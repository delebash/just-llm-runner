# SPDX-License-Identifier: GPL-3.0-or-later
"""llama.cpp binary acquisition — select + download + unpack.

Self-contained (uses this package's own hardware + download), so it runs
in JustWrite's sidecar with no app coupling. No CUDA toolkit is ever
installed; this only DETECTS + SELECTS the prebuilt build. Windows CUDA
builds need the separate cudart runtime DLLs (`asset.runtime_url`) unpacked
alongside the exe — those are fetched too.
"""

from __future__ import annotations

import logging
import sys
import tarfile
import zipfile
from pathlib import Path
from typing import Callable

from .download import stream_download
from .schema import BinaryAsset, HardwareInfo, RunnerConfig

log = logging.getLogger(__name__)


def _cuda_key(hardware: HardwareInfo) -> str:
    """Choose the CUDA build by the GPU chip (compute capability).

    Blackwell (sm_100/sm_120 → compute cap 10.0/12.0) needs CUDA ≥ 12.8, so our
    12.4 build can't target it → use the 13.x build. Older cards (Turing 7.5,
    Ampere/Ada 8.x) run on both → 12.4 for broad driver compatibility. An unknown
    capability defaults to 12.4 (the safe, widest-compat build).
    """
    max_cap = 0.0
    for g in hardware.gpus or []:
        try:
            max_cap = max(max_cap, float(g.compute_cap or 0))
        except (TypeError, ValueError):
            continue
    return "cuda13" if max_cap >= 10.0 else "cuda12"


def _gpu_preference(hardware: HardwareInfo) -> list[str]:
    """Ordered GPU-asset preference, most-capable first, CPU last.

    NVIDIA → the chip-aware CUDA build (`_cuda_key`). AMD/Intel → ROCm/HIP
    first (best perf when detected), Vulkan as the universal fallback. CPU is
    always the final fallback.
    """
    rt = hardware.runtimes or {}
    prefs: list[str] = []
    if rt.get("metal"):
        prefs.append("metal")
    if rt.get("cuda"):
        prefs.append(_cuda_key(hardware))
    if rt.get("rocm"):
        prefs.append("rocm")
    if rt.get("vulkan"):
        prefs.append("vulkan")
    prefs.append("cpu")
    return prefs


def select_binary(config: RunnerConfig, hardware: HardwareInfo) -> BinaryAsset | None:
    """Pick the best binary asset for (platform, gpu); None if none match."""
    by_gpu = {b.gpu: b for b in config.llamacpp.binaries if b.platform == hardware.platform}
    for gpu in _gpu_preference(hardware):
        if gpu in by_gpu:
            return by_gpu[gpu]
    return None


def binary_dir(cache_root: Path, build: str) -> Path:
    """Where an unpacked build lives (caller supplies the cache root)."""
    return cache_root / "llamacpp" / build


def _find_server_exe(root: Path, exe_name: str) -> Path | None:
    direct = root / exe_name
    if direct.is_file():
        return direct
    for found in root.rglob(exe_name):
        if found.is_file():
            return found
    return None


def acquired_server_exe(
    cache_root: Path, config: RunnerConfig, hardware: HardwareInfo
) -> Path | None:
    asset = select_binary(config, hardware)
    if asset is None:
        return None
    return _find_server_exe(binary_dir(cache_root, config.llamacpp.pinned_build), asset.server_exe)


def _unpack(archive: Path, dest: Path) -> None:
    """Extract `archive` into `dest` — a `.zip` (Windows) or a `.tar.gz`/`.tgz`
    (macOS/Linux). Assets come from the pinned llama.cpp release (trusted)."""
    dest.mkdir(parents=True, exist_ok=True)
    if archive.name.lower().endswith((".tar.gz", ".tgz")):
        with tarfile.open(archive, "r:gz") as tf:
            # `filter="data"` (3.12+) sanitizes member paths (traversal-safe);
            # older runtimes fall back — the asset is a pinned, trusted release.
            if sys.version_info >= (3, 12):
                tf.extractall(dest, filter="data")
            else:
                tf.extractall(dest)  # noqa: S202 — trusted GitHub release asset
    else:
        with zipfile.ZipFile(archive) as zf:
            zf.extractall(dest)


def acquire_binary(
    cache_root: Path,
    config: RunnerConfig,
    hardware: HardwareInfo,
    on_progress: Callable[[int, int | None], None] | None = None,
    cancel_check: Callable[[], bool] | None = None,
) -> Path:
    """Ensure llama-server is on disk for the detected hardware; return path.

    Idempotent. Downloads + unpacks the github asset (`.zip` or `.tar.gz`); if
    the asset declares a `runtime_url` companion (the Windows CUDA cudart DLLs)
    it is fetched + unpacked into the SAME dir so the exe can launch. Docker
    sources raise (Linux CUDA via docker is a later item).
    """
    asset = select_binary(config, hardware)
    if asset is None:
        raise RuntimeError(f"no llama.cpp binary configured for platform={hardware.platform}")

    dest = binary_dir(cache_root, config.llamacpp.pinned_build)
    existing = _find_server_exe(dest, asset.server_exe)
    if existing is not None:
        return existing

    if asset.source == "docker" or not asset.asset_url:
        raise NotImplementedError(
            f"binary source {asset.source!r} for {asset.platform}/{asset.gpu} not wired "
            "yet (Linux CUDA via docker is a later item); use a github asset or an "
            "external llama-server"
        )

    dest.mkdir(parents=True, exist_ok=True)

    def _fetch(url: str) -> None:
        suffix = ".tar.gz" if url.lower().endswith((".tar.gz", ".tgz")) else ".zip"
        archive = dest / f"_download{suffix}"
        log.info("downloading llama.cpp %s/%s from %s", asset.platform, asset.gpu, url)
        stream_download(url, archive, on_progress=on_progress, cancel_check=cancel_check)
        _unpack(archive, dest)
        archive.unlink(missing_ok=True)

    _fetch(asset.asset_url)
    # CUDA builds ship the cudart runtime DLLs separately — unpack alongside the exe.
    if asset.runtime_url:
        _fetch(asset.runtime_url)

    exe = _find_server_exe(dest, asset.server_exe)
    if exe is None:
        raise RuntimeError(f"{asset.server_exe} not found in unpacked archive at {dest}")
    if hardware.platform != "windows":
        exe.chmod(exe.stat().st_mode | 0o111)
    return exe
