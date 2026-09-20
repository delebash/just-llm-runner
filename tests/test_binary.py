# SPDX-License-Identifier: MIT
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

# The real verifiers, captured BEFORE the autouse stub below replaces them: the acquire
# tests unpack a fake 'MZ fake' exe that cannot really run, so they bypass the real
# `<exe> --version` checks; each check's own behaviour is tested directly via these refs.
_REAL_VERIFY = binmod._verify_exe_launches
_REAL_ACCEPTS = binmod._verify_exe_accepts_flags


@pytest.fixture(autouse=True)
def _stub_launch_verify(monkeypatch):
    monkeypatch.setattr(binmod, "_verify_exe_launches", lambda *a, **k: None)
    monkeypatch.setattr(binmod, "_verify_exe_accepts_flags", lambda *a, **k: None)


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
    containing `exe_name`, recording each fetched URL. **_segment_kwargs absorbs
    the DL-2 segment settings — irrelevant to the unpack behavior under test."""
    def _stream(url, dest, on_progress=None, cancel_check=None, **_segment_kwargs):
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


def test_acquire_fetches_stored_url_into_pin_folder(monkeypatch, tmp_path):
    # 2026-07-21: URLs are CONCRETE in the DB (the UI keeps every stored URL in lock-step
    # with the pin); the server does NOT compose — acquire fetches exactly the stored
    # asset_url and unpacks into the pinned build's folder, so folder and binary agree.
    m = default_config()  # concrete seed URLs at DEFAULT_PINNED_BUILD
    build = m.llamacpp.pinned_build
    hw = _hw("windows", {"cuda": True})
    calls: list[str] = []
    monkeypatch.setattr(binmod, "stream_download", _make_stream(calls, "llama-server.exe"))

    exe = binmod.acquire_binary(tmp_path, m, hw)
    assert binmod.build_of_exe(tmp_path, exe) == build             # lands in the pin's folder
    assert calls and all(f"/download/{build}/" in u for u in calls)  # fetches the stored URL
    assert not any("{build}" in u for u in calls)                  # no template placeholder leaks


# ── the ATOMIC + launch-verified install (2026-07-21: the update-brick fix) ────────

def test_verify_exe_launches_flags_a_missing_runtime_dll():
    from types import SimpleNamespace
    exe = binmod.Path("llama-server.exe")
    # exit 0 (or ANY app exit) → the process RAN, its libraries loaded → OK, no raise.
    _REAL_VERIFY(exe, "windows", run=lambda: SimpleNamespace(returncode=0))
    _REAL_VERIFY(exe, "windows", run=lambda: SimpleNamespace(returncode=1))
    _REAL_VERIFY(exe, "linux", run=lambda: SimpleNamespace(returncode=2))
    # a Windows loader failure — 0xC0000135 (3221225781) STATUS_DLL_NOT_FOUND → raises.
    with pytest.raises(RuntimeError, match="runtime library is missing"):
        _REAL_VERIFY(exe, "windows", run=lambda: SimpleNamespace(returncode=3221225781))
    # a Unix missing-.so (exit 127) → raises.
    with pytest.raises(RuntimeError, match="runtime library is missing"):
        _REAL_VERIFY(exe, "linux", run=lambda: SimpleNamespace(returncode=127))
    # the OS can't start the image at all → raises.
    def _boom():
        raise OSError("not a valid Win32 application")
    with pytest.raises(RuntimeError, match="could not start"):
        _REAL_VERIFY(exe, "windows", run=_boom)


def test_verify_exe_accepts_flags_names_the_rejected_flag():
    # 2026-09-19 (plan …-engine-update-safety-and-stable-channel.md §3.3): llama.cpp b10875
    # DELETED --mlock/--no-mmap. Such a build PASSES the `--version` check, so this second
    # check is what keeps it from replacing a working engine and breaking every load.
    from types import SimpleNamespace
    exe = binmod.Path("llama-server.exe")

    def _rejects(_argv):
        return SimpleNamespace(returncode=1, stdout=b"",
                               stderr=b"error: invalid argument: --no-mmap\n")

    with pytest.raises(RuntimeError, match=r"--no-mmap") as e:
        _REAL_ACCEPTS(exe, [["--no-mmap", "--version"]], run=_rejects)
    assert "left in place" in str(e.value)     # the message says the engine was NOT replaced


def test_verify_exe_accepts_flags_passes_on_zero_and_on_no_probes():
    from types import SimpleNamespace
    exe = binmod.Path("llama-server.exe")
    seen = []

    def _ok(argv):
        seen.append(argv)
        return SimpleNamespace(returncode=0, stdout=b"version: 0.1.0-dev\n", stderr=b"")

    _REAL_ACCEPTS(exe, [["--load-mode", "none", "--version"], ["--version"]], run=_ok)
    assert len(seen) == 2                       # every probe is run, not just the first
    _REAL_ACCEPTS(exe, None, run=_ok)           # nothing to check → no-op, no raise
    _REAL_ACCEPTS(exe, [], run=_ok)
    assert len(seen) == 2

    def _hangs(_argv):
        raise binmod.subprocess.TimeoutExpired(cmd="x", timeout=60)

    with pytest.raises(RuntimeError, match="could not run the flag check"):
        _REAL_ACCEPTS(exe, [["--version"]], run=_hangs)


def _seed_working_engine(tmp_path, m, gpu="cuda12"):
    """A pre-existing, complete engine variant on disk — the 'working engine'."""
    d = binmod.variant_dir(tmp_path, m.llamacpp.pinned_build, gpu)
    d.mkdir(parents=True, exist_ok=True)
    (d / "llama-server.exe").write_bytes(b"GOOD-OLD-ENGINE")
    return d


def _no_staging_litter(tmp_path, m):
    bd = binmod.binary_dir(tmp_path, m.llamacpp.pinned_build)
    return not list(bd.glob(".staging-*")) and not list(bd.glob(".old-*"))


def test_acquire_atomic_a_failed_download_leaves_the_working_engine(monkeypatch, tmp_path):
    # THE BRICK THIS FIXES: a force re-download that FAILS must NOT wipe the working engine.
    m = default_config()
    good = _seed_working_engine(tmp_path, m)

    def boom(*a, **k):
        raise RuntimeError("network died mid-download")
    monkeypatch.setattr(binmod, "stream_download", boom)

    with pytest.raises(RuntimeError, match="network died"):
        binmod.acquire_binary(tmp_path, m, _hw("windows", {"cuda": True}), force=True)
    assert (good / "llama-server.exe").read_bytes() == b"GOOD-OLD-ENGINE"   # untouched
    assert _no_staging_litter(tmp_path, m)


def test_acquire_atomic_a_build_that_fails_launch_is_discarded(monkeypatch, tmp_path):
    # A downloaded build whose exe won't launch (missing DLL) is discarded; the old one stays.
    m = default_config()
    good = _seed_working_engine(tmp_path, m)
    monkeypatch.setattr(binmod, "stream_download", _make_stream([], "llama-server.exe"))

    def _fail_verify(*a, **k):
        raise RuntimeError("a required runtime library is missing")
    monkeypatch.setattr(binmod, "_verify_exe_launches", _fail_verify)  # overrides the autouse stub

    with pytest.raises(RuntimeError, match="runtime library is missing"):
        binmod.acquire_binary(tmp_path, m, _hw("windows", {"cuda": True}), force=True)
    assert (good / "llama-server.exe").read_bytes() == b"GOOD-OLD-ENGINE"   # untouched
    assert _no_staging_litter(tmp_path, m)


def test_acquire_discards_a_build_that_rejects_our_flags(monkeypatch, tmp_path):
    # The b10875 class, end to end: the download and the launch check both SUCCEED, and the
    # build is still discarded because it refuses a flag this app puts on every model.
    m = default_config()
    good = _seed_working_engine(tmp_path, m)
    monkeypatch.setattr(binmod, "stream_download", _make_stream([], "llama-server.exe"))

    def _reject(*a, **k):
        raise RuntimeError("this engine build does not accept a launch flag this app uses "
                           "(error: invalid argument: --no-mmap) — the installed engine was "
                           "left in place")
    monkeypatch.setattr(binmod, "_verify_exe_accepts_flags", _reject)  # overrides the autouse stub

    with pytest.raises(RuntimeError, match="does not accept a launch flag"):
        binmod.acquire_binary(tmp_path, m, _hw("windows", {"cuda": True}), force=True,
                              probe_argvs=[["--no-mmap", "--version"]])
    assert (good / "llama-server.exe").read_bytes() == b"GOOD-OLD-ENGINE"   # untouched
    assert _no_staging_litter(tmp_path, m)


def test_acquire_force_reinstalls_and_swaps_even_when_present(monkeypatch, tmp_path):
    # force=True re-fetches over an existing variant (an update / reinstall) via the staged
    # swap — NOT the idempotent skip — and the fresh build lands in place.
    m = default_config()
    _seed_working_engine(tmp_path, m)
    calls: list[str] = []
    monkeypatch.setattr(binmod, "stream_download", _make_stream(calls, "llama-server.exe"))

    exe = binmod.acquire_binary(tmp_path, m, _hw("windows", {"cuda": True}), force=True)
    assert calls                                                 # it DID re-download
    assert exe.read_bytes() == b"MZ fake"                        # the fresh build swapped in
    assert binmod.build_of_exe(tmp_path, exe) == m.llamacpp.pinned_build
    assert _no_staging_litter(tmp_path, m)


def test_acquire_refuses_a_placeholder_url(monkeypatch, tmp_path):
    # A stored URL still carrying a `{…}` placeholder (a legacy row) 404s N times then fails.
    # `_fetch` refuses it up front with a clear message; stream_download is stubbed to blow up
    # so we prove the guard fires BEFORE any network call.
    m = default_config()
    hw = _hw("windows", {"cuda": True})
    asset = select_binary(m, hw)          # same object that lives in m.llamacpp.binaries
    asset.asset_url = (
        "https://github.com/ggml-org/llama.cpp/releases/download/{build}/"
        "llama-{build}-bin-win-cuda-12.4-x64.zip"
    )

    def boom(*a, **k):
        raise AssertionError("stream_download must not be called for a placeholder URL")
    monkeypatch.setattr(binmod, "stream_download", boom)

    with pytest.raises(RuntimeError, match="unresolved placeholder"):
        binmod.acquire_binary(tmp_path, m, hw)


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


# ── Download names come from the RELEASE's own asset list (2026-09-19, plan
#    docs/plans/2026-09-19-engine-update-safety-and-stable-channel.md §3.4). Upstream
#    renames these files between builds; substituting the tag into a stored name 404s. ──

def _assets_fixture():
    import json
    from pathlib import Path as _P
    raw = json.loads((_P(__file__).parent / "fixtures" / "llamacpp_release_assets.json")
                     .read_text(encoding="utf-8"))
    return {k: [{"name": n, "url": ""} for n in v] for k, v in raw.items() if not k.startswith("_")}


def _rows_for(build):
    """DEFAULT_BINARIES re-pointed at `build` the OLD way (tag substitution) — exactly the
    stored state an update would start from."""
    from llm_runner.runner.config import DEFAULT_BINARIES, DEFAULT_PINNED_BUILD
    rows = []
    for b in DEFAULT_BINARIES:
        d = dict(b)
        for key in ("asset_url", "runtime_url"):
            if d.get(key):
                d[key] = d[key].replace(DEFAULT_PINNED_BUILD, build)
        rows.append(binmod.BinaryAsset(**d))
    return rows


def _by_key(resolved):
    return {f"{r['platform']}/{r['gpu']}": r for r in resolved}


@pytest.mark.parametrize(("build", "want"), [
    ("b9993",  {"windows/cuda12": "llama-b9993-bin-win-cuda-12.4-x64.zip",
                "windows/cuda13": "llama-b9993-bin-win-cuda-13.3-x64.zip",
                "windows/rocm":   "llama-b9993-bin-win-hip-radeon-x64.zip",
                "linux/rocm":     "llama-b9993-bin-ubuntu-rocm-7.2-x64.tar.gz"}),
    ("b10437", {"windows/cuda12": "llama-b10437-bin-win-cuda-12.4-x64.zip",
                "windows/cuda13": "llama-b10437-bin-win-cuda-13.3-x64.zip",
                "windows/rocm":   "llama-b10437-bin-win-rocm-7.14-x64.zip",
                "linux/rocm":     None}),          # upstream published NONE for ~180 builds
    ("b10964", {"windows/cuda12": "llama-b10964-bin-win-cuda-12.4-x64.zip",
                "windows/cuda13": "llama-b10964-bin-win-cuda-13.3-x64.zip",
                "windows/rocm":   "llama-b10964-bin-win-rocm-10.0-x64.zip",
                "linux/rocm":     "llama-b10964-bin-ubuntu-rocm-10.0-x64.tar.gz"}),
    ("b11056", {"windows/cuda12": "llama-b11056-bin-win-cuda-12.4-x64.zip",
                "windows/cuda13": "llama-b11056-bin-win-cuda-13.4-x64.zip",   # 13.3 → 13.4
                "windows/rocm":   "llama-b11056-bin-win-rocm-10.0-x64.zip",
                "linux/rocm":     "llama-b11056-bin-ubuntu-rocm-10.0-x64.tar.gz"}),
])
def test_resolve_release_assets_against_four_real_builds(build, want):
    got = _by_key(binmod.resolve_release_assets(build, _rows_for(build), _assets_fixture()[build]))
    for key, name in want.items():
        row = got[key]
        if name is None:
            assert row["resolved"] is False, (build, key, row)
            assert build in row["reason"] and key in row["reason"]
        else:
            assert row["resolved"] is True, (build, key, row)
            assert row["assetUrl"].endswith(name), (build, key, row["assetUrl"])
    # the one-name rows resolve at EVERY build
    for key, tail in (("windows/vulkan", f"llama-{build}-bin-win-vulkan-x64.zip"),
                      ("macos/metal", f"llama-{build}-bin-macos-arm64.tar.gz"),
                      ("linux/vulkan", f"llama-{build}-bin-ubuntu-vulkan-x64.tar.gz")):
        assert got[key]["resolved"] is True and got[key]["assetUrl"].endswith(tail)
    # docker is never ours to resolve
    assert got["linux/cuda12"]["resolved"] is None
    # a CUDA asset always keeps a MATCHING cudart companion
    for key in ("windows/cuda12", "windows/cuda13"):
        row = got[key]
        if row["resolved"]:
            version = row["assetUrl"].rsplit("-x64.zip", 1)[0].rsplit("-", 1)[-1]
            assert f"cuda-{version}-x64.zip" in row["runtimeUrl"], (build, key, row)
    # an arm64 file never satisfies an x64 row
    assert "arm64" not in got["windows/cuda13"]["assetUrl"]


def test_resolve_leaves_a_hand_edited_url_alone():
    rows = _rows_for("b10964")
    mirror = "https://mirror.example.com/llama/custom-build.zip"
    for r in rows:
        if r.platform == "windows" and r.gpu == "cuda12":
            r.asset_url = mirror
    got = _by_key(binmod.resolve_release_assets("b10964", rows, _assets_fixture()["b10964"]))
    row = got["windows/cuda12"]
    assert row["resolved"] is None and row["assetUrl"] == mirror
    assert "custom URL" in row["reason"]


def test_resolve_refuses_an_asset_without_its_runtime():
    # A CUDA build whose cudart companion is missing would unpack, pass --version only if the
    # DLLs happened to be there, and otherwise brick the install — refuse it up front.
    assets = [a for a in _assets_fixture()["b10964"]
              if a["name"] != "cudart-llama-bin-win-cuda-13.3-x64.zip"]
    got = _by_key(binmod.resolve_release_assets("b10964", _rows_for("b10964"), assets))
    assert got["windows/cuda13"]["resolved"] is False
    assert "runtime companion" in got["windows/cuda13"]["reason"]
    assert got["windows/cuda12"]["resolved"] is True          # its own companion is intact


def test_resolve_picks_the_highest_version_when_several_match():
    assets = [{"name": "llama-b10964-bin-ubuntu-rocm-7.2-x64.tar.gz", "url": ""},
              {"name": "llama-b10964-bin-ubuntu-rocm-10.0-x64.tar.gz", "url": ""}]
    got = _by_key(binmod.resolve_release_assets("b10964", _rows_for("b10964"), assets))
    assert got["linux/rocm"]["assetUrl"].endswith("rocm-10.0-x64.tar.gz")   # 10.0 > 7.2


def test_build_num_is_strict():
    # 2026-09-19: `releases/latest` now answers a semver tag. The old digit-strip read
    # "v0.4.1" as 41 (silently "you are current" on every box) and would read "v1.10.500"
    # as 110500 — newer than every build, i.e. an update to a tag with no binaries.
    assert binmod.build_num("b9929") == 9929
    assert binmod.build_num(" b10437 ") == 10437
    for bad in ("v0.4.1", "v1.10.500", "v0.2.0", "", "latest", "b12x", "10437", None):
        assert binmod.build_num(bad) == -1, bad
