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

from .download import download_kwargs, stream_download
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


def gpu_family(gpu: str) -> str:
    """The user-facing backend FAMILY of a concrete asset key: every chip-specific
    CUDA build (`cuda12`/`cuda13`) collapses to `"cuda"`; the rest are their own
    family. The UI offers/pins families; the runner resolves the concrete key."""
    g = (gpu or "").strip().lower()
    return "cuda" if g.startswith("cuda") else g


def concrete_gpu(hardware: HardwareInfo, family: str) -> str:
    """Map a backend FAMILY the user picked (`cuda`/`vulkan`/…) to the concrete
    asset key for THIS box — `cuda` → the chip-aware `_cuda_key`; others are their
    own key. Empty stays empty (Auto)."""
    fam = (family or "").strip().lower()
    if not fam:
        return ""
    return _cuda_key(hardware) if fam == "cuda" else fam


def _gpu_preference(hardware: HardwareInfo, preferred: str = "") -> list[str]:
    """Ordered GPU-asset preference, most-capable first, CPU last.

    NVIDIA → the chip-aware CUDA build (`_cuda_key`). AMD/Intel → ROCm/HIP
    first (best perf when detected), Vulkan as the universal fallback. CPU is
    always the final fallback. A non-empty `preferred` FAMILY (the user's backend
    override) is moved to the FRONT when that runtime is actually present —
    otherwise it is ignored, so a pin for a backend this box can't run degrades
    silently to the auto order (the spawn chain still honours what's installed).
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
    want = concrete_gpu(hardware, preferred)
    if want and want in prefs:
        prefs.remove(want)
        prefs.insert(0, want)
    return prefs


def select_binary(config: RunnerConfig, hardware: HardwareInfo) -> BinaryAsset | None:
    """Pick the best binary asset for (platform, gpu); None if none match.

    `source="docker"` rows are NEVER auto-selected (A4, re-scoped 2026-07-06):
    upstream discontinued per-build image tags (only rolling `server-cuda*`
    remain — verified against ghcr manifests), so no PIN-FAITHFUL container
    exists for the pinned build; auto-selecting one would hand out an engine
    that silently tracks master, breaking the b-pin every switch/tune fact is
    grounded on. A Linux+NVIDIA box therefore falls to the real pinned vulkan
    archive (the vulkan runtime fact is recorded by detect()), else cpu. The
    row stays in config as the future seam — a digest-pinned image captured at
    the next pin bump re-enables it."""
    by_gpu = {
        b.gpu: b
        for b in config.llamacpp.binaries
        if b.platform == hardware.platform and b.source != "docker"
    }
    for gpu in _gpu_preference(hardware, config.preferred_gpu):
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


def build_num(tag: str) -> int:
    """Numeric part of a llama.cpp build tag ("b9929" → 9929; -1 when none) —
    one parser shared by the update check and the newest-on-disk ordering."""
    digits = "".join(ch for ch in str(tag) if ch.isdigit())
    return int(digits) if digits else -1


def _on_disk_builds(cache_root: Path) -> list[str]:
    """Build dirs actually present under `llamacpp/`, newest tag first. "logs" is
    the one non-build sibling dir; loose files (the generated models.ini) are
    files, not dirs, so the scan never sees them."""
    root = cache_root / "llamacpp"
    if not root.is_dir():
        return []
    names = [d.name for d in root.iterdir() if d.is_dir() and d.name != "logs"]
    return sorted(names, key=build_num, reverse=True)


def build_of_exe(cache_root: Path, exe: Path) -> str | None:
    """The build an installed exe IS — read from the dir it lives under (`llamacpp/<build>/…`).
    Reliable because the install names the folder for the pin AND downloads the concrete URL
    stored for that pin (the UI keeps every stored URL in lock-step with the pin), so the folder
    name and the binary always agree. (The `--version` cross-check + mismatch flag that briefly
    lived here were a band-aid for the old decoupling — removed once the URL followed the pin.)"""
    try:
        return exe.relative_to(cache_root / "llamacpp").parts[0]
    except ValueError:
        return None


def _find_server_exe(root: Path, exe_name: str) -> Path | None:
    direct = root / exe_name
    if direct.is_file():
        return direct
    for found in root.rglob(exe_name):
        if found.is_file():
            return found
    return None


def _find_variant_exe(
    cache_root: Path, config: RunnerConfig, asset: BinaryAsset, *,
    legacy_root: bool, build: str | None = None,
) -> Path | None:
    """An asset's installed exe within ONE build (the pin unless `build` says
    otherwise): its variant dir first; optionally the legacy build root
    (pre-variant-layout installs — attributed ONLY to the selected asset, so
    one legacy exe never counts as every variant). The WRITE path
    (`acquire_binary`) uses this pin-keyed form directly — install/update
    always TARGET the pin."""
    if build is None:
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


def _find_installed_exe(
    cache_root: Path, config: RunnerConfig, asset: BinaryAsset, *, legacy_root: bool
) -> Path | None:
    """READ-path resolution (QC-13, the user's law: "check the path and if path
    exe exist assume engine is installed"): the pinned build when its folder
    holds the exe, else the NEWEST on-disk build folder that does — a DB reset
    reverting the pin must not hide an engine the Update flow already installed.
    Only status/spawn/uninstall resolve; `acquire_binary` stays pin-keyed
    (resolving there would let a pin-bump Update skip its download and the
    stale-build sweep would then delete the only engine on disk)."""
    pinned = config.llamacpp.pinned_build
    for candidate in [pinned, *(b for b in _on_disk_builds(cache_root) if b != pinned)]:
        exe = _find_variant_exe(
            cache_root, config, asset, legacy_root=legacy_root, build=candidate
        )
        if exe is not None:
            return exe
    return None


def acquired_server_exe(
    cache_root: Path, config: RunnerConfig, hardware: HardwareInfo
) -> Path | None:
    asset = select_binary(config, hardware)
    if asset is None:
        return None
    return _find_installed_exe(cache_root, config, asset, legacy_root=True)


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
    for gpu in _gpu_preference(hardware, config.preferred_gpu):
        asset = by_gpu.get(gpu)
        if asset is None:
            continue
        exe = _find_installed_exe(
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
    install uses it to plant the CPU/Vulkan fallbacks). Docker sources raise —
    they are never auto-selected (see `select_binary`), and forcing one via
    `gpu=` explains the pin story (no pin-faithful image exists for the pinned
    build; the route returns when a digest is captured at a pin bump).
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
            f"binary source {asset.source!r} for {asset.platform}/{asset.gpu} is not "
            "installable: upstream publishes no pin-faithful container image for the "
            "pinned build (rolling tags only — they track master and would break the "
            "build pin). Linux NVIDIA boxes use the pinned Vulkan build automatically; "
            "the container route returns when a digest-pinned image is captured at a "
            "pin bump."
        )

    dest.mkdir(parents=True, exist_ok=True)

    def _fetch(url: str) -> None:
        suffix = ".tar.gz" if url.lower().endswith((".tar.gz", ".tgz")) else ".zip"
        archive = dest / f"_download{suffix}"
        log.info("downloading llama.cpp %s/%s from %s", asset.platform, asset.gpu, url)
        stream_download(url, archive, on_progress=on_progress, cancel_check=cancel_check,
                        **download_kwargs(config))
        _unpack(archive, dest)
        archive.unlink(missing_ok=True)

    # The stored URL is the CONCRETE download for the pinned build (the UI re-points every
    # stored URL whenever the pin changes); the folder above is named for that same pin, so
    # folder and binary agree. The server does NOT compose a URL — it fetches what is stored.
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
