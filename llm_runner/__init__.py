# SPDX-License-Identifier: GPL-3.0-or-later
"""just-llm-runner — shared local-LLM runner core for JustVoice + JustWrite.

Detects hardware, manages/recommends GGUF models, downloads the right
prebuilt llama.cpp (CUDA runtime bundled — no toolkit install), and spawns
llama-server (OpenAI-compatible). Mount `router` on either app's FastAPI.

Internal library — consumed as a git dependency, NOT published to PyPI.
See docs/plans/2026-06-16-builtin-llm-runner.md in the JustVoice repo.
"""

from .api import router
from .binary import acquire_binary, acquired_server_exe, binary_dir, select_binary
from .download import DownloadCancelled, stream_download
from .hardware import detect, platform_key
from .manifest import load_manifest, manifest_path
from .schema import HardwareInfo, RunnerManifest

__all__ = [
    "router",
    "load_manifest",
    "manifest_path",
    "RunnerManifest",
    "HardwareInfo",
    "detect",
    "platform_key",
    "select_binary",
    "acquire_binary",
    "acquired_server_exe",
    "binary_dir",
    "stream_download",
    "DownloadCancelled",
]
