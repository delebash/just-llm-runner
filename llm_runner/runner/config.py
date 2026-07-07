# SPDX-License-Identifier: GPL-3.0-or-later
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
# same day — all 11 filenames below exist under the identical naming scheme, so only
# the tag changes. NOTE: seeding is insert-if-missing (`seed_default_runner_settings`),
# so an EXISTING DB keeps its old `pinned_build` row — bump it in the UI (Settings → AI
# → engine Binaries panel) or the row directly; this constant fixes fresh installs and
# the panel's "reset to defaults".
DEFAULT_PINNED_BUILD = "b9870"

# Reserve this much VRAM headroom when computing the GPU layer split.
DEFAULT_SAFETY_MARGIN_MB = 1024

# Router mode (P1e): the count-based co-resident cap (`--models-max`; the arbiter
# works WITHIN it) and the native idle-unload TTL (`--sleep-idle-seconds`; 0 =
# never sleep). DB-editable via runner_setting; these are the standalone/seed
# defaults. models_max=2 keeps a chat model + a tiny embed co-resident on a small
# card; sleep_idle=900 s keeps the active model warm through normal writing pauses.
DEFAULT_MODELS_MAX = 2
DEFAULT_SLEEP_IDLE_SECONDS = 900

# Prebuilt llama-server distributions, selected by (platform, gpu). We never
# install a CUDA toolkit — we only DETECT the system and pick the matching
# prebuilt build; the Windows CUDA builds additionally need the separate cudart
# runtime DLLs (`runtime_url`), unpacked alongside the exe. Windows assets are
# `.zip`, macOS/Linux are `.tar.gz`. Filenames carry the build tag, so bumping
# DEFAULT_PINNED_BUILD rewrites every URL (single source of truth).
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
    )
