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

The base/mtp flag presets are NOT here — they live in the DB `switch_presets`
and reach the spawn via the runner's `switches_fn` → `Overrides`.
"""

from __future__ import annotations

from .schema import BinaryAsset, LlamacppSpec, RunnerConfig

# EXACT llama.cpp release tag (never "latest" — reproducible spawns).
DEFAULT_PINNED_BUILD = "b9644"

# Reserve this much VRAM headroom when computing the GPU layer split.
DEFAULT_SAFETY_MARGIN_MB = 1024

# Prebuilt llama-server distributions, selected by (platform, gpu). The CUDA
# RUNTIME is bundled inside the asset — there is NO CUDA-toolkit install; we
# only detect + pick the right build. (github-zip assets download+unzip; the
# linux/cuda docker source is a later item — see binary.acquire_binary.)
DEFAULT_BINARIES: list[dict] = [
    {"platform": "windows", "gpu": "cuda12", "source": "github",
     "asset_url": f"https://github.com/ggml-org/llama.cpp/releases/download/{DEFAULT_PINNED_BUILD}/cudart-llama-bin-win-cuda-12.4-x64.zip",
     "server_exe": "llama-server.exe"},
    {"platform": "windows", "gpu": "cuda13", "source": "github",
     "asset_url": f"https://github.com/ggml-org/llama.cpp/releases/download/{DEFAULT_PINNED_BUILD}/cudart-llama-bin-win-cuda-13.3-x64.zip",
     "server_exe": "llama-server.exe"},
    {"platform": "windows", "gpu": "cpu", "source": "github",
     "asset_url": f"https://github.com/ggml-org/llama.cpp/releases/download/{DEFAULT_PINNED_BUILD}/llama-bin-win-cpu-x64.zip",
     "server_exe": "llama-server.exe"},
    {"platform": "macos", "gpu": "metal", "source": "github",
     "asset_url": f"https://github.com/ggml-org/llama.cpp/releases/download/{DEFAULT_PINNED_BUILD}/llama-bin-macos-arm64.zip",
     "server_exe": "llama-server"},
    {"platform": "linux", "gpu": "cuda12", "source": "docker",
     "image": f"ghcr.io/ggml-org/llama.cpp:server-cuda12-{DEFAULT_PINNED_BUILD}",
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
    )
