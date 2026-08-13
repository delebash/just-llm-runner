# SPDX-License-Identifier: MIT
"""Runner config — engine DEFAULTS + the standalone fallback.

There is NO `runner-manifest.json` anymore (user decree 2026-06-27: config is
data, it belongs in the DB, seeded `built_in`). These module CONSTANTS are the
single source of truth for the llama.cpp build/binaries + the VRAM safety
margin:
  * the host (`install_llm`) seeds them into the DB (`runner_binary` /
    `runner_setting`) where they become user-editable, and injects a DB-backed
    `config_fn` into the runner service;
  * `default_config()` builds the same `RunnerConfig` straight from these
    constants for STANDALONE runner use (no host DB wired) — so the package
    still works as a library, and `llm/seed.py` imports these to seed the DB
    (one source of truth, no duplication).

The base/moe/dense flag presets are NOT here — they live in the DB `switch_presets`
and reach the spawn via the runner's `switches_fn` → `Overrides`.
"""

from __future__ import annotations

from .schema import BinaryAsset, LlamacppSpec, RunnerConfig

# EXACT llama.cpp release tag (never "latest" — reproducible spawns).
# b9644 → b9870 (2026-07-06): Gemma 4 MoE (26B-A4B) + its external MTP draft need the
# newer build; b9870's full asset list was verified against the GitHub release API the
# same day. b9870 → b9899 (2026-07-07, user: "update seeded engine version to latest
# b9899"): VERIFICATION RECORD — the win/cuda-12.4 build + its cudart companion are
# LIVE-VERIFIED (the user's box installed b9899 through the app's own update path,
# which rewrites these exact filenames to the offered tag: "Installed · b9899 ·
# cuda12"); the remaining assets are PATTERN-verified only — the dev container's
# GitHub egress is session-scoped, so the release API could not be re-queried
# (recorded in the design doc ROUND 17). If an asset was renamed upstream, the
# editable Binaries panel is the user-side fix (the #91 lesson — that's why it
# exists). NOTE: seeding is insert-if-missing (`seed_default_runner_settings`),
# so an EXISTING DB keeps its old `pinned_build` row — bump it in the UI (Settings
# → AI → engine Binaries panel) or the row directly; this constant fixes fresh
# installs and the panel's "reset to defaults".
# b9899 → b9993 (2026-07-14, Unit 2 engine bump — user: "do the bump and do it all"):
# reason = the per-request reasoning budget (b9982; the server reads request-body key
# `reasoning_budget_tokens` in tools/server/server-common.cpp — semantics common/common.h:
# -1 unlimited / 0 suppress / N>0 cap; the body value overrides the --reasoning-budget launch
# flag unconditionally, no launch==-1 gate — verified from SOURCE this session), which lets the
# built-in runner honor low/med/high locally, PLUS the b9986 chat-template reasoning-leak fix.
# EVERY DEFAULT_BINARIES filename below was re-verified against b9993's real asset list
# (`gh api releases/tags/b9993`) — all present (win cuda-12.4/13.3 + cudart, win hip-radeon,
# win vulkan, macos-arm64, ubuntu rocm-7.2, ubuntu vulkan). Upstream latest was b10012 but
# b9993 is the REVIEWED tag (docs/llama-cpp-watch.md, 2026-07-14) — bleeding-edge not chosen.
DEFAULT_PINNED_BUILD = "b9993"

# Reserve this much VRAM headroom when computing the GPU layer split.
DEFAULT_SAFETY_MARGIN_MB = 1024

# The most context an UNTUNED model is handed automatically: computed ctx becomes
# min(trained, KV-affordable, this cap). A CAP, never a pin — an explicit ctx from a
# tune/preset/request always overrides, and a smaller-trained model keeps its own
# window (fit-redesign §8.1; every measured tune on all three known machines chose
# 32768, while the uncapped policy handed a cheap-KV MoE 131,072 — ~2.7 GB of KV
# before any weights, the poisoned-launch defect of §1.5). 0 = uncapped.
# DB-editable via runner_setting `ctx_cap_tokens` + the GUI field beside the margin.
DEFAULT_CTX_CAP_TOKENS = 32768

# Fit-redesign Phase 2 (§8.21, §13.13) — the two floor-rule seeded facts:
# the canonical floor prices KV at MINIMAL-USABLE context ("can it run at all";
# the fit verdict prices the real config), and the RAM floor is file + headroom.
# Seeded runner_setting rows; the GUI field lives in the Loaded-models knobs
# group (§13.17 as amended at the Phase 3 go).
DEFAULT_FLOOR_CTX_TOKENS = 4096
DEFAULT_RAM_HEADROOM_MB = 4096

# Fit-redesign Phase 3 (§8.14) — the speed-band thresholds, tok/s minimums:
# fast ≥ 20 (well past reading speed) · fine ≥ 8 (the DECIDED "comfortable"
# reading-speed line) · slow ≥ 2 · below = painful. Seeded runner_setting rows,
# GUI-editable in the Loaded-models knobs group. Start values, not law.
DEFAULT_BAND_FAST_TOKS = 20.0
DEFAULT_BAND_FINE_TOKS = 8.0
DEFAULT_BAND_SLOW_TOKS = 2.0

# Fit-redesign Phase 3 (§5.5 corrected + §13.8) — the two EFFICIENCY FAMILIES
# converting raw pool bandwidth (device registers / probe / class seed) into
# effective decode bandwidth. Two families because the pools are different
# physical processes (streamed device reads vs scattered expert gather):
# device-compute measured ≈0.59 of spec on the author's box; host-CPU converged
# 0.10–0.22 across three independent derivations — seeded at 0.15, the low half
# (err-slow, §8.17). Measurement-DERIVED bandwidth (ladder source 1) bypasses
# these entirely. Seeded runner_setting rows; self-correct as Phase 5 learns.
DEFAULT_BW_EFF_DEVICE = 0.6
DEFAULT_BW_EFF_HOST = 0.15

# Fit-redesign Phase 5 (§13.2): keep-latest-K persisted load footprints per
# (model, machine, fingerprint) — without a cap, 'load' rows grow unboundedly.
# A seeded runner_setting fact.
DEFAULT_LOAD_ROWS_KEEP = 3

# Router mode (P1e): the count-based co-resident cap (`--models-max`; the arbiter
# works WITHIN it) and the native idle-unload TTL (`--sleep-idle-seconds`; 0 =
# never sleep). DB-editable via runner_setting; these are the standalone/seed
# defaults. models_max=2 keeps a chat model + a tiny embed co-resident on a small
# card; sleep_idle=900 s keeps the active model warm through normal writing pauses.
DEFAULT_MODELS_MAX = 2
DEFAULT_SLEEP_IDLE_SECONDS = 900

# Concurrent downloads — N connections pull CHUNKS off a shared work queue (download.py;
# the IDM/aria2 "dynamic segmentation" design). ONE setting for EVERY download (engine +
# models, no per-host special cases): work-stealing means a slow connection only delays the
# single chunk it holds. CORRECTED 2026-07-24 (the StyleTune 429): "safe on any CDN" was
# only true for BANDWIDTH — HuggingFace rate-limits by REQUEST COUNT (anonymous: 3,000
# resolver hits per 5-min window/IP), so chunk COUNT is now bounded in stream_download
# (≤ segments × 4 requests per file) and 429/503 park all connections on a shared gate for
# the server-declared wait. DB-editable via runner_setting; capped at
# MAX_DOWNLOAD_SEGMENT_COUNT (16).
DEFAULT_DOWNLOAD_SEGMENTS_ENABLED = True
DEFAULT_DOWNLOAD_SEGMENT_COUNT = 8
# RETIRED 2026-07-20: the downloader decides single- vs multi-connection itself from the
# server's Range support + size, so this floor is inert. Kept as a constant (and the
# DB row / config-API field) for back-compat — `download_kwargs` no longer reads it.
DEFAULT_DOWNLOAD_SEGMENT_MIN_BYTES = 64 * 1024 * 1024
DEFAULT_DOWNLOAD_SEGMENT_RETRIES = 3
# CONCURRENT model downloads (2026-07-20): how many model downloads may run in parallel —
# clicking Download on several models now runs them at once (a per-model thread + admission
# gate in lifecycle), instead of the old "second click is a silent no-op". Read LIVE at
# admission so the knob is tunable without a restart; DB-editable via runner_setting.
DEFAULT_DOWNLOAD_MAX_CONCURRENT = 4
# Upper bounds for the count knobs (#10, 2026-07-17; concurrency added 2026-07-20). There was
# NO segment cap: a UI "20" spawned 20 parallel Range requests (one thread each), and past
# ~4-8 that only piles load on the CDN edge without adding speed (the comment above). 16 is a
# generous ceiling; retries past ~10 just prolong a genuinely-dead segment; >10 concurrent
# whole-model downloads just thrash the disk + CDN. The write path (engine-config PUT) and the
# read paths (download_kwargs / the lifecycle admission gate) all clamp to these — ONE source,
# so a raw DB poke can't route around them either.
MAX_DOWNLOAD_SEGMENT_COUNT = 16
MAX_DOWNLOAD_SEGMENT_RETRIES = 10
MAX_DOWNLOAD_CONCURRENT = 10

# Prebuilt llama-server distributions, selected by (platform, gpu). We never
# install a CUDA toolkit — we only DETECT the system and pick the matching
# prebuilt build; the Windows CUDA builds additionally need the separate cudart
# runtime DLLs (`runtime_url`), unpacked alongside the exe. Windows assets are
# `.zip`, macOS/Linux are `.tar.gz`. Filenames carry the build tag, so bumping
# DEFAULT_PINNED_BUILD produces the concrete URLs for that build (this seeds fresh
# installs + "reset to defaults"; after boot the UI re-points every stored URL to
# the pin whenever the pin changes — the server never composes a URL, it fetches
# whatever concrete URL is stored).
#
# Every filename below was verified against the release's own asset list
# (GET api.github.com/repos/ggml-org/llama.cpp/releases/tags/<build>) — do NOT
# hand-edit a name from memory; confirm it exists on the release first. The
# cudart-* companion is unversioned (same CUDA runtime across builds).
# (linux/cuda has no prebuilt archive — docker-only; see binary.acquire_binary.)
_REL = f"https://github.com/ggml-org/llama.cpp/releases/download/{DEFAULT_PINNED_BUILD}"
DEFAULT_BINARIES: list[dict] = [
    {"platform": "windows", "gpu": "cuda12", "source": "github",
     "asset_url": f"{_REL}/llama-{DEFAULT_PINNED_BUILD}-bin-win-cuda-12.4-x64.zip",
     "runtime_url": f"{_REL}/cudart-llama-bin-win-cuda-12.4-x64.zip",
     "server_exe": "llama-server.exe"},
    {"platform": "windows", "gpu": "cuda13", "source": "github",
     "asset_url": f"{_REL}/llama-{DEFAULT_PINNED_BUILD}-bin-win-cuda-13.3-x64.zip",
     "runtime_url": f"{_REL}/cudart-llama-bin-win-cuda-13.3-x64.zip",
     "server_exe": "llama-server.exe"},
    {"platform": "windows", "gpu": "rocm", "source": "github",
     "asset_url": f"{_REL}/llama-{DEFAULT_PINNED_BUILD}-bin-win-hip-radeon-x64.zip",
     "server_exe": "llama-server.exe"},
    {"platform": "windows", "gpu": "vulkan", "source": "github",
     "asset_url": f"{_REL}/llama-{DEFAULT_PINNED_BUILD}-bin-win-vulkan-x64.zip",
     "server_exe": "llama-server.exe"},
    # The cpu rows are RETIRED (user, 2026-07-07: "deleet" — a CPU-only machine
    # can't run local LLMs at usable speed, so no cpu build is offered or ever
    # downloaded, on any platform). A box with no usable GPU resolves to NO
    # engine (select_binary → None) instead of a uselessly slow one; the seeder
    # prunes the previously seeded built-in cpu rows from existing DBs.
    {"platform": "macos", "gpu": "metal", "source": "github",
     "asset_url": f"{_REL}/llama-{DEFAULT_PINNED_BUILD}-bin-macos-arm64.tar.gz",
     "server_exe": "llama-server"},
    {"platform": "linux", "gpu": "rocm", "source": "github",
     "asset_url": f"{_REL}/llama-{DEFAULT_PINNED_BUILD}-bin-ubuntu-rocm-7.2-x64.tar.gz",
     "server_exe": "llama-server"},
    {"platform": "linux", "gpu": "vulkan", "source": "github",
     "asset_url": f"{_REL}/llama-{DEFAULT_PINNED_BUILD}-bin-ubuntu-vulkan-x64.tar.gz",
     "server_exe": "llama-server"},
    # Linux CUDA: docker-only upstream, and NO pin-faithful image exists — per-build
    # image tags were discontinued (server-cuda-b47xx era only; every b96xx probe
    # 404s on ghcr; verified 2026-07-06), leaving rolling tags that track master.
    # The row stays as the FUTURE seam (never auto-selected — see
    # binary.select_binary); at the next pin bump, capture the digest
    # (`server-cuda@sha256:…`) while the rolling tag still points at that build,
    # put it here, then wire the container spawn. Until then Linux+NVIDIA selects
    # the pinned vulkan archive.
    {"platform": "linux", "gpu": "cuda12", "source": "docker",
     "image": "ghcr.io/ggml-org/llama.cpp:server-cuda",
     "server_exe": "llama-server"},
]


def default_config() -> RunnerConfig:
    """The standalone fallback RunnerConfig, built from the constants above (no
    host DB wired). Hosts inject a DB-backed `config_fn` instead."""
    return RunnerConfig(
        llamacpp=LlamacppSpec(
            pinned_build=DEFAULT_PINNED_BUILD,
            binaries=[BinaryAsset(**b) for b in DEFAULT_BINARIES],
        ),
        safety_margin_mb=DEFAULT_SAFETY_MARGIN_MB,
        models_max=DEFAULT_MODELS_MAX,
        sleep_idle_seconds=DEFAULT_SLEEP_IDLE_SECONDS,
        ctx_cap_tokens=DEFAULT_CTX_CAP_TOKENS,
    )
