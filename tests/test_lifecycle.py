# SPDX-License-Identifier: GPL-3.0-or-later
"""RunnerService state machine (ROUTER mode) — the download + router IO is injected
so the orchestration (status transitions, DB→.ini emission, co-residence, OOM
back-off, error handling) tests offline. The real default RunnerConfig + compute_fit
run unmocked; a fake HF cache lets `cached_gguf_path` resolve on-disk models faithfully."""

import threading
from pathlib import Path
from types import SimpleNamespace

from llm_runner.runner.arbiter import VramArbiter
from llm_runner.runner.lifecycle import RunnerService
from llm_runner.runner.process import FitPlan, Overrides
from llm_runner.runner.schema import GpuInfo, HardwareInfo, ModelEntry


def _fake_hw(vram_mb):
    """A HardwareInfo with one GPU of `vram_mb` — for a deterministic arbiter VRAM budget."""
    return HardwareInfo(os="Linux", platform="linux", cpu_cores=8, ram_mb=32000,
                        gpus=[GpuInfo(vendor="nvidia", name="Test", vram_mb=vram_mb)])

# Catalog lives in the host DB now (there is no runner manifest); tests feed in
# their own test models via the `catalog_fn` injection.
_TEST_MODEL = ModelEntry(id="test-model", name="Test", tier="mid", hf_repo="org/test-GGUF", quant="Q4_K_M")
_MODEL_B = ModelEntry(id="model-b", name="B", tier="mid", hf_repo="org/b-GGUF", quant="Q4_K_M")


def _fake_router(url="http://127.0.0.1:8080", alive=True):
    return SimpleNamespace(url=url, is_alive=lambda: alive, stop=lambda: None)


def _service_for(tmp_path, *, catalog=None, start_router=None, router_load=None,
                 router_unload=None, router_models=None, now=None, sleep=None,
                 identify_fn=None, switches_fn=None, profile_switches_fn=None,
                 embedding_ids_fn=None, arbiter=None, acquired_exes=None,
                 used_vram_fn=None, hardware_fn=None):
    """A RunnerService with the router + download IO injected. Every catalog model is
    seeded into a fake HF cache (`<root>/hf/models--<repo>/snapshots/sha/<file>.gguf`)
    so both `cached_gguf_path` (the .ini emitter) and the injected `acquire_model`
    resolve the SAME on-disk path — faithful to production.

    The default injected `router_models` reports EVERY catalog model as `loaded`, so a
    load's confirmation poll (`_confirm_load`, P1f) resolves on the first GET /models and
    the load reaches `running` without touching a real socket. A test that needs a
    `loading` / `failed` / timeout path injects its own `router_models` (+ `now`/`sleep`
    to drive the clock deterministically).

    `used_vram_fn` defaults to `lambda: None` (unmeasurable) so the post-load VRAM
    true-up keeps the fit estimate — deterministic reservations regardless of the
    box the suite runs on (the REAL probe would read this machine's live nvidia-smi
    and make exact `reserved_mb` assertions flaky). A test exercising the true-up
    injects its own reading sequence."""
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
    if hardware_fn is not None:
        kw["hardware_fn"] = hardware_fn
    if acquired_exes is not None:
        kw["acquired_exes"] = acquired_exes
    if identify_fn is not None:
        kw["identify_fn"] = identify_fn
    if switches_fn is not None:
        kw["switches_fn"] = switches_fn
    if profile_switches_fn is not None:
        kw["profile_switches_fn"] = profile_switches_fn
    if embedding_ids_fn is not None:
        kw["embedding_ids_fn"] = embedding_ids_fn
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
        used_vram_fn=used_vram_fn or (lambda: None),
        # A FRESH arbiter per service isolates each test's ledger (the default is the shared
        # process singleton, which would leak reservations between tests).
        arbiter=arbiter if arbiter is not None else VramArbiter(),
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


def test_reserve_trues_up_with_measured_vram_delta(tmp_path):
    # Measure-don't-assume (2026-07-06): a CPU-only fit (no GPU → n_gpu_layers 0) books a
    # 0 MB estimate, but a CUDA-build child still holds real VRAM (driver context —
    # box-measured ~549 MB for an ngl-0 embed child on a 2070 SUPER). The post-confirm
    # true-up must reserve the MEASURED used-VRAM growth, not the assumed 0, or every
    # CPU-offloaded co-resident inflates the budget the arbiter hands the next load.
    readings = iter([1000, 1549])  # before-load → after-confirm: the child grew 549 MB
    arb = VramArbiter()
    no_gpu = HardwareInfo(os="Linux", platform="linux", cpu_cores=8, ram_mb=32000, gpus=[])
    svc = _service_for(tmp_path, arbiter=arb, hardware_fn=lambda: no_gpu,
                       used_vram_fn=lambda: next(readings))
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    assert svc.status()["status"] == "running"
    assert arb.reserved_mb(_TEST_MODEL.id) == 549


def test_reserve_floors_at_estimate_when_delta_undercounts(tmp_path):
    # The delta can UNDER-count (an evicted victim still draining at the `before`
    # snapshot, a co-resident idle-sleeping mid-load) — the true-up must floor at the
    # fit estimate, never book less. GPU hardware → a real (non-zero) estimate; a
    # 1 MB measured delta must NOT shrink the reservation to 1.
    readings = iter([5000, 5001])
    arb = VramArbiter()
    svc = _service_for(tmp_path, arbiter=arb, hardware_fn=lambda: _fake_hw(8192),
                       used_vram_fn=lambda: next(readings))
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    assert svc.status()["status"] == "running"
    assert arb.reserved_mb(_TEST_MODEL.id) > 1  # floored at the formula estimate


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


# ── A3: spawn-time backend fallback chain ─────────────────────────────────────

def _chain_fixture(tmp_path, *, fail_exes, exes, catalog=None):
    """A service whose preferred binary(s) raise RunnerStartError at spawn while
    the rest launch. `exes` = [(gpu, Path)] the installed-builds probe reports;
    the default `acquired_exe` (tmp_path/'llama-server') is the PREFERRED one."""
    from llm_runner.runner.process import RunnerStartError

    attempts = []

    def start(exe, **k):
        attempts.append(str(exe))
        if str(exe) in {str(x) for x in fail_exes}:
            raise RunnerStartError(f"failed to become healthy (exit=3221225781): {exe}")
        return _fake_router()

    svc = _service_for(tmp_path, start_router=start, catalog=catalog,
                       acquired_exes=lambda *a, **k: list(exes))
    return svc, attempts


def test_spawn_fallback_takes_next_installed_backend(tmp_path):
    preferred = tmp_path / "llama-server"                    # what acquired_exe returns
    cpu_exe = tmp_path / "llamacpp" / "b" / "cpu" / "llama-server"
    svc, attempts = _chain_fixture(
        tmp_path, fail_exes=[preferred],
        exes=[("cuda12", preferred), ("cpu", cpu_exe)],
    )
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    assert svc.status()["status"] == "running"               # rescued by the chain
    assert attempts == [str(preferred), str(cpu_exe)]        # preferred first, then fallback
    assert str(svc._active_server_exe) == str(cpu_exe)       # the PROVEN exe is remembered


def test_spawn_fallback_all_fail_aggregates_reasons(tmp_path):
    preferred = tmp_path / "llama-server"
    cpu_exe = tmp_path / "llamacpp" / "b" / "cpu" / "llama-server"
    svc, attempts = _chain_fixture(
        tmp_path, fail_exes=[preferred, cpu_exe],
        exes=[("cuda12", preferred), ("cpu", cpu_exe)],
    )
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    st = svc.status()
    assert st["status"] == "error"
    assert "every installed backend" in st["error"]
    assert "[preferred]" in st["error"] and "[cpu]" in st["error"]
    assert attempts == [str(preferred), str(cpu_exe)]


def test_bounce_after_fallback_reuses_proven_exe(tmp_path):
    # After a fallback spawn, an .ini-changing second load bounces the router —
    # with the PROVEN exe, never re-trying the broken preferred build (which
    # would knock down every healthy resident just to fail again).
    import shutil as _sh

    second = ModelEntry(id="second-model", name="second", tier="mid",
                        hf_repo="org/second", quant="Q4_K_M")
    preferred = tmp_path / "llama-server"
    cpu_exe = tmp_path / "llamacpp" / "b" / "cpu" / "llama-server"
    svc, attempts = _chain_fixture(
        tmp_path, fail_exes=[preferred],
        exes=[("cuda12", preferred), ("cpu", cpu_exe)],
        catalog=[_TEST_MODEL, second],
    )
    # Hide the second model's weights for load #1 so its .ini section doesn't
    # exist yet — load #2 then CHANGES the .ini and takes the bounce path.
    second_snap = tmp_path / "hf" / "models--org--second" / "snapshots" / "sha"
    _sh.rmtree(second_snap.parent.parent)

    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    assert svc.status()["status"] == "running"

    second_snap.mkdir(parents=True)
    (second_snap / "model-Q4_K_M.gguf").write_bytes(b"x" * 1024)
    svc.load(second.id)
    svc._thread.join(timeout=5)
    assert svc._resident[second.id]["status"] == "running"
    assert str(preferred) not in attempts[2:], f"broken preferred exe re-tried: {attempts}"
    assert len(attempts) == 3, f"expected a bounce respawn: {attempts}"
    assert attempts[-1] == str(cpu_exe)  # the bounce respawned with the proven exe


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


# ── P2: VRAM arbiter integration (reserve on load, release on stop, evict LRU) ─

def test_load_reserves_and_stop_releases(tmp_path):
    # A successful load records a VRAM reservation; stop(id) frees it (no leaked budget).
    svc = _service_for(tmp_path)
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    assert svc._arbiter.is_reserved(_TEST_MODEL.id)
    svc.stop(_TEST_MODEL.id)
    assert not svc._arbiter.is_reserved(_TEST_MODEL.id)


def test_stop_all_clears_arbiter(tmp_path):
    svc = _service_for(tmp_path)
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    svc.stop()  # full teardown
    assert svc._arbiter.committed_mb() == 0 and svc._arbiter.count() == 0


def test_failed_load_leaves_no_reservation(tmp_path):
    # A load that errors (unknown model) must not leave a phantom reservation.
    svc = _service_for(tmp_path)
    svc.load("does-not-exist")
    svc._thread.join(timeout=5)
    assert svc.status()["status"] == "error"
    assert not svc._arbiter.is_reserved("does-not-exist")


def test_admit_evicts_lru_when_over_budget(tmp_path):
    # An 800 MB load onto a 1000 MB card with A(200, LRU) + B(100) resident evicts the LRU (A) to
    # make room; B (more recent) stays. _admit is exercised directly with an explicit budget.
    unloaded = []
    arb = VramArbiter(hardware_fn=lambda: _fake_hw(1000))
    arb.reserve("A", 200)   # older → the LRU
    arb.reserve("B", 100)
    svc = _service_for(tmp_path, arbiter=arb, router_unload=lambda url, mid: unloaded.append(mid))
    svc._router = _fake_router()
    svc._resident = {"A": {"status": "running"}, "B": {"status": "running"}}
    svc._admit("C", 800, models_max=5, hardware=_fake_hw(1000))
    assert unloaded == ["A"]                 # only the LRU evicted (200 freed → 900 ≥ 800)
    assert not arb.is_reserved("A") and arb.is_reserved("B")


def test_admit_respects_pinned(tmp_path):
    # A pinned (embed) reservation is never evicted; the evictable chat goes first.
    unloaded = []
    arb = VramArbiter(hardware_fn=lambda: _fake_hw(1000))
    arb.reserve("embed", 200, pinned=True)   # older but PINNED
    arb.reserve("chat", 700)
    svc = _service_for(tmp_path, arbiter=arb, router_unload=lambda url, mid: unloaded.append(mid))
    svc._router = _fake_router()
    svc._resident = {"embed": {"status": "running"}, "chat": {"status": "running"}}
    svc._admit("big", 900, models_max=5, hardware=_fake_hw(1000))
    assert unloaded == ["chat"] and arb.is_reserved("embed")


def test_admit_count_cap_evicts_even_when_vram_fits(tmp_path):
    # models_max caps the child COUNT: 2 tiny models resident + models_max=2 → a 3rd load evicts
    # the LRU even though VRAM has plenty of room.
    unloaded = []
    arb = VramArbiter(hardware_fn=lambda: _fake_hw(8000))
    arb.reserve("A", 10)   # LRU
    arb.reserve("B", 10)
    svc = _service_for(tmp_path, arbiter=arb, router_unload=lambda url, mid: unloaded.append(mid))
    svc._router = _fake_router()
    svc._resident = {"A": {"status": "running"}, "B": {"status": "running"}}
    svc._admit("C", 10, models_max=2, hardware=_fake_hw(8000))
    assert unloaded == ["A"]                  # count 2 == cap → evict LRU so the 3rd fits under the cap


def test_admit_proceeds_when_only_pinned_and_over_budget(tmp_path):
    # Everything resident is pinned and it still doesn't fit → proceed anyway (no eviction); the
    # spawn OOM back-off + the build's CPU auto-offload are the final safety nets.
    unloaded = []
    arb = VramArbiter(hardware_fn=lambda: _fake_hw(1000))
    arb.reserve("embed", 900, pinned=True)
    svc = _service_for(tmp_path, arbiter=arb, router_unload=lambda url, mid: unloaded.append(mid))
    svc._router = _fake_router()
    svc._resident = {"embed": {"status": "running"}}
    svc._admit("big", 900, models_max=5, hardware=_fake_hw(1000))
    assert unloaded == [] and arb.is_reserved("embed")


def test_load_idempotent_when_running_does_not_respawn(tmp_path):
    # A plain re-load of a running model is a no-op (no re-POST → no 400, no ledger churn) — it just
    # touches the LRU. The HTTP path (api.load_model) ALWAYS passes an empty Overrides(), so the
    # guard must treat Overrides()==default as "no tuning" (not `is None`, which is dead for HTTP).
    spawns = {"n": 0}

    def count_spawn(*a, **k):
        spawns["n"] += 1
        return _fake_router()

    svc = _service_for(tmp_path, start_router=count_spawn)
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    assert spawns["n"] == 1
    st = svc.load(_TEST_MODEL.id, overrides=Overrides())   # the EXACT shape every HTTP load sends
    assert st["status"] == "running" and spawns["n"] == 1  # guard fired → NOT respawned/reloaded


def test_load_retune_while_running_does_reload(tmp_path):
    # A Lab re-tune (real overrides) of a running model must NOT be swallowed by the idempotent
    # guard — the .ini changes (ctx 4096→16384) → the router bounces and reloads with the new args.
    spawns = {"n": 0}

    def count_spawn(*a, **k):
        spawns["n"] += 1
        return _fake_router()

    svc = _service_for(tmp_path, start_router=count_spawn)
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    assert spawns["n"] == 1
    svc.load(_TEST_MODEL.id, overrides=Overrides(ctx_len=16384))  # real tuning → re-load
    svc._thread.join(timeout=5)
    assert svc.status()["status"] == "running"
    assert spawns["n"] == 2                    # bounced (respawned) to apply the re-tuned .ini
    assert "ctx-size = 16384" in _ini(svc)


def test_resident_reports_vram_budget(tmp_path):
    # /resident carries the arbiter's committed/remaining VRAM (here another 3000 MB model is
    # already resident) + each model's reserved vram_mb.
    arb = VramArbiter(hardware_fn=lambda: _fake_hw(8000))
    arb.reserve("other", 3000)

    def models(url):
        return {"object": "list", "data": [{"id": _TEST_MODEL.id, "status": {"value": "loaded"}}]}

    svc = _service_for(tmp_path, arbiter=arb, router_models=models)
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    res = svc.resident()
    assert res["vram_total_mb"] == 8000
    assert res["committed_mb"] == arb.committed_mb()
    assert res["remaining_mb"] == 8000 - arb.committed_mb()
    row = next(m for m in res["models"] if m["id"] == _TEST_MODEL.id)
    assert "vram_mb" in row


def test_admit_retune_excludes_own_reservation(tmp_path):
    # Re-admitting a model that is ALREADY reserved must (a) not evict itself and (b) count its own
    # reservation as freeable (a re-tune replaces, not adds) — PROVEN by a second co-resident that
    # WOULD be spuriously evicted if `own` weren't added back to the budget.
    unloaded = []
    arb = VramArbiter(hardware_fn=lambda: _fake_hw(1000))
    arb.reserve("chat", 800)    # the model being re-tuned
    arb.reserve("other", 100)   # a co-resident that must NOT be evicted
    svc = _service_for(tmp_path, arbiter=arb, router_unload=lambda url, mid: unloaded.append(mid))
    svc._router = _fake_router()
    svc._resident = {"chat": {"status": "running"}, "other": {"status": "running"}}
    # remaining is 100; re-admit chat at 900 — fits ONLY because chat's own 800 frees back (→ 900).
    svc._admit("chat", 900, models_max=5, hardware=_fake_hw(1000))
    assert unloaded == []       # neither chat (self-exclude) nor other (own add-back avoids the spurious evict)


def test_evict_rehomes_last_id(tmp_path):
    # Evicting the primary (_last_id) re-homes it to another resident.
    arb = VramArbiter(hardware_fn=lambda: _fake_hw(8000))
    arb.reserve("A", 100)
    arb.reserve("B", 100)
    svc = _service_for(tmp_path, arbiter=arb)
    svc._router = _fake_router()
    svc._resident = {"A": {"status": "running"}, "B": {"status": "running"}}
    svc._last_id = "A"
    svc._evict_resident("A")
    assert svc._last_id == "B" and "A" not in svc._resident


def test_load_evicts_then_reserves_on_success(tmp_path, monkeypatch):
    # A load that needs more than the remaining budget evicts the LRU first, then reserves. A forced
    # fit.vram_mb exercises the evict path via a REAL load (compute_fit → ~0 on a GPU-less CI box).
    unloaded = []
    arb = VramArbiter(hardware_fn=lambda: _fake_hw(1000))
    arb.reserve("old", 900)   # near-full → the LRU
    svc = _service_for(tmp_path, arbiter=arb, router_unload=lambda url, mid: unloaded.append(mid))
    svc._router = _fake_router()
    svc._resident["old"] = {"status": "running"}
    svc._hardware_fn = lambda: _fake_hw(1000)   # _admit's budget = 1000
    monkeypatch.setattr("llm_runner.runner.lifecycle.compute_fit",
                        lambda *a, **k: FitPlan(10, 0, 4096, 24, False, vram_mb=800))
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    assert svc.status()["status"] == "running"
    assert unloaded == ["old"]                          # LRU evicted to make room for the 800 MB load
    assert svc._arbiter.reserved_mb(_TEST_MODEL.id) == 800


def test_load_evicts_then_fails_releases(tmp_path, monkeypatch):
    # If a load evicts a victim to make room but then FAILS, the incoming model leaves NO reservation
    # (released on error) — no ledger drift; the victim stays evicted (an accepted, flagged cost).
    unloaded = []
    arb = VramArbiter(hardware_fn=lambda: _fake_hw(1000))
    arb.reserve("old", 900)

    def boom(url, mid):
        raise RuntimeError("/models/load failed [400]")

    svc = _service_for(tmp_path, arbiter=arb, router_load=boom,
                       router_unload=lambda url, mid: unloaded.append(mid))
    svc._router = _fake_router()
    svc._resident["old"] = {"status": "running"}
    svc._hardware_fn = lambda: _fake_hw(1000)
    monkeypatch.setattr("llm_runner.runner.lifecycle.compute_fit",
                        lambda *a, **k: FitPlan(10, 0, 4096, 24, False, vram_mb=800))
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    assert svc.status()["status"] == "error"
    assert unloaded == ["old"]                          # victim evicted before the (failing) load attempt
    assert not svc._arbiter.is_reserved(_TEST_MODEL.id)  # incoming released on failure — no ledger drift


def test_reload_respawns_dead_router(tmp_path):
    # If the router crashed, a plain re-load of a stale-'running' model must NOT be swallowed by the
    # idempotent guard — it must fall through and RESPAWN the router (recovery). Guards the exact
    # regression the guard's router-liveness check prevents.
    spawns = {"n": 0}
    routers = []

    def spy_start(*a, **k):
        spawns["n"] += 1
        r = SimpleNamespace(url="http://127.0.0.1:8080", is_alive=lambda: True, stop=lambda: None)
        routers.append(r)
        return r

    svc = _service_for(tmp_path, start_router=spy_start)
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    assert spawns["n"] == 1 and svc.status()["status"] == "running"
    routers[0].is_alive = lambda: False        # the router process dies; the resident entry stays 'running'
    svc.load(_TEST_MODEL.id)                    # plain re-load (no tuning) → must fall through, not swallow
    svc._thread.join(timeout=5)
    assert spawns["n"] == 2                      # respawned (the router-liveness gate let it fall through)
    assert svc.status()["status"] == "running"


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


# ── P3: co-resident embeddings — ensure_embedding + pinned + the .ini embed section ──

_EMBED = ModelEntry(id="nomic-embed-text", name="Nomic Embed", tier="cpu",
                    hf_repo="org/embed-GGUF", quant="Q4_K_M", pooling="mean")


def test_ensure_embedding_no_config_is_noop(tmp_path):
    # No local embed configured (routing points at Ollama/cloud) → ok:false, no load kicked off.
    svc = _service_for(tmp_path)  # default embedding_ids_fn → empty
    res = svc.ensure_embedding()
    assert res["ok"] is False
    assert svc._thread is None  # no background load started


def test_ensure_embedding_loads_and_pins(tmp_path):
    # The lazy trigger: ensure_embedding downloads-if-needed + loads + reserves the embed PINNED.
    svc = _service_for(tmp_path, catalog=[_EMBED], embedding_ids_fn=lambda: {_EMBED.id})
    res = svc.ensure_embedding()
    assert res["ok"] is True
    assert res["modelId"] == _EMBED.id
    svc._thread.join(timeout=5)
    assert svc.status()["status"] == "running"
    # reserved AND pinned → never the eviction victim
    assert svc._arbiter.is_reserved(_EMBED.id)
    row = next(r for r in svc._arbiter.snapshot()["reservations"] if r["key"] == _EMBED.id)
    assert row["pinned"] is True
    assert svc._arbiter.pick_evict() is None  # only a pinned reservation → nothing evictable


def test_embed_own_load_emits_embeddings_section(tmp_path):
    # PRIMARY P3 path (embed-first RAG): the embed is loaded as the OVERRIDE, so its emitted
    # section MUST carry embeddings=true + pooling (else /v1/embeddings would serve it as a chat
    # model). This exercises the override branch of _resolve_ini_entries, not the DB-resolved one.
    svc = _service_for(tmp_path, catalog=[_EMBED], embedding_ids_fn=lambda: {_EMBED.id})
    svc.load(_EMBED.id)
    svc._thread.join(timeout=5)
    ini = _ini(svc)
    assert f"[{_EMBED.id}]" in ini
    assert "embeddings = true" in ini
    assert "pooling = mean" in ini
    assert "load-on-startup" not in ini  # deliberately NOT set — pin is the arbiter reservation


def test_chat_load_emits_ondisk_embed_section(tmp_path):
    # DB-resolved path: a CHAT load re-emits the .ini for ALL on-disk models, so the embed's own
    # section (it is on disk) also carries embeddings=true — keeping it a valid embed child.
    svc = _service_for(tmp_path, catalog=[_TEST_MODEL, _EMBED], embedding_ids_fn=lambda: {_EMBED.id})
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    ini = _ini(svc)
    assert f"[{_TEST_MODEL.id}]" in ini and f"[{_EMBED.id}]" in ini
    embed_section = ini.split(f"[{_EMBED.id}]", 1)[1]
    assert "embeddings = true" in embed_section
    assert "pooling = mean" in embed_section  # pooling resolved by-id from the catalog on the DB-resolved path too (#119)
    # the chat model's section is NOT marked as an embed
    chat_section = ini.split(f"[{_TEST_MODEL.id}]", 1)[1].split("[", 1)[0]
    assert "embeddings = true" not in chat_section


def test_pinned_embed_survives_chat_coresidence(tmp_path):
    # models_max=2: embed(pinned) + chat1 resident → loading chat2 evicts the LRU NON-pinned
    # (chat1), never the pinned embed the RAG index depends on.
    svc = _service_for(tmp_path, catalog=[_EMBED, _TEST_MODEL, _MODEL_B],
                       embedding_ids_fn=lambda: {_EMBED.id})
    svc.ensure_embedding()
    svc._thread.join(timeout=5)
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    svc.load(_MODEL_B.id)
    svc._thread.join(timeout=5)
    assert svc._arbiter.is_reserved(_EMBED.id)          # embed never evicted (pinned)
    assert not svc._arbiter.is_reserved(_TEST_MODEL.id)  # chat1 was the LRU eviction victim
    assert svc._arbiter.is_reserved(_MODEL_B.id)         # chat2 is now resident


def test_non_embed_model_reserves_unpinned(tmp_path):
    # A chat model (not the configured embed) reserves UNPINNED — it can be evicted.
    svc = _service_for(tmp_path, catalog=[_TEST_MODEL, _EMBED], embedding_ids_fn=lambda: {_EMBED.id})
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    row = next(r for r in svc._arbiter.snapshot()["reservations"] if r["key"] == _TEST_MODEL.id)
    assert row["pinned"] is False
    assert svc._arbiter.pick_evict() == _TEST_MODEL.id


def test_switch_rows_type_new_flags(tmp_path):  # noqa: ARG001 — matches file convention
    # Stored switch ROWS for the 3 new flags land on the TYPED Overrides fields
    # (never extra_flags): reasoning_budget is in _parse_switch's int_fields
    # (Plan B D6, wiring point 4), the other two stay strings.
    from llm_runner.runner.lifecycle import _switches_to_overrides

    ov = _switches_to_overrides({
        "reasoning_budget": "1024",
        "reasoning_budget_message": "wrap it up",
        "model_draft": "/d/MTP/g-Q4_0-MTP.gguf",
    })
    assert ov.reasoning_budget == 1024                       # int-typed, not "1024"
    assert ov.reasoning_budget_message == "wrap it up"
    assert ov.model_draft == "/d/MTP/g-Q4_0-MTP.gguf"
    assert ov.extra_flags == []                              # no passthrough leak


# ── Gemma-style external MTP draft (Plan B, D7) ──────────────────────────────

_DRAFT_MODEL = ModelEntry(
    id="draft-model", name="Draft", tier="mid", hf_repo="org/draft-GGUF", quant="Q4_K_M",
    mtp=True, mtp_draft_repo="", mtp_draft_file="MTP/d-Q4_0-MTP.gguf", mtp_draft_quant="Q4_0",
)


def test_load_acquires_declared_draft_and_emits_model_draft(tmp_path):
    # A model declaring a separate MTP draft file + a resolved spec_type=draft-mtp
    # → the draft is acquired via the SAME acquire path (exact path as selector)
    # and the emitted .ini section carries model-draft = <snapshot path>.
    svc = _service_for(tmp_path, catalog=[_DRAFT_MODEL])
    snap = tmp_path / "hf" / "models--org--draft-GGUF" / "snapshots" / "sha"
    (snap / "MTP").mkdir(parents=True, exist_ok=True)
    (snap / "MTP" / "d-Q4_0-MTP.gguf").write_bytes(b"g" * 64)
    svc.load(_DRAFT_MODEL.id, switches={"spec_type": "draft-mtp"})
    svc._thread.join(timeout=5)
    assert svc.status()["status"] == "running"
    ini = _ini(svc)
    assert "spec-type = draft-mtp" in ini
    assert f"model-draft = {snap / 'MTP' / 'd-Q4_0-MTP.gguf'}" in ini


def test_load_fails_loud_when_declared_draft_missing(tmp_path):
    # The user asked for MTP (spec_type=draft-mtp) but the declared draft file is
    # absent after acquire → the LOAD fails with the real reason; never a silent
    # no-MTP fallback.
    svc = _service_for(tmp_path, catalog=[_DRAFT_MODEL])  # draft file NOT created
    svc.load(_DRAFT_MODEL.id, switches={"spec_type": "draft-mtp"})
    svc._thread.join(timeout=5)
    st = svc.status()
    assert st["status"] == "error"
    assert "MTP draft" in st["error"]


def test_load_skips_draft_when_spec_off(tmp_path):
    # Same model, but the user turned MTP OFF (spec none) → no draft acquire, no
    # model-draft in the ini, load succeeds on the main weights alone.
    svc = _service_for(tmp_path, catalog=[_DRAFT_MODEL])
    svc.load(_DRAFT_MODEL.id)  # no spec switch → knob default none
    svc._thread.join(timeout=5)
    assert svc.status()["status"] == "running"
    assert "model-draft" not in _ini(svc)


def test_passive_section_carries_cached_draft(tmp_path):
    # Diff-checker fold (Plan B D7): the auto-mtp layer can set draft-mtp on a
    # PASSIVE co-resident section. When the draft IS cached, the section must
    # carry model-draft (else a router bounce hands llama-server a broken preset).
    def auto_mtp_switches(mid):
        return {"spec_type": "draft-mtp"} if mid == _DRAFT_MODEL.id else {}

    svc = _service_for(tmp_path, catalog=[_DRAFT_MODEL, _TEST_MODEL],
                       switches_fn=auto_mtp_switches)
    snap = tmp_path / "hf" / "models--org--draft-GGUF" / "snapshots" / "sha"
    (snap / "MTP").mkdir(parents=True, exist_ok=True)
    (snap / "MTP" / "d-Q4_0-MTP.gguf").write_bytes(b"g" * 64)
    svc.load(_TEST_MODEL.id)  # the OTHER model loads → draft-model emits PASSIVELY
    svc._thread.join(timeout=5)
    ini = _ini(svc)
    passive = ini.split(f"[{_DRAFT_MODEL.id}]", 1)[1].split("[", 1)[0]
    assert "spec-type = draft-mtp" in passive
    assert f"model-draft = {snap / 'MTP' / 'd-Q4_0-MTP.gguf'}" in passive


def test_passive_section_strips_spec_when_draft_not_cached(tmp_path):
    # …and when the draft was NEVER downloaded, the passive section STRIPS spec
    # instead of emitting draft-mtp with no draft file (no network in the ini
    # emitter; the first ACTIVE load acquires it fail-loud and re-emits).
    def auto_mtp_switches(mid):
        return {"spec_type": "draft-mtp", "spec_n_max": "2"} if mid == _DRAFT_MODEL.id else {}

    svc = _service_for(tmp_path, catalog=[_DRAFT_MODEL, _TEST_MODEL],
                       switches_fn=auto_mtp_switches)  # draft file NOT created
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    ini = _ini(svc)
    passive = ini.split(f"[{_DRAFT_MODEL.id}]", 1)[1].split("[", 1)[0]
    assert "spec-type" not in passive
    assert "spec-draft-n-max" not in passive
    assert "model-draft" not in passive


def test_run_install_plants_fallback_builds(tmp_path):
    # A3-REVISED (user, 2026-07-07: "we do not even use cpu version"): the CPU build
    # is NO LONGER pre-downloaded. The one remaining extra is vulkan on a ROCm pick;
    # a CUDA/NVIDIA pick downloads its selected build ONLY.
    from llm_runner import default_config

    calls = []

    def spy(cache_root, config, hardware, on_progress=None, cancel_check=None, gpu=None):
        calls.append(gpu)
        return tmp_path / "x"

    hw_rocm = HardwareInfo(os="linux", platform="linux", cpu_cores=8, ram_mb=32000,
                           gpus=[], runtimes={"rocm": True, "vulkan": True})
    svc = RunnerService(tmp_path, config_fn=default_config, hardware_fn=lambda: hw_rocm,
                        acquire_binary=spy, arbiter=VramArbiter())
    svc.install_engine()
    svc._engine_thread.join(timeout=5)
    assert calls == [None, "vulkan"]  # rocm→vulkan kept; NO cpu download
    assert svc._engine_state["status"] == "installed"

    calls.clear()
    hw_cuda = HardwareInfo(os="windows", platform="windows", cpu_cores=8, ram_mb=32000,
                           gpus=[GpuInfo(vendor="NVIDIA", name="RTX 2070 SUPER", vram_mb=8192)],
                           runtimes={"cuda": True})
    svc2 = RunnerService(tmp_path, config_fn=default_config, hardware_fn=lambda: hw_cuda,
                         acquire_binary=spy, arbiter=VramArbiter())
    svc2.install_engine()
    svc2._engine_thread.join(timeout=5)
    assert calls == [None]  # NVIDIA: the selected build only — no extras at all
    assert svc2._engine_state["status"] == "installed"


def test_run_install_extra_failure_is_best_effort(tmp_path):
    # A failed EXTRA never fails the install — the selected build gates "installed".
    # (Re-seated on the vulkan extra: cpu is no longer downloaded at all.)
    from llm_runner import default_config

    calls = []

    def spy(cache_root, config, hardware, on_progress=None, cancel_check=None, gpu=None):
        calls.append(gpu)
        if gpu == "vulkan":
            raise RuntimeError("mirror down")
        return tmp_path / "x"

    hw_rocm = HardwareInfo(os="linux", platform="linux", cpu_cores=8, ram_mb=32000,
                           gpus=[], runtimes={"rocm": True, "vulkan": True})
    svc = RunnerService(tmp_path, config_fn=default_config, hardware_fn=lambda: hw_rocm,
                        acquire_binary=spy, arbiter=VramArbiter())
    svc.install_engine()
    svc._engine_thread.join(timeout=5)
    assert calls == [None, "vulkan"]  # the extra was attempted and failed
    assert svc._engine_state["status"] == "installed"


def test_run_install_replace_build_carries_ini_and_deletes_old(tmp_path):
    # #118 (user, 2026-07-07): an UPDATE replaces the old build — a hand-maintained
    # models.ini inside the old build dir is carried into the new one, then the old
    # folder is deleted. A plain reinstall (replace_build == the pin) deletes nothing.
    from llm_runner import default_config

    cfg = default_config()
    new_dir = tmp_path / "llamacpp" / cfg.llamacpp.pinned_build
    old_dir = tmp_path / "llamacpp" / "b0001"
    old_dir.mkdir(parents=True)
    (old_dir / "models.ini").write_text("[hand-tuned]\nmodel = x.gguf\n")

    def spy(cache_root, config, hardware, on_progress=None, cancel_check=None, gpu=None):
        new_dir.mkdir(parents=True, exist_ok=True)
        return new_dir

    hw_cuda = HardwareInfo(os="windows", platform="windows", cpu_cores=8, ram_mb=32000,
                           gpus=[GpuInfo(vendor="NVIDIA", name="RTX 2070 SUPER", vram_mb=8192)],
                           runtimes={"cuda": True})
    svc = RunnerService(tmp_path, config_fn=default_config, hardware_fn=lambda: hw_cuda,
                        acquire_binary=spy, arbiter=VramArbiter())
    svc.install_engine(replace_build="b0001")
    svc._engine_thread.join(timeout=5)
    assert svc._engine_state["status"] == "installed"
    assert not old_dir.exists()                                   # old folder gone
    assert (new_dir / "models.ini").read_text().startswith("[hand-tuned]")  # ini carried

    # Same-pin guard: a reinstall passing its own build never deletes the fresh install.
    svc.install_engine(replace_build=cfg.llamacpp.pinned_build)
    svc._engine_thread.join(timeout=5)
    assert new_dir.exists()

    # Generalized sweep (2026-07-07, after the user's box stranded a folder): ANY
    # stale build dir goes on the next successful install — a DB reset can re-pin
    # an older build and strand the newer folder — while "logs" and the pinned
    # build survive. (The stop-first exe-lock handling is Windows-runtime behavior;
    # here stop() is exercised offline.)
    stale2 = tmp_path / "llamacpp" / "b0002"
    stale2.mkdir(parents=True)
    logs = tmp_path / "llamacpp" / "logs"
    logs.mkdir(exist_ok=True)
    svc.install_engine()
    svc._engine_thread.join(timeout=5)
    assert not stale2.exists() and logs.exists() and new_dir.exists()


# ── 1b fit-by-omission: untuned sections omit placement; F4 any-failure fallback ──

def test_untuned_model_ini_omits_placement_knobs(tmp_path):
    # No tune/preset switches → the section omits n-gpu-layers/n-cpu-moe (the child's
    # default `--fit` places tensors) and still pins ctx-size (ctx policy is ours).
    svc = _service_for(tmp_path)
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    assert svc.status()["status"] == "running"
    ini = _ini(svc)
    assert "n-gpu-layers" not in ini and "n-cpu-moe" not in ini
    assert "ctx-size = " in ini


def test_tuned_model_ini_renders_explicit_knobs(tmp_path):
    # A tune (or preset/request) value renders exactly as pre-1b — explicit flags
    # legitimately disable the engine's fit for those args (tuned boxes unchanged).
    svc = _service_for(
        tmp_path,
        switches_fn=lambda mid: {"n_gpu_layers": "99", "n_cpu_moe": "21", "ctx_len": "32768"},
    )
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    ini = _ini(svc)
    # ngl renders EXPLICITLY (the whole point) — clamped to the model's real layer
    # count (24 in this harness), the pre-existing compute_fit clamp for ngl-99 tunes.
    assert "n-gpu-layers = 24" in ini
    assert "n-cpu-moe = 21" in ini
    assert "ctx-size = 32768" in ini


def test_fit_placed_failure_retries_explicit_once(tmp_path):
    # 1b-F4: a FIT-PLACED entry (no explicit knobs) that fails for ANY reason — even a
    # non-OOM exit (#18066's barely-fits presentation) — retries ONCE with the explicit
    # computed placement, then loads. The ini must end up carrying the explicit values.
    posts = {"n": 0}

    def count_load(url, model_id):
        posts["n"] += 1

    def fail_then_load(url):
        value = "loaded" if posts["n"] >= 2 else "failed"
        return {"object": "list", "data": [{"id": _TEST_MODEL.id, "status": {"value": value}}]}

    svc = _service_for(tmp_path, router_load=count_load, router_models=fail_then_load)
    svc.load(_TEST_MODEL.id)  # no overrides → fit-placed entry (ngl omitted)
    svc._thread.join(timeout=5)
    assert svc.status()["status"] == "running"
    assert posts["n"] == 2                      # failed once → explicit retry loaded
    ini = _ini(svc)
    assert "n-gpu-layers = " in ini             # the retry re-emitted explicit placement


def test_fit_placed_failure_falls_back_then_fails_fast_on_non_oom(tmp_path):
    # After the ONE explicit retry, a still-failing non-OOM load fails fast exactly as
    # pre-1b (no shed without an OOM signal, no endless bouncing).
    spawns = {"n": 0}

    def count_spawn(*a, **k):
        spawns["n"] += 1
        return _fake_router()

    def always_failed(url):
        return {"object": "list", "data": [{"id": _TEST_MODEL.id, "status": {"value": "failed"}}]}

    svc = _service_for(tmp_path, start_router=count_spawn, router_models=always_failed)
    svc.load(_TEST_MODEL.id)  # fit-placed
    svc._thread.join(timeout=5)
    assert svc.status()["status"] == "error"
    assert spawns["n"] == 2   # the initial spawn + the ONE explicit-retry bounce, no more


def test_engine_uninstall_removes_build_dir(tmp_path):
    # Providers-surface redesign item 3 (2026-07-06): uninstall deletes the pinned
    # build's binary dir (every per-GPU variant) and resets the engine state; the
    # HF model cache is untouched.
    from llm_runner import default_config
    from llm_runner.runner.binary import binary_dir

    svc = _service_for(tmp_path)
    d = binary_dir(svc.cache_root, default_config().llamacpp.pinned_build)
    d.mkdir(parents=True, exist_ok=True)
    (d / "llama-server").write_bytes(b"x")
    model_cache = svc.cache_root / "hf"
    assert model_cache.exists()

    out = svc.uninstall_engine()

    assert not d.exists()
    assert model_cache.exists()  # models are kept
    assert out["status"] == "idle"


def test_engine_uninstall_refused_while_installing(tmp_path):
    from llm_runner import default_config
    from llm_runner.runner.binary import binary_dir

    svc = _service_for(tmp_path)
    d = binary_dir(svc.cache_root, default_config().llamacpp.pinned_build)
    d.mkdir(parents=True, exist_ok=True)
    svc._engine_state = {"status": "installing", "detail": "llama.cpp engine",
                         "error": "", "downloaded": 0, "total": 0}

    out = svc.uninstall_engine()

    assert "install in progress" in out["error"]
    assert d.exists()  # nothing deleted while the installer thread owns the dir


def test_update_check_reports_newer_build(tmp_path):
    # A5: newer upstream tag → updateAvailable; the fetch is injected (the container
    # proxy can't reach ggml-org; the user's box calls the releases API directly).
    svc = _service_for(tmp_path)
    svc._latest_build_fn = lambda: "b99999"
    out = svc.update_check()
    assert out["updateAvailable"] is True and out["latest"] == "b99999" and out["error"] == ""


def test_update_check_same_and_error_paths(tmp_path):
    svc = _service_for(tmp_path)
    svc._latest_build_fn = lambda: svc._config_fn().llamacpp.pinned_build
    assert svc.update_check()["updateAvailable"] is False

    def boom():
        raise RuntimeError("offline")

    svc._latest_build_fn = boom
    out = svc.update_check()
    assert out["updateAvailable"] is False and "offline" in out["error"]
