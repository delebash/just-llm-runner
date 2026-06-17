# SPDX-License-Identifier: GPL-3.0-or-later
"""P1.4 — VRAM-fit, flag composition, and spawn + probe-and-back-off. The
subprocess and health probe are injected, so this runs anywhere (no GPU,
no llama-server binary, no model)."""

from __future__ import annotations

import pytest

from llm_runner import load_manifest
from llm_runner.gguf import GgufMeta
from llm_runner.runner import (
    FitPlan,
    Overrides,
    Runner,
    RunnerStartError,
    compose_flags,
    compute_fit,
    start_runner,
)
from llm_runner.schema import GpuInfo, HardwareInfo, ModelEntry

# layer_bytes = 10 GB / 10 layers = 1 GB/layer → clean fit arithmetic.
_TEN_GB = 10_000_000_000


def _hw(vram_mb=None):
    gpus = [GpuInfo(vendor="NVIDIA", name="test", vram_mb=vram_mb)] if vram_mb else []
    return HardwareInfo(
        os="Linux", platform="linux", cpu_cores=8, ram_mb=32000,
        gpus=gpus, runtimes={"cuda": True} if vram_mb else {},
    )


def _meta(block_count=10, dim=1000, expert_count=0):
    return GgufMeta(
        architecture="qwen3moe" if expert_count else "llama",
        block_count=block_count, embedding_length=dim, expert_count=expert_count,
    )


def test_fit_cpu_only_no_gpu():
    m = load_manifest(refresh=True)
    fit = compute_fit(m, _meta(), _TEN_GB, _hw(vram_mb=None))
    assert fit.n_gpu_layers == 0
    assert fit.n_cpu_moe == 0


def test_fit_large_gpu_all_layers():
    m = load_manifest(refresh=True)
    fit = compute_fit(m, _meta(block_count=10), _TEN_GB, _hw(vram_mb=24000))
    assert fit.n_gpu_layers == 10  # everything fits


def test_fit_small_gpu_moe_offloads_rest():
    m = load_manifest(refresh=True)
    # 8GB − 1024 margin = 7168 budget; KV tiny; ~7 of ten 1-GB layers fit.
    fit = compute_fit(m, _meta(block_count=10, expert_count=128), _TEN_GB, _hw(vram_mb=8192))
    assert fit.n_gpu_layers == 7
    assert fit.is_moe
    assert fit.n_cpu_moe == 3  # 10 − 7 offloaded to CPU


def test_fit_overrides_win():
    m = load_manifest(refresh=True)
    fit = compute_fit(
        m, _meta(block_count=40, expert_count=8), _TEN_GB, _hw(vram_mb=24000),
        overrides=Overrides(n_gpu_layers=5, n_cpu_moe=2, ctx_len=8192),
    )
    assert fit.n_gpu_layers == 5
    assert fit.n_cpu_moe == 2
    assert fit.ctx_len == 8192


def test_compose_flags_replaces_ngl_and_adds_moe(tmp_path):
    m = load_manifest(refresh=True)
    flags = compose_flags(
        m, m.models[0], tmp_path / "model.gguf",
        n_gpu_layers=20, n_cpu_moe=4, ctx_len=4096, port=9999,
    )
    # the base preset's placeholder -ngl 999 is gone; ours appears once
    assert flags.count("-ngl") == 1
    assert flags[flags.index("-ngl") + 1] == "20"
    assert "999" not in flags
    assert flags[flags.index("--n-cpu-moe") + 1] == "4"
    assert flags[flags.index("-m") + 1].endswith("model.gguf")
    assert flags[flags.index("--port") + 1] == "9999"
    assert "--spec-type" in flags  # m.models[0] is the MTP entry


def test_compose_flags_no_moe_no_mtp(tmp_path):
    m = load_manifest(refresh=True)
    dense = ModelEntry(id="d", name="D", tier="mid", hf_repo="x/y", quant="Q4", mtp=False)
    flags = compose_flags(m, dense, tmp_path / "m.gguf", n_gpu_layers=0, n_cpu_moe=0, ctx_len=2048)
    assert "--n-cpu-moe" not in flags  # omitted when 0
    assert "--spec-type" not in flags  # non-MTP model
    assert flags[flags.index("-ngl") + 1] == "0"


class _FakeProc:
    def __init__(self, exit_code=None, output=""):
        self._code = exit_code  # None == still running
        self._output = output
        self.killed = False

    def poll(self):
        return self._code

    def communicate(self, timeout=None):
        return (self._output, None)

    def kill(self):
        self.killed = True

    def wait(self, timeout=None):
        return self._code

    def terminate(self):
        pass


def _fixture():
    m = load_manifest(refresh=True)
    fit = FitPlan(n_gpu_layers=20, n_cpu_moe=0, ctx_len=4096, block_count=48, is_moe=True)
    return m, m.models[0], fit


def test_start_runner_healthy_first_try():
    m, model, fit = _fixture()
    spawned = []

    def popen(argv, **k):
        spawned.append(argv)
        return _FakeProc(exit_code=None)  # alive

    r = start_runner(
        "llama-server", "m.gguf", m, model, fit,
        _popen=popen, _health=lambda u: True, _sleep=lambda s: None,
    )
    assert isinstance(r, Runner) and r.is_alive()
    assert r.n_gpu_layers == 20
    assert len(spawned) == 1


def test_start_runner_backs_off_on_oom():
    m, model, fit = _fixture()
    procs = [
        _FakeProc(exit_code=1, output="ggml_cuda: CUDA error: out of memory"),  # OOM exit
        _FakeProc(exit_code=None),                                              # then healthy
    ]
    state = {"n": 0}

    def popen(argv, **k):
        p = procs[state["n"]]
        state["n"] += 1
        return p

    r = start_runner(
        "llama-server", "m.gguf", m, model, fit, backoff_step=4,
        _popen=popen, _health=lambda u: state["n"] >= 2, _sleep=lambda s: None,
    )
    assert state["n"] == 2          # spawned twice
    assert r.n_gpu_layers == 16     # 20 − 4
    assert r.n_cpu_moe == fit.block_count - 16  # MoE offload recomputed on back-off
    assert procs[0].killed          # first attempt cleaned up


def test_start_runner_raises_on_non_oom():
    m, model, fit = _fixture()

    def popen(argv, **k):
        return _FakeProc(exit_code=1, output="fatal: model file not found")

    with pytest.raises(RunnerStartError):
        start_runner(
            "llama-server", "m.gguf", m, model, fit,
            _popen=popen, _health=lambda u: False, _sleep=lambda s: None,
        )
