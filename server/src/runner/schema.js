// SPDX-License-Identifier: MIT
// camelCase schemas — the shared contract for the runner (the port of
// llm_runner/runner/schema.py).
//
// Python keeps snake_case attributes and aliases them to camelCase on the wire
// (`CamelModel`: alias_generator=to_camel, extra="forbid"). JavaScript keeps ONE name per
// field — the camelCase wire name — inside the code too: `hw.cpuCores`, `entry.hfRepo`.
// A dict-valued field keeps its own keys (`physicsFacts` holds snake keys, as in Python).
// Every model forbids unknown fields, as CamelModel does (a request with one → 422).

import { nullable, opt, strictObject, T } from "../platform/models.js";

// ─── Hardware ───────────────────────────────────────────────────────────

export const GpuInfo = strictObject({
  vendor: T.String(),
  name: T.String(),
  vramMb: opt(nullable(T.Integer()), null),
  driver: opt(nullable(T.String()), null),
  computeCap: opt(nullable(T.String()), null), // NVIDIA compute capability, e.g. "7.5" | "12.0"
});

export const HardwareInfo = strictObject({
  os: T.String(), // raw platform.system(), e.g. "Windows"
  platform: T.String(), // normalized: "windows" | "macos" | "linux"
  cpuCores: opt(T.Integer(), 0),
  ramMb: opt(T.Integer(), 0),
  gpus: opt(T.Array(GpuInfo), []),
  runtimes: opt(T.Record(T.String(), T.Boolean()), {}), // "cuda" | "metal" | "rocm" | "vulkan"
});

// ─── llama.cpp binary distribution ──────────────────────────────────────

/** One prebuilt llama-server distribution, selected by platform + gpu (see schema.py). */
export const BinaryAsset = strictObject({
  platform: T.String(),
  gpu: T.String(), // "cuda12" | "cuda13" | "metal" | "cpu" | "vulkan" | "rocm"
  source: opt(T.String(), "github"), // "github" | "docker"
  assetUrl: opt(nullable(T.String()), null),
  runtimeUrl: opt(nullable(T.String()), null), // companion (e.g. cudart DLLs) unpacked alongside
  image: opt(nullable(T.String()), null),
  sha256: opt(nullable(T.String()), null),
  runtimeSha256: opt(nullable(T.String()), null),
  serverExe: opt(T.String(), "llama-server"),
});

export const LlamacppSpec = strictObject({
  pinnedBuild: T.String(), // EXACT release tag (never "latest")
  binaries: opt(T.Array(BinaryAsset), []),
});

// ─── Model catalog ──────────────────────────────────────────────────────

export const RecommendedFor = strictObject({
  minVramMb: opt(nullable(T.Integer()), null),
  estVramMb: opt(nullable(T.Integer()), null),
});

/** A GGUF option (see schema.py's ModelEntry). */
export const ModelEntry = strictObject({
  id: T.String(),
  name: T.String(),
  tier: T.String(), // "cpu" | "low-vram-moe" | "mid" | "high"
  candidateFor: opt(T.Array(T.String()), []),
  hfRepo: T.String(),
  quant: T.String(),
  mmproj: opt(nullable(T.String()), null),
  totalParams: opt(nullable(T.String()), null),
  activeParams: opt(nullable(T.String()), null),
  mtp: opt(T.Boolean(), false),
  pooling: opt(T.String(), ""),
  embedding: opt(T.Boolean(), false),
  mtpDraftRepo: opt(T.String(), ""),
  mtpDraftFile: opt(T.String(), ""),
  mtpDraftQuant: opt(T.String(), ""),
  minRamMb: opt(nullable(T.Integer()), null),
  recommendedFor: opt(RecommendedFor, { minVramMb: null, estVramMb: null }),
  sizeBytes: opt(nullable(T.Integer()), null),
  trainedCtx: opt(nullable(T.Integer()), null),
  experts: opt(T.Integer(), 0),
  physicsFacts: opt(nullable(T.Record(T.String(), T.Number())), null), // snake-key fact dict
});

// ─── Runner config (binaries + the VRAM safety margin) ──────────────────

/** The runner's load-time config (see schema.py's RunnerConfig for each knob). */
export const RunnerConfig = strictObject({
  llamacpp: LlamacppSpec,
  safetyMarginMb: opt(T.Integer(), 1024),
  ctxCapTokens: opt(T.Integer(), 32768),
  modelsMax: opt(T.Integer(), 2),
  sleepIdleSeconds: opt(T.Integer(), 900),
  preferredGpu: opt(T.String(), ""),
  downloadSegmentsEnabled: opt(T.Boolean(), true),
  downloadSegmentCount: opt(T.Integer(), 8),
  downloadSegmentMinBytes: opt(T.Integer(), 64 * 1024 * 1024),
  downloadSegmentRetries: opt(T.Integer(), 3),
  downloadMaxConcurrent: opt(T.Integer(), 4),
  bandFastToks: opt(T.Number(), 20.0),
  bandFineToks: opt(T.Number(), 8.0),
  bandSlowToks: opt(T.Number(), 2.0),
  bandDeadzoneFrac: opt(T.Number(), 0.1),
  speedFloorGrace: opt(T.Number(), 0.2),
  calibModelUrl: opt(T.String(), ""),
  calibModelSha256: opt(T.String(), ""),
  calibModelSizeBytes: opt(T.Integer(), 0),
  calibActiveExpertMb: opt(T.Number(), 0.0),
  calibNonexpertMb: opt(T.Number(), 0.0),
  bwEffDevice: opt(T.Number(), 0.6),
  bwEffHost: opt(T.Number(), 0.15),
  bwEffHostProbe: opt(T.Number(), 0.4),
  ramHeadroomMb: opt(T.Integer(), 4096),
});

// ─── Model catalog view (GET /v1/llm-runner/models) ─────────────────────

/** One catalog model, annotated for the GUI (see schema.py's RunnerModelInfo). */
export const RunnerModelInfo = strictObject({
  id: T.String(),
  name: T.String(),
  tier: T.String(),
  params: opt(nullable(T.String()), null),
  activeParams: opt(nullable(T.String()), null),
  minVramMb: opt(nullable(T.Integer()), null),
  minRamMb: opt(nullable(T.Integer()), null),
  fit: T.String(), // "ok" | "tight" | "no" | "cpu" | "unknown"
  status: T.String(), // "loaded" | "loading" | "stopping" | "error" | "disk" | "available"
  downloaded: opt(T.Boolean(), false),
  localDir: opt(T.String(), ""),
  embedPlacement: opt(T.String(), ""),
  embedLeftoverMb: opt(nullable(T.Integer()), null),
  speedBand: opt(T.String(), ""),
  predTokS: opt(nullable(T.Number()), null),
  measuredTokS: opt(nullable(T.Number()), null),
  detail: opt(T.String(), ""),
  opDone: opt(T.Integer(), 0),
  opTotal: opt(T.Integer(), 0),
  error: opt(T.String(), ""),
  ranHere: opt(T.Boolean(), false),
});

export const RunnerModelsResponse = strictObject({
  vramMb: opt(T.Integer(), 0),
  ramMb: opt(T.Integer(), 0),
  safetyMarginMb: opt(T.Integer(), 1024),
  models: opt(T.Array(RunnerModelInfo), []),
  catalogWired: opt(T.Boolean(), true),
  bandFineToks: opt(T.Number(), 8.0),
  speedFloorGrace: opt(T.Number(), 0.2),
});

// ─── Resident set (GET /v1/llm-runner/resident) ─────────────────────────

/** One model as the router currently reports it (see schema.py's ResidentModel). */
export const ResidentModel = strictObject({
  id: T.String(),
  status: T.String(),
  nParams: opt(nullable(T.Integer()), null),
  sizeBytes: opt(nullable(T.Integer()), null),
  nCtx: opt(nullable(T.Integer()), null),
  vramMb: opt(nullable(T.Integer()), null),
});

export const RunnerResidentResponse = strictObject({
  router: opt(T.Boolean(), false),
  modelsMax: opt(T.Integer(), 2),
  sleepIdleSeconds: opt(T.Integer(), 900),
  memArch: opt(T.String(), "discrete"),
  vramTotalMb: opt(T.Integer(), 0),
  usedMb: opt(nullable(T.Integer()), null),
  committedMb: opt(T.Integer(), 0),
  remainingMb: opt(T.Integer(), 0),
  models: opt(T.Array(ResidentModel), []),
});

// ─── Load request (POST /v1/llm-runner/load) ────────────────────────────

/** Body for POST /v1/llm-runner/load — `modelId` required, the rest optional overrides. */
export const LoadRequest = strictObject({
  modelId: T.String(),
  jobId: opt(nullable(T.String()), null),
  nGpuLayers: opt(nullable(T.Integer()), null),
  nCpuMoe: opt(nullable(T.Integer()), null),
  ctxLen: opt(nullable(T.Integer()), null),
  cacheTypeK: opt(nullable(T.String()), null),
  cacheTypeV: opt(nullable(T.String()), null),
  flashAttn: opt(nullable(T.String()), null),
  noMmap: opt(nullable(T.Boolean()), null),
  mlock: opt(nullable(T.Boolean()), null),
  noKvOffload: opt(nullable(T.Boolean()), null),
  batchSize: opt(nullable(T.Integer()), null),
  ubatchSize: opt(nullable(T.Integer()), null),
  threads: opt(nullable(T.Integer()), null),
  threadsBatch: opt(nullable(T.Integer()), null),
  parallel: opt(nullable(T.Integer()), null),
  contBatching: opt(nullable(T.Boolean()), null),
  contextShift: opt(nullable(T.Boolean()), null),
  cacheReuse: opt(nullable(T.Integer()), null),
  specType: opt(nullable(T.String()), null),
  specNMax: opt(nullable(T.Integer()), null),
  modelDraft: opt(nullable(T.String()), null),
  reasoningBudget: opt(nullable(T.Integer()), null),
  reasoningBudgetMessage: opt(nullable(T.String()), null),
  extraFlags: opt(T.Array(T.String()), []),
  switches: opt(nullable(T.Record(T.String(), T.String())), null),
});

// ─── Cancel a download (POST /v1/llm-runner/download/cancel) ─────────────

/** `modelId` cancels that model's download; omitted / null cancels all of them. */
export const DownloadCancelRequest = strictObject({
  modelId: opt(nullable(T.String()), null),
});
