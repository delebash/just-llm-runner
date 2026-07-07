# SPDX-License-Identifier: GPL-3.0-or-later
"""Self-contained hardware detection → HardwareInfo.

Drives binary + model selection. No CUDA toolkit is ever required — we only
DETECT what the user has (platform, GPU vendor, NVIDIA compute capability +
driver, AMD/ROCm, Intel Arc, Vulkan) and pick the matching prebuilt build. For
NVIDIA the `compute_cap` chooses the CUDA build (Blackwell needs 13.x, older
cards 12.x); for AMD we prefer ROCm/HIP when its runtime is present, else
Vulkan (user decision 2026-07-01); Intel ARC discrete GPUs route to the Vulkan
build (iGPU-only Intel boxes stay CPU). The only prerequisite is the GPU's own
driver, which the user already has if the GPU works.

AMD/Intel rows come from a per-platform scan (only run when no NVIDIA GPU was
found, so the NVIDIA fast-path pays nothing): on Linux the kernel's own sysfs
(`/sys/class/drm/cardN/device/vendor`, and for amdgpu the byte-exact
`mem_info_vram_total` — kernel-documented ABI); on Windows the display-class
registry (`DriverDesc` + `HardwareInformation.qwMemorySize` — the 64-bit value;
`Win32_VideoController.AdapterRAM` is uint32 and caps at 4 GB, so it is never
used). Intel-on-Linux VRAM stays None: there is no stable merged sysfs ABI for
discrete-Intel local memory (`lmem_total_bytes` never left RFC), so the row
exists (vendor/name/routing work) and Fit honestly reads unknown.
"""

from __future__ import annotations

import logging
import os
import platform
import re
import shutil
import subprocess
from functools import cache
from pathlib import Path

from .schema import GpuInfo, HardwareInfo

log = logging.getLogger(__name__)


def max_vram_mb(hw: HardwareInfo) -> int:
    """The largest single-GPU VRAM (MiB) in `hw`, or 0 if no GPU — the ONE reduction the Fit math
    (`process.compute_fit`) and the VRAM arbiter both use, so "max detected VRAM" has a single
    source (matching the arbiter's 'one VRAM authority' principle) with no per-call-site drift."""
    return max((g.vram_mb or 0 for g in hw.gpus), default=0)


def platform_key() -> str:
    sysname = platform.system().lower()
    if sysname.startswith("win"):
        return "windows"
    if sysname == "darwin":
        return "macos"
    return "linux"


def machine_key(hw: HardwareInfo) -> str:
    """The per-MACHINE tuning key the `model_tunes` layer
    are stored under — `gpu|vram|cores|ramGB` (or `cpu|cores|ramGB` with no GPU).
    WHOLE machine, not GPU-only (Plan B, D2): `threads` is CPU-core-driven and
    `batch`/`ubatch` are RAM/bandwidth-bound, so two boxes sharing a GPU model
    must not collide. RAM rounds to whole GB (absorbs MB-level reporting jitter);
    the driver version is deliberately EXCLUDED — a driver update would orphan
    every saved tune. ONE source, beside `max_vram_mb` (same principle)."""
    ram_gb = (hw.ram_mb or 0) // 1024
    gpu = max(hw.gpus, key=lambda g: g.vram_mb or 0) if hw.gpus else None
    if gpu is None:
        return f"cpu|{hw.cpu_cores}c|{ram_gb}g"
    return f"{gpu.name}|{gpu.vram_mb or 0}|{hw.cpu_cores}c|{ram_gb}g"


def class_key(hw: HardwareInfo) -> str:
    """The COARSE hardware-CLASS key the seeded/editable `class_tunes` layer is matched
    on — `vram<GB>|ram<GB>` (VRAM band + RAM band), the "similar systems" bucket (user,
    2026-07-07). Unlike `machine_key`, GPU NAME and CPU CORES are EXCLUDED: the optimal
    layer placement is set by memory fit (VRAM + RAM), not GPU compute or core count, so
    two 8 GB / 32 GB boxes want the same config even with different GPUs. VRAM + RAM round
    to the NEAREST GB (absorbs the just-under a card reports, e.g. 8188 MB → the 8 GB
    class). No GPU → `cpu|ram<GB>`."""
    ram_gb = round((hw.ram_mb or 0) / 1024)
    gpu = max(hw.gpus, key=lambda g: g.vram_mb or 0) if hw.gpus else None
    if gpu is None or not (gpu.vram_mb or 0):
        return f"cpu|ram{ram_gb}"
    return f"vram{round((gpu.vram_mb or 0) / 1024)}|ram{ram_gb}"


@cache
def current_class_key() -> str:
    """`class_key(detect())`, memoized (hardware is fixed within a process)."""
    return class_key(detect())


@cache
def current_machine_key() -> str:
    """`machine_key(detect())`, memoized — hardware doesn't change within a
    process, so the per-load switches wire and the model-tunes API never pay a
    second `nvidia-smi` round-trip."""
    return machine_key(detect())


def used_vram_mb() -> int | None:
    """Total CURRENTLY-used VRAM across NVIDIA GPUs (MiB), or None when it cannot be
    measured (no nvidia-smi — AMD / Metal / CPU-only boxes; a probe failure).

    WHY this exists (measure-don't-assume, box-verified 2026-07-06): the lifecycle
    trues-up an arbiter reservation with the load's REAL footprint right after the
    load confirms. The fit formula books an `n-gpu-layers = 0` child as 0 MB, but a
    CUDA-build llama-server child still initializes a CUDA context and holds ~0.5 GB
    (measured 549 MB for the Qwen3-Embedding-0.6B child on an RTX 2070 SUPER) — an
    assumed 0 would over-report the remaining budget by that much for every
    CPU-offloaded co-resident (e.g. the pinned RAG embed), and the fitted estimate
    for GPU loads can drift from reality too. The measured number comes from the
    machine, not from a constant."""
    out = _nvidia_query("memory.used")
    if out is None:
        return None
    total, seen = 0, False
    for line in out.splitlines():
        tok = line.strip().split(",")[0].strip()
        if tok.isdigit():
            total += int(tok)
            seen = True
    return total if seen else None


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


# PCI vendor ids we build rows for. NVIDIA (0x10de) is deliberately absent —
# nvidia-smi stays the single NVIDIA authority (no smi = no usable CUDA anyway).
_PCI_VENDOR_TO_NAME = {"0x1002": "AMD", "0x8086": "Intel"}

# Intel DISCRETE detection by adapter name: "Arc" (A- and B-series retail names,
# Windows DriverDesc "Intel(R) Arc(TM) …", Linux lspci "… [Arc A770]") plus the
# DG1/DG2/Battlemage silicon names some lspci databases use instead.
_INTEL_ARC_RE = re.compile(r"\barc\b|dg1|dg2|battlemage", re.IGNORECASE)


def _lspci_names() -> dict[str, str]:
    """One `lspci -mm` pass → {pci address (no domain): device name}; {} when
    lspci is unavailable. Only used to give scanned rows their marketing name —
    a miss falls back to a generic vendor label, never an error."""
    if not shutil.which("lspci"):
        return {}
    try:
        out = subprocess.run(
            ["lspci", "-mm"], capture_output=True, text=True, timeout=5,
        ).stdout
    except Exception as e:  # noqa: BLE001 — detection must never raise
        log.debug("lspci -mm failed: %s", e)
        return {}
    names: dict[str, str] = {}
    for line in out.splitlines():
        # `03:00.0 "VGA compatible controller" "<vendor>" "<device name>" …`
        m = re.match(r'^(\S+)\s+"[^"]*"\s+"[^"]*"\s+"([^"]*)"', line)
        if m:
            names[m.group(1)] = m.group(2)
    return names


def _pci_gpus_linux(root: Path = Path("/sys/class/drm")) -> list[GpuInfo]:
    """AMD/Intel GPU rows from the kernel's sysfs (Linux). Never raises.

    Top-level `cardN` entries only (connector nodes like `card0-DP-1` and
    `renderD*` are skipped); vendor from the standard PCI `device/vendor`
    attribute. AMD VRAM from amdgpu's `mem_info_vram_total` (bytes →  MiB,
    kernel-documented sysfs ABI); Intel VRAM stays None (no stable merged ABI
    for discrete local memory — the lmem sysfs never left RFC)."""
    try:
        cards = sorted(p for p in root.iterdir() if re.fullmatch(r"card\d+", p.name))
    except OSError:
        return []
    names = _lspci_names()
    gpus: list[GpuInfo] = []
    for card in cards:
        dev = card / "device"
        try:
            vendor_id = (dev / "vendor").read_text().strip().lower()
        except OSError:
            continue
        vendor = _PCI_VENDOR_TO_NAME.get(vendor_id)
        if vendor is None:
            continue
        vram_mb: int | None = None
        if vendor == "AMD":
            try:
                vram_mb = int((dev / "mem_info_vram_total").read_text().strip()) // (1024 * 1024)
            except (OSError, ValueError):
                vram_mb = None
        try:
            pci_addr = dev.resolve().name  # the device symlink target, e.g. 0000:03:00.0
        except OSError:
            pci_addr = ""
        short = re.sub(r"^[0-9a-fA-F]{4}:", "", pci_addr)  # lspci prints no domain
        name = names.get(short) or names.get(pci_addr) or f"{vendor} GPU"
        gpus.append(GpuInfo(vendor=vendor, name=name, vram_mb=vram_mb, driver=None, compute_cap=None))
    return gpus


def _qw_to_mb(value: object) -> int | None:
    """Decode a registry `HardwareInformation.qwMemorySize` value → MiB.
    Accepts REG_QWORD (int) or REG_BINARY (8 bytes little-endian); None on junk."""
    try:
        if isinstance(value, bytes):
            value = int.from_bytes(value[:8], "little")
        n = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return n // (1024 * 1024) if n > 0 else None


_WIN_DISPLAY_CLASS = r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}"


def _registry_gpus_windows() -> list[GpuInfo]:
    """AMD/Intel GPU rows from the Windows display-class registry. Never raises.

    `DriverDesc` = adapter name; `HardwareInformation.qwMemorySize` = the 64-bit
    VRAM byte count (`Win32_VideoController.AdapterRAM` is uint32 → caps at
    4 GB, so it is NOT used). Stdlib `winreg`, no subprocess, no deprecated wmic."""
    if platform_key() != "windows":
        return []
    try:
        import winreg
    except ImportError:  # pragma: no cover — windows stdlib module
        return []
    gpus: list[GpuInfo] = []
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, _WIN_DISPLAY_CLASS) as cls:
            i = 0
            while True:
                try:
                    sub = winreg.EnumKey(cls, i)
                except OSError:
                    break
                i += 1
                if not re.fullmatch(r"\d{4}", sub):
                    continue
                try:
                    with winreg.OpenKey(cls, sub) as k:
                        name = str(winreg.QueryValueEx(k, "DriverDesc")[0])
                        low = name.lower()
                        if "nvidia" in low or "geforce" in low:
                            continue  # nvidia-smi stays the NVIDIA authority
                        if "amd" in low or "radeon" in low:
                            vendor = "AMD"
                        elif "intel" in low:
                            vendor = "Intel"
                        else:
                            continue
                        try:
                            raw = winreg.QueryValueEx(k, "HardwareInformation.qwMemorySize")[0]
                            vram_mb = _qw_to_mb(raw)
                        except OSError:
                            vram_mb = None
                        gpus.append(GpuInfo(
                            vendor=vendor, name=name, vram_mb=vram_mb,
                            driver=None, compute_cap=None,
                        ))
                except OSError:
                    continue
    except OSError as e:
        log.debug("display-class registry scan failed: %s", e)
    return gpus


def _gpu_scan() -> list[GpuInfo]:
    """AMD/Intel rows for this platform — only called when no NVIDIA GPU was found."""
    plat = platform_key()
    if plat == "linux":
        return _pci_gpus_linux()
    if plat == "windows":
        return _registry_gpus_windows()
    return []


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
        # Record the Vulkan capability FACT too (gpu-gated, like the AMD arm):
        # on Linux the pinned build has no installable CUDA archive (docker-only,
        # and no pin-faithful image exists upstream — A4), so selection falls to
        # the REAL pinned vulkan build there; on Windows cuda archives exist and
        # stay preferred — the extra fact only widens the A3 chain.
        if _vulkan_available():
            runtimes["vulkan"] = True
    elif plat in ("windows", "linux"):
        # No NVIDIA → scan for AMD/Intel rows (A1: real name + VRAM where the
        # platform exposes it, so Fit and machine_key work on those boxes).
        scanned = _gpu_scan()
        gpus = scanned
        amd = [g for g in scanned if g.vendor == "AMD"]
        intel = [g for g in scanned if g.vendor == "Intel"]
        if amd or (not scanned and _amd_gpu_present()):
            # Record BOTH capability facts when present — `runtimes` states what the
            # box can do; SELECTION prefers ROCm via `_gpu_preference` order (the
            # 2026-07-01 "ROCm first, else Vulkan" decision — a preference, honored
            # there). Both facts must exist so the A3 spawn chain can fall from a
            # broken rocm build to an installed vulkan one. The empty-scan arm keeps
            # the legacy name-sniff as a last resort (runtime-only, no row) so no
            # environment detects LESS than before the scan existed.
            if _rocm_available():
                runtimes["rocm"] = True
            if _vulkan_available():
                runtimes["vulkan"] = True
        elif any(_INTEL_ARC_RE.search(g.name or "") for g in intel):
            # A2: Intel ARC discrete GPUs auto-route to the Vulkan build. iGPU-only
            # Intel boxes deliberately stay CPU (the recorded scope is Arc discrete).
            if _vulkan_available():
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
