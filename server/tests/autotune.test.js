// SPDX-License-Identifier: MIT
// Port of tests/test_autotune.py — the auto-tune sweep (runner/autotune.js), offline: the
// service is faked, so the candidate ladder, winner pick, failure-skip, cancel, save and
// busy-guard logic test without a GPU or a llama-server.
//
// Python joined the sweep's thread; here the sweep is an async task (`tuner._task`) the tests
// await. Python's `monkeypatch.setattr("…autotune.list_repo_ggufs", fake)` is
// `vi.spyOn(models, "listRepoGgufs")` (the sweep calls it through the namespace).
import { expect, test, vi } from "vitest";
import { AsyncEvent, sleep } from "../src/platform/asyncutil.js";
import { createServer } from "../src/platform/server.js";
import { AutoTuner, makeAutotuneRouter } from "../src/runner/autotune.js";
import * as models from "../src/runner/models.js";

/** Scripted load/measure: tok/s per n_cpu_moe value; a value in `fail` never reaches
 * running. Mirrors the real surface the sweep drives. */
class FakeService {
  constructor({ tpsByNcmoe = null, fail = [], block = 30, isMoe = true } = {}) {
    this.tpsByNcmoe = tpsByNcmoe || {};
    this.fail = new Set(fail.map(String));
    this.block = block;
    this.isMoe = isMoe;
    this.loads = []; // every switches object passed to load()
    this._current = null; // [modelId, ncmoe] of the "resident" model
    this.stops = 0;
    this.embeds = 0;
  }

  previewFit(_modelId, _switches = null) {
    return { ok: true, blockCount: this.block, isMoe: this.isMoe, nGpuLayers: 99, nCpuMoe: this.block, ctxLen: 8192 };
  }

  stop(_modelId = null) {
    this.stops += 1;
    this._current = null;
  }

  ensureEmbedding() {
    this.embeds += 1;
    return { ok: true };
  }

  load(modelId, { switches = null } = {}) {
    this.loads.push({ ...(switches || {}) });
    this._current = [modelId, String((switches || {}).n_cpu_moe ?? "")];
    return { status: "starting" };
  }

  status() {
    if (this._current === null) return { status: "idle" };
    const [mid, ncmoe] = this._current;
    if (this.fail.has(ncmoe)) return { status: "error", error: `OOM at n_cpu_moe ${ncmoe}`, modelId: mid };
    return { status: "running", modelId: mid };
  }

  measure({ maxTokens = 0 } = {}) {
    const ncmoe = this._current[1];
    const key = ncmoe || "base";
    const tps = Object.hasOwn(this.tpsByNcmoe, key) ? this.tpsByNcmoe[key] : 10.0;
    return { ok: true, tokensPerSec: tps, completionTokens: maxTokens, ms: 1000.0, vramTotalMb: 7000 };
  }
}

async function runToEnd(tuner, modelId, base, opts) {
  const st = tuner.start(modelId, base, opts);
  expect(st.status).toBe("running");
  await tuner._task;
  return tuner.status();
}

const makeTuner = (svc) => new AutoTuner(() => svc, { sleep: () => {} });

const BASE = { n_cpu_moe: "21", batch_size: "512", ubatch_size: "512", threads: "8" };

/** `tuner._push_trial = push_and_cancel`: cancel the moment a trial lands. */
function cancelOnPush(tuner, when = () => true) {
  const orig = tuner._pushTrial.bind(tuner);
  tuner._pushTrial = (row) => {
    orig(row);
    if (when(row)) tuner._cancel = true;
  };
  return orig;
}

test("walk_steps_while_improving_and_strict_beats_baseline", async () => {
  // Tuned anchor 21 (in BASE → the baseline already measures it): probes 23 and 19; 19
  // improves on 23 → walk continues DOWN while improving (17 better, 15 worse → stop).
  // Winner = 17 (strictly beats the 30.0 baseline beyond the 5% band).
  const svc = new FakeService({ tpsByNcmoe: { 21: 30.0, 23: 28.0, 19: 33.0, 17: 36.0, 15: 35.0 } });
  const st = await runToEnd(makeTuner(svc), "m", BASE);
  expect(st.status).toBe("done");
  expect(st.trials.map((t) => t.label)).toEqual(["baseline", "n-cpu-moe 23", "n-cpu-moe 19", "n-cpu-moe 17", "n-cpu-moe 15"]);
  expect(st.best.switches.n_cpu_moe).toBe("17");
  expect(st.best.tokensPerSec).toBe(36.0);
  // every trial ran with the embed ensured + a clean stop first (production-true floor)
  expect(svc.embeds).toBe(st.trials.length);
  expect(svc.stops).toBe(st.trials.length);
});

test("strict_beat_a_tying_explicit_never_overwrites_baseline", async () => {
  // 1b-F5: 19 TIES the baseline within the 5% band (30.9 vs 30.0) — the baseline stands, and
  // NOTHING is saved (a tying explicit value would permanently disable the engine's fit /
  // clobber the existing tune for zero measured gain).
  const saves = [];
  const svc = new FakeService({ tpsByNcmoe: { 21: 30.0, 23: 25.0, 19: 30.9, 17: 30.0 } });
  const st = await runToEnd(makeTuner(svc), "m", BASE, { saveFn: (_mid, sw) => saves.push(sw), save: true });
  expect(st.status).toBe("done");
  expect(st.best.label).toBe("baseline");
  expect(st.saved).toBe(false);
  expect(saves).toEqual([]);
  expect(st.detail).toContain("nothing saved");
});

test("untuned_base_probes_the_computed_anchor_explicitly", async () => {
  // Untuned base (no n_cpu_moe): the baseline is the FIT-placed launch, so the computed
  // anchor (preview nCpuMoe=30) is untried → probed explicitly first.
  const svc = new FakeService({ tpsByNcmoe: { base: 20.0, 30: 21.0, 28: 22.0, 26: 21.0 } });
  const st = await runToEnd(makeTuner(svc), "m", { batch_size: "512", ubatch_size: "512" });
  const labels = st.trials.map((t) => t.label);
  expect(labels[0]).toBe("baseline");
  expect(labels[1]).toBe("n-cpu-moe 30");
});

test("spec_n_alternative_tried_for_mtp_base_only", async () => {
  // A9: an MTP base (spec_type=draft-mtp, spec_n 2) gets ONE spec-n 3 trial; the winner still
  // obeys strict-beat. A non-MTP base gets no spec-n trial (covered by the label sweep in the
  // other tests).
  const base = { ...BASE, spec_type: "draft-mtp", spec_n_max: "2" };
  // (FakeService has no catalog(), so the draft phase's alternate discovery fails advisory —
  // no listing, no network — exactly as in Python.)
  const svc = new FakeService({ tpsByNcmoe: { 21: 30.0, 23: 20.0, 19: 20.0 } });
  const st = await runToEnd(makeTuner(svc), "m", base);
  expect(st.trials.map((t) => t.label)).toContain("spec-n 3");
});

test("failed_trial_is_recorded_and_baseline_wins", async () => {
  // 19 OOMs at load — its trial records the error (tok/s 0 ends that direction), no explicit
  // candidate strictly beats the baseline → the baseline wins.
  const svc = new FakeService({ tpsByNcmoe: { 21: 30.0, 23: 22.0 }, fail: ["19"] });
  const st = await runToEnd(makeTuner(svc), "m", BASE);
  expect(st.status).toBe("done");
  const failed = st.trials.filter((t) => !t.ok);
  expect(failed.length).toBe(1);
  expect(failed[0].error).toContain("19");
  expect(st.best.label).toBe("baseline");
});

test("batch_variant_added_when_baseline_differs", async () => {
  const base = { n_cpu_moe: "21", batch_size: "64", ubatch_size: "32" };
  const svc = new FakeService({ tpsByNcmoe: { 21: 30.0, 23: 20.0, 20: 20.0, 19: 20.0 } });
  const st = await runToEnd(makeTuner(svc), "m", base);
  const labels = st.trials.map((t) => t.label);
  expect(labels[1]).toBe("batch 512/512");
  // the ladder candidates carry 512/512 (the measured-better batch), not the 64/32 base
  const ladder = st.trials.filter((t) => t.label.startsWith("n-cpu-moe"));
  expect(ladder.every((t) => t.switches.batch_size === "512")).toBe(true);
});

test("dense_model_sweeps_batch_only", async () => {
  const svc = new FakeService({ isMoe: false, tpsByNcmoe: { "": 40.0, base: 40.0 } });
  const st = await runToEnd(makeTuner(svc), "m", { batch_size: "64", ubatch_size: "32" });
  expect(st.status).toBe("done");
  expect(st.trials.map((t) => t.label)).toEqual(["baseline", "batch 512/512"]);
});

test("cancel_stops_between_trials", async () => {
  const svc = new FakeService({ tpsByNcmoe: { 21: 30.0 } });
  const tuner = makeTuner(svc);
  // cancel the moment the first trial lands (the push happens before the next loop check)
  cancelOnPush(tuner);
  const st = await runToEnd(tuner, "m", BASE);
  expect(st.status).toBe("cancelled");
  expect(st.trials.length).toBe(1);
});

test("cancel_state_lands_before_a_blocked_teardown", async () => {
  // QC-22 ("stopping the optimize pc does not work"): the teardown's svc.stop() can block
  // behind the service's router lock for minutes on a failing box — the terminal state must
  // land BEFORE it, so the UI ("stopping…") unsticks even while the teardown is still waiting.
  const gate = new AsyncEvent();

  class BlockingStopService extends FakeService {
    async stop(modelId = null) {
      super.stop(modelId);
      if (this.stops > 1) await gate.wait(5000); // the baseline trial's clean-slate stop passes; the teardown blocks
    }
  }

  const svc = new BlockingStopService({ tpsByNcmoe: { 21: 30.0 } });
  const tuner = makeTuner(svc);
  cancelOnPush(tuner);
  tuner.start("m", BASE);
  let settled = false;
  tuner._task.then(() => {
    settled = true;
  });
  for (let i = 0; i < 500; i++) {
    // the state write precedes the blocked stop — poll it in
    if (tuner.status().status === "cancelled") break;
    await sleep(10);
  }
  expect(tuner.status().status).toBe("cancelled"); // unstuck WHILE the teardown blocks
  expect(settled).toBe(false); // the teardown really is still blocked
  expect(tuner.status().trials.length).toBe(1);
  gate.set();
  await tuner._task;
  expect(svc.loads.at(-1)).toEqual({}); // the restore load still fired after
});

test("cancel_between_trials_skips_service_work", async () => {
  // QC-22: a cancel that lands between trials must not START the next one — the fast-path
  // returns before svc.stop()/load(), so the teardown never queues behind post-cancel trial
  // work.
  const svc = new FakeService({ tpsByNcmoe: { 21: 30.0, 23: 25.0, 19: 25.0 } });
  const tuner = makeTuner(svc);
  const origPreview = svc.previewFit.bind(svc);
  svc.previewFit = (modelId, switches = null) => {
    tuner._cancel = true; // lands after the baseline, before the ncmoe walk
    return origPreview(modelId, switches);
  };
  const st = await runToEnd(tuner, "m", BASE);
  expect(st.status).toBe("cancelled");
  expect(st.trials.map((t) => t.label)).toEqual(["baseline"]); // no walk trial ever pushed
  expect(svc.stops).toBe(2); // baseline's clean slate + the teardown — no walk stops
  expect(svc.embeds).toBe(1); // only the baseline trial touched the service
  expect(svc.loads).toEqual([{ ...BASE }, {}]); // baseline load + the bare restore, nothing else
});

test("restart_during_teardown_is_accepted_and_old_teardown_skipped", async () => {
  // QC-22 generation guard: state-first makes a restart legal while the old run still tears
  // down — the old run must then SKIP its teardown (it would knock down the new run's trial)
  // and never overwrite the new run's state.
  const svc = new FakeService({ tpsByNcmoe: { 21: 30.0, 23: 25.0, 19: 25.0 } });
  const tuner = makeTuner(svc);
  const origPush = cancelOnPush(tuner);
  const origSet = tuner._set.bind(tuner);
  const restarted = [];
  tuner._set = (kw) => {
    origSet(kw);
    if (kw.status === "cancelled" && !restarted.length) {
      restarted.push(tuner._task); // the OLD task, to await later
      tuner._pushTrial = origPush; // the new run must run to completion
      tuner.start("m2", BASE); // races in right after the state write
    }
  };
  tuner.start("m", BASE);
  for (let i = 0; i < 500; i++) {
    // wait for the hook to have restarted (it runs inside the old run)
    if (restarted.length) break;
    await sleep(10);
  }
  expect(restarted.length, "the cancel state write never fired").toBeGreaterThan(0);
  await restarted[0]; // the old run
  await tuner._task; // now the NEW run
  const st = tuner.status();
  expect(st.status).toBe("done");
  expect(st.modelId).toBe("m2"); // the new run owned the state
  expect(svc.loads.some((l) => Object.keys(l).length === 0)).toBe(false); // the old run's bare restore load was SKIPPED (gen guard)
});

test("save_on_done_writes_winner_verbatim", async () => {
  const saved = {};
  const svc = new FakeService({ tpsByNcmoe: { 21: 30.0, 23: 35.0, 20: 20.0, 19: 20.0 } });
  const st = await runToEnd(makeTuner(svc), "m", BASE, {
    saveFn: (mid, sw) => {
      saved[mid] = sw;
    },
    save: true,
  });
  expect(st.status).toBe("done");
  expect(st.saved).toBe(true);
  expect(saved.m.n_cpu_moe).toBe("23");
});

test("tie_band_prefers_higher_ncmoe_headroom_among_explicit", async () => {
  // 19 measures nominally fastest (36.0) but 23 sits within the 5% tie band (34.5) — single
  // measures carry ±10% MTP noise, so the tie AMONG EXPLICIT candidates resolves to the HIGHER
  // n-cpu-moe (more VRAM headroom at indistinguishable speed). Both strictly beat the 25.0
  // baseline, so the save proceeds.
  const svc = new FakeService({ tpsByNcmoe: { 21: 25.0, 23: 34.5, 19: 36.0, 17: 30.0 } });
  const st = await runToEnd(makeTuner(svc), "m", BASE);
  expect(st.status).toBe("done");
  expect(st.best.switches.n_cpu_moe).toBe("23");
});

test("walk_stops_at_a_failed_ncmoe_never_below", async () => {
  // MoE VRAM need is monotonic: 19 fails → the down-walk STOPS — nothing below 19 is ever
  // loaded (the walk breaks on failure; the `_try` prune remains a defensive backstop for any
  // future multi-direction candidates).
  const svc = new FakeService({ tpsByNcmoe: { 21: 30.0, 23: 25.0 }, fail: ["19"] });
  const st = await runToEnd(makeTuner(svc), "m", BASE);
  expect(st.status).toBe("done");
  const tried = st.trials.map((t) => t.label);
  expect(tried).not.toContain("n-cpu-moe 17");
  expect(tried).not.toContain("n-cpu-moe 15");
  // down probe failed (0.0) → the walk goes UP instead (25, worse → stop): baseline + 23 +
  // the failed 19 + 25 — and never anything below the failure.
  expect(svc.loads.length).toBe(4);
});

test("busy_guard_rejects_second_start", async () => {
  const svc = new FakeService({ tpsByNcmoe: { 21: 30.0 } });
  const tuner = makeTuner(svc);
  const gate = new AsyncEvent();
  const svcMeasure = svc.measure.bind(svc);
  svc.measure = async (kw) => {
    await gate.wait(5000);
    return svcMeasure(kw);
  };
  tuner.start("m", BASE);
  const second = tuner.start("m", BASE);
  expect(second.ok).toBe(false);
  expect(second.error).toContain("already running");
  gate.set();
  await tuner._task;
  expect(tuner.status().status).toBe("done");
});

// ── D4: the draft phase — spec-off + the draft-file A/B (2026-07-19) ──────────

const MTP_BASE = { ...BASE, spec_type: "draft-mtp", spec_n_max: "2" };

/** FakeService + the catalog row, acquire door and per-trial-KIND speeds the draft phase
 * drives. `draftTps`/`specOffTps` key off the trial's OWN switches (the n_cpu_moe-keyed script
 * can't distinguish these — every draft trial carries the base's n_cpu_moe). */
class DraftService extends FakeService {
  constructor({ configured = "MTP/cur-Q4_0-MTP.gguf", acquireError = null, draftTps = null, specOffTps = null, ...kw } = {}) {
    super(kw);
    this.configured = configured;
    this.acquireError = acquireError;
    this.draftTps = draftTps;
    this.specOffTps = specOffTps;
    this.acquired = []; // [repo, file] per acquireDraftFile call
    this.events = []; // interleaved "acquire:<file>" / "load:<what>"
  }

  catalog() {
    return [{ id: "m", hfRepo: "org/main-GGUF", mtpDraftRepo: "", mtpDraftFile: this.configured }];
  }

  acquireDraftFile(repo, file, { cancelCheck = null } = {}) {
    if (cancelCheck !== null && cancelCheck()) throw new Error("cancelled");
    if (this.acquireError) throw new Error(this.acquireError);
    this.acquired.push([repo, file]);
    this.events.push(`acquire:${file}`);
    return `/cache/${file}`;
  }

  load(modelId, opts = {}) {
    const sw = { ...(opts.switches || {}) };
    this.events.push(`load:${sw.model_draft || sw.spec_type || "base"}`);
    return super.load(modelId, opts);
  }

  measure(opts = {}) {
    const sw = this.loads.length ? this.loads.at(-1) : {};
    const forced = sw.model_draft ? this.draftTps : sw.spec_type === "none" ? this.specOffTps : null;
    if (forced == null) return super.measure(opts);
    return { ok: true, tokensPerSec: forced, completionTokens: opts.maxTokens ?? 0, ms: 1000.0, vramTotalMb: 7000 };
  }
}

function listing(drafts, { raises = null } = {}) {
  vi.spyOn(models, "listRepoGgufs").mockImplementation(async (_repo, _revision = "main") => {
    if (raises) throw raises;
    return { quants: [], drafts };
  });
}

test("draft_phase_measures_spec_off_and_each_alternate", async () => {
  // An MTP base gets the saveable spec-off trial plus one row per alternate draft FILE, each
  // DOWNLOADED before its own load, ordered by the shared pick rule (the q4OrBetter floor
  // first, then smallest). The configured draft is skipped — the baseline already measures it.
  listing([
    { path: "MTP/cur-Q4_0-MTP.gguf", sizeMb: 240, q4OrBetter: true }, // configured
    { path: "MTP/alt-Q2_K-MTP.gguf", sizeMb: 100, q4OrBetter: false }, // smallest, below floor
    { path: "MTP/alt-BF16-MTP.gguf", sizeMb: 880, q4OrBetter: true },
  ]);
  const svc = new DraftService({ tpsByNcmoe: { 21: 30.0, 23: 20.0, 19: 20.0 } });
  const st = await runToEnd(makeTuner(svc), "m", MTP_BASE);
  expect(st.status).toBe("done");
  const labels = st.trials.map((t) => t.label);
  expect(labels).toContain("no draft (spec off)");
  expect(labels).toContain("draft alt-BF16-MTP.gguf (0.9 GB)");
  expect(labels).toContain("draft alt-Q2_K-MTP.gguf (0.1 GB)");
  // the configured draft is never re-fetched or re-measured
  expect(svc.acquired.map(([, f]) => f)).toEqual(["MTP/alt-BF16-MTP.gguf", "MTP/alt-Q2_K-MTP.gguf"]);
  // …and every acquire precedes ITS load (download, then measure)
  expect(svc.events.indexOf("acquire:MTP/alt-BF16-MTP.gguf")).toBeLessThan(
    svc.events.indexOf("load:/cache/MTP/alt-BF16-MTP.gguf"),
  );
});

test("draft_phase_skips_an_unloadable_dspark_alternate", async () => {
  // T9 (2026-07-21): an alternate whose arch the engine can't load (loadable=false, e.g.
  // dspark) must never be A/B'd — it would only DOWNLOAD then fail-load. The same one-source
  // `loadable` flag classifyGgufEntries stamps gates the Lab sweep too, so a dspark sibling is
  // never fetched. (Rows without the key stay included — backward-compatible.)
  listing([
    { path: "MTP/alt-Q4_0-MTP.gguf", sizeMb: 100, q4OrBetter: true, loadable: true },
    { path: "repo-dspark-Q4_1.gguf", sizeMb: 90, q4OrBetter: true, loadable: false, unsupportedArch: "dspark" },
  ]);
  const svc = new DraftService({ tpsByNcmoe: { 21: 30.0, 23: 20.0, 19: 20.0 } });
  const st = await runToEnd(makeTuner(svc), "m", MTP_BASE);
  expect(st.status).toBe("done");
  const labels = st.trials.map((t) => t.label);
  expect(labels).toContain("draft alt-Q4_0-MTP.gguf (0.1 GB)"); // the loadable alternate runs
  expect(labels.some((l) => l.includes("dspark"))).toBe(false); // the dspark one is never trialed
  expect(svc.acquired.every(([, f]) => !f.includes("dspark"))).toBe(true); // …and never downloaded
});

test("no_draft_phase_without_spec_draft_mtp", async () => {
  listing([{ path: "MTP/alt-Q4_0-MTP.gguf", sizeMb: 100, q4OrBetter: true }]);
  const svc = new DraftService({ tpsByNcmoe: { 21: 30.0, 23: 20.0, 19: 20.0 } });
  const st = await runToEnd(makeTuner(svc), "m", BASE); // no spec_type
  expect(st.trials.some((t) => t.label.includes("draft"))).toBe(false);
  expect(svc.acquired).toEqual([]);
});

test("draft_file_trials_never_win_and_never_save", async () => {
  // THE save-discipline invariant: an informational draft-FILE trial is the fastest thing
  // measured and STILL cannot become the winner — a model_draft tune row would pin an
  // absolute cache path. No `model_draft` key may ever reach saveFn.
  listing([{ path: "MTP/alt-BF16-MTP.gguf", sizeMb: 880, q4OrBetter: true }]);
  const saves = [];
  const svc = new DraftService({ tpsByNcmoe: { 21: 30.0, 23: 20.0, 19: 20.0 }, draftTps: 99.0 }); // the alternate draft is far and away fastest
  const st = await runToEnd(makeTuner(svc), "m", MTP_BASE, { saveFn: (_mid, sw) => saves.push(sw), save: true });
  const fastest = st.trials.reduce((a, t) => (t.tokensPerSec > a.tokensPerSec ? t : a));
  expect(fastest.label.startsWith("draft ")).toBe(true);
  expect(fastest.informational).toBe(true);
  expect(st.best.label).not.toBe(fastest.label);
  expect(saves.every((sw) => !("model_draft" in sw))).toBe(true);
});

test("spec_off_can_win_and_saves_the_opt_out", async () => {
  // The other half: "no draft (spec off)" is a NORMAL candidate. When drafting turns out not
  // to pay on this box, it wins under strict-beat and spec_type=none persists (the documented
  // MTP opt-OUT) — the CPU-only question, answered by measurement.
  listing([]);
  const saves = [];
  const svc = new DraftService({ tpsByNcmoe: { 21: 10.0, 23: 9.0, 19: 9.0 }, specOffTps: 40.0 }); // drafting does NOT pay on this box
  const st = await runToEnd(makeTuner(svc), "m", MTP_BASE, { saveFn: (_mid, sw) => saves.push(sw), save: true });
  expect(st.best.label).toBe("no draft (spec off)");
  expect(st.saved).toBe(true);
  expect(saves.at(-1).spec_type).toBe("none");
});

test("draft_phase_skipped_when_the_budget_is_gone", async () => {
  // The time box gates this phase like every other: no new trial is scheduled and nothing
  // downloads once the cap trips — the sweep still finishes DONE.
  listing([{ path: "MTP/alt-Q4_0-MTP.gguf", sizeMb: 100, q4OrBetter: true }]);
  const clock = { t: 0.0 };
  const svc = new DraftService({ tpsByNcmoe: { 21: 30.0, 23: 40.0, 19: 20.0 } });
  const orig = svc.measure.bind(svc);
  svc.measure = (kw) => {
    clock.t += 6.0;
    return orig(kw);
  };
  const st = await runToEnd(clockedTuner(svc, clock), "m", MTP_BASE, { budgetSeconds: 10 });
  expect(st.status).toBe("done");
  expect(st.trials.some((t) => t.label.includes("draft"))).toBe(false);
  expect(svc.acquired).toEqual([]);
});

test("draft_listing_failure_skips_the_alternates_only", async () => {
  // Discovery is ADVISORY (the tier-C precedent): a dead HF listing costs the alternates, not
  // the sweep — and spec-off, which needs no network, still runs.
  listing([], { raises: new Error("HF down") });
  const svc = new DraftService({ tpsByNcmoe: { 21: 30.0, 23: 20.0, 19: 20.0 } });
  const st = await runToEnd(makeTuner(svc), "m", MTP_BASE);
  expect(st.status).toBe("done");
  expect(st.trials.map((t) => t.label)).toContain("no draft (spec off)");
  expect(st.trials.some((t) => t.label.startsWith("draft "))).toBe(false);
});

test("draft_acquire_failure_is_one_row_not_the_sweep", async () => {
  listing([{ path: "MTP/alt-Q4_0-MTP.gguf", sizeMb: 100, q4OrBetter: true }]);
  const svc = new DraftService({ tpsByNcmoe: { 21: 30.0, 23: 20.0, 19: 20.0 }, acquireError: "404 from the hub" });
  const st = await runToEnd(makeTuner(svc), "m", MTP_BASE);
  expect(st.status).toBe("done");
  const row = st.trials.find((t) => t.label.startsWith("draft "));
  expect(row.ok).toBe(false);
  expect(row.error).toContain("404");
  expect(row.informational).toBe(true);
});

test("cancel_between_trials_never_starts_a_draft_download", async () => {
  // A cancel that lands BEFORE the alternates must not begin fetching one.
  listing([{ path: "MTP/alt-Q4_0-MTP.gguf", sizeMb: 100, q4OrBetter: true }]);
  const svc = new DraftService({ tpsByNcmoe: { 21: 30.0, 23: 20.0, 19: 20.0 } });
  const tuner = makeTuner(svc);
  cancelOnPush(tuner, (row) => row.label === "no draft (spec off)"); // cancel right before the alternates would download
  const st = await runToEnd(tuner, "m", MTP_BASE);
  expect(st.status).toBe("cancelled");
  expect(svc.acquired).toEqual([]); // nothing downloaded after the cancel
});

test("cancel_DURING_a_draft_download_aborts_that_fetch", async () => {
  // THE escape proven to FIRE: the acquire door is handed the sweep's cancel token, so a Stop
  // pressed mid-download aborts THAT fetch instead of finishing a multi-hundred-MB file
  // first. Drop `cancelCheck` from _draftPhase's acquire call and this goes red two ways — the
  // fake completes the download (svc.acquired grows) and no failed draft row is recorded.
  listing([{ path: "MTP/alt-Q4_0-MTP.gguf", sizeMb: 100, q4OrBetter: true }]);
  const svc = new DraftService({ tpsByNcmoe: { 21: 30.0, 23: 20.0, 19: 20.0 } });
  const tuner = makeTuner(svc);
  svc.acquireDraftFile = (repo, file, { cancelCheck = null } = {}) => {
    tuner._cancel = true; // the user hits Stop mid-download
    if (cancelCheck !== null && cancelCheck()) throw new Error("download cancelled");
    svc.acquired.push([repo, file]); // no token → the fetch runs to the end
    return `/cache/${file}`;
  };
  const st = await runToEnd(tuner, "m", MTP_BASE);
  expect(st.status).toBe("cancelled");
  expect(svc.acquired).toEqual([]); // aborted, not completed
  const row = st.trials.find((t) => t.label.startsWith("draft "));
  expect(row.ok).toBe(false);
  expect(row.error).toContain("cancelled");
  expect(row.informational).toBe(true);
});

// ── the time box (budgetSeconds — the QuickSetup ~2-min quick tune, 2026-07-07) ──

function clockedTuner(svc, clock) {
  return new AutoTuner(() => svc, { sleep: () => {}, now: () => clock.t });
}

test("budget_stops_scheduling_and_keeps_best_so_far", async () => {
  // Each measure "costs" 6s on the fake clock; a 10s budget lets baseline + ONE explicit trial
  // run, then trips at the next walkTry — the run finishes DONE with the best of what
  // completed (23 @ 40 beats the 30 baseline).
  const clock = { t: 0.0 };
  const svc = new FakeService({ tpsByNcmoe: { 21: 30.0, 23: 40.0, 19: 45.0, 17: 50.0 } });
  const origMeasure = svc.measure.bind(svc);
  svc.measure = (kw) => {
    clock.t += 6.0;
    return origMeasure(kw);
  };
  const st = await runToEnd(clockedTuner(svc, clock), "m", BASE, { budgetSeconds: 10 });
  expect(st.status).toBe("done");
  expect(st.budgetSeconds).toBe(10);
  expect(st.detail.startsWith("time budget reached")).toBe(true);
  // baseline + n-cpu-moe 23 only — 19/17 (faster in the script) were never tried
  expect(st.trials.map((t) => t.label)).toEqual(["baseline", "n-cpu-moe 23"]);
  expect(st.best.switches.n_cpu_moe).toBe("23");
});

test("budget_aborts_an_inflight_load_and_restores", async () => {
  // The load never reaches running; the tuner's poll sleep advances the clock, so the 5s
  // budget trips INSIDE _waitRunning (not the 240s cap). No trial ever succeeded → the honest
  // error state — and the dangling trial load is torn down + the applied model restored
  // (stop + a bare load), the ROUND-9 teardown.
  const clock = { t: 0.0 };

  class StuckService extends FakeService {
    status() {
      return this._current ? { status: "starting" } : { status: "idle" };
    }
  }

  const svc = new StuckService();
  const tuner = new AutoTuner(() => svc, {
    now: () => clock.t,
    sleep: () => {
      clock.t += 1.0;
    },
  });
  const st = await runToEnd(tuner, "m", BASE, { budgetSeconds: 5 });
  expect(st.status).toBe("error");
  expect(st.error).toBe("no trial succeeded");
  expect(st.trials[0].error).toBe("time budget reached");
  // trial stop + the budget teardown stop; the restore load carries NO switches
  expect(svc.stops).toBe(2);
  expect(svc.loads.at(-1)).toEqual({});
});

test("budget_abort_never_poisons_the_ncmoe_prune", async () => {
  // A budget-aborted n-cpu-moe trial is NOT a fit failure: nothing lands in the monotonic
  // prune list, so a later (uncapped) sweep may try lower values again.
  const clock = { t: 0.0 };
  const svc = new FakeService({ tpsByNcmoe: { 21: 30.0, 23: 28.0 } });
  const origMeasure = svc.measure.bind(svc);
  svc.measure = (kw) => {
    clock.t += 6.0;
    return origMeasure(kw);
  };
  const tuner = clockedTuner(svc, clock);
  const failedSeen = [];
  const origTry = tuner._try.bind(tuner);
  tuner._try = (svc_, mid, label, switches, failedNcmoe) => {
    failedSeen.push([...failedNcmoe]);
    return origTry(svc_, mid, label, switches, failedNcmoe);
  };
  const st = await runToEnd(tuner, "m", BASE, { budgetSeconds: 10 });
  expect(st.status).toBe("done");
  expect(failedSeen.every((f) => f.length === 0)).toBe(true); // the prune list stayed empty throughout
});

// Not in the Python file: the auto-tune router's answers, each as FastAPI gave it through
// TestClient on 2026-10-07 (make_autotune_router over a recording tuner).
test("the auto-tune router answers as FastAPI did", async () => {
  const calls = [];
  const fakeTuner = {
    start: (...a) => {
      calls.push(["start", ...a]);
      return { ok: "started" };
    },
    status: () => ({ s: 1 }),
    cancel: () => ({ c: 1 }),
  };
  const saveTune = () => {};
  const app = createServer({ typeBase: "https://example.test/errors/" });
  app.register(makeAutotuneRouter(async () => ({ a: "1" }), saveTune, { tunerFn: () => fakeTuner }));
  const U = "/v1/llm-runner/auto-tune";
  const send = async (method, url, json) => {
    calls.length = 0;
    const r = await app.inject({
      method,
      url,
      ...(json !== undefined ? { payload: JSON.stringify(json), headers: { "content-type": "application/json" } } : {}),
    });
    return [r.statusCode, r.json()];
  };
  const v422 = (errors) => ({
    type: "https://example.test/errors/validation-error",
    title: "Validation Error",
    status: 422,
    detail: "Request body failed validation.",
    errors,
    instance: U,
  });
  expect(await send("POST", U)).toEqual([422, v422([{ loc: ["body"], msg: "Field required", type: "missing" }])]);
  expect(await send("POST", U, [1])).toEqual([422, v422([{ loc: ["body"], msg: "Input should be a valid dictionary", type: "dict_type" }])]);
  expect(await send("POST", U, {})).toEqual([
    400,
    { type: "https://example.test/errors/bad-request", title: "Bad Request", status: 400, detail: "modelId required", instance: U },
  ]);
  const opts = (save, budgetSeconds) => ({ saveFn: saveTune, save, budgetSeconds, recordFn: null });
  expect(await send("POST", U, { modelId: "m", save: "false", budgetSeconds: [1] })).toEqual([200, { ok: "started" }]);
  expect(calls).toEqual([["start", "m", { a: "1" }, opts(true, 0)]]); // bool("false") is True; float([1]) → 0
  await send("POST", U, { modelId: "m", budgetSeconds: "12" });
  expect(calls).toEqual([["start", "m", { a: "1" }, opts(false, 12)]]);
  await send("POST", U, { modelId: "m", budgetSeconds: true });
  expect(calls).toEqual([["start", "m", { a: "1" }, opts(false, 1)]]);
  expect(await send("POST", `${U}/cancel`, { x: 1 })).toEqual([200, { c: 1 }]);
  expect(await send("GET", U)).toEqual([200, { s: 1 }]);
});

test("budget_zero_means_uncapped", async () => {
  const svc = new FakeService({ tpsByNcmoe: { 21: 30.0, 23: 25.0, 19: 25.0 } });
  const st = await runToEnd(makeTuner(svc), "m", BASE, { budgetSeconds: 0 });
  expect(st.status).toBe("done");
  expect(st.budgetSeconds).toBe(0);
  expect(st.detail || "").not.toContain("time budget");
});
