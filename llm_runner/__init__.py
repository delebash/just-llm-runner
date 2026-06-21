# SPDX-License-Identifier: GPL-3.0-or-later
"""just-llm-runner — shared local-LLM runner core for JustVoice + JustWrite.

Detects hardware, manages/recommends GGUF models, downloads the right
prebuilt llama.cpp (CUDA runtime bundled — no toolkit install), and spawns
llama-server (OpenAI-compatible). Mount `router` on either app's FastAPI.

Internal library — consumed as a git dependency, NOT published to PyPI.
See docs/plans/2026-06-16-builtin-llm-runner.md in the JustVoice repo.
"""

from .runner.api import router
from .runner.binary import acquire_binary, acquired_server_exe, binary_dir, select_binary
from .runner.download import DownloadCancelled, stream_download
from .runner.gguf import GgufMeta, read_gguf_metadata
from .runner.hardware import detect, platform_key
from .runner.lifecycle import RunnerService, get_service
from .runner.manifest import load_manifest, manifest_path
from .runner.models import acquire_model, hf_cache_root, is_cached, select_files
from .runner.process import (
    FitPlan,
    Overrides,
    Runner,
    RunnerStartError,
    compose_flags,
    compute_fit,
    start_runner,
)
from .runner.schema import (
    HardwareInfo,
    RunnerManifest,
    RunnerModelInfo,
    RunnerModelsResponse,
)

__all__ = [
    "router",
    "RunnerService",
    "get_service",
    "load_manifest",
    "manifest_path",
    "RunnerManifest",
    "RunnerModelInfo",
    "RunnerModelsResponse",
    "HardwareInfo",
    "detect",
    "is_cached",
    "platform_key",
    "select_binary",
    "acquire_binary",
    "acquired_server_exe",
    "binary_dir",
    "stream_download",
    "DownloadCancelled",
    "select_files",
    "acquire_model",
    "hf_cache_root",
    "GgufMeta",
    "read_gguf_metadata",
    "compute_fit",
    "compose_flags",
    "start_runner",
    "Runner",
    "RunnerStartError",
    "FitPlan",
    "Overrides",
]
