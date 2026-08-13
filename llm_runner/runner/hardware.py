# SPDX-License-Identifier: MIT
"""Self-contained hardware detection → HardwareInfo.

Drives binary + model selection. No CUDA toolkit is ever required — we only
DETECT what the user has (platform, GPU vendor, NVIDIA compute capability +
driver, AMD/ROCm, Intel Arc, Vulkan) and pick the matching prebuilt build. For
NVIDIA the `compute_cap` chooses the CUDA build (Blackwell needs 13.x, older
cards 12.x); for AMD we prefer ROCm/HIP when its runtime is present, else
Vulkan (user decision 2026-07-01); any detected Intel GPU routes to the Vulkan
build when the loader is present (A2 widened 2026-07-23 — the old Arc-name gate
left Core Ultra iGPUs CPU-only with a working Vulkan device idle). The only
prerequisite is the GPU's own driver, which the user already has if the GPU works.

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


def active_backend(hw: HardwareInfo) -> str:
    """Which engine backend this box runs — `cuda | rocm | metal | vulkan | cpu` —
    for the physics overhead seed (`fit.PHYSICS_OVERHEAD_MB`, fit-redesign §5.1).
    Mirrors the binary-preference order's spirit without importing it: the
    detected runtime wins; macOS is Metal by construction; any other GPU means
    the Vulkan build; no GPU at all runs on CPU (overhead 0 — no device context)."""
    if hw.runtimes.get("cuda"):
        return "cuda"
    if hw.platform == "macos":
        return "metal"
    if hw.runtimes.get("rocm"):
        return "rocm"
    if hw.gpus or hw.runtimes.get("vulkan"):
        return "vulkan"
    return "cpu"


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


# The hardware memory-architecture classes (2026-07-22 redesign, user). The offload
# story — what makes the launch config differ — splits three ways:
#   discrete   — dedicated VRAM + system RAM; tune the GPU/CPU layer split.
#   integrated — an iGPU sharing ONE system-RAM pool; nothing to offload to.
#   unified    — an SoC ONE high-bandwidth pool (Apple Silicon / DGX Spark).
MEM_TYPES = ("discrete", "integrated", "unified")


def format_class_key(mem_type: str, vram_gb: int, ram_gb: int) -> str:
    """The class_key string convention — ONE source, type-first (2026-07-22):
    `dgpu-vram<V>|ram<R>` (discrete) · `unified-mem<M>` · `igpu-mem<M>` (integrated /
    the GPU-less fallback). For the one-pool types `ram_gb` IS the pool. BOTH detection
    (`class_key(hw)`) and the llm-side hardware-class store derive through this, so the
    format can never drift."""
    if mem_type == "discrete":
        return f"dgpu-vram{vram_gb}|ram{ram_gb}"
    if mem_type == "unified":
        return f"unified-mem{ram_gb}"
    return f"igpu-mem{ram_gb}"


def parse_class_key(key: str) -> tuple[str, int, int]:
    """Inverse of `format_class_key` → (mem_type, vram_gb, ram_gb). For the one-pool
    types vram_gb is 0 and ram_gb is the pool; an unrecognized shape → ('integrated',
    0, 0). Used by the hardware-class store's `ensure` (the Tune-modal 'Save for
    hardware class' path knows only the class_key)."""
    m = re.fullmatch(r"dgpu-vram(\d+)\|ram(\d+)", key or "")
    if m:
        return "discrete", int(m.group(1)), int(m.group(2))
    m = re.fullmatch(r"unified-mem(\d+)", key or "")
    if m:
        return "unified", 0, int(m.group(1))
    m = re.fullmatch(r"igpu-mem(\d+)", key or "")
    if m:
        return "integrated", 0, int(m.group(1))
    return "integrated", 0, 0


def _is_discrete_gpu(g) -> bool:
    """Is this scanned AMD/Intel GPU a DISCRETE card, not an iGPU? The PHYSICAL signal
    only — dedicated VRAM >= 4 GB reported (a discrete card reports its full board
    memory; an iGPU reports little or NOTHING — the Core Ultra 7 laptop's registry
    reported `qwMemorySize: (absent)` for its "Intel(R) Graphics", detect-facts
    2026-07-23). NO name matching: Intel reuses "Arc" for integrated graphics, so the
    old `_INTEL_ARC_RE` arm would misclass any iGPU whose DriverDesc says Arc(TM) as
    discrete — a name is marketing, not architecture. Discrete Arc cards (A770, B580)
    still classify correctly via their real board VRAM. The 'Use for this PC' override
    corrects any residual miss."""
    return (g.vram_mb or 0) >= 4096


def mem_arch(hw: HardwareInfo) -> str:
    """This box's memory architecture — `discrete` | `integrated` | `unified`. Platform
    + vendor, NO heavy deps (2026-07-22; verified against NVIDIA docs that no single CUDA
    attribute cleanly flags unified — `concurrent_managed_access` is 1 on ordinary
    discrete Linux GPUs too — so a unified-NVIDIA superchip (DGX Spark) falls to discrete
    and is corrected by the override, a device-name list being the future refinement):
        macOS                    → unified   (Apple Silicon; fixes the Mac-as-CPU bug)
        NVIDIA (cuda runtime)    → discrete
        a >=4 GB-dedicated GPU   → discrete  (the physical signal — no name matching)
        any other GPU / no GPU   → integrated (iGPU or the GPU-less one-pool fallback)"""
    if hw.platform == "macos":
        return "unified"
    if hw.runtimes.get("cuda"):
        return "discrete"
    if any(_is_discrete_gpu(g) for g in hw.gpus):
        return "discrete"
    return "integrated"


# The standard RAM capacities machines actually ship with. Detection SNAPS system
# RAM to the nearest rung (2026-07-23, user's rec): OEMs reserve different slivers
# (firmware/iGPU carve), so raw rounding fragmented identical nominal hardware —
# the Core Ultra laptop reported 31.5 GB (→31) while the desktop's 31.9 GB →32,
# landing two "32 GB" machines in different classes. (This fine ladder is the
# FIRST-stage RAM snap. The discrete CLASS key then down-snaps to the coarse
# _DGPU_RAM_RUNGS, and VRAM — jitter-rounded to the nearest GB — down-snaps the
# _VRAM_BANDS ladder: the 2026-07-25 band ruling, see class_key below. An earlier
# comment here said "VRAM is NOT snapped"; that described the pre-band design.)
_RAM_LADDER = (2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024)


def snap_ram_gb(ram_mb: int) -> int:
    """System RAM (MiB) → the nearest standard capacity in GB (ties take the lower
    rung — never overstate a box's memory). Above the ladder → plain rounding."""
    gb = (ram_mb or 0) / 1024
    if gb > _RAM_LADDER[-1]:
        return round(gb)
    return min(_RAM_LADDER, key=lambda v: (abs(v - gb), v))


# The discrete BANDS (2026-07-25, the user's ruling — "I never thought exact matches
# should be used"): the class key IS the band, so plain exact-match lookup covers every
# real card without any fallback machinery. VRAM snaps DOWN this ladder after the
# nearest-GB jitter round (10/11 GB cards → the 8 band; 20 → 16; everything ≥ 24 —
# a 4090's 24, a 5090's 32 — IS the 24+ band). Discrete system RAM snaps DOWN the
# coarse rungs after snap_ram_gb's fine jitter snap (24 → 16, 48 → 32, 96 → 64):
# down-snap on both dimensions because it can never overstate a box — a config keyed
# at the band floor fits every box above it, never the reverse (the 26B flagship's
# ~24 GB RAM appetite on a 16 GB box is exactly the miss this direction prevents).
# Below the ladder floor the (jitter-snapped) value passes through unchanged — those
# boxes are honestly sub-band and will simply match no band seed. Integrated/unified
# keys are untouched: the pool is the identity (igpu-mem16 stays igpu-mem16).
# Per-machine measurement fidelity is NOT lost — it never lived here (the exact
# machine_key → model_tunes layer owns it); this key's own charter says COARSE.
_VRAM_BANDS = (4, 6, 8, 12, 16, 24)
_DGPU_RAM_RUNGS = (16, 32, 64, 128)


def _band(gb: int, ladder: tuple) -> int:
    """Largest ladder value ≤ `gb`; below the floor the value passes through."""
    fits = [v for v in ladder if v <= gb]
    return max(fits) if fits else gb


def banded_class_key(mem_type: str, vram_gb: int, ram_gb: int) -> str:
    """`format_class_key` with the discrete BAND snap applied — THE key builder for
    anything that creates or matches a class identity (detection below, and the
    panel's create-class derive via install.py), so a hand-typed vram 10 lands in
    the 8 band instead of minting an unmatchable micro-class. One-pool types pass
    straight through to the raw formatter."""
    if mem_type == "discrete":
        return format_class_key("discrete", _band(int(vram_gb or 0), _VRAM_BANDS),
                                _band(int(ram_gb or 0), _DGPU_RAM_RUNGS))
    return format_class_key(mem_type, 0, ram_gb)


def class_key(hw: HardwareInfo) -> str:
    """The COARSE hardware-CLASS key the seeded/editable class library is matched on —
    memory-architecture-first (2026-07-22), BAND-grained on the discrete side
    (2026-07-25, see _VRAM_BANDS above). Discrete keys on VRAM band + RAM rung (the
    offload split); integrated/unified key on the single memory pool. VRAM first
    rounds to the NEAREST GB (absorbs the just-under a card reports, e.g. 8188 MB →
    8 GB) and then down-snaps the band ladder; system RAM snaps the fine standard-
    capacity ladder (snap_ram_gb — OEM-reserve jitter) and then down-snaps the coarse
    rungs. GPU NAME + CPU CORES are EXCLUDED (placement is memory-fit-bound, not
    compute-bound)."""
    arch = mem_arch(hw)
    ram_gb = snap_ram_gb(hw.ram_mb or 0)
    if arch == "discrete":
        gpu = max(hw.gpus, key=lambda g: g.vram_mb or 0) if hw.gpus else None
        vram_gb = round((gpu.vram_mb or 0) / 1024) if gpu else 0
        return banded_class_key("discrete", vram_gb, ram_gb)
    return format_class_key(arch, 0, ram_gb)  # integrated / unified — one pool


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
    measured (no nvidia-smi; a probe failure). The NVIDIA arm of the Phase-4 probe
    family — `used_device_mem_mb` below is the backend-aware door.

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


# ── Phase 4 (fit-redesign §11): per-backend used-memory probes, best-effort ──
# Every arm returns None when it cannot measure, and None degrades to exactly
# the pre-Phase-4 behavior (the true-up keeps the estimate) — an unverified
# probe can never make a box WORSE, only fail to improve it. Each parse targets
# a DOCUMENTED interface (a kernel ABI file, a vendor CLI, an OS counter) and
# is pinned by fixture tests, the same standard the platform detection above
# was built to from a single-OS dev box.


def _rocm_used_vram_mb() -> int | None:
    """AMD via `rocm-smi --showmeminfo vram --csv` — used-bytes column summed
    across devices. The column header varies by ROCm release ("VRAM Total Used
    Memory (B)" and near-variants), so the parse finds the header containing
    both "vram" and "used" instead of pinning one wording."""
    if not (shutil.which("rocm-smi")):
        return None
    try:
        out = subprocess.run(
            ["rocm-smi", "--showmeminfo", "vram", "--csv"],
            capture_output=True, text=True, timeout=8,
        ).stdout
    except Exception as e:  # noqa: BLE001 — probes never raise
        log.debug("rocm-smi probe failed: %s", e)
        return None
    lines = [ln for ln in out.splitlines() if ln.strip()]
    header = next((ln for ln in lines if "used" in ln.lower()), "")
    if not header:
        return None
    cols = [c.strip().lower() for c in header.split(",")]
    idx = next((i for i, c in enumerate(cols) if "vram" in c and "used" in c), None)
    if idx is None:
        return None
    total, seen = 0, False
    for ln in lines[lines.index(header) + 1:]:
        parts = [p.strip() for p in ln.split(",")]
        if len(parts) <= idx:
            continue
        try:
            total += int(float(parts[idx]))
            seen = True
        except ValueError:
            continue
    return total // (1024 * 1024) if seen else None


def _amd_sysfs_used_vram_mb(root: Path = Path("/sys/class/drm")) -> int | None:
    """AMD on Linux via the kernel's own `mem_info_vram_used` (bytes) — the
    documented amdgpu sysfs ABI, sibling of the `mem_info_vram_total` the GPU
    scan above already reads. Summed across cards; None when no card exposes it."""
    try:
        cards = sorted(p for p in root.iterdir() if re.fullmatch(r"card\d+", p.name))
    except OSError:
        return None
    total, seen = 0, False
    for card in cards:
        try:
            total += int((card / "device" / "mem_info_vram_used").read_text().strip())
            seen = True
        except (OSError, ValueError):
            continue
    return total // (1024 * 1024) if seen else None


def _windows_gpu_dedicated_used_mb() -> int | None:
    """Windows non-NVIDIA dGPUs via the OS's own GPU performance counters:
    `typeperf "\\GPU Adapter Memory(*)\\Dedicated Usage" -sc 1` — one sample,
    bytes per adapter instance, summed. typeperf ships with Windows; the counter
    set exists on any WDDM 2.x driver. ~1 s — only reached when nvidia-smi is
    absent, and only at load true-up time, never on a poll."""
    if platform_key() != "windows" or not shutil.which("typeperf"):
        return None
    try:
        out = subprocess.run(
            ["typeperf", r"\GPU Adapter Memory(*)\Dedicated Usage", "-sc", "1"],
            capture_output=True, text=True, timeout=10,
        ).stdout
    except Exception as e:  # noqa: BLE001
        log.debug("typeperf GPU probe failed: %s", e)
        return None
    # Output: a quoted-CSV header row naming each instance, then one sample row
    # of values; sum every numeric field of the sample row (field 0 is the
    # timestamp). No sample row / no numbers → None.
    rows = [ln for ln in out.splitlines() if ln.strip().startswith('"')]
    if len(rows) < 2:
        return None
    total, seen = 0.0, False
    for cell in rows[-1].split('","')[1:]:
        try:
            total += float(cell.strip().strip('"'))
            seen = True
        except ValueError:
            continue
    return int(total // (1024 * 1024)) if seen else None


def _used_pool_mb() -> int | None:
    """Used SYSTEM memory (MiB) — the probe for one-pool boxes (iGPU / Apple /
    CPU-only), where the pool IS what models load into and a before/after delta
    across a load captures the footprint ONCE (mmap'd weights and the "GPU"
    allocation are the same physical bytes on UMA — §5.2). Arms: psutil when a
    host ships it → Windows GlobalMemoryStatusEx (total − avail) → Linux
    /proc/meminfo (MemTotal − MemAvailable) → macOS vm_stat (active + wired +
    compressor pages × page size — the standard delta-stable accounting)."""
    try:
        import psutil  # type: ignore

        return int(psutil.virtual_memory().used // (1024 * 1024))
    except Exception:  # noqa: BLE001
        pass
    plat = platform_key()
    if plat == "windows":
        try:
            import ctypes

            class _MSX(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_uint32), ("dwMemoryLoad", ctypes.c_uint32),
                            ("ullTotalPhys", ctypes.c_uint64), ("ullAvailPhys", ctypes.c_uint64),
                            ("ullTotalPageFile", ctypes.c_uint64), ("ullAvailPageFile", ctypes.c_uint64),
                            ("ullTotalVirtual", ctypes.c_uint64), ("ullAvailVirtual", ctypes.c_uint64),
                            ("ullAvailExtendedVirtual", ctypes.c_uint64)]

            st = _MSX()
            st.dwLength = ctypes.sizeof(_MSX)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st)):
                return int((st.ullTotalPhys - st.ullAvailPhys) // (1024 * 1024))
        except Exception:  # noqa: BLE001
            pass
        return None
    if plat == "linux":
        try:
            fields = {}
            for ln in Path("/proc/meminfo").read_text().splitlines():
                parts = ln.split()
                if len(parts) >= 2 and parts[0].rstrip(":") in ("MemTotal", "MemAvailable"):
                    fields[parts[0].rstrip(":")] = int(parts[1])  # kB
            if "MemTotal" in fields and "MemAvailable" in fields:
                return (fields["MemTotal"] - fields["MemAvailable"]) // 1024
        except (OSError, ValueError):
            pass
        return None
    # macOS: vm_stat prints a page size line + "Pages active/wired down/occupied
    # by compressor" counts; their sum × page size is the used-memory figure
    # whose LOAD DELTA is stable (free-page accounting alone is not).
    try:
        out = subprocess.run(["vm_stat"], capture_output=True, text=True, timeout=5).stdout
        m = re.search(r"page size of (\d+) bytes", out)
        page = int(m.group(1)) if m else 4096
        used_pages = 0
        for name in ("Pages active", "Pages wired down", "Pages occupied by compressor"):
            pm = re.search(rf"{name}:\s+(\d+)", out)
            if pm:
                used_pages += int(pm.group(1))
        return (used_pages * page) // (1024 * 1024) if used_pages else None
    except Exception as e:  # noqa: BLE001
        log.debug("vm_stat probe failed: %s", e)
        return None


def used_device_mem_mb() -> int | None:
    """Used memory (MiB) of the pool models load into on THIS box — the Phase-4
    backend-aware door the load true-up consumes (`lifecycle._probe_used_vram`).
    Discrete: NVIDIA → ROCm CLI → amdgpu sysfs → Windows GPU counters (first
    non-None wins; on an NVIDIA box the later arms are never reached). One-pool
    (integrated/unified — iGPU, Apple, CPU-only): the used SYSTEM pool, so the
    before/after delta counts a model's bytes ONCE. None = unmeasurable — the
    true-up keeps the estimate, exactly the pre-Phase-4 behavior."""
    hw = detect()
    if mem_arch(hw) != "discrete":
        return _used_pool_mb()
    for probe in (used_vram_mb, _rocm_used_vram_mb, _amd_sysfs_used_vram_mb,
                  _windows_gpu_dedicated_used_mb):
        v = probe()
        if v is not None:
            return v
    return None


def budget_total_mb(hw: HardwareInfo) -> int:
    """The memory-budget DENOMINATOR for this box (fit-redesign §5.2, Phase 4):
    discrete → the largest single card's VRAM (the standing multi-GPU rule);
    one-pool (integrated / unified / CPU-only) → the pool itself (`ram_mb`).
    THE one reduction the arbiter's ledger and the true-up cap both use — before
    this, a Mac/iGPU box had total 0, so remaining was always 0, every admission
    tried to evict, and the budget line was fiction."""
    if mem_arch(hw) == "discrete":
        return max_vram_mb(hw)
    return int(hw.ram_mb or 0)


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

# (The Intel-Arc NAME regex was DELETED 2026-07-23: Intel reuses "Arc" for
# integrated graphics, so name-matching misclassed iGPUs as discrete and gated
# Vulkan off boxes whose registry says plain "Intel(R) Graphics". Classification
# now keys on dedicated VRAM (_is_discrete_gpu); the Vulkan runtime gates on any
# detected Intel/AMD GPU + the loader being present.)


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
    """Total physical RAM (MiB). Order: psutil (when a host ships it — it is NOT a
    declared dependency) → Windows GlobalMemoryStatusEx via ctypes → POSIX sysconf
    → 0. The Windows arm was MISSING until 2026-07-22: psutil absent + no sysconf
    on Windows meant every Windows box detected ram=0 for its entire life —
    "MEMORY —" in the header, class key vram8|ram0 — so the seeded vram8|ram32
    class config never matched the very PC it was measured on."""
    try:
        import psutil  # type: ignore

        return int(psutil.virtual_memory().total // (1024 * 1024))
    except Exception:  # noqa: BLE001
        pass
    if os.name == "nt":
        try:
            import ctypes

            class _MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_uint32),
                    ("dwMemoryLoad", ctypes.c_uint32),
                    ("ullTotalPhys", ctypes.c_uint64),
                    ("ullAvailPhys", ctypes.c_uint64),
                    ("ullTotalPageFile", ctypes.c_uint64),
                    ("ullAvailPageFile", ctypes.c_uint64),
                    ("ullTotalVirtual", ctypes.c_uint64),
                    ("ullAvailVirtual", ctypes.c_uint64),
                    ("ullAvailExtendedVirtual", ctypes.c_uint64),
                ]

            st = _MEMORYSTATUSEX()
            st.dwLength = ctypes.sizeof(_MEMORYSTATUSEX)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st)):
                return int(st.ullTotalPhys // (1024 * 1024))
        except Exception:  # noqa: BLE001
            pass
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
        elif intel:
            # A2 WIDENED (2026-07-23, user's rec on the laptop evidence): ANY detected
            # Intel GPU gets the Vulkan runtime when the loader is present — the old
            # gate required "Arc" in the name, but the Core Ultra 7's registry says
            # plain "Intel(R) Graphics" while its Vulkan device serves an 18 GB shared
            # pool (detect-facts 2026-07-23); the Arc-name gate left that iGPU
            # CPU/online-only with a working GPU idle. The loader check still gates
            # (no vulkan-1.dll → no vulkan runtime → the online-provider path), and
            # the A3 spawn chain falls back if the build won't run on a weak iGPU.
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
