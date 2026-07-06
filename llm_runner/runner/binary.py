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
    """Where a build's unpacked variants live (caller supplies the cache root)."""
    return cache_root / "llamacpp" / build


def variant_dir(cache_root: Path, build: str, gpu: str) -> Path:
    """Where ONE gpu-variant of a build unpacks (A3): `<build>/<gpu>/`. Multiple
    variants coexist so the spawn fallback chain has something to chain TO.
    Installs made before this layout landed live at the BUILD root — probes treat
    a root-level exe as the SELECTED asset's (legacy back-compat, never removed)."""
    return binary_dir(cache_root, build) / gpu


def _find_server_exe(root: Path, exe_name: str) -> Path | None:
    direct = root / exe_name
    if direct.is_file():
        return direct
    for found in root.rglob(exe_name):
        if found.is_file():
            return found
    return None


def _find_variant_exe(
    cache_root: Path, config: RunnerConfig, asset: BinaryAsset, *, legacy_root: bool
) -> Path | None:
    """An asset's installed exe: its variant dir first; optionally the legacy build
    root (pre-variant-layout installs — attributed ONLY to the selected asset, so
    one legacy exe never counts as every variant)."""
    build = config.llamacpp.pinned_build
    exe = _find_server_exe(variant_dir(cache_root, build, asset.gpu), asset.server_exe)
    if exe is None and legacy_root:
        root = binary_dir(cache_root, build)
        direct = root / asset.server_exe
        if direct.is_file():
            exe = direct
        else:
            # root-level legacy install: search WITHOUT descending into variant dirs
            # (a variant exe belongs to its own gpu key, not the legacy slot).
            variants = {b.gpu for b in config.llamacpp.binaries}
            for found in root.rglob(asset.server_exe):
                if found.is_file() and not any(part in variants for part in found.relative_to(root).parts[:1]):
                    exe = found
                    break
    return exe


def acquired_server_exe(
    cache_root: Path, config: RunnerConfig, hardware: HardwareInfo
) -> Path | None:
    asset = select_binary(config, hardware)
    if asset is None:
        return None
    return _find_variant_exe(cache_root, config, asset, legacy_root=True)


def acquired_server_exes(
    cache_root: Path, config: RunnerConfig, hardware: HardwareInfo
) -> list[tuple[str, Path]]:
    """Every INSTALLED build variant as (gpu_key, exe), in `_gpu_preference` order —
    the spawn fallback chain (A3) walks this list. It only ever REPORTS what is on
    disk; it never downloads (a load must not install — the engine-install split,
    decision A of the 2026-07-02 plan). The legacy build-root exe counts only for
    the SELECTED asset (single attribution)."""
    selected = select_binary(config, hardware)
    by_gpu = {b.gpu: b for b in config.llamacpp.binaries if b.platform == hardware.platform}
    out: list[tuple[str, Path]] = []
    for gpu in _gpu_preference(hardware):
        asset = by_gpu.get(gpu)
        if asset is None:
            continue
        exe = _find_variant_exe(
            cache_root, config, asset,
            legacy_root=selected is not None and asset.gpu == selected.gpu,
        )
        if exe is not None:
            out.append((gpu, exe))
    return out


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
    gpu: str | None = None,
) -> Path:
    """Ensure llama-server is on disk for the detected hardware; return path.

    Idempotent. Downloads + unpacks the github asset (`.zip` or `.tar.gz`) into
    the asset's VARIANT dir (`<build>/<gpu>/` — variants coexist for the A3 spawn
    fallback chain; a pre-variant install at the build root still satisfies the
    SELECTED asset); if the asset declares a `runtime_url` companion (the Windows
    CUDA cudart DLLs) it is fetched + unpacked into the SAME dir so the exe can
    launch. `gpu` overrides selection to install a SPECIFIC variant (the engine
    install uses it to plant the CPU/Vulkan fallbacks). Docker sources raise
    (Linux CUDA via docker is a later item).
    """
    if gpu is None:
        asset = select_binary(config, hardware)
    else:
        asset = next(
            (b for b in config.llamacpp.binaries
             if b.platform == hardware.platform and b.gpu == gpu),
            None,
        )
    if asset is None:
        raise RuntimeError(
            f"no llama.cpp binary configured for platform={hardware.platform}"
            + (f" gpu={gpu}" if gpu else "")
        )

    selected = select_binary(config, hardware)
    existing = _find_variant_exe(
        cache_root, config, asset,
        legacy_root=selected is not None and asset.gpu == selected.gpu,
    )
    if existing is not None:
        return existing
    dest = variant_dir(cache_root, config.llamacpp.pinned_build, asset.gpu)

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
