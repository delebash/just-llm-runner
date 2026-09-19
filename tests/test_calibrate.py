# SPDX-License-Identifier: MIT
"""The one-minute speed check (speed-truth plan
docs/plans/2026-09-19-speed-truth-and-calibrated-pick.md §6 / §11.4). The fakes
replay the spike's REAL numbers from the author's box, so the expected result is
the live measurement: pass A 2.668 ms/token, pass B 9.320 → 182.8 MB / 6.652 ms
= 27.48 GB/s."""
from __future__ import annotations

import hashlib
from pathlib import Path

from llm_runner.runner import calibrate
from llm_runner.runner.bandwidth import MOE_PROBE_MODEL_ID, moe_probe_label
from llm_runner.runner.schema import GpuInfo, HardwareInfo, LlamacppSpec, RunnerConfig

_BLOB = b"not really a gguf - the job only hashes it"
_SHA = hashlib.sha256(_BLOB).hexdigest()


def _dgpu_box():
    return HardwareInfo(os="Windows", platform="windows", cpu_cores=16, ram_mb=32768,
                        gpus=[GpuInfo(vendor="NVIDIA", name="RTX 2070 SUPER", vram_mb=8192)],
                        runtimes={"cuda": True})


def _cpu_box():
    return HardwareInfo(os="Linux", platform="linux", cpu_cores=8, ram_mb=16000, gpus=[])


def _mac_box():
    return HardwareInfo(os="Darwin", platform="macos", cpu_cores=10, ram_mb=32768, gpus=[])


class _Svc:
    def __init__(self, tmp: Path, *, exe=True):
        self.cache_root = tmp / "cache"
        self.runtime_root = tmp / "runtime"
        (self.cache_root / "calib").mkdir(parents=True)
        (self.cache_root / "calib" / f"{_SHA}.gguf").write_bytes(_BLOB)  # already downloaded
        self._exe = (tmp / "llama-server.exe") if exe else None
        self.recorded: list[tuple] = []
        self.stopped = 0

    def config(self):
        return RunnerConfig(llamacpp=LlamacppSpec(pinned_build="b10437"),
                            calib_model_url="https://example.invalid/calib.gguf",
                            calib_model_sha256=_SHA, calib_model_size_bytes=len(_BLOB),
                            calib_active_expert_mb=182.8, calib_nonexpert_mb=88.7)

    def installed_exe(self):
        return self._exe

    def installed_build(self):
        return "b10437"

    def stop(self, model_id=None):
        self.stopped += 1
        return {}

    def record_machine_probe(self, gbps, mkey, model_id, label):
        self.recorded.append((gbps, mkey, model_id, label))
        return True

    def host_moe_bw_gbps(self, mkey):
        return None


class _Proc:
    def poll(self):
        return None

    def terminate(self):
        pass

    def wait(self, timeout=None):
        return 0


def _calibrator(svc, hardware, *, per_tok_a=2.668, per_tok_b=9.320, runs_b=None):
    argvs: list[list[str]] = []

    def popen(argv, **_kw):
        argvs.append(list(argv))
        return _Proc()

    calls = {"b": 0}

    def post(url, body):
        is_b = "--n-cpu-moe" in argvs[-1]
        ms_tok = per_tok_b if is_b else per_tok_a
        if is_b and runs_b:
            calls["b"] += 1
            ms_tok = runs_b[min(calls["b"] - 1, len(runs_b) - 1)]
        n = body["max_tokens"]
        return {"timings": {"predicted_n": n, "predicted_ms": ms_tok * n}}

    cal = calibrate.Calibrator(lambda: svc, hardware_fn=lambda: hardware, popen=popen,
                               http_post=post, health=lambda url: True, sleep=lambda s: None)
    return cal, argvs


def _run(cal):
    cal._state = {**cal._fresh("running")}
    cal._run()  # synchronous — the thread body
    return cal.status()


def test_check_mode_by_memory_topology():
    assert calibrate.check_mode(_dgpu_box())[0] == "two-pass"
    assert calibrate.check_mode(_cpu_box())[0] == "one-pass"
    mode, reason = calibrate.check_mode(_mac_box())
    assert mode == "" and "memory" in reason  # one pool — nothing to split


def test_two_pass_replays_the_spike_and_records_a_build_stamped_row(tmp_path):
    svc = _Svc(tmp_path)
    cal, argvs = _calibrator(svc, _dgpu_box())
    st = _run(cal)
    assert st["status"] == "done", st
    assert abs(st["gbps"] - 27.48) < 0.05          # 182.8 / (9.320 − 2.668)
    assert svc.stopped == 1                        # a clean GPU before measuring
    # Pass A all-GPU, pass B experts forced to RAM — the exact spike flags.
    assert argvs[0][-2:] == ["-ngl", "99"]
    assert argvs[1][-4:] == ["-ngl", "99", "--n-cpu-moe", "999"]
    gbps, _mkey, model_id, label = svc.recorded[0]
    assert model_id == MOE_PROBE_MODEL_ID and label == moe_probe_label("b10437")
    assert abs(gbps - 27.48) < 0.05


def test_one_pass_on_a_gpu_less_box_prices_every_byte_from_ram(tmp_path):
    svc = _Svc(tmp_path)
    cal, argvs = _calibrator(svc, _cpu_box(), per_tok_a=13.5)
    st = _run(cal)
    assert st["status"] == "done", st
    assert len(argvs) == 1 and argvs[0][-2:] == ["-ngl", "0"]
    assert abs(st["gbps"] - (182.8 + 88.7) / 13.5) < 0.05


def test_passes_too_close_to_tell_apart_record_nothing(tmp_path):
    svc = _Svc(tmp_path)
    cal, _ = _calibrator(svc, _dgpu_box(), per_tok_a=9.0, per_tok_b=9.5)  # delta 5 % of t_B
    st = _run(cal)
    assert st["status"] == "error" and "too close" in st["error"]
    assert svc.recorded == []


def test_unstable_readings_record_nothing(tmp_path):
    svc = _Svc(tmp_path)
    cal, _ = _calibrator(svc, _dgpu_box(), runs_b=[9.3, 9.3, 9.3, 14.0])  # warm-up + 3 runs
    st = _run(cal)
    assert st["status"] == "error" and "varied" in st["error"]
    assert svc.recorded == []


def test_one_pool_machine_is_refused(tmp_path):
    svc = _Svc(tmp_path)
    cal, argvs = _calibrator(svc, _mac_box())
    st = _run(cal)
    assert st["status"] == "error" and argvs == []


def test_a_checksum_mismatch_deletes_the_file(tmp_path, monkeypatch):
    svc = _Svc(tmp_path)
    target = svc.cache_root / "calib" / f"{_SHA}.gguf"
    target.write_bytes(b"corrupted")  # present but wrong → re-download

    def fake_download(url, dest, on_progress=None, cancel_check=None, **_kw):
        Path(dest).write_bytes(b"still wrong")

    monkeypatch.setattr(calibrate, "stream_download", fake_download)
    cal, _ = _calibrator(svc, _dgpu_box())
    st = _run(cal)
    assert st["status"] == "error" and "checksum" in st["error"]
    assert not target.exists() and svc.recorded == []


def test_no_engine_waits_then_fails_cleanly(tmp_path, monkeypatch):
    svc = _Svc(tmp_path, exe=False)
    monkeypatch.setattr(calibrate, "_ENGINE_WAIT", 0.0)
    cal, argvs = _calibrator(svc, _dgpu_box())
    st = _run(cal)
    assert st["status"] == "error" and "engine" in st["error"].lower() and argvs == []
