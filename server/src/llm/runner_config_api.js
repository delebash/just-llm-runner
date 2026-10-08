// SPDX-License-Identifier: MIT
// The engine-config editor's wire models — from llm/runner_config_api.py (`RunnerBinaryRow`
// and `EngineConfig`, the ones the stores use). The router (`makeRunnerConfigRouter`) and
// `EngineConfigUpdate` are ported in wave 2.
//
// The per-(platform, gpu) download URLs, the pinned build, the VRAM safety margin and the
// two router residency knobs are DATA (DB-backed, seeded), so a moved/renamed release
// asset is a pasted URL, not a code change. The runner reads its live config from the same
// rows via `buildRunnerConfig()`.

import { nullable, opt, T } from "../platform/models.js";

export const RunnerBinaryRow = T.Object({
  platform: T.String(),
  gpu: T.String(),
  source: opt(T.String(), "github"), // "github" | "docker"
  assetUrl: opt(nullable(T.String()), null),
  runtimeUrl: opt(nullable(T.String()), null), // companion (cudart DLLs) unpacked alongside
  image: opt(nullable(T.String()), null), // docker source only
  serverExe: opt(T.String(), "llama-server"),
});

export const EngineConfig = T.Object({
  pinnedBuild: T.String(),
  safetyMarginMb: T.Integer(),
  // Computed-ctx cap for untuned launches (fit-redesign §8.1): min() ceiling, never a
  // pin; explicit ctx from a tune/preset/request always overrides. 0 = off.
  ctxCapTokens: opt(T.Integer(), 32768),
  // Fit-redesign Phase 3 (§8.14 + §13.17 as amended): the speed-band tok/s thresholds and
  // the RAM-headroom floor fact — edited in the Loaded-models knobs group.
  bandFastToks: opt(T.Number(), 20.0),
  bandFineToks: opt(T.Number(), 8.0),
  bandSlowToks: opt(T.Number(), 2.0),
  // Speed-truth plan §5 — a prediction within this fraction of a threshold shows its
  // number instead of a band word.
  bandDeadzoneFrac: opt(T.Number(), 0.1),
  // Speed-truth plan §7 — the fallback pick's floor = bandFineToks × (1 − this).
  speedFloorGrace: opt(T.Number(), 0.2),
  // Speed-truth plan §6 — the one-minute speed check's test model: where it downloads
  // from, its sha256, size, and the two byte facts of THAT file.
  calibModelUrl: opt(T.String(), ""),
  calibModelSha256: opt(T.String(), ""),
  calibModelSizeBytes: opt(T.Integer(), 0),
  calibActiveExpertMb: opt(T.Number(), 0.0),
  calibNonexpertMb: opt(T.Number(), 0.0),
  ramHeadroomMb: opt(T.Integer(), 4096),
  modelsMax: T.Integer(), // router: how many models may stay co-resident (>= 1)
  sleepIdleSeconds: T.Integer(), // router: idle-unload TTL in seconds (0 = never)
  // Segmented downloads (DL-2): N parallel byte-ranges per file.
  downloadSegmentsEnabled: opt(T.Boolean(), true),
  downloadSegmentCount: opt(T.Integer(), 8), // keep in step with config.DEFAULT_DOWNLOAD_SEGMENT_COUNT
  downloadSegmentMinBytes: opt(T.Integer(), 64 * 1024 * 1024), // RETIRED/inert; kept for back-compat
  downloadSegmentRetries: opt(T.Integer(), 3),
  downloadMaxConcurrent: opt(T.Integer(), 4), // CONCURRENT model downloads (2026-07-20)
  // "off" | "notify". Notify = the UI surfaces "update available" and the bump is a
  // deliberate click; NEVER auto-applied — the pin is a VERIFIED pin.
  updatePolicy: opt(T.String(), "notify"),
  // The last "gpu-name|vramMb" fingerprint the UI acknowledged — the hardware-change
  // toast fires ONCE per real gpu/vram change. "" = never seen.
  ackHwFingerprint: opt(T.String(), ""),
  // Acceleration-backend override: the GPU FAMILY the user pinned ("cuda" | "vulkan" |
  // "rocm" | "metal"; "" = Auto / hardware order).
  preferredGpu: opt(T.String(), ""),
  // Hardware-class override (§9): the class key the box FILES UNDER ("" = auto-detect).
  // "Detection proposes, never dictates" — a wrong sensor costs one setting.
  classKeyOverride: opt(T.String(), ""),
  // Warm the default local chat model into VRAM on app startup. The CLIENT gates the
  // actual warm; this flag is the user's on/off master.
  warmDefaultOnStartup: opt(T.Boolean(), true),
  binaries: T.Array(RunnerBinaryRow),
});
