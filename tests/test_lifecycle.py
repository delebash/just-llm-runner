# SPDX-License-Identifier: GPL-3.0-or-later
"""RunnerService state machine — the download/spawn IO is injected so the
orchestration (status transitions, error handling) tests offline. The real
manifest + compute_fit run unmocked."""

from types import SimpleNamespace

from llm_runner.lifecycle import RunnerService
from llm_runner.manifest import load_manifest


def _fake_runner(url="http://127.0.0.1:8080"):
    return SimpleNamespace(url=url, is_alive=lambda: True, stop=lambda: None)


def _service_for(tmp_path, *, start=None, gguf_quant=None):
    man = load_manifest()
    quant = gguf_quant or man.models[0].quant
    snap = tmp_path / "snap"
    snap.mkdir()
    (snap / f"model-{quant}.gguf").write_bytes(b"x" * 1024)
    return RunnerService(
        tmp_path,
        acquire_binary=lambda *a, **k: tmp_path / "llama-server",
        acquire_model=lambda *a, **k: snap,
        read_meta=lambda p: SimpleNamespace(block_count=24, embedding_length=2048, is_moe=False),
        start=start or (lambda *a, **k: _fake_runner()),
    )


def test_load_reaches_running(tmp_path):
    svc = _service_for(tmp_path)
    model_id = load_manifest().models[0].id
    svc.load(model_id)
    svc._thread.join(timeout=5)
    st = svc.status()
    assert st["status"] == "running"
    assert st["url"] == "http://127.0.0.1:8080"
    assert st["modelId"] == model_id


def test_unknown_model_errors(tmp_path):
    svc = _service_for(tmp_path)
    svc.load("does-not-exist")
    svc._thread.join(timeout=5)
    st = svc.status()
    assert st["status"] == "error"
    assert "unknown model" in st["error"]


def test_start_failure_surfaces_as_error(tmp_path):
    def boom(*a, **k):
        raise RuntimeError("llama-server failed to become healthy")

    svc = _service_for(tmp_path, start=boom)
    svc.load(load_manifest().models[0].id)
    svc._thread.join(timeout=5)
    assert svc.status()["status"] == "error"


def test_stop_returns_to_idle(tmp_path):
    svc = _service_for(tmp_path)
    svc.load(load_manifest().models[0].id)
    svc._thread.join(timeout=5)
    assert svc.status()["status"] == "running"
    assert svc.stop()["status"] == "idle"


def test_dead_process_flips_to_error(tmp_path):
    dead = SimpleNamespace(url="http://127.0.0.1:8080", is_alive=lambda: False, stop=lambda: None)
    svc = _service_for(tmp_path, start=lambda *a, **k: dead)
    svc.load(load_manifest().models[0].id)
    svc._thread.join(timeout=5)
    # _run_load set running; next status() sees the process is dead.
    assert svc.status()["status"] == "error"
