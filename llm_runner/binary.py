# SPDX-License-Identifier: GPL-3.0-or-later
"""llama.cpp binary acquisition — select + download + unpack.

Self-contained (uses this package's own hardware + download), so it runs
in JustWrite's sidecar with no app coupling. The CUDA runtime is bundled
inside the prebuilt asset; this only DETECTS + SELECTS, never installs CUDA.
"""

from __future__ import annotations

import logging
import zipfile
from pathlib import Path
from typing import Callable

from .download import stream_download
from .schema import BinaryAsset, HardwareInfo, RunnerManifest

log = logging.getLogger(__name__)


def _gpu_preference(hardware: HardwareInfo) -> list[str]:
    """Ordered GPU-asset preference, most-capable first, CPU last.

    cuda13 needs a newer driver than cuda12, so default to cuda12 (broad
    compat); a future refinement can promote to cuda13 from the driver
    version. CPU is the universal fallback.
    """
    rt = hardware.runtimes or {}
    prefs: list[str] = []
    if rt.get("metal"):
        prefs.append("metal")
    if rt.get("cuda"):
        prefs.append("cuda12")
    if rt.get("rocm"):
        prefs.append("rocm")
    if rt.get("vulkan"):
        prefs.append("vulkan")
    prefs.append("cpu")
    return prefs


def select_binary(manifest: RunnerManifest, hardware: HardwareInfo) -> BinaryAsset | None:
    """Pick the best binary asset for (platform, gpu); None if none match."""
    by_gpu = {b.gpu: b for b in manifest.llamacpp.binaries if b.platform == hardware.platform}
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
    cache_root: Path, manifest: RunnerManifest, hardware: HardwareInfo
) -> Path | None:
    asset = select_binary(manifest, hardware)
    if asset is None:
        return None
    return _find_server_exe(binary_dir(cache_root, manifest.llamacpp.pinned_build), asset.server_exe)


def _unzip(zip_path: Path, dest: Path) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(dest)


def acquire_binary(
    cache_root: Path,
    manifest: RunnerManifest,
    hardware: HardwareInfo,
    on_progress: Callable[[int], None] | None = None,
    cancel_check: Callable[[], bool] | None = None,
) -> Path:
    """Ensure llama-server is on disk for the detected hardware; return path.

    Idempotent. github-zip assets download + unzip; docker sources raise
    (Linux CUDA via docker is a later item).
    """
    asset = select_binary(manifest, hardware)
    if asset is None:
        raise RuntimeError(f"no llama.cpp binary in manifest for platform={hardware.platform}")

    dest = binary_dir(cache_root, manifest.llamacpp.pinned_build)
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
    archive = dest / "_download.zip"
    log.info("downloading llama.cpp %s/%s from %s", asset.platform, asset.gpu, asset.asset_url)
    stream_download(
        asset.asset_url, archive,
        on_progress=on_progress, cancel_check=cancel_check,
    )
    _unzip(archive, dest)
    archive.unlink(missing_ok=True)

    exe = _find_server_exe(dest, asset.server_exe)
    if exe is None:
        raise RuntimeError(f"{asset.server_exe} not found in unpacked archive at {dest}")
    if hardware.platform != "windows":
        exe.chmod(exe.stat().st_mode | 0o111)
    return exe
