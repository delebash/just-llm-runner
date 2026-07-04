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
        acquired_exe=lambda *a, **k: tmp_path / "llama-server",
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
    # Legacy job_id override hook (unused by JustWrite): a profile_switches_fn
    # result REPLACES the model-level base wholesale.
    captured = {}

    def fake_start(*a, **k):
        captured["ov"] = k.get("overrides")
        return _fake_runner()

    svc = _service_for(
        tmp_path, start=fake_start,
        switches_fn=lambda mid: {"ctx_len": "4096"},           # model base
        profile_switches_fn=lambda jid: {"ctx_len": "32768"},  # the override hook wins
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


def test_load_applies_adhoc_switches(tmp_path):
    # #20 "Tune & measure": ad-hoc switches passed to load() win over the model
    # base, and an unknown key routes to extra_flags (same converter as stored
    # switches). No job_id → model base from switches_fn.
    captured = {}

    def fake_start(*a, **k):
        captured["ov"] = k.get("overrides")
        return _fake_runner()

    svc = _service_for(
        tmp_path, start=fake_start,
        switches_fn=lambda mid: {"ctx_len": "4096"},  # model base
    )
    svc.load(_TEST_MODEL.id, switches={"ctx_len": "16384", "--top-n-sigma": "2"})
    svc._thread.join(timeout=5)
    assert svc.status()["status"] == "running"
    assert captured["ov"].ctx_len == 16384                  # ad-hoc beats the base
    assert "--top-n-sigma" in captured["ov"].extra_flags    # unknown → passthrough
    assert "2" in captured["ov"].extra_flags


def test_load_survives_identify_failure(tmp_path):
    # Type auto-detect is advisory — a failure must NOT fail the load.
    def boom(mid, path):
        raise RuntimeError("gguf unreadable")

    svc = _service_for(tmp_path, identify_fn=boom)
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    assert svc.status()["status"] == "running"


def test_measure_probes_running_model(tmp_path):
    # #20 measure: probe the running model → tok/s + resource context (probe injected).
    svc = _service_for(tmp_path)
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    assert svc.status()["status"] == "running"
    out = svc.measure(
        probe=lambda url, p, n: (256, 2000.0),  # 256 tokens in 2.0s → 128 tok/s
        sample=lambda: {"vramTotalMb": 8000, "ramTotalMb": 32000},
    )
    assert out["ok"] is True
    assert out["tokensPerSec"] == 128.0
    assert out["completionTokens"] == 256
    assert out["vramTotalMb"] == 8000 and out["ramTotalMb"] == 32000


def test_measure_requires_running_model(tmp_path):
    svc = _service_for(tmp_path)  # never loaded → idle
    out = svc.measure(probe=lambda *a: (1, 1.0), sample=dict)
    assert out["ok"] is False and "no model running" in out["error"]


def test_tokenize_counts_via_running_model(tmp_path):
    # b1 prompt-preview: exact count via the running model's /tokenize (probe injected).
    svc = _service_for(tmp_path)
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    out = svc.tokenize(text="hello world", probe=lambda url, t: 7)
    assert out["ok"] is True and out["count"] == 7


def test_tokenize_requires_running_model(tmp_path):
    svc = _service_for(tmp_path)  # idle
    out = svc.tokenize(text="x", probe=lambda *a: 1)
    assert out["ok"] is False and "no model running" in out["error"]


def test_dead_process_flips_to_error(tmp_path):
    dead = SimpleNamespace(url="http://127.0.0.1:8080", is_alive=lambda: False, stop=lambda: None)
    svc = _service_for(tmp_path, start=lambda *a, **k: dead)
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    # _run_load set running; next status() sees the process is dead.
    assert svc.status()["status"] == "error"


# ── download-only (fetch weights, no spawn) — separate from load ───────────────

def test_download_only_fetches_no_spawn(tmp_path):
    # download() fetches the weights but does NOT spawn llama-server: status
    # returns to idle, no runner, and `start` is never called.
    started = {"hit": False}

    def spy_start(*a, **k):
        started["hit"] = True
        return _fake_runner()

    svc = _service_for(tmp_path, start=spy_start)
    svc.download(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    assert svc.status()["status"] == "idle"   # back to idle — nothing running
    assert svc._runner is None
    assert started["hit"] is False            # NO spawn


def test_download_needs_no_engine(tmp_path):
    # Unlike load(), download() does NOT require the engine installed — it only
    # fetches weights. No engine present → it still succeeds.
    svc = _service_for(tmp_path)
    svc._acquired_exe = lambda *a, **k: None  # engine not installed
    svc.download(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    st = svc.status()
    assert st["status"] == "idle"
    assert st["error"] == ""


def test_download_grounds_type_via_identify(tmp_path):
    # download() still grounds the catalog type from the file (like load).
    seen = []
    svc = _service_for(tmp_path, identify_fn=lambda mid, path: seen.append(mid))
    svc.download(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    assert svc.status()["status"] == "idle"
    assert seen == [_TEST_MODEL.id]


def test_download_unknown_model_errors(tmp_path):
    svc = _service_for(tmp_path)
    svc.download("does-not-exist")
    svc._thread.join(timeout=5)
    st = svc.status()
    assert st["status"] == "error"
    assert "unknown model" in st["error"]


# ── engine install as its own step, separate from a model load ─────────────────

def test_load_without_engine_errors(tmp_path):
    # A model load now REQUIRES the engine installed; it no longer silently
    # downloads it. No engine → a clear engine-not-installed error.
    svc = _service_for(tmp_path)
    svc._acquired_exe = lambda *a, **k: None  # engine not installed
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    st = svc.status()
    assert st["status"] == "error"
    assert st["error"] == "engine-not-installed"


def test_engine_status_reports_installed(tmp_path):
    svc = _service_for(tmp_path)  # acquired_exe stub returns a path → installed
    es = svc.engine_status()
    assert es["installed"] is True
    assert es["build"]  # the pinned llama.cpp release tag
    assert es["status"] == "idle"


def test_engine_status_not_installed(tmp_path):
    svc = _service_for(tmp_path)
    svc._acquired_exe = lambda *a, **k: None
    assert svc.engine_status()["installed"] is False


def test_install_engine_runs_acquire(tmp_path):
    called = {}

    def fake_acquire(*a, **k):
        called["hit"] = True
        return tmp_path / "llama-server"

    svc = _service_for(tmp_path)
    svc._acquire_binary = fake_acquire
    svc.install_engine()
    svc._engine_thread.join(timeout=5)
    assert called.get("hit") is True
    assert svc.engine_status()["status"] == "installed"


def test_engine_log_empty_then_tails(tmp_path):
    svc = _service_for(tmp_path)
    assert svc.engine_log() == {"path": "", "text": ""}
    p = tmp_path / "runner.log"
    p.write_text("a\nb\nc\n")
    svc._last_log_path = p
    out = svc.engine_log(tail=2)
    assert out["text"] == "b\nc"
    assert out["path"] == str(p)
