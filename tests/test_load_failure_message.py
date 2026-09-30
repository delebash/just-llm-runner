# SPDX-License-Identifier: MIT
"""What a failed model load tells the user (2026-09-29).

The case: `gemma-4-26b-a4b-qat` could not load its MTP draft even alone, and
the message opened "Most often the tune left too little VRAM for the draft —
raise n_cpu_moe". The real cause was 1.6 GB of GPU memory held by speech
engines a hard-killed JustVoice server had left running. The message now leads
with what is MEASURED — other processes holding GPU memory, then llama.cpp's own
error line — and lists the causes after, unranked.
"""

from __future__ import annotations

import pytest

from llm_runner.runner import lifecycle
from test_lifecycle import (
    _GEMMA_MTP,
    _draft_crash_loader,
    _fake_hw,
    _fake_router,
    _mtp_entry,
    _mtp_fit,
    _service_for,
)

_WHISPER_PAIR = [
    {"pid": 10, "name": "python.exe", "memMb": 1295, "own": False,
     "label": "python.exe · whisper/engine.py"},
    {"pid": 11, "name": "python.exe", "memMb": 286, "own": False,
     "label": "python.exe · whisper/engine.py"},
]


def _solo_crash_message(tmp_path, restarts=None) -> str:
    """Drive a draft that crashes solo (and after a restart, if one happens);
    return the error. `restarts` collects one entry per engine restart."""
    def models(_url):
        return {"object": "list", "data": [{"id": _GEMMA_MTP.id, "status": {"value": "failed"}}]}

    def start_router(*_a, **_k):
        if restarts is not None:
            restarts.append(1)
        return _fake_router()

    holder = {}
    svc = _service_for(tmp_path, catalog=[_GEMMA_MTP], router_models=models,
                       start_router=start_router,
                       router_load=_draft_crash_loader(holder),
                       hardware_fn=lambda: _fake_hw(8192), sleep=lambda s: None)
    holder["svc"] = svc
    svc._router = _fake_router()
    svc._active_server_exe = tmp_path / "llama-server"
    crash_log = tmp_path / "router.log"
    svc._last_log_path = crash_log
    svc._router_log_path = lambda: crash_log
    svc._resident[_GEMMA_MTP.id] = {"status": "starting"}
    with pytest.raises(RuntimeError) as ei:
        svc._router_load_with_backoff(_mtp_entry(), _mtp_fit(), tmp_path / "llama-server",
                                      svc.config())
    return str(ei.value)


def test_mtp_failure_names_the_other_gpu_holders_first(tmp_path, monkeypatch):
    monkeypatch.setattr(lifecycle, "_other_gpu_holders", lambda: _WHISPER_PAIR)
    msg = _solo_crash_message(tmp_path)

    assert ("Other programs are holding 1.5 GB of GPU memory: "
            "python.exe · whisper/engine.py (pid 10, 1.3 GB), "
            "python.exe · whisper/engine.py (pid 11, 286 MB). "
            "Close them, then load the model again.") in msg
    assert 'llama.cpp said: "error loading model: invalid vector subscript"' in msg
    # Measured facts first; the guesses after, and none of them ranked "most often".
    assert msg.index("Other programs") < msg.index("llama.cpp said") < msg.index("n_cpu_moe")
    assert "Most often" not in msg


def test_mtp_failure_with_nobody_else_on_the_gpu(tmp_path, monkeypatch):
    monkeypatch.setattr(lifecycle, "_other_gpu_holders", lambda: [])
    msg = _solo_crash_message(tmp_path)
    assert "Other programs" not in msg
    assert 'llama.cpp said: "error loading model: invalid vector subscript"' in msg
    assert "If nothing else is holding GPU memory" in msg


def test_a_failing_probe_never_breaks_the_message(tmp_path, monkeypatch):
    def _boom():
        raise OSError("typeperf missing")

    monkeypatch.setattr(lifecycle, "_other_gpu_holders", _boom)
    msg = _solo_crash_message(tmp_path)
    assert "speculative-decoding (MTP) draft" in msg
    assert "Other programs" not in msg


def test_holders_note_lists_four_and_counts_the_rest(monkeypatch):
    rows = [{"pid": i, "name": "x.exe", "memMb": 300, "own": False, "label": "x.exe"}
            for i in range(6)]
    monkeypatch.setattr(lifecycle, "_other_gpu_holders", lambda: rows)
    note = lifecycle._gpu_holders_note()
    assert note.startswith("Other programs are holding 1.8 GB of GPU memory: ")
    assert note.count("(pid ") == 4
    assert " and 2 more." in note


def test_holders_note_is_empty_when_unmeasurable(monkeypatch):
    monkeypatch.setattr(lifecycle, "_other_gpu_holders", lambda: None)
    assert lifecycle._gpu_holders_note() == ""


def test_engine_error_line_drops_the_log_prefix():
    tail = ("I llama_model_load: loading\n"
            "E llama_model_load: error loading model: invalid vector subscript\n"
            "E srv load_model: failed to load draft model, '/x/d.gguf'\n")
    assert lifecycle._engine_error_line(tail) == "error loading model: invalid vector subscript"
    assert lifecycle._engine_error_line("nothing useful here") == ""


# ── Before the restart, look (2026-09-30, kit TASKS: user "b go") ────────────
#
# With nothing else loaded, the only retry left was a full engine restart. When
# another program holds the memory — the 2026-09-29 cause — that can't help: the
# retry failed the same way and the restart only added time.


def test_other_programs_on_the_gpu_skip_the_restart(tmp_path, monkeypatch):
    monkeypatch.setattr(lifecycle, "_other_gpu_holders", lambda: _WHISPER_PAIR)
    restarts = []
    msg = _solo_crash_message(tmp_path, restarts)
    assert restarts == []
    assert "Other programs are holding 1.5 GB of GPU memory" in msg


def test_nobody_else_on_the_gpu_still_gets_the_one_restart(tmp_path, monkeypatch):
    monkeypatch.setattr(lifecycle, "_other_gpu_holders", lambda: [])
    restarts = []
    msg = _solo_crash_message(tmp_path, restarts)
    assert restarts == [1]
    assert "If nothing else is holding GPU memory" in msg


def test_when_the_gpu_cant_be_read_it_restarts_as_before(tmp_path, monkeypatch):
    def _boom():
        raise OSError("typeperf missing")

    monkeypatch.setattr(lifecycle, "_other_gpu_holders", _boom)
    restarts = []
    _solo_crash_message(tmp_path, restarts)
    assert restarts == [1]


def test_unmeasurable_is_not_a_holder(tmp_path, monkeypatch):
    monkeypatch.setattr(lifecycle, "_other_gpu_holders", lambda: None)
    restarts = []
    _solo_crash_message(tmp_path, restarts)
    assert restarts == [1]
