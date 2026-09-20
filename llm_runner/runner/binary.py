# SPDX-License-Identifier: MIT
"""llama.cpp binary acquisition — select + download + unpack.

Self-contained (uses this package's own hardware + download), so it runs
in JustWrite's sidecar with no app coupling. No CUDA toolkit is ever
installed; this only DETECTS + SELECTS the prebuilt build. Windows CUDA
builds need the separate cudart runtime DLLs (`asset.runtime_url`) unpacked
alongside the exe — those are fetched too.
"""

from __future__ import annotations

import logging
import re
import shutil
import subprocess
import sys
import tarfile
import zipfile
from pathlib import Path
from typing import Callable, Sequence

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
    """Numeric part of a llama.cpp BUILD tag ("b9929" → 9929); -1 for anything else —
    one parser shared by the update check and the newest-on-disk ordering.

    STRICT since 2026-09-19 (plan docs/plans/2026-09-19-engine-update-safety-and-stable-
    channel.md §3.2). Upstream began publishing semver releases ("v0.4.1") on 2026-08-21 and
    flagging every bNNNN build a prerelease, so `releases/latest` started answering a `v` tag.
    The old digit-strip read "v0.4.1" as 41 — less than any build — so the update check has
    reported "you are current", with no error, ever since; and a future "v1.10.500" would
    read as 110500, i.e. newer than every build, offering an update whose download 404s."""
    m = re.fullmatch(r"b(\d+)", str(tag or "").strip())
    return int(m.group(1)) if m else -1


_UPSTREAM_DL = "https://github.com/ggml-org/llama.cpp/releases/download"

# (platform, gpu) → (asset regex, runtime-companion regex | None). `{b}` = the escaped build
# tag; `{v}` = the CUDA version captured from the chosen asset (an asset on 12.4 needs the
# cudart on 12.4). Patterns are ANCHORED and end in the arch, so `…-win-cuda-13.4-arm64.zip`
# can never satisfy an x64 row.
#
# WHY THIS EXISTS (2026-09-19, plan docs/plans/2026-09-19-engine-update-safety-and-stable-
# channel.md §3.4): upstream RENAMES these files between builds, and the update flow used to
# just substitute the tag into the stored name. Windows AMD went hip-radeon → rocm-7.14 →
# rocm-10.0, Linux AMD rocm-7.2 → (absent for ~180 builds) → rocm-10.0, Windows CUDA 13
# 13.3 → 13.4. A substituted name that no longer exists is a 404 mid-update.
ASSET_PATTERNS: dict[tuple[str, str], tuple[str, str | None]] = {
    ("windows", "cuda12"): (r"^llama-{b}-bin-win-cuda-(12\.\d+)-x64\.zip$",
                            r"^cudart-llama-bin-win-cuda-{v}-x64\.zip$"),
    ("windows", "cuda13"): (r"^llama-{b}-bin-win-cuda-(13\.\d+)-x64\.zip$",
                            r"^cudart-llama-bin-win-cuda-{v}-x64\.zip$"),
    ("windows", "rocm"):   (r"^llama-{b}-bin-win-(?:hip-radeon|rocm-([\d.]+))-x64\.zip$", None),
    ("windows", "vulkan"): (r"^llama-{b}-bin-win-vulkan-x64\.zip$", None),
    ("macos", "metal"):    (r"^llama-{b}-bin-macos-arm64\.tar\.gz$", None),
    ("linux", "rocm"):     (r"^llama-{b}-bin-ubuntu-rocm-([\d.]+)-x64\.tar\.gz$", None),
    ("linux", "vulkan"):   (r"^llama-{b}-bin-ubuntu-vulkan-x64\.tar\.gz$", None),
}


def _fill(pattern: str, build: str, version: str = "") -> str:
    """Placeholders are substituted, never `str.format`ed — the patterns contain regex braces."""
    return pattern.replace("{b}", re.escape(build)).replace("{v}", re.escape(version))


def _version_key(captured: str | None) -> tuple:
    """Sort key for a captured version ('10.0' > '7.14'); no capture ranks lowest."""
    if not captured:
        return (0,)
    return (1, *(int(part) for part in captured.split(".") if part.isdigit()))


def resolve_release_assets(build: str, rows, assets) -> list[dict]:
    """Map each stored binary row to the file that BUILD actually publishes.

    Pure: `assets` is `[{"name": str, "url": str}]` from the release, `rows` are
    `BinaryAsset`s (`config.llamacpp.binaries`). Per row, `resolved` is
      True  — found; `assetUrl`/`runtimeUrl` are that build's real downloads,
      False — this build publishes nothing for that (platform, gpu),
      None  — not ours to resolve: a docker row, a (platform, gpu) with no pattern, or a
              hand-edited URL that is not an upstream release download (a mirror stays put).
    Result rows are camelCase so the UI can merge them straight into the engine-config
    `binaries` it PUTs. Unresolved and not-ours rows keep their stored URLs untouched."""
    names = {str(a.get("name") or ""): str(a.get("url") or "") for a in (assets or [])}
    out: list[dict] = []
    for row in rows or []:
        platform, gpu = getattr(row, "platform", ""), getattr(row, "gpu", "")
        asset_url = getattr(row, "asset_url", "") or ""
        runtime_url = getattr(row, "runtime_url", "") or ""
        res: dict = {"platform": platform, "gpu": gpu, "assetUrl": asset_url,
                     "runtimeUrl": runtime_url, "resolved": None, "reason": ""}
        pattern = ASSET_PATTERNS.get((platform, gpu))
        if getattr(row, "source", "github") != "github":
            res["reason"] = f"{getattr(row, 'source', '')} rows are not release downloads"
        elif pattern is None:
            res["reason"] = f"no asset pattern for {platform}/{gpu}"
        elif "/ggml-org/llama.cpp/releases/download/" not in asset_url:
            res["reason"] = "a custom URL — left exactly as stored"
        else:
            asset_re, runtime_re = pattern
            matches = [(m, n) for n in names
                       if (m := re.fullmatch(_fill(asset_re, build), n)) is not None]
            best = max(matches, key=lambda mn: _version_key(
                next((g for g in mn[0].groups() if g), None)), default=None)
            if best is None:
                res["resolved"] = False
                res["reason"] = f"no download for {platform}/{gpu} at {build}"
            else:
                match, name = best
                version = next((g for g in match.groups() if g), "") or ""
                new_runtime = ""
                if runtime_re is not None:
                    want = _fill(runtime_re, build, version)
                    new_runtime = next((names[n] or f"{_UPSTREAM_DL}/{build}/{n}"
                                        for n in names if re.fullmatch(want, n)), "")
                    if not new_runtime:
                        res["resolved"] = False
                        res["reason"] = (f"{name} has no matching runtime companion "
                                         f"at {build} — it would not launch")
                        out.append(res)
                        continue
                res.update(resolved=True,
                           assetUrl=names[name] or f"{_UPSTREAM_DL}/{build}/{name}",
                           runtimeUrl=new_runtime)
        out.append(res)
    return out


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


def _verify_exe_launches(exe: Path, platform: str, *, run: Callable[[], object] | None = None) -> None:
    """Confirm a freshly-unpacked llama-server actually STARTS — the check a file-existence
    test can't do. Runs `<exe> --version` (no model, ~instant): a RUNTIME-LOADER failure
    (a missing DLL on Windows / a missing `.so` on Linux — the binary never reaches user
    code) raises RuntimeError so the caller discards the staged build and leaves the working
    engine untouched. Born 2026-07-21: an engine update landed a build whose cudart companion
    was absent; the exe FILE was present so the install "succeeded", the old build was swept,
    and every launch then died with exit 3221225781 (0xC0000135 STATUS_DLL_NOT_FOUND) —
    permanent until a manual reinstall. `run` injects the subprocess in tests."""
    try:
        proc = run() if run else subprocess.run(  # noqa: S603 — a trusted, just-unpacked release exe
            [str(exe), "--version"], capture_output=True, timeout=60)
        rc = int(getattr(proc, "returncode", 0) or 0)
    except OSError as e:                       # the OS could not even start the image
        raise RuntimeError(f"engine binary {exe} could not start: {e}") from e
    except subprocess.TimeoutExpired as e:
        raise RuntimeError(f"engine binary {exe} hung on --version: {e}") from e
    # A loader failure has a distinctive exit: an NTSTATUS error on Windows (>= 0xC0000000,
    # e.g. 0xC0000135 = missing DLL) or 127 on Unix (missing shared library). ANY other code
    # — including a non-zero APP exit — means the process RAN, so its libraries loaded.
    loader_failed = rc >= 0xC0000000 if platform == "windows" else rc == 127
    if loader_failed:
        raise RuntimeError(
            f"engine binary {exe} failed to launch (exit {rc}"
            + (f" / 0x{rc & 0xFFFFFFFF:08X}" if platform == "windows" else "")
            + ") — a required runtime library is missing")


def _swap_into_place(staging: Path, dest: Path) -> None:
    """Atomically replace `dest` with the verified `staging` dir: retire the old dir to a
    sibling backup, move the new one in, then delete the backup — so the working engine only
    ever vanishes for the microsecond between two same-volume renames, and a mid-swap failure
    restores it. Windows can't rename onto an existing dir, so the old one is moved aside
    first. Both dirs are siblings under `<build>/`, so the renames stay on one volume."""
    backup = dest.parent / f".old-{dest.name}"
    shutil.rmtree(backup, ignore_errors=True)
    if dest.exists():
        dest.rename(backup)
    try:
        staging.rename(dest)
    except OSError:
        if backup.exists() and not dest.exists():
            backup.rename(dest)                # roll back — the working engine is restored
        raise
    shutil.rmtree(backup, ignore_errors=True)


def _verify_exe_accepts_flags(exe: Path, argvs, *, run: Callable | None = None) -> None:
    """Confirm a freshly-unpacked llama-server ACCEPTS the launch flags this app emits —
    the check `--version` alone cannot do.

    Born 2026-09-19 (plan docs/plans/2026-09-19-engine-update-safety-and-stable-channel.md
    §3.3): llama.cpp b10875 DELETED `--mlock` and `--mmap`/`--no-mmap`. Such a build starts
    fine, so `_verify_exe_launches` passes it, it is swapped in, the old build is swept — and
    then every model load dies on "error: invalid argument" (or, through the router's preset
    file, "option not recognized in preset"). A non-zero exit here raises, so the caller
    discards the staged build and the working engine stays exactly where it was.

    Each argv is `<flags…> --version`: args parse in order and `--version` exits on sight, so
    no model is loaded and no GPU is touched. `run` injects the subprocess in tests."""
    for argv in argvs or ():
        try:
            proc = run(argv) if run else subprocess.run(  # noqa: S603 — a trusted, just-unpacked release exe
                [str(exe), *argv], capture_output=True, timeout=60)
        except (OSError, subprocess.TimeoutExpired) as e:
            raise RuntimeError(f"engine binary {exe} could not run the flag check: {e}") from e
        rc = int(getattr(proc, "returncode", 0) or 0)
        if rc != 0:
            blob = b"".join(x for x in (getattr(proc, "stdout", b"") or b"",
                                        getattr(proc, "stderr", b"") or b"") if x)
            line = next((ln.strip() for ln in blob.decode("utf-8", "replace").splitlines()
                         if "invalid argument" in ln or "error while handling argument" in ln), "")
            raise RuntimeError(
                "this engine build does not accept a launch flag this app uses"
                + (f" ({line})" if line else f" (exit {rc})")
                + " — the installed engine was left in place")


def acquire_binary(
    cache_root: Path,
    config: RunnerConfig,
    hardware: HardwareInfo,
    on_progress: Callable[[int, int | None], None] | None = None,
    cancel_check: Callable[[], bool] | None = None,
    gpu: str | None = None,
    force: bool = False,
    probe_argvs: Sequence[Sequence[str]] | None = None,
) -> Path:
    """Ensure llama-server is on disk for the detected hardware; return path.

    ATOMIC + VERIFIED (2026-07-21): the download + unpack happen in a STAGING dir, the
    unpacked exe is launch-verified (`_verify_exe_launches`), and only then is it swapped
    into the live variant dir (`_swap_into_place`). A failed/partial/broken download — or a
    build missing a runtime DLL — never touches the working engine, and the caller's
    stale-build sweep runs only AFTER a good build is in place. Since 2026-09-19 the staged
    exe must also ACCEPT the launch flags this app emits (`probe_argvs` →
    `_verify_exe_accepts_flags`) — upstream removes flags, and a build that starts but
    refuses our argv would otherwise replace a working engine and break every load. Idempotent unless `force` (an
    update / reinstall re-fetches even when a variant is already present).

    Downloads the github asset (`.zip`/`.tar.gz`) into the asset's VARIANT dir
    (`<build>/<gpu>/` — variants coexist for the A3 spawn fallback chain; a pre-variant
    install at the build root still satisfies the SELECTED asset); a `runtime_url` companion
    (the Windows CUDA cudart DLLs) is unpacked into the SAME dir. `gpu` overrides selection to
    install a SPECIFIC variant. Docker sources raise (never auto-selected — see
    `select_binary`; forcing one via `gpu=` explains the pin story).
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
    if not force:
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

    # STAGE: download + unpack into a sibling temp dir, never the live variant — the working
    # engine stays intact until a verified build is ready to swap in. Clear a crashed run's
    # leftover staging first.
    staging = dest.parent / f".staging-{asset.gpu}"
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True, exist_ok=True)

    def _fetch(url: str) -> None:
        # GUARD: a stored URL still carrying a `{…}` placeholder never composes to a real
        # asset — it 404s N times then fails (seen in the wild: a legacy `{build}` row 404'd an
        # install). The URL is meant to be the CONCRETE download (the pin drives it, the UI
        # re-points every stored URL on a pin change); refuse it up front with a clear message
        # instead of a silent retry storm.
        if "{" in url or "}" in url:
            raise RuntimeError(
                f"engine asset URL has an unresolved placeholder: {url} — re-save the engine "
                "binary rows so the URL is concrete (the pinned build drives it)"
            )
        suffix = ".tar.gz" if url.lower().endswith((".tar.gz", ".tgz")) else ".zip"
        archive = staging / f"_download{suffix}"
        log.info("downloading llama.cpp %s/%s from %s", asset.platform, asset.gpu, url)
        # ONE downloader, ONE config — the same chunk-queue download the models use (no per-host
        # special cases; the work-stealing design in download.py is what makes N connections safe
        # on every CDN, because a slow connection can only delay one chunk, never the file).
        stream_download(url, archive, on_progress=on_progress, cancel_check=cancel_check,
                        **download_kwargs(config))
        _unpack(archive, staging)
        archive.unlink(missing_ok=True)

    try:
        # The stored URL is the CONCRETE download for the pinned build (the UI re-points every
        # stored URL when the pin changes); the folder is named for that same pin. The server
        # does NOT compose a URL — it fetches what is stored.
        _fetch(asset.asset_url)
        # CUDA builds ship the cudart runtime DLLs separately — unpack alongside the exe.
        if asset.runtime_url:
            _fetch(asset.runtime_url)

        exe = _find_server_exe(staging, asset.server_exe)
        if exe is None:
            raise RuntimeError(f"{asset.server_exe} not found in unpacked archive at {staging}")
        if hardware.platform != "windows":
            exe.chmod(exe.stat().st_mode | 0o111)
        _verify_exe_launches(exe, hardware.platform)   # catches a missing runtime DLL/.so
        _verify_exe_accepts_flags(exe, probe_argvs)    # catches a flag upstream removed
        _swap_into_place(staging, dest)                # atomic — `dest` untouched until here
    finally:
        # Success renamed staging → dest (this is a no-op); any failure leaves it, so clean it
        # up and let the exception propagate with the live engine (`dest`) intact.
        shutil.rmtree(staging, ignore_errors=True)

    return _find_server_exe(dest, asset.server_exe)
