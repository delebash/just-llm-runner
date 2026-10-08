// SPDX-License-Identifier: MIT
// Load/run lifecycle for the built-in runner — the "choose → load on demand → use" half of the
// shared model (the port of llm_runner/runner/lifecycle.py; see the JustWrite server-side-LLM
// decision doc).
//
// A singleton `RunnerService` acquires the llama.cpp binary + the GGUF weights and spawns
// llama-server, exposing a pollable status so the GUI can show progress. The heavy work runs
// as a background task. `acquireBinary` / `acquireModel` / `startRouter` (the parts that
// download + spawn — not runnable in CI) are injectable, so the state machine itself is fully
// testable offline.
//
// ── The JS shape ────────────────────────────────────────────────────────────────────────
// NAMES. Python's keyword arguments become an options object (`load(id, {switches, trigger})`,
// `measure({modelId, maxTokens})`, `installEngine({force, replaceBuild, gpu})`); positional
// ones stay positional. Paths are strings (`pyPath`-normalized roots + `path.join`). The
// host's catalog rows, config and hardware are the camelCase schema objects (`m.hfRepo`,
// `cfg.modelsMax`, `hw.ramMb`). `resident()` keeps Python's snake_case keys (the API layer
// maps them, as FastAPI did); `reservationOf`/`snapshot` come from the arbiter the same way.
// Model-keyed state lives in `Map`s (`_resident`, `_downloadStates`, …): a model id is user
// data, and an integer-like id would reorder in a plain object (Python dicts keep insertion
// order). What goes out on the wire (`downloadStatus`, `opProgress`) is a plain object.
//
// SYNC / ASYNC (callers depend on this exactly). SYNC: `routerUrl`, `_activeBackend`,
// `cacheRoot` / `runtimeRoot`, `config`, `catalog`, `catalogWired`, `cachedPath`, `status`,
// `installedBuild` / `installedExe`, `engineStatus` (disk reads only), `engineLog`,
// `clearSpawnLogs`, `previewFit` (no probe — the claim ladder reads disk + the host stores),
// `modelDownloaded`, `embedPlacement`, `opProgress`, `downloadStatus`, `measurementRows`,
// `classBw`, `hostProbeBwGbps` (kicks its probe in the background), `hostMoeBwGbps`,
// `recordMachineProbe`. ASYNC: everything that spawns, waits, polls, downloads, reads HTTP or
// sleeps — `load`, `download`, `cancelDownload`, `stop`, `ensureModelReady`,
// `ensureEmbedding`, `reconcileSleeping`, `measure`, `tokenize`, `resident`,
// `installEngine`, `cancelInstallEngine`, `uninstallEngine`, `updateCheck`,
// `resolveBuildAssets`, `repointCache`, `clearModelsCache`, `deleteModelCache`,
// `acquireDraftFile`. `load` / `download` / `installEngine` resolve at once with the state
// they seeded (the work runs as a background task, as Python's thread did).
//
// THE HOST SEAMS. `hardwareFn` is SYNCHRONOUS — the default reads `hardware.detected()` (the
// memo boot fills with `await hardware.ensureDetected()`); Python's default re-ran `detect()`
// on every call. `catalogFn`, `switchesFn`, `profileSwitchesFn`, `embeddingIdsFn`,
// `defaultLlmIdFn`, `configFn`, `knobBackendsFn`, `measurementsFn`, `classBwFn`,
// `fitRelevantFlagsFn` and `readMeta` are synchronous (the stores are). Everything that
// spawns, fetches or probes may return a promise (`acquireBinary`, `acquireModel`,
// `startRouter`, `findPort`, `routerLoad`/`Unload`/`Models`, `usedVramFn`, `sleep`,
// `identifyFn`, `recordProbeFn`, `recordLoadFn`, `latestBuildFn`, `releaseAssetsFn`) — each is
// awaited.
//
// CONCURRENCY (each Python lock / thread → what):
//   * `_lock` (threading.Lock over the resident/download maps) — DROPPED: none of its
//     critical sections crosses an `await`, so nothing else runs inside one.
//   * `_router_lock` (RLock serializing spawn / bounce / emit / load) → `ReentrantMutex`:
//     an async lock whose owner is the async CONTEXT (AsyncLocalStorage). The re-entry Python
//     relied on is real here too: `_admit` → `arbiter.makeRoom` → a runner reservation's
//     evictor `_evictFromArbiter` takes the lock again ON THE SAME FLOW; a foreign caller (a
//     JustVoice speech admission) waits for it like any other.
//   * `_download_gate` (Condition with a 0.2 s wait) → `Condition` (a notify-all with the
//     same timeout): a queued download re-checks the LIVE `download_max_concurrent` each wake —
//     a semaphore whose size is read per admission.
//   * `_probe_lock` — DROPPED (no await inside).
//   * threading.Event (cancel tokens, the engine-install cancel) → `AsyncEvent`.
//   * threads (`_thread`, `_engine_thread`, the per-download threads, the RAM probe) →
//     `BackgroundTask`s: a promise with `isAlive()` and `join(timeoutS)` — Python's
//     `thread.join(timeout)` keeps its meaning (and its name, so the tests read the same).

import { AsyncLocalStorage } from "node:async_hooks";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { AsyncEvent, background, Mutex, sleep } from "../platform/asyncutil.js";
import * as http from "../platform/http.js";
import { HttpStatusError } from "../platform/http.js";
import { getLogger } from "../platform/log.js";
import {
  cpSlice,
  errText,
  FileNotFoundError,
  IS_WIN,
  isJsonObject,
  KeyError,
  pyFloatParse,
  pyInt,
  pyRound,
  pySorted,
  pyStr,
  RuntimeError,
  rstrip,
  splitlines,
  strip,
  truthy,
  ValueError,
} from "../platform/py.js";
import { pyFixed } from "../platform/pyjson.js";
import { EVICT_MIN_MB as ARBITER_EVICT_MIN_MB, getArbiter } from "./arbiter.js";
import * as bandwidth from "./bandwidth.js";
import * as binary from "./binary.js";
import { pyPath } from "./cache_registry.js";
import { DEFAULT_DOWNLOAD_MAX_CONCURRENT, DEFAULT_PINNED_BUILD, defaultConfig, MAX_DOWNLOAD_CONCURRENT } from "./config.js";
import { DownloadCancelled, downloadKwargs } from "./download.js";
import * as fitMod from "./fit.js";
import * as gguf from "./gguf.js";
import * as hardware from "./hardware.js";
import * as models from "./models.js";
import { pyRepr } from "./models.js";
import * as processMod from "./process.js";
import {
  _BACKOFF_STEP,
  _looksLikeDraftFailure,
  _looksLikeOom,
  _looksLikeUnfixable,
  DEFAULT_HOST,
  DEFAULT_PORT,
  ModelIniEntry,
  OVERRIDES_FIELDS,
  Overrides,
  RunnerStartError,
} from "./process.js";
import * as self from "./lifecycle.js";

const log = getLogger("llm_runner.runner.lifecycle");

/** Module settings a test replaces (Python's monkeypatch of `_IS_WINDOWS` — the seam for the
 * strip-rule tests). */
export const cfg = { IS_WINDOWS: process.platform === "win32" };

/** The process singleton (Python's module variable `_service`; the install tests reset it). */
export const state = { service: null };

const monotonic = () => performance.now() / 1000;
const sleepS = (s) => sleep(s * 1000);

// Load-confirmation poll (P1f). POST /models/load is ASYNCHRONOUS on b9644 (box-verified
// 2026-07-04): a 2xx only ACCEPTS the request — the child loads in the background — so the
// 200 is NOT a load confirmation. A load is confirmed by polling GET /models until the child
// reports `loaded`. Generous timeout: a large model cold-loads in ~19–21 s (measured on the
// RTX 2070 SUPER), a 70B on a slow disk longer.
export const _LOAD_POLL_TIMEOUT = 300.0; // seconds before a still-`loading` child is declared failed
export const _LOAD_POLL_INTERVAL = 1.0; // seconds between GET /models polls

// Embed placement (#274's missing half; built after the 2026-07-11 co-load incident): an
// embedding child gets the GPU only when the card's STATIC leftover beside the local chat
// default covers its curated floor — otherwise it is forced to CPU with an EXPLICIT
// `n-gpu-layers = 0`. Fit-by-omission would hand placement to the child's GPU-greedy `--fit`,
// which is exactly what co-loaded a full-GPU 32k-ctx embed beside Gemma on an 8 GB card and
// crashed the chat spawn. See `_applyEmbedPlacement`.
export const _EMBED_CTX_CAP = 8192; // an embedding input is a ~1k-token chunk, never a chat context
// An ngl-0 CUDA child still holds a driver context (box-measured 549 MB on the 2070 SUPER,
// 2026-07-06) — the floor a measured reservation can't go below when the fit claimed GPU use.
export const _DRIVER_CTX_MB = 549;
// VRAM-driven evictions skip victims reserving less than this (just above the driver-context
// floor): freeing a CPU-placed embed's ~0–550 MB can't make a GPU model fit, but it kills the
// warm embed child the RAG rail wants resident (observed live 2026-07-11). Count-cap evictions
// ignore this. The value lives in arbiter.js (2026-08-09 seam) so `makeRoom` and `_admit`
// share one threshold.
export const _EVICT_MIN_MB = ARBITER_EVICT_MIN_MB;

// Post-download integrity gate (the corrupt-GGUF fix, 2026-07-11). A freshly-acquired main
// GGUF has its header parsed BEFORE spawn; a corrupt or incomplete download (a file zeroed by
// antivirus mid-write — seen full-size but all-zeros — or a truncated transfer) fails the
// magic check and is surfaced as an ACTIONABLE error instead of llama.cpp's raw "bad magic",
// which otherwise bricks the whole router upstream at spawn. Reading a GGUF header is only a
// few KB, so the check is effectively free — it never scans the multi-GB body.

/**
 * A downloaded GGUF failed its integrity check (bad magic / truncated / too small). Thrown
 * with an actionable, user-facing message; carries `modelId` so a caller can offer a
 * one-click re-download.
 */
export class CorruptModelError extends RuntimeError {
  constructor(message, modelId = "", options) {
    super(message, options);
    this.name = "CorruptModelError";
    this.modelId = modelId;
  }
}

// ─── Small shared helpers (candidates for platform/) ─────────────────────────────────

/**
 * An async lock that the SAME async flow may re-enter — Python's `threading.RLock` for one
 * event loop. Ownership is the async context (AsyncLocalStorage): code awaited from inside
 * `run(fn)` re-enters at once; any other flow queues, in arrival order. Candidate for
 * platform/ (asyncutil).
 */
export class ReentrantMutex {
  #mutex = new Mutex();
  #als = new AsyncLocalStorage();
  get locked() {
    return this.#mutex.locked;
  }
  /** Does the CURRENT async flow hold the lock? (Python's `RLock._is_owned()`.) */
  isOwned() {
    const hold = this.#als.getStore();
    return hold != null && hold.active;
  }
  run(fn) {
    if (this.isOwned()) {
      try {
        return Promise.resolve(fn());
      } catch (e) {
        return Promise.reject(e);
      }
    }
    return this.#mutex.run(async () => {
      // A hold goes INACTIVE when the section ends, so a task that inherited the context
      // (started inside it, still running after it) can never think it still owns the lock.
      const hold = { active: true };
      try {
        return await this.#als.run(hold, fn);
      } finally {
        hold.active = false;
      }
    });
  }
}

/**
 * `threading.Condition.wait(timeout)` / `notify_all()` for one event loop: `wait(ms)`
 * resolves on the next `notifyAll()` or after `ms`, whichever comes first. The waiter then
 * re-checks its own predicate (as Python's loop did). Candidate for platform/ (asyncutil).
 */
export class Condition {
  #waiters = new Set();
  wait(timeoutMs) {
    return new Promise((resolve) => {
      let t = null;
      const w = () => {
        if (t) clearTimeout(t);
        this.#waiters.delete(w);
        resolve();
      };
      this.#waiters.add(w);
      t = setTimeout(w, Math.max(0, timeoutMs));
    });
  }
  notifyAll() {
    for (const w of [...this.#waiters]) w();
  }
}

/**
 * A Python daemon thread as an async task: `fn` starts on the next microtask (the caller's
 * synchronous code finishes first, as `thread.start()` returned at once), its error is logged
 * and swallowed (`background`). `isAlive()` / `join(timeoutS)` keep the thread's meaning.
 * Candidate for platform/ (asyncutil).
 */
export class BackgroundTask {
  constructor(name, fn, logger = log) {
    this.name = name;
    this._done = false;
    this.promise = background(name, fn, logger).finally(() => {
      this._done = true;
    });
  }
  isAlive() {
    return !this._done;
  }
  /** Resolves once the task has finished, or after `timeoutS` seconds (null = no limit). */
  async join(timeoutS = null) {
    if (this._done) return;
    if (timeoutS == null) {
      await this.promise;
      return;
    }
    let t = null;
    await Promise.race([
      this.promise,
      new Promise((r) => {
        t = setTimeout(r, Math.max(0, timeoutS) * 1000);
      }),
    ]);
    if (t) clearTimeout(t);
  }
}

/** A key collection Python tested with `in` (set, list, dict keys) → a Set. (arbiter.js has
 * the same, unexported.) */
function keySet(xs) {
  if (xs == null) return new Set();
  if (xs instanceof Set) return xs;
  if (xs instanceof Map) return new Set(xs.keys());
  if (typeof xs === "string" || Array.isArray(xs) || typeof xs[Symbol.iterator] === "function") return new Set(xs);
  return new Set(Object.keys(xs));
}

/** `repr(x)` for the values the messages quote: None or a str. */
function reprAny(x) {
  return x == null ? "None" : pyRepr(String(x));
}

/** The first key of a Map (Python's `next(iter(d), "")`). */
function firstKey(m) {
  for (const k of m.keys()) return k;
  return "";
}

/** `statistics.median`: the middle value, or the mean of the two middle ones. */
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (!n) throw new ValueError("no median for empty data");
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** pathlib's ordering: component-wise, case-folded on Windows. */
const pathKey = (p) => (IS_WIN ? String(p).toLowerCase() : String(p)).split(path.sep);
const sortedPaths = (ps, reverse = false) => pySorted(ps, pathKey, reverse);
const samePathKey = (a, b) => (IS_WIN ? String(a).toLowerCase() === String(b).toLowerCase() : String(a) === String(b));

/** `[d for d in root.iterdir() if d.is_dir()]` — the directories under `root`, in listing order. */
function childDirs(root) {
  let names;
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  return names.map((n) => path.join(root, n)).filter(isDir);
}

/** `Path(p).rglob(pattern)` for a `*<suffix>` pattern — every entry below `dir` whose name
 * ends with it (case-insensitive on Windows, as pathlib's glob is). Symlinked dirs aren't
 * descended. */
function rglobSuffix(dir, suffix) {
  const out = [];
  const want = IS_WIN ? suffix.toLowerCase() : suffix;
  const walk = (d) => {
    let ents;
    try {
      ents = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      const p = path.join(d, ent.name);
      if ((IS_WIN ? ent.name.toLowerCase() : ent.name).endsWith(want)) out.push(p);
      if (ent.isDirectory()) walk(p);
    }
  };
  walk(String(dir));
  return out;
}

/** shutil.rmtree(p, ignore_errors=True). */
function rmTree(p) {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
    /* ignore_errors */
  }
}

/** shutil.copy2: the bytes + the times. */
function copy2(src, dst) {
  copyFileSync(src, dst);
  const st = statSync(src);
  utimesSync(dst, st.atime, st.mtime);
}

/** `time.strftime("%Y%m%d-%H%M%S")` in local time. */
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Python's `except FileNotFoundError` (an OSError the OS raised for a missing file). */
function isFileNotFound(e) {
  return e instanceof FileNotFoundError || e?.code === "ENOENT";
}

/** Python's `except OSError`: a system error (errno / syscall / an E-code), never a
 * programming error. */
function isOsError(e) {
  return (
    isFileNotFound(e) ||
    typeof e?.errno === "number" ||
    typeof e?.syscall === "string" ||
    (typeof e?.code === "string" && /^E[A-Z0-9]+$/.test(e.code))
  );
}

/** The HardwareInfo boot detected (`await hardware.ensureDetected()`). SYNC: the many sync
 * readers (status, the backend switcher, the claim ladder) can't wait for a probe. */
function memoHardware() {
  const hw = hardware.detected();
  if (!hw) {
    throw new RuntimeError("hardware not detected yet — await hardware.ensureDetected() at boot before the runner reads it");
  }
  return hw;
}

// ─── The host-seam defaults ──────────────────────────────────────────────────────────

/** Standalone default: no host store wired → empty catalog. Hosts override this with a
 * DB-backed function via `new RunnerService(root, {catalogFn})`. */
export function _defaultCatalogFn() {
  return [];
}

/** Standalone default: no host store wired → no per-model switch overrides. */
export function _defaultSwitchesFn(_modelId) {
  return {};
}

/** Standalone default: no host store wired → no catalog type auto-detect. */
export function _defaultIdentifyFn(_modelId, _ggufPath) {
  return null;
}

/**
 * Standalone default: no host store wired → no local embedding model configured. Hosts
 * override via `embeddingIdsFn` (JustWrite wires it from the routing default when the
 * embedding provider points at the bundled runner) so the runner knows which catalog id is the
 * co-resident embed — the `.ini` section that gets `embeddings = true` + a PINNED reservation
 * so it is never the eviction victim (P3).
 */
export function _defaultEmbeddingIdsFn() {
  return new Set();
}

/** Standalone default for the legacy `jobId` override hook (unused by JustWrite, which
 * resolves switches from the model type baseline): no hook wired → fall back to the model's
 * own switches. */
export function _defaultProfileSwitchesFn(_jobId) {
  return {};
}

async function postJson(url, body, timeoutMs) {
  return http.fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs,
  });
}

/**
 * POST a fixed prompt to the running llama-server → [completionTokens, decodeMs, draft].
 * `draft` is {n, accepted} read from the response `timings` when speculative decoding
 * actually ran (llama.cpp `draft_n` / `draft_n_accepted`), else null — the MTP acceptance
 * signal (T3). In router mode the body carries `"model"` so the router dispatches to the
 * right resident child. A real network call — injected in tests. The timing includes the
 * body, as requests' (non-streaming) post did.
 */
export async function _defaultMeasureProbe(url, prompt, maxTokens, { modelId = "" } = {}) {
  const body = { messages: [{ role: "user", content: prompt }], max_tokens: maxTokens, stream: false };
  if (modelId) body.model = modelId;
  const t0 = monotonic();
  const target = `${rstrip(url, "/")}/v1/chat/completions`;
  const resp = await postJson(target, body, 120_000);
  const text = await resp.text();
  const ms = (monotonic() - t0) * 1000;
  if (!resp.ok) throw new HttpStatusError(resp.status, target, text);
  const payload = (text ? JSON.parse(text) : null) || {};
  const usage = payload.usage || {};
  const timings = payload.timings || {};
  // `draft_n` is present ONLY when a draft model / built-in MTP head actually speculated.
  const draft =
    timings && typeof timings === "object" && "draft_n" in timings
      ? { n: pyInt(timings.draft_n || 0), accepted: pyInt(timings.draft_n_accepted || 0) }
      : null;
  return [pyInt(usage.completion_tokens || 0), ms, draft];
}

/** The box's resource context (TOTALS, from hardware detect). Per-process USED VRAM/RAM is a
 * GPU-box refinement — inject a richer sampler there. */
export async function _defaultMeasureSample() {
  const hw = hardware.detected() ?? (await hardware.ensureDetected());
  return { vramTotalMb: hardware.maxVramMb(hw), ramTotalMb: hw.ramMb };
}

/** EXACT token count for `text` via the running llama-server's /tokenize (b1/E2) — the loaded
 * model's own tokenizer. In router mode the body carries `"model"`. A real network call;
 * injected in tests. */
export async function _defaultTokenizeProbe(url, text, { modelId = "" } = {}) {
  const body = { content: text };
  if (modelId) body.model = modelId;
  const target = `${rstrip(url, "/")}/tokenize`;
  const resp = await postJson(target, body, 30_000);
  const raw = await resp.text();
  if (!resp.ok) throw new HttpStatusError(resp.status, target, raw);
  return ((raw ? JSON.parse(raw) : null) || {}).tokens?.length ?? 0;
}

/**
 * POST {url}/models/load {"model": id} — ACCEPT a model into the router (it then routes
 * requests for that id to the child it spawns). ASYNC on b9644: a 2xx returns BEFORE the child
 * is loaded (fire-and-forget), so this signals acceptance only — load success/failure is
 * confirmed separately by polling GET /models (`_confirmLoad`). Throws on a SYNCHRONOUS 4xx
 * (unknown id / at `models-max`), which is a real reject, not an OOM. Injected in tests.
 */
export async function _defaultRouterLoad(url, modelId) {
  const resp = await postJson(`${rstrip(url, "/")}/models/load`, { model: modelId }, 600_000);
  const text = await resp.text();
  if (resp.status >= 400) {
    throw new RuntimeError(`/models/load ${pyRepr(modelId)} failed [${resp.status}]: ${cpSlice(text || "", 0, 800)}`);
  }
}

/**
 * POST {url}/models/unload {"model": id} — free a resident model's VRAM (the arbiter drives
 * this explicitly; auto-sleep is unreliable). Injected in tests. Idempotent (defect E,
 * 2026-07-22): a 404 / "not found|running|loaded" answer means the goal state already holds —
 * the router's truth wins, never an error (the call site swallows exceptions anyway; this
 * keeps the log free of false failures).
 */
export async function _defaultRouterUnload(url, modelId) {
  const resp = await postJson(`${rstrip(url, "/")}/models/unload`, { model: modelId }, 120_000);
  const text = await resp.text();
  if (resp.status >= 400) {
    const body = cpSlice(text || "", 0, 800);
    const low = body.toLowerCase();
    if (resp.status === 404 || low.includes("not found") || low.includes("not running") || low.includes("not loaded")) {
      log.info(`router unload ${modelId}: already gone [${resp.status}] — adopting`);
      return;
    }
    throw new RuntimeError(`/models/unload ${pyRepr(modelId)} failed [${resp.status}]: ${body}`);
  }
}

/**
 * GET {url}/models → the router's resident-set status (OpenAI-list shape:
 * `{"object":"list","data":[{"id":…,"status":{"value":…},"meta":{…}}]}`). Used to CONFIRM an
 * async load and to report the live resident set to `/v1/llm-runner/resident`. Injected in
 * tests.
 */
export async function _defaultRouterModels(url) {
  const target = `${rstrip(url, "/")}/models`;
  const resp = await http.fetch(target, { timeoutMs: 30_000 });
  const text = await resp.text();
  if (!resp.ok) throw new HttpStatusError(resp.status, target, text);
  return (text ? JSON.parse(text) : null) || {};
}

/**
 * Map the router's `GET /models` response to a Map `model_id → {value[, meta]}`. Status is
 * NESTED at `data[].status.value` on b9644 (box-verified 2026-07-04, NOT a flat string); a
 * flat `status` string is tolerated too for a hypothetical other build. `meta` (n_params /
 * size / n_ctx / …) is present only on a LOADED child — the real resident footprint. A
 * malformed / missing entry is skipped, never a crash.
 */
export function _parseRouterModels(payload) {
  const out = new Map();
  const data = (payload || {}).data || [];
  for (const entry of Array.isArray(data) ? data : []) {
    if (entry == null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const mid = entry.id;
    if (!mid) continue;
    const s = entry.status;
    const value = isJsonObject(s) ? s.value : typeof s === "string" ? s : "";
    const row = { value: value || "" };
    const meta = entry.meta;
    if (meta != null && typeof meta === "object" && !Array.isArray(meta) && Object.keys(meta).length) row.meta = meta;
    out.set(mid, row);
  }
  return out;
}

// ─── Switch rows → Overrides ─────────────────────────────────────────────────────────

/** The `Overrides` field names (Python's — the stored switch keys) — used to validate switch
 * keys at apply time (a stored flag_name not in this set is a raw passthrough flag). */
export const _OVERRIDE_FIELDS = new Set(Object.values(OVERRIDES_FIELDS));
// stored (snake) name → the Overrides property (camel).
const FIELD_OF = new Map(Object.entries(OVERRIDES_FIELDS).map(([camel, snake]) => [snake, camel]));

const BOOL_FIELDS = new Set(["no_mmap", "mlock", "no_kv_offload", "cont_batching", "context_shift"]);
const INT_FIELDS = new Set([
  "n_gpu_layers",
  "n_cpu_moe",
  "ctx_len",
  "batch_size",
  "ubatch_size",
  "threads",
  "threads_batch",
  "parallel",
  "cache_reuse",
  "spec_n_max",
  "reasoning_budget",
]);

/**
 * Parse a stored switch text value into the typed `Overrides` field. Bool fields recognize
 * 'true'/'false' (case-insensitive); int fields parse as int; everything else stays string.
 * Returns null if the value is empty (treated as 'not set').
 */
export function _parseSwitch(name, value) {
  if (value == null || value === "") return null;
  if (BOOL_FIELDS.has(name)) return ["true", "1", "yes", "on"].includes(strip(String(value)).toLowerCase());
  if (INT_FIELDS.has(name)) {
    try {
      return pyInt(String(value));
    } catch {
      return null;
    }
  }
  return value;
}

/** `Overrides(**x)` for a plain fields object, or the instance itself. */
function asOverrides(ov) {
  if (ov == null) return null;
  return ov instanceof Overrides ? ov : new Overrides(ov);
}

/**
 * Layer user-supplied Overrides ON TOP of catalog-derived ones. User wins per-field (a user
 * value REPLACES the catalog default; user null leaves the catalog value in place).
 * `extraFlags` are CONCATENATED, not replaced.
 */
export function _mergeOverrides(base, user) {
  user = asOverrides(user);
  if (user == null) return base;
  const merged = new Overrides({ extraFlags: [...(base.extraFlags || []), ...(user.extraFlags || [])] });
  for (const f of Object.keys(OVERRIDES_FIELDS)) {
    if (f === "extraFlags") continue;
    const u = user[f];
    merged[f] = u != null ? u : (base[f] ?? null);
  }
  return merged;
}

/**
 * Build an `Overrides` from the host's `{flag_name: flag_value}` dict (variable-cardinality
 * switch rows).
 *
 * A key that matches an `Overrides` field maps to that typed field. ANY OTHER key is a raw
 * passthrough flag → it lands in `extraFlags` verbatim (the key is the literal llama-server
 * flag token, e.g. `--top-n-sigma`, with the value appended when non-empty). So a NEW
 * llama.cpp flag works with **no code change** — the host just stores a switch row for it (the
 * shared `<KnobGrid>` escape). The literal key `extra_flags` is reserved (not itself a flag)
 * and skipped.
 */
export function _switchesToOverrides(switches) {
  const ov = new Overrides();
  const entries = switches instanceof Map ? [...switches] : Object.entries(switches || {});
  for (const [name, value] of entries) {
    if (name === "extra_flags") continue; // reserved: the passthrough list itself, not a flag name
    if (_OVERRIDE_FIELDS.has(name)) {
      const parsed = _parseSwitch(name, value);
      if (parsed !== null) ov[FIELD_OF.get(name)] = parsed;
      continue;
    }
    // Unknown key → raw passthrough flag (the "add a flag, no code" escape).
    ov.extraFlags.push(name);
    if (value != null && value !== "") ov.extraFlags.push(pyStr(value));
  }
  return ov;
}

/**
 * THE (b) decision (user, 2026-07-22 — pass-1 plan T7 options; no upstream report): on
 * Windows, --mlock combined with --no-mmap can NEVER lock — llama.cpp's no-mmap heap buffer is
 * not VirtualLock-able (998 ERROR_NOACCESS; standalone A/B in the recovery doc §9: mlock alone
 * locks, the pair fails). The seeded base bundle (mlock, every model) and the MoE bundle
 * (no_mmap) compose exactly this pair on every MoE model, shipping an inert flag + warning
 * spam. Strip mlock from the combination HERE — the flag merge is code's domain (house rules)
 * and this is a COMBINATION fact, not per-knob applicability. mlock ALONE stays honored (it
 * works, proven); non-Windows is untouched (Linux + IPC_LOCK plausibly locks the pair).
 */
export function _stripInertMlock(ov) {
  if (cfg.IS_WINDOWS && ov.noMmap && ov.mlock) {
    log.info("mlock is inert beside no-mmap on Windows (upstream VirtualLock 998) — stripping it from this section");
    ov.mlock = null;
  }
  return ov;
}

/**
 * THE one needs-its-draft predicate: does this resolved config call for an EXTERNAL MTP draft
 * that isn't already pinned to a path? True only when the merged overrides select
 * `draft-mtp`, no explicit `modelDraft` was set, and the catalog model actually declares a
 * draft file. Its THREE consumers must agree: `_acquireAndIdentify` (fetch the draft on load
 * AND download), the router `.ini` emitter (point at the cached draft or strip+warn), and
 * `RunnerService.modelDownloaded` (the catalog badge).
 */
export function _wantsDraft(ov, model) {
  return ov != null && ov.specType === "draft-mtp" && !ov.modelDraft && Boolean(model?.mtpDraftFile);
}

export function _idle() {
  return { status: "idle", modelId: "", url: "", detail: "", error: "", downloaded: 0, total: 0 };
}

// ─── The upstream release reads (GitHub) ─────────────────────────────────────────────

export const _GH_RELEASES = "https://api.github.com/repos/ggml-org/llama.cpp/releases";
export const _GH_HEADERS = { "User-Agent": "just-llm-runner" };
// re.fullmatch(r"b\d+") — Python's \d is any Unicode digit.
export const _BUILD_TAG = /^b\p{Nd}+$/u;

async function ghGet(url) {
  const r = await http.fetch(url, { headers: _GH_HEADERS, timeoutMs: 15_000 });
  if (!r.ok) throw new HttpStatusError(r.status, url, await r.text().catch(() => ""));
  return r;
}

/**
 * The asset list of ONE upstream release (`releases/tags/<build>`) — what that build REALLY
 * publishes, because upstream renames these files between builds (plan
 * docs/plans/2026-09-19-engine-update-safety-and-stable-channel.md §3.4). Same reach as the
 * update check: injectable in tests and, in the dev container, blocked by the egress proxy;
 * the user's box calls it directly.
 */
export async function _fetchLlamacppReleaseAssets(build) {
  const r = await ghGet(`https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/${build}`);
  const rel = (await r.json()) || {};
  return (rel.assets || []).map((a) => ({ name: String(a?.name || ""), url: String(a?.browser_download_url || "") }));
}

/**
 * [build tag, stable label] of upstream's latest STABLE release.
 *
 * Since 2026-08-21 llama.cpp publishes semver releases ("v0.4.1") and flags every `bNNNN`
 * build a PRERELEASE, so `releases/latest` answers the semver tag — which carries no
 * binaries. A stable release ships exactly one asset, `nightly-tag.txt`, naming the build
 * whose binaries it points at (v0.4.1 → b10964), and repeats it in the notes. Upstream's own
 * words: vX.Y.Z is "recommended for downstream distribution", b[NUM] is "bleeding edge" — so
 * this follows the stable channel (plan §3.1).
 *
 * Order: a bare bNNNN tag (the pre-2026-08-21 scheme) → nightly-tag.txt → the "Nightly build"
 * link in the notes. None of those → throws, and `updateCheck` reports it as an error rather
 * than inventing a target.
 */
export async function _fetchLatestLlamacppRelease() {
  const r = await ghGet(`${_GH_RELEASES}/latest`);
  const rel = (await r.json()) || {};
  const tag = strip(String(rel.tag_name || ""));
  if (_BUILD_TAG.test(tag)) return [tag, ""];
  for (const a of rel.assets || []) {
    if (a?.name === "nightly-tag.txt" && a.browser_download_url) {
      const t = await ghGet(a.browser_download_url);
      const build = strip(await t.text());
      if (_BUILD_TAG.test(build)) return [build, tag];
    }
  }
  const m = /\/releases\/tag\/(b\p{Nd}+)/u.exec(String(rel.body || ""));
  if (m) return [m[1], tag];
  throw new ValueError(`the latest llama.cpp release (${tag || "untagged"}) names no build`);
}

/** Back-compat face of `_fetchLatestLlamacppRelease` — the build tag alone. */
export async function _fetchLatestLlamacppTag() {
  return (await self._fetchLatestLlamacppRelease())[0];
}

// Defect D (2026-07-22 pass-1 plan T4, flagged default 1 — user-blessed): how long an
// EXPLICIT stop outranks a zombie request's auto-reload. `ensureModelReady` (the dispatch's
// ensure — trigger=ensure-ready) refuses to re-load a model stopped within this window; a
// direct user load() clears it (user intent wins). Protocol semantics (like retry counts),
// deliberately NOT a DB row.
export const _STOP_TOMBSTONE_S = 30.0;

export function _engineIdle() {
  // Separate channel from the model-load state (a model load must not clobber engine-install
  // progress, and vice-versa). status ∈ idle|installing|installed|error.
  return { status: "idle", detail: "", error: "", downloaded: 0, total: 0 };
}

function engineInstalled() {
  return { status: "installed", detail: "", error: "", downloaded: 0, total: 0 };
}

// How long uninstall waits for an in-flight install task to unwind after signalling cancel.
// The install's download polls its cancelCheck every ~0.3 s and throws promptly, so this is
// generous; a slower-than-this unwind returns a "still cancelling" message rather than
// hanging the request.
export const ENGINE_INSTALL_JOIN_TIMEOUT = 20.0;

/**
 * Remove a directory tree; resolves true iff it is gone afterwards. Windows can hold a
 * just-released exe/DLL open for a moment after the process that used it exits, so a first
 * delete can fail; retry a few times with a short pause. Best-effort — it never throws; the
 * caller checks the result and reports an honest error on a stuck dir. (Python also ran
 * `gc.collect()` between tries to release lingering handles; Node holds none here.)
 */
export async function _rmtreeWithRetry(p, { attempts = 5, delay = 0.2 } = {}) {
  for (let i = 0; i < attempts; i++) {
    rmTree(p);
    if (!existsSync(p)) return true;
    await sleepS(delay);
  }
  return !existsSync(p);
}

/** Seam for `hardware.otherGpuHolders` (tests replace it: the real probe reads the machine's
 * GPU). */
export async function _otherGpuHolders() {
  return hardware.otherGpuHolders();
}

export function _fmtMb(mb) {
  return mb >= 1024 ? `${pyFixed(mb / 1024, 1)} GB` : `${mb} MB`;
}

const MEASURE = Symbol("measure");

/**
 * One sentence naming the OTHER processes holding GPU memory, or "" when there are none (or
 * it can't be measured). For a failed load: a model that fit yesterday and not today usually
 * lost its room to something else, and the error should say what (2026-09-29 — 1.6 GB held
 * by speech engines left over from earlier sessions; the old message sent the user to the
 * tune). `rows` is a measurement the caller already made (one whole-machine query is ~1 s on
 * Windows); left out, it measures.
 */
export async function _gpuHoldersNote(rows = MEASURE) {
  if (rows === MEASURE) {
    try {
      rows = await self._otherGpuHolders();
    } catch {
      return ""; // the message must never fail to build
    }
  }
  if (!truthy(rows)) return "";
  const shown = rows
    .slice(0, 4)
    .map((r) => `${r.label} (pid ${r.pid}, ${_fmtMb(r.memMb)})`)
    .join(", ");
  const more = rows.length > 4 ? ` and ${rows.length - 4} more` : "";
  const total = _fmtMb(rows.reduce((a, r) => a + r.memMb, 0));
  return `Other programs are holding ${total} of GPU memory: ${shown}${more}. Close them, then load the model again. `;
}

/**
 * The error for an MTP draft that would not load with nothing else beside it. What it leads
 * with is MEASURED (2026-09-29): other processes holding GPU memory, then llama.cpp's own
 * error line; the causes follow unranked. The old text opened "Most often the tune left too
 * little VRAM — raise n_cpu_moe", and on 2026-09-29 the real cause was 1.6 GB held by speech
 * engines left over from earlier sessions: the tune was fine, the advice was wrong, and the
 * 400-char tail had cut the engine's own error line off (the record: JustVoice
 * `docs/plans/2026-09-30-lifetime-leftovers.md`). Resolves the error (the caller throws it).
 */
export async function _draftFailedAlone(modelId, outcome, tail, rows = MEASURE) {
  const said = _engineErrorLine(tail);
  return new RuntimeError(
    `model ${pyRepr(modelId)} could not load its speculative-decoding (MTP) draft even on its own (status=${outcome}). ` +
      (await self._gpuHoldersNote(rows)) +
      (said ? `llama.cpp said: "${said}". ` : "") +
      "If nothing else is holding GPU memory: the model's tune may leave too little " +
      "room for the draft (raise n_cpu_moe), the draft file may be damaged " +
      `(re-download it), or you can turn MTP off. Details: ${cpSlice(tail || "", -400)}`,
  );
}

/** llama.cpp's own `error loading model:` line from a load's log, without the
 * log-level/function prefix — "" when there is none. */
export function _engineErrorLine(tail) {
  const lines = splitlines(tail || "");
  for (let k = lines.length - 1; k >= 0; k--) {
    const ln = lines[k];
    const i = ln.toLowerCase().indexOf("error loading model");
    if (i >= 0) return strip(ln.slice(i));
  }
  return "";
}

// ─── The service ─────────────────────────────────────────────────────────────────────

/**
 * Owns the long-lived llama-server ROUTER + the resident-model set.
 *
 * The router (spawned LAZILY on the first `load()`) keeps up to `modelsMax` models
 * co-resident and routes each request by its `model` id; the manager emits the router's
 * `--models-preset` `.ini` from the DB. Per-model status ∈ downloading | starting | running |
 * error (the SAME vocabulary the single-model runner used, so the API's status mapping is
 * unchanged); `status()` exposes a back-compat single-model view.
 *
 * Concurrency: see the module header — `_routerLock` (a ReentrantMutex) serializes the slow
 * router process ops (spawn / bounce / emit / load) so two concurrent loads can't race the
 * shared router; the fast map mutations need no lock on one event loop.
 */
export class RunnerService {
  static _SLEEP_PROBE_TTL_S = 2.0;

  constructor(
    cacheRoot,
    {
      runtimeRoot = null,
      configFn = defaultConfig,
      hardwareFn = memoHardware,
      catalogFn = _defaultCatalogFn,
      switchesFn = _defaultSwitchesFn,
      profileSwitchesFn = _defaultProfileSwitchesFn,
      identifyFn = _defaultIdentifyFn,
      embeddingIdsFn = _defaultEmbeddingIdsFn,
      defaultLlmIdFn = null,
      acquireBinary = (...a) => binary.acquireBinary(...a),
      acquiredExe = (...a) => binary.acquiredServerExe(...a),
      acquiredExes = (...a) => binary.acquiredServerExes(...a),
      acquireModel = (...a) => models.acquireModel(...a),
      readMeta = (p) => gguf.readGgufMetadata(p),
      startRouter = (...a) => processMod.startRouter(...a),
      findPort = (...a) => processMod.findFreePort(...a),
      routerLoad = (...a) => self._defaultRouterLoad(...a),
      routerUnload = (...a) => self._defaultRouterUnload(...a),
      routerModels = (...a) => self._defaultRouterModels(...a),
      usedVramFn = () => hardware.usedDeviceMemMb(),
      now = monotonic,
      sleep: sleepFn = sleepS,
      arbiter = null,
      latestBuildFn = null,
      releaseAssetsFn = null,
      knobBackendsFn = null,
      measurementsFn = null,
      classBwFn = null,
      recordProbeFn = null,
      recordLoadFn = null,
      fitRelevantFlagsFn = null,
      declaredClaimFn = null,
    } = {},
  ) {
    this._cacheRoot = pyPath(cacheRoot);
    // WHAT THIS APP GENERATES, split from what it merely caches. `cacheRoot` holds artifacts
    // that are identical for everyone who fetches them — `hf/` weights and
    // `llamacpp/<build>/` binaries — so it may be SHARED with a sibling family app.
    // `runtimeRoot` holds what this app WRITES from its own DB: the generated `models.ini`
    // and the per-spawn logs. Sharing THAT would have each app overwrite the other's preset
    // file, and a router bounce would then re-read a preset describing somebody else's
    // catalogue. Default = the legacy location inside the cache, so an app with its own cache
    // is byte-identical to before.
    this._runtimeRoot = runtimeRoot ? pyPath(runtimeRoot) : path.join(this._cacheRoot, "llamacpp");
    this._configFn = configFn;
    this._hardwareFn = hardwareFn;
    this._catalogFn = catalogFn;
    this._switchesFn = switchesFn;
    this._profileSwitchesFn = profileSwitchesFn;
    this._identifyFn = identifyFn;
    this._embeddingIdsFn = embeddingIdsFn;
    // The LOCAL chat default's catalog id ("" when the chat default is cloud/Ollama) — the
    // embed placement guarantee's static baseline (#274 half 2).
    this._defaultLlmIdFn = defaultLlmIdFn || (() => "");
    this._acquireBinary = acquireBinary;
    this._acquiredExe = acquiredExe;
    this._acquiredExes = acquiredExes;
    this._acquireModel = acquireModel;
    this._latestBuildFn = latestBuildFn || (() => self._fetchLatestLlamacppRelease());
    // The build this kit is tested with — `updateCheck` offers it too (2026-09-28). The kit
    // constant, NOT the DB pin: an existing DB keeps whatever pin it was seeded with.
    this._testedBuild = DEFAULT_PINNED_BUILD;
    this._releaseAssetsFn = releaseAssetsFn || ((b) => self._fetchLlamacppReleaseAssets(b));
    this._readMeta = readMeta;
    this._startRouter = startRouter;
    this._findPort = findPort;
    this._routerLoad = routerLoad;
    this._routerUnload = routerUnload;
    this._routerModels = routerModels;
    this._usedVramFn = usedVramFn;
    // Pass 2 (2026-07-22): {flag_name → "cuda,rocm,…"} for knobs NOT applicable on every
    // engine family (host-wired from knob_catalog; null = no filtering — standalone/tests
    // unchanged). Consumed by _applyBackendApplicability.
    this._knobBackendsFn = knobBackendsFn;
    // Fit-redesign Phase 3 (§5.5) — the bandwidth ladder's host-wired reads: the
    // measurement history (source 1 derivation + the persisted RAM-probe row + the badge's
    // measured-replaces-predicted), the class-seeded bandwidths (source 3), and the probe
    // recorder. All null standalone — the ladder just resolves less and the badge shows no
    // band.
    this._measurementsFn = measurementsFn;
    this._classBwFn = classBwFn;
    this._recordProbeFn = recordProbeFn;
    // Fit-redesign Phase 5 (§6.2-6.4/§13.1-13.3) — the persistence + claim seams:
    // recordLoadFn persists a confirmed load's footprint (+ the observed overhead machine
    // row) and prunes to keep-K; the fingerprint SET comes from knob_catalog's fit_relevant
    // classification; declaredClaimFn answers a FOREIGN kind's declared claim (JV wires its
    // engine manifests there — the kit handles kind="llm" itself). All null standalone:
    // loads still true up in-memory, claims resolve down to computed/declared exactly as
    // before.
    this._recordLoadFn = recordLoadFn;
    this._fitRelevantFlagsFn = fitRelevantFlagsFn;
    this._declaredClaimFn = declaredClaimFn;
    this._probeStarted = false;
    this._probeValue = null;
    this._now = now;
    this._sleep = sleepFn;
    this._loadPollTimeout = _LOAD_POLL_TIMEOUT;
    this._loadPollInterval = _LOAD_POLL_INTERVAL;
    // The VRAM-budget arbiter (P2): the shared per-app singleton unless a test injects one.
    this._arbiter = arbiter != null ? arbiter : getArbiter();
    // Router + resident set (replaces the single `_runner` + `_state`).
    this._router = null;
    /** modelId → back-compat state object. */
    this._resident = new Map();
    this._lastId = ""; // primary for the back-compat status()
    this._lastIniText = ""; // re-emit / bounce only on a real change
    // Defect D (2026-07-22 pass-1 plan T4): {modelId → this._now() at its last EXPLICIT
    // stop}. ensureModelReady refuses a re-load inside the window; a direct load() pops the
    // stamp (user intent wins).
    this._stopTombstones = new Map();
    // Defect C (2026-07-22 pass-1 plan T3): {modelId → the ModelIniEntry it was ACTUALLY
    // loaded with} — the single truth for HOW a resident model runs. The emitter renders a
    // resident co-model's section from THIS (never re-derived from DB switch rows, which
    // silently reverted ephemeral launch configs on any later emit — the ctx-8192→131072 RAM
    // exhaustion). Recorded at the confirmed load (the FINAL entry, after any
    // fit-retry/OOM-shed rebind); pruned against `_resident` inside the emitter, so every
    // removal path converges without per-site mirror pops.
    this._activeEntries = new Map();
    this._engineState = _engineIdle();
    // Serializes router spawn/bounce/emit/load. Re-entrant (the 2026-08-09 arbiter seam): the
    // reservation's registered evictor (_evictFromArbiter) takes it so a FOREIGN flow (a JV
    // TTS admission running makeRoom) evicts safely — and the runner's own _admit →
    // makeRoom path re-enters it on the same flow.
    this._routerLock = new ReentrantMutex();
    // T2 (2026-07-17 approved plan): one cancel token per IN-FLIGHT load. stop() on a
    // mid-load model SETS the event and returns at once (never touching _routerLock — the old
    // stop blocked behind the load's router ops for the whole VRAM phase); the LOAD TASK
    // honors it at checkpoints and owns all cleanup.
    this._cancelEvents = new Map();
    this._thread = null;
    this._engineThread = null;
    this._engineCancel = new AsyncEvent(); // set → the engine-install worker aborts mid-download
    // CONCURRENT model downloads (2026-07-20): each downloaded model gets its OWN map entry +
    // cancel event + worker task, so clicking Download on several models runs them in
    // parallel (the old single `_download_state` made the 2nd click a silent no-op). ABSENT
    // from `_downloadStates` == idle/done; an "error" entry PERSISTS until a fresh download()
    // replaces it.
    this._downloadStates = new Map(); // modelId → {status, modelId, detail, error, downloaded, total}
    this._downloadCancels = new Map(); // modelId → its cancel token
    this._downloadThreads = new Map(); // modelId → its worker task
    // Admission gate: a queued worker parks here until fewer than `download_max_concurrent`
    // downloads are RUNNING; a completing worker notifies it to wake the next in line.
    this._downloadGate = new Condition();
    this._lastLogPath = null;
    // The sleeping-set probe's TTL stamp (2026-08-15), on the injected clock. null = "never
    // probed", which the first door forces through. (Python used 0.0 — safe only because
    // time.monotonic() is large; performance.now() starts near 0 in a fresh process.)
    this._lastSleepProbe = null;
    // A3: the binary the CURRENT router actually launched with. A fallback spawn may differ
    // from the preferred build; bounces must reuse the PROVEN exe, never re-try the broken
    // preferred one mid-session.
    this._activeServerExe = null;
  }

  /**
   * The runner's cache root (binaries + the `hf/` model cache live under it). Exposed so the
   * catalog endpoint can check on-disk state without reaching into a private field. MAY be
   * shared with a sibling family app — everything under it is content-addressed by (repo,
   * quant, snapshot) or by build number, so two apps fetching the same artifact fetch the
   * same bytes.
   */
  get cacheRoot() {
    return this._cacheRoot;
  }

  /** Where THIS app's generated engine state lives — `models.ini` and the per-spawn `logs/`.
   * Always app-private, even when the cache is shared. */
  get runtimeRoot() {
    return this._runtimeRoot;
  }

  /**
   * Point this service at a different cache root, live. Throws if the engine is busy — the
   * caller then tells the user it applies on the next start.
   *
   * Why not "restart required, always": the choice is offered during Quick Setup, BEFORE the
   * first download, and its whole purpose is to stop a 14 GB model being fetched into the
   * wrong place. A setting that needed a restart would be recorded and then immediately
   * contradicted by the download the same wizard starts. Idle is the normal state at that
   * moment.
   *
   * Nothing on disk moves. The previous cache keeps every byte it had, which is what makes the
   * choice reversible.
   */
  async repointCache(cacheRoot, runtimeRoot = null) {
    await this._routerLock.run(async () => {
      if (this._router != null && this._router.isAlive()) {
        throw new RuntimeError("the engine is running — unload the model first, or restart the app to apply this");
      }
      if (this._thread != null && this._thread.isAlive()) {
        throw new RuntimeError("a download or load is in progress — wait for it to finish, or restart the app to apply this");
      }
      this._cacheRoot = pyPath(cacheRoot);
      this._runtimeRoot = runtimeRoot ? pyPath(runtimeRoot) : path.join(this._cacheRoot, "llamacpp");
      // The emitter writes only when the render differs from what it last wrote; against a
      // NEW root that comparison is meaningless and would leave the new location with no
      // models.ini at all. The proven exe goes for the same reason — its path pointed into
      // the old cache.
      this._lastIniText = "";
      this._activeServerExe = null;
      log.info(`engine cache re-pointed to ${this._cacheRoot} (this app's generated state: ${this._runtimeRoot})`);
    });
  }

  /** Host-backed downloadable model catalog (DB via catalogFn). Empty for standalone runner
   * use (no host store wired) — the manifest's model list is gone (A7). */
  catalog() {
    return this._catalogFn();
  }

  /**
   * Did a host actually supply a catalog source, or is this the standalone default?
   *
   * The two states LOOK identical from `catalog()` — both return `[]` — and that ambiguity is
   * a real trap for a new consumer (2026-08-01 audit): mount the router, call
   * `/v1/llm-runner/models`, get `{"models": []}`, and there is nothing to distinguish "you
   * never called `configureService({catalogFn})`" from "your catalog is genuinely empty".
   * JustVoice has been in the first state for months without noticing, because nothing in its
   * UI reads the endpoint. Exposed so the endpoint can say which one it is.
   */
  get catalogWired() {
    return this._catalogFn !== _defaultCatalogFn;
  }

  /** The runner config (binaries + VRAM margin): DB-backed in the host (via the injected
   * configFn), or the seed defaults standalone. */
  config() {
    return this._configFn();
  }

  /** The FULL measurement history (host-wired wire rows) — the bandwidth ladder's source-1
   * raw material + the badge's measured-replaces-predicted read. [] when unwired or the store
   * hiccups (a badge read must never 500 the catalog). */
  measurementRows() {
    if (this._measurementsFn == null) return [];
    try {
      return [...(this._measurementsFn() || [])];
    } catch (e) {
      log.debug(`measurements read failed: ${errText(e)}`);
      return [];
    }
  }

  /** [vramBwGbps, ramBwGbps] of a class row — ladder source 3. [0, 0] when unwired/absent:
   * the ladder skips, never fabricates. */
  classBw(classKeyStr) {
    if (this._classBwFn == null) return [0.0, 0.0];
    try {
      const res = this._classBwFn(classKeyStr);
      if (res == null || typeof res[Symbol.iterator] !== "function") throw new TypeError("cannot unpack");
      const pair = [...res];
      if (pair.length !== 2) throw new ValueError(`expected 2 values to unpack, got ${pair.length}`);
      return [pyFloatParse(pair[0] || 0.0), pyFloatParse(pair[1] || 0.0)];
    } catch (e) {
      log.debug(`class bandwidth read failed: ${errText(e)}`);
      return [0.0, 0.0];
    }
  }

  /**
   * The RAM copy probe's GB/s for THIS box (§5.5 source 2, host pool). Reads the persisted
   * machine measurement row first (one-time per box); absent → kicks the ~2 s probe ONCE per
   * process as a background task (the catalog poll must never block on it) and returns null
   * until it lands. Clear-history deletes the row → the probe simply re-runs (§8.22
   * self-heal).
   */
  hostProbeBwGbps(machineKeyStr) {
    for (const r of this.measurementRows()) {
      if ((r?.modelId ?? "") === bandwidth.RAM_PROBE_MODEL_ID && (r?.machineKey ?? "") === machineKeyStr) {
        return pyFloatParse(r.tokensPerSec || 0) || null;
      }
    }
    if (this._probeStarted) return this._probeValue;
    this._probeStarted = true;

    const run = async () => {
      const gbps = await bandwidth.probeRamCopyGbps();
      if (!gbps) {
        // A probe that can't measure means every MoE keeps banding off generic class facts —
        // say so rather than leaving the ladder silently one rung lower forever.
        log.warning("RAM bandwidth probe returned nothing — speed bands will fall back to hardware-class figures on this box");
        return;
      }
      this._probeValue = gbps;
      if (this._recordProbeFn == null) {
        log.warning(
          `RAM bandwidth probe measured ${pyFixed(gbps, 1)} GB/s but no recorder is wired — it will re-probe every start and never persist`,
        );
        return;
      }
      try {
        await this._recordProbeFn(gbps, machineKeyStr, bandwidth.RAM_PROBE_MODEL_ID, bandwidth.RAM_PROBE_LABEL);
      } catch (e) {
        // WARNING, not debug (2026-08-14): this failing silently is indistinguishable from
        // "the box was never probed" — the probe re-runs each start, never lands, and every
        // speed band quietly stays on the class-facts rung.
        log.warning(`RAM probe measured ${pyFixed(gbps, 1)} GB/s but recording it FAILED — speed bands stay on hardware-class figures`, e);
      }
    };
    background("llm-runner-ram-probe", run, log);
    return null;
  }

  /**
   * The one-minute speed check's host GB/s for THIS box AND the engine build on disk
   * (speed-truth plan 2026-09-19 §6) — or null. Unlike the RAM probe this NEVER kicks itself
   * off: it is a download plus two engine launches, run only when the user clicks it in Quick
   * setup. A row from another build reads as absent (label build-stamped, the `__overhead__`
   * convention), so an engine upgrade simply re-offers the check.
   */
  hostMoeBwGbps(machineKeyStr) {
    const build = this._installedBuild(this._configFn());
    if (!build) return null;
    const want = bandwidth.moeProbeLabel(build);
    for (const r of this.measurementRows()) {
      // newest first — the latest check wins
      if (
        (r?.modelId ?? "") === bandwidth.MOE_PROBE_MODEL_ID &&
        (r?.machineKey ?? "") === machineKeyStr &&
        (r?.label ?? "") === want
      ) {
        return pyFloatParse(r.tokensPerSec || 0) || null;
      }
    }
    return null;
  }

  /** Persist a machine pseudo-row through the host's recorder (the RAM probe's DI seam,
   * `recordProbeFn`). False when no recorder is wired. */
  recordMachineProbe(gbps, machineKeyStr, modelId, label) {
    if (this._recordProbeFn == null) return false;
    this._recordProbeFn(gbps, machineKeyStr, modelId, label);
    return true;
  }

  /** The engine build on disk, or null — the public face of `_installedBuild` for callers
   * outside the service (the speed check). */
  installedBuild() {
    return this._installedBuild(this._configFn());
  }

  /** The llama-server exe this box would spawn, or null when no engine is installed — what
   * the speed check launches, so it measures the exact binary every real load uses. */
  installedExe() {
    return this._acquiredExe(this.cacheRoot, this._configFn(), this._hardwareFn());
  }

  /**
   * Back-compat SINGLE-model view: the primary (most-recently-loaded) model's state,
   * reconciled against a live router. The full resident-set shape is `resident()`. A router
   * that died while a model was resident surfaces as `error`.
   */
  status() {
    const st = this._resident.get(this._lastId);
    if (st == null) return _idle();
    const router = this._router;
    if (st.status === "running" && (router == null || !router.isAlive())) {
      Object.assign(st, { status: "error", error: "llama-server router exited" });
    }
    return { ...st };
  }

  /**
   * Where the bundled engine is ACTUALLY listening (`http://host:port`, no `/v1`), or "" when
   * no router is up.
   *
   * THE one answer to that question. The port is allocated at spawn (`findFreePort`), so a
   * stored provider `baseUrl` — seeded with the preferred port — is a guess, and acting on a
   * guess is how one app's chat request reached another app's router. `installLlm` points the
   * dispatch seam here so the `local-llamacpp` adapter resolves per request instead of
   * freezing a string at registry-build time.
   */
  routerUrl() {
    const router = this._router;
    return router != null && router.isAlive() ? router.url : "";
  }

  // ── Engine install — its OWN once-per-machine step, separate from loading a model (a load
  //    REQUIRES the engine present; see _runLoad). ──────────────────────────────────────

  /**
   * The build actually ON DISK (the installed exe's dir), or null when nothing is installed.
   * QC-13: status, uninstall and the update check report/act on the disk truth — what is
   * installed is a fact of the disk, while the pin is the user's CHOICE of what an install
   * should fetch.
   */
  _installedBuild(config) {
    const exe = this._acquiredExe(this.cacheRoot, config, this._hardwareFn());
    return exe ? binary.buildOfExe(this.cacheRoot, String(exe)) : null;
  }

  /**
   * The build of the exe a render is FOR — flag spellings depend on it
   * (`process.LOAD_MODE_MIN_BUILD`), and a key the reading engine does not know makes its
   * preset parser throw. `serverExe` = the exe about to be spawned or bounced; absent → the
   * one `_acquiredExe` would pick.
   *
   * NEVER `_activeServerExe` on its own: it is the session's PROVEN binary and is cleared only
   * in the constructor and on a cache re-point — NOT by `stop()`. After an engine update it
   * still names the swept build, so rendering from it would emit the old spelling for the new
   * engine and fail the first load after every update.
   */
  _engineBuildOf(serverExe = null) {
    let exe = serverExe;
    if (exe == null) {
      try {
        exe = this._acquiredExe(this.cacheRoot, this._configFn(), this._hardwareFn());
      } catch {
        exe = null; // a render must never die on a probe
      }
    }
    if (exe == null) return "";
    return binary.buildOfExe(this.cacheRoot, String(exe)) || "";
  }

  /**
   * Is the llama.cpp engine installed for THIS box? Reports the installed build/gpu, whether
   * the exe + (on Windows CUDA) its cudart companion are present, and any in-flight install
   * progress (`_engineState`). Synchronous: it reads the disk only.
   */
  engineStatus() {
    const config = this._configFn();
    const hw = this._hardwareFn();
    const exe = this._acquiredExe(this.cacheRoot, config, hw);
    const asset = binary.selectBinary(config, hw);
    let hasRuntime = true;
    if (exe != null && asset != null && asset.runtimeUrl) {
      // A Windows CUDA build needs the cudart DLLs unpacked next to the exe.
      let names = [];
      try {
        names = readdirSync(path.dirname(String(exe)));
      } catch {
        names = [];
      }
      hasRuntime = names.some((n) => (IS_WIN ? n.toLowerCase() : n).startsWith("cudart"));
    }
    // Backend switcher (2026-07-14): the concrete variants ON DISK, the one the router is
    // actually running (or would select), the user's pinned family, and the families
    // offerable on this box (a detected runtime that also has a real binary) — so the UI can
    // render a truthful backend selector instead of a phantom "available" label.
    let acquired;
    try {
      acquired = this._acquiredExes(this.cacheRoot, config, hw);
    } catch {
      acquired = []; // the probe must never break status
    }
    const installedGpus = acquired.map(([g]) => g);
    let activeGpu = "";
    if (this._activeServerExe) {
      activeGpu = acquired.find(([, e]) => String(e) === String(this._activeServerExe))?.[0] ?? "";
    }
    if (!activeGpu) activeGpu = asset ? asset.gpu : "";
    const runtimes = hw.runtimes || {};
    const famsWithBinary = new Set(
      (config.llamacpp.binaries || [])
        .filter((b) => b.platform === hw.platform && (b.source ?? "github") !== "docker")
        .map((b) => binary.gpuFamily(b.gpu)),
    );
    const offerBackends = ["cuda", "rocm", "vulkan", "metal"].filter((f) => runtimes[f] && famsWithBinary.has(f));
    return {
      installed: exe != null,
      serverExe: exe ? String(exe) : "",
      // QC-13: the build actually ON DISK (the exe's dir), which the pin may not name; the
      // pin is reported only when nothing is installed (then it's the build an install would
      // fetch). Folder and binary agree because the UI keeps every stored download URL in
      // lock-step with the pin.
      build: (exe ? binary.buildOfExe(this.cacheRoot, String(exe)) : null) || config.llamacpp.pinnedBuild,
      gpu: asset ? asset.gpu : "",
      platform: hw.platform,
      hasRuntime,
      // Backend-switcher fields (concrete keys except preferredGpu = family).
      installedGpus,
      activeGpu,
      preferredGpu: config.preferredGpu,
      offerBackends,
      ...this._engineState,
    };
  }

  /**
   * Download + unpack the llama.cpp engine for this box (its OWN step, not folded into a
   * model load). Idempotent unless `force`. Runs as its own task so it can't clobber an
   * in-flight model load. `replaceBuild` (user, 2026-07-07: "the engine update should delete
   * the old folder"): the OLD pinned build this install SUPERSEDES — it gets models.ini carry
   * PRIORITY. After ANY successful install, every stale build dir is swept (stop-first for the
   * Windows exe lock; see _runInstall's cleanup block). `gpu` (a FAMILY, 2026-07-14) targets
   * ONE variant for the backend selector — a lightweight ADD into the pinned build, with no
   * force-wipe and no sweep, so a working backend is never disturbed while the user tries
   * another.
   */
  async installEngine({ force = false, replaceBuild = "", gpu = "" } = {}) {
    if (this._engineState.status === "installing") return { ...this._engineState };
    this._engineCancel.clear(); // arm a fresh run — drop any prior cancel signal
    this._engineState = {
      status: "installing",
      detail: gpu ? `${gpu} engine build` : "llama.cpp engine",
      error: "",
      downloaded: 0,
      total: 0,
    };
    this._engineThread = new BackgroundTask("engine install", () => this._runInstall(force, replaceBuild, gpu));
    return { ...this._engineState };
  }

  /** Signal an in-flight engine install to stop at the next chunk boundary (the installer
   * threads `this._engineCancel.isSet` into acquireBinary's download, which throws
   * DownloadCancelled). Idempotent: a no-op when nothing is installing. Mirrors
   * cancelDownload. */
  async cancelInstallEngine() {
    if (this._engineState.status === "installing") {
      this._engineCancel.set();
      this._engineState.detail = "cancelling…";
    }
    return { ...this._engineState };
  }

  /** Tail of the most recent llama-server spawn log (the 'view log' affordance) — empty when
   * nothing has spawned yet. */
  engineLog(tail = 200) {
    if (tail != null && typeof tail === "object") tail = tail.tail ?? 200;
    const p = this._lastLogPath;
    if (!p || !existsSync(String(p))) return { path: "", text: "" };
    return { path: String(p), text: processMod._tailFile(String(p), tail) };
  }

  /**
   * Remove EVERY installed llama.cpp engine build (each build dir under `llamacpp/`, every
   * per-GPU variant incl. the A3 fallback chain — the whole engine). Models in the HF cache
   * are untouched; `logs/` and the loose `models.ini` are kept.
   *
   * Three fixes over the old one-dir version (all seen on the user's box, 2026-07-21): it
   * sweeps EVERY build (two builds on disk left the UI "Installed" after one was removed);
   * each delete retries the Windows lock-release lag and a dir STILL there comes back as an
   * honest `error` naming it; and an in-flight install is CANCELLED and joined (bounded)
   * rather than refused — during a crawling download "wait for it to finish" is never.
   *
   * Stops any running model first: a live llama-server holds its exe open, and Windows cannot
   * delete an open exe.
   */
  async uninstallEngine() {
    // Cancel + join an in-flight install BEFORE touching the dirs it writes into.
    let installThread = null;
    if (this._engineState.status === "installing") {
      this._engineCancel.set();
      installThread = this._engineThread;
    }
    if (installThread != null && installThread.isAlive()) {
      await installThread.join(ENGINE_INSTALL_JOIN_TIMEOUT);
      if (installThread.isAlive()) {
        return { ...this.engineStatus(), error: "an install is still cancelling — try again in a moment" };
      }
    }
    await this.stop(); // free the exe locks (a live llama-server holds its exe open on Windows)
    const root = path.join(this.cacheRoot, "llamacpp");
    const removed = [];
    const stuck = [];
    if (isDir(root)) {
      for (const d of childDirs(root).filter((d) => path.basename(d) !== "logs")) {
        ((await self._rmtreeWithRetry(d)) ? removed : stuck).push(path.basename(d));
      }
    }
    this._engineState = _engineIdle();
    if (removed.length) log.info(`engine uninstall: removed build(s) ${pySorted(removed).join(", ")}`);
    if (stuck.length) {
      log.warning(`engine uninstall: build(s) still locked after retry: ${pySorted(stuck).join(", ")}`);
      return {
        ...this.engineStatus(),
        error: `could not remove ${pySorted(stuck).join(", ")} — files in use; close any running model and try again`,
      };
    }
    return this.engineStatus();
  }

  // ── Reclaim disk: the runner owns its cache, so it owns these deletes (the SIZES are
  //    reported by the shared platform GET /v1/disk/usage). ────────────────────────────

  /**
   * Delete every `*.log` under `<runtime>/logs` (the per-spawn llama-server logs — UNBOUNDED;
   * nothing else sweeps them). The dir itself is KEPT so the next spawn can write.
   * Best-effort: a file that won't unlink (a live spawn holding it open on Windows) is
   * skipped, never fatal. Returns `{removed, bytes}`.
   */
  clearSpawnLogs() {
    const logsDir = path.join(this._runtimeRoot, "logs");
    let removed = 0;
    let freed = 0;
    if (isDir(logsDir)) {
      let names = [];
      try {
        names = readdirSync(logsDir);
      } catch {
        names = [];
      }
      for (const n of names) {
        if (!(IS_WIN ? n.toLowerCase() : n).endsWith(".log")) continue;
        const p = path.join(logsDir, n);
        let size;
        try {
          size = statSync(p).size;
          unlinkSync(p);
        } catch (e) {
          log.warning(`could not remove spawn log ${p}`, e);
          continue;
        }
        removed += 1;
        freed += size;
      }
    }
    return { removed, bytes: freed };
  }

  /**
   * Delete every downloaded model GGUF under `<cache>/hf`. SAFE BY DESIGN: the catalog rows
   * live in the host DB, not here, so a cleared model simply RE-DOWNLOADS on demand the next
   * time it is loaded — nothing here is unrecoverable.
   *
   * SAFETY GUARD: refuses (`ok: false`, "unload models first") while any model is resident or
   * loading — its weights are open/mmap'd, and deleting them out from under a running
   * llama-server would crash it (and on Windows an open file can't be unlinked). A
   * download-only op runs on a separate channel invisible to `resident()`; that edge stays
   * safe-by-design (the wipe just makes the download re-fetch).
   */
  async clearModelsCache() {
    const busy = new Set(["loaded", "sleeping", "loading", "downloading", "starting"]);
    const inUse = ((await this.resident()).models || []).filter((m) => busy.has(m.status)).map((m) => m.id);
    if (inUse.length) return { ok: false, detail: "unload models first", models: inUse };
    // One walk, one source: the same size measurement the /v1/disk/usage panel shows.
    const { dirSize } = await import("../platform/disk_api.js");
    const hf = path.join(this._cacheRoot, "hf");
    // dedupLinks like the panel: rmtree removes BOTH names of a hardlinked blob, so the bytes
    // really do come back — but they come back once, and a `freed` that counted each name
    // would overstate the reclaim (2x on Windows).
    const freed = await dirSize(hf, null, true);
    rmTree(hf);
    try {
      mkdirSync(hf, { recursive: true }); // recreate empty so the next download has a home
    } catch (e) {
      log.warning(`could not recreate empty hf cache dir at ${hf}`, e);
    }
    return { ok: true, bytes: freed };
  }

  /**
   * Delete THIS model's downloaded weights from `<cache>/hf` — the catalog 'Delete' reclaims
   * disk, not just the DB row. Resolves the model's repo(s) from the catalog and removes each
   * `models--<repo>` cache dir (blobs + snapshots + any same-repo MTP draft). SAFE BY DESIGN:
   * the weights re-download on demand if the model is re-added.
   *
   * Frees the file handle first — cancels an in-flight download of this model, and unloads it
   * when resident (its GGUF is mmap'd; an open file can't be unlinked on Windows). A repo still
   * referenced by ANOTHER catalog row is KEPT (deleting it would strand that sibling's
   * weights) and reported in `detail`. Idempotent: ok:true/bytes:0 when nothing is cached or
   * the id is unknown (the row may already be gone). Best-effort unlink (locked file skipped).
   */
  async deleteModelCache(modelId) {
    const catalog = this.catalog();
    const model = catalog.find((m) => m.id === modelId) ?? null;
    if (model == null) return { ok: true, bytes: 0, detail: "unknown model — nothing cached" };

    // Release any open handle before unlinking. Cancel a download of THIS model only (other
    // models may be downloading concurrently — leave them running), then join its worker so
    // its file handle is freed before the delete. A harmless no-op when this model isn't
    // downloading.
    await this.cancelDownload(modelId);
    const t = this._downloadThreads.get(modelId);
    if (t != null) await t.join(5);
    if (((await this.resident()).models || []).some((r) => r.id === modelId)) await this.stop(modelId);

    const [freed, kept] = await this._purgeModelWeights(model, catalog);
    const result = { ok: true, bytes: freed };
    if (kept.length) result.detail = `kept weights shared with another model: ${pySorted(kept).join(", ")}`;
    return result;
  }

  /**
   * Delete `model`'s downloaded weights from `<cache>/hf` — its main repo dir plus a SEPARATE
   * MTP-draft repo if the catalog pins one (a same-repo draft rides the main dir). Resolves
   * `[freedBytes, keptRepos]`. A repo another catalog row still needs is KEPT. Assumes the
   * file handle is already free — the caller unloads / cancels any in-flight download first.
   * Shared by `deleteModelCache` and the post-download integrity gate (`_verifyGguf`).
   */
  async _purgeModelWeights(model, catalog = null) {
    const { dirSize } = await import("../platform/disk_api.js");
    catalog = catalog != null ? catalog : this.catalog();
    const repos = new Set([model.hfRepo]);
    const draftRepo = model.mtpDraftRepo || "";
    if (draftRepo) repos.add(draftRepo);

    const hf = path.join(this._cacheRoot, "hf");
    let freed = 0;
    const kept = [];
    for (const repo of repos) {
      const repoDir = path.join(hf, `models--${String(repo).replaceAll("/", "--")}`);
      if (!isDir(repoDir)) continue;
      // KEEP a repo another catalog row still needs — those weights aren't ours to delete.
      const shared = catalog.some((o) => o.id !== model.id && (o.hfRepo === repo || (o.mtpDraftRepo || "") === repo));
      if (shared) {
        kept.push(repo);
        continue;
      }
      // dedupLinks: this repo dir holds blobs/ AND snapshots/, the same weights under two
      // names — one number, or the caller is told it freed twice the disk.
      freed += await dirSize(repoDir, null, true);
      rmTree(repoDir);
    }
    return [freed, kept];
  }

  /**
   * Fail-fast integrity gate on a freshly-acquired main GGUF: parse its header (magic + KV). A
   * corrupt / incomplete / zeroed download (or a missing file) fails the parse and is PURGED —
   * so the next load or download re-fetches clean — then thrown as an actionable
   * `CorruptModelError`, rather than surfacing llama.cpp's raw "bad magic" or bricking the
   * router upstream at spawn. Runs BEFORE spawn, when nothing has the file mmap'd, so the
   * purge always succeeds. `_readMeta` is the injected reader (fake in tests → a no-op
   * offline), so only a REAL corrupt file trips it.
   */
  async _verifyGguf(model, ggufPath) {
    try {
      this._readMeta(ggufPath); // magic + KV header; throws on bad magic / truncation / missing file
    } catch (exc) {
      if (exc instanceof ValueError || isFileNotFound(exc)) {
        // Parse-PROVEN corruption (bad magic / truncated header — gguf.js throws ValueError for
        // both) or a file the OS says is GONE (AV quarantine): purge + actionable error.
        log.warning(`integrity check failed for ${model.id} at ${ggufPath}: ${errText(exc)}`);
        try {
          await this._purgeModelWeights(model);
        } catch (e) {
          // purge is best-effort; the actionable error still stands
          log.warning(`could not purge corrupt weights for ${model.id}`, e);
        }
        throw new CorruptModelError(
          `The downloaded file for "${model.name || model.id}" is corrupted or incomplete, ` +
            "so it can't be loaded. It has been removed — re-download the model to repair it. " +
            "If this keeps happening, add your models folder to your antivirus exclusions.",
          model.id,
          { cause: exc },
        );
      }
      if (isOsError(exc)) {
        // Transient IO — a sharing violation / an AV scan holding the file open is NOT
        // corruption (2026-07-11 hardening): purging here would delete multi-GB GOOD weights
        // on a race. No purge; surface a retryable error instead.
        log.warning(`integrity check could not read ${model.id} at ${ggufPath}: ${errText(exc)}`);
        throw new RuntimeError(
          `Could not read the model file for "${model.name || model.id}" — it may be ` +
            "locked by an antivirus scan or another program. Nothing was deleted; " +
            "try again in a moment.",
          { cause: exc },
        );
      }
      throw exc;
    }
  }

  /**
   * A5 (user "do", 2026-07-06): the latest upstream llama.cpp release vs the INSTALLED build.
   * NEVER auto-applies — the pin is a VERIFIED pin (flag semantics move between builds:
   * reasoning-budget, the ini fields, the PR#16653 --fit behavior were each verified AT a
   * pin), so the surface is notify-then-deliberate-click. QC-25 (a DB reset reverted the pin
   * under an installed newer build and the app offered an "update" that would have
   * DOWNGRADED): `current` is the build actually ON DISK, with the pin only as the
   * nothing-installed fallback. This method never writes the pin. A network failure reports as
   * an `error`, never as updateAvailable.
   *
   * It follows upstream's STABLE channel (2026-09-19): `latest` is the build a `vX.Y.Z`
   * release names, and `latestStable` is that release's tag ("" under the pre-2026-08-21
   * scheme). A `latest` that is not a build tag can never read as an update — `buildNum`
   * returns -1 for it (from 2026-08-21 the old check read "v0.4.1" as 41 and silently
   * reported "current" on every box, plan §3.2).
   *
   * It also offers the build this kit is TESTED with (`_testedBuild`, the kit's
   * DEFAULT_PINNED_BUILD — 2026-09-28). The stable channel can lag it (v0.5.0 names b11146
   * while the pin is b11239). One offer: whichever of the two is newer; a tie reads as tested.
   * `latestKind` says which ("tested" | "stable"). The tested build needs no network, so it is
   * still offered when the stable fetch fails — with that failure in `error`.
   */
  async updateCheck() {
    const config = this._configFn();
    const current = this._installedBuild(config) || config.llamacpp.pinnedBuild;
    const tested = this._testedBuild;
    let stableBuild;
    let stable;
    let error;
    try {
      const res = await this._latestBuildFn();
      // Injected doubles (and the back-compat face) return the tag alone.
      [stableBuild, stable] = Array.isArray(res) ? res : [res, ""];
      error = "";
    } catch (exc) {
      // any fetch failure = the same honest answer
      [stableBuild, stable, error] = ["", "", errText(exc)];
    }
    let latest;
    let kind;
    if (binary.buildNum(tested) > 0 && binary.buildNum(tested) >= binary.buildNum(stableBuild)) {
      [latest, kind] = [tested, "tested"];
    } else {
      [latest, kind] = [stableBuild, binary.buildNum(stableBuild) > 0 ? "stable" : ""];
    }
    return {
      current,
      latest,
      latestKind: kind,
      latestStable: stable,
      updateAvailable: binary.buildNum(latest) > 0 && binary.buildNum(latest) > binary.buildNum(current),
      error,
    };
  }

  /**
   * Where an update to `build` would download from, per stored row — resolved from that
   * release's OWN asset list, because upstream renames these files between builds (plan
   * …-engine-update-safety-and-stable-channel.md §3.4: Windows AMD went hip-radeon →
   * rocm-7.14 → rocm-10.0, Linux AMD vanished for ~180 builds).
   *
   * READ-ONLY: it never writes the pin or a URL — the user's deliberate click still does that
   * (the update-check invariant). `selected` names THIS machine's row, so the caller can refuse
   * before writing anything. A fetch failure reports as `error`; the caller then falls back to
   * tag substitution, which is what it always did.
   */
  async resolveBuildAssets(build) {
    const out = { build, binaries: [], selected: null, error: "" };
    if (!_BUILD_TAG.test(strip(String(build ?? "")))) {
      out.error = `${reprAny(build)} is not a build tag`;
      return out;
    }
    const config = this._configFn();
    let assets;
    try {
      assets = await this._releaseAssetsFn(build);
    } catch (exc) {
      // any fetch failure = the same honest answer
      out.error = errText(exc);
      return out;
    }
    const rows = [...(config.llamacpp.binaries || [])];
    out.binaries = binary.resolveReleaseAssets(build, rows, assets);
    let mine;
    try {
      mine = binary.selectBinary(config, this._hardwareFn());
    } catch {
      mine = null; // a hardware probe must never break the answer
    }
    if (mine != null) {
      const r = out.binaries.find((x) => x.platform === mine.platform && x.gpu === mine.gpu);
      out.selected = r ? { platform: r.platform, gpu: r.gpu, resolved: r.resolved, reason: r.reason } : null;
    }
    return out;
  }

  /**
   * Make `modelId` resident in the router (spawning the router LAZILY on the first call). The
   * in-flight guard is PER-MODEL — loading a DIFFERENT model while one is loading proceeds
   * (co-residence within `modelsMax`); a second load of the SAME in-flight model returns its
   * current state. Heavy work runs as a background task (`_runLoad`); this resolves at once
   * with the seeded state.
   *
   * `trigger` names the ASK's origin in the log — "api" (a user's HTTP call, the default) /
   * "ensure-ready" (dispatch's auto-load before a local AI run) / "ensure-embedding" /
   * "autotune". Telemetry only, never behavior. Added 2026-07-17: an unload-then-respawn hunt
   * died because NOTHING recorded who asked for a load — every internal caller must pass its
   * own name, so an unnamed caller showing up as "api" in a log stays a signal, not a lie.
   */
  async load(modelId, { overrides = null, jobId = null, switches = null, trigger = "api" } = {}) {
    // Log EVERY ask — including the warm no-op and in-flight returns below. The respawn hunt
    // needs the asks that DIDN'T start a load too.
    log.info(`load ${modelId} (trigger=${trigger})`);
    overrides = asOverrides(overrides);
    // Defect D (T4): a direct load is fresh intent — it clears the model's stop-tombstone.
    // (ensureModelReady checks the tombstone BEFORE calling load(), so this pop cannot defeat
    // the ensure guard.)
    this._stopTombstones.delete(modelId);
    const cur = this._resident.get(modelId);
    if (cur != null && (cur.status === "downloading" || cur.status === "starting")) {
      return { ...cur }; // THIS model's load is already in flight
    }
    // A plain re-load of an already-running model (no tuning) is idempotent — keep it warm
    // (touch the LRU) rather than re-POST /models/load and get a 400 "already loaded" from the
    // router, which would then error + RELEASE the reservation while the child is still
    // resident (a VRAM-ledger drift). A Lab re-tune (real overrides/switches/job) still
    // re-loads to apply the ephemeral .ini section. NB: the HTTP path always passes an
    // Overrides() — empty when the body carries no tuning — so "no overrides" must compare
    // EQUAL to the default, not `== null`. The router-liveness gate is essential:
    // `_resident[id]=="running"` can be STALE after a router crash (status() only reconciles
    // the _lastId primary, not a co-resident like the pinned embed), and swallowing a re-load
    // then would never respawn the dead router.
    const router = this._router;
    const noTuning = (overrides == null || overrides.equals(new Overrides())) && !truthy(switches) && !jobId;
    if (cur != null && cur.status === "running" && noTuning && router != null && router.isAlive()) {
      this._lastId = modelId; // a re-load promotes to primary, as the non-guard path does
      this._arbiter.touch(modelId);
      return { ...cur };
    }
    this._resident.set(modelId, {
      status: "downloading",
      modelId,
      url: "",
      detail: "queued",
      error: "",
      downloaded: 0,
      total: 0,
    });
    // A FRESH event per load — never reuse: a stale set event from a prior cancelled load
    // would silently self-cancel this one at the first checkpoint.
    this._cancelEvents.set(modelId, new AsyncEvent());
    this._lastId = modelId;
    log.info(`load ${modelId}: starting load thread (trigger=${trigger})`);
    this._thread = new BackgroundTask(`load ${modelId}`, () =>
      this._runLoad(modelId, overrides ?? new Overrides(), jobId, switches),
    );
    return { ...this._resident.get(modelId) };
  }

  /** The admission ceiling, read LIVE at each gate check so the knob is tunable without a
   * restart: `downloadMaxConcurrent` clamped to [1, MAX_DOWNLOAD_CONCURRENT] (the same
   * ONE-source clamp the config-API write path applies — a raw DB poke can't route around
   * it). */
  _downloadLimit() {
    const config = this._configFn();
    const raw =
      config != null && typeof config === "object" && "downloadMaxConcurrent" in config
        ? config.downloadMaxConcurrent
        : DEFAULT_DOWNLOAD_MAX_CONCURRENT;
    try {
      return Math.max(1, Math.min(MAX_DOWNLOAD_CONCURRENT, pyInt(typeof raw === "string" ? raw : (raw ?? "None"))));
    } catch {
      return DEFAULT_DOWNLOAD_MAX_CONCURRENT;
    }
  }

  /** Park a queued download until a slot frees, then CLAIM it. A slot is free when fewer than
   * `_downloadLimit()` downloads are RUNNING (an entry whose detail has moved past "queued").
   * Re-checks its own cancel token every ~0.2 s so a cancel while QUEUED still takes effect;
   * on admission flips the entry's detail to the running phase in the same step, so the
   * running-count is race-free. */
  async _awaitSlot(modelId, cancelEv) {
    for (;;) {
      const entry = this._downloadStates.get(modelId);
      if (entry == null || cancelEv.isSet()) throw new DownloadCancelled(); // cancelled (or removed) before we ever ran
      let running = 0;
      for (const e of this._downloadStates.values()) {
        if (e.status === "downloading" && e.detail !== "queued") running += 1;
      }
      if (running < this._downloadLimit()) {
        entry.detail = "model weights"; // claim the slot → now counted as running
        return;
      }
      await this._downloadGate.wait(200);
    }
  }

  /**
   * Download a model's GGUF into the cache WITHOUT spawning it — the catalog's 'Download'
   * action, separate from 'Load'. Runs on its OWN per-model channel + task (like
   * engine-install) so it NEVER touches the running model's state: a download can proceed
   * while another model is loaded, AND several models download concurrently (up to
   * `downloadMaxConcurrent`; the rest queue). Idempotent: a second click while THIS model is
   * already downloading/queued returns its live state. A prior "error" entry is replaced by a
   * fresh run. Does NOT require the engine installed (only loading does).
   */
  async download(modelId) {
    const existing = this._downloadStates.get(modelId);
    if (existing != null && existing.status === "downloading") return { ...existing }; // already in flight — idempotent
    const cancelEv = new AsyncEvent();
    this._downloadCancels.set(modelId, cancelEv);
    const entry = { status: "downloading", modelId, detail: "queued", error: "", downloaded: 0, total: 0 };
    this._downloadStates.set(modelId, entry); // replaces any prior "error" entry
    const t = new BackgroundTask(`download ${modelId}`, () => this._runDownload(modelId));
    this._downloadThreads.set(modelId, t);
    return { ...entry };
  }

  /**
   * Signal a download-only op to stop at the next chunk/file boundary (a running worker polls
   * `cancelCheck` per chunk; a QUEUED one is woken and aborts before it runs). With `modelId`
   * → cancel just that one; null → cancel ALL (the back-compat no-id path any engine-panel
   * 'cancel everything' uses). Idempotent: unknown/idle ids are no-ops. Resolves the full
   * downloadStatus() snapshot.
   */
  async cancelDownload(modelId = null) {
    let targets;
    if (modelId != null) {
      targets = [modelId];
    } else {
      // ALL: every live cancel token PLUS any terminal (errored) row, so a "cancel
      // everything" genuinely empties the map instead of leaving dead rows behind for the UI
      // to keep rendering.
      targets = [
        ...this._downloadCancels.keys(),
        ...[...this._downloadStates].filter(([, e]) => e.status === "error").map(([mid]) => mid),
      ];
    }
    for (const mid of targets) {
      this._downloadCancels.get(mid)?.set();
      const e = this._downloadStates.get(mid);
      if (e == null) continue;
      if (e.status === "downloading") {
        e.detail = "cancelling…";
      } else if (e.status === "error") {
        // DROP a dead row (2026-07-24). An errored download has no worker to signal, so
        // cancelling it used to be a pure no-op and the row stayed in the map forever — the
        // UI's downloadingSet (which matches "downloading" OR "error") never reaped its task,
        // and the catalog row was stuck showing a failure whose only action was Retry.
        // Removing it here is what makes "dismiss" real. Only terminal rows are dropped; a
        // live download is signalled, never deleted.
        this._downloadStates.delete(mid);
      }
    }
    this._downloadGate.notifyAll(); // wake any parked (queued) workers to re-check
    return this.downloadStatus();
  }

  /** Snapshot of EVERY in-flight/errored download keyed by model id — its own channel,
   * separate from the model run-state (status()) and engine install. Shape:
   * `{downloads: {modelId: {status, modelId, detail, error, downloaded, total}}}`. An id
   * ABSENT from the map is idle/done (its weights are on disk). */
  downloadStatus() {
    return { downloads: Object.fromEntries([...this._downloadStates].map(([mid, e]) => [mid, { ...e }])) };
  }

  /**
   * Per-model LIVE operation detail — the caption, byte counters and error text sitting BEHIND
   * `status`, merged from both channels (the load ledger and the download map).
   *
   * The models list serializes these onto every row so any surface can render a truthful
   * progress bar from the SERVER alone (user ruling 2026-08-14: one control, one source).
   * Before this, only a browser-side task carried them, so a reloaded page — or a second
   * window, or a row whose load slot had moved on — drew an empty bar while the server knew
   * the load had failed.
   */
  opProgress() {
    const out = new Map();
    for (const [mid, st] of [...this._resident]) {
      out.set(mid, {
        detail: st.detail || "",
        done: pyInt(st.downloaded || 0),
        total: pyInt(st.total || 0),
        error: st.error || "",
      });
    }
    // A download-only op runs on its own channel and can overlap a resident model, so it
    // overlays the load ledger when active.
    for (const [mid, e] of this._downloadStates) {
      if (e.status === "downloading" || e.status === "error") {
        out.set(mid, {
          detail: e.detail || "",
          done: pyInt(e.downloaded || 0),
          total: pyInt(e.total || 0),
          error: e.error || "",
        });
      }
    }
    return Object.fromEntries(out);
  }

  /**
   * `stop(id)` cancels an IN-FLIGHT load or unloads a resident model; `stop()` (no id — the
   * back-compat `/v1/llm-runner/stop`) is a FULL teardown.
   *
   * T2 (2026-07-17 approved plan) — the three shapes:
   * • MID-LOAD (`downloading`/`starting`): set the model's cancel token, mark `cancelling`,
   *   return AT ONCE — never touching `_routerLock` (the old stop blocked behind the load's
   *   router ops for the whole VRAM phase while the UI's "Cancelled" lied). The LOAD TASK owns
   *   all cleanup at its checkpoints. (This branch runs synchronously, before the first
   *   await, so a caller that does not await still cancels at once.)
   * • RESIDENT: mark `stopping` BEFORE the lock (visible even while queued), unload under it,
   *   then CONFIRM-UNLOAD — poll GET /models until the router agrees the model is gone, so
   *   "stop returned" can never flicker back to "● loaded" during child teardown. The final
   *   removal is a COMPARE-AND-POP: only the `stopping` entry THIS stop wrote is popped — a
   *   fresher `downloading` entry written by a concurrent load() (e.g. ensureModelReady's
   *   auto-load) is left alone, else that load would abort at its membership checkpoint and
   *   its waiter would die at the 180 s timeout.
   * • Already `cancelling`/`stopping`: a double-stop is a no-op.
   */
  async stop(modelId = null) {
    // The ask logs BEFORE any lock: a stop that then queues still lands in the log at click
    // time (2026-07-17 — timeline correlation was impossible before).
    log.info(`stop ${modelId || "<full teardown>"}`);
    if (modelId) {
      // Defect D (T4): an EXPLICIT stop tombstones the model — ensure-ready (a
      // possibly-zombie request's auto-load) must not undo it for _STOP_TOMBSTONE_S; a direct
      // user load() pops the stamp.
      this._stopTombstones.set(modelId, this._now());
      const st = this._resident.get(modelId)?.status;
      if (st === "downloading" || st === "starting") {
        this._cancelEvents.get(modelId)?.set();
        this._touch(modelId, { status: "cancelling", detail: "" });
        return this.status();
      }
      if (st === "cancelling" || st === "stopping") return this.status(); // a second click while the first resolves
      // Resident (or errored) → the unload path. The status write is UNLOCKED and
      // deliberate: a stop queued behind a load's router ops must already read "stopping",
      // not "● loaded" (the user's unload-×3, 2026-07-17).
      this._touch(modelId, { status: "stopping", detail: "" });
      await this._routerLock.run(async () => {
        const router = this._router;
        let routerStillLive = false; // timeout with the child still listed live (defect E)
        if (router != null && router.isAlive()) {
          try {
            await this._routerUnload(router.url, modelId);
          } catch (e) {
            log.warning(`router unload ${modelId} failed`, e); // best-effort
          }
          // Confirm-unload (bounded): the unload POST can return while the child is still
          // exiting, and GET /models keeps saying loaded until it has — popping then would let
          // the next poll paint "● loaded" again and invite the second click.
          const deadline = this._now() + 5.0;
          for (;;) {
            let live;
            try {
              live = _parseRouterModels(await this._routerModels(router.url));
            } catch {
              break; // router died mid-teardown = gone
            }
            if (!["loaded", "sleeping", "loading"].includes(live.get(modelId)?.value)) break;
            if (this._now() >= deadline) {
              // Defect E (2026-07-22, pass-1 plan T5): do NOT pop while the router still lists
              // the child live — a ledger that says gone while the child serves on is the drift
              // that later surfaces as "/models/load … already running". Keep the entry at
              // "stopping"; resident()'s self-heal pops it the moment the router agrees the
              // child is gone (its compare-and-pop).
              routerStillLive = true;
              log.warning(
                `confirm-unload timeout: router still reports ${modelId} after unload — keeping 'stopping' for the reconcile`,
              );
              break;
            }
            await this._sleep(this._loadPollInterval);
          }
        }
        const cur = this._resident.get(modelId);
        if (cur != null && cur.status === "stopping" && !routerStillLive) {
          this._resident.delete(modelId);
          if (this._lastId === modelId) this._lastId = firstKey(this._resident);
        }
        // The OLD residency's reservation goes either way; a concurrent fresh load reserves
        // anew only after its own confirmed load (it cannot have reserved yet — reserve
        // happens under the router lock stop holds).
        this._arbiter.release(modelId);
      });
    } else {
      await this._routerLock.run(async () => {
        // Defect D (T4): a full teardown tombstones every resident model.
        const now = this._now();
        for (const mid of [...this._resident.keys()]) this._stopTombstones.set(mid, now);
        const router = this._router;
        if (router != null) {
          try {
            router.stop();
          } catch {
            /* best-effort */
          }
        }
        this._router = null;
        this._resident.clear();
        this._cancelEvents.clear();
        this._arbiter.clear(); // full teardown → drop the whole VRAM ledger
        this._activeEntries.clear(); // T3: nothing resident → no loaded-with configs
        this._lastIniText = "";
        this._lastId = "";
      });
    }
    return this.status();
  }

  /** The model's on-disk GGUF path, or null (unknown id / not downloaded) — the one
   * catalog+cache lookup, shared by previewFit and the boot derive-backfill
   * (identity.backfillDerivedFromCache, 2026-07-07). */
  cachedPath(modelId) {
    const model = this.catalog().find((m) => m.id === modelId);
    if (model == null) return null;
    return models.cachedGgufPath(model.hfRepo, model.quant, {
      cacheRoot: path.join(this._cacheRoot, "hf"),
      mmproj: model.mmproj ?? null,
    });
  }

  /**
   * Pure fit PREVIEW for a CACHED model: block count / MoE-ness + the computed layer split for
   * the given switches — no download, no spawn. The auto-tune sweep anchors its n-cpu-moe
   * candidates on this. Errors soft: unknown / not-downloaded → ok:false.
   *
   * GROWN into the claim-resolver door at Phase 5 (§6.2 — the DO-NOT list forbids a second
   * resolver standing beside this): every return carries `claim` = {vramMb, ramMb, source,
   * matches} resolved down the four-arm ladder (resident-live → persisted-measured → computed
   * → declared), even for a not-downloaded model (the declared arm needs no file).
   */
  previewFit(modelId, switches = null) {
    const model = this.catalog().find((m) => m.id === modelId);
    if (model == null) return { ok: false, error: `unknown model: ${modelId}` };
    const claim = this._resolveClaim(model, switches);
    const ggufPath = this.cachedPath(modelId);
    if (ggufPath == null) return { ok: false, error: "model not downloaded", claim };
    let f;
    try {
      const ov = _switchesToOverrides(truthy(switches) ? { ...switches } : this._switchesFn(modelId) || {});
      // Mirror the `.ini` emitter's draft resolve (2026-07-19) so the PREVIEW's layer split
      // matches what the spawn will actually get: a wanted draft that is on disk is charged
      // to the fit; one not downloaded yet contributes nothing, exactly like the emitter's
      // strip branch.
      if (_wantsDraft(ov, model)) {
        const cachedDraft = this._cachedDraftPath(model, path.join(this._cacheRoot, "hf"));
        if (cachedDraft != null) ov.modelDraft = String(cachedDraft);
      }
      const meta = this._readMeta(ggufPath);
      const [draftMeta, draftBytes] = this._draftFitInputs(ov);
      const c = this._configFn();
      f = processMod.computeFit(meta, gguf.ggufTotalBytes(ggufPath), this._hardwareFn(), ov, {
        safetyMarginMb: c.safetyMarginMb,
        ctxCapTokens: c.ctxCapTokens,
        draftMeta,
        draftBytes,
      });
    } catch (exc) {
      return { ok: false, error: errText(exc), claim }; // a preview must never throw into the sweep
    }
    return {
      ok: true,
      blockCount: f.blockCount,
      isMoe: f.isMoe,
      nGpuLayers: f.nGpuLayers,
      nCpuMoe: f.nCpuMoe,
      ctxLen: f.ctxLen,
      claim,
    };
  }

  /**
   * The four-arm claim ladder (§6.2; the INTERNAL engine `previewFit` and
   * `_embedGpuLeftoverMb` share — the public door stays previewFit):
   *
   *     resident-live → persisted-measured → computed → declared
   *
   * Returns {vramMb, ramMb, source, matches}. The claim follows the RESOLVED DEVICE (a load
   * at ngl 0 books 0 VRAM); ramMb is the §13.12 rule (file + headroom; display-only per §8.18)
   * on every arm — measured rows don't capture RAM. Foreign kinds (JV's TTS/STT engines) come
   * through the `declaredClaimFn` seam their wiring registers; this method is the kit's own
   * kind="llm" path.
   */
  _resolveClaim(model, switches = null) {
    const c = this._configFn();
    // MiB — compared with hardware MiB (vram-truth plan 2026-09-19 §6.4).
    const sizeMb = model.sizeBytes ? model.sizeBytes / (1024 * 1024) : null;
    const ramMb = sizeMb ? pyRound(sizeMb + Math.max(0, c.ramHeadroomMb)) : pyInt(model.minRamMb || 0);
    // Arm 1 — resident-live: the arbiter's booked number, with its §13.1 provenance (a
    // measured true-up reads "measured"; a probe-less box's booking reads "computed" — never
    // dressed up).
    const res = this._arbiter.reservationOf(model.id);
    if (res != null) {
      return { vramMb: Math.trunc(res.vram_mb), ramMb, source: res.source || "computed", matches: 0 };
    }
    const ggufPath = this.cachedPath(model.id);
    if (ggufPath != null) {
      try {
        const ov = _switchesToOverrides(truthy(switches) ? { ...switches } : this._switchesFn(model.id) || {});
        if (_wantsDraft(ov, model)) {
          const cachedDraft = this._cachedDraftPath(model, path.join(this._cacheRoot, "hf"));
          if (cachedDraft != null) ov.modelDraft = String(cachedDraft);
        }
        const meta = this._readMeta(ggufPath);
        const [draftMeta, draftBytes] = this._draftFitInputs(ov);
        const hw = this._hardwareFn();
        const f = processMod.computeFit(meta, gguf.ggufTotalBytes(ggufPath), hw, ov, {
          safetyMarginMb: c.safetyMarginMb,
          ctxCapTokens: c.ctxCapTokens,
          draftMeta,
          draftBytes,
        });
        const backend = hardware.activeBackend(hw);
        const mkey = hardware.machineKey(hw);
        let fset = new Set();
        if (this._fitRelevantFlagsFn != null) {
          try {
            fset = new Set(this._fitRelevantFlagsFn() || []);
          } catch {
            fset = new Set(); // a store hiccup falls to computed
          }
        }
        const rows = this.measurementRows();
        // Arm 2 — persisted-measured: MEDIAN over fingerprint-matched 'load' rows on THIS box
        // + backend (§13.2). A fingerprint miss falls to computed, full stop — the
        // ctx-adjust cleverness was CUT (§13.4). No fingerprint set wired → no matching.
        if (fset.size) {
          const pairsOf = (sw) =>
            pySorted(
              Object.entries(sw).filter(([k]) => fset.has(k)),
              (kv) => kv,
            );
          const want = pairsOf(RunnerService._fitConfigSwitches(f, ov));
          const matched = [];
          for (const r of rows) {
            if (
              (r?.modelId ?? "") !== model.id ||
              (r?.machineKey ?? "") !== mkey ||
              (r?.backend ?? "") !== backend ||
              (r?.source ?? "") !== "load"
            ) {
              continue;
            }
            const mb = pyInt(r.vramModelMb || 0);
            if (mb <= 0) continue;
            const rowSw = bandwidth._normSwitches(Object.fromEntries((r.switches || []).map((fl) => [fl.flagName, fl.flagValue])));
            const got = pairsOf(rowSw);
            if (got.length === want.length && got.every(([k, v], i) => k === want[i][0] && v === want[i][1])) matched.push(mb);
          }
          if (matched.length) {
            // A single row is usable but LOW-CONFIDENCE (§13.2) — `matches` says how much
            // evidence stands behind it.
            return { vramMb: Math.trunc(median(matched)), ramMb, source: "measured", matches: matched.length };
          }
        }
        // Arm 3 — computed: the physics booking, with the LEARNED per-(backend × machine ×
        // build) overhead replacing the seed when true-ups have taught it (§13.2/§13.6; a
        // build bump invalidates old rows by label non-match — recalibration by construction).
        let vram = Number(f.vramMb);
        if (f.nGpuLayers > 0 && vram > 0) {
          // The build ON DISK (R2 of the vram-truth plan: the pin is a choice, the running
          // engine is a fact — QC-13) + the physics version: a coefficient learned under
          // another byte model must not apply.
          const build = `${this._installedBuild(c) || c.llamacpp.pinnedBuild} ${fitMod.PHYSICS_VERSION}`;
          const learned = rows
            .filter(
              (r) =>
                (r?.modelId ?? "") === "__overhead__" &&
                (r?.machineKey ?? "") === mkey &&
                (r?.backend ?? "") === backend &&
                pyStr(r?.label === undefined ? "" : r.label).endsWith(build) &&
                pyInt(r.vramModelMb || 0) > 0,
            )
            .map((r) => pyInt(r.vramModelMb || 0));
          if (learned.length) {
            const seed = fitMod.PHYSICS_OVERHEAD_MB[backend] ?? fitMod.PHYSICS_OVERHEAD_MB.cuda;
            vram = Math.max(0.0, vram - seed + median(learned));
          }
        }
        return { vramMb: pyRound(vram), ramMb, source: "computed", matches: 0 };
      } catch (e) {
        // a claim read must never throw into a caller
        log.debug(`claim resolve fell to declared for ${model.id}: ${errText(e)}`);
      }
    }
    // Arm 4 — declared: the catalog's price. For chat rows the WANT (estVramMb) over the bare
    // floor — the conservative pre-download number the 2026-07-25 embed-guard ruling chose;
    // understating here re-opens the co-load crash class.
    const rec = model.recommendedFor || {};
    const declared = pyInt(rec.estVramMb || rec.minVramMb || 0);
    return { vramMb: declared, ramMb, source: "declared", matches: 0 };
  }

  /**
   * Probe a RESIDENT model with a fixed prompt → decode tok/s + the box's resource context
   * (#20 "Tune & measure"). `modelId` defaults to the primary (most-recently loaded); in router
   * mode the probe routes by that id. Requires the model resident. The real tok/s is
   * GPU-gated, but the timing math is not — `probe(url, prompt, maxTokens, {modelId})` /
   * `sample()` are injected in tests.
   */
  async measure({
    prompt = "Write one vivid paragraph about the sea.",
    maxTokens = 128,
    probe = null,
    sample = null,
    modelId = null,
  } = {}) {
    const mid = modelId || this._lastId;
    const st = this._resident.get(mid);
    const router = this._router;
    if (router == null || !router.isAlive() || !mid) return { ok: false, error: "no model running — load one first" };
    if (st == null || st.status !== "running") {
      // The internal ledger can be stale/reconciled while the child serves on — observed
      // 2026-07-21: BOTH bench legs' measures refused ("no model running") while the router
      // was serving every feature run fine, which is why the summary's MTP-acceptance table
      // came back empty. The ROUTER is the authority on residency (the same source
      // `resident()` reports and the bench polls), so consult it before refusing; loaded OR
      // sleeping counts (a sleeper wakes on the probe request, exactly as it does for a real
      // feature run).
      let live;
      try {
        live = _parseRouterModels(await this._routerModels(router.url));
      } catch {
        live = new Map(); // router GET failed → the refusal stands
      }
      const liveStatus = String(live.get(mid)?.value || "").toLowerCase();
      if (liveStatus !== "loaded" && liveStatus !== "sleeping") return { ok: false, error: "no model running — load one first" };
      log.info(
        `measure: internal ledger says ${reprAny(st?.status)} for ${mid} but the router reports ${reprAny(liveStatus)} — proceeding on the router's authority`,
      );
    }
    probe = probe || self._defaultMeasureProbe;
    sample = sample || self._defaultMeasureSample;
    let ct;
    let ms;
    let draft;
    try {
      [ct, ms, draft] = await probe(router.url, prompt, maxTokens, { modelId: mid });
    } catch (exc) {
      return { ok: false, error: errText(exc) }; // surface the probe error, don't crash
    }
    const tps = ms > 0 && ct ? pyRound(ct / (ms / 1000), 1) : 0.0;
    this._arbiter.touch(mid); // a measure is a use — keep it warm in the LRU
    const out = {
      ok: true,
      modelId: mid,
      tokensPerSec: tps,
      completionTokens: ct,
      ms: pyRound(ms, 1),
      ...(await sample()),
    };
    // Speculative-decoding acceptance (MTP, T3): present ONLY when the probe's completion
    // carried draft timings (spec actually ran). draftN==0 while a model is MTP-configured is
    // the "configured but not engaging" signal the bench flags.
    if (draft != null) {
      const n = draft.n;
      const acc = draft.accepted;
      out.draftN = n;
      out.draftNAccepted = acc;
      out.draftAcceptance = n > 0 ? pyRound(acc / n, 4) : 0.0;
    }
    return out;
  }

  /** Exact token count for `text` via a RESIDENT model's own tokenizer (b1/E2 — the
   * prompt-preview's exact-when-local count). `modelId` defaults to the primary; the router
   * routes /tokenize by that id. Requires the model resident; callers fall back to a
   * client-side heuristic otherwise. `probe(url, text, {modelId})` injected in tests. */
  async tokenize({ text, probe = null, modelId = null } = {}) {
    const mid = modelId || this._lastId;
    const st = this._resident.get(mid);
    const router = this._router;
    if (router == null || !router.isAlive() || st == null || st.status !== "running") {
      return { ok: false, error: "no model running" };
    }
    probe = probe || self._defaultTokenizeProbe;
    let count;
    try {
      count = await probe(router.url, text, { modelId: mid });
    } catch (exc) {
      return { ok: false, error: errText(exc) }; // surface the probe error, don't crash
    }
    this._arbiter.touch(mid); // a tokenize is a use — keep it warm in the LRU
    return { ok: true, count: pyInt(count) };
  }

  /**
   * The LIVE resident set for `GET /v1/llm-runner/resident`: the router's own `GET /models`
   * view (per-model status + the `meta` footprint of a LOADED child), the two operator knobs
   * that bound it (`models_max` / `sleep_idle_seconds`), and any in-flight load not yet
   * visible to the router. Read-only, safe to poll. snake_case keys matching
   * `RunnerResidentResponse` (the API layer emits camelCase). Router down (the lazy-spawn
   * common case) → `router: false`, empty set.
   */
  async resident(hw = null) {
    const c = this._configFn();
    // The router's own view comes FIRST, and its sleeping set reconciles the ledger before
    // the snapshot is taken (2026-08-15): read the other way round, the committed/remaining
    // numbers in this very response were a poll behind the sleeping flags they depend on.
    // This poll is also what keeps the flags fresh for a co-tenant that never calls the
    // runner (JustVoice's speech door).
    const router = this._router;
    let live = new Map();
    const routerUp = router != null && router.isAlive();
    if (routerUp) {
      let ok = false;
      try {
        live = _parseRouterModels(await this._routerModels(router.url));
        ok = true;
      } catch (e) {
        log.warning("GET /models failed while reading the resident set", e); // an empty live set
        live = new Map();
      }
      if (ok) this._syncSleepingFrom(live);
    }
    const snap = await this._arbiter.snapshot(hw); // committed/remaining/total budget (hw passed → no re-detect)
    const out = {
      router: routerUp,
      models_max: c.modelsMax,
      sleep_idle_seconds: c.sleepIdleSeconds,
      mem_arch: snap.mem_arch ?? "discrete",
      vram_total_mb: snap.vram_total_mb,
      // The MEASURED occupancy rides through to the strip (2026-08-14) — this object copies
      // named keys, so a field added to the snapshot and not to this list silently arrives as
      // null at the UI.
      used_mb: snap.used_mb ?? null,
      committed_mb: snap.committed_mb,
      remaining_mb: snap.remaining_mb,
      models: [],
    };
    const rows = [];
    const byId = new Map();
    for (const [mid, info] of live) {
      const meta = info.meta || {};
      const row = {
        id: mid,
        status: info.value || "unloaded",
        n_params: meta.n_params ?? null,
        size_bytes: meta.size ?? null,
        n_ctx: meta.n_ctx ?? null,
        vram_mb: this._arbiter.reservedMb(mid), // GPU-resident VRAM the arbiter reserved
      };
      rows.push(row);
      byId.set(mid, row);
    }
    // Overlay OUR in-flight ledger onto the router's view. Two cases:
    //  • The router doesn't list the id (never spawned — e.g. engine-not-installed errors, or
    //    a load mid-download with the router down): APPEND it, as ever.
    //  • The router DOES list the id but as IDLE: our in-flight status OVERRIDES it. The
    //    router lists EVERY preset model, loaded or not — so the old `if mid in seen:
    //    continue` masked the WHOLE pre-router phase of a load (disk check, fit, .ini emit,
    //    lock wait) behind the router's stale "unloaded", and the catalog's Load button looked
    //    dead while the load was already running (the user's 3-click repro, 2026-07-17). An
    //    ACTIVE router state (loaded|sleeping|loading) is the child's own truth and always
    //    wins the other way.
    for (const [mid, st] of [...this._resident]) {
      const s = st.status;
      if (!["downloading", "starting", "error", "cancelling", "stopping"].includes(s)) continue;
      const row = byId.get(mid);
      const routerLive = row != null && ["loaded", "sleeping", "loading"].includes(row.status);
      // SELF-HEAL a stuck "Unloading…" (2026-07-21): a "stopping" model the ROUTER no longer
      // reports as live (gone from its list, or listed as "unloaded") has ACTUALLY unloaded —
      // do NOT keep painting a phantom "Unloading…". Its ledger entry is cleaned by stop()'s
      // compare-and-pop, but that runs AFTER stop() acquires `_routerLock`, which a slow/hung
      // load can hold — so a cancelled/evicted model showed "Unloading…" indefinitely. Once
      // the router confirms it's gone, drop it here so the UI clears at once.
      if (s === "stopping" && !routerLive) {
        // …and CONVERGE THE LEDGER (defect E, 2026-07-22 pass-1 plan T5): stop()'s
        // confirm-unload timeout KEEPS the entry at "stopping" while the router still lists
        // the child. Once the router agrees the child is gone, THIS is the one cleanup.
        // Compare-and-pop: a concurrent fresh load() has already overwritten the entry
        // ("downloading"), so the guard refuses and nothing is lost.
        const cur = this._resident.get(mid);
        if (cur != null && cur.status === "stopping") {
          this._resident.delete(mid);
          if (this._lastId === mid) this._lastId = firstKey(this._resident);
        }
        continue;
      }
      if (row == null) {
        rows.push({ id: mid, status: s, vram_mb: this._arbiter.reservedMb(mid) });
      } else if (s === "stopping" || !["loaded", "sleeping", "loading"].includes(row.status)) {
        // T2b: while the child is genuinely tearing down (router still "loaded"), "stopping"
        // overrides that active listing so a stale "● loaded" can't re-invite a second Unload
        // click. Bounded: cleared the moment the router agrees (above).
        row.status = s;
      }
    }
    out.models = rows;
    return out;
  }

  /**
   * Make the configured local embedding model resident + PINNED, downloading its GGUF first
   * if needed — the LAZY trigger the host (JustWrite RAG "Build index" / Chat-with-book) calls
   * before it uses local embeddings. The embed request path hits the router directly, so the
   * embed must already be resident; this is what makes it so. No local embed configured →
   * `{ok: false}` and the caller falls back to that provider unchanged. Delegates to `load()`
   * (download-if-needed + lazy-spawn the router + reserve PINNED via `_runLoad`); idempotent +
   * cheap when the embed is already resident. Resolves IMMEDIATELY (the load runs in the
   * background): the caller polls `GET /v1/llm-runner/resident` for the returned `modelId`
   * until it reads loaded|sleeping before embedding.
   */
  async ensureEmbedding() {
    const embedIds = keySet(this._embeddingIdsFn());
    if (!embedIds.size) return { ok: false, detail: "no local embedding model configured" };
    const embedId = [...embedIds][0];
    const state = await this.load(embedId, { trigger: "ensure-embedding" });
    return { ok: true, modelId: embedId, ...state };
  }

  // ── the sleeping-child reconcile (2026-08-15) ─────────────────────────────
  // `--sleep-idle-seconds` idle-unloads a child: its VRAM is really gone while the router
  // still lists it as `sleeping`. Until this landed, the ledger kept booking that memory,
  // which made `committed_mb` a fiction and — because JustVoice's speech door prices on
  // MEASURED free memory, as it must — let a TTS engine move into the sleeper's freed
  // gigabytes with the booking still standing. The whole story is in arbiter.js's header.
  // This is the probe half: the router is the only thing that knows, and asking it costs one
  // local HTTP GET, so it is TTL-cached and called from the two admission doors + the
  // resident poll, never from a ledger read.

  /**
   * Re-align the arbiter's `asleep` flags with the router's live `GET /models`. Best-effort
   * and never throws: a router that is down or slow leaves the ledger exactly as it was
   * (conservative — it keeps booking memory that may be free, which can only refuse a load,
   * never overcommit one). TTL-cached at `_SLEEP_PROBE_TTL_S`; `force` bypasses the cache for a
   * door that must not act on a stale reading.
   */
  async reconcileSleeping({ force = false } = {}) {
    const router = this._router;
    if (router == null || !router.isAlive()) return;
    const now = this._now();
    if (!force && this._lastSleepProbe != null && now - this._lastSleepProbe < RunnerService._SLEEP_PROBE_TTL_S) return;
    let live;
    try {
      live = _parseRouterModels(await this._routerModels(router.url));
    } catch (e) {
      log.debug(`sleeping-set probe failed; ledger left as-is: ${errText(e)}`); // a probe must never fail the caller
      return;
    }
    this._lastSleepProbe = now;
    this._syncSleepingFrom(live);
  }

  /** Hand the arbiter the sleeping set parsed from a router model list the caller ALREADY
   * fetched (`resident()` polls it every couple of seconds — no second GET). */
  _syncSleepingFrom(live) {
    const sleeping = new Set();
    for (const [mid, info] of live) {
      if (String(info.value || "").toLowerCase() === "sleeping") sleeping.add(mid);
    }
    this._arbiter.syncSleeping(sleeping);
    this._lastSleepProbe = this._now();
  }

  /**
   * Admit a WAKE: the child is reserved but idle-unloaded, and the very next request makes
   * the router reload its weights — a reallocation that reaches the card through no load path
   * and so was never admitted by anything (the second half of the sleeping-child defect). Make
   * room for what it takes back BEFORE that request goes out, then book the memory
   * immediately so the gap between making room and the router filling it can't be claimed by a
   * co-tenant.
   *
   * Runs on the CALLER's flow (dispatch's ensure) and holds NO `_routerLock` — `makeRoom` is
   * the foreign-caller path by design, and each victim dies through its own registered
   * evictor.
   *
   * When nothing is evictable we PROCEED with a warning rather than throw, and the choice is
   * deliberate: throwing here would abort the request, so the practical effect is that every
   * AI feature fails for as long as a render holds the TTS engine busy — never-evict-busy
   * protecting the render by breaking everything else. Proceeding costs a spell of two models
   * on one card, which the engine's own CPU offload absorbs, and it ends when the render does.
   */
  async _admitWake(modelId) {
    const arb = this._arbiter;
    const want = arb.reservedMb(modelId) || 0;
    if (want <= 0) return;
    const hw = this._hardwareFn();
    const made = await arb.makeRoom(want, {
      exclude: modelId,
      hardware: hw,
      reason: `waking ${modelId}`,
      selfKind: "llm",
      selfEvict: (k) => this._evictResident(k),
    });
    if (!made) {
      log.warning(
        `wake ${modelId}: could not free ${want} MB — nothing evictable; the child reloads over budget and the engine's own offload decides`,
      );
    }
    arb.markAwake(modelId);
  }

  /** True when `modelId` is resident AND its router child is loaded|sleeping — i.e. the
   * internal load reached `running` (set ONLY after `_confirmLoad` saw the router report
   * loaded|sleeping) and the router is still alive. Drives ensureModelReady's already-ready
   * fast path and its poll-success test. */
  _residentReady(modelId) {
    const st = this._resident.get(modelId);
    if (st == null || st.status !== "running") return false;
    const router = this._router;
    return router != null && router.isAlive();
  }

  /**
   * Wait until `modelId` is resident (loaded|sleeping), driving the SAME load path
   * `ensureEmbedding` uses — download-if-needed + lazy-spawn the router + reserve — differing
   * only in that this WAITS for the child instead of returning immediately. The server-side
   * twin of the kit's ensure-embedding, so a LOCAL chat/feature/Lab run no longer dies with
   * "Connection refused" when the built-in router/model isn't up yet (QC-43b).
   *
   * Falsy id → immediate no-op (the caller resolved to a non-local / empty model). Already
   * resident+ready → immediate return, no reload. Throws RuntimeError on a failed/error load
   * or when the model isn't ready within `timeoutS`. The load runs as the service's own
   * background task, whose `_resident` state this polls every ~1 s through the injected clock.
   * (`timeoutS` may also be passed as `{timeoutS}`.)
   */
  async ensureModelReady(modelId, timeoutS = 180.0) {
    if (timeoutS != null && typeof timeoutS === "object") timeoutS = timeoutS.timeoutS ?? 180.0;
    if (!modelId) return;
    if (this._residentReady(modelId)) {
      // …but "resident" is not "holding memory". A child the router idle-unloaded reloads its
      // weights on the request we are about to send, through no load path — so the fast
      // return here was the moment the wake escaped admission entirely (2026-08-15).
      // Reconcile first (the flag is only as fresh as the last probe), then make room for what
      // it takes back.
      await this.reconcileSleeping();
      if (this._arbiter.isAsleep(modelId)) await this._admitWake(modelId);
      return;
    }
    // Defect D (2026-07-22 pass-1 plan T4): an EXPLICIT stop outranks a zombie request. The
    // 07:00 incident: the bench client died mid-chat, its server-side dispatch kept retrying,
    // and every user stop was answered ten seconds later by this ensure re-loading a 21 GB
    // model. Inside the tombstone window the ensure REFUSES instead — the user starts the model
    // again from the app if they meant to (any direct load() clears the stamp).
    const ts = this._stopTombstones.get(modelId);
    if (ts !== undefined && this._now() - ts < _STOP_TOMBSTONE_S) {
      throw new RuntimeError(`the local model "${modelId}" was just stopped — start it again from the app to use it`);
    }
    // Same path ensureEmbedding uses: download-if-needed + lazy-spawn the router + reserve,
    // on the background load task. A re-load of an already-in-flight / running model is
    // idempotent inside load() (and its router-liveness gate respawns a dead router), so this
    // is safe whatever state the model is in. This is THE auto-load a manual Unload races
    // (2026-07-17): any pending local AI run re-loads its model here, by design — the trigger
    // names it in the log.
    await this.load(modelId, { trigger: "ensure-ready" });
    const deadline = this._now() + timeoutS;
    for (;;) {
      if (this._residentReady(modelId)) return;
      const st = this._resident.get(modelId) || {};
      if (st.status === "error") {
        throw new RuntimeError(`The local model "${modelId}" failed to load: ${st.error || "unknown error"}`);
      }
      if (this._now() >= deadline) {
        throw new RuntimeError(`Timed out preparing the local model "${modelId}" after ${Math.trunc(timeoutS)}s.`);
      }
      await this._sleep(this._loadPollInterval);
    }
  }

  // ── internals ─────────────────────────────────────────────────────────

  /** The quant's GGUF in a snapshot. Word-bounded quant match (the ONE `_quantMatches` rule,
   * shared with selectFiles/cachedGgufPath) — a plain substring would resolve quant "Q2_0" to
   * a co-cached "…-PQ2_0.gguf" (sorts first) and load the WRONG file. Uses no `this`. */
  _mainGguf(snapshotDir, quant) {
    const cands = sortedPaths(rglobSuffix(String(snapshotDir), ".gguf").filter((p) => models._quantMatches(quant, path.basename(p))));
    if (!cands.length) throw new FileNotFoundError(`no .gguf for quant ${pyRepr(quant)} in ${snapshotDir}`);
    return cands[0]; // first shard of a split model loads the rest
  }

  /** The on-disk path of a model's declared MTP draft file, or null when not downloaded —
   * the acquire-free sibling of the `_runLoad` draft acquire (the snapshot preserves the
   * draft's relative path, so an exact join per snapshot dir suffices; no name matching).
   * Uses no `this` (Python's staticmethod). */
  _cachedDraftPath(model, hfCache) {
    const repo = model.mtpDraftRepo || model.hfRepo;
    const snaps = path.join(String(hfCache), `models--${String(repo).replaceAll("/", "--")}`, "snapshots");
    if (!isDir(snaps)) return null;
    let names;
    try {
      names = readdirSync(snaps);
    } catch {
      return null;
    }
    for (const snap of sortedPaths(names.map((n) => path.join(snaps, n)))) {
      const p = path.join(snap, model.mtpDraftFile);
      if (existsSync(p)) return p;
    }
    return null;
  }

  /**
   * THE draft-GGUF fetch: acquire ONE draft by exact path, resolve where it landed.
   *
   * The single body behind BOTH consumers — `_acquireAndIdentify`'s configured-draft leg
   * (load + download) and the auto-tune sweep's A/B trials, which measure alternates the
   * catalog row does not name. It owns the whole rule, not just the `_acquireModel` call: the
   * file path is its own selector, the snapshot preserves relative paths so an exact join
   * resolves it, and a snapshot that lacks the file after a fetch is FAIL-LOUD (never a silent
   * drop to no-MTP — the user asked for MTP). Downloads into the normal HF cache, so
   * delete-model-cache / Reclaim disk semantics are unchanged.
   */
  async acquireDraftFile(repo, file, { cancelCheck = null, onProgress = null } = {}) {
    const cancelKw = cancelCheck != null ? { cancelCheck } : {};
    const snapshot = await this._acquireModel(repo, file, null, {
      cacheRoot: path.join(this._cacheRoot, "hf"),
      onProgress,
      ...cancelKw,
      ...downloadKwargs(this._configFn()),
    });
    const p = path.join(String(snapshot), file);
    if (!existsSync(p)) throw new FileNotFoundError(`MTP draft downloaded but not found in the snapshot: ${pyRepr(file)}`);
    return p;
  }

  /**
   * `[draftMeta, draftBytes]` for `computeFit` when the resolved config pins a draft GGUF
   * path, else `[null, 0]` — THE one reader shared by the three fit sites (active load · `.ini`
   * emit · `previewFit`), so a draft's VRAM can never be counted by one and missed by another
   * (2026-07-19). Keyed on `ov.modelDraft`, which each site has already resolved to a real
   * on-disk path. Best-effort: an unreadable header yields no term rather than failing the
   * caller — the load path's own fail-loud acquire covers a genuinely missing draft, and the
   * spawn OOM back-off remains the safety net.
   */
  _draftFitInputs(ov) {
    const p = ov?.modelDraft || "";
    if (!p) return [null, 0];
    try {
      return [this._readMeta(String(p)), gguf.ggufTotalBytes(String(p))];
    } catch (e) {
      log.warning(`draft header read failed for ${pyRepr(p)} — its VRAM is not charged to the fit`, e);
      return [null, 0];
    }
  }

  /**
   * Is this catalog model FULLY downloaded — main weights AND, when the resolved config wants
   * an external MTP draft, the draft too? THE catalog badge's source of truth (replaces a raw
   * `isCached`, which saw only the main weights and so read "Downloaded ✓" for an MTP model
   * still missing its draft). Called per row per /models poll — switch resolution here is pure
   * DB reads (`_switchesFn`), acceptable at catalog scale.
   */
  modelDownloaded(m, hfCache) {
    if (!models.isCached(m.hfRepo, m.quant, { cacheRoot: String(hfCache), mmproj: m.mmproj ?? null })) return false;
    const ov = _switchesToOverrides(this._switchesFn(m.id) || {});
    return !_wantsDraft(ov, m) || this._cachedDraftPath(m, hfCache) != null;
  }

  /** Per-load log file — the real spawn creates the dir + copies the merged stdout/stderr
   * here (tailed on failure + by `engineLog`). */
  _runnerLogPath(modelId) {
    const safe = [...String(modelId)]
      .map((c) => (/^[\p{L}\p{N}]$/u.test(c) || "-_.".includes(c) ? c : "_"))
      .slice(0, 60)
      .join("");
    return path.join(this._runtimeRoot, "logs", `runner-${safe}-${stamp()}.log`);
  }

  /** The router's merged stdout/stderr log (tailed on a failed spawn + by `engineLog`; a
   * child's CUDA-OOM abort typically surfaces here). */
  _routerLogPath() {
    return path.join(this._runtimeRoot, "logs", `router-${stamp()}.log`);
  }

  async _runInstall(force, replaceBuild = "", gpu = "") {
    try {
      const config = this._configFn();
      const hw = this._hardwareFn();
      // The launch flags THIS build must accept before it may replace a working engine
      // (2026-09-19: b10875 removed two we emit on every model). The build being installed is
      // the pin — the dest dir is named for it.
      const probes = processMod.probeArgvs(config.llamacpp.pinnedBuild);
      const progress = (downloaded, total) => {
        this._engineState.downloaded = downloaded;
        this._engineState.total = total || 0;
      };
      const cancelCheck = () => this._engineCancel.isSet();

      // Backend switch/add (2026-07-14): install ONE specific variant into the pinned build
      // for the acceleration-backend selector — a targeted ADD, NOT a full (re)install. No
      // force-wipe, no stale-build sweep, so a working backend (and the other coexisting
      // variants) is never disturbed while the user tries another. `gpu` is a FAMILY
      // ("cuda"/"vulkan"); resolve it to this box's concrete asset key first.
      if (gpu) {
        const concrete = binary.concreteGpu(hw, gpu);
        this._engineState.detail = `${concrete || gpu} engine build`;
        await this._acquireBinary(this.cacheRoot, config, hw, {
          onProgress: progress,
          gpu: concrete,
          cancelCheck,
          probeArgvs: probes,
        });
        this._engineState = engineInstalled();
        return;
      }

      // NO pre-delete of the live build on force (2026-07-21): acquireBinary stages the
      // download, launch-verifies it, and only ATOMICALLY swaps it in on success — so a
      // failed/broken update can no longer wipe a working engine and strand the box on a build
      // that won't launch. `force` makes it re-fetch even when a variant exists.
      await this._acquireBinary(this.cacheRoot, config, hw, {
        onProgress: progress,
        cancelCheck,
        force,
        probeArgvs: probes,
      });
      // A3-REVISED (user, 2026-07-07: "you are downloading cpu version when i have nvidia
      // card, we do not even use cpu version"): the CPU build is NO LONGER pre-downloaded as a
      // universal fallback. The A3 spawn retry chain simply degrades to fewer local
      // candidates. The one KEPT extra is Vulkan on a ROCm pick (AMD's rocm→vulkan fallback is
      // real). BEST-EFFORT: a failed extra never fails the install — the selected build above
      // is the one that gates "installed".
      const selected = binary.selectBinary(config, hw);
      const extras = [];
      if (selected != null && selected.gpu === "rocm") extras.push("vulkan");
      for (const extra of extras) {
        try {
          this._engineState.detail = `fallback build (${extra})`;
          await this._acquireBinary(this.cacheRoot, config, hw, {
            onProgress: progress,
            gpu: extra,
            cancelCheck,
            probeArgvs: probes,
          });
        } catch (e) {
          if (e instanceof DownloadCancelled) throw e; // a user cancel aborts the whole install
          log.warning(`fallback build ${extra} failed to install (spawn chain will have fewer candidates)`, e);
        }
      }
      // An UPDATE replaces the old build (user, 2026-07-07) — generalized to EVERY stale build
      // dir (a DB reset can re-pin an older build and strand folders): after the new build is
      // fully in place, every OTHER build dir under llamacpp/ is removed ("logs" and loose
      // files — the app's generated models.ini sibling — are never touched). A hand-maintained
      // models.ini living INSIDE a removed build dir (the manual-router layout) is carried into
      // the new build dir first; `replaceBuild` (the update's superseded pin) has carry
      // priority. STOP-FIRST (the uninstall precedent: a live llama-server holds its exe open,
      // and Windows cannot delete an open exe) — an engine swap wants the router respawned on
      // the NEW build anyway (it respawns lazily at the next load). BEST-EFFORT: cleanup never
      // fails a completed install.
      const root = path.join(this.cacheRoot, "llamacpp");
      const keep = new Set([config.llamacpp.pinnedBuild, "logs"]);
      const stale = isDir(root) ? childDirs(root).filter((d) => !keep.has(path.basename(d))) : [];
      if (stale.length) {
        try {
          this._engineState.detail = "removing old builds";
          await this.stop(); // free exe locks; the router respawns on the new build at the next load
          const newDir = binary.binaryDir(this.cacheRoot, config.llamacpp.pinnedBuild);
          if (!isFile(path.join(newDir, "models.ini"))) {
            const candidates = sortedPaths(stale, true); // newest build name first
            if (replaceBuild) {
              const pref = binary.binaryDir(this.cacheRoot, replaceBuild);
              const i = candidates.findIndex((c) => samePathKey(c, pref));
              if (i >= 0) {
                candidates.splice(i, 1);
                candidates.unshift(pref);
              }
            }
            for (const d of candidates) {
              const ini = path.join(d, "models.ini");
              if (isFile(ini)) {
                this._engineState.detail = "carrying models.ini over";
                copy2(ini, path.join(newDir, "models.ini"));
                break;
              }
            }
          }
          for (const d of stale) {
            this._engineState.detail = `removing old build ${path.basename(d)}`;
            // Same robust delete as uninstall (ONE source): a just-superseded build's exe/DLL
            // can stay locked for a moment on Windows after the router exits. Retry the lock
            // lag; only a genuine survivor warns. Best-effort.
            if (!(await self._rmtreeWithRetry(d))) {
              log.warning(`old engine build ${path.basename(d)} still present after cleanup (files in use?)`);
            }
          }
        } catch (e) {
          log.warning("old engine build cleanup failed", e); // best-effort, never install-fatal
        }
      }
      // #138 (user screenshot, 2026-07-07): a load attempted BEFORE the engine existed parks
      // that model at status=error ("Install the engine first"), and nothing cleared it when
      // the install completed — the grid kept the red "install engine ↑" (and hid the row's
      // Unload) on a working box. Drop error-status entries now: they were attempts under a
      // missing/old engine; the next use retries fresh.
      const staleErrors = await this._routerLock.run(async () => {
        const errs = [...this._resident].filter(([, st]) => st.status === "error").map(([mid]) => mid);
        for (const mid of errs) {
          this._resident.delete(mid);
          this._arbiter.release(mid);
        }
        return errs;
      });
      if (staleErrors.length) log.info(`engine install: cleared ${staleErrors.length} stale model error state(s)`);
      this._engineState = engineInstalled();
    } catch (exc) {
      if (exc instanceof DownloadCancelled) {
        // A user cancel is not an error — restore the not-installed idle state. The partial
        // archive stays on disk, but a FRESH install re-fetches from the start (no cross-call
        // resume). Mirrors _runDownload's cancel handling.
        log.info("engine install cancelled");
        this._engineState = _engineIdle();
      } else {
        log.exception("engine install failed", exc); // any failure becomes error state
        this._engineState = { status: "error", detail: "", error: errText(exc), downloaded: 0, total: 0 };
      }
    }
  }

  /**
   * Shared download IO for load + download (ONE source, main + draft): resolve the catalog
   * model, fetch its GGUF into the cache, ground the catalog `type` (moe|dense) from the file,
   * and — when `_wantsDraft(overrides, model)` — fetch the model's EXTERNAL MTP draft too via
   * the SAME acquire path, so download and load pull the identical bytes ("Downloaded ✓" is
   * honest; first load never surprise-fetches). Resolves [model, ggufPath, draftPath|null];
   * throws ValueError for an unknown model. `onProgress(downloaded, total)` reports main-weight
   * bytes to the CALLER's channel; `onProgressDraft` the draft leg's; `resetProgress`
   * (optional) zeroes the neutral phase between the two legs. `cancelCheck` is polled per
   * chunk on BOTH legs → throws DownloadCancelled (the two callers pass DIFFERENT cancel
   * tokens).
   */
  async _acquireAndIdentify(
    modelId,
    onProgress,
    cancelCheck = null,
    { overrides = null, onProgressDraft = null, resetProgress = null, skipIfCached = false } = {},
  ) {
    // The downloadable catalog is HOST-OWNED (DB-backed via .catalog()).
    const model = this.catalog().find((m) => m.id === modelId) ?? null;
    if (model == null) throw new ValueError(`unknown model ${pyRepr(modelId)}`);

    // FAST PATH (2026-07-21, LOAD only — the user's "don't rerun what we don't have to"): the
    // weights are already on disk → skip the HF resolve (selectFiles' two API round-trips:
    // revision-sha + tree) AND the download. The load never needs their output — the GGUF is
    // resolved by _mainGguf's on-disk walk and the router .ini takes the ABSOLUTE path. Gated
    // to the LOAD via `skipIfCached`; the DOWNLOAD endpoint always does the full acquire.
    // The gate matches the "Downloaded ✓" badge's OWN parts (cachedGgufPath + the draft
    // check) so the two can never disagree; _verifyGguf below stays the integrity gate — a
    // corrupt/partial cache still fails loud → purge → re-download.
    if (skipIfCached) {
      const hfCache = path.join(this._cacheRoot, "hf");
      const wantsDraft = _wantsDraft(overrides, model);
      const cachedGguf = models.cachedGgufPath(model.hfRepo, model.quant, { cacheRoot: hfCache, mmproj: model.mmproj ?? null });
      const cachedDraft = wantsDraft ? this._cachedDraftPath(model, hfCache) : null;
      if (cachedGguf != null && (!wantsDraft || cachedDraft != null)) {
        await this._verifyGguf(model, cachedGguf);
        try {
          await this._identifyFn(modelId, cachedGguf);
        } catch (e) {
          log.warning(`model type auto-detect failed for ${modelId}`, e); // identification is advisory only
        }
        return [model, cachedGguf, wantsDraft ? cachedDraft : null];
      }
    }

    // Pass cancelCheck ONLY when supplied (the download-only path) so the load path's call
    // signature is unchanged.
    const cancelKw = cancelCheck != null ? { cancelCheck } : {};
    const snapshot = await this._acquireModel(model.hfRepo, model.quant, model.mmproj ?? null, {
      cacheRoot: path.join(this._cacheRoot, "hf"),
      onProgress,
      ...cancelKw,
      ...downloadKwargs(this._configFn()),
    });
    const ggufPath = this._mainGguf(snapshot, model.quant);
    // Integrity gate (fail-fast): a corrupt / incomplete download is purged + thrown as an
    // actionable CorruptModelError HERE — before _readMeta's raw "bad magic" or a router spawn
    // that would brick the whole upstream. This is the ONE download chokepoint, so it covers
    // BOTH the load (_runLoad) and download-only (_runDownload) channels.
    await this._verifyGguf(model, ggufPath);
    // Best-effort: auto-detect the catalog `type` (moe|dense) from the downloaded GGUF so a
    // user-added model's switch presets are grounded in the file, not a hand-typed guess.
    try {
      await this._identifyFn(modelId, ggufPath);
    } catch (e) {
      log.warning(`model type auto-detect failed for ${modelId}`, e); // identification is advisory only
    }
    // Gemma-style external MTP: the model declares a SEPARATE draft GGUF (catalog mtpDraft*
    // facts). When the resolved config wants draft-mtp and nothing set modelDraft explicitly,
    // fetch it next to the main weights through `acquireDraftFile` — THE one draft-fetch body,
    // shared with the auto-tune sweep's draft A/B so the two cannot drift. A draft failure
    // fails the CALLER with the real reason, never a silent drop to no-MTP.
    let draftPath = null;
    if (_wantsDraft(overrides, model)) {
      // Neutral phase + zeroed counters between the legs (the main model's bytes must not
      // linger under the draft's label); the draft's own phase comes from onProgressDraft,
      // only when it actually downloads (T1: a phase is set by the download itself, never
      // ahead of it).
      if (resetProgress != null) resetProgress();
      draftPath = await this.acquireDraftFile(model.mtpDraftRepo || model.hfRepo, model.mtpDraftFile, {
        cancelCheck,
        onProgress: onProgressDraft,
      });
    }
    return [model, ggufPath, draftPath];
  }

  /** Update a resident model's state IF it still exists — a concurrent stop() may have
   * dropped it, and we must NOT resurrect a cancelled entry. Returns whether the model was
   * present. Used for the out-of-`_routerLock` status writes in `_runLoad`. */
  _touch(modelId, fields) {
    const st = this._resident.get(modelId);
    if (st != null) Object.assign(st, fields);
    return st != null;
  }

  /** Has stop() asked THIS load to cancel? (T2 — the per-load token.) */
  _cancelled(modelId) {
    const ev = this._cancelEvents.get(modelId);
    return ev != null && ev.isSet();
  }

  /**
   * The ONE cancel cleanup (T2's per-exit matrix): pop the ledger entry, release the arbiter
   * reservation, drop the event — idempotent, exactly-once per field. `unloadChild` for the
   * post-spawn checkpoint (the q2 ruling: a child that spawned after the cancel is unloaded
   * SILENTLY; the absent state speaks). A bare return at any checkpoint would wedge a
   * permanent `cancelling` entry — stop() no longer pops for mid-load cancels, the load task
   * must.
   */
  async _cleanupCancelled(modelId, { unloadChild = false } = {}) {
    if (unloadChild) {
      const router = this._router;
      if (router != null && router.isAlive()) {
        try {
          await this._routerUnload(router.url, modelId);
        } catch (e) {
          log.warning(`cancel: unload of just-spawned ${modelId} failed`, e); // the pop below still runs
        }
      }
    }
    this._resident.delete(modelId);
    this._cancelEvents.delete(modelId);
    this._arbiter.release(modelId);
    log.info(`load ${modelId}: cancelled — cleaned up (child_unloaded=${unloadChild ? "True" : "False"})`);
  }

  /** The entry `_resident[modelId]` (Python's KeyError when it is gone). */
  _residentEntry(modelId) {
    const st = this._resident.get(modelId);
    if (st == null) throw new KeyError(pyRepr(modelId));
    return st;
  }

  async _runLoad(modelId, overrides = null, jobId = null, switches = null) {
    try {
      const config = this._configFn();
      const hw = this._hardwareFn();
      const embedIds = keySet(this._embeddingIdsFn()); // the configured local embed(s) → reserve them PINNED (P3)

      // Switch base, UNDER user-supplied overrides (user wins per-field). An optional legacy
      // `jobId` hook can REPLACE the base wholesale; normally there is no job → the model's
      // own base/type (moe|dense) presets. Ad-hoc #20 "Tune & measure" switches win last (an
      // unknown key → extraFlags via the same converter) — the Lab per-load tuning (Option A)
      // rides in `ov`.
      let baseSwitches = jobId ? this._profileSwitchesFn(jobId) : {};
      if (!truthy(baseSwitches)) baseSwitches = this._switchesFn(modelId) || {};
      let ov = _mergeOverrides(_switchesToOverrides(baseSwitches), overrides);
      if (truthy(switches)) ov = _mergeOverrides(ov, _switchesToOverrides(switches));
      // After the FULL merge: backend applicability (Pass 2) then the (b) rule.
      ov = _stripInertMlock(this._applyBackendApplicability(ov));

      const progress = (downloaded, total) => {
        // Live byte counters the GUI polls to draw a bar. The PHASE is set HERE, by the
        // download itself — never ahead of it (T1, 2026-07-17 approved plan): a cached file
        // fires no chunks, so a bar for a download that isn't happening can no longer appear
        // (the user's phantom "Downloading the model" on an already-cached load).
        this._touch(modelId, { detail: "model weights", downloaded, total: total || 0 });
      };
      const progressDraft = (downloaded, total) => {
        // Same rule for the SEPARATE MTP draft leg — its phase only when its bytes actually
        // flow (a cached main + missing draft still shows this).
        this._touch(modelId, { detail: "MTP draft model", downloaded, total: total || 0 });
      };

      // Engine install is its OWN step (POST /engine/install); a model load REQUIRES it
      // present — fail fast BEFORE the multi-GB download.
      const serverExe = this._acquiredExe(this._cacheRoot, config, hw);
      if (serverExe == null) {
        this._touch(modelId, {
          status: "error",
          detail: "Install the engine first",
          error: "engine-not-installed",
          downloaded: 0,
          total: 0,
        });
        return;
      }

      this._touch(modelId, { detail: "preparing", downloaded: 0, total: 0 });
      // True load abort (S2 → T2): a stop() during this (slow, unlocked) download SETS the
      // cancel token, so this cancelCheck flips true and the fetch aborts at the next chunk —
      // throwing DownloadCancelled (caught below). The membership half stays as the belt for
      // the no-id FULL teardown, which clears _resident wholesale and arms no per-model event.
      // ONE acquire path for main + draft (2026-07-19): never a silent drop to no-MTP.
      const [model, ggufPath, draftPath] = await this._acquireAndIdentify(
        modelId,
        progress,
        () => this._cancelled(modelId) || !this._resident.has(modelId),
        {
          overrides: ov,
          onProgressDraft: progressDraft,
          resetProgress: () => this._touch(modelId, { detail: "preparing", downloaded: 0, total: 0 }),
          skipIfCached: true,
        },
      );
      if (draftPath) ov.modelDraft = String(draftPath);

      const meta = this._readMeta(ggufPath);
      // #274 half 2 (2026-07-11): an embed is placed by POLICY (CPU unless the static leftover
      // covers it) BEFORE the fit — never by the child's default.
      this._applyEmbedPlacement(model, ov, meta, hw);
      // The draft (just acquired + pinned above) is GPU-resident alongside the main model —
      // charge its VRAM to the fit, or it silently sheds main layers.
      const [draftMeta, draftBytes] = this._draftFitInputs(ov);
      const fit = processMod.computeFit(meta, gguf.ggufTotalBytes(ggufPath), hw, ov, {
        safetyMarginMb: config.safetyMarginMb,
        ctxCapTokens: config.ctxCapTokens,
        draftMeta,
        draftBytes,
      });
      // 1b fit-by-omission: only tune/preset/request-EXPLICIT placement knobs are emitted; a
      // non-explicit knob is omitted so the child's default `--fit` places tensors at our
      // always-emitted ctx. Tuned boxes render identically to before.
      const entry = new ModelIniEntry({
        modelId,
        ggufPath: String(ggufPath),
        nGpuLayers: fit.nglExplicit ? fit.nGpuLayers : null,
        nCpuMoe: fit.ncmoeExplicit ? fit.nCpuMoe : null,
        ctxLen: fit.ctxLen,
        overrides: ov,
        blockCount: fit.blockCount,
      });

      await this._routerLock.run(async () => {
        // T2 checkpoint 1: a cancel (token) or a full teardown (membership) that landed during
        // the unlocked download phase. Cleanup, never a bare return — stop() no longer pops for
        // mid-load cancels, so a bare return would wedge a permanent "cancelling" entry.
        if (this._cancelled(modelId) || !this._resident.has(modelId)) {
          await this._cleanupCancelled(modelId);
          return;
        }
        // Arbiter admission (P2): evict the LRU non-pinned resident(s) until this model fits
        // the VRAM budget within modelsMax, THEN load. Under the router lock so the eviction
        // serializes with other loads/stops. The reservation is recorded at admission
        // (computed) and TRUED-UP to the measured used-VRAM delta after the confirmed load;
        // failure and cancel paths release, so the ledger never KEEPS a non-resident model.
        // Pins mirror the LIVE routing default (2026-07-12): a load-time pin goes stale when
        // the default moves — re-sync before every admission, and make replaced embeds the
        // PREFERRED victims (the embed slot swaps; the chat model never pays for an embed
        // switch).
        this._arbiter.syncPins(embedIds);
        const embedRows = new Set(
          this.catalog()
            .filter((m) => m.embedding)
            .map((m) => m.id),
        );
        const staleEmbeds = new Set(
          [...this._resident.keys()].filter((mid) => embedRows.has(mid) && !embedIds.has(mid) && mid !== modelId),
        );
        // T2 checkpoint 2 — IMMEDIATELY before _admit, not only at the lock entry: `catalog()`
        // above is a DB round-trip, so a cancel can land between the two, and _admit EVICTS
        // other residents to make room — a cancelled load must never cost the user a model
        // they were using. Adjacency is the guarantee.
        if (this._cancelled(modelId)) {
          await this._cleanupCancelled(modelId);
          return;
        }
        await this._admit(modelId, fit.vramMb, config.modelsMax, hw, {
          nglExplicit: fit.nglExplicit,
          isMoe: fit.isMoe,
          staleEmbedIds: staleEmbeds,
        });
        Object.assign(this._residentEntry(modelId), {
          status: "starting",
          detail: "loading into VRAM",
          downloaded: 0,
          total: 0,
        });
        // Book EARLY (2026-08-14, the admission→booking gap): between admission and the
        // post-load true-up the child allocates for seconds while the ledger shows the memory
        // as free — a concurrent FOREIGN load (a JV speech engine; their loads don't share the
        // router lock) could admit into it. Reserve the fit's computed number now; the true-up
        // below REPLACES it (reserve is an upsert) and every failure/cancel path releases.
        const earlyCap = hardware.budgetTotalMb(hw);
        this._arbiter.reserve(modelId, earlyCap > 0 ? Math.min(fit.vramMb, earlyCap) : fit.vramMb, {
          pinned: embedIds.has(modelId),
          kind: "llm",
          evictFn: () => this._evictFromArbiter(modelId),
          source: "computed",
        });
        const vramBefore = await this._probeUsedVram();
        await this._loadViaRouter(entry, fit, serverExe, config);
        // T2 checkpoint 3: the router op itself is not interruptible — a cancel that landed
        // while the child was spawning takes effect HERE: unload the child we just spawned,
        // SILENTLY (the user's q2 ruling — the absent state speaks), release, and never reach
        // reserve/running.
        if (this._cancelled(modelId)) {
          await this._cleanupCancelled(modelId, { unloadChild: true });
          return;
        }
        // Pin the configured embed so it is NEVER the LRU eviction victim (P3). A chat model
        // reserves unpinned. kind + evictFn (2026-08-09 seam): a foreign-kind admission (a JV
        // TTS load) evicts this model through makeRoom → _evictFromArbiter, which takes the
        // router lock itself.
        const [truedMb, truedSrc] = await this._truedUpVramMb(fit.vramMb, vramBefore, hw);
        this._arbiter.reserve(modelId, truedMb, {
          pinned: embedIds.has(modelId),
          kind: "llm",
          evictFn: () => this._evictFromArbiter(modelId),
          source: truedSrc,
        });
        // Phase 5 (§6.3): persist the confirmed load's footprint as a source='load'
        // measurement row (switches = the fingerprint raw material), and — when the true-up
        // really measured — the observed per-backend overhead as a machine row.
        await this._persistLoadFootprint(modelId, truedMb, truedSrc, fit, ov, hw, config);
        Object.assign(this._residentEntry(modelId), {
          status: "running",
          url: this._router.url,
          detail: "",
          error: "",
          downloaded: 0,
          total: 0,
        });
      });
    } catch (exc) {
      if (exc instanceof DownloadCancelled) {
        // A stop() during the download aborted the fetch (S2 → T2). Under the token design
        // stop() no longer pops the entry (it sits at "cancelling") — the cleanup is OURS. Never
        // an error state (a user-requested stop must not read as a failure).
        log.info(`runner load cancelled during download for ${modelId}`);
        await this._cleanupCancelled(modelId);
      } else {
        log.exception("runner load failed", exc);
        // A concurrent stop() may have cancelled + removed the model — don't resurrect it.
        this._touch(modelId, { status: "error", detail: "", error: errText(exc), downloaded: 0, total: 0 });
        this._arbiter.release(modelId); // never leak a reservation on a failed/cancelled load
      }
    } finally {
      // The token dies with its load, every path (the cancelled paths already popped it —
      // idempotent). load() arms a fresh event; this is the second belt.
      this._cancelEvents.delete(modelId);
    }
  }

  // ── Arbiter admission (P2): co-reside if it fits, else evict the LRU ───────
  //    Called from _runLoad under the router lock.

  /** Snapshot of the used BUDGET-POOL memory (MiB) via the injected probe (`usedVramFn`,
   * default `hardware.usedDeviceMemMb` — Phase 4's backend-aware door). null when
   * unmeasurable or when the probe itself throws — a probe failure must never fail a load. */
  async _probeUsedVram() {
    try {
      const v = await this._usedVramFn();
      return v ?? null;
    } catch {
      return null; // measurement is best-effort, never load-fatal
    }
  }

  /**
   * The VRAM (MiB) to RESERVE for a just-CONFIRMED load: the MEASURED used-VRAM growth across
   * the load, floored at the driver-context constant when the fit claimed GPU use, and capped
   * at the card (one child can never exceed it). Resolves [mb, source].
   *
   * WHY measured-first (INVERTED 2026-07-11; was `max(estimate, measured)`): the fit regression
   * has no `n-cpu-moe` term, so a CPU-offloaded MoE (Gemma 26B at ngl 30 / ncmoe 21 — real
   * footprint ~6.5 GB) estimated ~16 GB; flooring at that estimate wedged the ledger at
   * 19.3/8 GB with 0 free. Measurement is ground truth here — loads serialize under the router
   * lock, so the growth between the snapshots is attributable to THIS load. The under-count
   * cases now degrade to a too-small reservation, which `_admit` handles with a warning + the
   * spawn safety nets — strictly better than a permanently-poisoned ledger. The
   * `_DRIVER_CTX_MB` floor: an ngl-0 CUDA child still holds ~549 MB of driver context and
   * must not book 0 when the fit claimed GPU use. Unmeasurable → the card-capped estimate.
   *
   * ARCH-AWARE cap (Phase 4): the ceiling is the budget POOL. `source` (Phase 5, §13.1):
   * "measured" when a real before/after delta produced the number, "computed" when the probe
   * couldn't measure — so no consumer presents an estimate as live truth.
   */
  async _truedUpVramMb(estimateMb, before, hw = null) {
    const cap = hw != null ? hardware.budgetTotalMb(hw) : 0;
    const est = cap > 0 ? Math.min(estimateMb, cap) : estimateMb;
    const after = await this._probeUsedVram();
    if (before == null || after == null) return [est, "computed"];
    const measured = Math.max(0, after - before);
    const floor = est > 0 ? Math.min(est, _DRIVER_CTX_MB) : 0;
    return [Math.max(measured, floor), "measured"];
  }

  /**
   * The confirmed load's launch config as an UNDERSCORE-canon switch dict — the fingerprint
   * raw material a source='load' row carries (§6.3/§13.3). The fit knobs come from the
   * RESOLVED FitPlan (what actually launched, not what was asked); the rest from the merged
   * Overrides, set fields only. spec/modelDraft ride along so a speculative load is
   * identifiable.
   */
  static _fitConfigSwitches(f, ov) {
    const sw = { n_gpu_layers: pyStr(f.nGpuLayers), n_cpu_moe: pyStr(f.nCpuMoe), ctx_len: pyStr(f.ctxLen) };
    for (const name of [
      "cache_type_k",
      "cache_type_v",
      "flash_attn",
      "no_kv_offload",
      "parallel",
      "batch_size",
      "ubatch_size",
      "mlock",
      "no_mmap",
      "spec_type",
      "model_draft",
    ]) {
      const v = ov?.[FIELD_OF.get(name)];
      // Python's `v not in (None, "", False)` — 0 == False there, so a zero is skipped too.
      if (v == null || v === "" || v === false || v === 0) continue;
      sw[name] = pyStr(v);
    }
    return sw;
  }

  /**
   * Phase 5 (§6.3/§13.2): write the confirmed load's footprint as a source='load'
   * measurement row (vram_model_mb + the launch switches — the fingerprint), and, when the
   * true-up REALLY measured and the load used the device, the observed per-backend overhead
   * as a machine row (`__overhead__`, label stamped with the engine build so a pin bump
   * invalidates old rows by simple non-match). Best-effort: persistence must never fail a
   * load; unwired (standalone/tests) → no-op.
   */
  async _persistLoadFootprint(modelId, truedMb, source, f, ov, hw, config) {
    if (this._recordLoadFn == null) return;
    try {
      const switches = RunnerService._fitConfigSwitches(f, ov);
      await this._recordLoadFn(modelId, {
        vramModelMb: Math.trunc(truedMb),
        switches,
        source: "load",
        label: `load footprint (${source})`,
      });
      if (source === "measured" && f.nGpuLayers > 0 && f.vramMb > 0) {
        const backend = hardware.activeBackend(hw);
        const seed = fitMod.PHYSICS_OVERHEAD_MB[backend] ?? fitMod.PHYSICS_OVERHEAD_MB.cuda;
        // f.vramMb is the physics booking = weights-share + kv-share + the seed overhead; the
        // observed overhead is the measured total minus the physics weights+kv part.
        const observed = Math.max(0.0, truedMb - (f.vramMb - seed));
        // Stamp = the build ON DISK + the physics version (vram-truth plan R2 / §6.5) — the
        // reader matches the same suffix, so a pin bump, an engine swap, or a new byte model
        // each re-learn instead of misapplying.
        const disk = (config != null ? this._installedBuild(config) : null) || (config != null ? config.llamacpp.pinnedBuild : "");
        const build = `${disk} ${fitMod.PHYSICS_VERSION}`;
        await this._recordLoadFn("__overhead__", {
          vramModelMb: Math.trunc(observed),
          switches: {},
          source: "probe",
          label: `physics-overhead ${build}`,
        });
      }
    } catch (e) {
      log.debug(`load-footprint persist failed for ${modelId}: ${errText(e)}`); // best-effort, never load-fatal
    }
  }

  /**
   * The STATIC VRAM leftover an embedding child may claim: card total minus the LOCAL chat
   * default's claim. Static — NOT live free VRAM — because the ask flow loads the embed BEFORE
   * the chat model; a live reading would see an empty card, place the embed on GPU, and the
   * chat load then can't fit (the 2026-07-11 co-load crash). Baseline resolution, in order:
   * the routing default's LOCAL chat model's claim; empty (Plan-A boxes route via task presets,
   * the global default stays "") → the largest-claim DOWNLOADED local chat model; nothing
   * downloaded → the whole card. A named default with no catalog row → 0 (conservative: the
   * chat model is the primary workload).
   *
   * The chat baseline CONSUMES THE CLAIM RESOLVER since Phase 5 (§6.6): a resident chat
   * model's TRUE booked footprint, else a fingerprint-matched measured footprint, else the
   * physics booking, else the declared want (estVramMb over minVramMb — understating the chat
   * claim re-opens the 2026-07-11 co-load crash). POLICY is unchanged: chat-first,
   * static-not-live.
   */
  _embedGpuLeftoverMb(hw) {
    const card = hardware.maxVramMb(hw);
    if (card <= 0) return 0;
    let chatId;
    try {
      chatId = this._defaultLlmIdFn() || "";
    } catch {
      chatId = ""; // a routing-store hiccup must never kill a load
    }
    const chatClaim = (m) => {
      const rec = m.recommendedFor || {};
      return rec.estVramMb || rec.minVramMb || 0;
    };
    if (chatId) {
      const row = this.catalog().find((m) => m.id === chatId);
      if (row == null) return 0;
      let claim;
      try {
        claim = pyInt(this._resolveClaim(row).vramMb || 0);
      } catch {
        claim = chatClaim(row); // a resolver hiccup falls to the declared chain
      }
      return claim > 0 ? Math.max(0, card - claim) : 0;
    }
    const hf = path.join(this._cacheRoot, "hf");
    const claims = this.catalog()
      .filter(
        (m) =>
          !m.embedding &&
          chatClaim(m) > 0 &&
          models.cachedGgufPath(m.hfRepo, m.quant, { cacheRoot: hf, mmproj: m.mmproj ?? null }) != null,
      )
      .map(chatClaim);
    if (!claims.length) return card;
    return Math.max(0, card - Math.max(...claims));
  }

  /**
   * #274's missing half — the embed CPU-placement GUARANTEE. The pick rule (ui
   * modelPick.pickBestEmbedId) chooses WHICH embed rides a box assuming small embeds run on
   * CPU; nothing enforced it at load time, so llama.cpp's default placement put the whole
   * embed (weights + a 32k KV pool) on the GPU beside the chat model (the 2026-07-11
   * incident). Rules, first match wins; an EXPLICIT tune ngl always wins over the policy:
   *   * ctx: capped at min(trained, _EMBED_CTX_CAP) unless a tune set it;
   *   * tier "cpu" → ngl 0 (the ROUND-4 law: deliberately CPU on the user's box);
   *   * curated floor fits the static leftover → GPU (the fit places it);
   *   * otherwise (including no curated floor) → ngl 0.
   * ngl 0 is set as an EXPLICIT override so the `.ini` emits `n-gpu-layers = 0` —
   * fit-by-omission would hand placement back to the child's GPU-greedy `--fit`.
   */
  _applyEmbedPlacement(model, ov, meta, hw) {
    if (!model?.embedding) return;
    if (!ov.ctxLen) {
      const trained = pyInt(meta?.contextLength || 0);
      ov.ctxLen = trained > 0 ? Math.min(trained, _EMBED_CTX_CAP) : _EMBED_CTX_CAP;
    }
    if (ov.nGpuLayers != null) return;
    const [placement] = this.embedPlacement(model, hw);
    if (placement !== "gpu") ov.nGpuLayers = 0;
  }

  /**
   * Where the POLICY puts this embedding model on this box — ["cpu"|"gpu", static leftover
   * MB]. THE one source (2026-07-25): the load-time enforcement (`_applyEmbedPlacement`) and
   * the models-endpoint display both read this, so the catalog badge can never promise a
   * placement the loader then refuses. tier "cpu" never claims the GPU (the ROUND-4 law);
   * anything else only when its curated floor fits the static leftover beside the chat
   * default. An explicit tune ngl still overrides at load time — the power-user escape.
   */
  embedPlacement(model, hw) {
    const left = this._embedGpuLeftoverMb(hw);
    if ((model?.tier || "") === "cpu") return ["cpu", left];
    const rec = model?.recommendedFor;
    const need = (rec != null ? rec.minVramMb : null) || 0;
    return [need > 0 && need <= left ? "gpu" : "cpu", left];
  }

  /**
   * Make room for a load: evict the LRU non-pinned resident(s) until `modelId` fits the VRAM
   * budget AND the llm child count is under `modelsMax`. Accounts for `modelId`'s OWN prior
   * reservation (a re-tune replaces it, doesn't add) and never evicts `modelId`.
   *
   * Built ONTO the arbiter's shared `makeRoom` (2026-08-09 seam): the VRAM-fit phase runs the
   * one policy home, so a foreign-kind resident (a JV TTS engine) is evicted through ITS
   * registered evictor — never a router unload of a key the router doesn't own — and BUSY
   * kinds are protected (never-evict-busy, which also closes the old same-kind hole: loading
   * LLM B can no longer evict mid-stream LLM A). The replaced-embed preference and the count
   * cap stay HERE — both are runner-only concerns, and the count is llm-scoped (P5-3: a
   * resident TTS engine must not eat a child slot).
   *
   * When nothing is evictable and it still doesn't fit: a DENSE entry with an EXPLICIT ngl is
   * REFUSED with an actionable error (2026-07-11) — the child's `--fit` auto-placement ABORTS
   * on a user-set ngl, so there is NO safety net and the spawn dies. Everything else PROCEEDS
   * with a warning — a MoE's fit estimate over-books, so refusing on it would block loads that
   * actually fit; a fit-placed entry keeps the child's auto-offload as its net. The caller
   * holds the router lock (makeRoom's evictor re-enters it); `hw` is passed in (already
   * detected) so the arbiter doesn't re-run nvidia-smi per loop.
   */
  async _admit(modelId, vramMb, modelsMax, hw, { nglExplicit = false, isMoe = false, staleEmbedIds = null } = {}) {
    const arb = this._arbiter;
    // The ledger must not be pricing against sleepers' phantom bookings (2026-08-15): a child
    // the router idle-unloaded holds nothing, and counting it here refuses loads that fit.
    // `force` because an admission is exactly the moment a stale reading is worth the one
    // local GET.
    await this.reconcileSleeping({ force: true });
    const own = arb.reservedMb(modelId) || 0; // freeing our own reservation adds this back to the budget
    // MEASURED admission (2026-08-14, the user's ruling: "how can we possibly get the fit
    // correct ... if we dont take into account what is really available"). The ledger knows
    // only what WE placed, so on a card holding 2 GB of browser/compositor it reported the
    // full 8 GB free and admitted into memory that did not exist. `foreign` is everyone else's
    // usage — measured once, HERE, then carried as a constant offset.
    //
    // Probed ONCE at entry, never per iteration: evicted VRAM drains asynchronously, so a
    // measured re-check inside the eviction loops would see the number unmoved and keep killing
    // residents (the over-evict trap). The loops below stay pure LEDGER arithmetic — which
    // updates the instant a reservation is released — with `foreign` added to what we must
    // fit. Unmeasurable box (null) → foreign 0 → byte-identical to the pre-2026-08-14
    // behaviour.
    let foreign = 0;
    let measuredUsed = null;
    try {
      measuredUsed = await hardware.usedPoolMb({ fresh: true });
      if (measuredUsed != null) {
        const total = pyInt(hardware.budgetTotalMb(hw));
        if (total > 0) {
          const committed = Math.max(0, total - (await arb.remainingMb(hw)));
          foreign = Math.max(0, measuredUsed - committed);
        }
      }
    } catch (e) {
      log.debug(`used-memory probe failed; admitting on the ledger alone: ${errText(e)}`); // a probe must never block a load
    }
    if (foreign > 0) {
      log.info(
        `admission ${modelId}: ${foreign} MB held by processes we do not manage (measured ${measuredUsed} MB used) — added to the fit target`,
      );
    }

    const fits = async () => vramMb + foreign <= (await arb.remainingMb(hw)) + own;
    const nOthers = () => arb.count("llm") - (arb.isReserved(modelId) ? 1 : 0);

    // Phase A — a REPLACED embed (resident but no longer the routing default) goes FIRST under
    // ANY constraint: dead weight; the embed slot swaps (2026-07-12).
    while (truthy(staleEmbedIds) && !((await fits()) && nOthers() < modelsMax)) {
      const victim = arb.pickEvict({ exclude: modelId, minMb: 0, among: staleEmbedIds });
      if (victim == null) break;
      log.info(`arbiter: evict replaced embed ${victim} to make room for ${modelId}`);
      await this._evictResident(victim);
      arb.recordEviction(victim, "llm", `replaced embedding model (loading ${modelId})`);
    }

    // Phase B — the count cap, llm-scoped: only the runner's own children count, and only they
    // are count-cap victims (minMb 0 — a child must go regardless). Busy wins over the cap
    // (never-evict-busy): a mid-stream child is untouchable, so the load proceeds over
    // modelsMax and idle-sleep trims the excess later.
    while (nOthers() >= modelsMax) {
      if (arb.busyKinds().has("llm")) {
        log.warning("arbiter: models_max reached but llm is busy — proceeding over the cap (never-evict-busy)");
        break;
      }
      const victim = arb.pickEvict({ exclude: modelId, minMb: 0, kind: "llm" });
      if (victim == null) break;
      log.info(`arbiter: evict LRU ${victim} (models_max) to make room for ${modelId}`);
      await this._evictResident(victim);
      arb.recordEviction(victim, "llm", `model count cap (loading ${modelId})`);
    }

    // Phase C — the VRAM fit, through the shared policy home. Victims may be ANY kind (an idle
    // TTS engine on a small card); each dies by its own evictor. selfEvict covers llm
    // reservations recorded without an evictFn (tests, pre-seam rows) — the runner knows how
    // to unload its own children.
    const made =
      (await fits()) ||
      (await arb.makeRoom(Math.max(0, vramMb - own) + foreign, {
        exclude: modelId,
        hardware: hw,
        reason: `loading ${modelId}`,
        selfKind: "llm",
        selfEvict: (k) => this._evictResident(k),
      }));
    if (made && foreign > 0 && measuredUsed != null) {
      // Eviction frees device memory ASYNCHRONOUSLY (a terminated child drains over ~a
      // second), so re-measuring immediately reads stale-high. Wait briefly for the card to
      // agree before spawning; if it stays short, proceed — the ledger says there is room and
      // the spawn's own OOM handling is the last net.
      const deadline = this._now() + 4.0;
      while (this._now() < deadline) {
        const u = await hardware.usedPoolMb({ fresh: true });
        if (u == null || Math.max(0, pyInt(hardware.budgetTotalMb(hw)) - u) >= vramMb) break;
        await this._sleep(0.25);
      }
    }
    if (!made) {
      // The message must tell the MEASURED story (2026-08-14): quoting ledger arithmetic under
      // a strip that now shows real occupancy is two-truths-on-one-screen.
      const freeMb = (await arb.remainingMb(hw)) + own - foreign;
      const held = foreign > 0 ? ` (${foreign} MB of the card is held by other programs)` : "";
      if (nglExplicit && !isMoe) {
        const others =
          pySorted([...this._resident.keys()].filter((k) => k !== modelId)).join(", ") || "none";
        throw new RuntimeError(
          `Not enough free VRAM to load ${pyRepr(modelId)}: it needs ~${vramMb} MB but only ` +
            `${Math.max(0, freeMb)} MB are actually free${held}, and the resident models ` +
            `(${others}) are pinned or busy. Close other GPU programs, unload a model, ` +
            "pick a smaller embedding model, or lower this model's GPU layers in its tune.",
        );
      }
      log.warning(
        `arbiter: ${modelId} over budget (needs ${Math.trunc(vramMb)} MB, ${Math.trunc(Math.max(0, freeMb))} MB actually free${held}) with nothing evictable — proceeding; the spawn safety nets decide`,
      );
    }
  }

  /** The evictor `makeRoom` executes for a runner reservation — safe from ANY flow: a JV TTS
   * admission calls it without the router lock (it queues for it); the runner's own `_admit`
   * → `makeRoom` path re-enters the lock it already holds. */
  async _evictFromArbiter(modelId) {
    await this._routerLock.run(() => this._evictResident(modelId));
  }

  /**
   * Unload one co-resident model to free its VRAM for an incoming load: POST /models/unload,
   * drop it from `_resident`, release its arbiter reservation, and re-home `_lastId` if it was
   * the primary. Caller holds the router lock.
   *
   * DECISION — release the reservation on the unload ATTEMPT, not only on a confirmed unload:
   * (1) it guarantees `_admit`'s loop terminates (an un-released victim would keep coming back
   * from `pickEvict`), and (2) a failed unload almost always means the child is ALREADY gone (a
   * 4xx "not loaded" or a router that's down), so releasing is correct. The rare "unload failed
   * but the child is still resident" case under-counts committed VRAM → a possible OOM on the
   * next co-resident load, which the spawn OOM back-off + the build's CPU auto-offload catch.
   */
  async _evictResident(modelId) {
    const router = this._router;
    if (router != null && router.isAlive()) {
      try {
        await this._routerUnload(router.url, modelId);
      } catch (e) {
        log.warning(`arbiter evict: unload ${modelId} failed`, e); // reservation freed on attempt (see above)
      }
    }
    this._resident.delete(modelId);
    this._arbiter.release(modelId);
    if (this._lastId === modelId) this._lastId = firstKey(this._resident);
  }

  // ── Router: emit the .ini from the DB → spawn/bounce → load a model by id ──
  //    All of these assume the caller holds the router lock (they mutate `_router`).

  /**
   * The engine FAMILY the next child will run on ("cuda" | "rocm" | "vulkan" | "metal" |
   * "cpu"; "" unknown) — the same derivation engineStatus uses: the running router's exe
   * matched against the acquired variants, else the variant selectBinary would pick.
   * Best-effort: any failure returns "" (no filtering). SYNC (switch_resolve's seam).
   */
  _activeBackend() {
    try {
      const config = this._configFn();
      const hw = this._hardwareFn();
      const acquired = this._acquiredExes(this.cacheRoot, config, hw);
      let variant = "";
      if (this._activeServerExe) {
        variant = acquired.find(([, e]) => String(e) === String(this._activeServerExe))?.[0] ?? "";
      }
      if (!variant) {
        const asset = binary.selectBinary(config, hw);
        variant = asset ? asset.gpu : "";
        if (!variant && acquired.length) variant = acquired[0][0]; // e.g. a hand-registered variant on disk
      }
      return variant ? binary.gpuFamily(variant) : "";
    } catch {
      return ""; // applicability is best-effort, never load-fatal
    }
  }

  /**
   * Pass 2 (2026-07-22): drop typed launch knobs the ACTIVE engine family can't use — the
   * knob_catalog's `backends` column, host-wired via knobBackendsFn ({flag: "cuda,rocm,…"};
   * absent flag = applies everywhere). A dropped knob is simply OMITTED (fit-by-omission: the
   * child's own default governs), which is what un-applied CUDA tuning should mean on a cpu
   * engine — the 2026-07-22 incident shipped no_mmap/placement flags onto the cpu band's
   * children.
   */
  _applyBackendApplicability(ov) {
    const rules = this._knobBackendsFn ? this._knobBackendsFn() : null;
    if (!truthy(rules)) return ov;
    const backend = this._activeBackend();
    if (!backend) return ov;
    for (const [flag, spec] of rules instanceof Map ? [...rules] : Object.entries(rules)) {
      const allowed = new Set(
        pyStr(spec)
          .split(",")
          .map((p) => strip(p))
          .filter((p) => p),
      );
      const field = FIELD_OF.get(flag);
      if (allowed.size && !allowed.has(backend) && field != null && ov[field] != null) {
        log.info(`knob ${flag} is not applicable on the ${backend} engine — omitting it (backends=${pyStr(spec)})`);
        ov[field] = null;
      }
    }
    return ov;
  }

  /**
   * One `ModelIniEntry` per ON-DISK catalog model, IN CATALOG ORDER (a STABLE `.ini` text so a
   * co-resident load doesn't spuriously bounce — the text only changes when a section's flags
   * actually change). `override` (the model being loaded) REPLACES that model's section IN
   * PLACE so it carries this load's exact fit + any Lab tuning (Option A); the rest are
   * DB-resolved from `switchesFn`. A model whose meta/fit fails is skipped, not fatal to the
   * whole `.ini`.
   */
  _resolveIniEntries(override) {
    const hw = this._hardwareFn();
    const c = this._configFn();
    const margin = c.safetyMarginMb;
    const ctxCap = c.ctxCapTokens;
    const hfCache = path.join(this._cacheRoot, "hf");
    let entries = [];
    const catalog = [...this.catalog()];
    // Defect C (2026-07-22 pass-1 plan T3): prune loaded-with entries for models that left
    // residency — THE one convergence point, so no removal site needs a mirror pop. Caller
    // holds the router lock.
    this._activeEntries = new Map([...this._activeEntries].filter(([k]) => this._resident.has(k)));
    for (const m of catalog) {
      if (override != null && m.id === override.modelId) {
        entries.push(override); // this load's exact section, in the model's slot
        continue;
      }
      const kept = this._activeEntries.get(m.id);
      if (kept != null) {
        // A RESIDENT co-model renders the entry it was LOADED WITH — never a fresh DB
        // derivation, which silently reverted ephemeral launch configs on any later co-load's
        // emit and bounce-respawned the child at the wrong config (defect C: ctx 8192 → tune's
        // 131072 → ~21 GB on CPU).
        entries.push(kept);
        continue;
      }
      const ggufPath = models.cachedGgufPath(m.hfRepo, m.quant, { cacheRoot: hfCache, mmproj: m.mmproj ?? null });
      if (ggufPath == null) continue; // not on disk → no section (a section needs the file for computeFit)
      try {
        const ov = _stripInertMlock(this._applyBackendApplicability(_switchesToOverrides(this._switchesFn(m.id) || {})));
        // Plan B D7 (diff-checker fold): the auto-mtp layer can put `draft-mtp` on a PASSIVE
        // co-resident section too. Point it at the CACHED draft — which Download fetches
        // (2026-07-19 one-acquire change), so it normally is present.
        if (_wantsDraft(ov, m)) {
          const cachedDraft = this._cachedDraftPath(m, hfCache);
          if (cachedDraft != null) {
            ov.modelDraft = String(cachedDraft);
          } else {
            // A CORNER case now (cancelled mid-draft / hand-deleted / a pre-fix download).
            // Strip spec LOUDLY: no network in the ini emitter, and for a DECLARED-DRAFTER
            // model `spec-type = draft-mtp` without a `model-draft` line would hand
            // llama-server a broken preset on a router bounce. (A BUILT-IN-MTP model — no
            // `mtpDraftFile`, e.g. qwen3.6-27b — legitimately runs spec-type with NO
            // model-draft and never reaches this branch.) The first ACTIVE load re-acquires the
            // draft (fail-loud).
            log.warning(
              `model ${m.id} wants MTP (draft-mtp) but its draft ${pyRepr(m.mtpDraftFile)} is not downloaded — MTP is OFF for this router section; Re-download the model to restore it`,
            );
            ov.specType = null;
            ov.specNMax = null;
          }
        }
        const meta = this._readMeta(ggufPath);
        // #274 half 2 — the same embed placement rule as the active-load path, so a PASSIVE
        // section can't hand the embed to the child's GPU default.
        this._applyEmbedPlacement(m, ov, meta, hw);
        // Same draft-VRAM charge as the active-load path: a PASSIVE section that carries
        // `model-draft` holds those bytes too once the router loads it.
        const [draftMeta, draftBytes] = this._draftFitInputs(ov);
        const fit = processMod.computeFit(meta, gguf.ggufTotalBytes(ggufPath), hw, ov, {
          safetyMarginMb: margin,
          ctxCapTokens: ctxCap,
          draftMeta,
          draftBytes,
        });
        // Same 1b fit-by-omission rule as the active-load path.
        entries.push(
          new ModelIniEntry({
            modelId: m.id,
            ggufPath: String(ggufPath),
            nGpuLayers: fit.nglExplicit ? fit.nGpuLayers : null,
            nCpuMoe: fit.ncmoeExplicit ? fit.nCpuMoe : null,
            ctxLen: fit.ctxLen,
            overrides: ov,
            blockCount: fit.blockCount,
          }),
        );
      } catch (e) {
        log.warning(`skipping .ini section for ${m.id} (meta/fit failed)`, e); // keep the rest of the .ini
      }
    }
    // An override for a model NOT in the catalog still gets its own section.
    if (override != null && !entries.some((e) => e.modelId === override.modelId)) entries.unshift(override);
    // Mark EVERY embedding-capable section — not just the routing default (2026-07-12).
    // Marking only the active embed meant switching the default MOVED the `embeddings = true`
    // marker between sections, which changed the .ini TEXT → _bounceRouter → the router
    // reloaded Gemma + the incoming embed AT ONCE, and Gemma's MTP draft then crashed on the
    // simultaneous co-load (bricking the chat). All embed models are embed-ONLY, so marking the
    // idle ones is harmless AND makes the .ini STABLE across an embed-default switch → no
    // bounce. The ACTIVE embed is still selected two ways that don't touch the .ini: the client
    // requests it by model id, and the arbiter PINS it. Applied BY ID in a single post-pass so
    // EVERY emit path gets it. We deliberately do NOT set `load-on-startup`: an idle embed's
    // section must not auto-load (that would be invisible to `_resident`, so a later ensure
    // would re-POST /models/load for an already-loaded id → 400 → error). pooling is INTRINSIC
    // per-model (nomic=mean, qwen3-embedding=last); "" → no `pooling =` line → llama.cpp reads
    // the GGUF's pooling_type (#119). The mark set is the UNION of every catalog `embedding`
    // row AND the routing default (misconfig-safe).
    const embedIds = keySet(this._embeddingIdsFn());
    const embedPooling = new Map(catalog.filter((m) => m.embedding || embedIds.has(m.id)).map((m) => [m.id, m.pooling || ""]));
    if (embedPooling.size) {
      entries = entries.map((e) =>
        embedPooling.has(e.modelId) ? new ModelIniEntry({ ...e, embeddings: true, pooling: embedPooling.get(e.modelId) || "" }) : e,
      );
    }
    return entries;
  }

  /**
   * Write `<runtime>/models.ini` from the on-disk catalog. Returns [path, changed]: `changed`
   * is true only when the rendered text differs from what the running router was started with
   * — the signal to spawn (if down) or bounce (if up). The DB is the source of truth; this
   * `.ini` is GENERATED, never read back.
   *
   * `serverExe` is the exe that will READ the file — some flag spellings depend on its build
   * (`_engineBuildOf`). The file is written as Python's `write_text` wrote it: "\n" becomes
   * "\r\n" on Windows.
   */
  _emitIni(override = null, { serverExe = null } = {}) {
    const entries = this._resolveIniEntries(override);
    const text = processMod.emitModelsIni(entries, { engineBuild: this._engineBuildOf(serverExe) });
    const p = path.join(this._runtimeRoot, "models.ini");
    const changed = text !== this._lastIniText;
    if (changed) {
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, IS_WIN ? text.replace(/\n/g, "\r\n") : text, "utf8");
      this._lastIniText = text;
    }
    return [p, changed];
  }

  /**
   * Spawn the long-lived router from the just-emitted `.ini` (modelsMax + idle-TTL from the DB
   * config). Caller holds the router lock and has emitted the `.ini`. On success the exe
   * becomes the session's PROVEN binary (`_activeServerExe`) — bounces reuse it rather than
   * re-trying a preferred build that failed to launch.
   */
  async _spawnRouter(serverExe, config) {
    const logPath = this._routerLogPath();
    this._lastLogPath = logPath;
    // The port is ALLOCATED here, never assumed: a sibling family app, a stray router from a
    // crashed run, or the user's own llama.cpp may already hold the preferred one, and a
    // health probe cannot tell their server from ours (findFreePort carries the measured
    // incident). Callers must read the live URL off the handle — or `routerUrl()` — not
    // rebuild it from DEFAULT_PORT.
    const port = await this._findPort(DEFAULT_HOST, DEFAULT_PORT);
    if (port !== DEFAULT_PORT) log.info(`engine port ${DEFAULT_PORT} is taken — starting the router on ${port} instead`);
    this._router = await this._startRouter(serverExe, {
      modelsDir: path.join(this._cacheRoot, "hf"),
      modelsPreset: path.join(this._runtimeRoot, "models.ini"),
      modelsMax: config.modelsMax,
      sleepIdleSeconds: config.sleepIdleSeconds,
      host: DEFAULT_HOST,
      port,
      logPath,
    });
    this._activeServerExe = serverExe;
  }

  /**
   * A3: spawn the router, chaining across INSTALLED builds when the preferred binary fails to
   * LAUNCH (bad driver/runtime → `RunnerStartError`, e.g. a CUDA build on a box whose CUDA
   * runtime is broken). Candidates come from `acquiredExes` — builds ALREADY on disk in
   * preference order; a load NEVER downloads an engine (decision A, the 2026-07-02
   * install/load split). Resolves the exe that actually launched. All candidates failing
   * throws ONE `RunnerStartError` aggregating each backend's own reason. Caller holds the
   * router lock.
   */
  async _spawnRouterWithFallback(serverExe, config) {
    const candidates = [["preferred", serverExe]];
    let installed;
    try {
      installed = this._acquiredExes(this._cacheRoot, this._configFn(), this._hardwareFn());
    } catch {
      installed = []; // the probe must never kill the load path
    }
    for (const [gpu, exe] of installed) {
      if (String(exe) !== String(serverExe)) candidates.push([gpu, exe]);
    }
    const errors = [];
    for (let idx = 0; idx < candidates.length; idx++) {
      const [gpu, exe] = candidates[idx];
      try {
        await this._spawnRouter(exe, config);
      } catch (e) {
        if (!(e instanceof RunnerStartError)) throw e;
        errors.push(`[${gpu}] ${errText(e)}`);
        log.warning(`router spawn failed on ${gpu} build (${exe}) — trying next installed backend`);
        continue;
      }
      if (idx > 0) {
        log.warning(`router running on FALLBACK backend ${gpu} (${exe}); the preferred build failed to launch — see the engine log`);
      }
      return exe;
    }
    throw new RunnerStartError(`the engine failed to launch on every installed backend:\n${errors.join("\n")}`);
  }

  /** Restart the router so it re-reads a changed `.ini`, PRESERVING the resident set (reload
   * each previously-running model). Only taken when a re-emitted `.ini` changed while the
   * router was up (a new/tuned section) — the common co-residence path (model already in the
   * `.ini`) never bounces. */
  async _bounceRouter(serverExe, config) {
    const prev = [...this._resident].filter(([, st]) => st.status === "running").map(([mid]) => mid);
    if (this._router != null) {
      try {
        this._router.stop();
      } catch {
        /* best-effort */
      }
      this._router = null;
    }
    await this._spawnRouter(serverExe, config);
    for (const mid of prev) {
      try {
        await this._routerLoad(this._router.url, mid);
      } catch (e) {
        log.warning(`reloading ${mid} after router bounce failed`, e); // keeps its own status
      }
    }
  }

  /** Ensure the router is up with `entry`'s section present, then load the model by id with a
   * router-level OOM back-off. Caller holds the router lock. A fresh spawn goes through the A3
   * fallback chain; once ANY binary is proven (this spawn or an earlier one), that exe is what
   * bounces/backoffs reuse — a broken preferred build is never re-tried mid-session (it would
   * knock down every healthy resident). */
  async _loadViaRouter(entry, fit, serverExe, config) {
    const routerUp = this._router != null && this._router.isAlive();
    // Render for the exe that will actually READ the file: a live router keeps running its
    // PROVEN binary, a down one spawns `serverExe`.
    const effectiveExe = (routerUp ? this._activeServerExe : null) || serverExe;
    const [, changed] = this._emitIni(entry, { serverExe: effectiveExe });
    if (!routerUp) {
      // RECONCILE before a FRESH spawn (2026-07-11): the new router starts EMPTY, so resident
      // entries + arbiter reservations left by a router that died OUTSIDE `stop()` are stale —
      // a ghost embed's reservation kept ~3.6 GB booked and the header read 19.3/8 GB. Only
      // this load's model survives.
      for (const mid of [...this._resident.keys()].filter((m) => m !== entry.modelId)) {
        this._resident.delete(mid);
        this._arbiter.release(mid);
      }
      if (this._lastId !== entry.modelId) this._lastId = this._resident.has(entry.modelId) ? entry.modelId : "";
      serverExe = await this._spawnRouterWithFallback(serverExe, config);
    } else {
      serverExe = this._activeServerExe || serverExe;
      if (changed) await this._bounceRouter(serverExe, config);
    }
    await this._routerLoadWithBackoff(entry, fit, serverExe, config);
  }

  /**
   * Poll `GET /models` until the child for `modelId` resolves. POST /models/load is ASYNC on
   * b9644 (a 2xx only ACCEPTS), so the 200 is NOT a load confirmation. Resolves 'loaded'
   * (status.value loaded|sleeping), 'failed' (value failed/error, the router process itself
   * died, or — 2026-07-11 — the CHILD died: a crashed child can leave the router reporting its
   * id as still-`loading` forever (the brick), so with `logOffset` set the router log appended
   * since this load's POST is also scanned for the router's own `instance name=<id> exited
   * with status` death line; without it a corpse was polled for the full deadline, ~6.5 min
   * observed), or 'timeout'. Caller holds the router lock. `_now`/`_sleep`/`_routerModels` are
   * injected in tests so this polls deterministically offline.
   */
  async _confirmLoad(modelId, logOffset = null) {
    const deadline = this._now() + this._loadPollTimeout;
    for (;;) {
      const router = this._router;
      if (router == null || !router.isAlive()) return "failed"; // the router itself is gone
      let live;
      try {
        live = _parseRouterModels(await this._routerModels(router.url));
      } catch {
        live = new Map(); // a transient GET failure ≠ a load failure; keep polling
      }
      const value = live.get(modelId)?.value || "";
      if (value === "loaded" || value === "sleeping") return "loaded";
      if (value === "failed" || value === "error") return "failed";
      if (logOffset != null && this._childExitedSince(modelId, logOffset)) return "failed";
      if (this._now() >= deadline) return "timeout";
      await this._sleep(this._loadPollInterval);
    }
  }

  /** Byte size of the live router log — the watermark `_confirmLoad` scans from, so a
   * PREVIOUS attempt's exit line can't fail THIS load. */
  _routerLogSize() {
    try {
      return this._lastLogPath ? statSync(String(this._lastLogPath)).size : 0;
    } catch {
      return 0;
    }
  }

  /** The router-log bytes appended after `offset` (this attempt's POST watermark). THE one
   * per-attempt log read (2026-07-21): every failure-signature check — child-exit, OOM shed,
   * draft crash, the 1b-F4 unfixable gate — reads THIS, never an unwatermarked whole-log tail,
   * so a stale line from a previous attempt or an earlier model's failure in the shared router
   * log can never trigger a match. Read as Python's text mode read it (universal newlines). */
  _logAppendedSince(offset) {
    const p = this._lastLogPath;
    if (!p) return "";
    try {
      return readFileSync(String(p))
        .subarray(Math.max(0, offset))
        .toString("utf8")
        .replace(/\r\n?/g, "\n");
    } catch {
      return "";
    }
  }

  /** The fail-fast death signal (2026-07-11): the router logs a crashed child as `instance
   * name=<id> exited with status N` but can keep reporting the id as still-`loading` (the
   * brick). Scans only this attempt's appended bytes. */
  _childExitedSince(modelId, offset) {
    return this._logAppendedSince(offset).includes(`instance name=${modelId} exited with status`);
  }

  /**
   * `POST /models/load` the model, then CONFIRM it went resident by polling `GET /models`
   * (the POST is async — a 2xx only accepts). On a child that fails to load AND the spawn log
   * looks like CUDA-OOM, re-emit that model's section at a lower `ngl` (+ derived `nCpuMoe`
   * for a MoE) and reload — a router-level mirror of `startRunner`'s ngl-shed back-off, which
   * the router bypasses (design §5b, the ngl=999 over-fit).
   *
   * The OOM gate matters: a NON-OOM failure (a bad `extraFlags` passthrough, a corrupt or
   * mismatched GGUF, a flag the engine rejects) re-emits the SAME overrides, so shedding cannot
   * fix it — and each `_bounceRouter` knocks down + reloads EVERY healthy co-resident model.
   * So a non-OOM failure fails FAST, no shed, no bounce. A SYNCHRONOUS reject from the POST
   * itself (a 4xx: unknown id / at `models-max`) is NOT an OOM — it propagates out of here as
   * the load error. Caller holds the router lock.
   */
  async _routerLoadWithBackoff(entry, fit, serverExe, config) {
    let ngl = fit.nGpuLayers;
    // The shed tracks BOTH knobs (fit-redesign §5.7): a MoE OOM raises ncmoe first (expert
    // bytes leave the GPU, attention + KV stay); ngl sheds only once ncmoe is maxed. Start
    // from the entry's own value — a tune's ncmoe (e.g. 21) must never be silently replaced by
    // a derived one (§1.7's 21 → 4-at-ngl-26 regression, strictly worse each retry).
    let ncmoe = entry.nCpuMoe != null ? entry.nCpuMoe : fit.nCpuMoe;
    let draftSoloTried = false; // cheap recovery: unloaded co-residents to load the draft solo
    let draftRestartTried = false; // last resort: restarted the engine to load the draft alone
    for (;;) {
      // POST accepts (2xx) or throws on a synchronous 4xx (bad id / at capacity) — the latter is
      // a real error, not OOM, so it propagates (→ _runLoad sets error state). The log
      // watermark is captured per attempt (a bounce swaps the log file), so the confirm's
      // child-death scan only sees THIS attempt's lines (fail-fast, 2026-07-11).
      const logOffset = this._routerLogSize();
      try {
        await this._routerLoad(this._router.url, entry.modelId);
      } catch (exc) {
        // Idempotent adopt (defect E, 2026-07-22 pass-1 plan T5): the router answering
        // "already running" is TRUTH, not a failure — the ledger had drifted (e.g. an unload
        // the child outlived). Fall through to _confirmLoad, which verifies the resident child
        // like any other load. Caught HERE (not in _defaultRouterLoad) so injected routerLoad
        // fakes get the same tolerance and the behavior is unit-testable.
        if (!(exc instanceof RuntimeError) || !errText(exc).toLowerCase().includes("already running")) throw exc;
        log.info(`router says ${entry.modelId} is already running — adopting`);
      }
      const outcome = await this._confirmLoad(entry.modelId, logOffset);
      if (outcome === "loaded") {
        // Defect C (T3): record the entry AS FINALLY LOADED — after any explicit-placement
        // retry / OOM-shed rebind above — so re-emits and bounce-reloads reproduce THIS config,
        // not a DB-derived one. Caller holds the router lock.
        this._activeEntries.set(entry.modelId, entry);
        return;
      }
      // 1b-F4: a FIT-PLACED entry (ngl omitted → the child's own `--fit` placed tensors) that
      // fails for ANY reason — the barely-fits fit bugs present as non-OOM exits (#18066) —
      // retries ONCE with the explicit computed values (today's exact path); the ordinary
      // OOM-shed/fail-fast below then governs the now-explicit entry.
      if (entry.nGpuLayers == null) {
        // 1b-F4 guard (2026-07-21): an UNFIXABLE non-OOM failure (a rejected engine flag, an
        // unknown model architecture) re-emits the SAME flags/model, so the retry cannot help —
        // and each _bounceRouter knocks down + reloads EVERY healthy co-resident model. Fail
        // FAST on those. This also covers an unfixable DRAFT crash (an unknown/unsupported
        // MTP-draft architecture like dspark): the solo path exists for the TRANSIENT co-load
        // RACE ("invalid vector subscript", which is NOT unfixable), never for a draft the
        // engine simply can't load. When a draft is configured, the message names MTP so the
        // user knows to turn it off or set a compatible draft (2026-07-21, the user's ask).
        const tailNow = this._logAppendedSince(logOffset); // THIS attempt's lines only
        if (_looksLikeUnfixable(tailNow)) {
          const hasDraft = Boolean(entry.overrides.modelDraft) || (entry.overrides.specType != null && entry.overrides.specType !== "none");
          const hint = hasDraft
            ? " If this is the MTP draft (an unsupported/unknown draft architecture), turn MTP off for this model or set a draft the built-in engine can load."
            : "";
          throw new RuntimeError(
            `model ${pyRepr(entry.modelId)} failed to load (status=${outcome}) with an ` +
              "unfixable error — not retrying, since a retry would restart the engine and " +
              `disrupt other loaded models.${hint} Details: ${cpSlice(tailNow || "", -600)}`,
          );
        }
        log.warning(
          `router child ${entry.modelId} failed under engine fit (${outcome}) — retrying with explicit computed placement ngl=${fit.nGpuLayers} ncmoe=${fit.nCpuMoe}`,
        );
        entry = new ModelIniEntry({
          modelId: entry.modelId,
          ggufPath: entry.ggufPath,
          nGpuLayers: fit.nGpuLayers,
          nCpuMoe: fit.nCpuMoe,
          ctxLen: entry.ctxLen,
          overrides: entry.overrides,
          embeddings: entry.embeddings,
          pooling: entry.pooling,
          loadOnStartup: entry.loadOnStartup,
          blockCount: fit.blockCount,
        });
        this._emitIni(entry, { serverExe });
        await this._bounceRouter(serverExe, config);
        continue;
      }
      // failed / timeout: shed GPU layers ONLY on a genuine CUDA-OOM in the spawn log — never on
      // a non-OOM failure (shedding can't fix it and a bounce disrupts residents). Watermarked
      // (2026-07-21): only THIS attempt's appended lines.
      const tail = this._logAppendedSince(logOffset);
      // MTP/spec draft-load crash (2026-07-12): llama.cpp's router crashes the DRAFT model
      // ('invalid vector subscript') when it loads WHILE another child is loading — a transient
      // SCHEDULING race, NOT a resource problem. So we NEVER drop speculative decoding to work
      // around it — a permanent ~1.5-2x decode loss must not be a reaction to a transient
      // crash. (Nothing drops MTP automatically for VRAM reasons: since 2026-07-19 `computeFit`
      // CHARGES the draft's weights + KV to the budget.) Instead, remove the concurrency and
      // load the draft SOLO — keeping MTP — escalating cheapest-first, and surface WHY the load
      // runs long so the user isn't watching a silent spinner.
      const hasDraft = Boolean(entry.overrides.modelDraft) || (entry.overrides.specType != null && entry.overrides.specType !== "none");
      if (_looksLikeDraftFailure(tail) && hasDraft) {
        const others = [...this._resident.keys()].filter((mid) => mid !== entry.modelId);
        // Stage 1 (cheap, NO restart): unload the co-resident(s) that raced the draft, then
        // reload the draft-model solo. They reload lazily on next use — an embed has no draft,
        // so it co-loads fine beside the warm draft-model afterwards.
        if (!draftSoloTried && others.length) {
          draftSoloTried = true;
          log.warning(
            `router child ${entry.modelId} crashed loading its MTP draft beside ${pySorted(others).join(", ")} — unloading co-residents to load the draft solo (MTP kept; they reload on next use)`,
          );
          this._touch(entry.modelId, { detail: "freeing another model so fast generation (MTP) loads cleanly…" });
          for (const mid of others) await this._evictResident(mid);
          continue;
        }
        // Stage 2 (last resort): a full engine restart to load the draft-model ALONE. entry
        // KEEPS its draft — MTP preserved. Stale co-residents dropped first so the restart
        // comes up empty, then the loop re-POSTs it solo.
        if (!draftRestartTried) {
          // A restart can't free memory another PROGRAM holds — the 2026-09-29 cause (speech
          // engines left from earlier sessions): the retry failed the same way and the restart
          // only added time. So look first; when the one whole-machine query sees any (≥ 200 MB
          // each, not this engine's own processes), fail now and name them. Otherwise restart
          // as before — the one retry stays for causes we can't see from outside (2026-09-30,
          // kit user "b go"; JustVoice docs/plans/2026-09-30-lifetime-leftovers.md §2).
          let holders;
          try {
            holders = await self._otherGpuHolders();
          } catch {
            holders = null; // can't tell → restart, as before
          }
          if (truthy(holders)) {
            log.warning(
              `router child ${entry.modelId} crashed on its MTP draft with nothing beside it, and other programs hold GPU memory — not restarting the engine, which can't free it`,
            );
            throw await self._draftFailedAlone(entry.modelId, outcome, tail, holders);
          }
          draftRestartTried = true;
          log.warning(`router child ${entry.modelId} still crashed on its MTP draft — restarting the engine to load it alone (MTP kept)`);
          this._touch(entry.modelId, {
            detail: "restarting the engine to load fast generation (MTP) cleanly — this takes a little longer…",
          });
          for (const mid of [...this._resident.keys()].filter((m) => m !== entry.modelId)) {
            this._resident.delete(mid);
            this._arbiter.release(mid);
          }
          this._emitIni(entry, { serverExe });
          await this._bounceRouter(serverExe, config);
          continue;
        }
        // Solo AND a clean restart both still crashed on the draft → NOT the co-load race.
        // Surface the real error — never silently degrade to no-MTP.
        throw await self._draftFailedAlone(entry.modelId, outcome, tail);
      }
      const canRaiseNcmoe = fit.isMoe && (ncmoe || 0) < fit.blockCount;
      if ((ngl > 0 || canRaiseNcmoe) && _looksLikeOom(tail)) {
        if (canRaiseNcmoe) {
          ncmoe = Math.min(fit.blockCount, (ncmoe || 0) + _BACKOFF_STEP);
          log.warning(`router child ${entry.modelId} OOM (${outcome}) — raising n-cpu-moe to ${ncmoe} (ngl stays ${ngl}) + reload`);
        } else {
          ngl = Math.max(0, ngl - _BACKOFF_STEP);
          log.warning(`router child ${entry.modelId} OOM (${outcome}) — re-emit at ngl=${ngl} + reload`);
        }
        entry = new ModelIniEntry({
          modelId: entry.modelId,
          ggufPath: entry.ggufPath,
          nGpuLayers: ngl,
          nCpuMoe: ncmoe,
          ctxLen: entry.ctxLen,
          overrides: entry.overrides,
          embeddings: entry.embeddings,
          pooling: entry.pooling,
          loadOnStartup: entry.loadOnStartup,
          blockCount: fit.blockCount,
        });
        this._emitIni(entry, { serverExe });
        await this._bounceRouter(serverExe, config);
        continue;
      }
      throw new RuntimeError(
        `model ${pyRepr(entry.modelId)} failed to load (status=${outcome}, ngl=${ngl}). ` +
          (_looksLikeOom(tail) ? await self._gpuHoldersNote() : "") +
          cpSlice(tail || "", -600),
      );
    }
  }

  /**
   * Per-model download-only worker (OWN channel): wait for an admission slot, fetch the
   * weights — AND the external MTP draft when the resolved config wants it (2026-07-19), so
   * "Downloaded ✓" is honest and the first load never surprise-fetches — ground the catalog
   * type from the file, then DROP this model's map entry (absent == done; /models reports it
   * on-disk). It NEVER touches the model run-state (_resident/_router), so a running model — or
   * a sibling download — is undisturbed. The engine is NOT required to download, only to load.
   * Success/cancel remove the entry; a failure leaves a persistent "error" entry until a fresh
   * download().
   */
  async _runDownload(modelId) {
    const cancelEv = this._downloadCancels.get(modelId) ?? new AsyncEvent();
    try {
      await this._awaitSlot(modelId, cancelEv); // park while at the concurrency ceiling; sets detail

      const progress = (downloaded, total) => {
        const e = this._downloadStates.get(modelId);
        if (e != null) {
          // a concurrent cancel may have dropped it
          e.downloaded = downloaded;
          e.total = total || 0;
        }
      };
      const progressDraft = (downloaded, total) => {
        const e = this._downloadStates.get(modelId);
        if (e != null) {
          e.detail = "MTP draft model";
          e.downloaded = downloaded;
          e.total = total || 0;
        }
      };
      const resetProgress = () => {
        // Neutral phase + zeroed counters between the legs (main bytes must not linger under
        // the draft's label); the draft's phase comes from its own callback, only when it
        // actually downloads.
        const e = this._downloadStates.get(modelId);
        if (e != null) {
          e.detail = "preparing";
          e.downloaded = 0;
          e.total = 0;
        }
      };

      const ov = _switchesToOverrides(this._switchesFn(modelId) || {});
      await this._acquireAndIdentify(modelId, progress, () => cancelEv.isSet(), {
        overrides: ov,
        onProgressDraft: progressDraft,
        resetProgress,
      }); // throws ValueError for unknown model
      this._downloadStates.delete(modelId); // done → idle (weights on disk)
    } catch (exc) {
      if (exc instanceof DownloadCancelled) {
        // User cancel is not an error — the partial part-files stay cached (a re-download
        // resumes past them); drop the entry so the row reads "available" again.
        log.info(`runner download cancelled for ${modelId}`);
        this._downloadStates.delete(modelId);
      } else {
        log.exception("runner download failed", exc); // any failure becomes a persistent error entry
        this._downloadStates.set(modelId, {
          status: "error",
          modelId,
          detail: "",
          error: errText(exc),
          downloaded: 0,
          total: 0,
        });
      }
    } finally {
      // Release the admission slot + wake the next queued worker; drop this model's task +
      // cancel refs (the map ENTRY may persist on error, but the machinery that ran it is
      // done).
      this._downloadCancels.delete(modelId);
      this._downloadThreads.delete(modelId);
      this._downloadGate.notifyAll();
    }
  }
}

// ─── The process singleton ───────────────────────────────────────────────────────────

function defaultCacheRoot() {
  return process.env.LLM_RUNNER_CACHE || path.join(os.homedir(), ".cache", "just-llm-runner");
}

/**
 * Host hook to construct the singleton with DB-backed catalog/switches/config (and any other
 * injections). Call ONCE at boot, before `getService()`. Returns the constructed singleton.
 *
 * `runtimeRoot` splits what this app GENERATES (models.ini, spawn logs) out of the cache.
 * Pass it whenever `cacheRoot` is shared with a sibling app — otherwise the two apps overwrite
 * each other's preset file. null keeps the legacy in-cache spot.
 */
export function configureService({
  catalogFn = null,
  switchesFn = null,
  profileSwitchesFn = null,
  identifyFn = null,
  embeddingIdsFn = null,
  defaultLlmIdFn = null,
  configFn = null,
  hardwareFn = null,
  cacheRoot = null,
  runtimeRoot = null,
  knobBackendsFn = null,
  measurementsFn = null,
  classBwFn = null,
  recordProbeFn = null,
  recordLoadFn = null,
  fitRelevantFlagsFn = null,
  declaredClaimFn = null,
} = {}) {
  const root = cacheRoot || defaultCacheRoot();
  const kwargs = {};
  if (runtimeRoot) kwargs.runtimeRoot = runtimeRoot;
  const fns = {
    catalogFn,
    switchesFn,
    profileSwitchesFn,
    identifyFn,
    embeddingIdsFn,
    defaultLlmIdFn,
    configFn,
    hardwareFn,
    knobBackendsFn,
    measurementsFn,
    classBwFn,
    recordProbeFn,
    recordLoadFn,
    fitRelevantFlagsFn,
    declaredClaimFn,
  };
  for (const [k, v] of Object.entries(fns)) if (v != null) kwargs[k] = v;
  state.service = new RunnerService(root, kwargs);
  return state.service;
}

/**
 * Process-wide singleton. Cache root from LLM_RUNNER_CACHE or the user cache home (the runner
 * is app-agnostic — it owns its own cache dir). Hosts should call `configureService(...)` once
 * at boot to wire DB-backed catalog/switches; otherwise this falls back to the standalone
 * default.
 */
export function getService() {
  if (state.service == null) state.service = new RunnerService(defaultCacheRoot());
  return state.service;
}

/**
 * The singleton IF a host wired one — never the standalone fallback.
 *
 * `getService()` cannot answer "is the runner actually wired here?": it builds a default
 * pointed at `~/.cache/just-llm-runner` and hands it back, so a caller asking only for the
 * cache path gets a confident wrong answer in an app that mounts the platform routers without
 * the runner. Anything that MEASURES or REPORTS (rather than drives) the engine should ask this
 * and fall back itself.
 */
export function configuredService() {
  return state.service;
}
