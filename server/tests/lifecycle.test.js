// SPDX-License-Identifier: MIT
// Port of tests/test_lifecycle.py — the RunnerService state machine (ROUTER mode). The download
// + router IO is injected so the orchestration (status transitions, DB→.ini emission,
// co-residence, OOM back-off, error handling) tests offline. The real default RunnerConfig +
// computeFit run unmocked; a fake HF cache lets `cachedGgufPath` resolve on-disk models
// faithfully. The shared fixtures live in `_lifecycle_fakes.js` (test_load_failure_message
// imports them, as its Python twin imported test_lifecycle's).
//
// JS shape: Python's threads are the service's background tasks — `svc._thread.join(5)` is
// `await svc._thread.join(5)`; threading.Event → AsyncEvent; a test "thread" that ran
// `svc.stop(...)` is an un-awaited call whose promise the test awaits later. Model-keyed state
// is a Map (`svc._resident.get(id)`). `monkeypatch(lifecycle._IS_WINDOWS)` →
// `lifecycle.cfg.IS_WINDOWS`; patched module functions → `vi.spyOn(<namespace>, …)`.
//
// HERMETIC where Python read the box (see `_lifecycle_fakes.js`): the admission's measured
// occupancy is unmeasurable unless a test sets it, `_otherGpuHolders` answers null unless a
// test sets it, and no test binds a real port. Python's admission tests therefore read the
// live card, so on a box with other programs on the GPU they could disagree with these.
//
// All 208 Python tests are ported, plus one JS-only test at the end (marked): the router
// lock's re-entry through a reservation's own evictor, which no Python test exercised.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import { AsyncEvent, sleep } from "../src/platform/asyncutil.js";
import * as http from "../src/platform/http.js";
import { model } from "../src/platform/models.js";
import { RuntimeError, ValueError } from "../src/platform/py.js";
import { VramArbiter } from "../src/runner/arbiter.js";
import * as binary from "../src/runner/binary.js";
import { defaultConfig } from "../src/runner/config.js";
import { DownloadCancelled } from "../src/runner/download.js";
import * as fitMod from "../src/runner/fit.js";
import * as hardware from "../src/runner/hardware.js";
import * as lifecycle from "../src/runner/lifecycle.js";
import { CorruptModelError, RunnerService } from "../src/runner/lifecycle.js";
import * as processMod from "../src/runner/process.js";
import { FitPlan, ModelIniEntry, Overrides, RunnerStartError } from "../src/runner/process.js";
import { HardwareInfo } from "../src/runner/schema.js";
import {
  CHAT_26B,
  captureLogs,
  DRAFT_MODEL,
  draftCrashLoader,
  EMBED,
  EMBED_CPU,
  EMBED_MID,
  entry,
  fakeHw,
  fakeMeta,
  fakeRouter,
  GEMMA_MTP,
  ini,
  MODEL_B,
  mtpEntry,
  mtpFit,
  raiseBadMagic,
  routerView,
  section,
  serviceFor,
  TEST_MODEL,
  tmp,
  useHermeticRunner,
  winCudaHw,
  yieldPoll,
} from "./_lifecycle_fakes.js";

useHermeticRunner();

const join5 = (svc) => svc._thread.join(5);
const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const repoDirOf = (t, m) => join(t, "hf", `models--${m.hfRepo.replaceAll("/", "--")}`);
const draftSnap = (t) => join(t, "hf", "models--org--draft-GGUF", "snapshots", "sha");
function plantDraft(t, bytes = 64) {
  const snap = draftSnap(t);
  mkdirSync(join(snap, "MTP"), { recursive: true });
  writeFileSync(join(snap, "MTP", "d-Q4_0-MTP.gguf"), Buffer.alloc(bytes, "g"));
  return snap;
}
const appendLine = (p, line) => {
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, line);
};
/** The promise settles within `ms` (true) — a thread.join(timeout) that reports. */
const settles = (p, ms) => Promise.race([p.then(() => true), sleep(ms).then(() => false)]);

// ── load → resident (router) ─────────────────────────────────────────────────

test("load_reaches_running", async () => {
  const svc = serviceFor(tmp());
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  const st = svc.status();
  expect(st.status).toBe("running");
  expect(st.url).toBe("http://127.0.0.1:8080");
  expect(st.modelId).toBe(TEST_MODEL.id);
});

test("load_emits_ini_section", async () => {
  // The DB→.ini last mile: the loaded model gets a [<id>] section pointing at its GGUF.
  const svc = serviceFor(tmp());
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  const text = ini(svc);
  expect(text).toContain(`[${TEST_MODEL.id}]`);
  expect(text.includes("model = ") && text.includes("model-Q4_K_M.gguf")).toBe(true);
});

test("cached_load_skips_the_hf_resolve", async () => {
  // FAST PATH (2026-07-21): when the weights are already on disk, a LOAD skips acquireModel
  // entirely (no selectFiles / HF round-trips) — it resolves the cached GGUF and reaches
  // running.
  const svc = serviceFor(tmp()); // seedCache (default) → model-Q4_K_M.gguf already on disk
  const called = { n: 0 };
  const orig = svc._acquireModel;
  svc._acquireModel = (...a) => {
    called.n += 1;
    return orig(...a);
  };
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  expect(called.n).toBe(0); // acquire (→ selectFiles → HF) was NOT called
  expect(svc.status().status).toBe("running");
  expect(ini(svc)).toContain("model-Q4_K_M.gguf"); // still emitted the .ini for the cached gguf
});

test("reserve_trues_up_with_measured_vram_delta", async () => {
  // Measure-don't-assume (2026-07-06): a CPU-only fit (no GPU → nGpuLayers 0) books a 0 MB
  // estimate, but a CUDA-build child still holds real VRAM (driver context — box-measured ~549
  // MB for an ngl-0 embed child on a 2070 SUPER). The true-up must reserve the MEASURED growth.
  const readings = [1000, 1549][Symbol.iterator](); // before-load → after-confirm: +549 MB
  const arb = new VramArbiter();
  const noGpu = model(HardwareInfo, { os: "Linux", platform: "linux", cpuCores: 8, ramMb: 32000, gpus: [] });
  const svc = serviceFor(tmp(), { arbiter: arb, hardwareFn: () => noGpu, usedVramFn: () => readings.next().value });
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  expect(svc.status().status).toBe("running");
  expect(arb.reservedMb(TEST_MODEL.id)).toBe(549);
});

test("reserve_floors_at_estimate_when_delta_undercounts", async () => {
  // The delta can UNDER-count — the true-up must floor at the fit estimate, never book less.
  const readings = [5000, 5001][Symbol.iterator]();
  const arb = new VramArbiter();
  const svc = serviceFor(tmp(), { arbiter: arb, hardwareFn: () => fakeHw(8192), usedVramFn: () => readings.next().value });
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  expect(svc.status().status).toBe("running");
  expect(arb.reservedMb(TEST_MODEL.id)).toBeGreaterThan(1); // floored at the formula estimate
});

test("unknown_model_errors", async () => {
  const svc = serviceFor(tmp());
  await svc.load("does-not-exist");
  await join5(svc);
  const st = svc.status();
  expect(st.status).toBe("error");
  expect(st.error).toContain("unknown model");
});

test("start_failure_surfaces_as_error", async () => {
  const boom = () => {
    throw new RuntimeError("llama-server router failed to become healthy");
  };
  const svc = serviceFor(tmp(), { startRouter: boom });
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  expect(svc.status().status).toBe("error");
});

// ── A3: spawn-time backend fallback chain ─────────────────────────────────────

/** A service whose preferred binary(s) throw RunnerStartError at spawn while the rest launch.
 * `exes` = [[gpu, path]] the installed-builds probe reports; the default `acquiredExe`
 * (t/llama-server) is the PREFERRED one. */
function chainFixture(t, { failExes, exes, catalog = null }) {
  const attempts = [];
  const fails = new Set(failExes.map(String));
  const start = (exe) => {
    attempts.push(String(exe));
    if (fails.has(String(exe))) throw new RunnerStartError(`failed to become healthy (exit=3221225781): ${exe}`);
    return fakeRouter();
  };
  const svc = serviceFor(t, { startRouter: start, catalog, acquiredExes: () => [...exes] });
  return [svc, attempts];
}

test("spawn_fallback_takes_next_installed_backend", async () => {
  const t = tmp();
  const preferred = join(t, "llama-server"); // what acquiredExe returns
  const cpuExe = join(t, "llamacpp", "b", "cpu", "llama-server");
  const [svc, attempts] = chainFixture(t, {
    failExes: [preferred],
    exes: [
      ["cuda12", preferred],
      ["cpu", cpuExe],
    ],
  });
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  expect(svc.status().status).toBe("running"); // rescued by the chain
  expect(attempts).toEqual([preferred, cpuExe]); // preferred first, then fallback
  expect(String(svc._activeServerExe)).toBe(cpuExe); // the PROVEN exe is remembered
});

test("spawn_fallback_all_fail_aggregates_reasons", async () => {
  const t = tmp();
  const preferred = join(t, "llama-server");
  const cpuExe = join(t, "llamacpp", "b", "cpu", "llama-server");
  const [svc, attempts] = chainFixture(t, {
    failExes: [preferred, cpuExe],
    exes: [
      ["cuda12", preferred],
      ["cpu", cpuExe],
    ],
  });
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  const st = svc.status();
  expect(st.status).toBe("error");
  expect(st.error).toContain("every installed backend");
  expect(st.error.includes("[preferred]") && st.error.includes("[cpu]")).toBe(true);
  expect(attempts).toEqual([preferred, cpuExe]);
});

test("bounce_after_fallback_reuses_proven_exe", async () => {
  // After a fallback spawn, an .ini-changing second load bounces the router — with the PROVEN
  // exe, never re-trying the broken preferred build.
  const t = tmp();
  const second = entry({ id: "second-model", name: "second", tier: "mid", hfRepo: "org/second", quant: "Q4_K_M" });
  const preferred = join(t, "llama-server");
  const cpuExe = join(t, "llamacpp", "b", "cpu", "llama-server");
  const [svc, attempts] = chainFixture(t, {
    failExes: [preferred],
    exes: [
      ["cuda12", preferred],
      ["cpu", cpuExe],
    ],
    catalog: [TEST_MODEL, second],
  });
  // Hide the second model's weights for load #1 so its .ini section doesn't exist yet — load
  // #2 then CHANGES the .ini and takes the bounce path.
  const secondSnap = join(t, "hf", "models--org--second", "snapshots", "sha");
  rmSync(dirname(dirname(secondSnap)), { recursive: true, force: true });

  await svc.load(TEST_MODEL.id);
  await join5(svc);
  expect(svc.status().status).toBe("running");

  mkdirSync(secondSnap, { recursive: true });
  writeFileSync(join(secondSnap, "model-Q4_K_M.gguf"), Buffer.alloc(1024, "x"));
  await svc.load(second.id);
  await join5(svc);
  expect(svc._resident.get(second.id).status).toBe("running");
  expect(attempts.slice(2)).not.toContain(preferred); // broken preferred exe not re-tried
  expect(attempts.length).toBe(3); // a bounce respawn
  expect(attempts.at(-1)).toBe(cpuExe); // the bounce respawned with the proven exe
});

test("load_without_engine_errors", async () => {
  // A model load REQUIRES the engine installed; no engine → a clear error, no spawn.
  const svc = serviceFor(tmp());
  svc._acquiredExe = () => null;
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  const st = svc.status();
  expect(st.status).toBe("error");
  expect(st.error).toBe("engine-not-installed");
});

test("load_calls_identify_fn", async () => {
  // After download, the runner auto-detects the catalog type via identifyFn.
  const seen = [];
  const svc = serviceFor(tmp(), { identifyFn: (mid) => seen.push(mid) });
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  expect(svc.status().status).toBe("running");
  expect(seen).toEqual([TEST_MODEL.id]);
});

test("load_survives_identify_failure", async () => {
  // Type auto-detect is advisory — a failure must NOT fail the load.
  const svc = serviceFor(tmp(), {
    identifyFn: () => {
      throw new RuntimeError("gguf unreadable");
    },
  });
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  expect(svc.status().status).toBe("running");
});

// ── switch resolution flows into the emitted .ini section ─────────────────────

test("load_applies_profile_switches_for_job", async () => {
  // Legacy jobId override hook: a profileSwitchesFn result REPLACES the model-level base
  // wholesale — verified in the emitted .ini section.
  const svc = serviceFor(tmp(), {
    switchesFn: () => ({ ctx_len: "4096" }), // model base
    profileSwitchesFn: () => ({ ctx_len: "32768" }), // the override hook wins
  });
  await svc.load(TEST_MODEL.id, { jobId: "analysis" });
  await join5(svc);
  expect(svc.status().status).toBe("running");
  expect(ini(svc)).toContain("ctx-size = 32768");
});

test("load_uses_model_base_without_job", async () => {
  // No jobId → the model-level switches apply (profile reader untouched).
  const svc = serviceFor(tmp(), {
    switchesFn: () => ({ ctx_len: "4096" }),
    profileSwitchesFn: () => ({ ctx_len: "32768" }),
  });
  await svc.load(TEST_MODEL.id); // no jobId
  await join5(svc);
  expect(ini(svc)).toContain("ctx-size = 4096");
});

test("load_applies_adhoc_switches", async () => {
  // #20 "Tune & measure" (Option A ephemeral section): ad-hoc switches passed to load() win
  // over the model base, and an unknown key routes to the .ini verbatim.
  const svc = serviceFor(tmp(), { switchesFn: () => ({ ctx_len: "4096" }) });
  await svc.load(TEST_MODEL.id, { switches: { ctx_len: "16384", "--top-n-sigma": "2" } });
  await join5(svc);
  const text = ini(svc);
  expect(text).toContain("ctx-size = 16384"); // ad-hoc beats the base
  expect(text).toContain("top-n-sigma = 2"); // unknown → passthrough into the .ini
});

test("coload_preserves_resident_ephemeral_section", async () => {
  // Defect C (2026-07-22 pass-1 plan T3): model A loads with an EPHEMERAL ctx; model B then
  // co-loads. The re-emitted ini must render A's section from the entry A was LOADED WITH.
  // DB base ctx SMALL (4096) so both models co-fit the fixture's VRAM budget.
  const svc = serviceFor(tmp(), { catalog: [TEST_MODEL, MODEL_B], switchesFn: () => ({ ctx_len: "4096" }) });
  await svc.load(TEST_MODEL.id, { switches: { ctx_len: "8192" } });
  await join5(svc);
  expect(section(ini(svc), TEST_MODEL.id)).toContain("ctx-size = 8192");
  await svc.load(MODEL_B.id);
  await join5(svc);
  expect(svc._resident.get(TEST_MODEL.id)?.status).toBe("running"); // co-resident, not evicted
  const text = ini(svc);
  expect(section(text, TEST_MODEL.id)).toContain("ctx-size = 8192"); // loaded-with survives
  expect(section(text, MODEL_B.id)).toContain("ctx-size = 4096"); // DB base as ever
});

test("windows_strips_mlock_beside_no_mmap", async () => {
  // The (b) rule (user decision 2026-07-22): on Windows the seeded base(mlock) × moe(no_mmap)
  // composition ships a flag that can NEVER lock — strip mlock from the pair at the merge so the
  // emitted ini is truthful.
  const saved = lifecycle.cfg.IS_WINDOWS;
  lifecycle.cfg.IS_WINDOWS = true;
  try {
    const svc = serviceFor(tmp(), { switchesFn: () => ({ mlock: "true", no_mmap: "true" }) });
    await svc.load(TEST_MODEL.id);
    await join5(svc);
    const sec = section(ini(svc), TEST_MODEL.id);
    expect(sec).toContain("no-mmap = true");
    // flag-line form: the tmp path itself may contain the test's name
    expect(sec).not.toContain("mlock = ");
  } finally {
    lifecycle.cfg.IS_WINDOWS = saved;
  }
});

test("mlock_alone_stays_on_windows", async () => {
  // mlock WITHOUT no-mmap genuinely locks on Windows — the strip must not touch it.
  const saved = lifecycle.cfg.IS_WINDOWS;
  lifecycle.cfg.IS_WINDOWS = true;
  try {
    const svc = serviceFor(tmp(), { switchesFn: () => ({ mlock: "true" }) });
    await svc.load(TEST_MODEL.id);
    await join5(svc);
    expect(section(ini(svc), TEST_MODEL.id)).toContain("mlock = true");
  } finally {
    lifecycle.cfg.IS_WINDOWS = saved;
  }
});

test("mlock_no_mmap_pair_kept_off_windows", async () => {
  // Non-Windows is untouched: Linux with IPC_LOCK plausibly locks the pair.
  const saved = lifecycle.cfg.IS_WINDOWS;
  lifecycle.cfg.IS_WINDOWS = false;
  try {
    const svc = serviceFor(tmp(), { switchesFn: () => ({ mlock: "true", no_mmap: "true" }) });
    await svc.load(TEST_MODEL.id);
    await join5(svc);
    const sec = section(ini(svc), TEST_MODEL.id);
    expect(sec.includes("mlock = true") && sec.includes("no-mmap = true")).toBe(true);
  } finally {
    lifecycle.cfg.IS_WINDOWS = saved;
  }
});

const GPU_ONLY = { n_gpu_layers: "cuda,rocm,vulkan,metal", no_mmap: "cuda,rocm,vulkan,metal" };

test("backend_filter_drops_gpu_knobs_on_cpu_engine", async () => {
  // Pass 2 (2026-07-22): knobs whose knob_catalog `backends` excludes the ACTIVE engine
  // family are OMITTED from the section (fit-by-omission).
  const svc = serviceFor(tmp(), {
    switchesFn: () => ({ n_gpu_layers: "99", no_mmap: "true", ctx_len: "4096" }),
    knobBackendsFn: () => ({ ...GPU_ONLY }),
  });
  svc._activeBackend = () => "cpu";
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  const sec = section(ini(svc), TEST_MODEL.id);
  expect(sec).toContain("ctx-size = 4096"); // universal knob untouched
  expect(sec).not.toContain("n-gpu-layers"); // GPU placement dropped on cpu
  expect(sec).not.toContain("no-mmap"); // the RAM-copy flag dropped on cpu
});

test("backend_filter_keeps_gpu_knobs_on_cuda", async () => {
  const svc = serviceFor(tmp(), {
    // ngl 12: BELOW the fake meta's 24 layers, so computeFit passes it through unclamped.
    switchesFn: () => ({ n_gpu_layers: "12", no_mmap: "true" }),
    knobBackendsFn: () => ({ ...GPU_ONLY }),
  });
  svc._activeBackend = () => "cuda";
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  const sec = section(ini(svc), TEST_MODEL.id);
  expect(sec).toContain("n-gpu-layers = 12");
  expect(sec).toContain("no-mmap = true");
});

test("stopped_model_entry_pruned_back_to_db_section", async () => {
  // T3 prune: once A leaves residency its loaded-with entry stops rendering — the next emit
  // derives A's section from DB again.
  const unloaded = [];
  const view = () => routerView(...[TEST_MODEL.id, MODEL_B.id].filter((m) => !unloaded.includes(m)).map((m) => [m, "loaded"]));
  const svc = serviceFor(tmp(), {
    catalog: [TEST_MODEL, MODEL_B],
    routerModels: view,
    routerUnload: (_u, mid) => unloaded.push(mid),
    switchesFn: () => ({ ctx_len: "4096" }),
  });
  await svc.load(TEST_MODEL.id, { switches: { ctx_len: "8192" } });
  await join5(svc);
  await svc.stop(TEST_MODEL.id);
  expect(svc._resident.has(TEST_MODEL.id)).toBe(false);
  await svc.load(MODEL_B.id);
  await join5(svc);
  expect(section(ini(svc), TEST_MODEL.id)).toContain("ctx-size = 4096"); // back to DB
});

// ── co-residence + stop-by-id (the router keeps N models resident) ────────────

test("two_models_co_resident", async () => {
  // Per-model in-flight guard: loading a DIFFERENT model proceeds; both end resident.
  const loads = [];
  const svc = serviceFor(tmp(), { catalog: [TEST_MODEL, MODEL_B], routerLoad: (_u, mid) => loads.push(mid) });
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  await svc.load(MODEL_B.id);
  await join5(svc);
  expect(svc._resident.get(TEST_MODEL.id).status).toBe("running");
  expect(svc._resident.get(MODEL_B.id).status).toBe("running");
  const text = ini(svc);
  expect(text.includes(`[${TEST_MODEL.id}]`) && text.includes(`[${MODEL_B.id}]`)).toBe(true);
  expect(loads.includes(TEST_MODEL.id) && loads.includes(MODEL_B.id)).toBe(true);
});

test("stop_by_id_unloads_one", async () => {
  // The router view REFLECTS the unload (the child exits → gone from GET /models).
  const unloaded = [];
  const view = () => routerView(...[TEST_MODEL.id, MODEL_B.id].filter((m) => !unloaded.includes(m)).map((m) => [m, "loaded"]));
  const svc = serviceFor(tmp(), {
    catalog: [TEST_MODEL, MODEL_B],
    routerModels: view,
    routerUnload: (_u, mid) => unloaded.push(mid),
  });
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  await svc.load(MODEL_B.id);
  await join5(svc);
  await svc.stop(TEST_MODEL.id);
  expect(unloaded).toEqual([TEST_MODEL.id]);
  expect(svc._resident.has(TEST_MODEL.id)).toBe(false);
  expect(svc._resident.get(MODEL_B.id).status).toBe("running");
  expect(svc._router).not.toBeNull(); // router stays up for the other model
});

test("stop_all_tears_down_router", async () => {
  const svc = serviceFor(tmp());
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  expect(svc.status().status).toBe("running");
  expect((await svc.stop()).status).toBe("idle"); // full teardown → back-compat idle
  expect(svc._router).toBeNull();
  expect(svc._resident.size).toBe(0);
});

test("stop_during_load_leaves_no_ghost", async () => {
  // T1 race: a stop() while a load is mid-download must CANCEL the load — the task must not go
  // on to spawn a router / load VRAM that status() would report as idle.
  const entered = new AsyncEvent();
  const gate = new AsyncEvent();
  const spawns = { n: 0 };
  const spyStart = () => {
    spawns.n += 1;
    return fakeRouter();
  };
  const svc = serviceFor(tmp(), { startRouter: spyStart, seedCache: false }); // NOT cached → download runs
  const orig = svc._acquireModel;
  svc._acquireModel = async (...a) => {
    entered.set(); // signal: the load task is now in the download
    await gate.wait(5000); // ...and hold it there until the test releases
    return orig(...a);
  };
  await svc.load(TEST_MODEL.id);
  expect(await entered.wait(5000)).toBe(true); // the load is blocked mid-download
  await svc.stop(); // cancel while mid-download
  expect(svc.status().status).toBe("idle");
  gate.set(); // release the download → the task proceeds
  await join5(svc);
  // It must have bailed at the cancellation re-check: no router spawned, no ghost.
  expect(spawns.n).toBe(0);
  expect(svc._router).toBeNull();
  expect(svc.status().status).toBe("idle");
  expect(svc._resident.has(TEST_MODEL.id)).toBe(false);
});

// ── router-level OOM back-off (startRunner's shed doesn't run in router mode) ─

test("router_load_oom_backoff", async () => {
  // POST /models/load is ASYNC (b9644) — the OOM back-off keys off the child's GET /models
  // status, NOT an HTTP error, AND only fires when the spawn log looks like CUDA-OOM.
  const posts = { n: 0 };
  // Fail loads #1 and #2 (→ shed 20→16→12), then report loaded on #3.
  const failedUntilThird = () => routerView([TEST_MODEL.id, posts.n >= 3 ? "loaded" : "failed"]);
  const paths = {};
  // Stash the per-spawn log path; the OOM text is appended at POST time — the tail read is
  // WATERMARKED per attempt (2026-07-21), so a spawn-time write would land before the watermark.
  const oomRouter = (_exe, opts) => {
    paths.log = opts.logPath;
    return fakeRouter();
  };
  const oomLoad = () => {
    posts.n += 1;
    if (paths.log) appendLine(paths.log, "CUDA error: out of memory\n");
  };
  const svc = serviceFor(tmp(), { startRouter: oomRouter, routerLoad: oomLoad, routerModels: failedUntilThird });
  await svc.load(TEST_MODEL.id, { overrides: new Overrides({ nGpuLayers: 20 }) });
  await join5(svc);
  expect(svc.status().status).toBe("running");
  expect(posts.n).toBe(3); // POSTed 3× (failed twice → shed twice, third loads)
  expect(ini(svc)).toContain("n-gpu-layers = 12"); // 20 → 16 → 12 (step 4)
});

test("router_moe_oom_raises_ncmoe_before_shedding_layers", async () => {
  // The §5.7 shed direction, router edition: a MoE child's OOM raises n-cpu-moe by the step;
  // the layers stay at their tuned ngl.
  const posts = { n: 0 };
  const failedUntilThird = () => routerView([TEST_MODEL.id, posts.n >= 3 ? "loaded" : "failed"]);
  const paths = {};
  const oomRouter = (_exe, opts) => {
    paths.log = opts.logPath;
    return fakeRouter();
  };
  const oomLoad = () => {
    posts.n += 1;
    if (paths.log) appendLine(paths.log, "CUDA error: out of memory\n");
  };
  const svc = serviceFor(tmp(), { startRouter: oomRouter, routerLoad: oomLoad, routerModels: failedUntilThird });
  svc._readMeta = () => ({ blockCount: 24, embeddingLength: 2048, isMoe: true, nKvHeads: 8 });
  await svc.load(TEST_MODEL.id, { overrides: new Overrides({ nGpuLayers: 20, nCpuMoe: 4 }) });
  await join5(svc);
  expect(svc.status().status).toBe("running");
  expect(posts.n).toBe(3);
  expect(ini(svc)).toContain("n-gpu-layers = 20"); // layers NEVER shed while ncmoe has room
  expect(ini(svc)).toContain("n-cpu-moe = 12"); // 4 → 8 → 12 (step 4)
});

test("non_oom_failure_does_not_shed_or_bounce", async () => {
  // A `failed` with NO OOM in the spawn log must fail FAST: no shed, no bounce.
  const spawns = { n: 0 };
  const countSpawn = () => {
    spawns.n += 1;
    return fakeRouter(); // NO oom log written
  };
  const svc = serviceFor(tmp(), { startRouter: countSpawn, routerModels: () => routerView([TEST_MODEL.id, "failed"]) });
  await svc.load(TEST_MODEL.id, { overrides: new Overrides({ nGpuLayers: 20 }) }); // ngl>0, but no OOM signal
  await join5(svc);
  expect(svc.status().status).toBe("error");
  expect(spawns.n).toBe(1); // spawned once, NO bounce on a non-OOM failure
  expect(ini(svc)).toContain("n-gpu-layers = 20"); // ngl NOT shed (stays 20)
});

test("router_sync_reject_errors_without_shed", async () => {
  // A SYNCHRONOUS 4xx from POST /models/load is a real reject, NOT an OOM.
  const spawns = { n: 0 };
  const countSpawn = () => {
    spawns.n += 1;
    return fakeRouter();
  };
  const rejectLoad = () => {
    throw new RuntimeError("/models/load failed [400]: at capacity");
  };
  const svc = serviceFor(tmp(), { startRouter: countSpawn, routerLoad: rejectLoad });
  await svc.load(TEST_MODEL.id, { overrides: new Overrides({ nGpuLayers: 20 }) });
  await join5(svc);
  const st = svc.status();
  expect(st.status).toBe("error");
  expect(st.error).toContain("at capacity"); // the 4xx body propagates verbatim
  expect(spawns.n).toBe(1); // no bounce/re-spawn on a sync reject
});

// ── P1f: async load-confirmation poll (POST accepts; GET /models confirms) ────

test("parse_router_models_reads_nested_status", () => {
  // Box-verified b9644: status is NESTED at data[].status.value; meta only on a loaded child;
  // a flat-string status is tolerated; an id-less entry is skipped.
  const payload = {
    object: "list",
    data: [
      { id: "chat", status: { value: "loaded", args: [], preset: "..." }, meta: { n_params: 7, size: 9, n_ctx: 4096 } },
      { id: "embed", status: { value: "unloaded" } },
      { id: "flat", status: "loading" }, // a hypothetical flat-string build
      { status: { value: "x" } }, // no id → dropped
    ],
  };
  const out = lifecycle._parseRouterModels(payload);
  expect(out.get("chat").value).toBe("loaded");
  expect(out.get("chat").meta.n_params).toBe(7);
  expect(out.get("embed").value).toBe("unloaded");
  expect("meta" in out.get("embed")).toBe(false); // unloaded → no meta block
  expect(out.get("flat").value).toBe("loading"); // flat string tolerated
  expect(out.size).toBe(3); // the id-less entry dropped
});

test("load_polls_until_loaded", async () => {
  // The POST only ACCEPTS; the model reaches 'running' ONLY after GET /models confirms.
  const seq = ["loading", "loading", "loaded"];
  const idx = { i: 0 };
  const models = () => {
    const i = Math.min(idx.i, seq.length - 1);
    idx.i += 1;
    return routerView([TEST_MODEL.id, seq[i]]);
  };
  const sleeps = { n: 0 };
  const svc = serviceFor(tmp(), {
    routerModels: models,
    sleep: () => {
      sleeps.n += 1;
    },
  });
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  expect(svc.status().status).toBe("running");
  expect(sleeps.n).toBeGreaterThanOrEqual(2); // slept between the two 'loading' polls
});

test("load_errors_on_failed_status", async () => {
  // A child that reports 'failed' with no GPU layers left to shed (ngl 0) → immediate error.
  const svc = serviceFor(tmp(), { routerModels: () => routerView([TEST_MODEL.id, "failed"]) });
  await svc.load(TEST_MODEL.id, { overrides: new Overrides({ nGpuLayers: 0 }) });
  await join5(svc);
  const st = svc.status();
  expect(st.status).toBe("error");
  expect(st.error).toContain("failed to load");
});

test("confirm_load_times_out", async () => {
  // A child stuck 'loading' past the deadline → timeout → error (ngl 0 → no back-off).
  const clock = { t: 0.0 };
  const fastClock = () => {
    clock.t += 120.0;
    return clock.t;
  };
  const svc = serviceFor(tmp(), { routerModels: () => routerView([TEST_MODEL.id, "loading"]), now: fastClock, sleep: () => {} });
  await svc.load(TEST_MODEL.id, { overrides: new Overrides({ nGpuLayers: 0 }) });
  await join5(svc);
  const st = svc.status();
  expect(st.status).toBe("error");
  expect(st.error).toContain("status=timeout");
});

// ── P1f: resident set (live GET /models view for /v1/llm-runner/resident) ─────

test("resident_reports_live_set", async () => {
  // /resident reads the router's live GET /models incl. the meta footprint of a loaded child.
  const models = () => ({
    object: "list",
    data: [
      {
        id: TEST_MODEL.id,
        status: { value: "loaded" },
        meta: { n_params: 35_000_000_000, size: 22_000_000_000, n_ctx: 4096 },
      },
    ],
  });
  const svc = serviceFor(tmp(), { routerModels: models });
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  const res = await svc.resident();
  expect(res.router).toBe(true);
  expect(res.models_max === 2 && res.sleep_idle_seconds === 900).toBe(true);
  const row = res.models.find((m) => m.id === TEST_MODEL.id);
  expect(row.status).toBe("loaded");
  expect(row.n_params).toBe(35_000_000_000);
  expect(row.size_bytes).toBe(22_000_000_000);
  expect(row.n_ctx).toBe(4096);
});

test("resident_router_down_is_empty", async () => {
  const svc = serviceFor(tmp()); // never loaded → no router
  const res = await svc.resident();
  expect(res.router).toBe(false);
  expect(res.models).toEqual([]);
  expect(res.models_max).toBe(2);
});

test("resident_shows_in_flight_download", async () => {
  // A load still mid-download is surfaced as 'downloading' so the UI shows progress before the
  // child appears in GET /models. Router down → in-flight only.
  const svc = serviceFor(tmp());
  svc._resident.set(TEST_MODEL.id, { status: "downloading", modelId: TEST_MODEL.id });
  const row = (await svc.resident()).models.find((m) => m.id === TEST_MODEL.id);
  expect(row.status).toBe("downloading");
});

test("resident_surfaces_load_error", async () => {
  // A load that ERRORED before the router spawned (engine-not-installed) must still surface as
  // 'error' via resident() — the router can never report it (no router).
  const svc = serviceFor(tmp());
  svc._acquiredExe = () => null; // engine missing → _runLoad errors, no router spawns
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  expect(svc.status().status).toBe("error");
  const res = await svc.resident();
  expect(res.router).toBe(false);
  const row = res.models.find((m) => m.id === TEST_MODEL.id);
  expect(row.status).toBe("error");
});

// ── T1: the phase is set by the download itself (2026-07-17 approved plan) ──

/** Capture every `detail` value _touch writes, in order, without changing behavior. */
function detailRecorder(svc) {
  const details = [];
  const orig = svc._touch.bind(svc);
  svc._touch = (mid, fields) => {
    if ("detail" in fields) details.push(fields.detail);
    return orig(mid, fields);
  };
  return details;
}

test("cached_model_never_announces_a_download", async () => {
  // A fully cached model: the phantom "model weights" phase must not appear.
  const svc = serviceFor(tmp());
  const details = detailRecorder(svc);
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  expect(svc.status().status).toBe("running");
  expect(details).not.toContain("model weights"); // the phantom (fails before T1)
  expect(details).toContain("preparing"); // the honest neutral phase
});

test("real_download_still_announces_model_weights", async () => {
  const svc = serviceFor(tmp(), { seedCache: false }); // NOT cached → the load actually downloads
  const realAcquire = svc._acquireModel;
  svc._acquireModel = (repo, q, mm, opts = {}) => {
    if (opts.onProgress) opts.onProgress(1024, 4096); // a real chunk lands
    return realAcquire(repo, q, mm, opts);
  };
  const details = detailRecorder(svc);
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  expect(details).toContain("model weights"); // a real download still says so
});

// ── T2: cancel is a per-load token the LOAD TASK honors (2026-07-17 approved plan) ──

test("stop_during_vram_phase_returns_promptly_and_child_is_unloaded", async () => {
  const entered = new AsyncEvent();
  const gate = new AsyncEvent();
  const unloads = [];
  const gatedRouterLoad = async () => {
    entered.set();
    await gate.wait(5000);
  };
  const svc = serviceFor(tmp(), { routerLoad: gatedRouterLoad, routerUnload: (_u, mid) => unloads.push(mid) });
  await svc.load(TEST_MODEL.id);
  expect(await entered.wait(5000)).toBe(true);

  // The user's Cancel, while the spawn is in flight. OLD code: this call blocks on the router
  // lock until the load finishes (the "stuck cancel"). NEW: returns at once.
  expect(await settles(svc.stop(TEST_MODEL.id), 1000)).toBe(true); // stop() must not block behind the load's router ops
  // Double-stop while resolving: also prompt, also harmless.
  expect(await svc.stop(TEST_MODEL.id)).not.toBeNull();

  gate.set();
  await join5(svc);
  // The q2 silent unload: the just-spawned child was unloaded; nothing survives.
  expect(unloads).toEqual([TEST_MODEL.id]);
  expect(svc._resident.has(TEST_MODEL.id)).toBe(false); // no stuck "cancelling"
  expect(svc._arbiter.isReserved(TEST_MODEL.id)).toBe(false); // reservation released
  expect(svc._cancelEvents.size).toBe(0); // token died with its load
});

test("cancel_inside_the_admit_window_never_evicts", async () => {
  // THE panel's architecture finding: between the lock-entry checkpoint and _admit sit
  // syncPins + a catalog() DB round-trip — a cancel landing THERE must not let _admit evict an
  // innocent resident. The cancel is injected from inside the hooked catalogFn WHILE the router
  // lock is held (i.e. inside the window itself).
  const svcRef = {};
  const armed = new AsyncEvent(); // armed only for the SECOND load — not B's seeding
  const fired = [];
  const models = [TEST_MODEL, MODEL_B];
  const hookedCatalog = () => {
    const svc = svcRef.svc;
    // isOwned(): the hook runs ON the load's flow, so "this flow holds the router lock" IS "we're
    // inside the window".
    if (svc && armed.isSet() && svc._routerLock.isOwned() && !fired.length) {
      fired.push(true);
      svc.stop(TEST_MODEL.id); // the cancel lands INSIDE the window (its mid-load branch is synchronous)
    }
    return models;
  };
  const svc = serviceFor(tmp(), { catalog: models });
  svc._catalogFn = hookedCatalog;
  svcRef.svc = svc;

  const admits = [];
  const origAdmit = svc._admit.bind(svc);
  svc._admit = (...a) => {
    admits.push(a);
    return origAdmit(...a);
  };

  // Seed an innocent resident B the eviction would target.
  await svc.load(MODEL_B.id);
  await join5(svc);
  expect(svc._resident.get(MODEL_B.id).status).toBe("running");
  admits.length = 0;
  armed.set();

  await svc.load(TEST_MODEL.id);
  await join5(svc);

  expect(admits).toEqual([]); // _admit must never run for a cancelled load
  expect(fired).toEqual([true]);
  expect(svc._resident.get(MODEL_B.id).status).toBe("running"); // the innocent survived
  expect(svc._arbiter.isReserved(MODEL_B.id)).toBe(true);
  expect(svc._resident.has(TEST_MODEL.id)).toBe(false);
});

test("cancel_during_download_leaves_no_ledger_entry", async () => {
  // The token path end-to-end through the download leg: stop() marks "cancelling" (no pop),
  // the fetch aborts via cancelCheck, and the LOAD TASK cleans up.
  const svcRef = {};
  let checked = null;
  const cancellingAcquire = (_repo, _q, _mm, opts = {}) => {
    svcRef.svc.stop(TEST_MODEL.id); // the user cancels mid-download
    checked = opts.cancelCheck != null && opts.cancelCheck();
    throw new DownloadCancelled();
  };
  const svc = serviceFor(tmp(), { seedCache: false }); // NOT cached → the load's download runs (+ cancels)
  svc._acquireModel = cancellingAcquire;
  svcRef.svc = svc;
  await svc.load(TEST_MODEL.id);
  await join5(svc);

  expect(checked).toBe(true);
  expect(svc._resident.has(TEST_MODEL.id)).toBe(false);
  expect(svc._arbiter.isReserved(TEST_MODEL.id)).toBe(false);
  expect(svc._cancelEvents.size).toBe(0);
  expect(svc.status().status).not.toBe("error"); // a cancel is never a failure
});

test("stop_resident_confirm_unload_timeout_keeps_stopping_then_reconcile_pops", async () => {
  // Pathological branch (contract CHANGED by defect E, 2026-07-22): the router keeps reporting
  // the model loaded after the unload POST. The entry STAYS at "stopping" (bounded poll →
  // WARNING), and resident()'s self-heal pops it the moment the router agrees.
  const clock = { t: 0.0 };
  const live = { loaded: true };
  const view = () => (live.loaded ? routerView([TEST_MODEL.id, "loaded"]) : routerView());
  const svc = serviceFor(tmp(), {
    routerModels: view,
    now: () => clock.t,
    sleep: (s) => {
      clock.t += s;
    },
  });
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  const logs = captureLogs();
  await svc.stop(TEST_MODEL.id);
  expect(logs.some((r) => r.levelname === "WARNING" && r.msg.includes("confirm-unload timeout"))).toBe(true);
  // Router still lists the child → the ledger honestly keeps "stopping".
  expect(svc._resident.get(TEST_MODEL.id)?.status).toBe("stopping");
  // The child finally dies → the next resident() read converges the ledger.
  live.loaded = false;
  await svc.resident();
  expect(svc._resident.has(TEST_MODEL.id)).toBe(false);
});

test("router_load_already_running_adopts_instead_of_erroring", async () => {
  // Defect E (2026-07-22): a ledger↔router drift where the router already runs the model must
  // ADOPT (confirm + reconcile), never error the load.
  const loadAlreadyRunning = (_url, modelId) => {
    throw new RuntimeError(
      `/models/load '${modelId}' failed [400]: ` +
        '{"error":{"code":400,"message":"model is already running","type":"invalid_request_error"}}',
    );
  };
  const svc = serviceFor(tmp(), { routerLoad: loadAlreadyRunning });
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  const st = svc._resident.get(TEST_MODEL.id) || {};
  expect(st.status).toBe("running");
  expect(st.error).toBeFalsy();
});

/** A service whose fake router view REFLECTS unloads (children die on stop) and whose clock is
 * virtual — the defect-D tombstone tests need both. */
function svcWithDyingChildren(t, clock) {
  const unloaded = [];
  const view = () => (unloaded.includes(TEST_MODEL.id) ? routerView() : routerView([TEST_MODEL.id, "loaded"]));
  const svc = serviceFor(t, {
    routerModels: view,
    routerUnload: (_u, mid) => unloaded.push(mid),
    now: () => clock.t,
    sleep: (s) => {
      clock.t += s;
    },
  });
  return [svc, unloaded];
}

test("ensure_refuses_a_just_stopped_model", async () => {
  // Defect D (2026-07-22): stop qwen, and ten seconds later a zombie request's ensure
  // re-loaded it. Inside the tombstone window the ensure THROWS instead of re-loading.
  const clock = { t: 100.0 };
  const [svc] = svcWithDyingChildren(tmp(), clock);
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  await svc.stop(TEST_MODEL.id);
  expect(svc._resident.has(TEST_MODEL.id)).toBe(false);
  await expect(svc.ensureModelReady(TEST_MODEL.id)).rejects.toThrow(/just stopped/);
});

test("direct_load_clears_the_tombstone", async () => {
  // User intent wins: stop → the user loads it again from the app → the tombstone is popped.
  const clock = { t: 100.0 };
  const [svc, unloaded] = svcWithDyingChildren(tmp(), clock);
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  await svc.stop(TEST_MODEL.id);
  unloaded.length = 0; // the router lists it again on reload
  await svc.load(TEST_MODEL.id); // direct load = fresh intent
  await join5(svc);
  expect(svc._resident.get(TEST_MODEL.id).status).toBe("running");
  await svc.ensureModelReady(TEST_MODEL.id); // resident + no tombstone → returns
});

test("tombstone_expires", async () => {
  // Past _STOP_TOMBSTONE_S the ensure auto-load behaves exactly as before. The virtual clock
  // makes ensure's own wait race the real background load, so this asserts the GUARD
  // precisely: no "just stopped" throw, and load() was reached (its entry-seed is synchronous).
  const clock = { t: 100.0 };
  const [svc, unloaded] = svcWithDyingChildren(tmp(), clock);
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  await svc.stop(TEST_MODEL.id);
  clock.t += lifecycle._STOP_TOMBSTONE_S + 1.0;
  unloaded.length = 0;
  try {
    await svc.ensureModelReady(TEST_MODEL.id, 5.0);
  } catch (exc) {
    expect(exc.message).not.toContain("just stopped"); // expired → the guard no longer fires
  }
  expect(svc._resident.has(TEST_MODEL.id)).toBe(true); // the ensure proceeded into load()
  await join5(svc);
});

test("stop_compare_and_pop_spares_a_concurrent_fresh_load", async () => {
  // The panel's stop/auto-load race: a fresh load() lands while stop() is inside its unload —
  // stop's final pop must remove only ITS OWN "stopping" entry, never the fresh "downloading" one.
  const unloadEntered = new AsyncEvent();
  const unloadGate = new AsyncEvent();
  const state = { unloaded: false };
  const gatedUnload = async () => {
    unloadEntered.set();
    await unloadGate.wait(5000);
    state.unloaded = true;
  };
  const reactive = () => routerView([TEST_MODEL.id, state.unloaded ? "unloaded" : "loaded"]);
  const svc = serviceFor(tmp(), { routerUnload: gatedUnload, routerModels: reactive });
  svc._routerLoad = () => {
    state.unloaded = false;
  };
  await svc.load(TEST_MODEL.id);
  await join5(svc);

  const stopDone = svc.stop(TEST_MODEL.id);
  expect(await unloadEntered.wait(5000)).toBe(true);

  // The concurrent fresh load arrives mid-stop and re-seeds the ledger entry.
  await svc.load(TEST_MODEL.id);
  unloadGate.set();
  expect(await settles(stopDone, 10000)).toBe(true);
  await svc._thread.join(10);

  const st = svc._resident.get(TEST_MODEL.id);
  expect(st).toBeDefined(); // stop() must not pop the fresh load's entry
  expect(st.status).toBe("running");
});

// ── the router-listing mask (2026-07-17, the user's dead "Load now" button) ──

test("resident_in_flight_load_outranks_router_idle_listing", async () => {
  const svc = serviceFor(tmp(), { routerModels: () => routerView([TEST_MODEL.id, "unloaded"]) });
  svc._router = fakeRouter(); // router alive, model listed idle
  svc._resident.set(TEST_MODEL.id, { status: "downloading", modelId: TEST_MODEL.id });
  const row = (await svc.resident()).models.find((m) => m.id === TEST_MODEL.id);
  expect(row.status).toBe("downloading"); // the mask reported "unloaded" here
});

test("resident_error_outranks_router_idle_listing", async () => {
  // Same mask, error flavor: the failure (and its CTA) must not be hidden behind "unloaded".
  const svc = serviceFor(tmp(), { routerModels: () => routerView([TEST_MODEL.id, "unloaded"]) });
  svc._router = fakeRouter();
  svc._resident.set(TEST_MODEL.id, { status: "error", modelId: TEST_MODEL.id, error: "spawn refused" });
  const row = (await svc.resident()).models.find((m) => m.id === TEST_MODEL.id);
  expect(row.status).toBe("error");
});

test("resident_reports_stopping_while_router_still_says_loaded", async () => {
  // T2b — during a teardown WE ordered, the router keeps reporting "loaded" until the child
  // exits; painting that re-invites the second Unload click. "stopping" must win the merge.
  const entered = new AsyncEvent();
  const gate = new AsyncEvent();
  const gatedUnload = async () => {
    entered.set();
    await gate.wait(5000);
  };
  // Virtual clock: the confirm-unload poll (router never agrees here) fast-forwards to its
  // bounded timeout instead of spending 5 real seconds.
  const clock = { t: 0.0 };
  const svc = serviceFor(tmp(), {
    routerUnload: gatedUnload,
    routerModels: () => routerView([TEST_MODEL.id, "loaded"]),
    now: () => clock.t,
    sleep: (s) => {
      clock.t += s;
    },
  });
  await svc.load(TEST_MODEL.id);
  await join5(svc);

  const stopDone = svc.stop(TEST_MODEL.id);
  expect(await entered.wait(5000)).toBe(true);
  const row = (await svc.resident()).models.find((m) => m.id === TEST_MODEL.id);
  expect(row.status).toBe("stopping"); // pre-T2b this read "loaded" — the flicker
  gate.set();
  expect(await settles(stopDone, 10000)).toBe(true);
});

test("resident_cancelling_outranks_router_idle_listing", async () => {
  // T2b: a mid-load cancel resolving ("cancelling") must not be masked by the router's idle
  // preset listing.
  const svc = serviceFor(tmp(), { routerModels: () => routerView([TEST_MODEL.id, "unloaded"]) });
  svc._router = fakeRouter();
  svc._resident.set(TEST_MODEL.id, { status: "cancelling", modelId: TEST_MODEL.id });
  const row = (await svc.resident()).models.find((m) => m.id === TEST_MODEL.id);
  expect(row.status).toBe("cancelling");
});

test("resident_router_active_state_beats_stale_in_flight", async () => {
  // Once the child is genuinely loading/loaded, the router's ACTIVE state is the truth.
  const svc = serviceFor(tmp(), { routerModels: () => routerView([TEST_MODEL.id, "loaded"]) });
  svc._router = fakeRouter();
  svc._resident.set(TEST_MODEL.id, { status: "downloading", modelId: TEST_MODEL.id });
  const row = (await svc.resident()).models.find((m) => m.id === TEST_MODEL.id);
  expect(row.status).toBe("loaded");
});

// ── load()/stop() telemetry (2026-07-17: the respawn hunt was blind) ──

test("load_logs_its_trigger", async () => {
  const svc = serviceFor(tmp());
  const logs = captureLogs();
  await svc.load(TEST_MODEL.id, { trigger: "ensure-ready" });
  await join5(svc);
  expect(logs.some((r) => r.msg.includes("trigger=ensure-ready") && r.msg.includes(TEST_MODEL.id))).toBe(true);
});

test("load_default_trigger_is_api_and_warm_noop_still_logs", async () => {
  // Every ask lands in the log — including the warm no-op (a resident model re-asked).
  const svc = serviceFor(tmp());
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  const logs = captureLogs();
  await svc.load(TEST_MODEL.id); // warm — returns without a new task
  expect(logs.some((r) => r.msg.includes("trigger=api"))).toBe(true);
});

test("stop_logs_the_ask", async () => {
  const svc = serviceFor(tmp());
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  const logs = captureLogs();
  await svc.stop(TEST_MODEL.id);
  expect(logs.some((r) => r.msg.includes("stop") && r.msg.includes(TEST_MODEL.id))).toBe(true);
});

test("stop_during_confirm_poll_is_clean", async () => {
  // A stop() issued while a load is in its confirm poll (holding the router lock) — no ghost,
  // no leak.
  const entered = new AsyncEvent();
  const gate = new AsyncEvent();
  const unloaded = [];
  const gatedModels = async () => {
    entered.set(); // the load is now in the confirm poll (holds the lock)
    await gate.wait(5000); // ...hold it there until the test releases
    return routerView([TEST_MODEL.id, "loaded"]);
  };
  const svc = serviceFor(tmp(), { routerModels: gatedModels, routerUnload: (_u, mid) => unloaded.push(mid) });
  await svc.load(TEST_MODEL.id);
  expect(await entered.wait(5000)).toBe(true);
  const stopper = svc.stop(TEST_MODEL.id);
  gate.set(); // release the poll → load finishes → lock frees
  await join5(svc);
  await settles(stopper, 5000);
  expect(unloaded).toEqual([TEST_MODEL.id]); // unloaded once the load completed
  expect(svc._resident.has(TEST_MODEL.id)).toBe(false); // clean: no ghost resident entry
});

// ── P2: VRAM arbiter integration (reserve on load, release on stop, evict LRU) ─

test("load_reserves_and_stop_releases", async () => {
  const svc = serviceFor(tmp());
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  expect(svc._arbiter.isReserved(TEST_MODEL.id)).toBe(true);
  await svc.stop(TEST_MODEL.id);
  expect(svc._arbiter.isReserved(TEST_MODEL.id)).toBe(false);
});

test("stop_all_clears_arbiter", async () => {
  const svc = serviceFor(tmp());
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  await svc.stop(); // full teardown
  expect(svc._arbiter.committedMb() === 0 && svc._arbiter.count() === 0).toBe(true);
});

test("failed_load_leaves_no_reservation", async () => {
  const svc = serviceFor(tmp());
  await svc.load("does-not-exist");
  await join5(svc);
  expect(svc.status().status).toBe("error");
  expect(svc._arbiter.isReserved("does-not-exist")).toBe(false);
});

test("admit_evicts_lru_when_over_budget", async () => {
  // An 8000 MB load onto a 10000 MB card with A(2000, LRU) + B(1000) resident evicts the LRU (A).
  const unloaded = [];
  const arb = new VramArbiter(() => fakeHw(10000));
  arb.reserve("A", 2000); // older → the LRU
  arb.reserve("B", 1000);
  const svc = serviceFor(tmp(), { arbiter: arb, routerUnload: (_u, mid) => unloaded.push(mid) });
  svc._router = fakeRouter();
  svc._resident = new Map([
    ["A", { status: "running" }],
    ["B", { status: "running" }],
  ]);
  await svc._admit("C", 8000, 5, fakeHw(10000));
  expect(unloaded).toEqual(["A"]); // only the LRU evicted (2000 freed → 9000 ≥ 8000)
  expect(!arb.isReserved("A") && arb.isReserved("B")).toBe(true);
});

test("admit_vram_eviction_skips_tiny_cpu_embed", async () => {
  // 2026-07-11: evicting a CPU-placed embed (~44 MB) can't make a GPU model fit.
  const unloaded = [];
  const arb = new VramArbiter(() => fakeHw(8192));
  arb.reserve("cpu-embed", 44);
  const svc = serviceFor(tmp(), { arbiter: arb, routerUnload: (_u, mid) => unloaded.push(mid) });
  svc._router = fakeRouter();
  svc._resident = new Map([["cpu-embed", { status: "running" }]]);
  await svc._admit("big-moe", 16000, 5, fakeHw(8192), { isMoe: true });
  expect(unloaded).toEqual([]); // the tiny embed survived the over-budget admit
  expect(arb.isReserved("cpu-embed")).toBe(true);
  // …but a COUNT-cap eviction still removes it (a child must go regardless of VRAM).
  await svc._admit("third", 10, 1, fakeHw(8192));
  expect(unloaded).toEqual(["cpu-embed"]);
});

test("admit_respects_pinned", async () => {
  // A pinned (embed) reservation is never evicted; the evictable chat goes first.
  const unloaded = [];
  const arb = new VramArbiter(() => fakeHw(1000));
  arb.reserve("embed", 200, { pinned: true }); // older but PINNED
  arb.reserve("chat", 700);
  const svc = serviceFor(tmp(), { arbiter: arb, routerUnload: (_u, mid) => unloaded.push(mid) });
  svc._router = fakeRouter();
  svc._resident = new Map([
    ["embed", { status: "running" }],
    ["chat", { status: "running" }],
  ]);
  await svc._admit("big", 900, 5, fakeHw(1000));
  expect(unloaded).toEqual(["chat"]);
  expect(arb.isReserved("embed")).toBe(true);
});

test("admit_count_cap_evicts_even_when_vram_fits", async () => {
  // models_max caps the child COUNT.
  const unloaded = [];
  const arb = new VramArbiter(() => fakeHw(8000));
  arb.reserve("A", 10); // LRU
  arb.reserve("B", 10);
  const svc = serviceFor(tmp(), { arbiter: arb, routerUnload: (_u, mid) => unloaded.push(mid) });
  svc._router = fakeRouter();
  svc._resident = new Map([
    ["A", { status: "running" }],
    ["B", { status: "running" }],
  ]);
  await svc._admit("C", 10, 2, fakeHw(8000));
  expect(unloaded).toEqual(["A"]); // count 2 == cap → evict LRU so the 3rd fits under the cap
});

test("admit_proceeds_when_only_pinned_and_over_budget", async () => {
  // Everything resident is pinned and it still doesn't fit → proceed anyway (no eviction).
  const unloaded = [];
  const arb = new VramArbiter(() => fakeHw(1000));
  arb.reserve("embed", 900, { pinned: true });
  const svc = serviceFor(tmp(), { arbiter: arb, routerUnload: (_u, mid) => unloaded.push(mid) });
  svc._router = fakeRouter();
  svc._resident = new Map([["embed", { status: "running" }]]);
  await svc._admit("big", 900, 5, fakeHw(1000));
  expect(unloaded).toEqual([]);
  expect(arb.isReserved("embed")).toBe(true);
});

test("load_idempotent_when_running_does_not_respawn", async () => {
  // A plain re-load of a running model is a no-op. The HTTP path ALWAYS passes an empty
  // Overrides(), so the guard must treat Overrides()==default as "no tuning".
  const spawns = { n: 0 };
  const countSpawn = () => {
    spawns.n += 1;
    return fakeRouter();
  };
  const svc = serviceFor(tmp(), { startRouter: countSpawn });
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  expect(spawns.n).toBe(1);
  const st = await svc.load(TEST_MODEL.id, { overrides: new Overrides() }); // the EXACT shape every HTTP load sends
  expect(st.status === "running" && spawns.n === 1).toBe(true); // guard fired → NOT respawned/reloaded
});

test("load_retune_while_running_does_reload", async () => {
  // A Lab re-tune (real overrides) of a running model must NOT be swallowed by the guard.
  const spawns = { n: 0 };
  const countSpawn = () => {
    spawns.n += 1;
    return fakeRouter();
  };
  const svc = serviceFor(tmp(), { startRouter: countSpawn });
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  expect(spawns.n).toBe(1);
  await svc.load(TEST_MODEL.id, { overrides: new Overrides({ ctxLen: 16384 }) }); // real tuning → re-load
  await join5(svc);
  expect(svc.status().status).toBe("running");
  expect(spawns.n).toBe(2); // bounced (respawned) to apply the re-tuned .ini
  expect(ini(svc)).toContain("ctx-size = 16384");
});

// A load held in flight: its first router load waits for `release()`.
function heldFirstLoad() {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  let first = true;
  const routerLoad = async () => {
    if (first) {
      first = false;
      await gate;
    }
  };
  return { routerLoad, release };
}

test("load_retune_asked_while_loading_runs_once_it_finishes", async () => {
  // A re-tune asked while the model's load is still finishing was dropped without a word — the
  // router says loaded before the ledger says running (2026-10-09, the real-router smoke). It
  // now runs once that load finishes.
  const held = heldFirstLoad();
  const svc = serviceFor(tmp(), { routerLoad: held.routerLoad });
  await svc.load(TEST_MODEL.id);
  const first = svc._thread;
  const st = await svc.load(TEST_MODEL.id, { overrides: new Overrides({ ctxLen: 16384 }) });
  expect(["downloading", "starting"]).toContain(st.status); // kept, not started beside it
  held.release();
  await first.join(5);
  await join5(svc); // the re-tune's own load
  expect(svc.status().status).toBe("running");
  expect(ini(svc)).toContain("ctx-size = 16384");
});

test("the_same_load_asked_again_while_loading_stays_a_no_op", async () => {
  const held = heldFirstLoad();
  const svc = serviceFor(tmp(), { routerLoad: held.routerLoad });
  await svc.load(TEST_MODEL.id, { overrides: new Overrides({ ctxLen: 16384 }) });
  const first = svc._thread;
  await svc.load(TEST_MODEL.id, { overrides: new Overrides({ ctxLen: 16384 }) });
  held.release();
  await first.join(5);
  expect(svc._thread).toBe(first); // no second load started
  expect(svc._pendingRetunes.size).toBe(0);
});

test("a_stop_drops_a_retune_asked_while_loading", async () => {
  const held = heldFirstLoad();
  const svc = serviceFor(tmp(), { routerLoad: held.routerLoad });
  await svc.load(TEST_MODEL.id);
  const first = svc._thread;
  await svc.load(TEST_MODEL.id, { overrides: new Overrides({ ctxLen: 16384 }) });
  expect(svc._pendingRetunes.has(TEST_MODEL.id)).toBe(true);
  const stopping = svc.stop(TEST_MODEL.id);
  expect(svc._pendingRetunes.has(TEST_MODEL.id)).toBe(false);
  held.release();
  await stopping;
  await first.join(5);
  expect(svc._thread).toBe(first); // the re-tune never started
});

test("resident_reports_vram_budget", async () => {
  // /resident carries the arbiter's committed/remaining VRAM + each model's reserved vram_mb.
  const arb = new VramArbiter(() => fakeHw(8000));
  arb.reserve("other", 3000);
  const svc = serviceFor(tmp(), { arbiter: arb, routerModels: () => routerView([TEST_MODEL.id, "loaded"]) });
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  const res = await svc.resident();
  expect(res.vram_total_mb).toBe(8000);
  expect(res.committed_mb).toBe(arb.committedMb());
  expect(res.remaining_mb).toBe(8000 - arb.committedMb());
  const row = res.models.find((m) => m.id === TEST_MODEL.id);
  expect("vram_mb" in row).toBe(true);
});

test("admit_retune_excludes_own_reservation", async () => {
  // Re-admitting a model that is ALREADY reserved must not evict itself and must count its own
  // reservation as freeable (a re-tune replaces, not adds).
  const unloaded = [];
  const arb = new VramArbiter(() => fakeHw(1000));
  arb.reserve("chat", 800); // the model being re-tuned
  arb.reserve("other", 100); // a co-resident that must NOT be evicted
  const svc = serviceFor(tmp(), { arbiter: arb, routerUnload: (_u, mid) => unloaded.push(mid) });
  svc._router = fakeRouter();
  svc._resident = new Map([
    ["chat", { status: "running" }],
    ["other", { status: "running" }],
  ]);
  // remaining is 100; re-admit chat at 900 — fits ONLY because chat's own 800 frees back.
  await svc._admit("chat", 900, 5, fakeHw(1000));
  expect(unloaded).toEqual([]);
});

test("evict_rehomes_last_id", async () => {
  // Evicting the primary (_lastId) re-homes it to another resident.
  const arb = new VramArbiter(() => fakeHw(8000));
  arb.reserve("A", 100);
  arb.reserve("B", 100);
  const svc = serviceFor(tmp(), { arbiter: arb });
  svc._router = fakeRouter();
  svc._resident = new Map([
    ["A", { status: "running" }],
    ["B", { status: "running" }],
  ]);
  svc._lastId = "A";
  await svc._evictResident("A");
  expect(svc._lastId === "B" && !svc._resident.has("A")).toBe(true);
});

test("load_evicts_then_reserves_on_success", async () => {
  // A load that needs more than the remaining budget evicts the LRU first, then reserves.
  const unloaded = [];
  const arb = new VramArbiter(() => fakeHw(1000));
  arb.reserve("old", 900); // near-full → the LRU
  const svc = serviceFor(tmp(), { arbiter: arb, routerUnload: (_u, mid) => unloaded.push(mid) });
  svc._router = fakeRouter();
  svc._resident.set("old", { status: "running" });
  svc._hardwareFn = () => fakeHw(1000); // _admit's budget = 1000
  vi.spyOn(processMod, "computeFit").mockReturnValue(
    new FitPlan({ nGpuLayers: 10, nCpuMoe: 0, ctxLen: 4096, blockCount: 24, isMoe: false, vramMb: 800 }),
  );
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  expect(svc.status().status).toBe("running");
  expect(unloaded).toEqual(["old"]); // LRU evicted to make room for the 800 MB load
  expect(svc._arbiter.reservedMb(TEST_MODEL.id)).toBe(800);
});

test("load_evicts_then_fails_releases", async () => {
  // A load that evicts a victim but then FAILS leaves NO reservation for the incoming model.
  const unloaded = [];
  const arb = new VramArbiter(() => fakeHw(1000));
  arb.reserve("old", 900);
  const boom = () => {
    throw new RuntimeError("/models/load failed [400]");
  };
  const svc = serviceFor(tmp(), { arbiter: arb, routerLoad: boom, routerUnload: (_u, mid) => unloaded.push(mid) });
  svc._router = fakeRouter();
  svc._resident.set("old", { status: "running" });
  svc._hardwareFn = () => fakeHw(1000);
  vi.spyOn(processMod, "computeFit").mockReturnValue(
    new FitPlan({ nGpuLayers: 10, nCpuMoe: 0, ctxLen: 4096, blockCount: 24, isMoe: false, vramMb: 800 }),
  );
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  expect(svc.status().status).toBe("error");
  expect(unloaded).toEqual(["old"]); // victim evicted before the (failing) load attempt
  expect(svc._arbiter.isReserved(TEST_MODEL.id)).toBe(false); // incoming released on failure
});

test("reload_respawns_dead_router", async () => {
  // If the router crashed, a plain re-load of a stale-'running' model must RESPAWN the router.
  const spawns = { n: 0 };
  const routers = [];
  const spyStart = () => {
    spawns.n += 1;
    const r = { url: "http://127.0.0.1:8080", isAlive: () => true, stop: () => {} };
    routers.push(r);
    return r;
  };
  const svc = serviceFor(tmp(), { startRouter: spyStart });
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  expect(spawns.n === 1 && svc.status().status === "running").toBe(true);
  routers[0].isAlive = () => false; // the router process dies; the resident entry stays 'running'
  await svc.load(TEST_MODEL.id); // plain re-load (no tuning) → must fall through, not swallow
  await join5(svc);
  expect(spawns.n).toBe(2); // respawned
  expect(svc.status().status).toBe("running");
});

// ── measure / tokenize (re-homed onto the router, routed by model id) ─────────

test("measure_probes_running_model", async () => {
  const svc = serviceFor(tmp());
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  const out = await svc.measure({
    probe: () => [256, 2000.0, null], // 256 tokens in 2.0s → 128 tok/s
    sample: () => ({ vramTotalMb: 8000, ramTotalMb: 32000 }),
  });
  expect(out.ok).toBe(true);
  expect(out.tokensPerSec).toBe(128.0);
  expect(out.completionTokens).toBe(256);
  expect(out.modelId).toBe(TEST_MODEL.id);
  expect(out.vramTotalMb === 8000 && out.ramTotalMb === 32000).toBe(true);
});

test("measure_surfaces_draft_acceptance", async () => {
  // T3: draft timings → draftN / draftNAccepted / draftAcceptance; absent draft → keys absent.
  const svc = serviceFor(tmp());
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  const out = await svc.measure({ probe: () => [200, 1000.0, { n: 173, accepted: 104 }], sample: () => ({}) });
  expect(out.draftN === 173 && out.draftNAccepted === 104).toBe(true);
  expect(out.draftAcceptance).toBe(Math.round((104 / 173) * 10000) / 10000);
  const out2 = await svc.measure({ probe: () => [200, 1000.0, null], sample: () => ({}) });
  expect("draftAcceptance" in out2).toBe(false);
});

test("measure_falls_back_to_router_authority_when_ledger_stale", async () => {
  // 2026-07-21: the internal ledger had gone stale; measure consults the router's live view.
  const svc = serviceFor(tmp());
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  svc._resident.get(TEST_MODEL.id).status = "starting"; // stale ledger
  svc._routerModels = () => routerView([TEST_MODEL.id, "loaded"]);
  const out = await svc.measure({ probe: () => [100, 1000.0, null], sample: () => ({}) });
  expect(out.ok === true && out.modelId === TEST_MODEL.id).toBe(true);
  // Truly absent from the router → still refused.
  svc._routerModels = () => routerView();
  const out2 = await svc.measure({ probe: () => [1, 1.0, null], sample: () => ({}) });
  expect(out2.ok).toBe(false);
  expect(out2.error).toContain("no model running");
});

test("measure_passes_model_id", async () => {
  // Router mode: the probe body carries the model id so the router dispatches right.
  const seen = {};
  const probe = (_url, _p, _n, { modelId = "" } = {}) => {
    seen.mid = modelId;
    return [1, 1000.0, null];
  };
  const svc = serviceFor(tmp());
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  await svc.measure({ probe, sample: () => ({}) });
  expect(seen.mid).toBe(TEST_MODEL.id);
});

test("measure_requires_running_model", async () => {
  const svc = serviceFor(tmp()); // never loaded → idle
  const out = await svc.measure({ probe: () => [1, 1.0, null], sample: () => ({}) });
  expect(out.ok).toBe(false);
  expect(out.error).toContain("no model running");
});

test("tokenize_counts_via_running_model", async () => {
  const svc = serviceFor(tmp());
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  const out = await svc.tokenize({ text: "hello world", probe: () => 7 });
  expect(out.ok === true && out.count === 7).toBe(true);
});

test("tokenize_requires_running_model", async () => {
  const svc = serviceFor(tmp()); // idle
  const out = await svc.tokenize({ text: "x", probe: () => 1 });
  expect(out.ok).toBe(false);
  expect(out.error).toContain("no model running");
});

test("dead_router_flips_to_error", async () => {
  const dead = { url: "http://127.0.0.1:8080", isAlive: () => false, stop: () => {} };
  const svc = serviceFor(tmp(), { startRouter: () => dead });
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  expect(svc.status().status).toBe("error");
});

// ── download-only (fetch weights, no spawn) — its OWN per-model channel, CONCURRENT ─

const dlMap = (svc) => svc.downloadStatus().downloads;

/** Wait for a model's download-only op to SETTLE: absent (done/cancelled) or a persistent
 * 'error' entry. Resolves the terminal entry (null if done). */
async function awaitDownload(svc, modelId, timeout = 5) {
  const t = svc._downloadThreads.get(modelId);
  if (t != null) await t.join(timeout);
  const deadline = Date.now() + timeout * 1000;
  while (Date.now() < deadline) {
    const dl = dlMap(svc);
    if (!(modelId in dl) || dl[modelId].status === "error") return dl[modelId] ?? null;
    await sleep(5);
  }
  throw new Error(`download for '${modelId}' did not settle within ${timeout}s`);
}

async function waitUntil(pred, timeout = 5) {
  const deadline = Date.now() + timeout * 1000;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(5);
  }
  throw new Error("condition not met within timeout");
}

/** A fake `_acquireModel` that BLOCKS until `gate` is set, honouring cancelCheck. */
function gatedAcquire(gate, orig) {
  return async (repo, q, mm, opts = {}) => {
    while (!gate.isSet()) {
      if (opts.cancelCheck?.()) throw new DownloadCancelled();
      await sleep(5);
    }
    return orig(repo, q, mm, opts);
  };
}

test("download_only_fetches_no_spawn", async () => {
  const started = { hit: false };
  const spyStart = () => {
    started.hit = true;
    return fakeRouter();
  };
  const svc = serviceFor(tmp(), { startRouter: spyStart });
  await svc.download(TEST_MODEL.id);
  await awaitDownload(svc, TEST_MODEL.id);
  expect(TEST_MODEL.id in dlMap(svc)).toBe(false); // download channel done (absent == idle)
  expect(svc.status().status).toBe("idle"); // run-state untouched
  expect(svc._router).toBeNull();
  expect(started.hit).toBe(false); // NO spawn
});

test("download_does_not_clobber_running_model", async () => {
  const svc = serviceFor(tmp());
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  expect(svc.status().status).toBe("running");
  await svc.download(TEST_MODEL.id);
  await awaitDownload(svc, TEST_MODEL.id);
  expect(svc.status().status).toBe("running"); // run-state UNTOUCHED
  expect(svc._router).not.toBeNull();
  expect(TEST_MODEL.id in dlMap(svc)).toBe(false);
});

test("download_needs_no_engine", async () => {
  const svc = serviceFor(tmp());
  svc._acquiredExe = () => null;
  await svc.download(TEST_MODEL.id);
  expect(await awaitDownload(svc, TEST_MODEL.id)).toBeNull(); // done, no error entry
  expect(TEST_MODEL.id in dlMap(svc)).toBe(false);
});

test("download_grounds_type_via_identify", async () => {
  const seen = [];
  const svc = serviceFor(tmp(), { identifyFn: (mid) => seen.push(mid) });
  await svc.download(TEST_MODEL.id);
  await awaitDownload(svc, TEST_MODEL.id);
  expect(TEST_MODEL.id in dlMap(svc)).toBe(false);
  expect(seen).toEqual([TEST_MODEL.id]);
});

test("download_unknown_model_errors", async () => {
  const svc = serviceFor(tmp());
  await svc.download("does-not-exist");
  const e = await awaitDownload(svc, "does-not-exist");
  expect(e != null && e.status === "error").toBe(true);
  expect(e.error).toContain("unknown model");
});

test("verify_gguf_raises_corrupt_model_error_and_purges", async () => {
  // The integrity gate: a main GGUF whose header won't parse is purged and thrown as an
  // actionable CorruptModelError carrying the id.
  const t = tmp();
  const svc = serviceFor(t);
  svc._readMeta = raiseBadMagic;
  const m = svc.catalog()[0];
  const repoDir = repoDirOf(t, m);
  const g = join(repoDir, "snapshots", "sha", `model-${m.quant}.gguf`);
  expect(isDir(repoDir)).toBe(true);
  const err = await svc._verifyGguf(m, g).catch((e) => e);
  expect(err).toBeInstanceOf(CorruptModelError);
  expect(err.modelId).toBe(m.id);
  expect(err.message.toLowerCase()).toContain("re-download");
  expect(isDir(repoDir)).toBe(false); // weights purged → a clean re-fetch next time
});

test("download_corrupt_gguf_surfaces_and_purges", async () => {
  const t = tmp();
  const svc = serviceFor(t);
  svc._readMeta = raiseBadMagic;
  const repoDir = repoDirOf(t, TEST_MODEL);
  expect(isDir(repoDir)).toBe(true);
  await svc.download(TEST_MODEL.id);
  const e = await awaitDownload(svc, TEST_MODEL.id);
  expect(e != null && e.status === "error").toBe(true);
  expect(e.error).toContain("corrupted or incomplete");
  expect(isDir(repoDir)).toBe(false);
});

test("download_cancel_returns_to_idle", async () => {
  // cancelDownload(id) signals the in-flight worker; a DownloadCancelled is NOT an error.
  const started = new AsyncEvent();
  const blockingAcquire = async (_repo, _q, _mm, opts = {}) => {
    started.set();
    while (!opts.cancelCheck?.()) await sleep(5); // spin until the test signals cancel
    throw new DownloadCancelled();
  };
  const svc = serviceFor(tmp());
  svc._acquireModel = blockingAcquire;
  await svc.download(TEST_MODEL.id);
  expect(await started.wait(5000)).toBe(true); // the worker reached acquire
  expect(dlMap(svc)[TEST_MODEL.id].status).toBe("downloading");
  await svc.cancelDownload(TEST_MODEL.id);
  await awaitDownload(svc, TEST_MODEL.id);
  expect(TEST_MODEL.id in dlMap(svc)).toBe(false); // cancelled → gone, not an error
  expect(svc.status().status).toBe("idle"); // run-state never touched
});

test("cancel_download_drops_an_errored_row", async () => {
  // An ERRORED download has no worker left to signal; cancelling a terminal row now DROPS it,
  // which is what makes the UI's Dismiss real (user, 2026-07-24: "no way to cancel").
  const svc = serviceFor(tmp());
  svc._acquireModel = () => {
    throw new RuntimeError("nope");
  };
  await svc.download(TEST_MODEL.id);
  const e = await awaitDownload(svc, TEST_MODEL.id);
  expect(e != null && e.status === "error").toBe(true); // the dead row exists

  const left = (await svc.cancelDownload(TEST_MODEL.id)).downloads;
  expect(TEST_MODEL.id in left).toBe(false); // …and cancelling clears it
  expect(TEST_MODEL.id in dlMap(svc)).toBe(false);
});

test("cancel_download_all_clears_errored_rows_too", async () => {
  const svc = serviceFor(tmp());
  svc._acquireModel = () => {
    throw new RuntimeError("nope");
  };
  await svc.download(TEST_MODEL.id);
  expect((await awaitDownload(svc, TEST_MODEL.id)).status).toBe("error");
  expect((await svc.cancelDownload()).downloads).toEqual({});
});

test("cancel_download_noop_when_idle", async () => {
  const svc = serviceFor(tmp());
  expect((await svc.cancelDownload()).downloads).toEqual({});
  expect((await svc.cancelDownload("does-not-exist")).downloads).toEqual({});
});

// ── CONCURRENT downloads (2026-07-20): the per-model map + the admission gate ──────

test("two_downloads_run_concurrently", async () => {
  // Default limit (4) → both admitted at once: both "downloading" PAST "queued".
  const gate = new AsyncEvent();
  const svc = serviceFor(tmp(), { catalog: [TEST_MODEL, MODEL_B] });
  svc._acquireModel = gatedAcquire(gate, svc._acquireModel);
  await svc.download(TEST_MODEL.id);
  await svc.download(MODEL_B.id);
  await waitUntil(() => [TEST_MODEL.id, MODEL_B.id].every((m) => dlMap(svc)[m]?.detail === "model weights"));
  const dl = dlMap(svc);
  for (const m of [TEST_MODEL.id, MODEL_B.id]) {
    expect(dl[m].status === "downloading" && dl[m].detail !== "queued").toBe(true); // both RUNNING
  }
  gate.set(); // release both → they settle
  await awaitDownload(svc, TEST_MODEL.id);
  await awaitDownload(svc, MODEL_B.id);
  expect(dlMap(svc)).toEqual({});
});

test("download_max_concurrent_one_queues_the_second", async () => {
  // limit=1 → the second download stays "queued" until the first frees the slot.
  const gate = new AsyncEvent();
  const svc = serviceFor(tmp(), { catalog: [TEST_MODEL, MODEL_B] });
  svc._configFn = () => ({ downloadMaxConcurrent: 1 });
  svc._acquireModel = gatedAcquire(gate, svc._acquireModel);
  await svc.download(TEST_MODEL.id);
  await waitUntil(() => dlMap(svc)[TEST_MODEL.id]?.detail === "model weights");
  await svc.download(MODEL_B.id); // A holds the only slot → B must queue
  await sleep(100);
  expect(dlMap(svc)[MODEL_B.id].detail).toBe("queued"); // still waiting behind A
  expect(dlMap(svc)[MODEL_B.id].status).toBe("downloading"); // (queued IS a downloading entry)
  gate.set(); // A finishes → B is admitted → both settle
  await awaitDownload(svc, TEST_MODEL.id);
  await awaitDownload(svc, MODEL_B.id);
  expect(dlMap(svc)).toEqual({});
});

test("cancel_one_download_leaves_the_other", async () => {
  const gate = new AsyncEvent();
  const svc = serviceFor(tmp(), { catalog: [TEST_MODEL, MODEL_B] });
  svc._acquireModel = gatedAcquire(gate, svc._acquireModel);
  await svc.download(TEST_MODEL.id);
  await svc.download(MODEL_B.id);
  await waitUntil(() => [TEST_MODEL.id, MODEL_B.id].every((m) => dlMap(svc)[m]?.detail === "model weights"));
  await svc.cancelDownload(TEST_MODEL.id); // cancel ONLY A
  await awaitDownload(svc, TEST_MODEL.id);
  expect(TEST_MODEL.id in dlMap(svc)).toBe(false); // A cancelled → gone
  expect(dlMap(svc)[MODEL_B.id].status).toBe("downloading"); // B untouched, still running
  gate.set();
  await awaitDownload(svc, MODEL_B.id);
});

test("delete_path_cancels_its_own_download", async () => {
  // deleteModelCache frees the handle first — cancels + joins THIS model's download.
  const gate = new AsyncEvent();
  const svc = serviceFor(tmp());
  svc._acquireModel = gatedAcquire(gate, svc._acquireModel);
  await svc.download(TEST_MODEL.id);
  await waitUntil(() => dlMap(svc)[TEST_MODEL.id]?.detail === "model weights");
  const res = await svc.deleteModelCache(TEST_MODEL.id); // cancels the in-flight download, then purges
  expect(res.ok).toBe(true);
  expect(TEST_MODEL.id in dlMap(svc)).toBe(false); // its download was cancelled + reaped
});

test("error_entry_persists_and_is_replaced_by_fresh_download", async () => {
  const t = tmp();
  const svc = serviceFor(t);
  svc._readMeta = raiseBadMagic; // → CorruptModelError at the verify gate
  const repoDir = repoDirOf(t, TEST_MODEL);
  await svc.download(TEST_MODEL.id);
  const e = await awaitDownload(svc, TEST_MODEL.id);
  expect(e.status).toBe("error");
  expect(dlMap(svc)[TEST_MODEL.id].status).toBe("error"); // the error entry PERSISTS in the map

  // A fresh download() REPLACES the error entry. Re-seed good weights + meta so the
  // replacement actually completes and leaves the map.
  const snap = join(repoDir, "snapshots", "sha");
  mkdirSync(snap, { recursive: true });
  writeFileSync(join(snap, `model-${TEST_MODEL.quant}.gguf`), Buffer.alloc(1024, "x"));
  svc._readMeta = fakeMeta;
  const fresh = await svc.download(TEST_MODEL.id);
  expect(fresh.status).toBe("downloading"); // error → a fresh run, not rejected
  await awaitDownload(svc, TEST_MODEL.id);
  expect(TEST_MODEL.id in dlMap(svc)).toBe(false); // now succeeds → leaves the map
});

test("delete_model_cache_removes_repo_dir", async () => {
  // The catalog 'Delete' also reclaims disk: the model's `models--<repo>` dir is removed.
  const t = tmp();
  const svc = serviceFor(t);
  const repoDir = repoDirOf(t, TEST_MODEL);
  expect(isDir(repoDir)).toBe(true); // the fixture seeded the weights
  const res = await svc.deleteModelCache(TEST_MODEL.id);
  expect(res.ok === true && res.bytes > 0).toBe(true);
  expect(existsSync(repoDir)).toBe(false); // weights removed from disk
});

test("delete_model_cache_unknown_is_noop", async () => {
  // Unknown id (the row may already be gone) → idle no-op, never an error.
  const svc = serviceFor(tmp());
  const res = await svc.deleteModelCache("does-not-exist");
  expect(res.ok === true && res.bytes === 0).toBe(true);
});

test("delete_model_cache_keeps_repo_shared_with_sibling", async () => {
  // Two catalog rows on the SAME repo: deleting one KEEPS the repo dir.
  const t = tmp();
  const sibling = entry({ id: "sibling", name: "Sibling", tier: "mid", hfRepo: TEST_MODEL.hfRepo, quant: "Q8_0" });
  const svc = serviceFor(t, { catalog: [TEST_MODEL, sibling] });
  const repoDir = repoDirOf(t, TEST_MODEL);
  const res = await svc.deleteModelCache(TEST_MODEL.id);
  expect(res.ok === true && res.bytes === 0).toBe(true);
  expect(res.detail ?? "").toContain("kept");
  expect(isDir(repoDir)).toBe(true); // sibling's weights untouched
});

// ── engine install as its own step, separate from a model load ────────────────

test("engine_status_reports_installed", () => {
  const svc = serviceFor(tmp()); // acquiredExe stub returns a path → installed
  const es = svc.engineStatus();
  expect(es.installed).toBe(true);
  expect(es.build).toBeTruthy(); // the pinned llama.cpp release tag
  expect(es.status).toBe("idle");
});

test("engine_status_not_installed", () => {
  const svc = serviceFor(tmp());
  svc._acquiredExe = () => null;
  expect(svc.engineStatus().installed).toBe(false);
});

test("engine_status_follows_disk_when_pin_reverted", () => {
  // QC-13 (user's box, 2026-07-09): the pin reverted under an installed newer build. The
  // user's law: "check the path and if path exe exist assume engine is installed" — and the
  // version shown is the DISK's.
  const svc = serviceFor(tmp(), { hardwareFn: winCudaHw });
  svc._acquiredExe = binary.acquiredServerExe; // the REAL disk probe (the factory stubs it)
  const pinned = defaultConfig().llamacpp.pinnedBuild;
  const diskBuild = `b${binary.buildNum(pinned) + 30}`;
  const d = binary.variantDir(svc.cacheRoot, diskBuild, "cuda12");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "llama-server.exe"), "MZ");

  const es = svc.engineStatus();

  expect(es.installed).toBe(true);
  expect(es.build).toBe(diskBuild);
});

test("engine_uninstall_removes_disk_build_when_pin_reverted", async () => {
  // QC-13 companion: uninstall removes the build STATUS reports (the disk's).
  const svc = serviceFor(tmp(), { hardwareFn: winCudaHw });
  svc._acquiredExe = binary.acquiredServerExe;
  const diskBuild = `b${binary.buildNum(defaultConfig().llamacpp.pinnedBuild) + 30}`;
  const d = binary.variantDir(svc.cacheRoot, diskBuild, "cuda12");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "llama-server.exe"), "MZ");

  const out = await svc.uninstallEngine();

  expect(existsSync(join(svc.cacheRoot, "llamacpp", diskBuild))).toBe(false);
  expect(out.installed).toBe(false);
});

// ── The .ini is rendered for the engine that will READ it (2026-09-19, plan
//    docs/plans/2026-09-19-engine-update-safety-and-stable-channel.md §3.6). ──

function seedEngineOnDisk(svc, build, gpu = "cuda12") {
  const d = binary.variantDir(svc.cacheRoot, build, gpu);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "llama-server.exe"), "MZ");
  return join(d, "llama-server.exe");
}
const readIni = (p) => readFileSync(p, "utf8").replace(/\r\n?/g, "\n");

test("emit_ini_renders_for_the_engine_on_disk", () => {
  const svc = serviceFor(tmp(), { hardwareFn: winCudaHw });
  svc._acquiredExe = binary.acquiredServerExe; // the REAL disk probe
  const e = new ModelIniEntry({
    modelId: "m",
    ggufPath: "/m.gguf",
    nGpuLayers: null,
    nCpuMoe: null,
    ctxLen: 4096,
    overrides: new Overrides({ noMmap: true }),
  });

  seedEngineOnDisk(svc, "b10437");
  let [p] = svc._emitIni(e);
  expect(readIni(p)).toContain("load-mode = none");
  expect(readIni(p)).not.toContain("no-mmap");

  rmSync(join(svc.cacheRoot, "llamacpp", "b10437"), { recursive: true, force: true });
  seedEngineOnDisk(svc, "b9993");
  svc._lastIniText = ""; // force a re-render
  [p] = svc._emitIni(e);
  expect(readIni(p)).toContain("no-mmap = true");
  expect(readIni(p)).not.toContain("load-mode");
});

test("emit_ini_ignores_a_stale_proven_exe", () => {
  // THE TRAP (plan §3.6): `_activeServerExe` is NOT cleared by stop(), so after an engine
  // update it still names the SWEPT build. The render must follow the exe that will run.
  const t = tmp();
  const svc = serviceFor(t, { hardwareFn: winCudaHw });
  svc._acquiredExe = binary.acquiredServerExe;
  const newExe = seedEngineOnDisk(svc, "b10964");
  svc._activeServerExe = join(t, "llamacpp", "b9993", "cuda12", "llama-server.exe");
  const e = new ModelIniEntry({
    modelId: "m",
    ggufPath: "/m.gguf",
    nGpuLayers: null,
    nCpuMoe: null,
    ctxLen: 4096,
    overrides: new Overrides({ noMmap: true }),
  });

  expect(svc._engineBuildOf()).toBe("b10964"); // the disk, not the stale pointer
  expect(svc._engineBuildOf(newExe)).toBe("b10964");
  const [p] = svc._emitIni(e);
  expect(readIni(p)).toContain("load-mode = none");
});

test("run_install_hands_the_flag_probes_to_acquire", async () => {
  // A staged build must prove it accepts our launch flags BEFORE it replaces a working engine.
  const t = tmp();
  const seen = {};
  const svc = serviceFor(t);
  svc._acquireBinary = (_cr, _c, _hw, opts = {}) => {
    if (!("probes" in seen)) seen.probes = opts.probeArgvs;
    return join(t, "llama-server");
  };
  await svc.installEngine();
  await svc._engineThread.join(5);

  const probes = seen.probes;
  expect(probes && probes.length).toBeTruthy(); // the install passed flag probes
  expect(probes.every((a) => a.at(-1) === "--version")).toBe(true); // flags FIRST, --version last
});

test("install_engine_runs_acquire", async () => {
  const t = tmp();
  const called = {};
  const svc = serviceFor(t);
  svc._acquireBinary = () => {
    called.hit = true;
    return join(t, "llama-server");
  };
  await svc.installEngine();
  await svc._engineThread.join(5);
  expect(called.hit).toBe(true);
  expect(svc.engineStatus().status).toBe("installed");
});

test("cancel_install_engine_returns_to_idle", async () => {
  // S1: a cancel during the engine build download is NOT an error — the engine returns to
  // the not-installed idle state.
  const started = new AsyncEvent();
  const blockingAcquire = async (_cr, _c, _hw, opts = {}) => {
    started.set();
    while (!opts.cancelCheck?.()) await sleep(5);
    throw new DownloadCancelled();
  };
  const svc = serviceFor(tmp());
  svc._acquireBinary = blockingAcquire;
  await svc.installEngine();
  expect(await started.wait(5000)).toBe(true); // the installer reached the download
  expect(svc.engineStatus().status).toBe("installing");
  await svc.cancelInstallEngine();
  await svc._engineThread.join(5);
  const es = svc.engineStatus();
  expect(es.status).toBe("idle"); // cancelled → idle, not error
  expect(es.error).toBe("");
});

test("cancel_install_engine_noop_when_idle", async () => {
  const svc = serviceFor(tmp());
  const es = await svc.cancelInstallEngine();
  expect(es.status).toBe("idle");
});

test("stop_during_load_download_aborts_without_error", async () => {
  // S2: a stop() during the (unlocked) download aborts the fetch at the next chunk — the model
  // leaves _resident and the load must NOT set an error state.
  const started = new AsyncEvent();
  const blockingAcquire = async (_repo, _q, _mm, opts = {}) => {
    started.set();
    while (!opts.cancelCheck?.()) await sleep(5); // spin until stop() cancels
    throw new DownloadCancelled();
  };
  const svc = serviceFor(tmp(), { seedCache: false }); // NOT cached → the download actually runs
  svc._acquireModel = blockingAcquire;
  await svc.load(TEST_MODEL.id);
  expect(await started.wait(5000)).toBe(true);
  await svc.stop(TEST_MODEL.id);
  await join5(svc);
  const st = svc.status();
  expect(st.status).not.toBe("error"); // a cancel is not a failure
  expect(st.status).toBe("idle");
  expect(svc._resident.has(TEST_MODEL.id)).toBe(false);
});

test("engine_log_empty_then_tails", () => {
  const t = tmp();
  const svc = serviceFor(t);
  expect(svc.engineLog()).toEqual({ path: "", text: "" });
  const p = join(t, "runner.log");
  writeFileSync(p, "a\nb\nc\n");
  svc._lastLogPath = p;
  const out = svc.engineLog({ tail: 2 });
  expect(out.text).toBe("b\nc");
  expect(out.path).toBe(p);
});

// ── P3: co-resident embeddings — ensureEmbedding + pinned + the .ini embed section ──

test("ensure_embedding_no_config_is_noop", async () => {
  // No local embed configured → ok:false, no load kicked off.
  const svc = serviceFor(tmp()); // default embeddingIdsFn → empty
  const res = await svc.ensureEmbedding();
  expect(res.ok).toBe(false);
  expect(svc._thread).toBeNull(); // no background load started
});

test("ensure_embedding_loads_and_pins", async () => {
  // The lazy trigger: ensureEmbedding downloads-if-needed + loads + reserves the embed PINNED.
  const svc = serviceFor(tmp(), { catalog: [EMBED], embeddingIdsFn: () => new Set([EMBED.id]) });
  const res = await svc.ensureEmbedding();
  expect(res.ok).toBe(true);
  expect(res.modelId).toBe(EMBED.id);
  await join5(svc);
  expect(svc.status().status).toBe("running");
  // reserved AND pinned → never the eviction victim
  expect(svc._arbiter.isReserved(EMBED.id)).toBe(true);
  const row = (await svc._arbiter.snapshot()).reservations.find((r) => r.key === EMBED.id);
  expect(row.pinned).toBe(true);
  expect(svc._arbiter.pickEvict()).toBeNull(); // only a pinned reservation → nothing evictable
});

// ── QC-43b: ensureModelReady (BLOCK until resident — the dispatch-path trigger) ──

test("ensure_model_ready_noop_for_falsy_id", async () => {
  const svc = serviceFor(tmp());
  const calls = [];
  svc.load = (...a) => calls.push(a);
  await svc.ensureModelReady("");
  expect(calls).toEqual([]); // never kicked a load
});

test("ensure_model_ready_noop_when_already_resident", async () => {
  // Already resident + child loaded → returns immediately WITHOUT re-loading.
  const svc = serviceFor(tmp());
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  expect(svc.status().status).toBe("running");
  const calls = [];
  svc.load = (...a) => calls.push(a);
  await svc.ensureModelReady(TEST_MODEL.id);
  expect(calls).toEqual([]); // fast path fired → no reload
});

test("ensure_model_ready_loads_then_returns", async () => {
  // Not resident → drives the normal load path and WAITS until the child is loaded. The poll
  // yields to the event loop each iteration (yieldPoll) so the background load actually runs.
  const svc = serviceFor(tmp(), { sleep: yieldPoll });
  await svc.ensureModelReady(TEST_MODEL.id, 10);
  expect(svc.status().status).toBe("running");
  expect(svc._arbiter.isReserved(TEST_MODEL.id)).toBe(true); // went fully resident + reserved
});

test("ensure_model_ready_raises_on_failed_load", async () => {
  // A child that reports 'failed' → the background load errors → ensure throws a clear error.
  const svc = serviceFor(tmp(), { routerModels: () => routerView([TEST_MODEL.id, "failed"]), sleep: yieldPoll });
  await expect(svc.ensureModelReady(TEST_MODEL.id, 10)).rejects.toThrow(/failed to load/);
});

test("embed_own_load_emits_embeddings_section", async () => {
  // PRIMARY P3 path: the embed is loaded as the OVERRIDE, so its section MUST carry
  // embeddings=true + pooling.
  const svc = serviceFor(tmp(), { catalog: [EMBED], embeddingIdsFn: () => new Set([EMBED.id]) });
  await svc.load(EMBED.id);
  await join5(svc);
  const text = ini(svc);
  expect(text).toContain(`[${EMBED.id}]`);
  expect(text).toContain("embeddings = true");
  expect(text).toContain("pooling = mean");
  expect(text).not.toContain("load-on-startup"); // deliberately NOT set — pin is the arbiter reservation
});

test("chat_load_emits_ondisk_embed_section", async () => {
  // DB-resolved path: a CHAT load re-emits the .ini for ALL on-disk models, so the embed's own
  // section also carries embeddings=true.
  const svc = serviceFor(tmp(), { catalog: [TEST_MODEL, EMBED], embeddingIdsFn: () => new Set([EMBED.id]) });
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  const text = ini(svc);
  expect(text.includes(`[${TEST_MODEL.id}]`) && text.includes(`[${EMBED.id}]`)).toBe(true);
  const embedSection = text.split(`[${EMBED.id}]`)[1];
  expect(embedSection).toContain("embeddings = true");
  expect(embedSection).toContain("pooling = mean"); // pooling resolved by id on the DB path too (#119)
  // the chat model's section is NOT marked as an embed
  const chatSection = text.split(`[${TEST_MODEL.id}]`)[1].split("[")[0];
  expect(chatSection).not.toContain("embeddings = true");
});

test("pinned_embed_survives_chat_coresidence", async () => {
  // modelsMax=2: embed(pinned) + chat1 resident → loading chat2 evicts the LRU NON-pinned
  // (chat1), never the pinned embed.
  const svc = serviceFor(tmp(), { catalog: [EMBED, TEST_MODEL, MODEL_B], embeddingIdsFn: () => new Set([EMBED.id]) });
  await svc.ensureEmbedding();
  await join5(svc);
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  await svc.load(MODEL_B.id);
  await join5(svc);
  expect(svc._arbiter.isReserved(EMBED.id)).toBe(true); // embed never evicted (pinned)
  expect(svc._arbiter.isReserved(TEST_MODEL.id)).toBe(false); // chat1 was the LRU eviction victim
  expect(svc._arbiter.isReserved(MODEL_B.id)).toBe(true); // chat2 is now resident
});

test("non_embed_model_reserves_unpinned", async () => {
  // A chat model (not the configured embed) reserves UNPINNED — it can be evicted.
  const svc = serviceFor(tmp(), { catalog: [TEST_MODEL, EMBED], embeddingIdsFn: () => new Set([EMBED.id]) });
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  const row = (await svc._arbiter.snapshot()).reservations.find((r) => r.key === TEST_MODEL.id);
  expect(row.pinned).toBe(false);
  expect(svc._arbiter.pickEvict()).toBe(TEST_MODEL.id);
});

test("switch_rows_type_new_flags", () => {
  // Stored switch ROWS for the 3 new flags land on the TYPED Overrides fields (never
  // extraFlags): reasoning_budget is an int field, the other two stay strings.
  const ov = lifecycle._switchesToOverrides({
    reasoning_budget: "1024",
    reasoning_budget_message: "wrap it up",
    model_draft: "/d/MTP/g-Q4_0-MTP.gguf",
  });
  expect(ov.reasoningBudget).toBe(1024); // int-typed, not "1024"
  expect(ov.reasoningBudgetMessage).toBe("wrap it up");
  expect(ov.modelDraft).toBe("/d/MTP/g-Q4_0-MTP.gguf");
  expect(ov.extraFlags).toEqual([]); // no passthrough leak
});

// ── Gemma-style external MTP draft (Plan B, D7) ──────────────────────────────

test("load_acquires_declared_draft_and_emits_model_draft", async () => {
  // A model declaring a separate MTP draft file + a resolved spec_type=draft-mtp → the draft is
  // acquired via the SAME acquire path and the section carries model-draft = <snapshot path>.
  const t = tmp();
  const svc = serviceFor(t, { catalog: [DRAFT_MODEL] });
  const snap = plantDraft(t);
  await svc.load(DRAFT_MODEL.id, { switches: { spec_type: "draft-mtp" } });
  await join5(svc);
  expect(svc.status().status).toBe("running");
  const text = ini(svc);
  expect(text).toContain("spec-type = draft-mtp");
  expect(text).toContain(`model-draft = ${join(snap, "MTP", "d-Q4_0-MTP.gguf")}`);
});

test("load_fails_loud_when_declared_draft_missing", async () => {
  // The user asked for MTP but the declared draft file is absent after acquire → the LOAD fails
  // with the real reason; never a silent no-MTP fallback.
  const svc = serviceFor(tmp(), { catalog: [DRAFT_MODEL] }); // draft file NOT created
  await svc.load(DRAFT_MODEL.id, { switches: { spec_type: "draft-mtp" } });
  await join5(svc);
  const st = svc.status();
  expect(st.status).toBe("error");
  expect(st.error).toContain("MTP draft");
});

test("load_skips_draft_when_spec_off", async () => {
  const svc = serviceFor(tmp(), { catalog: [DRAFT_MODEL] });
  await svc.load(DRAFT_MODEL.id); // no spec switch → knob default none
  await join5(svc);
  expect(svc.status().status).toBe("running");
  expect(ini(svc)).not.toContain("model-draft");
});

/** Record every computeFit options object, running the REAL function underneath. */
function spyComputeFit() {
  const calls = [];
  const real = processMod.computeFit;
  vi.spyOn(processMod, "computeFit").mockImplementation((...a) => {
    calls.push(a[4] || {});
    return real(...a);
  });
  return calls;
}

test("load_and_preview_charge_the_draft_to_the_fit", async () => {
  // 2026-07-19: a draft is GPU-resident beside the main model, so EVERY fit site must see it.
  // Asserted as wiring (does computeFit receive the draft's meta + byte size).
  const t = tmp();
  const calls = spyComputeFit();
  const svc = serviceFor(t, { catalog: [DRAFT_MODEL], switchesFn: () => ({ spec_type: "draft-mtp" }) });
  // PREVIEW with the draft not yet downloaded → no term (mirrors the emitter's strip)
  svc.previewFit(DRAFT_MODEL.id);
  expect(calls.at(-1).draftMeta).toBeNull();
  expect(calls.at(-1).draftBytes).toBe(0);
  // …once it is on disk, the preview charges it — so the Tune modal matches the spawn
  plantDraft(t, 4096);
  svc.previewFit(DRAFT_MODEL.id);
  expect(calls.at(-1).draftMeta).not.toBeNull();
  expect(calls.at(-1).draftBytes).toBe(4096);
  // …and the ACTIVE load charges the draft it just acquired
  calls.length = 0;
  await svc.load(DRAFT_MODEL.id, { switches: { spec_type: "draft-mtp" } });
  await join5(svc);
  expect(svc.status().status).toBe("running");
  expect(calls.length > 0 && calls.every((c) => c.draftBytes === 4096 && c.draftMeta != null)).toBe(true);
});

test("passive_section_charges_its_cached_draft_to_the_fit", async () => {
  // The third fit site: a PASSIVE .ini section carrying model-draft holds those bytes too.
  const t = tmp();
  const autoMtp = (mid) => (mid === DRAFT_MODEL.id ? { spec_type: "draft-mtp" } : {});
  const calls = spyComputeFit();
  const svc = serviceFor(t, { catalog: [TEST_MODEL, DRAFT_MODEL], switchesFn: autoMtp });
  plantDraft(t, 4096);
  await svc.load(TEST_MODEL.id); // the OTHER model loads → draft-model emits PASSIVELY
  await join5(svc);
  expect(calls.some((c) => c.draftBytes === 4096)).toBe(true); // the passive section
  expect(calls.some((c) => c.draftBytes === 0)).toBe(true); // the draft-less loader
});

test("passive_section_carries_cached_draft", async () => {
  // Diff-checker fold (Plan B D7): the auto-mtp layer can set draft-mtp on a PASSIVE section;
  // when the draft IS cached, the section must carry model-draft.
  const t = tmp();
  const autoMtp = (mid) => (mid === DRAFT_MODEL.id ? { spec_type: "draft-mtp" } : {});
  const svc = serviceFor(t, { catalog: [DRAFT_MODEL, TEST_MODEL], switchesFn: autoMtp });
  const snap = plantDraft(t);
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  const passive = ini(svc).split(`[${DRAFT_MODEL.id}]`)[1].split("[")[0];
  expect(passive).toContain("spec-type = draft-mtp");
  expect(passive).toContain(`model-draft = ${join(snap, "MTP", "d-Q4_0-MTP.gguf")}`);
});

test("passive_section_strips_spec_when_draft_not_cached", async () => {
  // …and when the draft was NEVER downloaded, the passive section STRIPS spec.
  const autoMtp = (mid) => (mid === DRAFT_MODEL.id ? { spec_type: "draft-mtp", spec_n_max: "2" } : {});
  const svc = serviceFor(tmp(), { catalog: [DRAFT_MODEL, TEST_MODEL], switchesFn: autoMtp }); // draft NOT created
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  const passive = ini(svc).split(`[${DRAFT_MODEL.id}]`)[1].split("[")[0];
  expect(passive).not.toContain("spec-type");
  expect(passive).not.toContain("spec-draft-n-max");
  expect(passive).not.toContain("model-draft");
});

test("ini_emit_strip_warns_when_draft_missing", async () => {
  // 2026-07-19: the strip is LOUD — the emitter drops spec AND warns, naming the model id.
  const autoMtp = (mid) => (mid === DRAFT_MODEL.id ? { spec_type: "draft-mtp" } : {});
  const svc = serviceFor(tmp(), { catalog: [DRAFT_MODEL, TEST_MODEL], switchesFn: autoMtp }); // draft NOT created
  const logs = captureLogs();
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  expect(
    logs.some((r) => r.levelname === "WARNING" && r.msg.includes("MTP is OFF for this router section") && r.msg.includes(DRAFT_MODEL.id)),
  ).toBe(true);
});

// ── Download (own channel) acquires the draft too — one acquire path (2026-07-19) ──

test("download_acquires_both_legs_for_mtp", async () => {
  // The Download button fetches the external MTP draft too. Two acquire calls in order (main
  // quant, then the draft file), and the draft leg's phase shows in the download state.
  const t = tmp();
  const svc = serviceFor(t, { catalog: [DRAFT_MODEL], switchesFn: () => ({ spec_type: "draft-mtp" }) });
  const real = svc._acquireModel;
  const calls = [];
  const details = [];
  svc._acquireModel = (repo, second, mm, opts = {}) => {
    calls.push([repo, second]);
    if (second === DRAFT_MODEL.mtpDraftFile) plantDraft(t); // the draft leg → plant the file
    if (opts.onProgress) opts.onProgress(512, 1024); // a real chunk → the leg's phase writes
    details.push(dlMap(svc)[DRAFT_MODEL.id]?.detail);
    return real(repo, second, mm, opts);
  };
  await svc.download(DRAFT_MODEL.id);
  await awaitDownload(svc, DRAFT_MODEL.id);

  expect(DRAFT_MODEL.id in dlMap(svc)).toBe(false); // completed cleanly (absent == done)
  expect(calls).toEqual([
    [DRAFT_MODEL.hfRepo, DRAFT_MODEL.quant],
    [DRAFT_MODEL.hfRepo, DRAFT_MODEL.mtpDraftFile],
  ]);
  expect(details).toContain("MTP draft model");
});

test("download_single_acquire_when_no_draft_wanted", async () => {
  // spec_type=draft-mtp but the model declares NO draft file → exactly ONE acquire.
  const svc = serviceFor(tmp(), { catalog: [TEST_MODEL], switchesFn: () => ({ spec_type: "draft-mtp" }) });
  const calls = [];
  const real = svc._acquireModel;
  svc._acquireModel = (repo, second, ...rest) => {
    calls.push([repo, second]);
    return real(repo, second, ...rest);
  };
  await svc.download(TEST_MODEL.id);
  await awaitDownload(svc, TEST_MODEL.id);
  expect(TEST_MODEL.id in dlMap(svc)).toBe(false);
  expect(calls).toEqual([[TEST_MODEL.hfRepo, TEST_MODEL.quant]]);
});

test("download_cancel_during_draft_leg_returns_to_idle", async () => {
  // A cancel during the SECOND (draft) leg aborts via cancelCheck → the channel returns to idle.
  const svc = serviceFor(tmp(), { catalog: [DRAFT_MODEL], switchesFn: () => ({ spec_type: "draft-mtp" }) });
  const real = svc._acquireModel;
  let checked = null;
  svc._acquireModel = (repo, second, mm, opts = {}) => {
    if (second === DRAFT_MODEL.mtpDraftFile) {
      svc.cancelDownload(DRAFT_MODEL.id); // the user cancels mid-draft (its body is synchronous)
      checked = opts.cancelCheck != null && opts.cancelCheck();
      throw new DownloadCancelled();
    }
    return real(repo, second, mm, opts);
  };
  await svc.download(DRAFT_MODEL.id);
  await awaitDownload(svc, DRAFT_MODEL.id);
  expect(checked).toBe(true);
  expect(DRAFT_MODEL.id in dlMap(svc)).toBe(false); // cancelled → gone (not an error)
});

// ── modelDownloaded: the badge counts the draft when the config wants it ─────────

test("model_downloaded_false_when_wanted_draft_missing_then_true", () => {
  const t = tmp();
  const hfCache = join(t, "hf");
  const svc = serviceFor(t, { catalog: [DRAFT_MODEL], switchesFn: () => ({ spec_type: "draft-mtp" }) });
  // Main weights cached (harness seeds them) but the wanted draft is absent → false.
  expect(svc.modelDownloaded(DRAFT_MODEL, hfCache)).toBe(false);
  // Plant the draft → both legs cached → true.
  plantDraft(t);
  expect(svc.modelDownloaded(DRAFT_MODEL, hfCache)).toBe(true);
});

test("model_downloaded_true_when_draft_not_wanted", () => {
  const t = tmp();
  // spec off → the draft isn't wanted, so a present main GGUF is "downloaded".
  const svc = serviceFor(t, { catalog: [DRAFT_MODEL], switchesFn: () => ({}) });
  expect(svc.modelDownloaded(DRAFT_MODEL, join(t, "hf"))).toBe(true);
});

const hwOf = (fields) => model(HardwareInfo, fields);

test("run_install_plants_fallback_builds", async () => {
  // A3-REVISED (user, 2026-07-07: "we do not even use cpu version"): the one remaining extra is
  // vulkan on a ROCm pick; a CUDA/NVIDIA pick downloads its selected build ONLY.
  const t = tmp();
  const calls = [];
  const spy = (_cr, _c, _hw, { gpu = null } = {}) => {
    calls.push(gpu);
    return join(t, "x");
  };
  const hwRocm = hwOf({ os: "linux", platform: "linux", cpuCores: 8, ramMb: 32000, gpus: [], runtimes: { rocm: true, vulkan: true } });
  const svc = new RunnerService(t, { configFn: defaultConfig, hardwareFn: () => hwRocm, acquireBinary: spy, arbiter: new VramArbiter() });
  await svc.installEngine();
  await svc._engineThread.join(5);
  expect(calls).toEqual([null, "vulkan"]); // rocm→vulkan kept; NO cpu download
  expect(svc._engineState.status).toBe("installed");

  calls.length = 0;
  const hwCuda = winCudaHw();
  const svc2 = new RunnerService(t, { configFn: defaultConfig, hardwareFn: () => hwCuda, acquireBinary: spy, arbiter: new VramArbiter() });
  await svc2.installEngine();
  await svc2._engineThread.join(5);
  expect(calls).toEqual([null]); // NVIDIA: the selected build only — no extras at all
  expect(svc2._engineState.status).toBe("installed");
});

test("run_install_extra_failure_is_best_effort", async () => {
  // A failed EXTRA never fails the install — the selected build gates "installed".
  const t = tmp();
  const calls = [];
  const spy = (_cr, _c, _hw, { gpu = null } = {}) => {
    calls.push(gpu);
    if (gpu === "vulkan") throw new RuntimeError("mirror down");
    return join(t, "x");
  };
  const hwRocm = hwOf({ os: "linux", platform: "linux", cpuCores: 8, ramMb: 32000, gpus: [], runtimes: { rocm: true, vulkan: true } });
  const svc = new RunnerService(t, { configFn: defaultConfig, hardwareFn: () => hwRocm, acquireBinary: spy, arbiter: new VramArbiter() });
  await svc.installEngine();
  await svc._engineThread.join(5);
  expect(calls).toEqual([null, "vulkan"]); // the extra was attempted and failed
  expect(svc._engineState.status).toBe("installed");
});

test("main_gguf_resolves_quant_word_bounded", () => {
  // With a PQ2_0 co-cached beside Q2_0, a plain substring match (+ sort) would return the PQ2_0
  // file ('p' < 'q') and load the WRONG weights. `_mainGguf` is boundary-aware.
  const snap = join(tmp(), "snap");
  mkdirSync(snap);
  writeFileSync(join(snap, "Ternary-Bonsai-27B-PQ2_0.gguf"), "x");
  writeFileSync(join(snap, "Ternary-Bonsai-27B-Q2_0.gguf"), "x");
  // `_mainGguf` does not touch `this` — call it unbound to avoid the heavy service fixture.
  const got = RunnerService.prototype._mainGguf.call(null, snap, "Q2_0");
  expect(basename(got)).toBe("Ternary-Bonsai-27B-Q2_0.gguf");
  const gotPq = RunnerService.prototype._mainGguf.call(null, snap, "PQ2_0");
  expect(basename(gotPq)).toBe("Ternary-Bonsai-27B-PQ2_0.gguf");
});

test("run_install_replace_build_carries_ini_and_deletes_old", async () => {
  // #118 (user, 2026-07-07): an UPDATE replaces the old build — a hand-maintained models.ini
  // inside the old build dir is carried into the new one, then the old folder is deleted. A
  // plain reinstall (replaceBuild == the pin) deletes nothing.
  const t = tmp();
  const c = defaultConfig();
  const newDir = join(t, "llamacpp", c.llamacpp.pinnedBuild);
  const oldDir = join(t, "llamacpp", "b0001");
  mkdirSync(oldDir, { recursive: true });
  writeFileSync(join(oldDir, "models.ini"), "[hand-tuned]\nmodel = x.gguf\n");
  const spy = () => {
    mkdirSync(newDir, { recursive: true });
    return newDir;
  };
  const svc = new RunnerService(t, { configFn: defaultConfig, hardwareFn: winCudaHw, acquireBinary: spy, arbiter: new VramArbiter() });
  await svc.installEngine({ replaceBuild: "b0001" });
  await svc._engineThread.join(5);
  expect(svc._engineState.status).toBe("installed");
  expect(existsSync(oldDir)).toBe(false); // old folder gone
  expect(readFileSync(join(newDir, "models.ini"), "utf8").startsWith("[hand-tuned]")).toBe(true); // ini carried

  // Same-pin guard: a reinstall passing its own build never deletes the fresh install.
  await svc.installEngine({ replaceBuild: c.llamacpp.pinnedBuild });
  await svc._engineThread.join(5);
  expect(existsSync(newDir)).toBe(true);

  // Generalized sweep (2026-07-07): ANY stale build dir goes on the next successful install,
  // while "logs" and the pinned build survive.
  const stale2 = join(t, "llamacpp", "b0002");
  mkdirSync(stale2, { recursive: true });
  const logs = join(t, "llamacpp", "logs");
  mkdirSync(logs, { recursive: true });
  await svc.installEngine();
  await svc._engineThread.join(5);
  expect(!existsSync(stale2) && existsSync(logs) && existsSync(newDir)).toBe(true);
});

// ── 1b fit-by-omission: untuned sections omit placement; F4 any-failure fallback ──

test("untuned_model_ini_omits_placement_knobs", async () => {
  // No tune/preset switches → the section omits n-gpu-layers/n-cpu-moe and still pins
  // ctx-size (ctx policy is ours).
  const svc = serviceFor(tmp());
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  expect(svc.status().status).toBe("running");
  const text = ini(svc);
  expect(text.includes("n-gpu-layers") || text.includes("n-cpu-moe")).toBe(false);
  expect(text).toContain("ctx-size = ");
});

test("tuned_model_ini_renders_explicit_knobs", async () => {
  // A tune value renders exactly — the kit clamps a 99 tune to the model's real block count
  // (24), and "every block" RENDERS as 24 + 1 (llama.cpp counts the output layer; measured
  // 2026-09-19: +5.94 % tok/s on the 26B for full offload).
  const svc = serviceFor(tmp(), { switchesFn: () => ({ n_gpu_layers: "99", n_cpu_moe: "21", ctx_len: "32768" }) });
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  const text = ini(svc);
  expect(text).toContain("n-gpu-layers = 25");
  expect(text).toContain("n-cpu-moe = 21");
  expect(text).toContain("ctx-size = 32768");
});

test("fit_placed_failure_retries_explicit_once", async () => {
  // 1b-F4: a FIT-PLACED entry that fails for ANY reason retries ONCE with the explicit computed
  // placement, then loads.
  const posts = { n: 0 };
  const svc = serviceFor(tmp(), {
    routerLoad: () => {
      posts.n += 1;
    },
    routerModels: () => routerView([TEST_MODEL.id, posts.n >= 2 ? "loaded" : "failed"]),
  });
  await svc.load(TEST_MODEL.id); // no overrides → fit-placed entry (ngl omitted)
  await join5(svc);
  expect(svc.status().status).toBe("running");
  expect(posts.n).toBe(2); // failed once → explicit retry loaded
  expect(ini(svc)).toContain("n-gpu-layers = "); // the retry re-emitted explicit placement
});

test("fit_placed_failure_falls_back_then_fails_fast_on_non_oom", async () => {
  // After the ONE explicit retry, a still-failing non-OOM load fails fast.
  const spawns = { n: 0 };
  const svc = serviceFor(tmp(), {
    startRouter: () => {
      spawns.n += 1;
      return fakeRouter();
    },
    routerModels: () => routerView([TEST_MODEL.id, "failed"]),
  });
  await svc.load(TEST_MODEL.id); // fit-placed
  await join5(svc);
  expect(svc.status().status).toBe("error");
  expect(spawns.n).toBe(2); // the initial spawn + the ONE explicit-retry bounce, no more
});

test("fit_placed_unfixable_fails_fast_without_bounce", async () => {
  // 1b-F4 guard: a FIT-PLACED load whose log shows an UNFIXABLE error (a rejected CLI flag /
  // unknown architecture) must fail FAST — no retry bounce.
  const spawns = { n: 0 };
  const paths = {};
  const unfixableRouter = (_exe, opts) => {
    spawns.n += 1;
    paths.log = opts.logPath;
    return fakeRouter();
  };
  // The engine rejects the flag DURING this attempt — after the POST watermark.
  const rejectLoad = () => {
    if (paths.log) appendLine(paths.log, "error: invalid argument: --no-such-flag\n");
  };
  const svc = serviceFor(tmp(), {
    startRouter: unfixableRouter,
    routerLoad: rejectLoad,
    routerModels: () => routerView([TEST_MODEL.id, "failed"]),
  });
  await svc.load(TEST_MODEL.id); // fit-placed (ngl omitted)
  await join5(svc);
  expect(svc.status().status).toBe("error");
  expect(spawns.n).toBe(1); // spawned once, NO fit-placed retry bounce on an unfixable failure
});

test("unfixable_draft_arch_fails_fast_with_mtp_hint", async () => {
  // 2026-07-21: an UNKNOWN-ARCHITECTURE draft is unfixable — it must fail FAST AND the error
  // must name MTP so the user knows to turn it off or set a compatible draft.
  const t = tmp();
  const spawns = { n: 0 };
  const paths = {};
  const unfixableRouter = (_exe, opts) => {
    spawns.n += 1;
    paths.log = opts.logPath;
    return fakeRouter();
  };
  const badDraftArchLoad = () => {
    if (paths.log) {
      // BOTH the loader's unknown-arch line AND the router's draft wrapper.
      appendLine(paths.log, "llama_model_load: error: unknown model architecture: 'dspark'\n");
      appendLine(paths.log, "srv load_model: failed to load draft model, '/x/dspark.gguf'\n");
    }
  };
  const svc = serviceFor(t, {
    catalog: [DRAFT_MODEL],
    startRouter: unfixableRouter,
    routerLoad: badDraftArchLoad,
    routerModels: () => routerView([DRAFT_MODEL.id, "failed"]),
  });
  plantDraft(t);
  await svc.load(DRAFT_MODEL.id, { switches: { spec_type: "draft-mtp" } }); // fit-placed + a draft
  await join5(svc);
  const st = svc.status();
  expect(st.status).toBe("error");
  expect(spawns.n).toBe(1); // failed FAST — no co-load-race restart detour
  expect(st.error.toLowerCase()).toContain("turn mtp off"); // the actionable MTP guidance
});

test("fit_placed_stale_log_line_does_not_suppress_retry", async () => {
  // Watermark proof (2026-07-21): an unfixable-looking line ALREADY in the router log (written
  // before this attempt's POST watermark) must NOT suppress the fit-placed explicit retry.
  const spawns = { n: 0 };
  const staleRouter = (_exe, opts) => {
    spawns.n += 1;
    const lp = opts.logPath;
    if (lp && spawns.n === 1) {
      mkdirSync(dirname(lp), { recursive: true });
      writeFileSync(lp, "error: invalid argument: --from-a-previous-model\n"); // the STALE line
    }
    return fakeRouter();
  };
  const svc = serviceFor(tmp(), { startRouter: staleRouter, routerModels: () => routerView([TEST_MODEL.id, "failed"]) });
  await svc.load(TEST_MODEL.id); // fit-placed
  await join5(svc);
  expect(svc.status().status).toBe("error");
  expect(spawns.n).toBe(2); // the explicit retry STILL happened — the stale line was ignored
});

test("engine_uninstall_removes_build_dir", async () => {
  // Uninstall deletes the pinned build's binary dir and resets the engine state; the HF model
  // cache is untouched.
  const svc = serviceFor(tmp());
  const d = binary.binaryDir(svc.cacheRoot, defaultConfig().llamacpp.pinnedBuild);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "llama-server"), "x");
  const modelCache = join(svc.cacheRoot, "hf");
  expect(existsSync(modelCache)).toBe(true);

  const out = await svc.uninstallEngine();

  expect(existsSync(d)).toBe(false);
  expect(existsSync(modelCache)).toBe(true); // models are kept
  expect(out.status).toBe("idle");
});

test("engine_uninstall_removes_every_build", async () => {
  // THE USER'S BUG (2026-07-21): two builds on disk — the old uninstall removed only ONE. Now
  // it sweeps them ALL. `logs/` and a loose `models.ini` are kept.
  const svc = serviceFor(tmp(), { hardwareFn: winCudaHw });
  svc._acquiredExe = binary.acquiredServerExe; // the REAL disk probe
  const root = join(svc.cacheRoot, "llamacpp");
  for (const build of ["b0001", "b0002"]) {
    const d = binary.variantDir(svc.cacheRoot, build, "cuda12");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "llama-server.exe"), "MZ");
  }
  mkdirSync(join(root, "logs"), { recursive: true });
  writeFileSync(join(root, "logs", "keep.log"), "log");
  writeFileSync(join(root, "models.ini"), "ini");

  const out = await svc.uninstallEngine();

  expect(existsSync(join(root, "b0001")) || existsSync(join(root, "b0002"))).toBe(false); // BOTH removed
  expect(existsSync(join(root, "logs", "keep.log"))).toBe(true); // logs kept
  expect(existsSync(join(root, "models.ini"))).toBe(true); // loose models.ini kept
  expect(out.status === "idle" && out.installed === false && !out.error).toBe(true);
});

test("engine_uninstall_cancels_a_live_install", async () => {
  // Uninstall CANCELS the in-flight install, joins its task, THEN removes the builds.
  const started = new AsyncEvent();
  const blockingAcquire = async (_cr, _c, _hw, opts = {}) => {
    started.set();
    while (!opts.cancelCheck?.()) await sleep(5);
    throw new DownloadCancelled();
  };
  const svc = serviceFor(tmp());
  svc._acquireBinary = blockingAcquire;
  const d = binary.variantDir(svc.cacheRoot, "b0001", "cuda12");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "llama-server.exe"), "MZ");

  await svc.installEngine();
  expect(await started.wait(5000)).toBe(true); // the installer is mid-download
  expect(svc.engineStatus().status).toBe("installing");

  const out = await svc.uninstallEngine(); // cancels it, joins, then sweeps

  expect(svc._engineThread == null || !svc._engineThread.isAlive()).toBe(true);
  expect(existsSync(d)).toBe(false); // the build was removed after the cancel
  expect(out.status === "idle" && !out.error).toBe(true);
});

test("engine_uninstall_reports_a_locked_build_honestly", async () => {
  // A Windows file-lock that survives the retry must NOT be swallowed: the stuck dir is named
  // in an honest error, and the removable builds still go.
  const svc = serviceFor(tmp());
  for (const build of ["b0001", "b0002"]) {
    const d = binary.variantDir(svc.cacheRoot, build, "cuda12");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "llama-server.exe"), "MZ");
  }
  const real = lifecycle._rmtreeWithRetry;
  vi.spyOn(lifecycle, "_rmtreeWithRetry").mockImplementation((p, o) => (basename(p) === "b0002" ? Promise.resolve(false) : real(p, o)));

  const out = await svc.uninstallEngine();

  expect(out.error).toContain("b0002"); // the stuck dir is named, not hidden
  expect(existsSync(join(svc.cacheRoot, "llamacpp", "b0001"))).toBe(false); // the removable one still went
});

test("update_check_reports_newer_build", async () => {
  // A5: newer upstream tag → updateAvailable; the fetch is injected.
  const svc = serviceFor(tmp());
  svc._latestBuildFn = () => "b99999";
  const out = await svc.updateCheck();
  expect(out.updateAvailable === true && out.latest === "b99999" && out.error === "").toBe(true);
});

test("update_check_same_and_error_paths", async () => {
  const svc = serviceFor(tmp());
  svc._latestBuildFn = () => svc._configFn().llamacpp.pinnedBuild;
  expect((await svc.updateCheck()).updateAvailable).toBe(false);

  svc._latestBuildFn = () => {
    throw new RuntimeError("offline");
  };
  const out = await svc.updateCheck();
  expect(out.updateAvailable).toBe(false);
  expect(out.error).toContain("offline");
});

// ── QC-25: the update check + pin follow the DISK ─────────────────────────

/** Put a build NEWER than the seed pin on disk (the user's reset-regression shape). */
function newerDiskBuild(cacheRoot, offset = 35) {
  const diskBuild = `b${binary.buildNum(defaultConfig().llamacpp.pinnedBuild) + offset}`;
  const d = binary.variantDir(cacheRoot, diskBuild, "cuda12");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "llama-server.exe"), "MZ");
  return diskBuild;
}

test("update_check_reports_disk_build_when_pin_reverted", async () => {
  // QC-25 (user's box, 2026-07-09): `current` must be the DISK's build; latest == disk ⇒ no
  // update offered.
  const svc = serviceFor(tmp(), { hardwareFn: winCudaHw });
  svc._acquiredExe = binary.acquiredServerExe;
  const diskBuild = newerDiskBuild(svc.cacheRoot);
  svc._latestBuildFn = () => diskBuild;

  const out = await svc.updateCheck();

  expect(out.current).toBe(diskBuild);
  expect(out.updateAvailable === false && out.error === "").toBe(true);
});

test("update_check_pin_fallback_when_nothing_installed", async () => {
  // Nothing on disk → `current` falls back to the pin, and a newer upstream still reports.
  const svc = serviceFor(tmp(), { hardwareFn: winCudaHw });
  svc._acquiredExe = () => null;
  svc._latestBuildFn = () => "b99999";

  const out = await svc.updateCheck();

  expect(out.current).toBe(svc._configFn().llamacpp.pinnedBuild);
  expect(out.updateAvailable).toBe(true);
});

test("update_check_deliberate_pin_bump_still_reports", async () => {
  // The Update flow writes pinnedBuild=latest BEFORE installing: `current` stays the DISK build
  // and the newer latest still reports available.
  const svc = serviceFor(tmp(), { hardwareFn: winCudaHw });
  svc._acquiredExe = binary.acquiredServerExe;
  const diskBuild = newerDiskBuild(svc.cacheRoot);
  const bumped = `b${binary.buildNum(diskBuild) + 10}`;
  svc._configFn = () => {
    const c = defaultConfig();
    c.llamacpp.pinnedBuild = bumped;
    return c;
  };
  svc._latestBuildFn = () => bumped;

  const out = await svc.updateCheck();

  expect(out.current).toBe(diskBuild);
  expect(out.updateAvailable).toBe(true);
});

test("deliberate_downgrade_survives_install", async () => {
  // The user deliberately pins an OLDER build and clicks Reinstall: the install fetches the pin,
  // the sweep removes the newer dir, and NOTHING rewrites the pin behind the user's back.
  const svc = serviceFor(tmp(), { hardwareFn: winCudaHw });
  svc._acquiredExe = binary.acquiredServerExe;
  const newer = newerDiskBuild(svc.cacheRoot);
  const older = `b${binary.buildNum(defaultConfig().llamacpp.pinnedBuild) - 50}`;
  const state = { pin: older };
  svc._configFn = () => {
    const c = defaultConfig();
    c.llamacpp.pinnedBuild = state.pin;
    return c;
  };
  svc._acquireBinary = (cacheRoot, config) => {
    const d = binary.variantDir(cacheRoot, config.llamacpp.pinnedBuild, "cuda12");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "llama-server.exe"), "MZ");
    return join(d, "llama-server.exe");
  };
  await svc.installEngine({ force: true });
  await svc._engineThread.join(5);

  expect(svc._engineState.status).toBe("installed");
  expect(state.pin).toBe(older); // downgrade survived
  expect(existsSync(join(svc.cacheRoot, "llamacpp", newer))).toBe(false); // sweep removed the newer
  expect(svc.engineStatus().build).toBe(older);
});

// ── #274 half 2 (2026-07-11): the embed CPU-placement guarantee ───────────────

test("embed_tier_cpu_forced_to_ngl0", async () => {
  // tier "cpu" (the ROUND-4 law) → the section carries an EXPLICIT n-gpu-layers = 0 + the
  // capped embed ctx.
  const svc = serviceFor(tmp(), { catalog: [EMBED_CPU], embeddingIdsFn: () => new Set([EMBED_CPU.id]), hardwareFn: () => fakeHw(8192) });
  await svc.load(EMBED_CPU.id);
  await join5(svc);
  const text = ini(svc);
  expect(text).toContain("n-gpu-layers = 0");
  expect(text).toContain("ctx-size = 8192"); // _EMBED_CTX_CAP — never a chat-sized KV pool
});

test("embed_leftover_gates_gpu_placement", async () => {
  // A non-cpu-tier embed rides the GPU only when the STATIC leftover (card minus the LOCAL chat
  // default's CLAIM) covers its own floor. seedCache false: the chat default is NOT downloaded,
  // so the claim resolver's DECLARED arm answers (estVramMb).
  const t = tmp();
  const build = (vramMb) =>
    serviceFor(join(t, String(vramMb)), {
      catalog: [EMBED_MID, CHAT_26B],
      embeddingIdsFn: () => new Set([EMBED_MID.id]),
      defaultLlmIdFn: () => CHAT_26B.id,
      hardwareFn: () => fakeHw(vramMb),
      seedCache: false,
    });

  let svc = build(8192); // leftover 8192-17713 → 0 < 4500 → CPU
  await svc.load(EMBED_MID.id);
  await join5(svc);
  let sec = ini(svc).split(`[${EMBED_MID.id}]`)[1].split("\n[")[0];
  expect(sec).toContain("n-gpu-layers = 0");

  // THE 2026-07-25 refinement's proof case: a 16 GB card under the old min-floor baseline handed
  // this embed the GPU; est-based: leftover 0 → CPU.
  svc = build(16384);
  await svc.load(EMBED_MID.id);
  await join5(svc);
  sec = ini(svc).split(`[${EMBED_MID.id}]`)[1].split("\n[")[0];
  expect(sec).toContain("n-gpu-layers = 0");

  svc = build(24576); // leftover 24576-17713 = 6863 >= 4500 → GPU (fit-placed → NO explicit ngl)
  await svc.load(EMBED_MID.id);
  await join5(svc);
  sec = ini(svc).split(`[${EMBED_MID.id}]`)[1].split("\n[")[0];
  expect(sec).not.toContain("n-gpu-layers");
});

test("embed_placement_is_the_one_source", () => {
  // `embedPlacement()` is what BOTH the loader and the models endpoint read — pin its verdicts.
  const svc = serviceFor(tmp(), {
    catalog: [EMBED_CPU, EMBED_MID, CHAT_26B],
    embeddingIdsFn: () => new Set([EMBED_CPU.id, EMBED_MID.id]),
    defaultLlmIdFn: () => CHAT_26B.id,
    hardwareFn: () => fakeHw(24576),
    seedCache: false,
  });
  const hw = fakeHw(24576);
  let [place, left] = svc.embedPlacement(EMBED_CPU, hw);
  expect(place).toBe("cpu"); // cpu-tier NEVER claims the GPU
  [place, left] = svc.embedPlacement(EMBED_MID, hw);
  expect(place === "gpu" && left === 24576 - 17713).toBe(true); // est-based leftover, floor fits
  [place, left] = svc.embedPlacement(EMBED_MID, fakeHw(16384));
  expect(place === "cpu" && left === 0).toBe(true); // chat-first: the flagship wants the card
});

test("embed_leftover_consumes_the_claim_ladder", () => {
  // Phase 5 (§6.6): with the chat default DOWNLOADED, the leftover subtracts the resolver's
  // COMPUTED claim instead of the declared est.
  const svc = serviceFor(tmp(), {
    catalog: [EMBED_MID, CHAT_26B],
    embeddingIdsFn: () => new Set([EMBED_MID.id]),
    defaultLlmIdFn: () => CHAT_26B.id,
    hardwareFn: () => fakeHw(24576),
  }); // seedCache true
  const left = svc._embedGpuLeftoverMb(fakeHw(24576));
  const claim = 24576 - left;
  expect(claim > 0 && claim < 17713).toBe(true); // the computed booking, NOT the declared est
  // And a RESIDENT chat wins over everything (arm 1): its booked reservation.
  svc._arbiter.reserve(CHAT_26B.id, 6500, { kind: "llm", source: "measured" });
  expect(svc._embedGpuLeftoverMb(fakeHw(24576))).toBe(24576 - 6500);
});

test("preview_fit_carries_the_claim", () => {
  // §6.2: previewFit IS the claim-resolver door. Downloaded → computed arm; not-downloaded →
  // ok:false but the claim still answers (declared arm).
  const t = tmp();
  const svc = serviceFor(t, { catalog: [CHAT_26B], hardwareFn: () => fakeHw(8192) });
  const out = svc.previewFit(CHAT_26B.id);
  expect(out.ok).toBe(true);
  expect(out.claim.source).toBe("computed");
  expect(out.claim.vramMb).toBeGreaterThan(0);
  const svc2 = serviceFor(join(t, "nodl"), { catalog: [CHAT_26B], hardwareFn: () => fakeHw(8192), seedCache: false });
  const out2 = svc2.previewFit(CHAT_26B.id);
  expect(out2.ok).toBe(false);
  expect(out2.claim).toEqual({ vramMb: 17713, ramMb: 0, source: "declared", matches: 0 });
});

test("embed_explicit_tune_ngl_wins_over_policy", async () => {
  // A user tune's explicit ngl beats the placement policy (power-user escape hatch).
  const svc = serviceFor(tmp(), {
    catalog: [EMBED_CPU],
    embeddingIdsFn: () => new Set([EMBED_CPU.id]),
    switchesFn: () => ({ n_gpu_layers: "10" }),
    hardwareFn: () => fakeHw(8192),
  });
  await svc.load(EMBED_CPU.id);
  await join5(svc);
  expect(ini(svc)).toContain("n-gpu-layers = 10");
});

test("non_embed_untouched_by_placement", async () => {
  // A chat model is NEVER forced to CPU by the embed policy.
  const svc = serviceFor(tmp(), { hardwareFn: () => fakeHw(8192) });
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  expect(ini(svc)).not.toContain("n-gpu-layers = 0");
});

// ── 2026-07-11 fail-fast: a dead child must not be polled to the deadline ────

test("confirm_load_fails_fast_on_child_exit_line", async () => {
  // A crashed child can leave the router reporting `loading` forever (the brick) — the confirm
  // must fail on the router log's own death line.
  const t = tmp();
  const svc = serviceFor(t, { routerModels: () => routerView([TEST_MODEL.id, "loading"]), sleep: () => {} });
  svc._router = fakeRouter();
  const logFile = join(t, "router.log");
  writeFileSync(logFile, "spawning...\ninstance name=test-model exited with status 1\n");
  svc._lastLogPath = logFile;
  expect(await svc._confirmLoad(TEST_MODEL.id, 0)).toBe("failed");
});

test("confirm_load_ignores_exit_line_before_watermark", async () => {
  // A death line from a PREVIOUS attempt (before this load's log watermark) must not fail THIS
  // load — the scan starts at the offset captured at POST time.
  const t = tmp();
  const svc = serviceFor(t, { routerModels: () => routerView([TEST_MODEL.id, "loading"]), sleep: () => {} });
  svc._router = fakeRouter();
  const logFile = join(t, "router.log");
  writeFileSync(logFile, "instance name=test-model exited with status 1\n");
  svc._lastLogPath = logFile;
  const clock = [0.0, 1e9][Symbol.iterator](); // deadline snapshot, then a poll far past it
  svc._now = () => clock.next().value;
  expect(await svc._confirmLoad(TEST_MODEL.id, statSync(logFile).size)).toBe("timeout");
});

test("confirm_load_treats_error_value_as_failed", async () => {
  // A router that reports `error` (not just `failed`) is terminal too.
  const svc = serviceFor(tmp(), { routerModels: () => routerView([TEST_MODEL.id, "error"]), sleep: () => {} });
  svc._router = fakeRouter();
  expect(await svc._confirmLoad(TEST_MODEL.id)).toBe("failed");
});

// ── 2026-07-11 ledger honesty: fresh-spawn reconcile + measured true-up ──────

test("fresh_spawn_reconciles_stale_ledger", async () => {
  // A router that died OUTSIDE stop() leaves resident entries + reservations behind; the fresh
  // spawn must drop them.
  const arb = new VramArbiter();
  const svc = serviceFor(tmp(), { arbiter: arb, hardwareFn: () => fakeHw(8192) });
  svc._resident.set("ghost-embed", { status: "running" });
  arb.reserve("ghost-embed", 3600, { pinned: true });
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  expect(svc.status().status).toBe("running");
  expect(svc._resident.has("ghost-embed")).toBe(false);
  expect(arb.isReserved("ghost-embed")).toBe(false);
  expect(arb.isReserved(TEST_MODEL.id)).toBe(true);
});

test("trued_up_trues_down_to_measured", async () => {
  // 2026-07-11 inversion: the measured delta wins in BOTH directions; a real delta is "measured".
  const svc = serviceFor(tmp(), { usedVramFn: () => 7500 });
  expect(await svc._truedUpVramMb(16000, 1000, fakeHw(8192))).toEqual([6500, "measured"]);
});

test("trued_up_unmeasurable_caps_at_card", async () => {
  // No probe → the estimate survives ("computed"), but a child can never book more than the card.
  const svc = serviceFor(tmp()); // usedVramFn → null (unmeasurable)
  expect(await svc._truedUpVramMb(16000, null, fakeHw(8192))).toEqual([8192, "computed"]);
});

test("trued_up_keeps_driver_ctx_floor", async () => {
  // A GPU-claiming fit whose delta under-counts still books at least the driver-context constant.
  const svc = serviceFor(tmp(), { usedVramFn: () => 5001 });
  expect(await svc._truedUpVramMb(4000, 5000, fakeHw(8192))).toEqual([549, "measured"]);
});

// ── 2026-07-11 admission: refuse a DOOMED dense/explicit spawn ────────────────

test("admit_refuses_dense_explicit_when_only_pinned", async () => {
  // The proceed-anyway safety net is a lie for a DENSE entry with EXPLICIT ngl — refuse
  // actionably instead.
  const arb = new VramArbiter();
  const svc = serviceFor(tmp(), { arbiter: arb, hardwareFn: () => fakeHw(8192) });
  arb.reserve("pinned-embed", 8000, { pinned: true });
  svc._resident.set("pinned-embed", { status: "running" });
  await expect(svc._admit(TEST_MODEL.id, 7000, 2, fakeHw(8192), { nglExplicit: true, isMoe: false })).rejects.toThrow(
    /Not enough free VRAM/,
  );
  // a MoE (its estimate over-books) and a fit-placed entry proceed
  await svc._admit(TEST_MODEL.id, 7000, 2, fakeHw(8192), { nglExplicit: true, isMoe: true });
  await svc._admit(TEST_MODEL.id, 7000, 2, fakeHw(8192), { nglExplicit: false, isMoe: false });
});

test("no_badged_model_is_launchable", async () => {
  // §7.3's launchable pin (§8.23 — verdicts inform, never gate): a model whose COARSE BADGE
  // reads "no" on this box still loads untuned.
  const m = entry({
    id: "too-big",
    name: "Too Big",
    tier: "mid",
    hfRepo: "org/too-big-GGUF",
    quant: "Q4_K_M",
    totalParams: "26B",
    recommendedFor: { minVramMb: 16000, estVramMb: 17713 },
  });
  const hw = fakeHw(4096);
  expect(
    fitMod.coarseFit({
      totalParams: "26B",
      quant: "Q4_K_M",
      vramMb: 4096,
      ramMb: hw.ramMb || 0,
      marginMb: 1024,
      minVramOverride: 16000,
      minRamOverride: null,
    }),
  ).toBe("no"); // the badge this box shows for it
  const svc = serviceFor(tmp(), { catalog: [m], hardwareFn: () => hw });
  await svc.load(m.id); // untuned: fit-placed, no explicit ngl
  await join5(svc);
  expect(svc.status().status).toBe("running");
});

// ── 2026-07-11 hardening: transient IO is NOT corruption — no purge ──────────

test("verify_gguf_locked_file_no_purge", async () => {
  // A sharing violation / AV scan holding the file open must NOT purge good weights.
  const t = tmp();
  const svc = serviceFor(t);
  svc._readMeta = () => {
    throw Object.assign(new Error("sharing violation"), { code: "EACCES", errno: -4092, syscall: "open" });
  };
  const m = svc.catalog()[0];
  const repoDir = repoDirOf(t, m);
  const g = join(repoDir, "snapshots", "sha", `model-${m.quant}.gguf`);
  expect(isDir(repoDir)).toBe(true);
  await expect(svc._verifyGguf(m, g)).rejects.toThrow(/locked/);
  expect(isDir(repoDir)).toBe(true); // weights NOT deleted
});

// ── 2026-07-12: an embed SWITCH swaps the embed slot — the chat model never pays ──

test("embed_switch_evicts_replaced_embed_not_chat", async () => {
  // Live repro: switching the embedding default auto-loaded the new embed; the OLD embed's STALE
  // pin deflected the count-cap eviction onto Gemma. Pins re-sync; the replaced embed is the
  // preferred victim.
  const oldEmbed = entry({
    id: "embed-old",
    name: "Old Embed",
    tier: "cpu",
    hfRepo: "org/embed-old-GGUF",
    quant: "Q8_0",
    pooling: "last",
    embedding: true,
    recommendedFor: { minVramMb: 1500 },
  });
  const unloaded = [];
  const arb = new VramArbiter();
  const svc = serviceFor(tmp(), {
    catalog: [EMBED_CPU, oldEmbed],
    arbiter: arb,
    embeddingIdsFn: () => new Set([EMBED_CPU.id]), // the NEW default
    routerUnload: (_u, mid) => unloaded.push(mid),
    hardwareFn: () => fakeHw(8192),
  });
  svc._router = fakeRouter();
  // Pre-switch world: the chat is the LRU, the old embed still carries its earned pin.
  arb.reserve("chat-26b", 5900);
  arb.reserve(oldEmbed.id, 550, { pinned: true });
  svc._resident.set("chat-26b", { status: "running" });
  svc._resident.set(oldEmbed.id, { status: "running" });

  await svc.load(EMBED_CPU.id); // the dropdown switch's auto-load (modelsMax default = 2)
  await join5(svc);

  expect(unloaded).toEqual([oldEmbed.id]); // the REPLACED embed went, not the chat
  expect(arb.isReserved("chat-26b")).toBe(true);
  expect(arb.isReserved(EMBED_CPU.id)).toBe(true);
  const row = (await arb.snapshot()).reservations.find((r) => r.key === EMBED_CPU.id);
  expect(row.pinned).toBe(true); // protection followed the new default
});

test("embed_leftover_falls_back_to_downloaded_chat_floor", async () => {
  // Plan-A boxes leave the routing default LLM empty — the baseline then falls back to the
  // largest-floor DOWNLOADED chat model.
  const svc = serviceFor(tmp(), {
    catalog: [EMBED_MID, CHAT_26B],
    embeddingIdsFn: () => new Set([EMBED_MID.id]),
    hardwareFn: () => fakeHw(8192),
  }); // no defaultLlmIdFn
  await svc.load(EMBED_MID.id);
  await join5(svc);
  const sec = ini(svc).split(`[${EMBED_MID.id}]`)[1].split("\n[")[0];
  expect(sec).toContain("n-gpu-layers = 0");
});

// ── 2026-07-12: embed switch must NOT churn the .ini (Fix A) ──────────────────

test("ini_stable_across_embed_default_switch", () => {
  // All embed sections are marked regardless of which is the default, so the .ini is
  // byte-stable across a switch (no bounce, the chat model never disturbed).
  const active = { id: EMBED_CPU.id };
  const svc = serviceFor(tmp(), {
    catalog: [EMBED_CPU, EMBED_MID, CHAT_26B],
    embeddingIdsFn: () => new Set([active.id]),
    hardwareFn: () => fakeHw(8192),
  });
  svc._lastIniText = "";
  svc._emitIni();
  const iniA = ini(svc);
  active.id = EMBED_MID.id; // the user switches the default embed
  svc._lastIniText = ""; // force a rewrite so we compare the RESOLVED text
  svc._emitIni();
  const iniB = ini(svc);
  expect(iniA).toBe(iniB); // byte-identical → no bounce on switch
  expect(iniA.split("embeddings = true").length - 1).toBe(2); // BOTH embeds marked
  expect(iniA).toContain("[chat-26b]");
  expect(iniA.split("[chat-26b]")[1].split("\n[")[0]).not.toContain("embeddings = true"); // chat isn't an embed
});

// ── 2026-07-12: MTP draft co-load crash recovers WITHOUT dropping MTP (Fix B) ──

test("draft_crash_unloads_coresident_and_keeps_mtp", async () => {
  // Stage 1 (cheap, no restart): the draft crashes beside the resident embed → the embed is
  // unloaded so the draft loads SOLO, and the entry KEEPS its draft.
  const t = tmp();
  const unloaded = [];
  const state = { embedUp: true };
  const models = () => routerView([GEMMA_MTP.id, state.embedUp ? "failed" : "loaded"], [EMBED_CPU.id, "loaded"]);
  const unload = (_u, mid) => {
    unloaded.push(mid);
    if (mid === EMBED_CPU.id) state.embedUp = false;
  };
  const arb = new VramArbiter();
  const holder = {};
  const svc = serviceFor(t, {
    catalog: [GEMMA_MTP, EMBED_CPU],
    arbiter: arb,
    routerModels: models,
    routerUnload: unload,
    routerLoad: draftCrashLoader(holder),
    hardwareFn: () => fakeHw(8192),
    sleep: () => {},
  });
  holder.svc = svc;
  svc._router = fakeRouter();
  svc._lastLogPath = join(t, "router.log");
  svc._resident.set(GEMMA_MTP.id, { status: "starting" });
  svc._resident.set(EMBED_CPU.id, { status: "running" });
  arb.reserve(EMBED_CPU.id, 44);

  const e = mtpEntry();
  await svc._routerLoadWithBackoff(e, mtpFit(), join(t, "llama-server"), svc.config());

  expect(unloaded).toEqual([EMBED_CPU.id]); // co-resident freed, no restart
  expect(e.overrides.modelDraft).toBe("/x/mtp-draft.gguf"); // MTP never dropped
  expect(e.overrides.specType).toBe("draft-mtp");
});

test("draft_crash_escalates_to_restart_keeping_mtp", async () => {
  // Stage 2 (last resort): a full engine restart to load the draft ALONE, still with MTP.
  const t = tmp();
  // Before a restart the kit looks for other programs on the GPU (2026-09-30) — nobody else
  // holds memory here.
  vi.spyOn(lifecycle, "_otherGpuHolders").mockResolvedValue([]);
  const events = [];
  const state = { restarted: false };
  const models = () => routerView([GEMMA_MTP.id, state.restarted ? "loaded" : "failed"]); // only the solo load succeeds
  const startRouter = () => {
    state.restarted = true;
    events.push("restart");
    return fakeRouter();
  };
  const arb = new VramArbiter();
  const holder = {};
  const svc = serviceFor(t, {
    catalog: [GEMMA_MTP],
    arbiter: arb,
    routerModels: models,
    startRouter,
    routerLoad: draftCrashLoader(holder),
    hardwareFn: () => fakeHw(8192),
    sleep: () => {},
  });
  holder.svc = svc;
  svc._router = fakeRouter();
  svc._activeServerExe = join(t, "llama-server");
  svc._lastLogPath = join(t, "router.log");
  svc._resident.set(GEMMA_MTP.id, { status: "starting" });

  const e = mtpEntry();
  // No co-residents → Stage 1 is skipped; Stage 2 (restart) fires.
  await svc._routerLoadWithBackoff(e, mtpFit(), join(t, "llama-server"), svc.config());

  expect(events).toEqual(["restart"]); // escalated to exactly one restart
  expect(e.overrides.specType).toBe("draft-mtp"); // MTP still intact after recovery
});

test("draft_crash_solo_still_fails_raises_never_drops_mtp", async () => {
  // Solo + restart both still crash on the draft → a GENUINE draft problem. Surface the real
  // error; never silently drop MTP.
  const t = tmp();
  vi.spyOn(lifecycle, "_otherGpuHolders").mockResolvedValue([]); // the message probes the GPU
  const holder = {};
  const svc = serviceFor(t, {
    catalog: [GEMMA_MTP],
    routerModels: () => routerView([GEMMA_MTP.id, "failed"]),
    startRouter: () => fakeRouter(),
    routerLoad: draftCrashLoader(holder),
    hardwareFn: () => fakeHw(8192),
    sleep: () => {},
  });
  holder.svc = svc;
  svc._router = fakeRouter();
  svc._activeServerExe = join(t, "llama-server");
  const crashLog = join(t, "router.log");
  svc._lastLogPath = crashLog;
  // The stage-2 restart rotates the log via _routerLogPath; pin it so the loader's per-POST
  // crash appends keep landing where the (post-restart) attempt tails from.
  svc._routerLogPath = () => crashLog;
  svc._resident.set(GEMMA_MTP.id, { status: "starting" });

  const e = mtpEntry();
  await expect(svc._routerLoadWithBackoff(e, mtpFit(), join(t, "llama-server"), svc.config())).rejects.toThrow(
    /speculative-decoding|MTP/,
  );
  expect(e.overrides.specType).toBe("draft-mtp"); // NOT dropped even on the hard failure
});

// ── Phase 5: the persisted-measured arm + the load recorder ──────────────────

const measRow = (modelId, machineKey, backend, source, vramModelMb, switches, label = "") => ({
  modelId,
  machineKey,
  backend,
  source,
  vramModelMb,
  label,
  tokensPerSec: 0.0,
  switches: Object.entries(switches).map(([flagName, flagValue]) => ({ flagName, flagValue })),
});

test("claim_measured_arm_fingerprint_match_and_median", () => {
  const hw = fakeHw(8192);
  const svc = serviceFor(tmp(), { catalog: [CHAT_26B], hardwareFn: () => hw });
  // Learn the config the resolver will actually request (so the fingerprint matches).
  const base = svc.previewFit(CHAT_26B.id);
  expect(base.ok).toBe(true);
  const fset = new Set([
    "ctx_len",
    "n_gpu_layers",
    "n_cpu_moe",
    "cache_type_k",
    "cache_type_v",
    "flash_attn",
    "no_kv_offload",
    "parallel",
    "batch_size",
    "ubatch_size",
  ]);
  const matchSw = { n_gpu_layers: String(base.nGpuLayers), n_cpu_moe: String(base.nCpuMoe), ctx_len: String(base.ctxLen) };
  const mk = hardware.machineKey(hw);
  const rows = [
    measRow(CHAT_26B.id, mk, "cuda", "load", 6400, matchSw),
    measRow(CHAT_26B.id, mk, "cuda", "load", 6500, matchSw),
    measRow(CHAT_26B.id, mk, "cuda", "load", 9000, matchSw),
    // A DIFFERENT ctx (fingerprint miss §13.4 — never blended in):
    measRow(CHAT_26B.id, mk, "cuda", "load", 20000, { ...matchSw, ctx_len: "999999" }),
    // Another box / another backend / a speed row: never this box's evidence.
    measRow(CHAT_26B.id, "other|1|2c|4g", "cuda", "load", 100, matchSw),
    measRow(CHAT_26B.id, mk, "vulkan", "load", 100, matchSw),
    measRow(CHAT_26B.id, mk, "cuda", "tune", 100, matchSw),
  ];
  svc._measurementsFn = () => rows;
  svc._fitRelevantFlagsFn = () => fset;
  const out = svc.previewFit(CHAT_26B.id);
  expect(out.claim.source).toBe("measured");
  expect(out.claim.vramMb).toBe(6500); // the MEDIAN of the three matches
  expect(out.claim.matches).toBe(3);
  // No fingerprint set wired → matching impossible → computed (never a guess).
  svc._fitRelevantFlagsFn = null;
  expect(svc.previewFit(CHAT_26B.id).claim.source).toBe("computed");
});

test("load_records_footprint_and_overhead_rows", async () => {
  // A confirmed load persists its footprint (source='load') and — when the true-up really
  // measured on the device — the observed physics overhead as the build-stamped machine row.
  const recorded = [];
  const rec = (modelId, { vramModelMb, switches, source, label }) => {
    recorded.push({ id: modelId, mb: vramModelMb, sw: { ...switches }, source, label });
  };
  const svc = serviceFor(tmp(), { usedVramFn: () => 5000 }); // delta 0 → floor 549, "measured"
  svc._recordLoadFn = rec;
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  expect(svc.status().status).toBe("running");
  const loadRows = recorded.filter((r) => r.source === "load");
  expect(loadRows.length).toBe(1);
  expect(loadRows[0].id).toBe(TEST_MODEL.id);
  expect(loadRows[0].mb).toBe(549); // the driver-ctx floor the ledger booked
  for (const k of ["n_gpu_layers", "n_cpu_moe", "ctx_len"]) expect(k in loadRows[0].sw).toBe(true);
  const over = recorded.filter((r) => r.id === "__overhead__");
  expect(over.length === 1 && over[0].source === "probe").toBe(true);
  expect(over[0].label.startsWith("physics-overhead ")).toBe(true);
  // vram-truth plan §6.5: the stamp carries the physics version.
  expect(over[0].label.endsWith(` ${fitMod.PHYSICS_VERSION}`)).toBe(true);
  expect(over[0].mb).toBeGreaterThanOrEqual(0);
});

test("unmeasured_load_records_no_overhead_row", async () => {
  const recorded = [];
  const svc = serviceFor(tmp()); // probe unmeasurable → source "computed"
  svc._recordLoadFn = (modelId, kw) => recorded.push([modelId, kw]);
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  expect(recorded.map(([mid]) => mid)).toEqual([TEST_MODEL.id]); // footprint yes, overhead no
  expect(recorded[0][1].label).toBe("load footprint (computed)");
});

// ── Admission counts memory OTHER programs hold (2026-08-14) ─────────

/** Point the kit's cached probe door at a fixed measured occupancy. */
const probeUsed = (usedMb) => vi.spyOn(hardware, "usedPoolMb").mockResolvedValue(usedMb);

test("admit_refuses_when_other_programs_fill_the_card", async () => {
  // 8 GB card, 6 GB held by other programs, nothing of ours resident: a 4 GB model does NOT
  // fit, and the ledger alone would have said it did.
  probeUsed(6000);
  const arb = new VramArbiter(() => fakeHw(8192));
  const svc = serviceFor(tmp(), { arbiter: arb });
  svc._router = fakeRouter();
  const err = await svc._admit("dense", 4000, 5, fakeHw(8192), { nglExplicit: true }).catch((e) => e);
  expect(err).toBeInstanceOf(RuntimeError);
  // The message tells the MEASURED story, not ledger arithmetic.
  expect(err.message).toContain("held by other programs");
});

test("admit_allows_what_actually_fits", async () => {
  // Same card and same foreign usage, a model that genuinely fits the 2 GB left: admitted.
  probeUsed(6000);
  const unloaded = [];
  const arb = new VramArbiter(() => fakeHw(8192));
  const svc = serviceFor(tmp(), { arbiter: arb, routerUnload: (_u, mid) => unloaded.push(mid) });
  svc._router = fakeRouter();
  await svc._admit("small", 1500, 5, fakeHw(8192));
  expect(unloaded).toEqual([]);
});

test("admit_evicts_ours_before_blaming_other_programs", async () => {
  // 2 GB foreign + 4 GB of ours on an 8 GB card. A 5 GB model needs our resident model gone —
  // and the eviction loop must run on the LEDGER (measuring per iteration over-evicts). The
  // probe DRAINS: 6000 until the victim is unloaded, then 2000 (the post-eviction wait).
  const unloaded = [];
  vi.spyOn(hardware, "usedPoolMb").mockImplementation(async () => (unloaded.length ? 2000 : 6000));
  const arb = new VramArbiter(() => fakeHw(8192));
  arb.reserve("old", 4000);
  const svc = serviceFor(tmp(), { arbiter: arb, routerUnload: (_u, mid) => unloaded.push(mid) });
  svc._router = fakeRouter();
  svc._resident = new Map([["old", { status: "running" }]]);
  await svc._admit("new", 5000, 5, fakeHw(8192));
  expect(unloaded).toEqual(["old"]); // exactly one victim, not a cascade
  expect(arb.isReserved("old")).toBe(false);
});

test("admit_unmeasurable_box_behaves_exactly_as_before", async () => {
  // Probe returns null → foreign 0 → the pre-2026-08-14 ledger behaviour.
  probeUsed(null);
  const unloaded = [];
  const arb = new VramArbiter(() => fakeHw(8192));
  const svc = serviceFor(tmp(), { arbiter: arb, routerUnload: (_u, mid) => unloaded.push(mid) });
  svc._router = fakeRouter();
  await svc._admit("fits-the-ledger", 7000, 5, fakeHw(8192));
  expect(unloaded).toEqual([]);
});

// ── the sleeping child, runner half (2026-08-15) ─────────────────────────────

const sleepingRouterModels =
  (...sleeping) =>
  () =>
    routerView(...[TEST_MODEL, MODEL_B].map((m) => [m.id, sleeping.includes(m.id) ? "sleeping" : "loaded"]));

test("reconcile_sleeping_reads_the_router", async () => {
  const hw = fakeHw(8192);
  const arb = new VramArbiter(() => hw);
  const svc = serviceFor(tmp(), { arbiter: arb, hardwareFn: () => hw, routerModels: sleepingRouterModels("test-model") });
  svc._router = fakeRouter();
  arb.reserve("test-model", 6000, { kind: "llm", evictFn: () => {} });
  expect(arb.committedMb()).toBe(6000);
  await svc.reconcileSleeping({ force: true });
  // The child's weights are gone: the ledger stops calling that memory taken.
  expect(arb.isAsleep("test-model")).toBe(true);
  expect(arb.committedMb() === 0 && arb.bookedMb() === 6000).toBe(true);
});

test("reconcile_sleeping_leaves_the_ledger_alone_when_the_router_is_down", async () => {
  // Conservative on purpose: keeping a booking can only refuse a load, never overcommit one.
  const hw = fakeHw(8192);
  const arb = new VramArbiter(() => hw);
  const svc = serviceFor(tmp(), { arbiter: arb, hardwareFn: () => hw, routerModels: sleepingRouterModels("test-model") });
  arb.reserve("test-model", 6000, { kind: "llm", evictFn: () => {} });
  svc._router = null;
  await svc.reconcileSleeping({ force: true });
  expect(!arb.isAsleep("test-model") && arb.committedMb() === 6000).toBe(true);
});

test("reconcile_sleeping_survives_a_failing_probe", async () => {
  const hw = fakeHw(8192);
  const arb = new VramArbiter(() => hw);
  const svc = serviceFor(tmp(), {
    arbiter: arb,
    hardwareFn: () => hw,
    routerModels: () => {
      throw new RuntimeError("router GET exploded");
    },
  });
  svc._router = fakeRouter();
  arb.reserve("test-model", 6000, { kind: "llm", evictFn: () => {} });
  await svc.reconcileSleeping({ force: true }); // must not throw
  expect(arb.committedMb()).toBe(6000);
});

test("ensure_model_ready_admits_the_wake_and_evicts_the_co_tenant", async () => {
  // THE defect, end to end: a 6 GB model sleeps, a 4.3 GB TTS engine moves into the freed
  // memory, and the model is asked for again. Now the wake makes room through the executor.
  const hw = fakeHw(8192);
  const arb = new VramArbiter(() => hw);
  const svc = serviceFor(tmp(), { arbiter: arb, hardwareFn: () => hw, routerModels: sleepingRouterModels("test-model") });
  svc._router = fakeRouter();
  svc._resident.set("test-model", { status: "running", modelId: "test-model", url: "", detail: "", error: "" });
  arb.reserve("test-model", 6000, { kind: "llm", evictFn: () => {} });
  const killed = [];
  arb.reserve("tts:chatterbox", 4400, { kind: "tts", evictFn: () => killed.push("tts:chatterbox") });

  await svc.ensureModelReady("test-model");

  expect(killed).toEqual(["tts:chatterbox"]); // the wake must evict its co-tenant, not overcommit
  expect(arb.isAsleep("test-model")).toBe(false); // the woken model books its memory back at once
  expect(arb.committedMb()).toBe(6000);
  // …and the user is told why their speech engine went away.
  const events = arb.eventsSince(0);
  expect(events.map((e) => e.victim_key)).toEqual(["tts:chatterbox"]);
  expect(events[0].reason).toContain("waking test-model");
});

test("ensure_model_ready_still_fast_returns_for_an_awake_model", async () => {
  // The wake path must not turn every local AI call into an eviction pass.
  const hw = fakeHw(8192);
  const arb = new VramArbiter(() => hw);
  const svc = serviceFor(tmp(), { arbiter: arb, hardwareFn: () => hw, routerModels: sleepingRouterModels() }); // nothing asleep
  svc._router = fakeRouter();
  svc._resident.set("test-model", { status: "running", modelId: "test-model", url: "", detail: "", error: "" });
  arb.reserve("test-model", 6000, { kind: "llm", evictFn: () => {} });
  const killed = [];
  arb.reserve("tts:chatterbox", 4400, { kind: "tts", evictFn: () => killed.push("tts:chatterbox") });
  await svc.ensureModelReady("test-model");
  expect(killed).toEqual([]);
  expect(arb.eventsSince(0)).toEqual([]);
});

test("resident_reconciles_the_sleeping_set_it_already_fetched", async () => {
  // The resident poll keeps the flags fresh for a co-tenant that never calls the runner — and
  // its own committed/remaining numbers must reflect the sleeping set in the SAME response.
  const hw = fakeHw(8192);
  const arb = new VramArbiter(() => hw);
  const svc = serviceFor(tmp(), { arbiter: arb, hardwareFn: () => hw, routerModels: sleepingRouterModels("test-model") });
  svc._router = fakeRouter();
  arb.reserve("test-model", 6000, { kind: "llm", evictFn: () => {} });
  const out = await svc.resident(hw);
  expect(arb.isAsleep("test-model")).toBe(true);
  expect(out.committed_mb).toBe(0);
  expect(out.remaining_mb).toBe(8192);
  expect(out.router).toBe(true);
});

// ── The update check follows upstream's STABLE channel, and the asset resolver
//    (2026-09-19, plan docs/plans/2026-09-19-engine-update-safety-and-stable-channel.md
//    §3.1–3.4). Upstream started flagging every bNNNN build a prerelease on 2026-08-21. ──

test("update_check_follows_the_stable_channel", async () => {
  const svc = serviceFor(tmp(), { hardwareFn: winCudaHw });
  svc._acquiredExe = binary.acquiredServerExe;
  seedEngineOnDisk(svc, "b10437");
  svc._testedBuild = "b10437"; // the stable channel alone decides here
  svc._latestBuildFn = () => ["b10964", "v0.4.1"];

  const out = await svc.updateCheck();

  expect(out.current).toBe("b10437");
  expect(out.latest).toBe("b10964");
  expect(out.latestKind).toBe("stable");
  expect(out.latestStable).toBe("v0.4.1");
  expect(out.updateAvailable === true && out.error === "").toBe(true);
});

// ── The update check also offers the build the kit is TESTED with (2026-09-28). ──

test("update_check_offers_the_tested_build_when_stable_lags_it", async () => {
  // The user's box on 2026-09-28: b10750 installed, stable v0.5.0 = b11146, pin b11239.
  const svc = serviceFor(tmp(), { hardwareFn: winCudaHw });
  svc._acquiredExe = binary.acquiredServerExe;
  seedEngineOnDisk(svc, "b10750");
  svc._testedBuild = "b11239";
  svc._latestBuildFn = () => ["b11146", "v0.5.0"];

  const out = await svc.updateCheck();

  expect(out.current).toBe("b10750");
  expect(out.latest === "b11239" && out.latestKind === "tested").toBe(true);
  expect(out.latestStable).toBe("v0.5.0"); // still reported, for the record
  expect(out.updateAvailable === true && out.error === "").toBe(true);
});

test("update_check_offers_stable_when_it_is_newer_than_the_tested_build", async () => {
  const svc = serviceFor(tmp(), { hardwareFn: winCudaHw });
  svc._acquiredExe = binary.acquiredServerExe;
  seedEngineOnDisk(svc, "b10750");
  svc._testedBuild = "b11239";
  svc._latestBuildFn = () => ["b11400", "v0.6.0"];

  const out = await svc.updateCheck();

  expect(out.latest === "b11400" && out.latestKind === "stable").toBe(true);
  expect(out.updateAvailable).toBe(true);
});

test("update_check_offers_the_tested_build_when_the_stable_fetch_fails", async () => {
  // The tested build is known locally, so a failed fetch does not hide it; the failure is still
  // reported. And it never offers a DOWNGRADE (QC-25).
  const svc = serviceFor(tmp(), { hardwareFn: winCudaHw });
  svc._acquiredExe = binary.acquiredServerExe;
  seedEngineOnDisk(svc, "b10750");
  svc._testedBuild = "b11239";
  svc._latestBuildFn = () => {
    throw new RuntimeError("offline");
  };
  let out = await svc.updateCheck();
  expect(out.latest === "b11239" && out.latestKind === "tested").toBe(true);
  expect(out.updateAvailable).toBe(true);
  expect(out.error).toContain("offline");

  svc._testedBuild = "b10700"; // older than the installed build
  out = await svc.updateCheck();
  expect(out.updateAvailable).toBe(false);
});

test("update_check_never_offers_a_non_build_tag", async () => {
  // THE BUG (silent since ~2026-08-21): `releases/latest` answers "v0.4.1", the old digit-strip
  // read it as 41, so the check said "current"; "v1.10.500" → 110500 would have offered an
  // update to a tag with no binaries at all.
  const svc = serviceFor(tmp());
  for (const tag of ["v0.4.1", "v1.10.500", "", "latest"]) {
    svc._latestBuildFn = () => tag;
    const out = await svc.updateCheck();
    expect(out.updateAvailable, tag).toBe(false);
    expect(out.error, tag).toBe(""); // not an error either — just "no build named"
  }
});

/** An `http.fetch` double: exact-URL → a response with .json()/.text(). */
function fakeGet(pages) {
  return async (url) => {
    if (!(url in pages)) throw new Error(`unexpected fetch: ${url}`);
    const payload = pages[url];
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => (typeof payload === "string" ? payload : ""),
    };
  };
}

test("fetch_latest_release_reads_nightly_tag", async () => {
  vi.spyOn(http, "fetch").mockImplementation(
    fakeGet({
      [`${lifecycle._GH_RELEASES}/latest`]: {
        tag_name: "v0.4.1",
        body: "",
        assets: [{ name: "nightly-tag.txt", browser_download_url: "https://x/nt" }],
      },
      "https://x/nt": "b10964\n",
    }),
  );
  expect(await lifecycle._fetchLatestLlamacppRelease()).toEqual(["b10964", "v0.4.1"]);
  expect(await lifecycle._fetchLatestLlamacppTag()).toBe("b10964"); // the back-compat face
});

test("fetch_latest_release_falls_back_to_the_notes_link", async () => {
  vi.spyOn(http, "fetch").mockImplementation(
    fakeGet({
      [`${lifecycle._GH_RELEASES}/latest`]: {
        tag_name: "v0.4.1",
        assets: [],
        body: "**Nightly build:** [b10964](https://github.com/ggml-org/llama.cpp/releases/tag/b10964)",
      },
    }),
  );
  expect(await lifecycle._fetchLatestLlamacppRelease()).toEqual(["b10964", "v0.4.1"]);
});

test("fetch_latest_release_accepts_the_old_scheme", async () => {
  // Pre-2026-08-21 (and if upstream ever reverts): the tag IS the build, one request.
  vi.spyOn(http, "fetch").mockImplementation(
    fakeGet({ [`${lifecycle._GH_RELEASES}/latest`]: { tag_name: "b10549", assets: [], body: "" } }),
  );
  expect(await lifecycle._fetchLatestLlamacppRelease()).toEqual(["b10549", ""]);
});

test("fetch_latest_release_raises_when_no_build_is_named", async () => {
  vi.spyOn(http, "fetch").mockImplementation(
    fakeGet({ [`${lifecycle._GH_RELEASES}/latest`]: { tag_name: "v9.9.9", assets: [], body: "nothing here" } }),
  );
  const err = await lifecycle._fetchLatestLlamacppRelease().catch((e) => e);
  expect(err).toBeInstanceOf(ValueError);
  expect(err.message).toMatch(/names no build/);
});

function assetNames(build) {
  const raw = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/llamacpp_release_assets.json", import.meta.url)), "utf8"));
  return raw[build].map((n) => ({ name: n, url: "" }));
}

test("resolve_build_assets_marks_this_machines_row", async () => {
  const svc = serviceFor(tmp(), { hardwareFn: winCudaHw });
  svc._releaseAssetsFn = (b) => assetNames(b);

  const out = await svc.resolveBuildAssets("b10964");

  expect(out.error === "" && out.build === "b10964").toBe(true);
  expect(out.selected).toEqual({ platform: "windows", gpu: "cuda12", resolved: true, reason: "" });
  const rocm = out.binaries.find((r) => r.platform === "windows" && r.gpu === "rocm");
  expect(rocm.assetUrl.endsWith("llama-b10964-bin-win-rocm-10.0-x64.zip")).toBe(true);
});

test("resolve_build_assets_reports_a_row_this_build_lacks", async () => {
  // b10437 published NO Linux ROCm asset. A Linux+AMD box must learn that BEFORE the pin is
  // written — that is what `selected.resolved === false` is for.
  const linuxAmd = () => hwOf({ os: "linux", platform: "linux", cpuCores: 8, ramMb: 32000, gpus: [], runtimes: { rocm: true } });
  const svc = serviceFor(tmp(), { hardwareFn: linuxAmd });
  svc._releaseAssetsFn = (b) => assetNames(b);

  const out = await svc.resolveBuildAssets("b10437");

  expect(out.selected.gpu === "rocm" && out.selected.resolved === false).toBe(true);
  expect(out.selected.reason).toContain("b10437");
});

test("resolve_build_assets_reports_a_fetch_error", async () => {
  const svc = serviceFor(tmp(), { hardwareFn: winCudaHw });
  svc._releaseAssetsFn = () => {
    throw new RuntimeError("offline");
  };
  const out = await svc.resolveBuildAssets("b10964");
  expect(out.error === "offline" && out.binaries.length === 0 && out.selected === null).toBe(true);
});

test("resolve_build_assets_rejects_a_non_build_tag", async () => {
  const svc = serviceFor(tmp(), { hardwareFn: winCudaHw });
  svc._releaseAssetsFn = () => {
    throw new Error("must not fetch for a non-build tag");
  };
  const out = await svc.resolveBuildAssets("v0.4.1");
  expect(out.error).toContain("not a build tag");
  expect(out.binaries).toEqual([]);
});

// ── JS-only (no Python twin) ─────────────────────────────────────────────────

test("js_admission_evicts_an_earlier_load_through_its_own_evictor", async () => {
  // JS-only: the router lock's RE-ENTRY. A runner reservation registers `_evictFromArbiter`,
  // which takes the router lock; when the NEXT load's admission (already holding that lock)
  // needs the room, `makeRoom` runs that evictor on the same flow. Python's RLock re-entered by
  // thread; the JS ReentrantMutex re-enters by async context — a plain Mutex deadlocks here
  // (measured: the load never finishes).
  const unloaded = [];
  const arb = new VramArbiter(() => fakeHw(1000));
  const svc = serviceFor(tmp(), {
    catalog: [TEST_MODEL, MODEL_B],
    arbiter: arb,
    hardwareFn: () => fakeHw(1000),
    routerUnload: (_u, mid) => unloaded.push(mid),
  });
  vi.spyOn(processMod, "computeFit").mockReturnValue(
    new FitPlan({ nGpuLayers: 10, nCpuMoe: 0, ctxLen: 4096, blockCount: 24, isMoe: false, vramMb: 800 }),
  );
  await svc.load(TEST_MODEL.id);
  await join5(svc);
  expect(arb.reservationOf(TEST_MODEL.id)).not.toBeNull();
  await svc.load(MODEL_B.id); // 800 + 800 > 1000 → makeRoom evicts TEST through its evictor
  await join5(svc);
  expect(svc._thread.isAlive()).toBe(false);
  expect(unloaded).toEqual([TEST_MODEL.id]);
  expect(svc.status().status).toBe("running");
  expect(svc._routerLock.locked).toBe(false);
});
