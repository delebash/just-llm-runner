// SPDX-License-Identifier: MIT
// Spawn `llama-server` with a VRAM-fit flag set + probe-and-back-off (the port of
// llm_runner/runner/process.py).
//
// Three pieces:
//   * `computeFit` — pure heuristic: how many layers fit on the GPU, and (for MoE) how many
//     expert layers to offload to CPU RAM (`--n-cpu-moe`).
//   * `composeFlags` — build the llama-server argv from the resolved overrides + the fit +
//     the model path.
//   * `startRunner` / `Runner` — spawn the process, wait for `/health`, and on a CUDA-OOM
//     exit shed GPU layers and retry. The back-off is the real safety net, so `computeFit`
//     only needs to be a reasonable first guess.
//
// ── The JS shape ────────────────────────────────────────────────────────────────────────
// Python's dataclasses (Overrides, FitPlan, ModelIniEntry, Runner, RouterHandle) are classes
// built from ONE fields object with camelCase names (`new Overrides({nGpuLayers: 30})`,
// `fit.vramMb`) — the same one-name-per-field rule as gguf.js's GgufMeta. `OVERRIDES_FIELDS`
// maps each Overrides field to its Python (= stored switch-key) name. Python keyword
// arguments become an options object.
//
// SYNC / ASYNC: the pure parts (fit, flags, ini, classifiers, `_tailFile`) stay synchronous.
// Everything that waited in Python is async: `findFreePort` / `_portIsFree` (a bind),
// `_spawnChild` / `spawnChild` (it must learn whether the OS started the program, and it
// sleeps between retries), `startRunner`, `startRouter`, `_waitUntilHealthy`,
// `_defaultHealth` / `ServerHandle.health()`, `_drain`, `_kill`, `waitExit`.
// `ServerHandle.isAlive()` and `stop()` stay synchronous (Python's were non-blocking).
//
// THE PROCESS OBJECT. A spawn returns Node's ChildProcess (from `platform/procs.js`
// `popen`). This module reads only: `pid`, `exitCode`, `signalCode`, `kill(signal)`, the
// `stdout` / `stderr` streams and the `once` / `on` events — so a test's fake is a plain
// object with `exitCode` (null = still running), `kill()` and, for the pipe path,
// `capturedOutput`. `pollProc(proc)` is Python's `proc.poll()`: null while running, else
// the exit code as Python reports it (Windows: unsigned 32-bit; a signal: −signo).
//
// THE OUTPUT. CREATE_NO_WINDOW needs every stdio piped or ignored, never an inherited fd
// (`platform/procs.js` header; kit register §5), so Python's `stdout=logf, stderr=STDOUT`
// becomes: both pipes copied into the log file by THIS process (appending), or — with no
// log — into `proc.capturedOutput` (Python's `stdout=PIPE, text=True`). Two consequences,
// both recorded: stdout and stderr are merged here, not by the OS, so their relative order
// can differ from Python's; and the capture keeps only the last 1 MiB (Python's never-read
// PIPE would instead have blocked the child once the OS buffer filled).

import { createRequire } from "node:module";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { sleep, withTimeout } from "../platform/asyncutil.js";
import * as http from "../platform/http.js";
import { getLogger } from "../platform/log.js";
import * as procs from "../platform/procs.js";
import { FileNotFoundError, floorDiv, lstrip, pyStr, RuntimeError, splitlines } from "../platform/py.js";
import { buildNum } from "./binary.js";
import { DEFAULT_CTX_CAP_TOKENS, DEFAULT_SAFETY_MARGIN_MB } from "./config.js";
import * as fit from "./fit.js";
import * as hardware from "./hardware.js";
import * as self from "./process.js";

const log = getLogger("llm_runner.runner.process");

export const DEFAULT_CTX = 4096;
export const DEFAULT_HOST = "127.0.0.1";
// The PREFERRED router port — never a promised one. See findFreePort.
export const DEFAULT_PORT = 8080;
export const _PORT_SCAN_SPAN = 64; // how far past the preferred port to look before giving up
export const _BACKOFF_STEP = 4; // GPU layers shed per OOM retry

/**
 * Module settings a test replaces (Python's monkeypatch of `process.sys.platform`):
 * `platform` decides the Windows-only parts — the job and the transient-error retry.
 */
export const cfg = { platform: process.platform };

const monotonic = () => performance.now() / 1000;
const sleepS = (s) => sleep(s * 1000);

/** llama-server never became healthy (and it wasn't a recoverable OOM). */
export class RunnerStartError extends RuntimeError {
  constructor(message, options) {
    super(message);
    this.name = "RunnerStartError";
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/** Nothing in the scanned range could be bound — the box is genuinely full. */
export class NoFreePortError extends RunnerStartError {
  constructor(message, options) {
    super(message, options);
    this.name = "NoFreePortError";
  }
}

// ─── The router port ─────────────────────────────────────────────────────────────────

/**
 * Can WE bind (host, port) right now? A connect-probe would answer a different question —
 * 'is anyone listening' — and would call a port held by a non-listening socket free.
 * SO_REUSEADDR is deliberately NOT set by Python: on Windows it lets a second socket steal
 * a bound port, which is exactly the confusion this guards against.
 *
 * Node can only bind a TCP socket by listening on it, so the probe listens for an instant
 * and closes. libuv sets no SO_REUSEADDR on Windows TCP sockets (the answer is Python's);
 * on Linux/macOS it sets SO_REUSEADDR, which there only lets a port in TIME_WAIT read free —
 * llama-server's own listener binds the same way, so it would succeed too.
 */
export function _portIsFree(host, port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen({ host, port, exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

/**
 * The first bindable port at or after `preferred`.
 *
 * The router port is the one resource a family of apps genuinely CANNOT share, and it was
 * the one thing they all hardcoded. Every app spawned its router on :8080, so the second
 * app's llama-server could not bind — and `_waitUntilHealthy` passed anyway, because
 * `GET /health` on that port was answered by the FIRST app's router. The load then went to
 * a stranger's process and 404'd on a model id it had never heard of (measured 2026-08-03:
 * JustWrite's `gemma-4-26b-a4b-qat` against just_ai_i18n_docgen's router, 404 in 31 ms —
 * indistinguishable from a corrupt install). Health-by-port is not identity, so take a
 * port nobody else holds.
 *
 * Binding is the test, immediately before the spawn: a stray router from a crashed run, a
 * sibling app, or the user's own llama.cpp all fail it equally. Async (a bind is an event).
 */
export async function findFreePort(host = DEFAULT_HOST, preferred = DEFAULT_PORT, { span = _PORT_SCAN_SPAN, _isFree = null } = {}) {
  const isFree = _isFree ?? ((h, p) => self._portIsFree(h, p));
  for (let port = preferred; port < preferred + Math.max(1, span); port++) {
    if (await isFree(host, port)) return port;
  }
  throw new NoFreePortError(
    `no free port for the engine in ${preferred}-${preferred + span - 1} on ${host} — something is holding the whole range`,
  );
}

// ─── Overrides / FitPlan ─────────────────────────────────────────────────────────────

/**
 * Each Overrides field (camelCase) → its Python field name, which is also the stored
 * switch key (`switch_presets.flag_name`, lifecycle's `_OVERRIDE_FIELDS`). Order = Python's.
 */
export const OVERRIDES_FIELDS = Object.freeze({
  // Fit knobs (computeFit).
  nGpuLayers: "n_gpu_layers",
  nCpuMoe: "n_cpu_moe",
  ctxLen: "ctx_len",
  // Engine flags (composeFlags; null = keep the base preset / llama default).
  cacheTypeK: "cache_type_k", // f16 | q8_0 | turbo3/turbo4 (fork only)
  cacheTypeV: "cache_type_v",
  flashAttn: "flash_attn", // "on" | "off" | "auto"
  noMmap: "no_mmap", // true → read weights into RAM (MoE offload)
  mlock: "mlock", // base sets it; false removes it
  noKvOffload: "no_kv_offload", // true → keep KV in system RAM, free VRAM
  batchSize: "batch_size",
  ubatchSize: "ubatch_size",
  threads: "threads", // CPU gen threads (drive MoE CPU experts)
  threadsBatch: "threads_batch",
  parallel: "parallel", // server slots (batch sweeps / Compare)
  contBatching: "cont_batching", // false → emits --no-cont-batching
  contextShift: "context_shift", // true → --context-shift (snappy edits); false → --no-context-shift
  cacheReuse: "cache_reuse", // reuse a prompt prefix's KV across calls
  specType: "spec_type", // "none"|"draft-mtp"|"ngram-mod"|… (dense)
  specNMax: "spec_n_max", // drafted tokens / ngram max, per specType
  // Separate draft-model GGUF path (--model-draft, alias of --spec-draft-model) for
  // Gemma-style external-MTP models. Normally filled by LIFECYCLE from the catalog's
  // mtp_draft_* facts after acquiring the draft file — not hand-typed (a raw switch row CAN
  // set it; power-user escape). Verified against llama.cpp b9644.
  modelDraft: "model_draft",
  // Thinking budget (--reasoning-budget): -1 unlimited (llama default) | 0 = no thinking |
  // N>0 caps the thinking tokens, then --reasoning-budget-message is injected before the
  // end-of-thinking tag. Verified against llama.cpp b9644.
  reasoningBudget: "reasoning_budget",
  reasoningBudgetMessage: "reasoning_budget_message",
  extraFlags: "extra_flags",
});

/**
 * Operator overrides for tuning/testing a model load — any null falls back to the computed
 * Fit or the llama default. Two groups:
 *   * fit knobs (nGpuLayers / nCpuMoe / ctxLen) — consumed by computeFit;
 *   * engine flags — rendered into the argv by composeFlags. The base + type (moe|dense)
 *     preset defaults arrive HERE already (resolved from the DB `switch_presets` via the
 *     runner's switches_fn), so composeFlags renders purely from these.
 *
 * WHY this surface exists: POST /v1/llm-runner/load must let the GUI test the speed/fit
 * switches on the user's OWN machine (esp. --n-cpu-moe to fit a MoE on a small card, and
 * the KV/threads/batch knobs to find the fast split) — the engine had the knobs but nothing
 * could set them. Full rationale + per-flag when/why: docs/plans/2026-06-24-llamacpp-switches.md
 * (Plane 1). WHAT WOULD CHANGE THIS: if llama-server grows a typed config endpoint, these map
 * 1:1 to it; until then we compose the CLI argv.
 */
export class Overrides {
  constructor(fields = {}) {
    for (const k of Object.keys(fields ?? {})) {
      if (!Object.hasOwn(OVERRIDES_FIELDS, k)) throw new TypeError(`Overrides() got an unexpected keyword argument '${k}'`);
    }
    for (const k of Object.keys(OVERRIDES_FIELDS)) {
      if (k === "extraFlags") this.extraFlags = fields?.extraFlags ?? [];
      else this[k] = fields?.[k] ?? null;
    }
  }

  /** The dataclass `==`: every field equal (extraFlags element by element). */
  equals(other) {
    if (!(other instanceof Overrides)) return false;
    for (const k of Object.keys(OVERRIDES_FIELDS)) {
      if (k === "extraFlags") {
        const a = this.extraFlags ?? [];
        const b = other.extraFlags ?? [];
        if (a.length !== b.length || a.some((x, i) => x !== b[i])) return false;
      } else if (this[k] !== other[k]) return false;
    }
    return true;
  }
}

/** `overrides or Overrides()` — a plain fields object is accepted too. */
function asOverrides(ov) {
  if (!ov) return new Overrides();
  return ov instanceof Overrides ? ov : new Overrides(ov);
}

function requireFields(name, fields, names) {
  for (const k of names) {
    if (fields?.[k] === undefined) throw new TypeError(`${name}() missing required argument: '${k}'`);
  }
}

/**
 * A computed placement. The three values stay CONCRETE ints — the arbiter (vramMb),
 * preview_fit, and the OOM back-off all read them as numbers even when the launch omits the
 * flags (1b-F2).
 */
export class FitPlan {
  constructor(fields = {}) {
    requireFields("FitPlan", fields, ["nGpuLayers", "nCpuMoe", "ctxLen", "blockCount", "isMoe"]);
    this.nGpuLayers = fields.nGpuLayers;
    this.nCpuMoe = fields.nCpuMoe;
    this.ctxLen = fields.ctxLen;
    this.blockCount = fields.blockCount; // carried so back-off can recompute nCpuMoe as layers shed
    this.isMoe = fields.isMoe;
    // estimated GPU-RESIDENT VRAM for nGpuLayers (the VRAM arbiter reserves this, P2)
    this.vramMb = fields.vramMb ?? 0;
    // WHICH knobs were user/tune-EXPLICIT (from Overrides) vs computed here. The emission
    // layer omits non-explicit ngl/ncmoe so the engine's own `--fit` (default-on at the
    // b9870 pin) places tensors; ctx is ALWAYS emitted — ctx policy is ours (1b design).
    this.nglExplicit = fields.nglExplicit ?? false;
    this.ncmoeExplicit = fields.ncmoeExplicit ?? false;
    this.ctxExplicit = fields.ctxExplicit ?? false;
  }
}

// Overrides field → its llama-server VALUE flag (presence + spec handled separately).
export const _VALUE_FLAGS = [
  ["cacheTypeK", "--cache-type-k"],
  ["cacheTypeV", "--cache-type-v"],
  ["flashAttn", "--flash-attn"],
  ["batchSize", "--batch-size"],
  ["ubatchSize", "--ubatch-size"],
  ["threads", "--threads"],
  ["threadsBatch", "--threads-batch"],
  ["parallel", "--parallel"],
  ["cacheReuse", "--cache-reuse"],
  ["modelDraft", "--model-draft"],
  // reasoning_budget + reasoning_budget_message launch flags RETIRED (U2-T4, 2026-07-14,
  // decision 1a): the engine launches at its default (-1 = unlimited) and EVERY request
  // carries the resolved per-request `reasoning_budget_tokens` from the ONE resolver
  // (llm/reasoning). The pre-b9982 "request key honored only when launch == -1" gate is
  // satisfied by construction; post-b9982 the request value wins anyway. The
  // `reasoningBudget` VALUE lives on as DATA — the class-tune cap the resolver reads — it is
  // simply no longer a launch flag. (The raw runner-API load fields stay untouched.)
];

// Keys that use a SHORT argv form (`-ngl` for n-gpu-layers); everything else is `--{key}`.
const _ARGV_SHORT = { "n-gpu-layers": "-ngl" };

// `--load-mode` replaces --mlock / --mmap / --no-mmap / --direct-io (llama.cpp #20834, b10105;
// the legacy args were DELETED at b10875, #28334 — an engine >= that REFUSES them, and an
// unknown key in models.ini makes the preset parser throw). We switch at b10145 (#26135), the
// first build whose value list has `mmap+mlock` AND where `mlock` means "lock WITHOUT mmap" —
// at b10105 the list is none|mmap|mlock|dio. Semantics verified identical b10145 → b11056, and
// MEASURED on the real b10437 (plan docs/plans/2026-09-19-engine-update-safety-and-stable-
// channel.md §3.3): the engine's own `load_mode = X` line confirms each mapping below.
export const LOAD_MODE_MIN_BUILD = 10145;

/**
 * The `--load-mode` value for the kit's two loading switches, or null to emit nothing (the
 * engine default). `mlock` alone keeps its PRE-refactor meaning — mmap on + lock, the
 * combination the 2026-07-22 A/B proved locks on Windows. Since b10105 the legacy flags each
 * ASSIGN one mode and do not combine, so our emitted `--mlock --no-mmap` pair silently
 * resolved to `none` (no mmap, NO LOCK — measured on b10437); that is the bug this closes.
 */
export function loadModeValue(mlock, noMmap) {
  if (mlock && noMmap) return "mlock"; // no mmap + lock (Windows never reaches here — lifecycle's _strip_inert_mlock)
  if (mlock) return "mmap+mlock";
  if (noMmap) return "none";
  return null;
}

/**
 * The ONE normalized [flag, value] list for a model's launch config — the single source
 * BOTH renderers consume, so the spawn argv (`renderArgv`) and the router `.ini` section
 * (`renderIni`) can never drift (the "a copy drifts" rule). `value` is a string for a value
 * flag, or `null` for a presence flag (a bare `--flag` in argv; `key = true` in the ini).
 * Keys are canonical, WITHOUT leading dashes.
 *
 * Covers the fit knobs (n-gpu-layers / n-cpu-moe / ctx) + the engine `Overrides`: value
 * flags (`_VALUE_FLAGS`), presence flags (no-kv-offload, with the cont-batching +
 * context-shift INVERSIONS preserved), the LOADING pair, and the spec-decode branch.
 * `extraFlags` is NOT here — it is a raw passthrough the caller renders verbatim (argv) or
 * parses (ini). The merged `Overrides` already resolved the base preset, so there is nothing
 * to strip; the list is built fresh.
 *
 * `engineBuild` is the build the render is FOR ("b10437"): the LOADING pair (mlock /
 * noMmap) spells itself `--load-mode` from `LOAD_MODE_MIN_BUILD` and as the legacy presence
 * flags below it. Default "" → buildNum -1 → the legacy spelling, i.e. byte-identical to
 * every render made before 2026-09-19.
 */
export function overridesToPairs(ov, knobs = {}) {
  // Python's keyword-only arguments without defaults: the three must be passed (null allowed).
  requireFields("overridesToPairs", knobs, ["nGpuLayers", "nCpuMoe", "ctxLen"]);
  const { nGpuLayers, nCpuMoe, ctxLen, engineBuild = "" } = knobs;
  ov = asOverrides(ov);
  // 1b fit-by-omission: a null fit knob is NOT rendered, so the engine's own default
  // `--fit` places tensors (untuned models); explicit values render as ever and legitimately
  // disable upstream fitting for that arg. ctx-size is ALWAYS rendered (ctx policy is ours —
  // computed or explicit, never delegated).
  const pairs = [];
  if (nGpuLayers != null) pairs.push(["n-gpu-layers", pyStr(nGpuLayers)]);
  if (nCpuMoe != null && nCpuMoe > 0) pairs.push(["n-cpu-moe", pyStr(nCpuMoe)]);
  pairs.push(["ctx-size", pyStr(ctxLen)]);
  for (const [attr, flag] of _VALUE_FLAGS) {
    const val = ov[attr];
    if (val != null) pairs.push([lstrip(flag, "-"), pyStr(val)]);
  }
  if (buildNum(engineBuild) >= LOAD_MODE_MIN_BUILD) {
    const mode = loadModeValue(ov.mlock, ov.noMmap);
    if (mode !== null) pairs.push(["load-mode", mode]);
  } else {
    // Unknown build ("" → -1) or a pre-b10145 engine: the legacy presence flags.
    if (ov.mlock) pairs.push(["mlock", null]);
    if (ov.noMmap) pairs.push(["no-mmap", null]);
  }
  if (ov.noKvOffload) pairs.push(["no-kv-offload", null]);
  if (ov.contBatching === false) {
    // Continuous batching is ON upstream by default — only the OFF switch exists.
    pairs.push(["no-cont-batching", null]);
  }
  if (ov.contextShift != null) {
    // Context shift is OFF upstream by default — emit the explicit flag either way.
    pairs.push([ov.contextShift ? "context-shift" : "no-context-shift", null]);
  }
  if (ov.specType != null && ov.specType !== "none") {
    pairs.push(["spec-type", ov.specType]);
    if (ov.specNMax != null) {
      const key = ov.specType.includes("ngram") ? "spec-ngram-mod-n-max" : "spec-draft-n-max";
      pairs.push([key, pyStr(ov.specNMax)]);
    }
  }
  return pairs;
}

/** Render normalized pairs as llama-server CLI argv tokens (`--flag value` / `--flag`
 * presence / the short `-ngl`). */
export function renderArgv(pairs) {
  const out = [];
  for (const [key, val] of pairs) {
    out.push(_ARGV_SHORT[key] ?? `--${key}`);
    if (val != null) out.push(String(val));
  }
  return out;
}

/** Render normalized pairs as router `.ini` preset lines (`key = value` / `key = true`; the
 * dashless canonical keys llama.cpp's preset parser accepts). */
export function renderIni(pairs) {
  return pairs.map(([key, val]) => `${key} = ${val == null ? "true" : val}`).join("\n");
}

/**
 * Parse raw passthrough argv tokens (e.g. ['--top-n-sigma', '0.05', '--some-flag']) into
 * [key, value|null] `.ini` pairs. Rule: a flag key starts with '-' and is not a number; the
 * NEXT token is that flag's value unless it too is a flag (then the flag is a bare toggle →
 * value null). Numeric values, incl. negatives like '-0.5', are consumed as values, not
 * mistaken for flags. (Python's `\d` is any Unicode digit, hence `\p{Nd}`.)
 */
export function _extraFlagsToIniPairs(tokens) {
  const isFlag = (tok) => tok.startsWith("-") && !/^-?\p{Nd}/u.test(tok);
  const toks = [...(tokens ?? [])];
  const pairs = [];
  let i = 0;
  while (i < toks.length) {
    const key = lstrip(toks[i], "-");
    if (i + 1 < toks.length && !isFlag(toks[i + 1])) {
      pairs.push([key, toks[i + 1]]);
      i += 2;
    } else {
      pairs.push([key, null]);
      i += 1;
    }
  }
  return pairs;
}

/**
 * One resident model's resolved launch config for the router `--models-preset` `.ini`.
 * `modelId` is the section name = the id clients request. The fit knobs + `overrides`
 * render to per-model `.ini` lines via the SAME `overridesToPairs` the spawn argv uses (no
 * drift). An embed entry sets `embeddings` (+ `pooling`); the arbiter pins a model with
 * `loadOnStartup`.
 */
export class ModelIniEntry {
  constructor(fields = {}) {
    requireFields("ModelIniEntry", fields, ["modelId", "ggufPath", "nGpuLayers", "nCpuMoe", "ctxLen"]);
    this.modelId = fields.modelId;
    this.ggufPath = fields.ggufPath;
    // null = OMIT the flag from this section — the child's default `--fit` places tensors
    // (the 1b untuned path); an int renders as ever. ctxLen stays required.
    this.nGpuLayers = fields.nGpuLayers;
    this.nCpuMoe = fields.nCpuMoe;
    this.ctxLen = fields.ctxLen;
    this.overrides = fields.overrides ?? new Overrides();
    this.embeddings = fields.embeddings ?? false;
    // "" → no `pooling =` line (llama.cpp reads the GGUF); else mean|cls|last|rank. Set
    // per-model from the catalog (#119).
    this.pooling = fields.pooling ?? "";
    this.loadOnStartup = fields.loadOnStartup ?? false;
    // The model's repeating-block count — only the RENDER uses it (`engineNglFlag`: "all
    // blocks" renders n + 1). 0 = unknown → the value renders unchanged.
    this.blockCount = fields.blockCount ?? 0;
  }
}

/**
 * The `-ngl` value to EMIT for the kit's `nGpu` (= repeating blocks on the GPU,
 * 0…blockCount). llama.cpp counts the OUTPUT layer too: `-ngl k` puts the output layer + the
 * LAST k−1 blocks on the GPU, block 0 staying on the CPU (`llama-model.cpp` b9993/b10437:
 * `i_gpu_start = n_layer_all + 1 − n_gpu_layers`), so "every block" must render as n + 1.
 * Measured 2026-09-19 on the 26B at the app's launch: `-ngl 31` vs `-ngl 30` = +5.94 % tok/s
 * for +49…58 MiB (plan docs/plans/2026-09-19-vram-truth-exact-bytes-units-offload.md §10.4).
 * Partial values render unchanged — they were MEASURED under this rendering. The kit's own
 * value (tunes, fingerprints, the OOM shed) never sees the +1.
 */
export function engineNglFlag(nGpu, blockCount) {
  if (nGpu == null) return null;
  return blockCount > 0 && nGpu >= blockCount ? blockCount + 1 : nGpu;
}

/**
 * Launch-flag ACCEPTANCE probes for an engine build: each list is `<flags…> --version`.
 *
 * llama-server parses args IN ORDER and exits on `--version`, so an unknown flag or a bad
 * value placed BEFORE it exits 1 ("error: invalid argument: …") with no model and no GPU —
 * `--version` first would test nothing (both observed on b10437, plan §3.3). Together the
 * lists cover every key `overridesToPairs` can emit for that build, plus the fit knobs and
 * the router's own flags. `modelDraft` is absent on purpose: it is a path, not a spelling.
 * Born 2026-09-19: b10875 DELETED --mlock/--no-mmap, and such a build passes the
 * `--version`-only check, gets swapped in, and then rejects every model load.
 */
export function probeArgvs(engineBuild) {
  const common = {
    cacheTypeK: "q8_0",
    cacheTypeV: "q8_0",
    flashAttn: "on",
    batchSize: 512,
    ubatchSize: 512,
    threads: 4,
    threadsBatch: 4,
    parallel: 1,
    cacheReuse: 256,
  };
  const configs = [
    new Overrides({ ...common, mlock: true, noKvOffload: true, contBatching: false, contextShift: true, specType: "draft-mtp", specNMax: 2 }),
    new Overrides({ noMmap: true, contextShift: false, specType: "ngram-mod", specNMax: 4 }),
    new Overrides({ mlock: true, noMmap: true }),
  ];
  const out = configs.map((ov) => [
    ...renderArgv(overridesToPairs(ov, { nGpuLayers: 31, nCpuMoe: 21, ctxLen: 4096, engineBuild })),
    "--version",
  ]);
  out.push([
    "--models-dir", ".", "--models-preset", "models.ini", "--models-max", "2",
    "--sleep-idle-seconds", "600", "--host", "127.0.0.1", "--port", "1",
    "--embeddings", "--pooling", "mean", "--version",
  ]);
  return out;
}

/**
 * Render the router `--models-preset` `.ini` from resolved per-model entries. The DB is the
 * source of truth; this `.ini` is a GENERATED artifact — written from the DB when the router
 * (re)starts or the resident set changes, never hand-edited or read back. One
 * `[<modelId>]` section per entry; per-model flags come from the shared `overridesToPairs`
 * (so the `.ini` can't drift from the spawn argv).
 *
 * `engineBuild` is the build that will READ this file — flag spellings depend on it
 * (`LOAD_MODE_MIN_BUILD`), and an unknown key makes the preset parser throw. It is a property
 * of the whole file, not of a model, which is why it lives here and not on `ModelIniEntry`.
 */
export function emitModelsIni(entries, { engineBuild = "" } = {}) {
  const blocks = [];
  for (const e of entries) {
    const pairs = overridesToPairs(e.overrides, {
      nGpuLayers: engineNglFlag(e.nGpuLayers, e.blockCount),
      nCpuMoe: e.nCpuMoe,
      ctxLen: e.ctxLen,
      engineBuild,
    });
    pairs.push(..._extraFlagsToIniPairs(e.overrides?.extraFlags));
    const section = [`[${e.modelId}]`, `model = ${e.ggufPath}`, renderIni(pairs)];
    if (e.embeddings) {
      section.push("embeddings = true");
      if (e.pooling) section.push(`pooling = ${e.pooling}`);
    }
    if (e.loadOnStartup) section.push("load-on-startup = true");
    blocks.push(section.filter((s) => s).join("\n"));
  }
  return blocks.length ? `${blocks.join("\n\n")}\n` : "";
}

/**
 * Build the llama-server ROUTER-mode argv (NO `-m`): the router loads models by id from the
 * emitted `--models-preset` `.ini`. `--models-max` caps the co-resident count (the arbiter
 * works within it); `--sleep-idle-seconds` (when > 0) is the native idle-unload TTL.
 * Per-model launch flags live in the `.ini`, not here.
 */
export function composeRouterArgv({
  modelsDir,
  modelsPreset,
  modelsMax = 2,
  sleepIdleSeconds = null,
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  extra = [],
} = {}) {
  let argv = [
    "--models-dir", String(modelsDir),
    "--models-preset", String(modelsPreset),
    "--models-max", pyStr(modelsMax),
    "--host", host, "--port", pyStr(port),
  ];
  if (sleepIdleSeconds != null && sleepIdleSeconds > 0) argv = [...argv, "--sleep-idle-seconds", pyStr(sleepIdleSeconds)];
  return [...argv, ...extra];
}

/**
 * Decide how much of the model fits on the GPU.
 *
 * Reserve a safety margin + KV-cache VRAM, then divide the remaining budget by the average
 * per-layer weight bytes. MoE expert layers that don't fit are offloaded to CPU RAM.
 * Probe-and-back-off at spawn corrects any overestimate, so this only needs to be a sane
 * first guess.
 *
 * `safetyMarginMb` comes from the RunnerConfig (DB-backed, host) or its default; the KV
 * cache-type is taken from the resolved overrides (the DB `base` preset sets q8_0) so it
 * isn't under-counted.
 *
 * `draftMeta`/`draftBytes` (2026-07-19) describe the speculative-decode DRAFT GGUF when the
 * resolved config carries one (`ov.modelDraft`). A draft is a SECOND model in the same
 * process — GPU-placed by the engine itself (`-ngld` defaults to `auto`, and we emit no
 * override) — so its weights + its own KV are charged to the budget before the main split.
 * Omit them and the draft silently steals main-model layers: the #274 embed-co-load defect in
 * a new coat. Callers that resolve a draft path MUST pass these; absent → byte-identical to
 * the pre-2026-07-19 plan.
 *
 * `meta` is a GgufMeta (or any object with its camelCase fields: blockCount,
 * embeddingLength, nKvHeads, isMoe, and optionally contextLength, keyLength, valueLength,
 * headCount, kvMbAtCtx(), expertByteShare(), the tensor-table fields).
 */
export function computeFit(
  meta,
  totalWeightBytes,
  hw,
  overrides = null,
  { safetyMarginMb = DEFAULT_SAFETY_MARGIN_MB, ctxCapTokens = DEFAULT_CTX_CAP_TOKENS, draftMeta = null, draftBytes = 0 } = {},
) {
  const ov = asOverrides(overrides);
  const nLayers = Math.max(1, meta.blockCount);
  const cacheType = fit.cacheTypeBits(ov.cacheTypeK || "q8_0");
  // head_count_kv is absent in some GGUF headers — fall back to MHA (≈ hidden_dim / 128, a
  // typical head_dim) so KV isn't under-counted.
  const nKvHeads = meta.nKvHeads || Math.max(1, floorDiv(meta.embeddingLength, 128));
  // THE ARCHITECTURE ARM (fit-redesign §5.2, Phase 1): `memArch` reaches the fit math. On a
  // ONE-POOL box (integrated iGPU / Apple unified) "how much VRAM" is not a separate question
  // from "how much memory": the budget that affords ctx and layers is the POOL, not the
  // carve-out figure a driver reports (a Mac reports NO GPU at all — max_vram 0 — and was
  // clamped to ctx 4096 as a fake CPU box while Metal ran the model fine). Discrete keeps the
  // two-pool arithmetic exactly as before.
  const arch = hardware.memArch(hw);
  // A GPU-LESS box on Windows/Linux is a CPU box, not a one-pool GPU box — `memArch` calls it
  // "integrated" as the classification fallback, but with no device there is nothing to
  // offload to and the CPU path below is the truth. macOS qualifies WITHOUT a GPU row by
  // design: detection never fabricates one, yet Metal is there (the Mac-as-CPU bug this arm
  // fixes).
  const onePool = (arch === "integrated" || arch === "unified") && ((hw.gpus || []).length > 0 || hw.platform === "macos");
  const budgetMb = onePool
    ? Math.max(0, (hw.ramMb || 0) - safetyMarginMb)
    : Math.max(0, hardware.maxVramMb(hw) - safetyMarginMb);

  // ctx POLICY is ours (1b): an explicit override (tune/preset/request) wins — and is NEVER
  // capped ("a tune's explicit context always overrides"); else the computed knob —
  // min(trained window, KV-affordable on this box, the ctx cap). The cap (fit-redesign
  // §8.1/§1.5) exists because affordability alone hands cheap-KV models absurd windows: the
  // Qwen's 2 KV heads afforded ctx 131,072 — ~2.7 GB of KV spent before any weight was placed
  // — while every measured tune pinned 32,768. A cap composes through min() and only ever
  // lowers; 0 = uncapped. DEFAULT_CTX remains the floor for headerless files
  // (contextLength=0 → the `||` keeps a zero trained-ctx from winning the min).
  let ctxLen;
  let ctxExplicit;
  if (ov.ctxLen) {
    ctxLen = ov.ctxLen;
    ctxExplicit = true;
  } else {
    const candidates = [
      meta.contextLength || DEFAULT_CTX,
      fit.kvAffordable({ vramBudgetMb: budgetMb, nLayers, nKvHeads, cacheType }),
    ];
    if (ctxCapTokens && ctxCapTokens > 0) candidates.push(ctxCapTokens);
    ctxLen = Math.min(...candidates);
    ctxExplicit = false;
  }

  // The main model's exact KV at the chosen ctx + the backend overhead seed — hoisted ABOVE
  // the split (Phase 6): the joint solve, the draft charge and the booking all consume the
  // same two numbers (one source, computed once). KV: iSWA models keep their per-layer-window
  // exact source (`kvMbAtCtx`); every other model gets exact KV via `kvExactMb` (§5.1's
  // one-KV-source). Guarded: tests + duck-typed callers pass minimal meta objects.
  let kvMb = typeof meta.kvMbAtCtx === "function" ? meta.kvMbAtCtx(ctxLen, cacheType) : null;
  if (kvMb == null) {
    kvMb = fit.kvExactMb({
      nLayers,
      nKvHeads,
      ctxSize: ctxLen,
      cacheType,
      keyLength: meta.keyLength ?? 0,
      valueLength: meta.valueLength ?? 0,
      embeddingDim: meta.embeddingLength,
      headCount: meta.headCount ?? 0,
    });
  }
  const overheadMb = fit.PHYSICS_OVERHEAD_MB[hardware.activeBackend(hw)] ?? fit.PHYSICS_OVERHEAD_MB.cuda;
  const expertShare = meta.isMoe && typeof meta.expertByteShare === "function" ? meta.expertByteShare() : 0.0;
  // ONE unit (vram-truth plan 2026-09-19 §6.4): budgets and measurements are MiB, so the
  // weight size is MiB too (it was decimal MB — a 4.86 % over-statement).
  const sizeMib = totalWeightBytes / fit.MIB;
  // EXACT placement (§6.3) when the tensor table was read: the bytes llama.cpp actually puts
  // on the card for the flag we EMIT (engineNglFlag), incl. a tied head's duplicated vocab
  // table — validated to < 1 MiB against the engine's own estimator (plan §10.2). Otherwise
  // the share approximation, as before.
  const exact = !!meta.tensorBytesKnown && (meta.layerNonexpBytes || []).length >= nLayers;

  /** Physics booking (MiB) for `g` repeating blocks on the GPU (the kit's value) with the
   * first `nc` blocks' experts in RAM. */
  const needMib = (g, nc) => {
    if (g <= 0) return 0.0;
    if (exact) {
      const flag = engineNglFlag(g, nLayers);
      const weights = fit.placedWeightMib({
        layerNonexp: meta.layerNonexpBytes,
        layerExps: meta.layerExpsBytes,
        outputBytes: meta.outputBytes,
        blockCount: nLayers,
        nglFlag: flag,
        nCpuMoe: nc,
      });
      const onGpu = fit.engineGpuBlocks(nLayers, flag).length;
      return weights + kvMb * (onGpu / nLayers) + overheadMb;
    }
    return fit.physicsVramMb({
      sizeMb: sizeMib,
      nLayers,
      gpuLayers: g,
      moeShare: fit.moeGpuSizeShare({ nLayers, gpuLayers: g, nCpuMoe: nc, expertShare }),
      kvMb,
      overheadMb,
    });
  };

  // The speculative-decode DRAFT's share of the budget, taken BEFORE the main split.
  // PHYSICS-CHARGED since Phase 6 (§5.7 retired the regression's `marginalVramMb` here — its
  // fitted per-layer −18 MB credit and embedding-ratio slope have nothing to do with a
  // 4-layer draft): the draft's whole file + its exact KV at our chosen ctx. No base offset —
  // the main model pays the backend overhead once. ctx itself was picked against the
  // UNdiminished budget just above (one pass, no iteration): that leaves the ctx choice
  // slightly optimistic, which the spawn probe-and-back-off nets. A CPU-only box (budget 0)
  // has no GPU to charge, so the term is a no-op there.
  // We emit no `-ngld`, whose default is `auto` (read from the installed b10068 `--help`;
  // upstream's server README agrees), so the engine sizes the draft's offload itself. Charge
  // ALL its bytes anyway: over-reserving costs a main expert layer at worst, under-reserving
  // is what OOMs. The same build shows NO draft-specific context flag, so the draft rides our
  // chosen ctx.
  let draftMarginalMb = 0.0;
  let draftFullMb = 0.0;
  if (draftMeta != null && budgetMb > 0) {
    const dLayers = Math.max(1, draftMeta.blockCount);
    let dKv = typeof draftMeta.kvMbAtCtx === "function" ? draftMeta.kvMbAtCtx(ctxLen, cacheType) : null;
    if (dKv == null) {
      dKv = fit.kvExactMb({
        nLayers: dLayers,
        nKvHeads: draftMeta.nKvHeads || Math.max(1, floorDiv(draftMeta.embeddingLength, 128)),
        ctxSize: ctxLen,
        cacheType,
        keyLength: draftMeta.keyLength ?? 0,
        valueLength: draftMeta.valueLength ?? 0,
        embeddingDim: draftMeta.embeddingLength,
        headCount: draftMeta.headCount ?? 0,
      });
    }
    draftMarginalMb = draftBytes / fit.MIB + dKv;
    // Main fully on CPU → the draft is the GPU's only tenant and pays the backend overhead
    // itself (the base the main model would otherwise carry).
    draftFullMb = draftMarginalMb + overheadMb;
  }
  const mainBudgetMb = Math.max(0.0, budgetMb - draftMarginalMb);

  // THE SPLIT. Explicit overrides win untouched. The untuned two-pool MoE arm is Phase 6's
  // JOINT SOLVE (§5.7): ngl pinned at nLayers, the smallest ncmoe whose physics estimate fits
  // — replacing the regression inverse, which computed ngl 8-9 on models every measured tune
  // runs at ngl=all (§1.9: 10 of 13 rows pin ngl 99). Every other untuned arm (dense,
  // one-pool, MoE with a tuned ncmoe) checks physics-at-full-offload FIRST — the fitted
  // inverse's uniform KV projection overbooks iSWA models ~9× at big ctx and strands layers a
  // card holds (the §7.2 12B row: full offload on vram12 is the physics truth; the inverse
  // said 37) — and only falls back to the inverse when full offload genuinely doesn't fit
  // (partial dense offload stays the regression's fitted domain, §7.1).
  const joint = meta.isMoe && !onePool && ov.nGpuLayers == null && ov.nCpuMoe == null;
  let nGpu;
  let nCpuMoe;
  if (joint) {
    [nGpu, nCpuMoe] = fit.moeJointSplit({
      sizeMb: sizeMib,
      nLayers,
      expertShare,
      kvMb,
      overheadMb,
      budgetMb: mainBudgetMb,
      needFn: exact ? needMib : null,
    });
  } else {
    if (ov.nGpuLayers != null) {
      nGpu = Math.max(0, Math.min(nLayers, ov.nGpuLayers));
    } else {
      const ncPinned = ov.nCpuMoe != null ? Math.max(0, ov.nCpuMoe) : 0;
      const fullMb = needMib(nLayers, ncPinned);
      if (mainBudgetMb > 0 && fullMb <= mainBudgetMb) {
        nGpu = nLayers;
      } else {
        // oobabooga's fitted formula → the most GPU layers that fit.
        nGpu = fit.maxGpuLayers({
          sizeMb: sizeMib,
          nLayers,
          nKvHeads,
          embeddingDim: meta.embeddingLength,
          ctxSize: ctxLen,
          cacheType,
          vramBudgetMb: mainBudgetMb,
        });
      }
    }
    if (ov.nCpuMoe != null) {
      nCpuMoe = Math.max(0, ov.nCpuMoe);
    } else if (onePool) {
      // One pool: expert "offload" moves bytes from the pool to the pool — the Core Ultra 7
      // ncmoe sweep (0/8/16/24) measured it as pure loss and the seeded igpu tune pins 0.
      // The computed default agrees (§5.2).
      nCpuMoe = 0;
    } else {
      nCpuMoe = meta.isMoe ? Math.max(0, nLayers - nGpu) : 0;
    }
  }

  // GPU-resident VRAM for the chosen split. The VRAM arbiter reserves this (P2). A fully-CPU
  // load (nGpu == 0) touches no GPU (no CUDA context), so it reserves 0. A draft rides ON TOP:
  // the arbiter must reserve what the process actually holds, or a co-resident admission
  // over-books by the draft's size.
  //
  // THE ncmoe TERM (2026-07-24): `--n-cpu-moe` keeps the expert tensors of the first N layers
  // in system RAM; the booking scales the size term by `moeGpuSizeShare` (expert share from
  // the GGUF header; 0 → the exact old estimate) — Gemma 26B (ngl 30/ncmoe 21) used to reserve
  // 20.6 GB against a measured ~6.5 GB. The INVERSE split (`maxGpuLayers` above) deliberately
  // stays undiscounted (pushing MORE layers onto the GPU for an untuned MoE needs its own
  // measurement round). For iSWA models (Gemma 3/4) the header's per-layer facts give the
  // REAL KV size. Together on the real Gemma-4 26B (ngl 30/ncmoe 21/ctx 32k): 19.8 GB → ~7 GB
  // against a measured 6.5-7.9 GB. (history: process.py)
  let vramMb;
  if (nGpu > 0) {
    // PHYSICS BOOKING (fit-redesign Phase 1, §5.1): device weights (placement share) + exact
    // KV riding the offloaded layers + the backend overhead seed — the fitted regression stays
    // as the CI oracle (§7.1) and as the partial-dense inverse above.
    let booked = needMib(nGpu, nCpuMoe);
    if (onePool) {
      // THE ONE-POOL RULING (2026-08-13, "your rec go"): the ledger tracks POOL occupancy, so
      // the booking's ceiling is the pool — the same denominator Phase 4 gave the arbiter (the
      // old ceiling, the iGPU carve-out, booked ~0 and admission never engaged).
      booked = Math.min(booked, hardware.budgetTotalMb(hw));
    }
    vramMb = Math.trunc(booked + draftMarginalMb);
  } else if (draftFullMb > 0) {
    // Main fell fully to CPU, but the draft still lands on the GPU — it is then the ONLY
    // tenant, so it pays the base offset itself (full estimate, not marginal).
    vramMb = Math.trunc(draftFullMb);
  } else {
    vramMb = 0;
  }

  return new FitPlan({
    nGpuLayers: nGpu,
    nCpuMoe,
    ctxLen,
    blockCount: nLayers,
    isMoe: meta.isMoe,
    vramMb,
    nglExplicit: ov.nGpuLayers != null,
    ncmoeExplicit: ov.nCpuMoe != null,
    ctxExplicit,
  });
}

/**
 * Build the llama-server argv (after the exe) from the resolved engine overrides.
 * `nGpuLayers` is the kit's value; the EMITTED flag goes through `engineNglFlag` (full
 * offload renders blockCount + 1; 0 = render unchanged). The base + type (moe|dense) flag
 * defaults (flash-attn, KV cache type, mlock, spec-decode, …) arrive in `overrides` already —
 * resolved from the DB `switch_presets` by the runner's switches_fn — so there is no manifest
 * preset to merge here. We render the overrides + fit knobs via the shared
 * `overridesToPairs`→`renderArgv`, the SAME normalized pairs the router `.ini` emitter
 * renders (via `renderIni`), so the spawn argv and the `.ini` section can never drift.
 */
export function composeFlags(ggufPath, opts = {}) {
  requireFields("composeFlags", opts, ["nGpuLayers", "nCpuMoe", "ctxLen"]);
  const {
    nGpuLayers,
    nCpuMoe,
    ctxLen,
    host = DEFAULT_HOST,
    port = DEFAULT_PORT,
    extra = [],
    overrides = null,
    blockCount = 0,
    engineBuild = "",
  } = opts;
  const ov = asOverrides(overrides);
  const flags = renderArgv(
    overridesToPairs(ov, { nGpuLayers: engineNglFlag(nGpuLayers, blockCount), nCpuMoe, ctxLen, engineBuild }),
  );
  flags.push("-m", String(ggufPath), "--host", host, "--port", pyStr(port));
  flags.push(...(ov.extraFlags ?? [])); // raw passthrough (the "new flag, no code" escape), verbatim
  flags.push(...extra);
  return flags;
}

// ─── Failure classifiers ─────────────────────────────────────────────────────────────

export function _looksLikeOom(text) {
  const t = (text || "").toLowerCase();
  return ["out of memory", "cudamalloc", "cuda error", "failed to allocate", "oom"].some((s) => t.includes(s));
}

/**
 * The MTP/speculative-decode draft-load crash (2026-07-12): llama.cpp's router crashes the
 * DRAFT model ('invalid vector subscript') when it loads beside another LOADING/active child
 * — the co-load bug. The signature is the router's own 'failed to load draft model' line;
 * the load backoff recovers by loading the draft-carrying model solo (co-residents unloaded),
 * never losing speculative decoding.
 */
export function _looksLikeDraftFailure(text) {
  return (text || "").toLowerCase().includes("failed to load draft model");
}

/**
 * A load failure that re-emitting the model with EXPLICIT placement cannot fix — so the 1b-F4
 * fit-placed retry must fail fast rather than restart the engine (a bounce that knocks down +
 * reloads every healthy co-resident model) for nothing. The signatures are llama.cpp's own
 * stderr, verified 2026-07-21 against the master source (llama.cpp is NOT vendored —
 * re-verify at an engine bump):
 *   - "error: invalid argument:" — common/arg.cpp raises std::invalid_argument("error:
 *     invalid argument: %s") on an unrecognized flag; a rejected `--ngl` prints "error:
 *     invalid argument: --ngl" (github.com/ggml-org/llama.cpp/issues/23739).
 *   - "error while handling argument" — common/arg.cpp raises 'error while handling argument
 *     "%s": %s' when a known flag's value is rejected.
 *   - "unknown model architecture" — the loader emits "unknown model architecture: '<name>'"
 *     for an arch this build doesn't know (github.com/ggml-org/llama.cpp/issues/21320).
 * A bad extraFlags passthrough re-sends identically, so the retry can't fix it. Kept TIGHT: a
 * false NEGATIVE is only today's single bounce; a false POSITIVE cannot wrongly refuse a
 * #18066 fixable fit-bug (the fit vs explicit-retry argv differ ONLY by added ngl/ncmoe lines,
 * and all three signatures are parse-/load-time errors independent of placement), so bare
 * "invalid argument" (also a CUDA runtime error, not an arg reject) is NOT matched.
 */
export function _looksLikeUnfixable(text) {
  const t = (text || "").toLowerCase();
  return ["error: invalid argument:", "error while handling argument", "unknown model architecture"].some((s) =>
    t.includes(s),
  );
}

// ─── Process helpers ─────────────────────────────────────────────────────────────────

/**
 * `proc.poll()`: null while the process runs, else its exit code as Python reports it —
 * Windows codes unsigned 32-bit (3221225781, not -1073741515), a signal as −signo.
 * Candidate for platform/ (procs.js has the same conversion, unexported).
 */
export function pollProc(proc) {
  if (proc?.exitCode != null) return process.platform === "win32" ? proc.exitCode >>> 0 : proc.exitCode;
  if (proc?.signalCode) return -(os.constants.signals[proc.signalCode] ?? 1);
  return null;
}

/**
 * `proc.wait(timeout)`: resolves the exit code once the process has ended, or null when
 * `timeoutS` (seconds; null = no limit) passes first. A fake without events resolves its
 * current state. Candidate for platform/.
 */
export function waitExit(proc, timeoutS = null) {
  const rc = pollProc(proc);
  if (rc !== null || typeof proc?.once !== "function") return Promise.resolve(rc);
  return new Promise((resolve) => {
    let t = null;
    const onExit = () => {
      if (t) clearTimeout(t);
      resolve(pollProc(proc));
    };
    proc.once("exit", onExit);
    if (timeoutS != null) {
      t = setTimeout(() => {
        proc.removeListener("exit", onExit);
        resolve(null);
      }, timeoutS * 1000);
    }
  });
}

export async function _defaultHealth(url) {
  try {
    const r = await http.fetch(`${url}/health`, { timeoutMs: 2000 });
    await r.body?.cancel().catch(() => {});
    return r.status === 200;
  } catch {
    return false; // any failure means not-yet-healthy
  }
}

// child → a promise that settles once its output has all been written (log) or captured.
const outputDone = new WeakMap();
const CAPTURE_MAX = 1024 * 1024; // chars of merged output kept on the pipe path (the tail)

function appendCaptured(proc, text) {
  if (!text) return;
  let t = (proc.capturedOutput || "") + text;
  if (t.length > CAPTURE_MAX) t = t.slice(-CAPTURE_MAX);
  proc.capturedOutput = t;
}

/** Copy the child's stdout + stderr into `logPath` (appending), or into
 * `proc.capturedOutput` when there is no log. A fake without streams is left alone. */
function wireOutput(proc, logPath) {
  const sources = [proc?.stdout, proc?.stderr].filter((s) => s && typeof s.on === "function");
  if (!sources.length) return;
  let out = null;
  let closed = Promise.resolve();
  if (logPath) {
    out = createWriteStream(String(logPath), { flags: "a" });
    closed = new Promise((resolve) => out.once("close", resolve));
    let warned = false;
    out.on("error", (e) => {
      if (!warned) log.warning(`writing the engine log ${logPath} failed: ${e.message}`);
      warned = true;
    });
  } else {
    proc.capturedOutput = proc.capturedOutput || "";
  }
  let open = sources.length;
  const done = new Promise((resolve) => {
    for (const s of sources) {
      const dec = out ? null : new StringDecoder("utf8");
      s.on("data", (d) => {
        if (out) out.write(d);
        else appendCaptured(proc, dec.write(d));
      });
      s.on("error", () => {}); // a broken pipe ends the copy; 'close' still follows
      s.once("close", () => {
        if (dec) appendCaptured(proc, dec.end());
        open -= 1;
        if (open === 0) {
          if (out) {
            out.end();
            closed.then(resolve);
          } else resolve();
        }
      });
    }
  });
  outputDone.set(proc, done);
}

/** Wait (≤ `ms`) until an EXITED child's output has reached its log — the child wrote the
 * file directly in Python, so the tail read right after the exit must not miss the last
 * chunks still in flight here. A running child is not waited for. */
async function settleOutput(proc, ms = 2000) {
  const done = outputDone.get(proc);
  if (!done || pollProc(proc) === null) return;
  await withTimeout(done, ms).catch(() => {});
}

/**
 * Python's `proc.communicate(timeout=2)` on the pipe path: the merged output once the
 * process has ended and its pipes have closed; "" if that doesn't happen within 2 s (a hang —
 * Python's TimeoutExpired was swallowed into "" too). A fake returns its `capturedOutput`.
 */
export async function _drain(proc) {
  try {
    const done = outputDone.get(proc);
    if (done) await withTimeout(done, 2000);
    return proc?.capturedOutput || "";
  } catch {
    return ""; // still running / no pipe
  }
}

/** Last ~maxLines of the redirected llama-server log (lenient decode). Synchronous: a
 * per-load log is small. */
export function _tailFile(path, maxLines = 40) {
  let text;
  try {
    text = readFileSync(String(path)).toString("utf8");
  } catch {
    return ""; // no log yet / unreadable → empty tail
  }
  return splitlines(text).slice(-maxLines).join("\n");
}

/** kill + wait (Python's `_kill`): never throws. */
export async function _kill(proc) {
  try {
    proc.kill("SIGKILL");
  } catch {
    /* already gone */
  }
  try {
    await waitExit(proc);
  } catch {
    /* nothing to wait for */
  }
}

/** The last `n` characters (code points, as Python slices a str). */
function tailChars(s, n) {
  const cps = [...(s || "")];
  return cps.length > n ? cps.slice(-n).join("") : s || "";
}

// ── The Windows orphan-child fix (model-per-hardware plan Phase 4 + amendment A3) ──
// On-box incident (2026-07-06): stopping the JW server ORPHANED its llama-server child on
// Windows — :8080 survived, serving a stale generated ini. A Job Object with
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE ties the child's lifetime to the job HANDLE: when the
// parent dies (or stop() closes the handle), the OS kills the child. The handle is RETAINED
// on the returned ServerHandle, and every spawn goes through the ONE `_spawnChild` seam below
// (A3: four ad-hoc spawn sites would each need this wiring and would drift).
//
// In Node the seam is not optional (kit register §2, "Process trees on Windows"; JustVoice
// plan §1.1, measured 2026-10-07): Node puts its children in libuv's own kill-on-close job,
// but that job sets SILENT_BREAKAWAY_OK, so a GRANDCHILD — every per-model child llama-server's
// router starts — survived a hard kill of the server. With this job the whole tree died in
// every case measured (hard kill of Electron main, of the server, of the headless server,
// and app.quit()).
export const _KILL_ON_JOB_CLOSE = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
export const _JOB_EXTENDED_INFO_CLASS = 9; // JobObjectExtendedLimitInformation
// JOBOBJECT_EXTENDED_LIMIT_INFORMATION on 64-bit Windows: BASIC (LARGE_INTEGER×2 · DWORD
// LimitFlags · SIZE_T×2 · DWORD · ULONG_PTR Affinity · DWORD×2) + IO_COUNTERS (6×ULONGLONG,
// inline) + 4×SIZE_T = 144 bytes, LimitFlags at offset 16 (the layout process.py
// web-verified against golang/sys and windows-rs; the buffer form measured in the step-0
// spike). Electron ships 64-bit only.
const JOB_INFO_SIZE = 144;
const LIMIT_FLAGS_AT = 16;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_TERMINATE = 0x0001;

let k32 = null;
/** kernel32's job functions through koffi, bound once (Windows only; throws elsewhere). */
export function _kernel32() {
  if (k32) return k32;
  const require = createRequire(import.meta.url);
  const koffi = require("koffi");
  const lib = koffi.load("kernel32.dll");
  k32 = {
    CreateJobObjectW: lib.func("CreateJobObjectW", "void *", ["void *", "void *"]),
    SetInformationJobObject: lib.func("SetInformationJobObject", "bool", ["void *", "int", "void *", "uint32"]),
    OpenProcess: lib.func("OpenProcess", "void *", ["uint32", "bool", "uint32"]),
    AssignProcessToJobObject: lib.func("AssignProcessToJobObject", "bool", ["void *", "void *"]),
    CloseHandle: lib.func("CloseHandle", "bool", ["void *"]),
  };
  return k32;
}

/**
 * Enclose a freshly-spawned child in a kill-on-close Job Object (win32 only). Returns the
 * job handle to retain, or null (off-Windows, or on ANY failure — the job is a safety net; it
 * must never block a spawn).
 *
 * Python passed CPython's process HANDLE; Node exposes only the pid, so the process is opened
 * by pid (PROCESS_SET_QUOTA | PROCESS_TERMINATE — what AssignProcessToJobObject needs) right
 * after the spawn, and that process handle is closed again (the job keeps its own reference).
 * As in Python, a grandchild the child starts BEFORE this assignment is outside the job;
 * llama-server's router starts its children only on a model load, long after.
 */
export function _winJobForChild(proc) {
  if (cfg.platform !== "win32") return null;
  try {
    const pid = proc?.pid;
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const k = self._kernel32();
    const job = k.CreateJobObjectW(null, null);
    if (!job) return null;
    const info = Buffer.alloc(JOB_INFO_SIZE);
    info.writeUInt32LE(_KILL_ON_JOB_CLOSE, LIMIT_FLAGS_AT);
    if (!k.SetInformationJobObject(job, _JOB_EXTENDED_INFO_CLASS, info, JOB_INFO_SIZE)) {
      k.CloseHandle(job);
      return null;
    }
    const h = k.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid);
    if (!h) {
      k.CloseHandle(job);
      return null;
    }
    let ok = false;
    try {
      ok = k.AssignProcessToJobObject(job, h);
    } finally {
      k.CloseHandle(h);
    }
    if (!ok) {
      k.CloseHandle(job);
      return null;
    }
    return job;
  } catch {
    return null; // a safety net must never block a spawn
  }
}

// Jobs already closed: a second CloseHandle on the same value could close whatever handle
// Windows has since reused that number for (another child's job → that child dies).
const closedJobs = new WeakSet();

/** Close a retained job handle (kills the enclosed tree under KILL_ON_JOB_CLOSE). No-op
 * off-Windows / on null / on any failure / when already closed. */
export function _closeJob(job) {
  if (job == null || cfg.platform !== "win32") return;
  if (typeof job === "object") {
    if (closedJobs.has(job)) return;
    closedJobs.add(job);
  }
  try {
    self._kernel32().CloseHandle(job);
  } catch {
    /* nothing to close */
  }
}

// A spawn that fails because the OS cannot SEE a binary we know is on disk is retried: on
// Windows a freshly installed engine is routinely still held by the real-time virus scanner,
// and CreateProcess then answers ERROR_FILE_NOT_FOUND (2) or ERROR_ACCESS_DENIED (5) for a
// file that exists and runs fine a moment later. Measured 2026-08-03 on the i18n app: Quick
// Setup installed b9993, the load fired, and CreateProcess raised WinError 2 against
// …\b9993\cuda12\llama-server.exe — a path that existed, whose exe ran by hand, and whose
// router started normally on the next attempt.
export const _SPAWN_ATTEMPTS = 4;
export const _SPAWN_RETRY_SECONDS = 0.6;
export const _TRANSIENT_SPAWN_WINERRORS = new Set([2, 5]); // not found / access denied

// Node reports libuv's code, not the Windows error: libuv maps ERROR_FILE_NOT_FOUND (and
// PATH_NOT_FOUND, INVALID_NAME, …) to ENOENT and ERROR_ACCESS_DENIED to EPERM (EACCES covers
// the other access errors). So "not found" here is ENOENT, "access denied" EPERM/EACCES — a
// little wider than Python's two numbers; a wrongly retried case only delays an honest error.
const WINERROR_OF_CODE = { ENOENT: 2, EPERM: 5, EACCES: 5 };

function winerrorOf(e) {
  if (typeof e?.winerror === "number") return e.winerror;
  return WINERROR_OF_CODE[e?.code] ?? null;
}

/** Python's `except OSError`: a system error (errno / syscall), never a programming error. */
function isOsError(e) {
  return (
    e instanceof FileNotFoundError ||
    typeof e?.errno === "number" ||
    typeof e?.winerror === "number" ||
    typeof e?.syscall === "string"
  );
}

/** A spawn failure worth retrying rather than reporting. Windows only: on POSIX a missing
 * exe is a missing exe, and retrying would only delay an honest error. */
export function _isTransientSpawnError(e) {
  if (cfg.platform !== "win32") return false;
  return _TRANSIENT_SPAWN_WINERRORS.has(winerrorOf(e));
}

/** Resolve once the OS has started `proc`, or throw the spawn error. Node reports ENOENT /
 * EACCES as an 'error' event on the next tick (pid unset) and throws the rest at once. */
function confirmSpawned(proc) {
  if (proc == null || typeof proc.once !== "function" || typeof proc.pid === "number") return Promise.resolve();
  return new Promise((resolve, reject) => {
    proc.once("spawn", resolve);
    proc.once("error", reject);
  });
}

/**
 * The ONE spawn seam every llama-server child goes through (A3): the shared stdout/stderr
 * wiring + the Windows Job Object enclosure. Resolves `[proc, jobHandle]` — the caller stores
 * the handle on its ServerHandle (and closes it with `closeJob` when it stops the child).
 *
 * `popen(argv, opts)` starts the program — `procs.popen` (no console to inherit) or a wrapper
 * adding the caller's own options, e.g. JustVoice's speech runtime:
 * `(argv, opts) => procs.popen(argv, { ...opts, cwd, env })`. The seam passes
 * `{stdio: ["ignore", "pipe", "pipe"]}` and copies both pipes into `logPath` (appending), or
 * into `proc.capturedOutput` when `logPath` is null.
 *
 * Throws `RunnerStartError` — never a bare system error — when the binary cannot be
 * launched. That matters upstream: `_spawn_router_with_fallback` chains across the OTHER
 * installed backends on RunnerStartError, so an OS error escaping here both skipped that
 * chain and reached the user as a raw "[WinError 2] The system cannot find the file
 * specified", which says nothing about what to do next. `_sleep(seconds)` is the retry wait
 * (a test injection point).
 */
export async function _spawnChild(popen, argv, logPath = null, { _sleep = sleepS } = {}) {
  const start = popen ?? ((a, o) => procs.popen(a, o));
  let last = null;
  for (let attempt = 0; attempt < _SPAWN_ATTEMPTS; attempt++) {
    try {
      const proc = start(argv, { stdio: ["ignore", "pipe", "pipe"] });
      await confirmSpawned(proc);
      // The job FIRST: the sooner the child is enclosed, the less it can start outside it.
      const job = self._winJobForChild(proc);
      if (typeof proc?.on === "function") {
        // A later error (a failed kill) must not become an unhandled 'error' event.
        proc.on("error", (e) => log.debug(`${argv[0]}: ${e?.message ?? e}`));
      }
      wireOutput(proc, logPath);
      if (attempt) {
        log.info(`spawned ${argv[0]} on attempt ${attempt + 1} (${attempt} earlier attempt(s) could not see it)`);
      }
      return [proc, job];
    } catch (e) {
      if (!isOsError(e)) throw e;
      last = e;
      if (!self._isTransientSpawnError(e) || attempt === _SPAWN_ATTEMPTS - 1) break;
      log.warning(
        `spawn of ${argv[0]} failed (${e?.message ?? e}) — retrying in ${(_SPAWN_RETRY_SECONDS * (attempt + 1)).toFixed(1)}s`,
      );
      await _sleep(_SPAWN_RETRY_SECONDS * (attempt + 1));
    }
  }
  const exe = argv?.length ? String(argv[0]) : "?";
  const onDisk = exe !== "?" && existsSync(exe);
  throw new RunnerStartError(
    `Couldn't start the engine binary (${last?.message ?? last}). Path: ${exe} — ` +
      (onDisk
        ? "the file IS on disk, so this is usually a virus scanner still holding a freshly installed binary. Try again in a moment."
        : "that file is missing — reinstall the engine from the AI page."),
    { cause: last },
  );
}

// The same seam for the family's OTHER native runtimes (JustVoice's audio.cpp speech server,
// 2026-10-01): one spawn path, one kill-on-parent-death enclosure, one virus-scanner retry —
// never a second copy in an app.
export const spawnChild = _spawnChild;
export const closeJob = _closeJob;

// ─── The live server handles ─────────────────────────────────────────────────────────

/**
 * A live llama-server process (OpenAI-compatible at `url`) — the ONE process-handle surface
 * (`isAlive`/`health`/`stop`) shared by the single-model `Runner` and the multi-model
 * `RouterHandle` (so the aliveness/health/terminate logic has a single source).
 * Fields: `process`, `url`, `jobHandle` (the retained Windows Job Object; null off-win32).
 */
export class ServerHandle {
  constructor(fields = {}) {
    requireFields(new.target.name, fields, ["process", "url"]);
    this.process = fields.process;
    this.url = fields.url;
    this.jobHandle = fields.jobHandle ?? null;
  }

  isAlive() {
    return pollProc(this.process) === null;
  }

  /** GET /health answered 200 (async). */
  health() {
    return self._defaultHealth(this.url);
  }

  /** Terminate the process and close the job — the job (win32) guarantees the whole child
   * tree dies with it. Non-blocking, as Python's. */
  stop() {
    try {
      this.process.kill();
    } catch {
      /* already gone */
    }
    self._closeJob(this.jobHandle);
  }
}
export { ServerHandle as _ServerHandle };

/** A single-model `llama-server` spawn — the shared handle surface + the resolved GPU split
 * it was launched with. */
export class Runner extends ServerHandle {
  constructor(fields = {}) {
    super(fields);
    requireFields("Runner", fields, ["nGpuLayers", "nCpuMoe"]);
    this.nGpuLayers = fields.nGpuLayers;
    this.nCpuMoe = fields.nCpuMoe;
  }
}

/**
 * A `llama-server` in ROUTER mode (multi-model; routes by model id). Distinct from `Runner`
 * (a single-model spawn): the router owns N child servers, so it carries no per-model
 * ngl/offload — those live per section in the emitted `.ini`. It is exactly the shared
 * ServerHandle surface, so the service treats router and single-model spawns uniformly.
 */
export class RouterHandle extends ServerHandle {}

export async function _waitUntilHealthy(proc, url, timeout, health, sleepFn, now) {
  const deadline = now() + timeout;
  while (now() < deadline) {
    if (pollProc(proc) !== null) return false; // exited before it ever became healthy
    if (await health(url)) return true;
    await sleepFn(0.5);
  }
  return false;
}

/** Make the log's folder and start it empty (Python's `open(log_path, "wb")`; each spawn
 * then appends). */
function freshLog(logPath) {
  if (!logPath) return;
  mkdirSync(dirname(String(logPath)), { recursive: true });
  writeFileSync(String(logPath), "");
}

/** Why a failed spawn failed: the log's tail (once an exited child's output has landed) or
 * the drained pipe. */
async function failureOutput(proc, rc, logPath) {
  if (logPath) {
    if (rc !== null) await settleOutput(proc);
    return self._tailFile(logPath);
  }
  return _drain(proc);
}

/**
 * Spawn llama-server, wait for `/health`, shed GPU layers on CUDA-OOM.
 *
 * Resolves a live `Runner`. Throws `RunnerStartError` if it can't become healthy for a
 * non-OOM reason (or after backing off to 0 GPU layers) — the error carries the process exit
 * status (null = still running, killed on the health timeout = a hang; a number = it exited
 * on its own, e.g. Windows 3221225781 / 0xC0000135 = a DLL failed to load) plus the tail of
 * the log. When `logPath` is set, llama-server's merged stdout+stderr goes to that file
 * (survives a hang/crash/kill and is tailed on failure); otherwise it is captured from the
 * pipes. `_popen`/`_health`/`_sleep` (seconds)/`_now` (seconds) are injection points for
 * tests.
 */
export async function startRunner(
  serverExe,
  ggufPath,
  fitPlan,
  {
    host = DEFAULT_HOST,
    port = DEFAULT_PORT,
    extraFlags = [],
    overrides = null,
    logPath = null,
    probeTimeout = 30.0,
    backoffStep = _BACKOFF_STEP,
    _popen = null,
    _health = null,
    _sleep = null,
    _now = null,
  } = {},
) {
  const popen = _popen ?? ((a, o) => procs.popen(a, o));
  const health = _health ?? ((u) => self._defaultHealth(u));
  const sleepFn = _sleep ?? sleepS;
  const now = _now ?? monotonic;
  const url = `http://${host}:${port}`;
  let nGpu = fitPlan.nGpuLayers;
  // The plan's own split, honored from attempt #1 (fit-redesign §1.7 hygiene: the old
  // per-attempt `blockCount - ngl` formula silently discarded the computed ncmoe on the FIRST
  // spawn and reduced expert offload on every shed).
  let nCpuMoe = fitPlan.isMoe ? fitPlan.nCpuMoe : 0;
  // One log for the whole load: the sequential OOM-backoff attempts append into the same
  // per-load file.
  freshLog(logPath);
  for (;;) {
    const flags = composeFlags(ggufPath, {
      nGpuLayers: nGpu,
      nCpuMoe,
      ctxLen: fitPlan.ctxLen,
      host,
      port,
      extra: extraFlags,
      overrides,
      blockCount: fitPlan.blockCount,
    });
    log.info(`spawning llama-server: ngl=${nGpu} n_cpu_moe=${nCpuMoe} ctx=${fitPlan.ctxLen}`);
    const [proc, job] = await self._spawnChild(popen, [String(serverExe), ...flags], logPath);
    if (await _waitUntilHealthy(proc, url, probeTimeout, health, sleepFn, now)) {
      return new Runner({ process: proc, url, nGpuLayers: nGpu, nCpuMoe, jobHandle: job });
    }

    // Capture WHY before killing: poll() is null for a hang (still alive at the deadline) or
    // the self-exit code if it died on its own.
    const rc = pollProc(proc);
    const output = await failureOutput(proc, rc, logPath);
    await _kill(proc);
    self._closeJob(job); // a failed spawn's job dies with its child
    // SHED DIRECTION (fit-redesign §5.7): a MoE OOM raises nCpuMoe first — each step frees an
    // expert layer's bytes (~0.45 GB on the 26B) while keeping attention + KV on the GPU;
    // shedding ngl moves those too and is strictly worse per retry. ngl sheds only once ncmoe
    // is maxed (or the model is dense).
    if (_looksLikeOom(output)) {
      if (fitPlan.isMoe && nCpuMoe < fitPlan.blockCount) {
        nCpuMoe = Math.min(fitPlan.blockCount, nCpuMoe + backoffStep);
        log.warning(`llama-server OOM — raising n-cpu-moe to ${nCpuMoe} (ngl stays ${nGpu})`);
        continue;
      }
      if (nGpu > 0) {
        nGpu = Math.max(0, nGpu - backoffStep);
        log.warning(`llama-server OOM — backing off to ngl=${nGpu}`);
        continue;
      }
    }
    const status = rc === null ? "still running, killed on timeout" : `exit ${rc}`;
    const where = logPath ? `  [log: ${logPath}]` : "";
    throw new RunnerStartError(
      `llama-server failed to become healthy (ngl=${nGpu}, ${status}): ${tailChars(output, 1000)}${where}`,
    );
  }
}

/**
 * Spawn llama-server in ROUTER mode (no `-m`; it loads models by id from the
 * `--models-preset` `.ini`) and wait for `/health`.
 *
 * Unlike `startRunner` there is **NO OOM back-off here** — the router process itself loads
 * no weights; each CHILD fits independently from its `.ini` section, so a child's CUDA-OOM is
 * recovered at the SERVICE level (re-emit that model's section at a lower `ngl` + reload), not
 * by shedding layers on the router. Throws `RunnerStartError` if the router never becomes
 * healthy. `_popen`/`_health`/`_sleep`/`_now` are test injection points (the router spawn is
 * not runnable in CI).
 */
export async function startRouter(
  serverExe,
  {
    modelsDir,
    modelsPreset,
    modelsMax = 2,
    sleepIdleSeconds = null,
    host = DEFAULT_HOST,
    port = DEFAULT_PORT,
    logPath = null,
    probeTimeout = 60.0,
    _popen = null,
    _health = null,
    _sleep = null,
    _now = null,
  } = {},
) {
  const popen = _popen ?? ((a, o) => procs.popen(a, o));
  const health = _health ?? ((u) => self._defaultHealth(u));
  const sleepFn = _sleep ?? sleepS;
  const now = _now ?? monotonic;
  const url = `http://${host}:${port}`;
  const argv = composeRouterArgv({ modelsDir, modelsPreset, modelsMax, sleepIdleSeconds, host, port });
  freshLog(logPath);
  log.info(`spawning llama-server router: models_max=${modelsMax} sleep_idle=${pyStr(sleepIdleSeconds)}`);
  const [proc, job] = await self._spawnChild(popen, [String(serverExe), ...argv], logPath);
  if (await _waitUntilHealthy(proc, url, probeTimeout, health, sleepFn, now)) {
    return new RouterHandle({ process: proc, url, jobHandle: job });
  }
  const rc = pollProc(proc);
  const output = await failureOutput(proc, rc, logPath);
  await _kill(proc);
  self._closeJob(job); // a failed spawn's job dies with its child
  const status = rc === null ? "still running, killed on timeout" : `exit ${rc}`;
  const where = logPath ? `  [log: ${logPath}]` : "";
  throw new RunnerStartError(`llama-server router failed to become healthy (${status}): ${tailChars(output, 1000)}${where}`);
}
