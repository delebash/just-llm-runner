# SPDX-License-Identifier: GPL-3.0-or-later
"""Hardware detection: NVIDIA compute-capability parse (+ old-driver fallback)
and the AMD ROCm-first / Vulkan-fallback routing. Every probe is monkeypatched,
so it runs on any box with no GPU."""

from __future__ import annotations

from llm_runner.runner import hardware as hw


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


def _no_nvidia(monkeypatch, plat="linux"):
    monkeypatch.setattr(hw, "_nvidia_gpus", lambda: [])
    monkeypatch.setattr(hw.shutil, "which", lambda c: None)
    monkeypatch.setattr(hw, "platform_key", lambda: plat)


def test_detect_amd_rocm_first(monkeypatch):
    _no_nvidia(monkeypatch)
    monkeypatch.setattr(hw, "_amd_gpu_present", lambda: True)
    monkeypatch.setattr(hw, "_rocm_available", lambda: True)
    monkeypatch.setattr(hw, "_vulkan_available", lambda: True)
    info = hw.detect()
    assert info.runtimes.get("rocm") is True
    assert "vulkan" not in info.runtimes  # ROCm wins when present
    assert "cuda" not in info.runtimes


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
