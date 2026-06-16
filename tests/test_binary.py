# SPDX-License-Identifier: GPL-3.0-or-later
"""Binary selection + acquisition. HardwareInfo passed explicitly (no real
detection) and network mocked, so tests run anywhere."""

from __future__ import annotations

import zipfile

import pytest

from llm_runner import load_manifest, select_binary
from llm_runner import binary as binmod
from llm_runner.schema import GpuInfo, HardwareInfo


def _hw(platform_name, runtimes, gpus=None):
    return HardwareInfo(
        os=platform_name, platform=platform_name, cpu_cores=8, ram_mb=32000,
        gpus=gpus or [], runtimes=runtimes,
    )


def test_select_windows_cuda():
    m = load_manifest(refresh=True)
    hw = _hw("windows", {"cuda": True}, [GpuInfo(vendor="NVIDIA", name="RTX 2070 SUPER", vram_mb=8192)])
    a = select_binary(m, hw)
    assert a and a.platform == "windows" and a.gpu == "cuda12" and a.asset_url


def test_select_windows_cpu_fallback():
    m = load_manifest(refresh=True)
    a = select_binary(m, _hw("windows", {}))
    assert a and a.gpu == "cpu"


def test_select_macos_metal():
    m = load_manifest(refresh=True)
    a = select_binary(m, _hw("macos", {"metal": True}))
    assert a and a.gpu == "metal" and a.server_exe == "llama-server"


def test_select_linux_cuda_docker():
    m = load_manifest(refresh=True)
    a = select_binary(m, _hw("linux", {"cuda": True}))
    assert a and a.source == "docker" and a.image


def test_acquire_github_zip(monkeypatch, tmp_path):
    m = load_manifest(refresh=True)
    hw = _hw("windows", {"cuda": True})

    def fake_stream(url, dest, on_progress=None, cancel_check=None):
        with zipfile.ZipFile(dest, "w") as zf:
            zf.writestr("llama-server.exe", b"MZ fake")
        if on_progress:
            on_progress(7)
        return "deadbeef"

    monkeypatch.setattr(binmod, "stream_download", fake_stream)

    exe = binmod.acquire_binary(tmp_path, m, hw)
    assert exe.is_file() and exe.name == "llama-server.exe"
    assert not (binmod.binary_dir(tmp_path, m.llamacpp.pinned_build) / "_download.zip").exists()

    # Idempotent — second call returns same path without downloading.
    def boom(*a, **k):
        raise AssertionError("should not re-download")
    monkeypatch.setattr(binmod, "stream_download", boom)
    assert binmod.acquire_binary(tmp_path, m, hw) == exe


def test_acquire_docker_raises(tmp_path):
    m = load_manifest(refresh=True)
    with pytest.raises(NotImplementedError):
        binmod.acquire_binary(tmp_path, m, _hw("linux", {"cuda": True}))
