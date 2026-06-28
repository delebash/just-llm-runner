# SPDX-License-Identifier: GPL-3.0-or-later
"""RunnerService state machine — the download/spawn IO is injected so the
orchestration (status transitions, error handling) tests offline. The real
default RunnerConfig + compute_fit run unmocked."""

from types import SimpleNamespace

from llm_runner.runner.lifecycle import RunnerService
from llm_runner.runner.schema import ModelEntry

# Catalog lives in the host DB now (there is no runner manifest); tests feed in
# their own test models via the `catalog_fn` injection.
_TEST_MODEL = ModelEntry(id="test-model", name="Test", tier="mid", hf_repo="org/test-GGUF", quant="Q4_K_M")


def _fake_runner(url="http://127.0.0.1:8080"):
    return SimpleNamespace(url=url, is_alive=lambda: True, stop=lambda: None)


def _service_for(tmp_path, *, start=None, gguf_quant=None, identify_fn=None,
                 switches_fn=None, profile_switches_fn=None):
    quant = gguf_quant or _TEST_MODEL.quant
    snap = tmp_path / "snap"
    snap.mkdir()
    (snap / f"model-{quant}.gguf").write_bytes(b"x" * 1024)
    kw = {}
    if identify_fn is not None:
        kw["identify_fn"] = identify_fn
    if switches_fn is not None:
        kw["switches_fn"] = switches_fn
    if profile_switches_fn is not None:
        kw["profile_switches_fn"] = profile_switches_fn
    return RunnerService(
        tmp_path,
        catalog_fn=lambda: [_TEST_MODEL],
        acquire_binary=lambda *a, **k: tmp_path / "llama-server",
        acquire_model=lambda *a, **k: snap,
        read_meta=lambda p: SimpleNamespace(block_count=24, embedding_length=2048, is_moe=False, n_kv_heads=8),
        start=start or (lambda *a, **k: _fake_runner()),
        **kw,
    )


def test_load_reaches_running(tmp_path):
    svc = _service_for(tmp_path)
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    st = svc.status()
    assert st["status"] == "running"
    assert st["url"] == "http://127.0.0.1:8080"
    assert st["modelId"] == _TEST_MODEL.id


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
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    assert svc.status()["status"] == "error"


def test_stop_returns_to_idle(tmp_path):
    svc = _service_for(tmp_path)
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    assert svc.status()["status"] == "running"
    assert svc.stop()["status"] == "idle"


def test_load_calls_identify_fn(tmp_path):
    # After download, the runner auto-detects the catalog type via identify_fn.
    seen = []
    svc = _service_for(tmp_path, identify_fn=lambda mid, path: seen.append(mid))
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    assert svc.status()["status"] == "running"
    assert seen == [_TEST_MODEL.id]


def test_load_applies_profile_switches_for_job(tmp_path):
    # D9 load-reader: with a job_id, the Profile's frozen switches REPLACE the
    # model-level base (the Profile wins wholesale).
    captured = {}

    def fake_start(*a, **k):
        captured["ov"] = k.get("overrides")
        return _fake_runner()

    svc = _service_for(
        tmp_path, start=fake_start,
        switches_fn=lambda mid: {"ctx_len": "4096"},           # model base
        profile_switches_fn=lambda jid: {"ctx_len": "32768"},  # the Profile wins
    )
    svc.load(_TEST_MODEL.id, job_id="analysis")
    svc._thread.join(timeout=5)
    assert svc.status()["status"] == "running"
    assert captured["ov"].ctx_len == 32768


def test_load_uses_model_base_without_job(tmp_path):
    # No job_id → the model-level switches apply (profile reader untouched).
    captured = {}

    def fake_start(*a, **k):
        captured["ov"] = k.get("overrides")
        return _fake_runner()

    svc = _service_for(
        tmp_path, start=fake_start,
        switches_fn=lambda mid: {"ctx_len": "4096"},
        profile_switches_fn=lambda jid: {"ctx_len": "32768"},
    )
    svc.load(_TEST_MODEL.id)  # no job_id
    svc._thread.join(timeout=5)
    assert captured["ov"].ctx_len == 4096


def test_load_survives_identify_failure(tmp_path):
    # Type auto-detect is advisory — a failure must NOT fail the load.
    def boom(mid, path):
        raise RuntimeError("gguf unreadable")

    svc = _service_for(tmp_path, identify_fn=boom)
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    assert svc.status()["status"] == "running"


def test_dead_process_flips_to_error(tmp_path):
    dead = SimpleNamespace(url="http://127.0.0.1:8080", is_alive=lambda: False, stop=lambda: None)
    svc = _service_for(tmp_path, start=lambda *a, **k: dead)
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    # _run_load set running; next status() sees the process is dead.
    assert svc.status()["status"] == "error"
