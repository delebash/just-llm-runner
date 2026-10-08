// SPDX-License-Identifier: MIT
// The shared LLM-runner REST surface (`/v1/llm-runner/*`) — the port of
// llm_runner/runner/api.py (Python's `llm_runner.router`, which every app mounts).
//
// Every app registers this plugin so the GUI talks to an identical API:
//     app.register(runnerRouter)
//
// Manifest + detected hardware, the model catalog with Fit + speed band + live status, the
// load / download / stop lifecycle, the engine (llama.cpp binary) install, and the disk
// reclaims. The auto-tune and speed-check routes live in autotune.js / calibrate.js.
//
// ── The JS shape ────────────────────────────────────────────────────────────────────────
// Python's handlers called the service synchronously; here every service call is awaited, so
// the lifecycle port may make any of them async. The hardware probe (`hardware.detect`) is
// async and — as in Python — runs afresh on every request that needs it. Both are reached
// through their module namespaces (`hardware.detect()`, `lifecycle.getService()`), so a test
// replaces them with `vi.spyOn` where the Python tests patched `api.detect` /
// `api.get_service`.
//
// The runner's models are pydantic CamelModels with `populate_by_name=True`: a body field may
// arrive under its snake_case NAME as well as its camelCase alias (`{"model_id": "x"}` loads
// "x"), and a dict the service returns may use either. `populateByName` reproduces that
// before validation (bodies) and before the response model (resident); with BOTH spellings
// present the snake one stays an unknown field, as pydantic answers (422 extra_forbidden).

import path from "node:path";
import { HttpError, RequestValidationError } from "../platform/errors.js";
import { getLogger } from "../platform/log.js";
import { model, opt, strictObject, T } from "../platform/models.js";
import { pyFloatParse, pyInt, pyRound, pyStr, truthy } from "../platform/py.js";
import { dictBody } from "./autotune.js";
import * as bandwidth from "./bandwidth.js";
import * as fit from "./fit.js";
import * as hardware from "./hardware.js";
import * as lifecycle from "./lifecycle.js";
import * as models from "./models.js";
import { Overrides } from "./process.js";
import {
  DownloadCancelRequest,
  HardwareInfo,
  LoadRequest,
  RunnerConfig,
  RunnerModelsResponse,
  RunnerResidentResponse,
} from "./schema.js";

const log = getLogger("llm_runner.runner.api");

// ─── Small pydantic / Python helpers (candidates for platform/) ──────────────────

/**
 * pydantic's bool from a query string: 1/0, true/false, yes/no, on/off, t/f, y/n (any case,
 * no surrounding space). Anything else is the 422 pydantic gives, at `loc`. Candidate for
 * platform/.
 */
export function pyBool(raw, loc) {
  if (raw === undefined || raw === null) return raw;
  if (typeof raw === "boolean") return raw;
  const s = String(raw).toLowerCase();
  if (["1", "true", "yes", "on", "t", "y"].includes(s)) return true;
  if (["0", "false", "no", "off", "f", "n"].includes(s)) return false;
  throw new RequestValidationError([
    { loc, msg: "Input should be a valid boolean, unable to interpret input", type: "bool_parsing" },
  ]);
}

/** pydantic's `to_camel` for a snake_case field name (`n_gpu_layers` → `nGpuLayers`). */
export function toCamel(name) {
  if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(name)) return name;
  return name.replace(/_([a-z0-9])/g, (_m, c) => c.toUpperCase());
}

/**
 * `populate_by_name=True`: rename each snake_case field NAME the schema declares (as its
 * camelCase alias) to that alias, recursively — unless the alias is present too, in which
 * case the snake key stays (and a strict model rejects it, as pydantic does). Key order is
 * kept. Candidate for platform/models.js.
 */
export function populateByName(schema, value) {
  if (!schema || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return schema.type === "array" && schema.items ? value.map((x) => populateByName(schema.items, x)) : value;
  }
  if (schema.anyOf) {
    const branch = schema.anyOf.find((b) => b.type === "object");
    return branch ? populateByName(branch, value) : value;
  }
  if (schema.type === "object" && schema.properties) {
    const props = schema.properties;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      let key = k;
      if (!Object.hasOwn(props, k)) {
        const camel = toCamel(k);
        if (camel !== k && Object.hasOwn(props, camel) && !Object.hasOwn(value, camel)) key = camel;
      }
      out[key] = Object.hasOwn(props, key) ? populateByName(props[key], v) : v;
    }
    return out;
  }
  if (schema.patternProperties) {
    const s = Object.values(schema.patternProperties)[0];
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, populateByName(s, v)]));
  }
  return value;
}

/** A route's `preValidation` hook applying `populateByName` to the body. */
const bodyByName = (schema) => async (req) => {
  if (req.body && typeof req.body === "object") req.body = populateByName(schema, req.body);
};

/** `d.get(k, dflt)` — a present-but-null value stays null. */
const get = (obj, k, dflt) => (obj != null && Object.hasOwn(obj, k) ? obj[k] : dflt);

// ─── Models declared here (api.py's own) ─────────────────────────────────────────

/**
 * HardwareInfo + the two DERIVED tuning identities (2026-07-07, the debug ask): `machineKey`
 * is what `model_tunes` (the machine's own tunes) are stored under and `classKey` is what the
 * seeded/editable `class_tunes` layer matches on — served here so a debug surface can explain
 * exactly which tune layers apply to this box.
 */
export const HardwareWithKeys = strictObject({
  ...HardwareInfo.properties,
  machineKey: opt(T.String(), ""),
  classKey: opt(T.String(), ""),
});

/**
 * One process holding GPU memory. `own` = inside THIS server's process tree (our engine
 * subprocesses and model runners), so the reader can tell our footprint from everything else.
 */
export const GpuProcessRow = strictObject({
  pid: opt(T.Integer(), 0),
  name: opt(T.String(), ""),
  memMb: opt(T.Integer(), 0),
  own: opt(T.Boolean(), false),
});

/**
 * The breakdown behind the memory strip's "Other apps" cell.
 *
 * `available=false` is a first-class answer, never an empty list: AMD boxes have no
 * per-process arm (vendor tooling exposes device-wide use only) and localized Windows
 * localizes the counter names, so `reason` carries the sentence a UI should show instead of
 * rendering "nothing is using the GPU".
 *
 * `additive` says the rows are comparable to the device total rather than overlapping figures
 * that can exceed the card — true only because the Windows arm reads the `Local Usage`
 * counter (see hardware's `_GPU_PROC_COUNTER`). They still sum to slightly less than the card
 * holds: driver and desktop overhead belongs to no process. `source` distinguishes COVERAGE —
 * nvidia-smi sees compute workloads only; the Windows counters see graphics too.
 */
export const GpuProcessesResponse = strictObject({
  available: opt(T.Boolean(), false),
  reason: opt(T.String(), ""),
  source: opt(T.String(), ""),
  additive: opt(T.Boolean(), true),
  processes: opt(T.Array(GpuProcessRow), []),
});

// ─── The catalog view's helpers ──────────────────────────────────────────────────

let warnedCatalogUnwired = false;

/**
 * Once per process: this router is mounted but no host catalog was ever wired.
 *
 * Not an error — the runner is legitimately usable for hardware detection and engine install
 * alone — but it IS the difference between "nothing to download yet" and "downloading
 * anything is impossible here", and it was previously invisible.
 */
function warnCatalogUnwired() {
  if (!warnedCatalogUnwired) {
    warnedCatalogUnwired = true;
    log.warning(
      "llm-runner: /models is empty because no catalog source is wired. Call " +
        "configureService({catalogFn}) at boot (llm/install.js installLlm does " +
        "this for you), or the engine has nothing it can download or load.",
    );
  }
}

/**
 * Coarse pre-download Fit (no GGUF yet): computed from the model's params × quant vs detected
 * VRAM — or an explicit `recommendedFor.minVramMb` override when the manifest sets one (it can
 * encode MoE CPU-offload a raw weights estimate misses). Bands: ok ≤1.0, tight ≤1.5, else no;
 * no GPU → cpu (no only if RAM can't hold it). The precise per-layer fit needs the downloaded
 * GGUF (`computeFit`); the spawn OOM back-off is the final safety net.
 */
function modelFit(m, gpuVramMb, ramMb, marginMb) {
  return fit.coarseFit({
    totalParams: m.totalParams ?? null,
    quant: m.quant,
    vramMb: gpuVramMb,
    ramMb,
    marginMb,
    minVramOverride: m.recommendedFor?.minVramMb ?? null,
    minRamOverride: m.minRamMb ?? null,
  });
}

/**
 * The per-model byte facts the speed model and the bandwidth derivation share (fit-redesign
 * §5.5): bytes/pass split into non-expert + active-expert legs, plus the §13.11 KV scalars.
 * null for embeds (no decode-speed story) and for rows whose header was never read — those
 * get NO band, never a guess. Snake keys: bandwidth.js reads them so.
 */
export function _speedFacts(m) {
  const facts = m.physicsFacts || {};
  if (m.embedding || !m.sizeBytes || !facts.block_count) return null;
  // SPEED path: DECIMAL MB against decimal GB/s — deliberately not MiB (§6.4).
  let sizeMb = m.sizeBytes / 1e6;
  let nonExpert;
  let activeExpert;
  const layersNonexp = pyInt(facts.layers_nonexp_bytes || 0);
  if (layersNonexp > 0) {
    // EXACT per-token bytes (vram-truth §6.3): every block's non-expert weights + the output
    // head are read each token; the routed experts at used/total. The 26B: 1,387 + 803 MB —
    // the split the speed-check pass C validated.
    const exps = pyInt(facts.exps_bytes || 0);
    const used = pyInt(facts.expert_used_count || 0);
    const total = pyInt(m.experts || 0);
    nonExpert = (layersNonexp + pyInt(facts.output_bytes || 0)) / 1e6;
    activeExpert = exps && total > 0 ? (exps * (Math.min(used, total) / total)) / 1e6 : 0.0;
    sizeMb = nonExpert + exps / 1e6; // dense per-pass bytes (no input table)
  } else {
    [nonExpert, activeExpert] = fit.activeBytesPerPassMb({
      sizeMb,
      expertByteShare: pyFloatParse(facts.expert_byte_share || 0.0),
      expertsTotal: pyInt(m.experts || 0),
      expertUsed: pyInt(facts.expert_used_count || 0),
    });
  }
  return {
    n_layers: pyInt(facts.block_count || 0),
    mtp: !!m.mtp,
    size_mb: sizeMb,
    non_expert_mb: nonExpert,
    active_expert_mb: activeExpert,
    kv_facts: facts,
  };
}

// ─── The router ──────────────────────────────────────────────────────────────────

/** The runner router — a Fastify plugin (Python's module-level `router`). */
export async function runnerRouter(app) {
  app.get("/v1/llm-runner/config", async () => model(RunnerConfig, await (await lifecycle.getService()).config()));

  app.get("/v1/llm-runner/hardware", async () => {
    const hw = await hardware.detect();
    // Reading the hardware panel refreshes the detection the service and the tune keys use,
    // so a GPU or driver change shows without a restart (decided 2026-10-08 — Python
    // re-detected on every call; the service reads the stored result).
    hardware.setDetected(hw);
    return model(HardwareWithKeys, { ...hw, machineKey: hardware.machineKey(hw), classKey: hardware.classKey(hw) });
  });

  // Deliberately NOT wired into any poll. The probe is one shell-out for the whole machine
  // (not one per process), but the Windows counter arm takes ~1 s, so this is fetched when a
  // user opens the list and at no other time.
  app.get(
    "/v1/llm-runner/gpu-processes",
    { schema: { querystring: T.Object({ fresh: opt(T.String()) }) } },
    async (req) => {
      const fresh = pyBool(req.query.fresh, ["query", "fresh"]) ?? false;
      const snap = await hardware.gpuProcesses({ fresh });
      if (snap == null) {
        return model(GpuProcessesResponse, {
          available: false,
          reason:
            "This system has no per-process GPU memory counter. AMD tooling " +
            "reports device-wide use only, and Windows exposes the counters " +
            "under localized names on non-English installs.",
        });
      }
      return model(GpuProcessesResponse, {
        available: true,
        source: snap.source,
        additive: !!snap.additive,
        processes: snap.processes.map((r) => populateByName(GpuProcessRow, r)),
      });
    },
  );

  // The bundled-runner model catalog the GUI shows in the built-in provider's form: each
  // manifest model annotated with a coarse Fit (vs detected VRAM), whether its GGUF is
  // already cached, and the live load status. `vram_mb` overrides the detected VRAM so Quick
  // Setup's card chooser can re-score Fit for a card other than the one in this machine
  // (0 = CPU-only).
  app.get(
    "/v1/llm-runner/models",
    { schema: { querystring: T.Object({ vram_mb: opt(T.Integer()) }) } },
    async (req) => modelsView(req.query.vram_mb ?? null),
  );

  // ── Lifecycle: choose → load on demand → use ──────────────────────────────────

  // Load a model, optionally with Plane-1 engine overrides for tuning/testing (n_cpu_moe /
  // n_gpu_layers / ctx / KV-cache type / flags / …). Omitted fields fall back to the computed
  // Fit + the manifest's base preset. See docs/plans/2026-06-24-llamacpp-switches.md (Plane 1).
  app.post(
    "/v1/llm-runner/load",
    { schema: { body: LoadRequest }, preValidation: bodyByName(LoadRequest) },
    async (req) => {
      const body = req.body;
      if (!body.modelId) throw new HttpError(400, "modelId required");
      const overrides = new Overrides({
        nGpuLayers: body.nGpuLayers,
        nCpuMoe: body.nCpuMoe,
        ctxLen: body.ctxLen,
        cacheTypeK: body.cacheTypeK,
        cacheTypeV: body.cacheTypeV,
        flashAttn: body.flashAttn,
        noMmap: body.noMmap,
        mlock: body.mlock,
        noKvOffload: body.noKvOffload,
        batchSize: body.batchSize,
        ubatchSize: body.ubatchSize,
        threads: body.threads,
        threadsBatch: body.threadsBatch,
        parallel: body.parallel,
        contBatching: body.contBatching,
        contextShift: body.contextShift,
        cacheReuse: body.cacheReuse,
        specType: body.specType,
        specNMax: body.specNMax,
        modelDraft: body.modelDraft,
        reasoningBudget: body.reasoningBudget,
        reasoningBudgetMessage: body.reasoningBudgetMessage,
        extraFlags: [...(body.extraFlags || [])],
      });
      return (await lifecycle.getService()).load(body.modelId, {
        overrides,
        jobId: body.jobId,
        switches: body.switches,
        trigger: "api",
      });
    },
  );

  // Fetch a model's weights into the local cache WITHOUT loading it — the catalog's
  // 'Download' action, separate from 'Load'. Does not require the engine installed; the model
  // then reports as on-disk via /models. Any overrides in the body are ignored.
  app.post(
    "/v1/llm-runner/download",
    { schema: { body: LoadRequest }, preValidation: bodyByName(LoadRequest) },
    async (req) => {
      if (!req.body.modelId) throw new HttpError(400, "modelId required");
      return (await lifecycle.getService()).download(req.body.modelId);
    },
  );

  // Every in-flight/errored model download keyed by model id:
  // `{"downloads": {modelId: {status, modelId, detail, error, downloaded, total}}}`. Downloads
  // run concurrently, so a model absent from the map is idle on this channel.
  app.get("/v1/llm-runner/download/status", async () => (await lifecycle.getService()).downloadStatus());

  // Signal a download to stop at the next chunk boundary. With `modelId` → cancel just that
  // model's download; with no body / null → cancel ALL (the back-compat path). A queued
  // download cancels before it starts. Idempotent: unknown/idle ids are no-ops. Returns the
  // live download status — the cancelled row reads 'cancelling…' briefly, then leaves the map.
  app.post(
    "/v1/llm-runner/download/cancel",
    {
      schema: { body: DownloadCancelRequest },
      // `DownloadCancelRequest | None = None`: no body (or JSON null) is None — validated as
      // an empty request, which answers the same (cancel all).
      preValidation: async (req) => {
        if (req.body === undefined || req.body === null) req.body = {};
        else if (typeof req.body === "object") req.body = populateByName(DownloadCancelRequest, req.body);
      },
    },
    async (req) => (await lifecycle.getService()).cancelDownload(req.body.modelId || null),
  );

  // Back-compat SINGLE-model view (most-recently-loaded model's progress/state) — the existing
  // UI (catalog poller, QuickSetup, Tune modal) reads this shape. The full co-resident set is
  // /resident.
  app.get("/v1/llm-runner/status", async () => (await lifecycle.getService()).status());

  // The router's LIVE per-model status (loaded | sleeping | loading | failed) with each loaded
  // child's real footprint (`meta` sizes), plus `modelsMax` / `sleepIdleSeconds`. Router down →
  // `router: false`, empty set. The committed/remaining VRAM budget rides along (the arbiter).
  app.get("/v1/llm-runner/resident", async () => {
    const res = await (await lifecycle.getService()).resident();
    return model(RunnerResidentResponse, populateByName(RunnerResidentResponse, res));
  });

  // LAZY embed prep (P3): download-if-needed + load + PIN the embedding model the routing
  // default points at the bundled runner, so local RAG works out of the box. `{"ok": false}`
  // when no local embed is configured — the caller then uses that provider unchanged. The
  // load is ASYNC: poll `GET /v1/llm-runner/resident` for the returned `modelId` until it
  // reads loaded|sleeping before embedding.
  app.post("/v1/llm-runner/ensure-embedding", async () => (await lifecycle.getService()).ensureEmbedding());

  // With a modelId this unloads ONE resident model and frees its VRAM (the router stays up
  // for the others) — the catalog row's Unload button (user, 2026-07-07: "no way to unload").
  // No body keeps the original full-teardown semantics.
  app.post("/v1/llm-runner/stop", async (req) => {
    const body = dictBody(req.body, { required: false });
    const modelId = strOr((body || {}).modelId);
    return (await lifecycle.getService()).stop(modelId || null);
  });

  // ── Engine (the llama.cpp binary): install as its OWN step, separate from downloading a
  //    model — a model load requires the engine already installed. ──

  app.get("/v1/llm-runner/engine/status", async () => (await lifecycle.getService()).engineStatus());

  app.post("/v1/llm-runner/engine/install", async (req) => {
    const body = dictBody(req.body, { required: false }) || {};
    const force = truthy(body.force);
    // An UPDATE passes the build it supersedes (user, 2026-07-07: "the engine update should
    // delete the old folder") — the service removes that old build dir after the new one
    // installs, carrying over a models.ini found inside it first.
    const replaceBuild = strOr(body.replaceBuild);
    // A backend switch/add (2026-07-14) targets ONE variant family ("cuda"/"vulkan"): a
    // lightweight ADD into the pinned build — force/replaceBuild are ignored then.
    const gpu = strOr(body.gpu);
    return (await lifecycle.getService()).installEngine({ force, replaceBuild, gpu });
  });

  // Signal the engine install to stop at the next chunk boundary — the same shape as the
  // model /download/cancel. Idempotent: a no-op (returns the current status) when nothing is
  // installing. Returns the live engine status — 'cancelling…' immediately, then
  // not-installed (idle) once the installer unwinds.
  app.post("/v1/llm-runner/engine/install/cancel", async () => (await lifecycle.getService()).cancelInstallEngine());

  app.get(
    "/v1/llm-runner/engine/log",
    { schema: { querystring: T.Object({ tail: opt(T.Integer(), 200) }) } },
    async (req) => (await lifecycle.getService()).engineLog({ tail: req.query.tail }),
  );

  app.post("/v1/llm-runner/engine/uninstall", async () => (await lifecycle.getService()).uninstallEngine());

  app.get("/v1/llm-runner/engine/update-check", async () => (await lifecycle.getService()).updateCheck());

  // Upstream RENAMES its release files between builds, so substituting a build tag into a
  // stored URL can 404 mid-update. This reports each stored row's REAL download at `build`,
  // plus whether THIS machine's row exists there at all — so the UI can refuse before it
  // writes a pin. Read-only: it never writes the pin or a URL.
  app.get(
    "/v1/llm-runner/engine/resolve-assets",
    { schema: { querystring: T.Object({ build: T.String() }) } },
    async (req) => (await lifecycle.getService()).resolveBuildAssets(req.query.build),
  );

  // ── Reclaim disk: the runner OWNS its cache, so it owns the deletes. The sizes are
  //    reported by the shared platform GET /v1/disk/usage; these do the freeing. ──

  // Remove every `*.log` under the runner's `llamacpp/logs` dir — the per-spawn llama-server
  // logs, which are otherwise UNBOUNDED (nothing else sweeps them). The dir is kept so the
  // next spawn can write. Best-effort: a locked file is skipped. Returns `{removed, bytes}`.
  app.post("/v1/llm-runner/spawn-logs/clear", async () => (await lifecycle.getService()).clearSpawnLogs());

  // Delete every downloaded model GGUF from the HF cache. SAFE BY DESIGN: the catalog rows
  // persist in the host DB, so each model simply RE-DOWNLOADS the next time it is loaded.
  // Refuses with `{ok: false, detail: "unload models first"}` (HTTP 200) while any model is
  // resident/loading, because its weights are open/mmap'd (and on Windows an open file can't
  // be unlinked); the caller unloads, then retries. On success returns `{ok: true, bytes}`.
  app.post("/v1/llm-runner/models-cache/clear", async () => (await lifecycle.getService()).clearModelsCache());

  // Delete a single model's GGUF(s) from the HF cache — the disk half of the catalog
  // 'Delete'. SAFE BY DESIGN: the weights re-download on demand if the model is re-added.
  // Frees the handle first (cancels an in-flight download of it, unloads it if resident); a
  // repo shared with another catalog row is kept. Returns `{ok: true, bytes, detail?}`.
  app.post(
    "/v1/llm-runner/models-cache/delete",
    { schema: { body: LoadRequest }, preValidation: bodyByName(LoadRequest) },
    async (req) => {
      if (!req.body.modelId) throw new HttpError(400, "modelId required");
      return (await lifecycle.getService()).deleteModelCache(req.body.modelId);
    },
  );

  // #20 'Tune & measure': run a fixed probe against the loaded model and return decode tok/s
  // + the box's VRAM/RAM context. Requires a model running. `model_id` names the model
  // explicitly (the bench names its leg's model); omitted → the primary (most-recently
  // loaded). The parameters are QUERY parameters, snake_case, as FastAPI declared them.
  app.post(
    "/v1/llm-runner/measure",
    {
      schema: {
        querystring: T.Object({
          prompt: opt(T.String(), "Write one vivid paragraph about the sea."),
          max_tokens: opt(T.Integer(), 128),
          model_id: opt(T.String()),
        }),
      },
    },
    async (req) =>
      (await lifecycle.getService()).measure({
        prompt: req.query.prompt,
        maxTokens: req.query.max_tokens,
        modelId: req.query.model_id ?? null,
      }),
  );

  // b1 'prompt preview': exact token count via the loaded model's own tokenizer (/tokenize).
  // Requires a model running — the UI falls back to a heuristic when `ok` is false (no local
  // model).
  app.post("/v1/llm-runner/tokenize", async (req) => {
    const body = dictBody(req.body, { required: true });
    return (await lifecycle.getService()).tokenize({ text: strOr((body || {}).text) });
  });
}

/** `str(x or "")`. */
const strOr = (v) => pyStr(truthy(v) ? v : "");

/** GET /v1/llm-runner/models — the catalog rows with Fit, speed band and live status. */
async function modelsView(vramMb) {
  const hw = await hardware.detect();
  const service = await lifecycle.getService();

  // Fit answers "how does this model run on THIS MACHINE'S CARD" — scored against the card's
  // TOTAL VRAM. (User decree 2026-07-06 "fix it": budget-aware scoring fed the VRAM
  // *remaining* after the resident set, so a sleeping model on an 8 GB box flipped EVERY row
  // to "CPU" while the same screen's header showed the card. The load-moment budget belongs
  // to the arbiter.) A card-chooser override (vram_mb passed) is used as-is (0 = CPU-only).
  const gpuVram = vramMb !== null ? vramMb : hardware.maxVramMb(hw);
  const margin = (await service.config()).safetyMarginMb;
  const hfCache = path.join(String(service.cacheRoot), "hf");

  // Resident-set aware (P1f): the router co-resides up to models_max models, so read the LIVE
  // per-model status rather than the single-model status(). Router down → empty set → every
  // model falls through to disk/available. The download-only channel still overlays
  // independently (it can run while a model is resident).
  const live = new Map();
  for (const m of get((await service.resident(hw)) || {}, "models", [])) live.set(m.id, get(m, "status", null));
  // Downloads are concurrent + per-model keyed: {modelId: {status, …}}. A model absent from
  // the map is idle on that channel.
  const downloads = get((await service.downloadStatus()) || {}, "downloads", {});
  // The live operation behind each status — so every row can carry a truthful bar without a
  // browser-side task (2026-08-14: one control, one source).
  const ops = (await service.opProgress()) || {};

  const statusFor = (modelId, downloaded) => {
    const s = live.get(modelId);
    // T2b (2026-07-17): a model being torn down or cancel-resolved says so — the card renders
    // "Unloading…" with its buttons inert instead of a live "● loaded" that invites the second
    // click (the user's unload-×3).
    if (s === "stopping" || s === "cancelling") return "stopping";
    if (s === "loaded" || s === "sleeping") return "loaded";
    if (s === "loading" || s === "downloading" || s === "starting") return "loading";
    if (s === "failed" || s === "error") return "error";
    // A download-only op runs on its OWN per-model channel (it can overlap a loaded model).
    const dl = get(downloads, modelId, null);
    if (dl != null) {
      if (dl.status === "downloading") return "loading";
      if (dl.status === "error") return "error";
    }
    return downloaded ? "disk" : "available";
  };

  // Catalog is HOST-OWNED (DB-backed via service.catalog()). There is NO fallback: a host
  // that never called `configureService({catalogFn})` gets an EMPTY list.
  const catalog = (await service.catalog()) || [];
  if (!service.catalogWired) {
    // Say it once per process rather than per request: silence here is what let JustVoice
    // mount this router and serve an empty catalog unnoticed.
    warnCatalogUnwired();
  }

  // ── The SPEED half of the badge (fit-redesign Phase 3; §5.4: feasibility × band ship
  // together). Bandwidth is a MACHINE property, resolved once per request down the §5.5
  // ladder (measurement-derived → device-reported → class-seeded); each chat row with header
  // facts then gets its per-pass byte split priced. A row without facts, or a pool without
  // bandwidth, keeps band "" — the chip shows plain feasibility rather than a guess.
  const cfg = await service.config();
  const backend = hardware.activeBackend(hw);
  const arch = hardware.memArch(hw);
  // Same one-pool condition as computeFit's arch arm (§13.10): a GPU-less Windows/Linux box
  // stays the plain CPU path (budget 0 → all bytes host).
  const onePool = (arch === "integrated" || arch === "unified") && ((hw.gpus || []).length > 0 || hw.platform === "macos");
  const mkey = hardware.machineKey(hw);
  const speedFacts = {};
  for (const m of catalog) {
    const sf = _speedFacts(m);
    if (sf) speedFacts[m.id] = sf;
  }
  const measPlain = ((await service.measurementRows()) || []).map((r) => ({
    model_id: r.modelId ?? "",
    machine_key: r.machineKey ?? "",
    backend: r.backend ?? "",
    tokens_per_sec: pyFloatParse(r.tokensPerSec || 0),
    switches: Object.fromEntries((r.switches || []).map((f) => [f.flagName, f.flagValue])),
  }));
  const [clsVramBw, clsRamBw] = await service.classBw(hardware.classKey(hw));
  const [devBw, hostBw] = await bandwidth.resolveEffectiveBw({
    rows: measPlain,
    factsById: speedFacts,
    machineKey: mkey,
    backend,
    isMacos: hw.platform === "macos",
    classVramBwGbps: clsVramBw,
    classRamBwGbps: clsRamBw,
    probeGbps: await service.hostProbeBwGbps(mkey),
    // The one-minute speed check's rung (speed-truth plan §6) — llama.cpp's own expert
    // streaming on this box; null until the user ran the check.
    moeProbeGbps: (await service.hostMoeBwGbps(mkey)) ?? null,
    effDevice: cfg.bwEffDevice,
    effHost: cfg.bwEffHost,
    effHostProbe: cfg.bwEffHostProbe,
  });
  const overhead = fit.PHYSICS_OVERHEAD_MB[backend] ?? fit.PHYSICS_OVERHEAD_MB.cuda;
  const weightBudget = Math.max(0.0, gpuVram - margin - overhead);
  // Newest REAL measurement per model on THIS box + backend — measurement outranks estimate
  // at display AND for the band. Rows arrive newest-first; the RAM-probe pseudo-row never
  // matches a catalog id.
  const measuredById = new Map();
  for (const r of measPlain) {
    if (r.machine_key === mkey && r.backend === backend && r.tokens_per_sec > 0 && !measuredById.has(r.model_id)) {
      measuredById.set(r.model_id, r.tokens_per_sec);
    }
  }
  // §7.4-as-ranking: ANY persisted row for this machine — a tune, an autotune trial, or a
  // Phase 5 load footprint (tok/s 0, so measuredById skips it) — is THIS-box evidence the
  // model ran here. Machine-keyed only: a backend switch changes speed, not the fact that it
  // ran. The pseudo-rows (__machine_ram_bw__, __overhead__) never match a catalog id.
  const ranHereIds = new Set(measPlain.filter((r) => r.machine_key === mkey).map((r) => r.model_id));

  /** [band, predicted tok/s, measured tok/s] for one chat row. */
  const speed = (m) => {
    const sf = Object.hasOwn(speedFacts, m.id) ? speedFacts[m.id] : null;
    if (!sf) return ["", null, null];
    // The band prices the config the row would actually launch: capped ctx (§8.1) — larger
    // ctx reads more KV per token, the err-slow direction.
    const cap = cfg.ctxCapTokens;
    const ctx = cap ? Math.min(m.trainedCtx || cap, cap) : m.trainedCtx || 4096;
    // SPEED path: decimal MB against decimal GB/s (vram-truth §6.4 — NOT MiB).
    const kv = fit.kvMbFromFacts(sf.kv_facts, Math.max(1, ctx), 16, { unit: 1e6 });
    const [devMb, hostMb] = fit.speedBytesSplit({
      nonExpertMb: sf.non_expert_mb,
      activeExpertMb: sf.active_expert_mb,
      kvMb: kv,
      onePool,
      weightBudgetMb: weightBudget,
    });
    let tok;
    if (onePool) {
      // The one pool is priced by ITS efficiency family (§5.5): Metal streams like a device
      // (Apple published BW × device family); an iGPU/CPU pool gathers like a host
      // (Appendix B's laptop rows sit in the host range — err-slow keeps them there).
      tok = fit.predictDecodeTokS({
        deviceMb: devMb,
        hostMb: 0,
        deviceBwGbps: backend === "metal" ? devBw : hostBw,
        hostBwGbps: null,
      });
    } else {
      tok = fit.predictDecodeTokS({ deviceMb: devMb, hostMb, deviceBwGbps: devBw, hostBwGbps: hostBw });
    }
    const meas = measuredById.get(m.id) ?? null;
    let band = fit.speedBand(meas || tok, { fast: cfg.bandFastToks, fine: cfg.bandFineToks, slow: cfg.bandSlowToks });
    // A PREDICTION within the dead zone of a threshold ships no word — the chip shows
    // "~7.9 tok/s" (predTokS still ships) instead of a band the next probe reading could flip
    // (speed-truth plan 2026-09-19 §5). A measured speed always keeps its word.
    if (
      !meas &&
      fit.inBandDeadzone(tok, {
        fast: cfg.bandFastToks,
        fine: cfg.bandFineToks,
        slow: cfg.bandSlowToks,
        frac: cfg.bandDeadzoneFrac,
      })
    ) {
      band = "";
    }
    return [band, tok ? pyRound(tok, 1) : null, meas ? pyRound(meas, 1) : null];
  };

  const rows = [];
  for (const m of catalog) {
    const downloaded = !!(await service.modelDownloaded(m, hfCache)); // main weights AND the MTP draft when wanted
    // Embedding rows carry the placement TRUTH (2026-07-25): the same service rule the loader
    // enforces, so the badge never claims a GPU fit the load then refuses. Placement reflects
    // THIS box — the card-chooser vram_mb override re-scores `fit` only.
    const [place, left] = m.embedding ? await service.embedPlacement(m, hw) : ["", 0];
    const [band, pred, meas] = speed(m);
    // The row's own folder (Open folder in the ⋯ menu). Same match rule as
    // `modelDownloaded`, one extra glob only for a model that HAS files.
    const gguf = downloaded ? models.cachedGgufPath(m.hfRepo, m.quant, { cacheRoot: hfCache, mmproj: m.mmproj ?? null }) : null;
    const op = truthy(get(ops, m.id, null)) ? ops[m.id] : {};
    rows.push({
      id: m.id,
      name: m.name,
      tier: m.tier,
      params: m.totalParams ?? null,
      activeParams: m.activeParams ?? null,
      minVramMb: m.recommendedFor?.minVramMb ?? null,
      minRamMb: m.minRamMb ?? null,
      fit: modelFit(m, gpuVram, hw.ramMb, margin),
      status: statusFor(m.id, downloaded),
      downloaded,
      localDir: gguf ? path.dirname(gguf) : "",
      embedPlacement: place,
      embedLeftoverMb: place ? left : null,
      speedBand: band,
      predTokS: pred,
      measuredTokS: meas,
      ranHere: ranHereIds.has(m.id),
      detail: get(op, "detail", ""),
      opDone: get(op, "done", 0),
      opTotal: get(op, "total", 0),
      error: get(op, "error", ""),
    });
  }

  return model(RunnerModelsResponse, {
    vramMb: gpuVram,
    ramMb: hw.ramMb,
    safetyMarginMb: margin,
    models: rows,
    catalogWired: service.catalogWired,
    bandFineToks: cfg.bandFineToks,
    speedFloorGrace: cfg.speedFloorGrace,
  });
}
