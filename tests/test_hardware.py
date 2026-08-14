# SPDX-License-Identifier: MIT
"""Hardware detection: NVIDIA compute-capability parse (+ old-driver fallback),
the AMD ROCm-first / Vulkan-fallback routing, the sysfs/registry AMD-Intel scan
(A1: rows with VRAM where the platform exposes it), and the Intel-Arc → Vulkan
routing (A2). Every probe is monkeypatched, so it runs on any box with no GPU."""

from __future__ import annotations

import os
import sys

import pytest

from llm_runner.runner import hardware as hw
from llm_runner.runner.schema import GpuInfo, HardwareInfo as _HardwareInfo


def test_nvidia_gpus_parses_compute_cap(monkeypatch):
    monkeypatch.setattr(hw.shutil, "which", lambda c: "/x/nvidia-smi" if c == "nvidia-smi" else None)
    monkeypatch.setattr(
        hw, "_nvidia_query",
        lambda fields: "RTX 5090, 32607, 580.00, 12.0\n" if "compute_cap" in fields else None,
    )
    gpus = hw._nvidia_gpus()
    assert len(gpus) == 1
    assert gpus[0].compute_cap == "12.0"
    assert gpus[0].vram_mb == 32607
    assert gpus[0].driver == "580.00"


def test_nvidia_gpus_old_driver_fallback(monkeypatch):
    # compute_cap query fails (old driver) → fall back to the 3-field query,
    # keep the GPU (don't lose it), compute_cap stays None.
    monkeypatch.setattr(hw.shutil, "which", lambda c: "/x/nvidia-smi" if c == "nvidia-smi" else None)

    def q(fields):
        return None if "compute_cap" in fields else "RTX 2070, 8192, 550.00\n"

    monkeypatch.setattr(hw, "_nvidia_query", q)
    gpus = hw._nvidia_gpus()
    assert len(gpus) == 1
    assert gpus[0].compute_cap is None
    assert gpus[0].vram_mb == 8192


def _no_nvidia(monkeypatch, plat="linux", scan=None):
    monkeypatch.setattr(hw, "_nvidia_gpus", lambda: [])
    monkeypatch.setattr(hw.shutil, "which", lambda c: None)
    monkeypatch.setattr(hw, "platform_key", lambda: plat)
    monkeypatch.setattr(hw, "_gpu_scan", lambda: list(scan or []))


def test_detect_amd_rocm_first(monkeypatch):
    # Legacy presence-sniff arm (empty scan). Both capability FACTS are recorded
    # (the A3 chain needs the truthful vulkan candidate); SELECTION still prefers
    # rocm — _gpu_preference orders it first (the 2026-07-01 preference decision).
    from llm_runner.runner.binary import _gpu_preference

    _no_nvidia(monkeypatch)
    monkeypatch.setattr(hw, "_amd_gpu_present", lambda: True)
    monkeypatch.setattr(hw, "_rocm_available", lambda: True)
    monkeypatch.setattr(hw, "_vulkan_available", lambda: True)
    info = hw.detect()
    assert info.runtimes.get("rocm") is True
    assert info.runtimes.get("vulkan") is True  # a fact of the box, not a selection
    assert "cuda" not in info.runtimes
    assert _gpu_preference(info) == ["rocm", "vulkan", "cpu"]  # ROCm still wins selection


def test_detect_amd_vulkan_fallback(monkeypatch):
    _no_nvidia(monkeypatch)
    monkeypatch.setattr(hw, "_amd_gpu_present", lambda: True)
    monkeypatch.setattr(hw, "_rocm_available", lambda: False)
    monkeypatch.setattr(hw, "_vulkan_available", lambda: True)
    info = hw.detect()
    assert info.runtimes.get("vulkan") is True
    assert "rocm" not in info.runtimes


def test_detect_cpu_only(monkeypatch):
    _no_nvidia(monkeypatch)
    monkeypatch.setattr(hw, "_amd_gpu_present", lambda: False)
    info = hw.detect()
    assert not any(info.runtimes.values())


# ── A1: the sysfs scan builds real AMD/Intel rows ──────────────────────────────


def _fake_sysfs(tmp_path, entries):
    """Build /sys/class/drm-shaped tree: {name: (vendor_hex|None, vram_bytes|None)}."""
    root = tmp_path / "drm"
    for name, (vendor, vram) in entries.items():
        dev = root / name / "device"
        dev.mkdir(parents=True)
        if vendor is not None:
            (dev / "vendor").write_text(vendor + "\n")
        if vram is not None:
            (dev / "mem_info_vram_total").write_text(str(vram) + "\n")
    return root


def test_pci_gpus_linux_rows(monkeypatch, tmp_path):
    monkeypatch.setattr(hw, "_lspci_names", lambda: {})
    root = _fake_sysfs(tmp_path, {
        "card0": ("0x1002", 16 * 1024**3),   # AMD, 16 GiB
        "card1": ("0x8086", None),           # Intel — no stable VRAM ABI on Linux
        "card2": ("0x10de", 8 * 1024**3),    # NVIDIA — skipped (nvidia-smi authority)
        "renderD128": ("0x1002", None),      # render node — skipped by name
    })
    (root / "card0-DP-1").mkdir()            # connector node — skipped by name
    gpus = hw._pci_gpus_linux(root)
    assert [(g.vendor, g.vram_mb) for g in gpus] == [("AMD", 16384), ("Intel", None)]
    assert gpus[0].name == "AMD GPU" and gpus[1].name == "Intel GPU"  # lspci-less fallback


@pytest.mark.skipif(
    sys.platform != "linux",
    reason="builds a real sysfs-shaped symlink tree — os.symlink needs privileges "
    "on Windows and the code under test is the Linux scan; the standing "
    "'one expected failure' note dies with this skip (tracked 2026-08-05, "
    "closed 2026-08-08: 'a real skip is cleaner').",
)
def test_pci_gpus_linux_lspci_name_match(monkeypatch, tmp_path):
    # device is a SYMLINK to the PCI node (as in real sysfs); the lspci map is
    # keyed without the domain prefix — the scan must still match the name.
    root = tmp_path / "drm"
    pci = tmp_path / "pci" / "0000:03:00.0"
    pci.mkdir(parents=True)
    (pci / "vendor").write_text("0x1002\n")
    (pci / "mem_info_vram_total").write_text(str(24 * 1024**3) + "\n")
    (root / "card0").mkdir(parents=True)
    os.symlink(pci, root / "card0" / "device")
    monkeypatch.setattr(hw, "_lspci_names", lambda: {"03:00.0": "Navi 31 [Radeon RX 7900 XTX]"})
    gpus = hw._pci_gpus_linux(root)
    assert len(gpus) == 1
    assert gpus[0].name == "Navi 31 [Radeon RX 7900 XTX]"
    assert gpus[0].vram_mb == 24 * 1024


def test_qw_to_mb_decodes_qword_and_binary():
    sixteen_gb = 16 * 1024**3
    assert hw._qw_to_mb(sixteen_gb) == 16384                                # REG_QWORD int
    assert hw._qw_to_mb(sixteen_gb.to_bytes(8, "little")) == 16384          # REG_BINARY
    assert hw._qw_to_mb(0) is None
    assert hw._qw_to_mb("junk") is None


# ── A1+A2: detect() consumes scanned rows; Arc routes to Vulkan ────────────────


def test_detect_amd_scan_row_feeds_gpus_and_machine_key(monkeypatch):
    row = GpuInfo(vendor="AMD", name="Radeon RX 7900 XTX", vram_mb=24560)
    _no_nvidia(monkeypatch, scan=[row])
    monkeypatch.setattr(hw, "_rocm_available", lambda: False)
    monkeypatch.setattr(hw, "_vulkan_available", lambda: True)
    info = hw.detect()
    assert info.runtimes.get("vulkan") is True
    assert [g.name for g in info.gpus] == ["Radeon RX 7900 XTX"]
    assert hw.machine_key(info).startswith("Radeon RX 7900 XTX|24560|")


def test_detect_intel_arc_routes_vulkan(monkeypatch):
    row = GpuInfo(vendor="Intel", name="Intel(R) Arc(TM) A770 Graphics", vram_mb=16384)
    _no_nvidia(monkeypatch, scan=[row])
    monkeypatch.setattr(hw, "_amd_gpu_present", lambda: False)
    monkeypatch.setattr(hw, "_vulkan_available", lambda: True)
    info = hw.detect()
    assert info.runtimes.get("vulkan") is True
    assert "rocm" not in info.runtimes
    assert info.gpus == [row]


def test_detect_intel_igpu_routes_vulkan(monkeypatch):
    # A2 WIDENED (2026-07-23): ANY Intel GPU + the loader → the Vulkan runtime. The
    # old Arc-name gate left the Core Ultra 7 (registry name plain "Intel(R)
    # Graphics", qwMemorySize absent) CPU/online-only while its Vulkan device served
    # an 18 GB shared pool (detect-facts 2026-07-23).
    row = GpuInfo(vendor="Intel", name="Intel(R) Graphics", vram_mb=None)
    _no_nvidia(monkeypatch, scan=[row])
    monkeypatch.setattr(hw, "_amd_gpu_present", lambda: False)
    monkeypatch.setattr(hw, "_vulkan_available", lambda: True)
    info = hw.detect()
    assert info.runtimes.get("vulkan") is True
    assert info.gpus == [row]


def test_detect_intel_igpu_no_loader_stays_cpu(monkeypatch):
    # The loader still gates: no vulkan-1.dll → no vulkan runtime (the box takes
    # the online-provider path rather than a doomed engine install).
    row = GpuInfo(vendor="Intel", name="Intel(R) Graphics", vram_mb=None)
    _no_nvidia(monkeypatch, scan=[row])
    monkeypatch.setattr(hw, "_amd_gpu_present", lambda: False)
    monkeypatch.setattr(hw, "_vulkan_available", lambda: False)
    info = hw.detect()
    assert not any(info.runtimes.values())


def test_detect_nvidia_records_vulkan_fact(monkeypatch):
    # A4: on an NVIDIA box with a Vulkan loader, BOTH facts are recorded — on
    # Linux the pinned build has no installable CUDA archive, so selection falls
    # to the real pinned vulkan build (docker rows are never auto-selected).
    monkeypatch.setattr(hw, "_nvidia_gpus",
                        lambda: [GpuInfo(vendor="NVIDIA", name="RTX 4090", vram_mb=24564)])
    monkeypatch.setattr(hw.shutil, "which", lambda c: "/x/nvidia-smi" if c == "nvidia-smi" else None)
    monkeypatch.setattr(hw, "platform_key", lambda: "linux")
    monkeypatch.setattr(hw, "_vulkan_available", lambda: True)
    info = hw.detect()
    assert info.runtimes.get("cuda") is True
    assert info.runtimes.get("vulkan") is True


def test_detect_amd_wins_over_intel_arc(monkeypatch):
    from llm_runner.runner.binary import _gpu_preference

    rows = [
        GpuInfo(vendor="AMD", name="Radeon RX 7800 XT", vram_mb=16384),
        GpuInfo(vendor="Intel", name="Intel(R) Arc(TM) B580 Graphics", vram_mb=12288),
    ]
    _no_nvidia(monkeypatch, scan=rows)
    monkeypatch.setattr(hw, "_rocm_available", lambda: True)
    monkeypatch.setattr(hw, "_vulkan_available", lambda: True)
    info = hw.detect()
    # The AMD branch keeps precedence (elif chain): rocm recorded, vulkan too (both
    # are FACTS of the box — the A3 chain needs the truthful vulkan candidate) — and
    # SELECTION still puts rocm first.
    assert info.runtimes.get("rocm") is True
    assert info.runtimes.get("vulkan") is True
    assert _gpu_preference(info)[0] == "rocm"


def test_ram_mb_positive_on_every_supported_platform():
    # 2026-07-22: _ram_mb returned 0 on EVERY Windows box for the system's entire
    # life (psutil absent + os.sysconf does not exist on Windows), so the detected
    # class key was vram8|ram0 and the seeded vram8|ram32 class config never matched
    # the very PC it was measured on — the user's hand tune silently un-applied.
    # The Windows GlobalMemoryStatusEx arm fixes it; this pins "RAM detection works
    # HERE, wherever here is" (Windows exercises the ctypes arm when psutil is
    # absent; POSIX uses sysconf/psutil).
    from llm_runner.runner.hardware import _ram_mb

    ram = _ram_mb()
    assert ram > 1024, f"_ram_mb() returned {ram} — RAM detection is broken on this platform"


# ── Phase 4 (fit-redesign §11): the per-backend used-memory probe family ─────
# Fixture-pinned parses over DOCUMENTED interfaces — the same standard the
# platform detection above was built to from a single-OS dev box. Every arm's
# None degrades to the pre-Phase-4 behavior (true-up keeps the estimate).


def test_rocm_used_vram_parse(monkeypatch):
    from types import SimpleNamespace

    monkeypatch.setattr(hw.shutil, "which", lambda n: "/usr/bin/rocm-smi" if n == "rocm-smi" else None)
    csv = ("device,VRAM Total Memory (B),VRAM Total Used Memory (B)\n"
           "card0,17163091968,4294967296\n"
           "card1,17163091968,1073741824\n")
    monkeypatch.setattr(hw.subprocess, "run",
                        lambda *a, **k: SimpleNamespace(stdout=csv))
    assert hw._rocm_used_vram_mb() == (4294967296 + 1073741824) // (1024 * 1024)
    # Junk output → None, never a guess.
    monkeypatch.setattr(hw.subprocess, "run",
                        lambda *a, **k: SimpleNamespace(stdout="no such counters"))
    assert hw._rocm_used_vram_mb() is None


def test_amd_sysfs_used_vram(tmp_path):
    dev = tmp_path / "card0" / "device"
    dev.mkdir(parents=True)
    (dev / "mem_info_vram_used").write_text("2147483648\n")   # 2 GiB
    assert hw._amd_sysfs_used_vram_mb(tmp_path) == 2048
    assert hw._amd_sysfs_used_vram_mb(tmp_path / "absent") is None


def test_windows_gpu_counter_parse(monkeypatch):
    from types import SimpleNamespace

    monkeypatch.setattr(hw, "platform_key", lambda: "windows")
    monkeypatch.setattr(hw.shutil, "which", lambda n: "C:/typeperf" if n == "typeperf" else None)
    out = ('"(PDH-CSV 4.0)","\\BOX\GPU Adapter Memory(luid_a)\Dedicated Usage",'
           '"\\BOX\GPU Adapter Memory(luid_b)\Dedicated Usage"\n'
           '"08/13/2026 10:00:00.000","1073741824.000000","536870912.000000"\n')
    monkeypatch.setattr(hw.subprocess, "run",
                        lambda *a, **k: SimpleNamespace(stdout=out))
    assert hw._windows_gpu_dedicated_used_mb() == (1073741824 + 536870912) // (1024 * 1024)
    # The counter set absent (typeperf error text, no sample row) → None.
    monkeypatch.setattr(hw.subprocess, "run",
                        lambda *a, **k: SimpleNamespace(stdout="Error: no valid counters.\n"))
    assert hw._windows_gpu_dedicated_used_mb() is None


def test_used_device_mem_routing(monkeypatch):
    # One-pool box → the SYSTEM pool probe (bytes counted once); discrete box →
    # the VRAM arms, first non-None wins, all-None stays None (honest unknown).
    one_pool = _HardwareInfo(os="W", platform="windows", cpu_cores=8, ram_mb=32768,
                            gpus=[GpuInfo(vendor="Intel", name="Iris Xe", vram_mb=None)],
                            runtimes={"vulkan": True})
    monkeypatch.setattr(hw, "detect", lambda: one_pool)
    monkeypatch.setattr(hw, "_used_pool_mb", lambda: 12345)
    assert hw.used_device_mem_mb() == 12345

    discrete = _HardwareInfo(os="W", platform="windows", cpu_cores=8, ram_mb=32768,
                            gpus=[GpuInfo(vendor="AMD", name="RX 7600", vram_mb=8192)],
                            runtimes={"vulkan": True})
    monkeypatch.setattr(hw, "detect", lambda: discrete)
    monkeypatch.setattr(hw, "used_vram_mb", lambda: None)
    monkeypatch.setattr(hw, "_rocm_used_vram_mb", lambda: None)
    monkeypatch.setattr(hw, "_amd_sysfs_used_vram_mb", lambda: 3000)
    monkeypatch.setattr(hw, "_windows_gpu_dedicated_used_mb", lambda: 9999)
    assert hw.used_device_mem_mb() == 3000   # first non-None wins
    monkeypatch.setattr(hw, "_amd_sysfs_used_vram_mb", lambda: None)
    assert hw.used_device_mem_mb() == 9999
    monkeypatch.setattr(hw, "_windows_gpu_dedicated_used_mb", lambda: None)
    assert hw.used_device_mem_mb() is None


def test_used_pool_probe_live_sanity():
    # The pool probe on THIS box (any OS): a positive, sane MiB figure — the
    # Windows/Linux arms are pure OS calls, so this is a real live check.
    used = hw._used_pool_mb()
    assert used is not None and 100 < used < 4 * 1024 * 1024


# ── Per-process probes (the speech measured true-up, 2026-08-13) ─────────────


def test_nvidia_process_mem_parse(monkeypatch):
    from types import SimpleNamespace

    monkeypatch.setattr(hw.shutil, "which", lambda n: "/usr/bin/nvidia-smi" if n == "nvidia-smi" else None)
    # Two GPUs → the pid appears twice; a foreign pid and a WDDM "[N/A]" row ride along.
    out = "1234, 900\n5678, 4000\n1234, 300\n1234, [N/A]\n"
    monkeypatch.setattr(hw.subprocess, "run", lambda *a, **k: SimpleNamespace(stdout=out))
    assert hw._nvidia_process_mem_mb(1234) == 1200
    # WDDM: every row for the pid is non-numeric → None (falls through to the counter arm).
    monkeypatch.setattr(hw.subprocess, "run",
                        lambda *a, **k: SimpleNamespace(stdout="1234, [N/A]\n"))
    assert hw._nvidia_process_mem_mb(1234) is None
    # nvidia-smi absent → None without running anything.
    monkeypatch.setattr(hw.shutil, "which", lambda n: None)
    assert hw._nvidia_process_mem_mb(1234) is None


def test_windows_gpu_process_counter_parse(monkeypatch):
    from types import SimpleNamespace

    monkeypatch.setattr(hw, "platform_key", lambda: "windows")
    monkeypatch.setattr(hw.shutil, "which", lambda n: "C:/typeperf" if n == "typeperf" else None)
    out = ('"(PDH-CSV 4.0)","\\\\BOX\\GPU Process Memory(pid_1234_luid_a_phys_0)\\Dedicated Usage",'
           '"\\\\BOX\\GPU Process Memory(pid_1234_luid_a_phys_1)\\Dedicated Usage"\n'
           '"08/13/2026 10:00:00.000","1073741824.000000","268435456.000000"\n')
    monkeypatch.setattr(hw.subprocess, "run", lambda *a, **k: SimpleNamespace(stdout=out))
    assert hw._windows_gpu_process_dedicated_mb(1234) == (1073741824 + 268435456) // (1024 * 1024)
    # Localized/absent counter set → typeperf error text, no sample row → None.
    monkeypatch.setattr(hw.subprocess, "run",
                        lambda *a, **k: SimpleNamespace(stdout="Error: no valid counters.\n"))
    assert hw._windows_gpu_process_dedicated_mb(1234) is None
    # Not Windows → None without running anything.
    monkeypatch.setattr(hw, "platform_key", lambda: "linux")
    assert hw._windows_gpu_process_dedicated_mb(1234) is None


def test_process_device_mem_routing(monkeypatch):
    monkeypatch.setattr(hw, "_nvidia_process_mem_mb", lambda pid: None)
    monkeypatch.setattr(hw, "_windows_gpu_process_dedicated_mb", lambda pid: 2222)
    assert hw.process_device_mem_mb(42) == 2222
    monkeypatch.setattr(hw, "_nvidia_process_mem_mb", lambda pid: 1111)
    assert hw.process_device_mem_mb(42) == 1111  # first non-None wins
    monkeypatch.setattr(hw, "_nvidia_process_mem_mb", lambda pid: None)
    monkeypatch.setattr(hw, "_windows_gpu_process_dedicated_mb", lambda pid: None)
    assert hw.process_device_mem_mb(42) is None


def test_process_rss_live_sanity():
    # Our own pid: a positive, sane MiB figure on any OS (psutil or the OS arm).
    import os

    rss = hw.process_rss_mb(os.getpid())
    assert rss is not None and 5 < rss < 1024 * 1024
    # A pid that cannot exist → None, never a raise.
    assert hw.process_rss_mb(2**31 - 7) is None


def test_budget_total_is_arch_aware():
    dgpu = _HardwareInfo(os="W", platform="windows", cpu_cores=8, ram_mb=32768,
                        gpus=[GpuInfo(vendor="NVIDIA", name="2070S", vram_mb=8192)],
                        runtimes={"cuda": True})
    igpu = _HardwareInfo(os="W", platform="windows", cpu_cores=8, ram_mb=16384,
                        gpus=[GpuInfo(vendor="Intel", name="Iris Xe", vram_mb=None)],
                        runtimes={"vulkan": True})
    mac = _HardwareInfo(os="Darwin", platform="macos", cpu_cores=10, ram_mb=65536,
                       gpus=[], runtimes={"metal": True})
    assert hw.budget_total_mb(dgpu) == 8192    # the card (historical meaning)
    assert hw.budget_total_mb(igpu) == 16384   # the pool
    assert hw.budget_total_mb(mac) == 65536    # the pool
