# SPDX-License-Identifier: GPL-3.0-or-later
"""RunnerService state machine (ROUTER mode) — the download + router IO is injected
so the orchestration (status transitions, DB→.ini emission, co-residence, OOM
back-off, error handling) tests offline. The real default RunnerConfig + compute_fit
run unmocked; a fake HF cache lets `cached_gguf_path` resolve on-disk models faithfully."""

import threading
from pathlib import Path
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
                 router_unload=None, router_models=None, now=None, sleep=None,
                 identify_fn=None, switches_fn=None, profile_switches_fn=None):
    """A RunnerService with the router + download IO injected. Every catalog model is
    seeded into a fake HF cache (`<root>/hf/models--<repo>/snapshots/sha/<file>.gguf`)
    so both `cached_gguf_path` (the .ini emitter) and the injected `acquire_model`
    resolve the SAME on-disk path — faithful to production.

    The default injected `router_models` reports EVERY catalog model as `loaded`, so a
    load's confirmation poll (`_confirm_load`, P1f) resolves on the first GET /models and
    the load reaches `running` without touching a real socket. A test that needs a
    `loading` / `failed` / timeout path injects its own `router_models` (+ `now`/`sleep`
    to drive the clock deterministically)."""
    models = list(catalog or [_TEST_MODEL])
    snaps = {}
    for m in models:
        d = tmp_path / "hf" / ("models--" + m.hf_repo.replace("/", "--")) / "snapshots" / "sha"
        d.mkdir(parents=True, exist_ok=True)
        (d / f"model-{m.quant}.gguf").write_bytes(b"x" * 1024)
        snaps[m.hf_repo] = d

    def _all_loaded(url):
        return {"object": "list", "data": [{"id": m.id, "status": {"value": "loaded"}} for m in models]}

    kw = {}
    if identify_fn is not None:
        kw["identify_fn"] = identify_fn
    if switches_fn is not None:
        kw["switches_fn"] = switches_fn
    if profile_switches_fn is not None:
        kw["profile_switches_fn"] = profile_switches_fn
    if now is not None:
        kw["now"] = now
    if sleep is not None:
        kw["sleep"] = sleep
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
        router_models=router_models or _all_loaded,
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
    # POST /models/load is ASYNC (b9644) — the OOM back-off keys off the child's GET /models
    # status, NOT an HTTP raise, AND only fires when the spawn log looks like CUDA-OOM. A child
    # that reports `failed` on a too-high ngl (+ an OOM log) → re-emit that section at a lower
    # ngl + reload, mirroring start_runner's shed. Force ngl>0.
    posts = {"n": 0}

    def count_load(url, mid):
        posts["n"] += 1  # each POST /models/load (async accept)

    def failed_until_third(url):
        # The confirm poll reads this AFTER the POST bumps the counter: fail loads #1 and #2
        # (→ shed 20→16→12), then report loaded on #3.
        value = "loaded" if posts["n"] >= 3 else "failed"
        return {"object": "list", "data": [{"id": _TEST_MODEL.id, "status": {"value": value}}]}

    def oom_router(*a, **k):
        # The shed only fires on an OOM-looking spawn log — write one to the log the service
        # tails. _spawn_router passes the per-spawn log_path here (a fresh one per bounce).
        lp = k.get("log_path")
        if lp:
            Path(lp).parent.mkdir(parents=True, exist_ok=True)
            Path(lp).write_text("CUDA error: out of memory")
        return _fake_router()

    svc = _service_for(tmp_path, start_router=oom_router,
                       router_load=count_load, router_models=failed_until_third)
    svc.load(_TEST_MODEL.id, overrides=Overrides(n_gpu_layers=20))
    svc._thread.join(timeout=5)
    assert svc.status()["status"] == "running"
    assert posts["n"] == 3                      # POSTed 3× (failed twice → shed twice, third loads)
    assert "n-gpu-layers = 12" in _ini(svc)     # 20 → 16 → 12 (step 4)


def test_non_oom_failure_does_not_shed_or_bounce(tmp_path):
    # A `failed` with NO OOM in the spawn log (a bad flag / corrupt GGUF) must fail FAST:
    # shedding can't fix it and a bounce would knock down healthy co-resident models. So the
    # router spawns exactly once (no bounce), ngl is NOT shed, and the load ends in error.
    spawns = {"n": 0}

    def count_spawn(*a, **k):
        spawns["n"] += 1
        return _fake_router()  # NO oom log written → _looks_like_oom(tail) is False

    def always_failed(url):
        return {"object": "list", "data": [{"id": _TEST_MODEL.id, "status": {"value": "failed"}}]}

    svc = _service_for(tmp_path, start_router=count_spawn, router_models=always_failed)
    svc.load(_TEST_MODEL.id, overrides=Overrides(n_gpu_layers=20))  # ngl>0, but no OOM signal
    svc._thread.join(timeout=5)
    assert svc.status()["status"] == "error"
    assert spawns["n"] == 1                      # spawned once, NO bounce on a non-OOM failure
    assert "n-gpu-layers = 20" in _ini(svc)      # ngl NOT shed (stays 20)


def test_router_sync_reject_errors_without_shed(tmp_path):
    # A SYNCHRONOUS 4xx from POST /models/load (unknown id / at models-max) is a real reject,
    # NOT an OOM — the raise propagates as a load error with no shed/bounce, even at ngl>0.
    spawns = {"n": 0}

    def count_spawn(*a, **k):
        spawns["n"] += 1
        return _fake_router()

    def reject_load(url, mid):
        raise RuntimeError("/models/load failed [400]: at capacity")

    svc = _service_for(tmp_path, start_router=count_spawn, router_load=reject_load)
    svc.load(_TEST_MODEL.id, overrides=Overrides(n_gpu_layers=20))
    svc._thread.join(timeout=5)
    st = svc.status()
    assert st["status"] == "error"
    assert "at capacity" in st["error"]         # the 4xx body propagates verbatim
    assert spawns["n"] == 1                      # no bounce/re-spawn on a sync reject


# ── P1f: async load-confirmation poll (POST accepts; GET /models confirms) ────

def test_parse_router_models_reads_nested_status():
    # Box-verified b9644: status is NESTED at data[].status.value (not flat); meta only on a
    # loaded child; a flat-string status is tolerated; an id-less entry is skipped.
    from llm_runner.runner.lifecycle import _parse_router_models

    payload = {"object": "list", "data": [
        {"id": "chat", "status": {"value": "loaded", "args": [], "preset": "..."},
         "meta": {"n_params": 7, "size": 9, "n_ctx": 4096}},
        {"id": "embed", "status": {"value": "unloaded"}},
        {"id": "flat", "status": "loading"},          # a hypothetical flat-string build
        {"status": {"value": "x"}},                    # no id → dropped
    ]}
    out = _parse_router_models(payload)
    assert out["chat"]["value"] == "loaded"
    assert out["chat"]["meta"]["n_params"] == 7
    assert out["embed"]["value"] == "unloaded"
    assert "meta" not in out["embed"]                  # unloaded → no meta block
    assert out["flat"]["value"] == "loading"           # flat string tolerated
    assert len(out) == 3                               # the id-less entry dropped


def test_load_polls_until_loaded(tmp_path):
    # The POST only ACCEPTS (async); the model reaches 'running' ONLY after GET /models
    # confirms status.value == 'loaded'. Poll through two 'loading' reads first.
    seq = ["loading", "loading", "loaded"]
    idx = {"i": 0}

    def models(url):
        i = min(idx["i"], len(seq) - 1)
        idx["i"] += 1
        return {"object": "list", "data": [{"id": _TEST_MODEL.id, "status": {"value": seq[i]}}]}

    sleeps = {"n": 0}
    svc = _service_for(tmp_path, router_models=models,
                       sleep=lambda s: sleeps.__setitem__("n", sleeps["n"] + 1))
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    assert svc.status()["status"] == "running"
    assert sleeps["n"] >= 2                     # slept between the two 'loading' polls


def test_load_errors_on_failed_status(tmp_path):
    # A child that reports 'failed' with no GPU layers left to shed (ngl 0) → immediate
    # error, no back-off. Proves the error path keys off status, not an HTTP raise.
    def failed(url):
        return {"object": "list", "data": [{"id": _TEST_MODEL.id, "status": {"value": "failed"}}]}

    svc = _service_for(tmp_path, router_models=failed)
    svc.load(_TEST_MODEL.id, overrides=Overrides(n_gpu_layers=0))
    svc._thread.join(timeout=5)
    st = svc.status()
    assert st["status"] == "error"
    assert "failed to load" in st["error"]


def test_confirm_load_times_out(tmp_path):
    # A child stuck 'loading' past the deadline → timeout → error (ngl 0 → no back-off).
    # An injected fast clock blows past the 300s deadline in a few reads; sleep is a no-op.
    def always_loading(url):
        return {"object": "list", "data": [{"id": _TEST_MODEL.id, "status": {"value": "loading"}}]}

    clock = {"t": 0.0}

    def fast_clock():
        clock["t"] += 120.0
        return clock["t"]

    svc = _service_for(tmp_path, router_models=always_loading, now=fast_clock, sleep=lambda s: None)
    svc.load(_TEST_MODEL.id, overrides=Overrides(n_gpu_layers=0))
    svc._thread.join(timeout=5)
    st = svc.status()
    assert st["status"] == "error"
    assert "status=timeout" in st["error"]


# ── P1f: resident set (live GET /models view for /v1/llm-runner/resident) ─────

def test_resident_reports_live_set(tmp_path):
    # /resident reads the router's live GET /models incl. the meta footprint of a loaded child.
    def models(url):
        return {"object": "list", "data": [{
            "id": _TEST_MODEL.id, "status": {"value": "loaded"},
            "meta": {"n_params": 35_000_000_000, "size": 22_000_000_000, "n_ctx": 4096},
        }]}

    svc = _service_for(tmp_path, router_models=models)
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    res = svc.resident()
    assert res["router"] is True
    assert res["models_max"] == 2 and res["sleep_idle_seconds"] == 900
    row = next(m for m in res["models"] if m["id"] == _TEST_MODEL.id)
    assert row["status"] == "loaded"
    assert row["n_params"] == 35_000_000_000
    assert row["size_bytes"] == 22_000_000_000
    assert row["n_ctx"] == 4096


def test_resident_router_down_is_empty(tmp_path):
    svc = _service_for(tmp_path)  # never loaded → no router
    res = svc.resident()
    assert res["router"] is False
    assert res["models"] == []
    assert res["models_max"] == 2


def test_resident_shows_in_flight_download(tmp_path):
    # A load still mid-download (not yet a router section) is surfaced as 'downloading' so the
    # UI shows progress before the child appears in GET /models. Router down → in-flight only.
    svc = _service_for(tmp_path)
    svc._resident[_TEST_MODEL.id] = {"status": "downloading", "modelId": _TEST_MODEL.id}
    res = svc.resident()
    row = next(m for m in res["models"] if m["id"] == _TEST_MODEL.id)
    assert row["status"] == "downloading"


def test_resident_surfaces_load_error(tmp_path):
    # A load that ERRORED before the router spawned (engine-not-installed) must still surface as
    # 'error' via resident() — the router's GET /models can never report it (no router), so the
    # in-flight overlay carries it, else the catalog would show it as available and the UI would
    # lose the failure + the install-engine CTA.
    svc = _service_for(tmp_path)
    svc._acquired_exe = lambda *a, **k: None  # engine missing → _run_load errors, no router spawns
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    assert svc.status()["status"] == "error"
    res = svc.resident()
    assert res["router"] is False
    row = next(m for m in res["models"] if m["id"] == _TEST_MODEL.id)
    assert row["status"] == "error"


def test_stop_during_confirm_poll_is_clean(tmp_path):
    # A stop() issued while a load is in its confirm poll (holding _router_lock) serializes
    # behind the load, then unloads — no ghost, no leak. Deterministic via a gate on the poll.
    entered = threading.Event()
    gate = threading.Event()
    unloaded = []

    def gated_models(url):
        entered.set()          # signal: the load thread is now in the confirm poll (holds the lock)
        gate.wait(timeout=5)   # ...hold it there until the test releases
        return {"object": "list", "data": [{"id": _TEST_MODEL.id, "status": {"value": "loaded"}}]}

    svc = _service_for(tmp_path, router_models=gated_models,
                       router_unload=lambda url, mid: unloaded.append(mid))
    svc.load(_TEST_MODEL.id)
    assert entered.wait(timeout=5)                       # load is mid-poll, holding _router_lock
    stopper = threading.Thread(target=lambda: svc.stop(_TEST_MODEL.id))
    stopper.start()                                      # stop() blocks on _router_lock
    gate.set()                                           # release the poll → load finishes → lock frees
    svc._thread.join(timeout=5)
    stopper.join(timeout=5)
    assert unloaded == [_TEST_MODEL.id]                  # stop unloaded it once the load completed
    assert _TEST_MODEL.id not in svc._resident           # clean: no ghost resident entry


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
