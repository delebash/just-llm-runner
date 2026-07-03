# SPDX-License-Identifier: GPL-3.0-or-later
"""VRAM-fit, flag composition, and spawn + probe-and-back-off. The subprocess
and health probe are injected, so this runs anywhere (no GPU, no llama-server
binary, no model).

Post-A7: there is no runner-manifest. `compute_fit` takes the VRAM safety margin
directly (default), and `compose_flags` renders PURELY from the resolved
`Overrides` (the base + type (moe|dense) flag defaults arrive in `Overrides`, resolved
from the DB `switch_presets` by the runner's switches_fn) + the computed fit knobs."""

from __future__ import annotations

import pytest

from llm_runner.runner.gguf import GgufMeta
from llm_runner.runner.process import (
    FitPlan,
    Overrides,
    Runner,
    RunnerStartError,
    _tail_file,
    compose_flags,
    compute_fit,
    start_runner,
)
from llm_runner.runner.schema import GpuInfo, HardwareInfo

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


# ── compute_fit ───────────────────────────────────────────────────────────────

def test_fit_cpu_only_no_gpu():
    fit = compute_fit(_meta(), _TEN_GB, _hw(vram_mb=None))
    assert fit.n_gpu_layers == 0
    assert fit.n_cpu_moe == 0


def test_fit_large_gpu_all_layers():
    fit = compute_fit(_meta(block_count=10), _TEN_GB, _hw(vram_mb=24000))
    assert fit.n_gpu_layers == 10  # everything fits


def test_fit_small_gpu_moe_offloads_rest():
    # 10 GB model on an 8 GB GPU → only some layers fit; the oobabooga formula
    # (incl. base CUDA overhead) sets how many, and the MoE rest offloads to CPU.
    fit = compute_fit(_meta(block_count=10, expert_count=128), _TEN_GB, _hw(vram_mb=8192))
    assert fit.is_moe
    assert 0 < fit.n_gpu_layers < 10                 # partial fit
    assert fit.n_cpu_moe == 10 - fit.n_gpu_layers    # the rest offloads to CPU


def test_fit_overrides_win():
    fit = compute_fit(
        _meta(block_count=40, expert_count=8), _TEN_GB, _hw(vram_mb=24000),
        overrides=Overrides(n_gpu_layers=5, n_cpu_moe=2, ctx_len=8192),
    )
    assert fit.n_gpu_layers == 5
    assert fit.n_cpu_moe == 2
    assert fit.ctx_len == 8192


def test_fit_safety_margin_shrinks_budget():
    # A larger margin reserves more VRAM → no more layers fit than a small margin.
    tight = compute_fit(_meta(block_count=10), _TEN_GB, _hw(vram_mb=8192), safety_margin_mb=6000)
    loose = compute_fit(_meta(block_count=10), _TEN_GB, _hw(vram_mb=8192), safety_margin_mb=512)
    assert tight.n_gpu_layers <= loose.n_gpu_layers


# ── compose_flags (renders from Overrides + fit knobs; no manifest preset) ─────

def test_compose_flags_sets_ngl_and_moe(tmp_path):
    flags = compose_flags(
        tmp_path / "model.gguf", n_gpu_layers=20, n_cpu_moe=4, ctx_len=4096, port=9999,
    )
    assert flags.count("-ngl") == 1
    assert flags[flags.index("-ngl") + 1] == "20"
    assert flags[flags.index("--n-cpu-moe") + 1] == "4"
    assert flags[flags.index("-m") + 1].endswith("model.gguf")
    assert flags[flags.index("--port") + 1] == "9999"
    assert flags[flags.index("--ctx-size") + 1] == "4096"


def test_compose_flags_omits_moe_when_zero(tmp_path):
    flags = compose_flags(tmp_path / "m.gguf", n_gpu_layers=0, n_cpu_moe=0, ctx_len=2048)
    assert "--n-cpu-moe" not in flags  # omitted when 0
    assert flags[flags.index("-ngl") + 1] == "0"


def test_compose_flags_base_preset_via_overrides(tmp_path):
    # The DB `base` preset reaches the spawn as Overrides → rendered onto empty.
    flags = compose_flags(
        tmp_path / "m.gguf", n_gpu_layers=10, n_cpu_moe=0, ctx_len=2048,
        overrides=Overrides(cache_type_k="q8_0", cache_type_v="q8_0", flash_attn="on",
                            mlock=True, threads=8, batch_size=1024),
    )
    assert flags.count("--cache-type-k") == 1
    assert flags[flags.index("--cache-type-k") + 1] == "q8_0"
    assert flags[flags.index("--cache-type-v") + 1] == "q8_0"
    assert flags[flags.index("--flash-attn") + 1] == "on"
    assert "--mlock" in flags
    assert flags[flags.index("--threads") + 1] == "8"
    assert flags[flags.index("--batch-size") + 1] == "1024"


def test_compose_flags_presence_overrides(tmp_path):
    # Presence flags add/remove cleanly (no value-eating).
    flags = compose_flags(
        tmp_path / "m.gguf", n_gpu_layers=10, n_cpu_moe=0, ctx_len=2048,
        overrides=Overrides(mlock=False, no_mmap=True, no_kv_offload=True, cont_batching=False),
    )
    assert "--mlock" not in flags          # mlock=False → not present
    assert "--no-mmap" in flags            # added
    assert "--no-kv-offload" in flags      # added
    assert "--no-cont-batching" in flags   # cont-batching disabled
    assert flags[flags.index("-ngl") + 1] == "10"


def test_compose_flags_spec_draft_mtp(tmp_path):
    # A user's MTP opt-in arrives as Overrides(spec_type=draft-mtp) for MTP models (Phase 3).
    flags = compose_flags(
        tmp_path / "m.gguf", n_gpu_layers=10, n_cpu_moe=0, ctx_len=2048,
        overrides=Overrides(spec_type="draft-mtp", spec_n_max=3),
    )
    assert flags[flags.index("--spec-type") + 1] == "draft-mtp"
    assert flags[flags.index("--spec-draft-n-max") + 1] == "3"


def test_compose_flags_spec_none_clears(tmp_path):
    # spec_type="none" (the MoE preset) emits no spec flags.
    flags = compose_flags(
        tmp_path / "m.gguf", n_gpu_layers=10, n_cpu_moe=0, ctx_len=2048,
        overrides=Overrides(spec_type="none"),
    )
    assert "--spec-type" not in flags
    assert "--spec-draft-n-max" not in flags


def test_compose_flags_spec_ngram(tmp_path):
    flags = compose_flags(
        tmp_path / "m.gguf", n_gpu_layers=10, n_cpu_moe=0, ctx_len=2048,
        overrides=Overrides(spec_type="ngram-mod", spec_n_max=64),
    )
    assert flags[flags.index("--spec-type") + 1] == "ngram-mod"
    assert flags[flags.index("--spec-ngram-mod-n-max") + 1] == "64"


def test_switches_to_overrides_routes_unknown_to_extra_flags():
    # Known keys → typed Overrides fields; any other key → a raw passthrough flag
    # in extra_flags (the "new llama.cpp flag, no code" escape the KnobGrid uses).
    from llm_runner.runner.lifecycle import _switches_to_overrides

    ov = _switches_to_overrides({
        "n_cpu_moe": "8",          # known → typed int field
        "flash_attn": "on",        # known → typed value field
        "--top-n-sigma": "0.05",   # unknown → raw flag + value
        "--some-bool-flag": "",    # unknown valueless → just the flag token
    })
    assert ov.n_cpu_moe == 8
    assert ov.flash_attn == "on"
    assert ov.extra_flags == ["--top-n-sigma", "0.05", "--some-bool-flag"]


def test_compose_flags_extra_flags_passthrough(tmp_path):
    # extra_flags reach the spawned argv verbatim (after the typed overrides).
    flags = compose_flags(
        tmp_path / "m.gguf", n_gpu_layers=10, n_cpu_moe=0, ctx_len=2048,
        overrides=Overrides(extra_flags=["--top-n-sigma", "0.05"]),
    )
    assert flags[flags.index("--top-n-sigma") + 1] == "0.05"


# ── start_runner (probe + OOM back-off; subprocess injected) ───────────────────

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


def _fit():
    return FitPlan(n_gpu_layers=20, n_cpu_moe=0, ctx_len=4096, block_count=48, is_moe=True)


def test_start_runner_healthy_first_try():
    fit = _fit()
    spawned = []

    def popen(argv, **k):
        spawned.append(argv)
        return _FakeProc(exit_code=None)  # alive

    r = start_runner(
        "llama-server", "m.gguf", fit,
        _popen=popen, _health=lambda u: True, _sleep=lambda s: None,
    )
    assert isinstance(r, Runner) and r.is_alive()
    assert r.n_gpu_layers == 20
    assert len(spawned) == 1


def test_start_runner_backs_off_on_oom():
    fit = _fit()
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
        "llama-server", "m.gguf", fit, backoff_step=4,
        _popen=popen, _health=lambda u: state["n"] >= 2, _sleep=lambda s: None,
    )
    assert state["n"] == 2          # spawned twice
    assert r.n_gpu_layers == 16     # 20 − 4
    assert r.n_cpu_moe == fit.block_count - 16  # MoE offload recomputed on back-off
    assert procs[0].killed          # first attempt cleaned up


def test_start_runner_raises_on_non_oom():
    fit = _fit()

    def popen(argv, **k):
        return _FakeProc(exit_code=1, output="fatal: model file not found")

    with pytest.raises(RunnerStartError):
        start_runner(
            "llama-server", "m.gguf", fit,
            _popen=popen, _health=lambda u: False, _sleep=lambda s: None,
        )


# ── spawn diagnostics (log file + exit code + tail) ────────────────────────────

def test_tail_file_returns_last_lines(tmp_path):
    p = tmp_path / "runner.log"
    p.write_text("\n".join(f"line {i}" for i in range(100)))
    assert _tail_file(p, max_lines=3).splitlines() == ["line 97", "line 98", "line 99"]
    assert _tail_file(tmp_path / "nope.log") == ""  # missing → empty, not a crash


def test_start_runner_error_reports_exit_code():
    # A self-exited llama-server (e.g. a missing DLL on Windows) surfaces its exit
    # code + captured output, not a bare "failed".
    def popen(argv, **k):
        return _FakeProc(exit_code=3221225781, output="error while loading shared libraries")

    with pytest.raises(RunnerStartError) as ei:
        start_runner("llama-server", "m.gguf", _fit(),
                     _popen=popen, _health=lambda u: False, _sleep=lambda s: None)
    msg = str(ei.value)
    assert "exit 3221225781" in msg
    assert "error while loading shared libraries" in msg


def test_start_runner_hang_reports_still_running():
    # A hang (never healthy, never exits) reports "still running" — the case the
    # old empty-tail message could not distinguish from a crash.
    times = iter([0.0, 0.0, 1000.0])  # deadline calc, first check, then past deadline

    def popen(argv, **k):
        return _FakeProc(exit_code=None, output="")  # alive the whole time

    with pytest.raises(RunnerStartError) as ei:
        start_runner("llama-server", "m.gguf", _fit(),
                     _popen=popen, _health=lambda u: False, _sleep=lambda s: None,
                     _now=lambda: next(times))
    assert "still running" in str(ei.value)


def test_start_runner_redirects_to_log_and_cites_path(tmp_path):
    # With log_path set, output is redirected to that file and the failure cites
    # the log path so the user can open it.
    log_path = tmp_path / "logs" / "runner.log"

    def popen(argv, **k):
        assert "stdout" in k  # redirected to the file, not a pipe we drain
        return _FakeProc(exit_code=1, output="")

    with pytest.raises(RunnerStartError) as ei:
        start_runner("llama-server", "m.gguf", _fit(), log_path=log_path,
                     _popen=popen, _health=lambda u: False, _sleep=lambda s: None)
    assert f"[log: {log_path}]" in str(ei.value)
    assert log_path.exists()  # start_runner created the dir + opened the file


def test_start_runner_backs_off_on_oom_via_log(tmp_path):
    # On the file-redirect path (the one _run_load actually uses), the OOM signal
    # is read from the LOG-FILE tail, not a pipe. First attempt writes an OOM line
    # into the redirected log → back-off → second attempt healthy.
    log_path = tmp_path / "logs" / "runner.log"
    procs = [_FakeProc(exit_code=1), _FakeProc(exit_code=None)]  # OOM exit, then alive
    state = {"n": 0}

    def popen(argv, **k):
        if state["n"] == 0:
            k["stdout"].write(b"ggml_cuda: CUDA error: out of memory")  # into the log file
            k["stdout"].flush()
        p = procs[state["n"]]
        state["n"] += 1
        return p

    r = start_runner("llama-server", "m.gguf", _fit(), backoff_step=4, log_path=log_path,
                     _popen=popen, _health=lambda u: state["n"] >= 2, _sleep=lambda s: None)
    assert state["n"] == 2           # spawned twice: the log-tail OOM drove the retry
    assert r.n_gpu_layers == 16      # 20 − 4
