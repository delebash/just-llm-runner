// SPDX-License-Identifier: MIT
// The fixtures test_lifecycle.py shares with test_load_failure_message.py, as JS fakes: a
// RunnerService with the router + download IO injected, a fake HF cache on disk, the test
// catalog rows, and the MTP draft-crash fixtures.
//
// HERMETIC by default (`useHermeticRunner()` — call it at the top of a test file). Python's
// suite ran three things for real on whatever box it was on, and the JS doesn't:
//   * `hardware.detect()` — boot's `ensureDetected()` runs ONCE (the real box, as Python
//     re-ran it per call); afterwards every `detect()` returns that memo, so an arbiter
//     snapshot doesn't start nvidia-smi again;
//   * `hardware.usedPoolMb` (the admission's measured occupancy) → null = unmeasurable, the
//     pre-2026-08-14 ledger behaviour. Python read the live card here, so its admission tests
//     passed or failed with whatever else held GPU memory at that moment (the user's own
//     llama-server). The tests that pin measured admission set their own value, as Python's
//     `_probe` did;
//   * `lifecycle._otherGpuHolders` → null (unmeasurable) unless a test sets it, as Python's
//     MTP tests did;
//   * the router port: `findPort` returns the preferred port — Python's `_service_for` bound
//     127.0.0.1:8080 for real on every spawn.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, onTestFinished, vi } from "vitest";
import { addSink } from "../src/platform/log.js";
import { model } from "../src/platform/models.js";
import { ValueError } from "../src/platform/py.js";
import { VramArbiter } from "../src/runner/arbiter.js";
import * as hardware from "../src/runner/hardware.js";
import * as lifecycle from "../src/runner/lifecycle.js";
import { RunnerService } from "../src/runner/lifecycle.js";
import { FitPlan, ModelIniEntry, Overrides } from "../src/runner/process.js";
import { HardwareInfo, ModelEntry } from "../src/runner/schema.js";

/** Install the hermetic hardware hooks (see the header) for the calling test file. */
export function useHermeticRunner() {
  beforeAll(async () => {
    await hardware.ensureDetected();
  });
  beforeEach(() => {
    const box = hardware.detected();
    vi.spyOn(hardware, "detect").mockImplementation(async () => box);
    vi.spyOn(hardware, "usedPoolMb").mockResolvedValue(null);
    vi.spyOn(lifecycle, "_otherGpuHolders").mockResolvedValue(null);
  });
}

/** A fresh temp folder (pytest's tmp_path). */
export function tmp() {
  return mkdtempSync(join(tmpdir(), "lifecycle-"));
}

/**
 * A HardwareInfo with one GPU of `vramMb` — for a deterministic arbiter VRAM budget. Declares
 * the cuda runtime so memArch reads DISCRETE even for the tiny test cards (Phase 4: a sub-4-GB
 * GPU with no runtime honestly classifies as integrated, and an integrated box budgets against
 * the 32 GB pool — which would make these small-VRAM eviction scenarios never need to evict).
 */
export function fakeHw(vramMb) {
  return model(HardwareInfo, {
    os: "Linux",
    platform: "linux",
    cpuCores: 8,
    ramMb: 32000,
    gpus: [{ vendor: "nvidia", name: "Test", vramMb }],
    runtimes: { cuda: true },
  });
}

export function winCudaHw() {
  return model(HardwareInfo, {
    os: "windows",
    platform: "windows",
    cpuCores: 8,
    ramMb: 32000,
    gpus: [{ vendor: "NVIDIA", name: "RTX 2070 SUPER", vramMb: 8192 }],
    runtimes: { cuda: true },
  });
}

export const entry = (fields) => model(ModelEntry, fields);

// Catalog lives in the host DB now (there is no runner manifest); tests feed in their own test
// models via the `catalogFn` injection.
export const TEST_MODEL = entry({ id: "test-model", name: "Test", tier: "mid", hfRepo: "org/test-GGUF", quant: "Q4_K_M" });
export const MODEL_B = entry({ id: "model-b", name: "B", tier: "mid", hfRepo: "org/b-GGUF", quant: "Q4_K_M" });

export const EMBED = entry({
  id: "nomic-embed-text",
  name: "Nomic Embed",
  tier: "cpu",
  hfRepo: "org/embed-GGUF",
  quant: "Q4_K_M",
  pooling: "mean",
});

export const DRAFT_MODEL = entry({
  id: "draft-model",
  name: "Draft",
  tier: "mid",
  hfRepo: "org/draft-GGUF",
  quant: "Q4_K_M",
  mtp: true,
  mtpDraftRepo: "",
  mtpDraftFile: "MTP/d-Q4_0-MTP.gguf",
  mtpDraftQuant: "Q4_0",
});

export const EMBED_CPU = entry({
  id: "embed-small",
  name: "Small Embed",
  tier: "cpu",
  hfRepo: "org/embed-small-GGUF",
  quant: "Q8_0",
  pooling: "last",
  embedding: true,
  recommendedFor: { minVramMb: 1500 },
});
export const EMBED_MID = entry({
  id: "embed-4b",
  name: "Mid Embed",
  tier: "mid",
  hfRepo: "org/embed-4b-GGUF",
  quant: "Q4_K_M",
  pooling: "last",
  embedding: true,
  recommendedFor: { minVramMb: 4500 },
});
// min = the bare floor-to-run; est = what it WANTS resident (the real flagship's shape). The
// leftover subtracts EST when known (2026-07-25): the floor made mid cards too generous to the
// embed.
export const CHAT_26B = entry({
  id: "chat-26b",
  name: "Chat",
  tier: "low-vram-moe",
  hfRepo: "org/chat-GGUF",
  quant: "Q4_K_XL",
  recommendedFor: { minVramMb: 6000, estVramMb: 17713 },
});

export const GEMMA_MTP = entry({
  id: "gemma-4-26b-a4b-qat",
  name: "Gemma",
  tier: "low-vram-moe",
  hfRepo: "org/gemma-GGUF",
  quant: "Q4_K_XL",
  recommendedFor: { minVramMb: 6000 },
});

export function fakeRouter(url = "http://127.0.0.1:8080", alive = true) {
  return { url, isAlive: () => alive, stop: () => {} };
}

/** A readMeta stand-in for a corrupt/zeroed GGUF — the exact error gguf.js throws. */
export function raiseBadMagic(_path) {
  throw new ValueError("not a GGUF stream (bad magic)");
}

/** The fake GGUF header every load reads (Python's SimpleNamespace). */
export const fakeMeta = () => ({ blockCount: 24, embeddingLength: 2048, isMoe: false, nKvHeads: 8 });

/**
 * Injected `sleep` for an ensureModelReady poll that waits on the BACKGROUND load task.
 * Python's `time.sleep(0)` yielded the GIL; here a macrotask turn lets the load (and any real
 * I/O it awaits) progress — a no-op sleep would spin on microtasks.
 */
export const yieldPoll = () => new Promise((r) => setImmediate(r));

/**
 * A RunnerService with the router + download IO injected. Every catalog model is seeded into a
 * fake HF cache (`<root>/hf/models--<repo>/snapshots/sha/<file>.gguf`) so both
 * `cachedGgufPath` (the .ini emitter) and the injected `acquireModel` resolve the SAME on-disk
 * path — faithful to production.
 *
 * The default injected `routerModels` reports EVERY catalog model as `loaded`, so a load's
 * confirmation poll resolves on the first GET /models. A test that needs a `loading` /
 * `failed` / timeout path injects its own `routerModels` (+ `now`/`sleep` to drive the clock).
 *
 * `usedVramFn` defaults to `() => null` (unmeasurable) so the post-load VRAM true-up keeps the
 * fit estimate — deterministic reservations regardless of the box the suite runs on.
 */
export function serviceFor(
  tmpPath,
  {
    catalog = null,
    startRouter = null,
    routerLoad = null,
    routerUnload = null,
    routerModels = null,
    now = null,
    sleep = null,
    identifyFn = null,
    switchesFn = null,
    profileSwitchesFn = null,
    embeddingIdsFn = null,
    defaultLlmIdFn = null,
    arbiter = null,
    acquiredExes = null,
    usedVramFn = null,
    hardwareFn = null,
    seedCache = true,
    knobBackendsFn = null,
  } = {},
) {
  const models = [...(catalog || [TEST_MODEL])];
  const snaps = new Map();
  const quantFor = new Map();
  for (const m of models) {
    const d = join(tmpPath, "hf", `models--${m.hfRepo.replaceAll("/", "--")}`, "snapshots", "sha");
    mkdirSync(d, { recursive: true });
    // seedCache true (default): the weights are already on disk — the cached-model case, which
    // the LOAD fast path (skipIfCached) takes. false: NOT downloaded yet; the fake acquire below
    // WRITES the file when called, so a download-during-load test actually exercises it.
    if (seedCache) writeFileSync(join(d, `model-${m.quant}.gguf`), Buffer.alloc(1024, "x"));
    snaps.set(m.hfRepo, d);
    quantFor.set(m.hfRepo, m.quant);
  }

  const fakeAcquireModel = (repo) => {
    // Return the snapshot dir and — for the not-pre-seeded case — ensure the MAIN gguf exists,
    // so _mainGguf resolves after a simulated download. Keyed on the repo's REGISTERED quant,
    // never the passed 2nd arg (the MTP draft leg passes the draft file PATH there).
    const d = snaps.get(repo);
    const q = quantFor.get(repo);
    if (q) {
      const f = join(d, `model-${q}.gguf`);
      if (!existsSync(f)) writeFileSync(f, Buffer.alloc(1024, "x"));
    }
    return d;
  };

  // The default router view is REACTIVE to unload (T2, 2026-07-17): stop()'s confirm-unload
  // polls GET /models until the model stops reading loaded — a static always-loaded default
  // would park every stop() in that poll's 5 s timeout. Like the real router: unloaded ids
  // report "unloaded", everything else "loaded".
  const unloadedIds = new Set();
  const defaultUnload = (_url, mid) => {
    unloadedIds.add(mid);
  };
  const allLoaded = () => ({
    object: "list",
    data: models.map((m) => ({ id: m.id, status: { value: unloadedIds.has(m.id) ? "unloaded" : "loaded" } })),
  });

  const kw = {};
  const opt = { hardwareFn, acquiredExes, identifyFn, switchesFn, profileSwitchesFn, embeddingIdsFn, defaultLlmIdFn, now, sleep, knobBackendsFn };
  for (const [k, v] of Object.entries(opt)) if (v != null) kw[k] = v;
  return new RunnerService(tmpPath, {
    catalogFn: () => models,
    acquireBinary: () => join(tmpPath, "llama-server"),
    acquiredExe: () => join(tmpPath, "llama-server"),
    acquireModel: fakeAcquireModel,
    readMeta: fakeMeta,
    startRouter: startRouter || (() => fakeRouter()),
    findPort: (_h, p) => p,
    // A re-load of a previously-unloaded id flips it back to loaded (as the router does).
    routerLoad: routerLoad || ((_url, mid) => unloadedIds.delete(mid)),
    routerUnload: routerUnload || defaultUnload,
    routerModels: routerModels || allLoaded,
    usedVramFn: usedVramFn || (() => null),
    // A FRESH arbiter per service isolates each test's ledger (the default is the shared
    // process singleton, which would leak reservations between tests).
    arbiter: arbiter != null ? arbiter : new VramArbiter(),
    ...kw,
  });
}

/** The generated models.ini, read as Python's read_text did (universal newlines). */
export function ini(svc) {
  return readFileSync(join(svc._cacheRoot, "llamacpp", "models.ini"), "utf8").replace(/\r\n?/g, "\n");
}

/** The `[modelId]` section's text (up to the next section header). */
export function section(text, modelId) {
  if (!text.includes(`[${modelId}]`)) throw new Error(`no [${modelId}] in:\n${text}`);
  return text.split(`[${modelId}]`)[1].split("\n[")[0];
}

/** The router's `GET /models` body for `[id, status]` pairs. */
export function routerView(...pairs) {
  return { object: "list", data: pairs.map(([id, value]) => ({ id, status: { value } })) };
}

/** Collect the lifecycle logger's records for the rest of the CURRENT test (pytest's caplog
 * for one logger). */
export function captureLogs(name = "llm_runner.runner.lifecycle") {
  const records = [];
  const remove = addSink((r) => {
    if (r.name === name) records.push(r);
  });
  onTestFinished(remove);
  return records;
}

// ── 2026-07-12: MTP draft co-load crash recovers WITHOUT dropping MTP (Fix B) ──

export function mtpEntry() {
  const ov = new Overrides({ specType: "draft-mtp", specNMax: 2, modelDraft: "/x/mtp-draft.gguf" });
  return new ModelIniEntry({
    modelId: GEMMA_MTP.id,
    ggufPath: "/x/gemma.gguf",
    nGpuLayers: 30,
    nCpuMoe: 21,
    ctxLen: 32768,
    overrides: ov,
  });
}

export function mtpFit() {
  return new FitPlan({
    nGpuLayers: 30,
    nCpuMoe: 21,
    ctxLen: 32768,
    blockCount: 48,
    isMoe: true,
    vramMb: 6000,
    nglExplicit: true,
    ncmoeExplicit: true,
    ctxExplicit: true,
  });
}

export const DRAFT_CRASH_TEXT =
  "E llama_model_load: error loading model: invalid vector subscript\n" +
  "E srv load_model: failed to load draft model, '/x/mtp-draft.gguf'\n";

/**
 * routerLoad fake: the child crashes on its draft DURING the attempt, so the crash text lands
 * AFTER this POST's watermark (the tail read is per-attempt since 2026-07-21). `holder.svc` is
 * filled after construction; appends to the CURRENT log path so a stage-2 restart's rotated
 * log still receives the signature.
 */
export function draftCrashLoader(holder) {
  return (_url, _mid) => {
    const p = holder.svc._lastLogPath;
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, DRAFT_CRASH_TEXT, { flag: "a" });
  };
}
