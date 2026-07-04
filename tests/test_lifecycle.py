# SPDX-License-Identifier: GPL-3.0-or-later
"""RunnerService state machine (ROUTER mode) — the download + router IO is injected
so the orchestration (status transitions, DB→.ini emission, co-residence, OOM
back-off, error handling) tests offline. The real default RunnerConfig + compute_fit
run unmocked; a fake HF cache lets `cached_gguf_path` resolve on-disk models faithfully."""

import threading
from types import SimpleNamespace

from llm_runner.runner.lifecycle import RunnerService
from llm_runner.runner.process import Overrides
from llm_runner.runner.schema import ModelEntry

# Catalog lives in the host DB now (there is no runner manifest); tests feed in
# their own test models via the `catalog_fn` injection.
_TEST_MODEL = ModelEntry(id="test-model", name="Test", tier="mid", hf_repo="org/test-GGUF", quant="Q4_K_M")
_MODEL_B = ModelEntry(id="model-b", name="B", tier="mid", hf_repo="org/b-GGUF", quant="Q4_K_M")


def _fake_router(url="http://127.0.0.1:8080", alive=True):
    return SimpleNamespace(url=url, is_alive=lambda: alive, stop=lambda: None)


def _service_for(tmp_path, *, catalog=None, start_router=None, router_load=None,
                 router_unload=None, identify_fn=None, switches_fn=None, profile_switches_fn=None):
    """A RunnerService with the router + download IO injected. Every catalog model is
    seeded into a fake HF cache (`<root>/hf/models--<repo>/snapshots/sha/<file>.gguf`)
    so both `cached_gguf_path` (the .ini emitter) and the injected `acquire_model`
    resolve the SAME on-disk path — faithful to production."""
    models = list(catalog or [_TEST_MODEL])
    snaps = {}
    for m in models:
        d = tmp_path / "hf" / ("models--" + m.hf_repo.replace("/", "--")) / "snapshots" / "sha"
        d.mkdir(parents=True, exist_ok=True)
        (d / f"model-{m.quant}.gguf").write_bytes(b"x" * 1024)
        snaps[m.hf_repo] = d
    kw = {}
    if identify_fn is not None:
        kw["identify_fn"] = identify_fn
    if switches_fn is not None:
        kw["switches_fn"] = switches_fn
    if profile_switches_fn is not None:
        kw["profile_switches_fn"] = profile_switches_fn
    return RunnerService(
        tmp_path,
        catalog_fn=lambda: models,
        acquire_binary=lambda *a, **k: tmp_path / "llama-server",
        acquired_exe=lambda *a, **k: tmp_path / "llama-server",
        acquire_model=lambda repo, *a, **k: snaps[repo],
        read_meta=lambda p: SimpleNamespace(block_count=24, embedding_length=2048, is_moe=False, n_kv_heads=8),
        start_router=start_router or (lambda *a, **k: _fake_router()),
        router_load=router_load or (lambda *a, **k: None),
        router_unload=router_unload or (lambda *a, **k: None),
        **kw,
    )


def _ini(svc) -> str:
    return (svc._cache_root / "llamacpp" / "models.ini").read_text()


# ── load → resident (router) ─────────────────────────────────────────────────

def test_load_reaches_running(tmp_path):
    svc = _service_for(tmp_path)
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    st = svc.status()
    assert st["status"] == "running"
    assert st["url"] == "http://127.0.0.1:8080"
    assert st["modelId"] == _TEST_MODEL.id


def test_load_emits_ini_section(tmp_path):
    # The DB→.ini last mile: the loaded model gets a [<id>] section pointing at its GGUF.
    svc = _service_for(tmp_path)
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    ini = _ini(svc)
    assert f"[{_TEST_MODEL.id}]" in ini
    assert "model = " in ini and "model-Q4_K_M.gguf" in ini


def test_unknown_model_errors(tmp_path):
    svc = _service_for(tmp_path)
    svc.load("does-not-exist")
    svc._thread.join(timeout=5)
    st = svc.status()
    assert st["status"] == "error"
    assert "unknown model" in st["error"]


def test_start_failure_surfaces_as_error(tmp_path):
    def boom(*a, **k):
        raise RuntimeError("llama-server router failed to become healthy")

    svc = _service_for(tmp_path, start_router=boom)
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    assert svc.status()["status"] == "error"


def test_load_without_engine_errors(tmp_path):
    # A model load REQUIRES the engine installed; no engine → a clear error, no spawn.
    svc = _service_for(tmp_path)
    svc._acquired_exe = lambda *a, **k: None
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    st = svc.status()
    assert st["status"] == "error"
    assert st["error"] == "engine-not-installed"


def test_load_calls_identify_fn(tmp_path):
    # After download, the runner auto-detects the catalog type via identify_fn.
    seen = []
    svc = _service_for(tmp_path, identify_fn=lambda mid, path: seen.append(mid))
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    assert svc.status()["status"] == "running"
    assert seen == [_TEST_MODEL.id]


def test_load_survives_identify_failure(tmp_path):
    # Type auto-detect is advisory — a failure must NOT fail the load.
    def boom(mid, path):
        raise RuntimeError("gguf unreadable")

    svc = _service_for(tmp_path, identify_fn=boom)
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    assert svc.status()["status"] == "running"


# ── switch resolution flows into the emitted .ini section ─────────────────────

def test_load_applies_profile_switches_for_job(tmp_path):
    # Legacy job_id override hook (unused by JustWrite): a profile_switches_fn result
    # REPLACES the model-level base wholesale — verified in the emitted .ini section.
    svc = _service_for(
        tmp_path,
        switches_fn=lambda mid: {"ctx_len": "4096"},           # model base
        profile_switches_fn=lambda jid: {"ctx_len": "32768"},  # the override hook wins
    )
    svc.load(_TEST_MODEL.id, job_id="analysis")
    svc._thread.join(timeout=5)
    assert svc.status()["status"] == "running"
    assert "ctx-size = 32768" in _ini(svc)


def test_load_uses_model_base_without_job(tmp_path):
    # No job_id → the model-level switches apply (profile reader untouched).
    svc = _service_for(
        tmp_path,
        switches_fn=lambda mid: {"ctx_len": "4096"},
        profile_switches_fn=lambda jid: {"ctx_len": "32768"},
    )
    svc.load(_TEST_MODEL.id)  # no job_id
    svc._thread.join(timeout=5)
    assert "ctx-size = 4096" in _ini(svc)


def test_load_applies_adhoc_switches(tmp_path):
    # #20 "Tune & measure" (Option A ephemeral section): ad-hoc switches passed to
    # load() win over the model base, and an unknown key routes to the .ini verbatim.
    svc = _service_for(tmp_path, switches_fn=lambda mid: {"ctx_len": "4096"})
    svc.load(_TEST_MODEL.id, switches={"ctx_len": "16384", "--top-n-sigma": "2"})
    svc._thread.join(timeout=5)
    ini = _ini(svc)
    assert "ctx-size = 16384" in ini            # ad-hoc beats the base
    assert "top-n-sigma = 2" in ini             # unknown → passthrough into the .ini


# ── co-residence + stop-by-id (the router keeps N models resident) ────────────

def test_two_models_co_resident(tmp_path):
    # Per-model in-flight guard: loading a DIFFERENT model proceeds. Both models'
    # sections are in the .ini (emitted for every on-disk model), so the second loads
    # by id with NO bounce — both end resident.
    loads = []
    svc = _service_for(tmp_path, catalog=[_TEST_MODEL, _MODEL_B],
                       router_load=lambda url, mid: loads.append(mid))
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    svc.load(_MODEL_B.id)
    svc._thread.join(timeout=5)
    assert svc._resident[_TEST_MODEL.id]["status"] == "running"
    assert svc._resident[_MODEL_B.id]["status"] == "running"
    ini = _ini(svc)
    assert f"[{_TEST_MODEL.id}]" in ini and f"[{_MODEL_B.id}]" in ini
    assert _TEST_MODEL.id in loads and _MODEL_B.id in loads


def test_stop_by_id_unloads_one(tmp_path):
    unloaded = []
    svc = _service_for(tmp_path, catalog=[_TEST_MODEL, _MODEL_B],
                       router_unload=lambda url, mid: unloaded.append(mid))
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    svc.load(_MODEL_B.id)
    svc._thread.join(timeout=5)
    svc.stop(_TEST_MODEL.id)
    assert unloaded == [_TEST_MODEL.id]
    assert _TEST_MODEL.id not in svc._resident
    assert svc._resident[_MODEL_B.id]["status"] == "running"
    assert svc._router is not None            # router stays up for the other model


def test_stop_all_tears_down_router(tmp_path):
    svc = _service_for(tmp_path)
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    assert svc.status()["status"] == "running"
    assert svc.stop()["status"] == "idle"     # full teardown → back-compat idle
    assert svc._router is None
    assert svc._resident == {}


def test_stop_during_load_leaves_no_ghost(tmp_path):
    # T1 race: a stop() while a load is mid-download must CANCEL the load — the thread
    # must not go on to spawn a router / load VRAM that status() would report as idle.
    entered = threading.Event()
    gate = threading.Event()
    spawns = {"n": 0}

    def spy_start(*a, **k):
        spawns["n"] += 1
        return _fake_router()

    svc = _service_for(tmp_path, start_router=spy_start)
    orig = svc._acquire_model

    def blocking_acquire(*a, **k):
        entered.set()          # signal: the load thread is now in the download
        gate.wait(timeout=5)   # ...and hold it there until the test releases
        return orig(*a, **k)

    svc._acquire_model = blocking_acquire
    svc.load(_TEST_MODEL.id)
    assert entered.wait(timeout=5)            # the load is blocked mid-download
    svc.stop()                               # cancel while mid-download
    assert svc.status()["status"] == "idle"
    gate.set()                               # release the download → the thread proceeds
    svc._thread.join(timeout=5)
    # It must have bailed at the cancellation re-check: no router spawned, no ghost.
    assert spawns["n"] == 0
    assert svc._router is None
    assert svc.status()["status"] == "idle"
    assert _TEST_MODEL.id not in svc._resident


# ── router-level OOM back-off (start_runner's shed doesn't run in router mode) ─

def test_router_load_oom_backoff(tmp_path):
    # A child that aborts on a too-high ngl → re-emit that section at a lower ngl +
    # reload, mirroring start_runner's shed. Force ngl>0 via an explicit override.
    calls = []

    def flaky_load(url, mid):
        calls.append(mid)
        if len(calls) < 3:
            raise RuntimeError("CUDA error: out of memory")

    svc = _service_for(tmp_path, router_load=flaky_load)
    svc.load(_TEST_MODEL.id, overrides=Overrides(n_gpu_layers=20))
    svc._thread.join(timeout=5)
    assert svc.status()["status"] == "running"
    assert len(calls) == 3                     # failed twice (shed twice), third succeeds
    assert "n-gpu-layers = 12" in _ini(svc)    # 20 → 16 → 12 (step 4)


# ── measure / tokenize (re-homed onto the router, routed by model id) ─────────

def test_measure_probes_running_model(tmp_path):
    svc = _service_for(tmp_path)
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    out = svc.measure(
        probe=lambda url, p, n, model_id="": (256, 2000.0),  # 256 tokens in 2.0s → 128 tok/s
        sample=lambda: {"vramTotalMb": 8000, "ramTotalMb": 32000},
    )
    assert out["ok"] is True
    assert out["tokensPerSec"] == 128.0
    assert out["completionTokens"] == 256
    assert out["modelId"] == _TEST_MODEL.id
    assert out["vramTotalMb"] == 8000 and out["ramTotalMb"] == 32000


def test_measure_passes_model_id(tmp_path):
    # Router mode: the probe body carries the model id so the router dispatches right.
    seen = {}

    def probe(url, p, n, model_id=""):
        seen["mid"] = model_id
        return (1, 1000.0)

    svc = _service_for(tmp_path)
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    svc.measure(probe=probe, sample=dict)
    assert seen["mid"] == _TEST_MODEL.id


def test_measure_requires_running_model(tmp_path):
    svc = _service_for(tmp_path)  # never loaded → idle
    out = svc.measure(probe=lambda *a, **k: (1, 1.0), sample=dict)
    assert out["ok"] is False and "no model running" in out["error"]


def test_tokenize_counts_via_running_model(tmp_path):
    svc = _service_for(tmp_path)
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    out = svc.tokenize(text="hello world", probe=lambda url, t, model_id="": 7)
    assert out["ok"] is True and out["count"] == 7


def test_tokenize_requires_running_model(tmp_path):
    svc = _service_for(tmp_path)  # idle
    out = svc.tokenize(text="x", probe=lambda *a, **k: 1)
    assert out["ok"] is False and "no model running" in out["error"]


def test_dead_router_flips_to_error(tmp_path):
    dead = SimpleNamespace(url="http://127.0.0.1:8080", is_alive=lambda: False, stop=lambda: None)
    svc = _service_for(tmp_path, start_router=lambda *a, **k: dead)
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    # _run_load set running; next status() sees the router process is dead.
    assert svc.status()["status"] == "error"


# ── download-only (fetch weights, no spawn) — its OWN channel, separate from load ─

def test_download_only_fetches_no_spawn(tmp_path):
    # download() fetches the weights but does NOT spawn the router: its channel returns
    # to idle, no router, and `start_router` is never called.
    started = {"hit": False}

    def spy_start(*a, **k):
        started["hit"] = True
        return _fake_router()

    svc = _service_for(tmp_path, start_router=spy_start)
    svc.download(_TEST_MODEL.id)
    svc._download_thread.join(timeout=5)
    assert svc.download_status()["status"] == "idle"   # download channel done
    assert svc.status()["status"] == "idle"            # run-state untouched
    assert svc._router is None
    assert started["hit"] is False                     # NO spawn


def test_download_does_not_clobber_running_model(tmp_path):
    # T1 regression: downloading while another model is resident must not touch the
    # run-state — the router + the loaded model stay up on their own channel.
    svc = _service_for(tmp_path)
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    assert svc.status()["status"] == "running"
    svc.download(_TEST_MODEL.id)
    svc._download_thread.join(timeout=5)
    assert svc.status()["status"] == "running"          # run-state UNTOUCHED
    assert svc._router is not None                      # router still up
    assert svc.download_status()["status"] == "idle"    # download finished separately


def test_download_needs_no_engine(tmp_path):
    # Unlike load(), download() does NOT require the engine installed.
    svc = _service_for(tmp_path)
    svc._acquired_exe = lambda *a, **k: None
    svc.download(_TEST_MODEL.id)
    svc._download_thread.join(timeout=5)
    ds = svc.download_status()
    assert ds["status"] == "idle"
    assert ds["error"] == ""


def test_download_grounds_type_via_identify(tmp_path):
    seen = []
    svc = _service_for(tmp_path, identify_fn=lambda mid, path: seen.append(mid))
    svc.download(_TEST_MODEL.id)
    svc._download_thread.join(timeout=5)
    assert svc.download_status()["status"] == "idle"
    assert seen == [_TEST_MODEL.id]


def test_download_unknown_model_errors(tmp_path):
    svc = _service_for(tmp_path)
    svc.download("does-not-exist")
    svc._download_thread.join(timeout=5)
    ds = svc.download_status()
    assert ds["status"] == "error"
    assert "unknown model" in ds["error"]


# ── engine install as its own step, separate from a model load ────────────────

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
