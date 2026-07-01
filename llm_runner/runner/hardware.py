# SPDX-License-Identifier: GPL-3.0-or-later
"""Self-contained hardware detection → HardwareInfo.

Drives binary + model selection. No CUDA toolkit is ever required — we only
DETECT what the user has (platform, GPU vendor, NVIDIA compute capability +
driver, AMD/ROCm, Vulkan) and pick the matching prebuilt build. For NVIDIA the
`compute_cap` chooses the CUDA build (Blackwell needs 13.x, older cards 12.x);
for AMD/Intel we prefer ROCm/HIP when its runtime is present, else Vulkan
(user decision 2026-07-01). The only prerequisite is the GPU's own driver,
which the user already has if the GPU works.
"""

from __future__ import annotations

import logging
import os
import platform
import shutil
import subprocess

from .schema import GpuInfo, HardwareInfo

log = logging.getLogger(__name__)


def platform_key() -> str:
    sysname = platform.system().lower()
    if sysname.startswith("win"):
        return "windows"
    if sysname == "darwin":
        return "macos"
    return "linux"


def _nvidia_query(fields: str) -> str | None:
    """Run one `nvidia-smi --query-gpu` call; None on any failure (never raises)."""
    try:
        return subprocess.run(
            ["nvidia-smi", f"--query-gpu={fields}", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5, check=True,
        ).stdout
    except Exception as e:  # noqa: BLE001 — detection must never raise
        log.debug("nvidia-smi query %r failed: %s", fields, e)
        return None


def _nvidia_gpus() -> list[GpuInfo]:
    if not shutil.which("nvidia-smi"):
        return []
    # `compute_cap` (added ~CUDA 11) drives the CUDA build choice; fall back to
    # the base fields on an old driver that rejects it (don't lose the GPU).
    fields = "name,memory.total,driver_version,compute_cap"
    out = _nvidia_query(fields)
    if out is None:
        fields = "name,memory.total,driver_version"
        out = _nvidia_query(fields)
    if out is None:
        return []
    ncols = len(fields.split(","))
    gpus: list[GpuInfo] = []
    for line in out.splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) != ncols:
            continue
        name, mem, driver = parts[0], parts[1], parts[2]
        cap = parts[3] if ncols == 4 else None
        try:
            vram = int(float(mem))
        except ValueError:
            vram = None
        gpus.append(GpuInfo(
            vendor="NVIDIA", name=name, vram_mb=vram,
            driver=driver or None, compute_cap=cap or None,
        ))
    return gpus


def _amd_gpu_present() -> bool:
    """Best-effort: is an AMD/Radeon GPU present? Never raises. Only probed when
    no NVIDIA GPU was found, so the NVIDIA fast-path pays nothing."""
    plat = platform_key()
    try:
        if plat == "linux" and shutil.which("lspci"):
            out = subprocess.run(
                ["lspci"], capture_output=True, text=True, timeout=5,
            ).stdout.lower()
            return any(k in out for k in ("amd/ati", "advanced micro devices", "radeon"))
        if plat == "windows":
            if os.environ.get("HIP_PATH"):  # AMD HIP SDK installed
                return True
            if shutil.which("wmic"):
                out = subprocess.run(
                    ["wmic", "path", "win32_VideoController", "get", "name"],
                    capture_output=True, text=True, timeout=8,
                ).stdout.lower()
                return "amd" in out or "radeon" in out
    except Exception as e:  # noqa: BLE001 — detection must never raise
        log.debug("amd detection failed: %s", e)
    return False


def _rocm_available() -> bool:
    """ROCm/HIP runtime present (rocminfo / HIP SDK / /opt/rocm)."""
    return bool(
        shutil.which("rocminfo") or shutil.which("hipInfo")
        or os.environ.get("HIP_PATH") or os.path.isdir("/opt/rocm")
    )


def _vulkan_available() -> bool:
    """A Vulkan loader/tool is present (the universal GPU fallback)."""
    if shutil.which("vulkaninfo"):
        return True
    plat = platform_key()
    if plat == "windows":
        sysroot = os.environ.get("SystemRoot", r"C:\Windows")
        return os.path.exists(os.path.join(sysroot, "System32", "vulkan-1.dll"))
    if plat == "linux":
        return any(os.path.exists(p) for p in (
            "/usr/lib/x86_64-linux-gnu/libvulkan.so.1",
            "/usr/lib/libvulkan.so.1", "/usr/lib64/libvulkan.so.1",
        ))
    return False


def _ram_mb() -> int:
    try:
        import psutil  # type: ignore

        return int(psutil.virtual_memory().total // (1024 * 1024))
    except Exception:  # noqa: BLE001
        try:
            return int(os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") // (1024 * 1024))
        except (ValueError, AttributeError, OSError):
            return 0


def detect() -> HardwareInfo:
    plat = platform_key()
    gpus = _nvidia_gpus()
    runtimes: dict[str, bool] = {}
    if gpus and shutil.which("nvidia-smi"):
        runtimes["cuda"] = True
    elif plat in ("windows", "linux") and _amd_gpu_present():
        # ROCm/HIP first (best perf when its runtime is installed), else Vulkan
        # as the universal GPU fallback (user decision 2026-07-01).
        if _rocm_available():
            runtimes["rocm"] = True
        elif _vulkan_available():
            runtimes["vulkan"] = True
    if plat == "macos":
        runtimes["metal"] = True
    return HardwareInfo(
        os=platform.system(),
        platform=plat,
        cpu_cores=os.cpu_count() or 0,
        ram_mb=_ram_mb(),
        gpus=gpus,
        runtimes=runtimes,
    )
