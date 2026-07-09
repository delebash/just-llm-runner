# SPDX-License-Identifier: GPL-3.0-or-later
"""Binary selection + acquisition. HardwareInfo passed explicitly (no real
detection) and network mocked, so tests run anywhere."""

from __future__ import annotations

import io
import tarfile
import zipfile

import pytest

from llm_runner import default_config, select_binary
from llm_runner.runner import binary as binmod
from llm_runner.runner.schema import GpuInfo, HardwareInfo


def _hw(platform_name, runtimes, gpus=None):
    return HardwareInfo(
        os=platform_name, platform=platform_name, cpu_cores=8, ram_mb=32000,
        gpus=gpus or [], runtimes=runtimes,
    )


def test_select_windows_cuda():
    m = default_config()
    hw = _hw("windows", {"cuda": True}, [GpuInfo(vendor="NVIDIA", name="RTX 2070 SUPER", vram_mb=8192)])
    a = select_binary(m, hw)
    assert a and a.platform == "windows" and a.gpu == "cuda12" and a.asset_url


def test_select_cuda_by_chip():
    # The CUDA build is chosen by the GPU chip (compute capability): Blackwell
    # (sm_120 -> 12.0, datacenter sm_100 -> 10.0) needs 13.x; older cards + an
    # unknown capability use the broad-compat 12.4 build.
    m = default_config()

    def cap(c):
        return [GpuInfo(vendor="NVIDIA", name="gpu", vram_mb=16000, compute_cap=c)]

    assert select_binary(m, _hw("windows", {"cuda": True}, cap("12.0"))).gpu == "cuda13"
    assert select_binary(m, _hw("windows", {"cuda": True}, cap("10.0"))).gpu == "cuda13"
    assert select_binary(m, _hw("windows", {"cuda": True}, cap("7.5"))).gpu == "cuda12"
    assert select_binary(m, _hw("windows", {"cuda": True}, cap("8.9"))).gpu == "cuda12"
    assert select_binary(m, _hw("windows", {"cuda": True}, cap(None))).gpu == "cuda12"


def test_select_windows_no_gpu_selects_nothing():
    # The cpu rows are RETIRED (user, 2026-07-07: "deleet" — a CPU-only box can't
    # run local LLMs at usable speed): no GPU runtime → NO engine offered (None),
    # never the uselessly slow cpu build.
    m = default_config()
    assert select_binary(m, _hw("windows", {})) is None


def test_select_macos_metal():
    m = default_config()
    a = select_binary(m, _hw("macos", {"metal": True}))
    assert a and a.gpu == "metal" and a.server_exe == "llama-server"


def test_select_linux_cuda_never_picks_docker():
    # A4 (re-scoped): no pin-faithful container exists upstream, so the docker row
    # is never auto-selected. With the vulkan fact recorded (detect() does this on
    # NVIDIA boxes with a loader) selection lands on the REAL pinned vulkan
    # archive; without it, NOTHING (the cpu fallback row is retired — user,
    # 2026-07-07). The docker row stays in config as the future seam.
    m = default_config()
    a = select_binary(m, _hw("linux", {"cuda": True, "vulkan": True}))
    assert a and a.source == "github" and a.gpu == "vulkan"
    assert select_binary(m, _hw("linux", {"cuda": True})) is None
    assert any(b.source == "docker" for b in m.llamacpp.binaries)  # seam kept


def test_select_cross_platform_rows():
    # Every (platform, gpu) the detector can route to must resolve to a real,
    # fetchable asset — not fall through to None (the "no binary configured" bug).
    m = default_config()
    cases = [
        ("windows", {"rocm": True}, "rocm"),
        ("windows", {"vulkan": True}, "vulkan"),
        # ("linux", {}, cpu) RETIRED (user, 2026-07-07): no-GPU boxes get no engine.
        ("linux", {"rocm": True}, "rocm"),
        ("linux", {"vulkan": True}, "vulkan"),
    ]
    for platform_name, runtimes, want_gpu in cases:
        a = select_binary(m, _hw(platform_name, runtimes))
        assert a and a.gpu == want_gpu and a.asset_url, f"{platform_name}/{want_gpu} unresolved"


def _make_stream(calls, exe_name):
    """Fake stream_download: writes a `.zip` or `.tar.gz` (by dest suffix)
    containing `exe_name`, recording each fetched URL."""
    def _stream(url, dest, on_progress=None, cancel_check=None):
        if str(dest).lower().endswith((".tar.gz", ".tgz")):
            with tarfile.open(dest, "w:gz") as tf:
                data = b"MZ fake"
                info = tarfile.TarInfo(exe_name)
                info.size = len(data)
                tf.addfile(info, io.BytesIO(data))
        else:
            with zipfile.ZipFile(dest, "w") as zf:
                zf.writestr(exe_name, b"MZ fake")
        calls.append(url)
        if on_progress:
            on_progress(7, 7)  # (downloaded, total)
        return "deadbeef"

    return _stream


def test_acquire_windows_cuda_downloads_cudart_companion(monkeypatch, tmp_path):
    m = default_config()
    hw = _hw("windows", {"cuda": True})
    calls: list[str] = []
    monkeypatch.setattr(binmod, "stream_download", _make_stream(calls, "llama-server.exe"))

    exe = binmod.acquire_binary(tmp_path, m, hw)
    assert exe.is_file() and exe.name == "llama-server.exe"
    # BOTH the build zip (has the exe) AND the cudart runtime companion are fetched.
    assert len(calls) == 2
    assert any("cudart" in u for u in calls)
    assert not (binmod.binary_dir(tmp_path, m.llamacpp.pinned_build) / "_download.zip").exists()

    # Idempotent — second call returns same path without downloading.
    def boom(*a, **k):
        raise AssertionError("should not re-download")
    monkeypatch.setattr(binmod, "stream_download", boom)
    assert binmod.acquire_binary(tmp_path, m, hw) == exe


def test_acquire_tar_gz_macos(monkeypatch, tmp_path):
    # macOS/Linux assets are .tar.gz — _unpack must handle them (was zip-only).
    m = default_config()
    hw = _hw("macos", {"metal": True})
    calls: list[str] = []
    monkeypatch.setattr(binmod, "stream_download", _make_stream(calls, "llama-server"))

    exe = binmod.acquire_binary(tmp_path, m, hw)
    assert exe.is_file() and exe.name == "llama-server"
    assert len(calls) == 1  # metal has no runtime companion
    dest = binmod.binary_dir(tmp_path, m.llamacpp.pinned_build)
    assert not list(dest.glob("_download*"))  # temp archive cleaned up


def test_acquire_docker_raises(tmp_path):
    # Auto-selection never lands on docker anymore (A4) — FORCING the variant via
    # gpu= still explains itself with the truthful pin story. Auto-select on a
    # plain linux+cuda box now resolves the cpu github asset instead of raising.
    m = default_config()
    with pytest.raises(NotImplementedError, match="pin-faithful"):
        binmod.acquire_binary(tmp_path, m, _hw("linux", {"cuda": True}), gpu="cuda12")


# ── A3: per-variant layout + the installed-builds probe ───────────────────────

def test_acquire_unpacks_into_variant_dir(monkeypatch, tmp_path):
    # New installs land in <build>/<gpu>/ so variants coexist for the spawn chain.
    m = default_config()
    hw = _hw("windows", {"cuda": True})
    monkeypatch.setattr(binmod, "stream_download", _make_stream([], "llama-server.exe"))
    exe = binmod.acquire_binary(tmp_path, m, hw)
    assert exe.is_relative_to(binmod.variant_dir(tmp_path, m.llamacpp.pinned_build, "cuda12"))


def test_acquire_gpu_override_installs_specific_variant(monkeypatch, tmp_path):
    # The engine install plants fallbacks via gpu=...; each lands in ITS OWN dir.
    # (Re-seated on vulkan — the cpu row is retired, user 2026-07-07.)
    m = default_config()
    hw = _hw("windows", {"cuda": True})
    monkeypatch.setattr(binmod, "stream_download", _make_stream([], "llama-server.exe"))
    exe = binmod.acquire_binary(tmp_path, m, hw, gpu="vulkan")
    assert exe.is_relative_to(binmod.variant_dir(tmp_path, m.llamacpp.pinned_build, "vulkan"))
    # and the selected build's probe still reports nothing (vulkan ≠ selected cuda12)
    assert binmod.acquired_server_exe(tmp_path, m, hw) is None


def test_acquired_server_exes_orders_and_single_attributes(tmp_path):
    # Legacy pre-variant install at the BUILD ROOT counts ONLY for the selected
    # asset; variant dirs count for their own gpu key; order = _gpu_preference.
    # A leftover on-disk cpu variant (pre-retirement installs planted one) is NOT
    # offered to the chain — its config row is gone (user, 2026-07-07).
    m = default_config()
    hw = _hw("windows", {"cuda": True, "vulkan": True})
    build = m.llamacpp.pinned_build
    root = binmod.binary_dir(tmp_path, build)
    root.mkdir(parents=True)
    (root / "llama-server.exe").write_bytes(b"MZ legacy")          # legacy root install
    for gpu in ("vulkan", "cpu"):
        d = binmod.variant_dir(tmp_path, build, gpu)
        d.mkdir(parents=True)
        (d / "llama-server.exe").write_bytes(b"MZ " + gpu.encode())
    got = binmod.acquired_server_exes(tmp_path, m, hw)
    assert [g for g, _ in got] == ["cuda12", "vulkan"]             # preference order; no cpu
    assert got[0][1] == root / "llama-server.exe"                  # legacy → selected only
    assert got[1][1] == binmod.variant_dir(tmp_path, build, "vulkan") / "llama-server.exe"


def test_legacy_root_not_attributed_to_unselected_variants(tmp_path):
    # ONE legacy exe must not satisfy every variant — else the chain would "retry"
    # the same broken binary under three names.
    m = default_config()
    hw = _hw("windows", {"cuda": True, "vulkan": True})
    root = binmod.binary_dir(tmp_path, m.llamacpp.pinned_build)
    root.mkdir(parents=True)
    (root / "llama-server.exe").write_bytes(b"MZ legacy")
    got = binmod.acquired_server_exes(tmp_path, m, hw)
    assert [g for g, _ in got] == ["cuda12"]


# ── QC-13: the install check follows the DISK (user's box, 2026-07-09) ────────

def test_acquired_exe_follows_disk_build_when_pin_reverted(tmp_path):
    # The user's exact state: the Update flow installed b9929, then a DB reset
    # reverted the pin to the seeded b9899 — and the app claimed "Not installed".
    # The user's law: "check the path and if path exe exist assume engine is
    # installed" — the newest on-disk build holding the exe wins when the pinned
    # build's folder doesn't.
    m = default_config()
    hw = _hw("windows", {"cuda": True})
    disk_build = f"b{binmod.build_num(m.llamacpp.pinned_build) + 30}"  # b9899 → b9929
    d = binmod.variant_dir(tmp_path, disk_build, "cuda12")
    d.mkdir(parents=True)
    (d / "llama-server.exe").write_bytes(b"MZ update-installed")
    exe = binmod.acquired_server_exe(tmp_path, m, hw)
    assert exe == d / "llama-server.exe"
    assert binmod.build_of_exe(tmp_path, exe) == disk_build


def test_acquired_exe_prefers_pinned_build_when_both_on_disk(tmp_path):
    # The pin stays authoritative when ITS folder holds the exe — disk builds
    # only step in when the pinned folder has nothing.
    m = default_config()
    hw = _hw("windows", {"cuda": True})
    pinned = m.llamacpp.pinned_build
    newer = f"b{binmod.build_num(pinned) + 30}"
    for build in (pinned, newer):
        d = binmod.variant_dir(tmp_path, build, "cuda12")
        d.mkdir(parents=True)
        (d / "llama-server.exe").write_bytes(b"MZ " + build.encode())
    exe = binmod.acquired_server_exe(tmp_path, m, hw)
    assert binmod.build_of_exe(tmp_path, exe) == pinned


def test_acquire_binary_targets_pin_not_disk_build(monkeypatch, tmp_path):
    # The WRITE path stays pin-keyed: a pin-bump Update must download the new
    # build even while the superseded one is still on disk — resolving here
    # would skip the download and the stale-build sweep would then delete the
    # only engine on disk.
    m = default_config()
    hw = _hw("windows", {"cuda": True})
    older = f"b{binmod.build_num(m.llamacpp.pinned_build) - 30}"
    d = binmod.variant_dir(tmp_path, older, "cuda12")
    d.mkdir(parents=True)
    (d / "llama-server.exe").write_bytes(b"MZ pre-update")
    monkeypatch.setattr(binmod, "stream_download", _make_stream([], "llama-server.exe"))
    exe = binmod.acquire_binary(tmp_path, m, hw)
    assert exe.is_relative_to(binmod.variant_dir(tmp_path, m.llamacpp.pinned_build, "cuda12"))
