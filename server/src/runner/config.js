// SPDX-License-Identifier: MIT
// Runner config — engine DEFAULTS + the standalone fallback (the port of
// llm_runner/runner/config.py).
//
// There is NO `runner-manifest.json` (decided 2026-06-27: config is data, it belongs in the
// DB, seeded `built_in`). These module CONSTANTS are the single source of truth for the
// llama.cpp build/binaries + the VRAM safety margin:
//   * the host (`installLlm`) seeds them into the DB (`runner_binary` / `runner_setting`)
//     where they become user-editable, and injects a DB-backed `configFn` into the runner
//     service;
//   * `defaultConfig()` builds the same RunnerConfig straight from these constants for
//     STANDALONE runner use (no host DB wired), and `llm/seed.js` imports these to seed the
//     DB (one source of truth, no duplication).
//
// The base/moe/dense flag presets are NOT here — they live in the DB `switch_presets` and
// reach the spawn via the runner's `switchesFn` → `Overrides`.
//
// NOTE for the seed port: Python seeds the float constants with `str(x)` ("20.0", "0.1"),
// which `String(x)` does not reproduce for whole numbers ("20") — use `pyFloat(x)` from
// platform/pyjson.js for the DEFAULT_BAND_* / DEFAULT_SPEED_FLOOR_GRACE / DEFAULT_BW_EFF_* /
// DEFAULT_CALIB_*_MB rows.

import { model } from "../platform/models.js";
import { RunnerConfig } from "./schema.js";

// EXACT llama.cpp release tag (never "latest" — reproducible spawns).
// b10750 → b11239 (2026-09-28, the #29168 re-measure; user: "do 1" = move the pin to head).
// The earlier b10750 pin ("the last build before upstream broke MTP") did NOT survive a
// real-prompt test: its 0.823 → 0.481 acceptance drop was measured with ONE raw
// `/completion` prompt and no chat template. Through `/v1/chat/completions` — the only path
// the family sends — b10750, b10751 and b11239 are level (acceptance within 0.02 on three
// prompts, the draft 1.10–1.31× faster on every build), and drafted output ≠ greedy on EVERY
// build there. b11239 carries every post-b10750 fix. Record:
// docs/plans/2026-09-19-engine-update-safety-and-stable-channel.md §10. All seven rows
// resolve, re-verified against `gh api releases/tags/b11239` on 2026-09-28 (three renamed:
// win cuda-13.3 → 13.4, win + ubuntu rocm-7.14 → rocm-10.0).
// Seeding is insert-if-missing, so an EXISTING DB keeps its old `pinned_build` row — bump it
// in the UI (Settings → AI → engine Binaries panel); this constant fixes fresh installs and
// the panel's "reset to defaults". The Update button compares the stable channel's build
// with the build ON DISK (`update_check`); stable (v0.5.0) names b11146, older than this
// pin, so it offers nothing. (history: runner/config.py)
export const DEFAULT_PINNED_BUILD = "b11239";

// Reserve this much VRAM headroom when computing the GPU layer split.
export const DEFAULT_SAFETY_MARGIN_MB = 1024;

// The most context an UNTUNED model is handed automatically: computed ctx becomes
// min(trained, KV-affordable, this cap). A CAP, never a pin — an explicit ctx from a
// tune/preset/request always overrides, and a smaller-trained model keeps its own window
// (fit-redesign §8.1; every measured tune on all three known machines chose 32768, while
// the uncapped policy handed a cheap-KV MoE 131,072 — ~2.7 GB of KV before any weights,
// the poisoned-launch defect of §1.5). 0 = uncapped. DB-editable via runner_setting
// `ctx_cap_tokens` + the GUI field beside the margin.
export const DEFAULT_CTX_CAP_TOKENS = 32768;

// Fit-redesign Phase 2 (§8.21, §13.13) — the two floor-rule seeded facts: the canonical
// floor prices KV at MINIMAL-USABLE context ("can it run at all"; the fit verdict prices
// the real config), and the RAM floor is file + headroom. Seeded runner_setting rows.
export const DEFAULT_FLOOR_CTX_TOKENS = 4096;
export const DEFAULT_RAM_HEADROOM_MB = 4096;

// Fit-redesign Phase 3 (§8.14) — the speed-band thresholds, tok/s minimums: fast ≥ 20
// (well past reading speed) · fine ≥ 8 (the DECIDED "comfortable" reading-speed line) ·
// slow ≥ 2 · below = painful. Seeded runner_setting rows. Start values, not law.
export const DEFAULT_BAND_FAST_TOKS = 20.0;
export const DEFAULT_BAND_FINE_TOKS = 8.0;
export const DEFAULT_BAND_SLOW_TOKS = 2.0;

// Speed-truth plan 2026-09-19 §5 — the band DEAD ZONE. A PREDICTED tok/s within this
// fraction of any band threshold ships band "" so the chip shows the number ("~7.9 tok/s")
// instead of a word the next probe reading may flip: on the author's box the flagship
// predicts 7.9 against a fine-line of 8.0, and a ±2 % RAM-probe wobble crosses it. A
// MEASURED speed always keeps its word.
export const DEFAULT_BAND_DEADZONE_FRAC = 0.1;

// Speed-truth plan 2026-09-19 §7 — the speed FLOOR in the fallback pick (boxes with no
// curated class tune): a model whose measured-or-predicted tok/s is below
// band_fine_toks × (1 − this) is not "fast enough". The grace is not optional: on the
// author's box a HARD 8.0 floor would drop the flagship (pred 7.9, quality rank 5) for E4B
// (rank 23) over a 0.1 tok/s rounding error. 0.2 → floor 6.4.
export const DEFAULT_SPEED_FLOOR_GRACE = 0.2;

// Speed-truth plan 2026-09-19 §6 — the ONE-MINUTE SPEED CHECK's test model, served from the
// kit's own GitHub release (ruling 2026-09-19: never from a third-party repo that can
// vanish). The file is sha-pinned, so its byte facts are constants of THAT file: read from
// its tensor table on 2026-09-19 — `*_exps` 731.4 MB of 820.1 MB of tensors, 8 of 32 experts
// active per token → 182.8 MB; everything else 88.7 MB. Source:
// bartowski/granite-3.1-1b-a400m-instruct-GGUF (IBM Granite 3.1 1B-A400M, Apache-2.0),
// redistributed unmodified — the release notes carry the license.
export const DEFAULT_CALIB_MODEL_URL =
  "https://github.com/delebash/just-llm-runner/releases/download/calib-v1/granite-3.1-1b-a400m-instruct-Q4_K_M.gguf";
export const DEFAULT_CALIB_MODEL_SHA256 = "3a2ec1c2a78cb29d901e29bbf5162dcd03381e13803d2cbdcff838d4d08142eb";
export const DEFAULT_CALIB_MODEL_SIZE_BYTES = 821_847_360;
export const DEFAULT_CALIB_ACTIVE_EXPERT_MB = 182.8;
export const DEFAULT_CALIB_NONEXPERT_MB = 88.7;

// Fit-redesign Phase 3 (§5.5 corrected + §13.8) — the two EFFICIENCY FAMILIES converting
// raw pool bandwidth into effective decode bandwidth. Two families because the pools are
// different physical processes (streamed device reads vs scattered expert gather):
// device-compute measured ≈0.59 of spec on the author's box; host-CPU converged 0.10–0.22
// across three independent derivations — seeded at 0.15, the low half (err-slow, §8.17).
// Measurement-DERIVED bandwidth bypasses these entirely.
export const DEFAULT_BW_EFF_DEVICE = 0.6;
export const DEFAULT_BW_EFF_HOST = 0.15;

// The RAM COPY PROBE's own factor — calibrated ONCE against the measured-model path, live
// on the author's desktop 2026-08-13: the probe reads 19.01 GB/s there while the measured
// host effective window is 6.9–10.6 GB/s — 19.01 × 0.40 = 7.6, the same low-mid position the
// class-seed math was designed to (51.2 × 0.15 = 7.68). It cannot share the generic host
// factor (19.01 × 0.15 = 2.85 → a band lie). The probe is topology-aware (single + threaded
// passes, best wins), so this factor is the STREAMING → SCATTERED-EXPERT-GATHER discount —
// an access-pattern property that transfers across machines far better than any spec
// ratio. Refinable per box via the settings row.
export const DEFAULT_BW_EFF_HOST_PROBE = 0.4;

// Fit-redesign Phase 5 (§13.2): keep-latest-K persisted load footprints per (model,
// machine, fingerprint) — without a cap, 'load' rows grow unboundedly.
export const DEFAULT_LOAD_ROWS_KEEP = 3;

// Router mode (P1e): the count-based co-resident cap (`--models-max`; the arbiter works
// WITHIN it) and the native idle-unload TTL (`--sleep-idle-seconds`; 0 = never sleep).
// models_max=2 keeps a chat model + a tiny embed co-resident on a small card; sleep_idle=900 s
// keeps the active model warm through normal writing pauses.
export const DEFAULT_MODELS_MAX = 2;
export const DEFAULT_SLEEP_IDLE_SECONDS = 900;

// Concurrent downloads — N connections pull CHUNKS off a shared work queue (download.js; the
// IDM/aria2 "dynamic segmentation" design). ONE setting for EVERY download (engine + models,
// no per-host special cases): work-stealing means a slow connection only delays the single
// chunk it holds. HuggingFace rate-limits by REQUEST COUNT (anonymous: 3,000 resolver hits
// per 5-min window/IP — the 2026-07-24 StyleTune 429), so chunk COUNT is bounded in
// streamDownload (≤ segments × 4 requests per file) and 429/503 park all connections on a
// shared gate for the server-declared wait. Capped at MAX_DOWNLOAD_SEGMENT_COUNT (16).
export const DEFAULT_DOWNLOAD_SEGMENTS_ENABLED = true;
export const DEFAULT_DOWNLOAD_SEGMENT_COUNT = 8;
// RETIRED 2026-07-20: the downloader decides single- vs multi-connection itself from the
// server's Range support + size, so this floor is inert. Kept (and the DB row / config-API
// field) for back-compat — `downloadKwargs` no longer reads it.
export const DEFAULT_DOWNLOAD_SEGMENT_MIN_BYTES = 64 * 1024 * 1024;
export const DEFAULT_DOWNLOAD_SEGMENT_RETRIES = 3;
// CONCURRENT model downloads (2026-07-20): how many model downloads may run in parallel.
// Read LIVE at admission so the knob is tunable without a restart.
export const DEFAULT_DOWNLOAD_MAX_CONCURRENT = 4;
// Upper bounds for the count knobs (#10, 2026-07-17). Past ~4-8 segments only piles load on
// the CDN edge without adding speed; retries past ~10 just prolong a genuinely-dead segment;
// >10 concurrent whole-model downloads thrash the disk + CDN. The write path (engine-config
// PUT) and the read paths (downloadKwargs / the lifecycle admission gate) all clamp to these
// — ONE source, so a raw DB poke can't route around them either.
export const MAX_DOWNLOAD_SEGMENT_COUNT = 16;
export const MAX_DOWNLOAD_SEGMENT_RETRIES = 10;
export const MAX_DOWNLOAD_CONCURRENT = 10;

// Prebuilt llama-server distributions, selected by (platform, gpu). We never install a CUDA
// toolkit — we only DETECT the system and pick the matching prebuilt build; the Windows CUDA
// builds additionally need the separate cudart runtime DLLs (`runtime_url`), unpacked
// alongside the exe. Windows assets are `.zip`, macOS/Linux `.tar.gz`. This seeds fresh
// installs + "reset to defaults"; the server never composes a URL, it fetches whatever
// concrete URL is stored.
//
// Every filename was verified against the release's own asset list (GET
// api.github.com/repos/ggml-org/llama.cpp/releases/tags/<build>) — do NOT hand-edit a name
// from memory. UPSTREAM RENAMES THESE: substituting the tag into a stored name is NOT enough
// (Windows AMD went hip-radeon → rocm-7.14 → rocm-10.0, Linux AMD rocm-7.2 → absent for ~180
// builds → rocm-10.0, Windows CUDA 13 → 13.4 after b10964), so the UPDATE flow resolves names
// from the target release's own asset list (`binary.resolveReleaseAssets`); these literals
// only seed a FRESH database. The Windows cudart-* companion is tied to its asset's CUDA
// version; on Linux, from b10969, it is build-tagged.
//
// The rows keep Python's snake_case keys: they are seed DATA mapped onto `runner_binary`
// columns (seed + the reset-to-defaults path read `b.asset_url`, `b.server_exe`, …).
const REL = `https://github.com/ggml-org/llama.cpp/releases/download/${DEFAULT_PINNED_BUILD}`;
export const DEFAULT_BINARIES = [
  {
    platform: "windows",
    gpu: "cuda12",
    source: "github",
    asset_url: `${REL}/llama-${DEFAULT_PINNED_BUILD}-bin-win-cuda-12.4-x64.zip`,
    runtime_url: `${REL}/cudart-llama-bin-win-cuda-12.4-x64.zip`,
    server_exe: "llama-server.exe",
  },
  {
    platform: "windows",
    gpu: "cuda13",
    source: "github",
    asset_url: `${REL}/llama-${DEFAULT_PINNED_BUILD}-bin-win-cuda-13.4-x64.zip`,
    runtime_url: `${REL}/cudart-llama-bin-win-cuda-13.4-x64.zip`,
    server_exe: "llama-server.exe",
  },
  // Windows AMD has been renamed TWICE upstream: win-hip-radeon (≤ b10398) → win-rocm-7.14 →
  // win-rocm-10.0 (b10767, #27803; this pin).
  {
    platform: "windows",
    gpu: "rocm",
    source: "github",
    asset_url: `${REL}/llama-${DEFAULT_PINNED_BUILD}-bin-win-rocm-10.0-x64.zip`,
    server_exe: "llama-server.exe",
  },
  {
    platform: "windows",
    gpu: "vulkan",
    source: "github",
    asset_url: `${REL}/llama-${DEFAULT_PINNED_BUILD}-bin-win-vulkan-x64.zip`,
    server_exe: "llama-server.exe",
  },
  // The cpu rows are RETIRED (user, 2026-07-07: "deleet" — a CPU-only machine can't run
  // local LLMs at usable speed, so no cpu build is offered or ever downloaded). A box with no
  // usable GPU resolves to NO engine (selectBinary → null); the seeder prunes previously
  // seeded built-in cpu rows from existing DBs.
  {
    platform: "macos",
    gpu: "metal",
    source: "github",
    asset_url: `${REL}/llama-${DEFAULT_PINNED_BUILD}-bin-macos-arm64.tar.gz`,
    server_exe: "llama-server",
  },
  // Linux AMD: rocm-7.2 (≤ b10397) → NO asset for b10398-b10581 → rocm-7.14 → rocm-10.0
  // (b10767; this pin).
  {
    platform: "linux",
    gpu: "rocm",
    source: "github",
    asset_url: `${REL}/llama-${DEFAULT_PINNED_BUILD}-bin-ubuntu-rocm-10.0-x64.tar.gz`,
    server_exe: "llama-server",
  },
  {
    platform: "linux",
    gpu: "vulkan",
    source: "github",
    asset_url: `${REL}/llama-${DEFAULT_PINNED_BUILD}-bin-ubuntu-vulkan-x64.tar.gz`,
    server_exe: "llama-server",
  },
  // Linux CUDA: docker-only upstream, and NO pin-faithful image exists — per-build image
  // tags were discontinued, leaving rolling tags that track master. The row stays as the
  // FUTURE seam (never auto-selected — see binary.selectBinary); until a digest is captured
  // at a pin bump, Linux+NVIDIA selects the pinned vulkan archive.
  {
    platform: "linux",
    gpu: "cuda12",
    source: "docker",
    image: "ghcr.io/ggml-org/llama.cpp:server-cuda",
    server_exe: "llama-server",
  },
];

/** A DEFAULT_BINARIES row (snake data keys) as a BinaryAsset value (camelCase fields). */
export function binaryAsset(b) {
  const out = { platform: b.platform, gpu: b.gpu };
  if ("source" in b) out.source = b.source;
  if ("asset_url" in b) out.assetUrl = b.asset_url;
  if ("runtime_url" in b) out.runtimeUrl = b.runtime_url;
  if ("image" in b) out.image = b.image;
  if ("sha256" in b) out.sha256 = b.sha256;
  if ("runtime_sha256" in b) out.runtimeSha256 = b.runtime_sha256;
  if ("server_exe" in b) out.serverExe = b.server_exe;
  return out;
}

/** The standalone fallback RunnerConfig, built from the constants above (no host DB
 * wired). Hosts inject a DB-backed `configFn` instead. */
export function defaultConfig() {
  return model(RunnerConfig, {
    llamacpp: {
      pinnedBuild: DEFAULT_PINNED_BUILD,
      binaries: DEFAULT_BINARIES.map(binaryAsset),
    },
    safetyMarginMb: DEFAULT_SAFETY_MARGIN_MB,
    modelsMax: DEFAULT_MODELS_MAX,
    sleepIdleSeconds: DEFAULT_SLEEP_IDLE_SECONDS,
    ctxCapTokens: DEFAULT_CTX_CAP_TOKENS,
  });
}
