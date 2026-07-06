# SPDX-License-Identifier: GPL-3.0-or-later
"""Hardware detection: NVIDIA compute-capability parse (+ old-driver fallback),
the AMD ROCm-first / Vulkan-fallback routing, the sysfs/registry AMD-Intel scan
(A1: rows with VRAM where the platform exposes it), and the Intel-Arc → Vulkan
routing (A2). Every probe is monkeypatched, so it runs on any box with no GPU."""

from __future__ import annotations

import os

from llm_runner.runner import hardware as hw
from llm_runner.runner.schema import GpuInfo


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


def test_detect_intel_igpu_stays_cpu(monkeypatch):
    # iGPU-only Intel box: the recorded A2 scope is ARC DISCRETE — no GPU runtime.
    row = GpuInfo(vendor="Intel", name="Intel(R) Iris(R) Xe Graphics", vram_mb=None)
    _no_nvidia(monkeypatch, scan=[row])
    monkeypatch.setattr(hw, "_amd_gpu_present", lambda: False)
    monkeypatch.setattr(hw, "_vulkan_available", lambda: True)
    info = hw.detect()
    assert not any(info.runtimes.values())
    assert info.gpus == [row]  # the row still exists (name in the UI, key in tunes)


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
