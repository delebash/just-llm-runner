// SPDX-License-Identifier: MIT
// Auto-tune — a small measured sweep that finds a model's fastest launch config on THIS box
// (the port of llm_runner/runner/autotune.py; from the JW llamacpp tuning session, the manual
// methodology in justwrite-app/docs/plans/2026-07-06-llamacpp-config-tuning-2070s.md,
// downscaled to a one-click job).
//
// WHAT it does: a short sequence of real load→measure trials against the resident router —
// first settle batch/ubatch (512/512 vs the resolved baseline; measured 8.6× TTFT there),
// then walk `n-cpu-moe` around the fit/tune anchor (the winner is usually within ±2 of it).
// Winner = highest measured decode tok/s (VRAM breaks ties). Every trial runs with the
// configured embed co-resident (`ensureEmbedding` first) because the CPU-embed child holds
// real VRAM and shifts the MoE floor — measuring without it finds configs that OOM in
// production.
//
// WHAT it does NOT do: hunt the absolute OOM floor (the load path's own OOM back-off would
// silently shed layers and corrupt the reading — a trial that back-offs simply measures
// slower and loses), sweep threads (measured flat on the reference box), or auto-save (the
// caller decides: the Tune modal fills the grid for review; QuickSetup passes save=true).
// MTP bases DO get one spec-n alternative trial (A9) and, since D4 (2026-07-19), a draft
// phase: one SAVEABLE "no draft (spec off)" trial — the honest answer to "does drafting pay
// on THIS box", the question a CPU-only machine most needs — plus one INFORMATIONAL trial
// per alternate draft file the repo ships (measured and shown, never saved; the durable
// choice lives on the catalog row). Doc: docs/plans/2026-07-19-draft-fit-floor-and-lab-measure.md.
//
// BENCH-METHOD CAVEAT (on-box incident 3, 2026-07-06): a verbatim-repeated prompt hits
// llama's prompt cache and TTFT collapses to decode-only — `measure` reads DECODE tok/s
// (cache-insensitive), which is why the sweep compares decode rates; any future TTFT-shaped
// trial must cache-bust its prompt head per run.
//
// Layering: this module owns the MECHANICS (service-driving sweep + job state). The ROUTER
// FACTORY takes the llm layer's `resolveSwitches` + `saveTune` callables via DI (mounted by
// `llm/install.js`), so the runner never imports llm stores — same seam as the catalog router.
//
// ── The JS shape ────────────────────────────────────────────────────────────────────────
// Python's background thread is an async task (`this._task`, a promise that settles when
// the sweep ends — the tests await it where Python joined the thread). Every service call is
// awaited, so a service whose methods are sync or async both work. The threading.Lock
// guarded state that never spans an await, so it is dropped (nothing else runs in between).
// `sleep(seconds)` and `now()` (seconds) are the injection points, as in Python.

import { Hono } from "hono";
import { background, sleep as sleepMs } from "../platform/asyncutil.js";
import { HttpError, RequestValidationError } from "../platform/errors.js";
import { getLogger } from "../platform/log.js";
import { pyFloatParse, pyInt, pyMax, pySorted, pyStr, strip, truthy } from "../platform/py.js";
import { pyFixed } from "../platform/pyjson.js";
import { readJson } from "../platform/server.js";
import * as lifecycle from "#runner/lifecycle";
import * as models from "./models.js";

const log = getLogger("llm_runner.runner.autotune");

const POLL_INTERVAL = 1.0;
const LOAD_TIMEOUT = 240.0; // per-trial cap — a candidate stuck in the service's OOM-backoff churn is a FAIL, not a wait
const MEASURE_TOKENS = 192; // live-validated 2026-07-06: 96-token measures sat inside the ±10% MTP noise band; 192 discriminates
const TIE_BAND = 0.95; // trials within 5% of the best are TIES → prefer the higher n-cpu-moe (VRAM headroom over noise)
const WALK_STEP = 2; // 1b-F5: the n-cpu-moe walk stride — probe ±2 around the anchor, then keep stepping
const WALK_MAX_TRIALS = 12; // explicit-ncmoe trial budget: covers a 37→21-style journey (8 steps) with slack
const DRAFT_ALT_CAP = 4; // D4: most alternate draft FILES to A/B — each one is a download + a load

const monotonic = () => performance.now() / 1000;

// ─── Small Python-semantics helpers (candidates for platform/) ───────────────────

/** Python's `str(exc)` for an error: its message (a non-Error value stringified). */
export function errStr(e) {
  if (e instanceof Error) return e.message;
  return pyStr(e);
}

/** `x or ""` then `str()` — the sweep's way of reading a switch value as text. */
const strOr = (v) => pyStr(truthy(v) ? v : "");

/** `{k: str(v) for k, v in base.items() if v not in (None, "")}` + `{k: str(v)}` of delta. */
export function _merged(base, delta) {
  const out = {};
  for (const [k, v] of Object.entries(base || {})) {
    if (v !== null && v !== undefined && v !== "") out[k] = pyStr(v);
  }
  for (const [k, v] of Object.entries(delta)) out[k] = pyStr(v);
  return out;
}

/** `int(str(switches.get(key, "")).strip())`, null where that raises. */
export function _intOf(switches, key) {
  try {
    const raw = switches != null && Object.hasOwn(switches, key) ? switches[key] : "";
    return pyInt(strip(pyStr(raw)));
  } catch {
    return null;
  }
}

/**
 * One process-wide sweep job (engine-install pattern: a background task + a state object the
 * GET endpoint returns verbatim). `serviceFn` / `sleep` / `now` are injection points so the
 * sweep tests offline.
 */
export class AutoTuner {
  constructor(serviceFn = () => lifecycle.getService(), { sleep = (s) => sleepMs(s * 1000), now = monotonic } = {}) {
    this._serviceFn = serviceFn;
    this._sleep = sleep;
    this._now = now;
    this._task = null; // the running sweep (Python's thread) — settles when it ends
    this._cancel = false;
    this._gen = 0; // sweep generation — a new start() supersedes an old run's teardown
    this._budgetDeadline = null; // optional time box (quick tune)
    this._budgetHit = false; // sticky: the cap tripped
    this._budgetAbortedLoad = false; // the cap aborted a load IN FLIGHT
    this._recordFn = null; // optional measurement-history sink (llm layer, DI)
    this._state = {
      status: "idle",
      modelId: "",
      detail: "",
      error: "",
      trials: [],
      best: null,
      saved: false,
      budgetSeconds: 0,
    };
  }

  // ── public surface (endpoint-shaped) ─────────────────────────────────────

  status() {
    return { ...this._state, trials: [...this._state.trials] };
  }

  cancel() {
    if (this._state.status === "running") {
      this._cancel = true;
      // Prompt now, not "after the current trial": _waitRunning observes this flag and
      // aborts the in-flight load wait (see _run/_waitRunning).
      this._state.detail = "stopping…";
    }
    return this.status();
  }

  /** Options mirror Python's keywords: `{saveFn, save, budgetSeconds, recordFn}`. */
  start(modelId, baseSwitches, { saveFn = null, save = false, budgetSeconds = 0, recordFn = null } = {}) {
    if (this._state.status === "running") {
      return { ...this._state, ok: false, error: "an auto-tune is already running" };
    }
    this._cancel = false;
    this._gen += 1; // supersede any prior run still tearing down (see `cancelled`)
    // Measurement-history sink (#142 rows 5+6): every OK trial is a real measurement,
    // recorded as it lands. Best-effort — see _try.
    this._recordFn = recordFn;
    // Optional time box (the QuickSetup "~2-min quick tune", 2026-07-07): once exhausted,
    // the sweep stops scheduling trials and finishes with the best result so far — checked
    // at the same seams as the cancel flag. 0 = uncapped.
    const asked = pyFloatParse(truthy(budgetSeconds) ? budgetSeconds : 0);
    const budget = asked > 0.0 ? asked : 0.0; // max(0.0, x) — NaN → 0.0, as Python's max gives
    this._budgetDeadline = budget ? this._now() + budget : null;
    this._budgetHit = false;
    this._budgetAbortedLoad = false;
    this._state = {
      status: "running",
      modelId,
      detail: "starting…",
      error: "",
      trials: [],
      best: null,
      saved: false,
      budgetSeconds: budget,
    };
    const base = { ...(baseSwitches || {}) };
    // The run starts on a later tick, as the Python thread did: start() answers first.
    this._task = background("auto-tune", () => this._run(modelId, base, saveFn, save), log);
    return this.status();
  }

  /** true once the optional time budget is exhausted. Sticky — the first trip latches
   * `_budgetHit` so every later check (incl. the prune guard) agrees. */
  _budgetOver() {
    if (this._budgetHit) return true;
    if (this._budgetDeadline !== null && this._now() >= this._budgetDeadline) {
      this._budgetHit = true;
      return true;
    }
    return false;
  }

  // ── the sweep ─────────────────────────────────────────────────────────────

  _set(kw) {
    Object.assign(this._state, kw);
  }

  _pushTrial(row) {
    this._state.trials.push(row);
  }

  /**
   * The ONE alternative spec-n trial for MTP models (A9: the optimal speculation depth is
   * hardware-conditioned — the draft/target speed ratio changes when the target runs fully
   * on-GPU). Gate = the resolved `spec_type`; 2↔3 around the current value; null for non-MTP
   * bases (no trial).
   */
  static _specAlt(base) {
    if (strOr((base || {}).spec_type) !== "draft-mtp") return null;
    const cur = _intOf(base, "spec_n_max") || 3;
    return cur === 2 ? 3 : 2;
  }

  async _waitRunning(svc, modelId) {
    const deadline = this._now() + LOAD_TIMEOUT;
    while (this._now() < deadline) {
      // A cancel must ABORT the in-flight load wait, not run out the 240s cap. Without this
      // the cancel only lands at the NEXT trial boundary, so a cancel while a trial is
      // loading hangs the user for minutes (the reported "cant cance tune … it hangs").
      if (this._cancel) return [false, "cancelled"];
      // The time box aborts an in-flight load the same way — otherwise a slow trial load
      // could run a "~2-min" quick tune out to the 240s cap. The aborted-load flag tells the
      // finish path to tear down + restore (the router would otherwise keep chewing the
      // trial's switches after done).
      if (this._budgetOver()) {
        this._budgetAbortedLoad = true;
        return [false, "time budget reached"];
      }
      const st = (await svc.status()) || {};
      if (st.modelId === modelId && st.status === "running") return [true, ""];
      if (st.status === "error") return [false, st.error || "load failed"];
      await this._sleep(POLL_INTERVAL);
    }
    return [false, "load timed out"];
  }

  /**
   * 1b-F5 STRICT-BEAT rule. The `baseline` trial is the model's CURRENT launch — a tune's
   * explicit values, or (untuned) the engine-fit placement with no explicit knobs. An
   * explicit candidate wins ONLY by beating the baseline strictly beyond the tie band: a tie
   * must never overwrite the baseline, because saving a tying explicit value would
   * permanently disable the engine's fit over an equal-or-better placement. Ties AMONG
   * explicit candidates still resolve to the highest n-cpu-moe (VRAM headroom over ±10% MTP
   * noise, live-validated 2026-07-06).
   *
   * `informational` trials (the D4 draft-FILE A/B, 2026-07-19) are EXCLUDED from the
   * candidate set: they are measured and shown, never saved. A winning `model_draft` would
   * pin an absolute cache path into a tune row, while the durable home for that choice is
   * the catalog's `mtp_draft_*` fields, which the USER sets in the Edit-model form — the
   * machine supplies measurements, the user supplies choices.
   */
  static _pickWinner(trials) {
    const ok = trials.filter((t) => t.ok);
    if (!ok.length) return null;
    const baseline = ok.find((t) => t.label === "baseline") ?? null;
    const explicit = ok.filter((t) => t.label !== "baseline" && !t.informational);
    if (!explicit.length) return baseline;
    const top = Math.max(...explicit.map((t) => t.tokensPerSec));
    const tied = explicit.filter((t) => t.tokensPerSec >= top * TIE_BAND);
    const best = pyMax(tied, (t) => [_intOf(t.switches, "n_cpu_moe") || -1, t.tokensPerSec]);
    if (baseline !== null && !(best.tokensPerSec * TIE_BAND > baseline.tokensPerSec)) return baseline;
    return best;
  }

  /**
   * One load→measure trial, pushed to the live trial list. Monotonic MoE prune: an
   * n-cpu-moe below an already-failed value is recorded as skipped, never tried (below a
   * failed value never fits — the slowest failure mode avoided). `extra` seeds extra keys on
   * the row at CREATION (never patched on after the push, which a status() poll could
   * observe half-written) — the D4 draft phase marks its file trials `informational` that way.
   */
  async _try(svc, modelId, label, switches, failedNcmoe, { extra = null } = {}) {
    const seed = { ...(extra || {}) };
    // QC-22 fast-path: a cancel that landed between trials must not start the next one —
    // return WITHOUT touching the service and WITHOUT pushing a row (the sweep is ending; a
    // phantom per-phase "cancelled" row would clutter the trial list) — the caller's
    // `cancelled()` check ends the run.
    if (this._cancel) {
      return { label, ok: false, tokensPerSec: 0.0, vramTotalMb: 0, error: "cancelled", switches, ...seed };
    }
    const candNcmoe = _intOf(switches, "n_cpu_moe");
    if (candNcmoe !== null && failedNcmoe.some((f) => candNcmoe < f)) {
      const trial = {
        label,
        ok: false,
        tokensPerSec: 0.0,
        vramTotalMb: 0,
        error: "skipped — a higher n-cpu-moe already failed",
        switches,
        ...seed,
      };
      this._pushTrial(trial);
      return trial;
    }
    this._set({ detail: `trying ${label}…` });
    const trial = { label, ok: false, tokensPerSec: 0.0, vramTotalMb: 0, error: "", switches, ...seed };
    try {
      await svc.stop(); // clean slate per trial — deterministic VRAM
      try {
        await svc.ensureEmbedding(); // co-resident embed = production-true floor
      } catch {
        /* no embed configured is fine */
      }
      await svc.load(modelId, { switches, trigger: "autotune" });
      const [ok, err] = await this._waitRunning(svc, modelId);
      if (!ok) {
        trial.error = err;
      } else if (this._cancel) {
        trial.error = "cancelled"; // loaded, but a cancel landed — skip the measure
      } else {
        const res = (await svc.measure({ modelId, maxTokens: MEASURE_TOKENS })) || {};
        if (!res.ok) {
          trial.error = res.error || "measure failed";
        } else {
          Object.assign(trial, { ok: true, tokensPerSec: res.tokensPerSec || 0.0, vramTotalMb: res.vramTotalMb || 0 });
        }
      }
    } catch (exc) {
      trial.error = errStr(exc); // a broken trial must not kill the sweep
    }
    this._pushTrial(trial);
    // Persist the measurement (#142 rows 5+6): an OK trial is a real number — record it in
    // the history as it lands. Best-effort: a history-write failure must never kill (or even
    // mark) the sweep.
    if (trial.ok && this._recordFn !== null) {
      try {
        await this._recordFn(modelId, trial);
      } catch (e) {
        log.warning("auto-tune measurement record failed", e); // history is an enrichment
      }
    }
    // A CANCELLED or BUDGET-STOPPED trial is NOT a fit failure — never let it poison the
    // monotonic n-cpu-moe prune (below-a-failed-value skip); the sweep is stopping anyway.
    if (!trial.ok && candNcmoe !== null && !this._cancel && !this._budgetHit) failedNcmoe.push(candNcmoe);
    return trial;
  }

  /**
   * The OTHER draft GGUFs this model's draft repo ships — the D4 A/B candidates.
   *
   * Empty unless the resolved config actually speculates (`spec_type=draft-mtp`). The
   * CONFIGURED draft is excluded: the baseline trial already measures it. Files whose
   * architecture the engine can't load are excluded too (`loadable` is false, e.g. dspark) —
   * the same one-source flag `classifyGgufEntries` stamps — so a sweep never DOWNLOADS +
   * fail-loads a draft that can only fail at spawn. Ordered by the SHARED pick rule the form
   * and the tier-C suggestion use — the `q4OrBetter` floor first, then smallest — and capped
   * at DRAFT_ALT_CAP so a repo shipping a dozen quants can't turn a tune into an all-night
   * download. Discovery is ADVISORY (the tier-C precedent): any listing/network failure
   * yields no candidates and the sweep finishes normally.
   */
  async _draftAlternates(svc, modelId, base) {
    if (strOr((base || {}).spec_type) !== "draft-mtp") return [];
    let configured;
    let repo;
    let drafts;
    try {
      const model = ((await svc.catalog()) || []).find((m) => m.id === modelId) ?? null;
      if (model === null) return [];
      configured = model.mtpDraftFile || "";
      repo = model.mtpDraftRepo || model.hfRepo;
      drafts = (await models.listRepoGgufs(repo)).drafts;
    } catch (e) {
      log.warning(`draft A/B listing failed for ${modelId}`, e); // advisory: never break a sweep on discovery
      return [];
    }
    let alts = drafts.filter((d) => d.path && d.path !== configured && d.loadable !== false); // skip arches our engine can't load (e.g. dspark)
    alts = pySorted(alts, (d) => [d.q4OrBetter ? 0 : 1, d.sizeMb || 0]);
    return alts.slice(0, DRAFT_ALT_CAP).map((d) => ({ ...d, repo }));
  }

  /**
   * D4 (2026-07-19): does speculative decoding pay on THIS box, and which draft file is
   * fastest here? Two kinds of trial, deliberately unequal:
   *
   *   * "no draft (spec off)" — a NORMAL, saveable candidate (`spec_type=none` is the
   *     documented MTP opt-OUT). This is the trial that answers the question a CPU-only box
   *     actually has: is drafting worth it at all, when every drafted token re-reads the
   *     draft's weights through the same memory bottleneck?
   *   * one per alternate draft FILE — `informational`: measured and shown, never saved.
   *     Bigger-draft-wins is real only ACROSS drafters, and it is machine-dependent, so this
   *     MEASURES it instead of the pickers guessing; but the durable home for the choice is
   *     the catalog's `mtp_draft_*` fields, which the user sets in the Edit-model form.
   *
   * Each candidate is fetched through the service's one acquire door before its trial; a
   * failed fetch is one recorded row, never the end of the sweep.
   */
  async _draftPhase(svc, modelId, base, batch512, failedNcmoe) {
    if (strOr((base || {}).spec_type) !== "draft-mtp") return;
    await this._try(svc, modelId, "no draft (spec off)", _merged(base, { spec_type: "none", ...batch512 }), failedNcmoe);
    if (this._cancel || this._budgetOver()) return;
    for (const d of await this._draftAlternates(svc, modelId, base)) {
      if (this._cancel || this._budgetOver()) return;
      const name = String(d.path).split("/").at(-1);
      const gb = (d.sizeMb || 0) / 1024;
      const label = gb ? `draft ${name} (${pyFixed(gb, 1)} GB)` : `draft ${name}`;
      this._set({ detail: `downloading ${name}…` });
      let path;
      try {
        path = await svc.acquireDraftFile(d.repo, d.path, { cancelCheck: () => this._cancel });
      } catch (exc) {
        // one bad candidate, not the sweep
        this._pushTrial({
          label,
          ok: false,
          tokensPerSec: 0.0,
          vramTotalMb: 0,
          error: errStr(exc),
          switches: {},
          informational: true,
        });
        continue;
      }
      await this._try(svc, modelId, label, _merged(base, { model_draft: String(path), ...batch512 }), failedNcmoe, {
        extra: { informational: true },
      });
    }
  }

  /**
   * The 1b-F5 sweep shape: baseline (the CURRENT launch — tuned explicit values, or on an
   * untuned box the engine-fit placement) → batch settle → the bounded n-cpu-moe WALK (probe
   * the anchor when untried + ±2 around it, then keep stepping in the improving direction
   * while decode tok/s improves, ≤ WALK_MAX_TRIALS explicit trials) → the one spec-n
   * alternative for MTP models. The winner comes from the strict-beat rule; a baseline win
   * saves NOTHING (an untuned box keeps the engine's fit; a tuned box keeps its tune).
   */
  async _run(modelId, base, saveFn, save) {
    const gen = this._gen; // this run's generation — compared in `cancelled` (see below)
    // Outside the job boundary, as in Python: a serviceFn that throws ends the task with the
    // state left "running" (Python's thread died the same way; background() logs it).
    const svc = await this._serviceFn();
    const failedNcmoe = []; // MoE VRAM need is monotonic: below a failed value never fits
    try {
      const budgetRestore = async () => {
        // The time box aborted a trial load IN FLIGHT — the router is still chewing that
        // trial's switches. Tear down + restore the applied model with its DB-resolved
        // switches (the ROUND-9 cancel teardown) so a finished quick tune never leaves a
        // dangling trial load serving. A cap that landed at a clean trial boundary skips
        // this and leaves the last trial resident, exactly like an uncapped run's finish.
        try {
          await svc.stop();
        } catch (e) {
          log.warning("auto-tune budget stop failed", e); // teardown is best-effort
        }
        try {
          await svc.load(modelId, { trigger: "autotune" });
        } catch (e) {
          log.warning("auto-tune budget restore load failed", e); // restore is best-effort
        }
      };

      const cancelled = async () => {
        if (!this._cancel) return false;
        // TERMINAL STATE FIRST (QC-22, 2026-07-09: "stopping the optimize pc does not
        // work"). svc.stop() serializes on the service's router lock, which an in-flight
        // trial load holds through its bounded-but-slow spawn/confirm legs — on a failing
        // box queued loads starve the teardown for what reads as forever. Writing the state
        // first unsticks the UI (the QuickSetup band stops polling on any non-running
        // status) while the teardown below still runs to completion.
        this._set({ status: "cancelled", detail: "cancelled" });
        if (gen !== this._gen) {
          // A newer sweep already start()ed (state-first makes that legal): the service now
          // belongs to IT — this run's teardown would knock down the new run's trial, so
          // skip it (the new run's own per-trial svc.stop() supplies the clean slate).
          return true;
        }
        // Free the VRAM the in-flight/last trial holds — otherwise the model (+ the
        // co-resident embed) stays resident under TRIAL switches and the user's NEXT load
        // contends on the router and appears to hang. A cancel means "stop AND let go of the
        // GPU", not just "stop looping". Then RESTORE the applied model with its DB-resolved
        // switches (async load).
        try {
          await svc.stop();
        } catch (e) {
          log.warning("auto-tune cancel: stop failed", e); // teardown is best-effort
        }
        try {
          await svc.load(modelId, { trigger: "autotune" });
        } catch (e) {
          log.warning("auto-tune cancel: restore load failed", e); // restore is best-effort
        }
        return true;
      };

      const batch512 = { batch_size: "512", ubatch_size: "512" };
      await this._try(svc, modelId, "baseline", _merged(base, {}), failedNcmoe);
      if (await cancelled()) return;
      // Every phase below gates on the time box: once it trips, no NEW trial is scheduled
      // and the run falls through to the winner-pick with what it has.
      if (!this._budgetOver() && (_intOf(base, "batch_size") !== 512 || _intOf(base, "ubatch_size") !== 512)) {
        await this._try(svc, modelId, "batch 512/512", _merged(base, batch512), failedNcmoe);
        if (await cancelled()) return;
      }

      const pv = (await svc.previewFit(modelId, base)) || {};
      if (pv.ok && pv.isMoe && !this._budgetOver()) {
        const block = pyInt(pv.blockCount || 0);
        let anchor = _intOf(base, "n_cpu_moe");
        const anchorUntried = anchor === null; // untuned: the baseline was FIT-placed, not the anchor
        if (anchor === null) anchor = pyInt(pv.nCpuMoe || block);
        const results = new Map();
        let budget = WALK_MAX_TRIALS;

        const walkTry = async (n) => {
          if (budget <= 0 || this._budgetOver() || results.has(n) || !(n >= 0 && n <= block)) return false;
          budget -= 1;
          const t = await this._try(svc, modelId, `n-cpu-moe ${n}`, _merged(base, { n_cpu_moe: String(n), ...batch512 }), failedNcmoe);
          results.set(n, t.ok ? t.tokensPerSec : 0.0);
          return t.ok;
        };
        const res = (n) => results.get(n) ?? 0.0;

        if (anchorUntried) {
          await walkTry(anchor);
          if (await cancelled()) return;
        }
        for (const d of [+WALK_STEP, -WALK_STEP]) {
          // direction probes
          await walkTry(anchor + d);
          if (await cancelled()) return;
        }
        const up = res(anchor + WALK_STEP);
        const down = res(anchor - WALK_STEP);
        const d = up >= down ? WALK_STEP : -WALK_STEP;
        let cur = anchor + d;
        while (res(cur) > 0.0) {
          const prev = res(cur);
          const nxt = cur + d;
          if (!(await walkTry(nxt))) break;
          if (await cancelled()) return;
          if (res(nxt) <= prev) break;
          cur = nxt;
        }
      }

      const alt = AutoTuner._specAlt(base);
      if (alt !== null && !this._budgetOver()) {
        await this._try(svc, modelId, `spec-n ${alt}`, _merged(base, { spec_n_max: String(alt), ...batch512 }), failedNcmoe);
        if (await cancelled()) return;
      }

      // D4: spec-off + the draft-file A/B (see _draftPhase). Last, because its candidates
      // may DOWNLOAD — the cheap measured knobs are settled by now.
      if (!this._budgetOver()) {
        await this._draftPhase(svc, modelId, base, batch512, failedNcmoe);
        if (await cancelled()) return;
      }

      const best = AutoTuner._pickWinner(this.status().trials);
      if (best === null) {
        // (the cap can trip before ANY trial succeeded — restore, then the honest error state)
        if (this._budgetAbortedLoad) await budgetRestore();
        this._set({ status: "error", error: "no trial succeeded", detail: "" });
        return;
      }
      let saved = false;
      let detail = "";
      if (best.label === "baseline") {
        // Strict-beat: the current launch stands — save nothing.
        detail = "current launch is already best — nothing saved";
      } else if (save && saveFn !== null) {
        try {
          await saveFn(modelId, best.switches);
          saved = true;
        } catch (exc) {
          // a save failure must not void the sweep
          log.warning("auto-tune save failed", exc);
          this._set({ error: `tuned OK but save failed: ${errStr(exc)}` });
        }
      }
      if (this._budgetHit) {
        // Restore runs AFTER the save above, so a just-saved tune is already in the
        // resolution the restore load resolves with.
        if (this._budgetAbortedLoad) await budgetRestore();
        detail = `time budget reached — ${detail || "kept the best result so far"}`;
      }
      this._set({ status: "done", detail, best, saved });
    } catch (exc) {
      // job boundary
      log.exception("auto-tune failed", exc);
      this._set({ status: "error", error: errStr(exc), detail: "" });
    }
  }
}

let tuner = null;

export function getTuner() {
  tuner ??= new AutoTuner();
  return tuner;
}

/** FastAPI's `body: dict` — a JSON object, else the 422 pydantic gives (missing / dict_type). */
export function dictBody(body, { required }) {
  if (body === undefined || body === null) {
    if (required) throw new RequestValidationError([{ loc: ["body"], msg: "Field required", type: "missing" }]);
    return null;
  }
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new RequestValidationError([{ loc: ["body"], msg: "Input should be a valid dictionary", type: "dict_type" }]);
  }
  return body;
}

/** `float(x or 0)`, 0 where that raises (a list, a dict, a non-number string). */
function floatOrZero(raw) {
  const v = truthy(raw) ? raw : 0;
  if (v !== null && typeof v === "object") return 0; // float([1]) → TypeError
  try {
    return pyFloatParse(v);
  } catch {
    return 0;
  }
}

/**
 * The auto-tune REST surface. `resolveSwitches(modelId) -> object` and
 * `saveTune(modelId, switches) -> void` come from the llm layer (installLlm) — the runner
 * drives loads/measures, the host owns the switch resolution + tune persistence (same DI seam
 * as the catalog router). `recordMeasurement(modelId, trial) -> void` (optional, same seam)
 * is the measurement-history sink — every OK trial persists (#142 rows 5+6). Each may be
 * sync or async.
 */
export function makeAutotuneRouter(resolveSwitches, saveTune, { recordMeasurement = null, tunerFn = getTuner } = {}) {
  const app = new Hono();
  app.post("/v1/llm-runner/auto-tune", async (c) => {
    const body = dictBody(await readJson(c), { required: true });
    const modelId = strOr((body || {}).modelId);
    if (!modelId) throw new HttpError(400, "modelId required");
    const save = truthy((body || {}).save || false);
    // Optional time box (seconds) — the QuickSetup quick tune passes ~120; the full sweep
    // omits it. Bad input → uncapped (never a 400 for an enrichment).
    const budgetSeconds = floatOrZero((body || {}).budgetSeconds);
    const base = (await resolveSwitches(modelId)) || {};
    return c.json(
      await tunerFn().start(modelId, base, { saveFn: saveTune, save, budgetSeconds, recordFn: recordMeasurement }),
    );
  });

  app.get("/v1/llm-runner/auto-tune", async (c) => c.json(await tunerFn().status()));

  app.post("/v1/llm-runner/auto-tune/cancel", async (c) => c.json(await tunerFn().cancel()));
  return app;
}
