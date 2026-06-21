# SPDX-License-Identifier: GPL-3.0-or-later
"""Self-contained hardware detection → HardwareInfo.

Drives binary + model selection. No CUDA toolkit is ever required — the
prebuilt llama.cpp binaries bundle the CUDA runtime; we only DETECT what
the user has (platform, GPU vendor, driver version) and pick the matching
build. The only prerequisite is the NVIDIA driver, which the user already
has if the GPU works.
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


def _nvidia_gpus() -> list[GpuInfo]:
    if not shutil.which("nvidia-smi"):
        return []
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total,driver_version",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5, check=True,
        ).stdout
    except Exception as e:  # noqa: BLE001 — detection must never raise
        log.debug("nvidia-smi failed: %s", e)
        return []
    gpus: list[GpuInfo] = []
    for line in out.splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) != 3:
            continue
        name, mem, driver = parts
        try:
            vram = int(float(mem))
        except ValueError:
            vram = None
        gpus.append(GpuInfo(vendor="NVIDIA", name=name, vram_mb=vram, driver=driver or None))
    return gpus


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
