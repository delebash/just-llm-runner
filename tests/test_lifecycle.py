# SPDX-License-Identifier: GPL-3.0-or-later
"""RunnerService state machine (ROUTER mode) — the download + router IO is injected
so the orchestration (status transitions, DB→.ini emission, co-residence, OOM
back-off, error handling) tests offline. The real default RunnerConfig + compute_fit
run unmocked; a fake HF cache lets `cached_gguf_path` resolve on-disk models faithfully."""

import logging
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from llm_runner.runner.arbiter import VramArbiter
from llm_runner.runner.download import DownloadCancelled
from llm_runner.runner.lifecycle import CorruptModelError, RunnerService
from llm_runner.runner.process import FitPlan, ModelIniEntry, Overrides
from llm_runner.runner.schema import GpuInfo, HardwareInfo, ModelEntry, RecommendedFor


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


def _raise_bad_magic(_path):
    """A read_meta stand-in for a corrupt/zeroed GGUF — the exact error gguf.py raises."""
    raise ValueError("not a GGUF stream (bad magic)")


def _yield_poll(_seconds):
    """Injected `sleep` for an ensure_model_ready poll that waits on the BACKGROUND load
    thread. `time.sleep(0)` yields the GIL each iteration; a no-op (`lambda s: None`) makes
    the poll a tight GIL-holding busy-loop that STARVES the load thread, so the load can't
    reach its terminal state before the poll's own timeout — a real hang whenever the load
    path does enough work (the fit-placed failed-load retry/bounce crossed that line and hung
    deterministically on Windows). Production polls with a real time.sleep, which yields, so
    it never starves; this mirrors that cheaply without a real delay."""
    time.sleep(0)


def _service_for(tmp_path, *, catalog=None, start_router=None, router_load=None,
                 router_unload=None, router_models=None, now=None, sleep=None,
                 identify_fn=None, switches_fn=None, profile_switches_fn=None,
                 embedding_ids_fn=None, default_llm_id_fn=None, arbiter=None,
                 acquired_exes=None, used_vram_fn=None, hardware_fn=None):
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

    # The default router view is REACTIVE to unload (T2, 2026-07-17): stop()'s
    # confirm-unload polls GET /models until the model stops reading loaded — a static
    # always-loaded default would park every stop() in that poll's 5 s timeout. Like
    # the real router: unloaded ids report "unloaded", everything else "loaded".
    _unloaded_ids = set()

    def _default_unload(url, mid):
        _unloaded_ids.add(mid)

    def _all_loaded(url):
        return {"object": "list", "data": [
            {"id": m.id, "status": {"value": "unloaded" if m.id in _unloaded_ids else "loaded"}}
            for m in models]}

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
    if default_llm_id_fn is not None:
        kw["default_llm_id_fn"] = default_llm_id_fn
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
        # A re-load of a previously-unloaded id flips it back to loaded (as the router does).
        router_load=router_load or (lambda url, mid: _unloaded_ids.discard(mid)),
        router_unload=router_unload or _default_unload,
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

    paths = {}

    def oom_router(*a, **k):
        # Stash the per-spawn log path; the OOM text is appended at POST time below —
        # the tail read is WATERMARKED per attempt (2026-07-21), so a spawn-time write
        # would land before the watermark and never match (as a real stale line shouldn't).
        paths["log"] = k.get("log_path")
        return _fake_router()

    def oom_load(url, mid):
        count_load(url, mid)
        # The child's OOM text lands DURING the attempt (after this POST's watermark),
        # exactly as the real child writes it.
        lp = paths.get("log")
        if lp:
            Path(lp).parent.mkdir(parents=True, exist_ok=True)
            with open(lp, "a", encoding="utf-8") as f:
                f.write("CUDA error: out of memory\n")

    svc = _service_for(tmp_path, start_router=oom_router,
                       router_load=oom_load, router_models=failed_until_third)
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


# ── T1: the phase is set by the download itself (2026-07-17 approved plan) ──
# _run_load used to write detail="model weights" UNCONDITIONALLY before checking disk
# (:1361), so an already-cached model flashed a download bar that lied (the user's
# phantom bar). Now the neutral "preparing" is written up front and the download's own
# _progress callback — which fires only on real chunks — sets its leg's phase.

def _detail_recorder(svc):
    """Capture every `detail` value _touch writes, in order, without changing behavior."""
    details = []
    orig = svc._touch

    def spy(mid, **fields):
        if "detail" in fields:
            details.append(fields["detail"])
        return orig(mid, **fields)

    svc._touch = spy
    return details


def test_cached_model_never_announces_a_download(tmp_path):
    # The harness seeds every catalog model into the fake HF cache and its injected
    # acquire_model returns the snapshot WITHOUT firing on_progress — i.e. a fully
    # cached model. The phantom phase must not appear.
    svc = _service_for(tmp_path)
    details = _detail_recorder(svc)
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    assert svc.status()["status"] == "running"
    assert "model weights" not in details      # the phantom (fails before T1)
    assert "preparing" in details              # the honest neutral phase


def test_real_download_still_announces_model_weights(tmp_path):
    svc = _service_for(tmp_path)
    real_acquire = svc._acquire_model

    def acquiring_with_chunks(repo, *a, on_progress=None, **k):
        if on_progress:
            on_progress(1024, 4096)            # a real chunk lands
        return real_acquire(repo, *a, **k)

    svc._acquire_model = acquiring_with_chunks
    details = _detail_recorder(svc)
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    assert "model weights" in details          # a real download still says so


# ── T2: cancel is a per-load token the LOAD THREAD honors (2026-07-17 approved plan) ──
# stop() on a mid-load model sets the token and returns AT ONCE (the old stop blocked on
# _router_lock behind the load's router ops for the whole VRAM phase); the load thread
# cancels at checkpoints — never evicting for a cancelled load, silently unloading a
# child that spawned after the cancel (the user's q2 ruling), and always cleaning its
# ledger entry (a bare return would wedge a permanent "cancelling" with the UI inert).

def test_stop_during_vram_phase_returns_promptly_and_child_is_unloaded(tmp_path):
    entered = threading.Event()
    gate = threading.Event()
    unloads = []

    def gated_router_load(url, mid):
        entered.set()
        gate.wait(5)

    svc = _service_for(tmp_path, router_load=gated_router_load,
                       router_unload=lambda url, mid: unloads.append(mid))
    svc.load(_TEST_MODEL.id)
    assert entered.wait(5)

    # The user's Cancel, while the spawn is in flight. OLD code: this call blocks on
    # _router_lock until the load finishes (the "stuck cancel"). NEW: returns at once.
    done = threading.Event()
    out = {}

    def do_stop():
        out["st"] = svc.stop(_TEST_MODEL.id)
        done.set()

    threading.Thread(target=do_stop, daemon=True).start()
    assert done.wait(1.0), "stop() must not block behind the load's router ops"
    # Double-stop while resolving: also prompt, also harmless.
    assert svc.stop(_TEST_MODEL.id) is not None

    gate.set()
    svc._thread.join(timeout=5)
    # The q2 silent unload: the just-spawned child was unloaded; nothing survives.
    assert unloads == [_TEST_MODEL.id]
    assert _TEST_MODEL.id not in svc._resident          # no stuck "cancelling"
    assert not svc._arbiter.is_reserved(_TEST_MODEL.id)  # reservation released
    assert not svc._cancel_events                        # token died with its load


def test_cancel_inside_the_admit_window_never_evicts(tmp_path):
    # THE panel's architecture finding: between the lock-entry checkpoint and _admit
    # sit sync_pins + a catalog() DB round-trip — a cancel landing THERE must not let
    # _admit evict an innocent resident. The cancel is injected from inside the hooked
    # catalog_fn WHILE the router lock is held (i.e. inside the window itself); a test
    # injecting earlier passes even with the hole present.
    svc_ref = {}
    armed = threading.Event()  # armed only for the SECOND load — not B's seeding
    fired = []

    models = [_TEST_MODEL, _MODEL_B]

    def hooked_catalog():
        svc = svc_ref.get("svc")
        if svc is not None and armed.is_set() and svc._router_lock.locked() and not fired:
            fired.append(True)
            svc.stop(_TEST_MODEL.id)  # the cancel lands INSIDE the window
        return models

    svc = _service_for(tmp_path, catalog=models)
    svc._catalog_fn = hooked_catalog
    svc_ref["svc"] = svc

    admits = []
    orig_admit = svc._admit
    svc._admit = lambda *a, **k: (admits.append(a), orig_admit(*a, **k))

    # Seed an innocent resident B the eviction would target.
    svc.load(_MODEL_B.id)
    svc._thread.join(timeout=5)
    assert svc._resident[_MODEL_B.id]["status"] == "running"
    admits.clear()
    armed.set()

    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)

    assert admits == [], "_admit must never run for a cancelled load"
    assert svc._resident[_MODEL_B.id]["status"] == "running"   # the innocent survived
    assert svc._arbiter.is_reserved(_MODEL_B.id)
    assert _TEST_MODEL.id not in svc._resident


def test_cancel_during_download_leaves_no_ledger_entry(tmp_path):
    # The token path end-to-end through the download leg: stop() marks "cancelling"
    # (no pop), the fetch aborts via cancel_check, and the LOAD THREAD cleans up.
    svc_ref = {}

    def cancelling_acquire(repo, *a, cancel_check=None, **k):
        svc_ref["svc"].stop(_TEST_MODEL.id)         # the user cancels mid-download
        assert cancel_check is not None and cancel_check()
        raise DownloadCancelled()

    svc = _service_for(tmp_path)
    svc._acquire_model = cancelling_acquire
    svc_ref["svc"] = svc
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)

    assert _TEST_MODEL.id not in svc._resident
    assert not svc._arbiter.is_reserved(_TEST_MODEL.id)
    assert not svc._cancel_events
    assert svc.status().get("status") != "error"     # a cancel is never a failure


def test_stop_resident_confirm_unload_timeout_pops_and_warns(tmp_path, caplog):
    # Pathological branch: the router keeps reporting the model loaded after a
    # successful unload POST. The ledger must not wedge: bounded poll → WARNING → pop.
    clock = {"t": 0.0}

    def always_loaded(url):
        return {"object": "list", "data": [{"id": _TEST_MODEL.id, "status": {"value": "loaded"}}]}

    svc = _service_for(tmp_path, router_models=always_loaded,
                       now=lambda: clock["t"], sleep=lambda s: clock.__setitem__("t", clock["t"] + s))
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    with caplog.at_level(logging.WARNING, logger="llm_runner.runner.lifecycle"):
        svc.stop(_TEST_MODEL.id)
    assert _TEST_MODEL.id not in svc._resident
    assert any("confirm-unload timeout" in r.message for r in caplog.records)


def test_stop_compare_and_pop_spares_a_concurrent_fresh_load(tmp_path):
    # The panel's stop/auto-load race: a fresh load() (e.g. ensure_model_ready's
    # auto-load) lands while stop() is inside its unload — stop's final pop must
    # remove only ITS OWN "stopping" entry, never the fresh "downloading" one, else
    # the new load aborts at its checkpoint and its waiter dies at the 180 s timeout.
    unload_entered = threading.Event()
    unload_gate = threading.Event()
    state = {"unloaded": False}

    def gated_unload(url, mid):
        unload_entered.set()
        unload_gate.wait(5)
        state["unloaded"] = True

    def reactive_models(url):
        v = "unloaded" if state["unloaded"] else "loaded"
        return {"object": "list", "data": [{"id": _TEST_MODEL.id, "status": {"value": v}}]}

    svc = _service_for(tmp_path, router_unload=gated_unload, router_models=reactive_models)
    svc._router_load = lambda url, mid: state.__setitem__("unloaded", False)
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)

    stop_done = threading.Event()
    threading.Thread(target=lambda: (svc.stop(_TEST_MODEL.id), stop_done.set()), daemon=True).start()
    assert unload_entered.wait(5)

    # The concurrent fresh load arrives mid-stop and re-seeds the ledger entry.
    svc.load(_TEST_MODEL.id)
    unload_gate.set()
    assert stop_done.wait(10)
    svc._thread.join(timeout=10)

    st = svc._resident.get(_TEST_MODEL.id)
    assert st is not None, "stop() must not pop the fresh load's entry"
    assert st["status"] == "running"


# ── the router-listing mask (2026-07-17, the user's dead "Load now" button) ──
# The router's GET /models lists EVERY preset model, loaded or not (box-verified: the
# .ini catalog appears with status values like "unloaded"). resident() used to skip any
# in-flight `_resident` entry whose id the router already listed (`if mid in seen:
# continue`), so for the WHOLE pre-router phase of a load — disk check, fit, .ini emit,
# lock wait — the router's stale idle value won and the UI showed "Load now" as if the
# click did nothing. The user clicked three times; every click had already worked.

def test_resident_in_flight_load_outranks_router_idle_listing(tmp_path):
    def preset_listed_but_unloaded(url):
        return {"object": "list", "data": [{"id": _TEST_MODEL.id, "status": {"value": "unloaded"}}]}

    svc = _service_for(tmp_path, router_models=preset_listed_but_unloaded)
    svc._router = _fake_router()  # router alive, model listed idle
    svc._resident[_TEST_MODEL.id] = {"status": "downloading", "modelId": _TEST_MODEL.id}
    row = next(m for m in svc.resident()["models"] if m["id"] == _TEST_MODEL.id)
    assert row["status"] == "downloading"  # the mask reported "unloaded" here


def test_resident_error_outranks_router_idle_listing(tmp_path):
    # Same mask, error flavor: a load that failed AFTER the router was up (spawn refused)
    # leaves _resident="error" while the router still lists the model idle — the failure
    # (and its CTA) must not be hidden behind "unloaded".
    def preset_listed_but_unloaded(url):
        return {"object": "list", "data": [{"id": _TEST_MODEL.id, "status": {"value": "unloaded"}}]}

    svc = _service_for(tmp_path, router_models=preset_listed_but_unloaded)
    svc._router = _fake_router()
    svc._resident[_TEST_MODEL.id] = {"status": "error", "modelId": _TEST_MODEL.id, "error": "spawn refused"}
    row = next(m for m in svc.resident()["models"] if m["id"] == _TEST_MODEL.id)
    assert row["status"] == "error"


def test_resident_reports_stopping_while_router_still_says_loaded(tmp_path):
    # T2b — the ONE deliberate exception to the active-wins precedence: during a
    # teardown WE ordered, the router keeps reporting "loaded" until the child exits;
    # painting that re-invites the second Unload click (the user's unload-×3). The
    # "stopping" the stop() wrote must win the merge for its bounded window.
    entered = threading.Event()
    gate = threading.Event()

    def gated_unload(url, mid):
        entered.set()
        gate.wait(5)

    def still_loaded(url):
        return {"object": "list", "data": [{"id": _TEST_MODEL.id, "status": {"value": "loaded"}}]}

    # Virtual clock: the confirm-unload poll (router never agrees here) fast-forwards
    # to its bounded timeout instead of spending 5 real seconds.
    clock = {"t": 0.0}
    svc = _service_for(tmp_path, router_unload=gated_unload, router_models=still_loaded,
                       now=lambda: clock["t"],
                       sleep=lambda s: clock.__setitem__("t", clock["t"] + s))
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)

    stop_done = threading.Event()
    threading.Thread(target=lambda: (svc.stop(_TEST_MODEL.id), stop_done.set()), daemon=True).start()
    assert entered.wait(5)
    row = next(m for m in svc.resident()["models"] if m["id"] == _TEST_MODEL.id)
    assert row["status"] == "stopping"   # pre-T2b this read "loaded" — the flicker
    gate.set()
    assert stop_done.wait(10)


def test_resident_cancelling_outranks_router_idle_listing(tmp_path):
    # T2b: a mid-load cancel resolving ("cancelling") is in-flight state like any
    # other — it must not be masked by the router's idle preset listing.
    def preset_listed_but_unloaded(url):
        return {"object": "list", "data": [{"id": _TEST_MODEL.id, "status": {"value": "unloaded"}}]}

    svc = _service_for(tmp_path, router_models=preset_listed_but_unloaded)
    svc._router = _fake_router()
    svc._resident[_TEST_MODEL.id] = {"status": "cancelling", "modelId": _TEST_MODEL.id}
    row = next(m for m in svc.resident()["models"] if m["id"] == _TEST_MODEL.id)
    assert row["status"] == "cancelling"


def test_resident_router_active_state_beats_stale_in_flight(tmp_path):
    # Precedence must not flip the other way: once the child is genuinely loading/loaded,
    # the router's ACTIVE state is the truth — a not-yet-updated in-flight entry must not
    # mask a child that is really up.
    def child_loaded(url):
        return {"object": "list", "data": [{"id": _TEST_MODEL.id, "status": {"value": "loaded"}}]}

    svc = _service_for(tmp_path, router_models=child_loaded)
    svc._router = _fake_router()
    svc._resident[_TEST_MODEL.id] = {"status": "downloading", "modelId": _TEST_MODEL.id}
    row = next(m for m in svc.resident()["models"] if m["id"] == _TEST_MODEL.id)
    assert row["status"] == "loaded"


# ── load()/stop() telemetry (2026-07-17: the respawn hunt was blind because nothing
# logged WHO asked for a load — the file log had zero INFO lines to correlate) ──

def test_load_logs_its_trigger(tmp_path, caplog):
    svc = _service_for(tmp_path)
    with caplog.at_level(logging.INFO, logger="llm_runner.runner.lifecycle"):
        svc.load(_TEST_MODEL.id, trigger="ensure-ready")
        svc._thread.join(timeout=5)
    assert any("trigger=ensure-ready" in r.message and _TEST_MODEL.id in r.message
               for r in caplog.records)


def test_load_default_trigger_is_api_and_warm_noop_still_logs(tmp_path, caplog):
    # Every ask lands in the log — including the warm no-op (a resident model re-asked),
    # which is exactly the call a respawn hunt needs to see.
    svc = _service_for(tmp_path)
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    with caplog.at_level(logging.INFO, logger="llm_runner.runner.lifecycle"):
        svc.load(_TEST_MODEL.id)  # warm — returns without a new thread
    assert any("trigger=api" in r.message for r in caplog.records)


def test_stop_logs_the_ask(tmp_path, caplog):
    svc = _service_for(tmp_path)
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    with caplog.at_level(logging.INFO, logger="llm_runner.runner.lifecycle"):
        svc.stop(_TEST_MODEL.id)
    assert any("stop" in r.message and _TEST_MODEL.id in r.message for r in caplog.records)


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
    # An 8000 MB load onto a 10000 MB card with A(2000, LRU) + B(1000) resident evicts the LRU (A)
    # to make room; B (more recent) stays. _admit is exercised directly with an explicit budget.
    # (Sizes are GPU-scale on purpose — sub-_EVICT_MIN_MB reservations are deliberately skipped
    # by VRAM-driven eviction since 2026-07-11; see the tiny-embed test below.)
    unloaded = []
    arb = VramArbiter(hardware_fn=lambda: _fake_hw(10000))
    arb.reserve("A", 2000)   # older → the LRU
    arb.reserve("B", 1000)
    svc = _service_for(tmp_path, arbiter=arb, router_unload=lambda url, mid: unloaded.append(mid))
    svc._router = _fake_router()
    svc._resident = {"A": {"status": "running"}, "B": {"status": "running"}}
    svc._admit("C", 8000, models_max=5, hardware=_fake_hw(10000))
    assert unloaded == ["A"]                 # only the LRU evicted (2000 freed → 9000 ≥ 8000)
    assert not arb.is_reserved("A") and arb.is_reserved("B")


def test_admit_vram_eviction_skips_tiny_cpu_embed(tmp_path):
    # 2026-07-11: evicting a CPU-placed embed (~44 MB measured driver noise) can't make a
    # GPU model fit — a VRAM-driven eviction must skip it (proceed via the warning path),
    # keeping the warm embed child the RAG rail wants resident.
    unloaded = []
    arb = VramArbiter(hardware_fn=lambda: _fake_hw(8192))
    arb.reserve("cpu-embed", 44)   # unpinned — e.g. its pin was lost across a bounce
    svc = _service_for(tmp_path, arbiter=arb, router_unload=lambda url, mid: unloaded.append(mid))
    svc._router = _fake_router()
    svc._resident = {"cpu-embed": {"status": "running"}}
    svc._admit("big-moe", 16000, models_max=5, hardware=_fake_hw(8192), is_moe=True)
    assert unloaded == []                    # the tiny embed survived the over-budget admit
    assert arb.is_reserved("cpu-embed")
    # …but a COUNT-cap eviction still removes it (a child must go regardless of VRAM).
    svc._admit("third", 10, models_max=1, hardware=_fake_hw(8192))
    assert unloaded == ["cpu-embed"]


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
        probe=lambda url, p, n, model_id="": (256, 2000.0, None),  # 256 tokens in 2.0s → 128 tok/s
        sample=lambda: {"vramTotalMb": 8000, "ramTotalMb": 32000},
    )
    assert out["ok"] is True
    assert out["tokensPerSec"] == 128.0
    assert out["completionTokens"] == 256
    assert out["modelId"] == _TEST_MODEL.id
    assert out["vramTotalMb"] == 8000 and out["ramTotalMb"] == 32000


def test_measure_surfaces_draft_acceptance(tmp_path):
    # T3: when the probe reports draft timings (speculative decoding ran), measure exposes
    # draftN / draftNAccepted / draftAcceptance; absent draft → those keys are absent, not 0.
    svc = _service_for(tmp_path)
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    out = svc.measure(
        probe=lambda url, p, n, model_id="": (200, 1000.0, {"n": 173, "accepted": 104}),
        sample=dict,
    )
    assert out["draftN"] == 173 and out["draftNAccepted"] == 104
    assert out["draftAcceptance"] == round(104 / 173, 4)
    out2 = svc.measure(probe=lambda *a, **k: (200, 1000.0, None), sample=dict)
    assert "draftAcceptance" not in out2


def test_measure_falls_back_to_router_authority_when_ledger_stale(tmp_path):
    # 2026-07-21 (bench run 06-45-46): BOTH legs' measures refused ("no model running")
    # while the router was serving every feature run fine — the internal ledger had gone
    # stale/reconciled. Measure now consults the router's live view (the same authority
    # `resident()` reports) before refusing: loaded/sleeping → the probe proceeds; a model
    # the router doesn't list → the refusal stands.
    svc = _service_for(tmp_path)
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    # Stale ledger: the entry claims "starting" though the child serves fine.
    svc._resident[_TEST_MODEL.id]["status"] = "starting"
    svc._router_models = lambda url: {
        "object": "list",
        "data": [{"id": _TEST_MODEL.id, "status": {"value": "loaded"}}],
    }
    out = svc.measure(probe=lambda *a, **k: (100, 1000.0, None), sample=dict)
    assert out["ok"] is True and out["modelId"] == _TEST_MODEL.id
    # Truly absent from the router → still refused.
    svc._router_models = lambda url: {"object": "list", "data": []}
    out2 = svc.measure(probe=lambda *a, **k: (1, 1.0, None), sample=dict)
    assert out2["ok"] is False and "no model running" in out2["error"]


def test_measure_passes_model_id(tmp_path):
    # Router mode: the probe body carries the model id so the router dispatches right.
    seen = {}

    def probe(url, p, n, model_id=""):
        seen["mid"] = model_id
        return (1, 1000.0, None)

    svc = _service_for(tmp_path)
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    svc.measure(probe=probe, sample=dict)
    assert seen["mid"] == _TEST_MODEL.id


def test_measure_requires_running_model(tmp_path):
    svc = _service_for(tmp_path)  # never loaded → idle
    out = svc.measure(probe=lambda *a, **k: (1, 1.0, None), sample=dict)
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


# ── download-only (fetch weights, no spawn) — its OWN per-model channel, CONCURRENT ─
# The channel is a {modelId: entry} MAP now (concurrent downloads); a model ABSENT from
# download_status()["downloads"] is idle/done, and an "error" entry PERSISTS until replaced.

def _dl_map(svc):
    return svc.download_status()["downloads"]


def _await_download(svc, model_id, timeout=5):
    """Wait for a model's download-only op to SETTLE: absent (done/cancelled) or a persistent
    'error' entry. Robust to the worker popping its own thread ref — polls the status map rather
    than joining a thread that may already be gone. Returns the terminal entry (None if done)."""
    t = svc._download_threads.get(model_id)
    if t is not None:
        t.join(timeout=timeout)
    deadline = time.time() + timeout
    while time.time() < deadline:
        dl = _dl_map(svc)
        if model_id not in dl or dl[model_id]["status"] == "error":
            return dl.get(model_id)
        time.sleep(0.005)
    raise AssertionError(f"download for {model_id!r} did not settle within {timeout}s")


def _wait_until(pred, timeout=5):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if pred():
            return
        time.sleep(0.005)
    raise AssertionError("condition not met within timeout")


def _gated_acquire(gate, orig):
    """A fake `_acquire_model` that BLOCKS until `gate` is set (so a test can hold a download
    mid-flight), honouring cancel_check (→ DownloadCancelled). Delegates to `orig` for the real
    seeded snapshot path once released, so the rest of `_acquire_and_identify` runs normally."""
    def _acq(repo, *a, cancel_check=None, **k):
        while not gate.is_set():
            if cancel_check and cancel_check():
                raise DownloadCancelled()
            time.sleep(0.005)
        return orig(repo, *a, **k)
    return _acq


def test_download_only_fetches_no_spawn(tmp_path):
    # download() fetches the weights but does NOT spawn the router: its channel goes back to
    # idle (the model LEAVES the map), no router, and `start_router` is never called.
    started = {"hit": False}

    def spy_start(*a, **k):
        started["hit"] = True
        return _fake_router()

    svc = _service_for(tmp_path, start_router=spy_start)
    svc.download(_TEST_MODEL.id)
    _await_download(svc, _TEST_MODEL.id)
    assert _TEST_MODEL.id not in _dl_map(svc)          # download channel done (absent == idle)
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
    _await_download(svc, _TEST_MODEL.id)
    assert svc.status()["status"] == "running"          # run-state UNTOUCHED
    assert svc._router is not None                      # router still up
    assert _TEST_MODEL.id not in _dl_map(svc)           # download finished separately


def test_download_needs_no_engine(tmp_path):
    # Unlike load(), download() does NOT require the engine installed.
    svc = _service_for(tmp_path)
    svc._acquired_exe = lambda *a, **k: None
    svc.download(_TEST_MODEL.id)
    assert _await_download(svc, _TEST_MODEL.id) is None  # done, no error entry
    assert _TEST_MODEL.id not in _dl_map(svc)


def test_download_grounds_type_via_identify(tmp_path):
    seen = []
    svc = _service_for(tmp_path, identify_fn=lambda mid, path: seen.append(mid))
    svc.download(_TEST_MODEL.id)
    _await_download(svc, _TEST_MODEL.id)
    assert _TEST_MODEL.id not in _dl_map(svc)
    assert seen == [_TEST_MODEL.id]


def test_download_unknown_model_errors(tmp_path):
    svc = _service_for(tmp_path)
    svc.download("does-not-exist")
    entry = _await_download(svc, "does-not-exist")
    assert entry is not None and entry["status"] == "error"
    assert "unknown model" in entry["error"]


def test_verify_gguf_raises_corrupt_model_error_and_purges(tmp_path):
    # The integrity gate: a main GGUF whose header won't parse is purged (so the next
    # fetch re-downloads clean) and raised as an actionable CorruptModelError carrying the id.
    svc = _service_for(tmp_path)
    svc._read_meta = _raise_bad_magic
    model = svc.catalog()[0]
    repo_dir = tmp_path / "hf" / ("models--" + model.hf_repo.replace("/", "--"))
    gguf = repo_dir / "snapshots" / "sha" / f"model-{model.quant}.gguf"
    assert repo_dir.is_dir()
    with pytest.raises(CorruptModelError) as ei:
        svc._verify_gguf(model, gguf)
    assert ei.value.model_id == model.id
    assert "re-download" in str(ei.value).lower()
    assert not repo_dir.is_dir()  # weights purged → a clean re-fetch next time


def test_download_corrupt_gguf_surfaces_and_purges(tmp_path):
    # A download whose file fails the header check must NOT report success: the gate catches it
    # at download time (previously identify() swallowed it and the corruption only surfaced later,
    # bricking the router with a raw "bad magic"). The error is actionable; the weights are purged.
    svc = _service_for(tmp_path)
    svc._read_meta = _raise_bad_magic
    repo_dir = tmp_path / "hf" / ("models--" + _TEST_MODEL.hf_repo.replace("/", "--"))
    assert repo_dir.is_dir()
    svc.download(_TEST_MODEL.id)
    entry = _await_download(svc, _TEST_MODEL.id)
    assert entry is not None and entry["status"] == "error"
    assert "corrupted or incomplete" in entry["error"]
    assert not repo_dir.is_dir()


def test_download_cancel_returns_to_idle(tmp_path):
    # cancel_download(id) signals the in-flight worker (via cancel_check); a DownloadCancelled is
    # NOT an error — the entry LEAVES the map, run-state untouched.
    started = threading.Event()

    def blocking_acquire(repo, *a, cancel_check=None, **k):
        started.set()
        while not (cancel_check and cancel_check()):  # spin until the test signals cancel
            time.sleep(0.005)
        raise DownloadCancelled()

    svc = _service_for(tmp_path)
    svc._acquire_model = blocking_acquire
    svc.download(_TEST_MODEL.id)
    assert started.wait(timeout=5)                         # the worker reached acquire
    assert _dl_map(svc)[_TEST_MODEL.id]["status"] == "downloading"
    svc.cancel_download(_TEST_MODEL.id)
    _await_download(svc, _TEST_MODEL.id)
    assert _TEST_MODEL.id not in _dl_map(svc)              # cancelled → gone, not an error
    assert svc.status()["status"] == "idle"                # run-state never touched


def test_cancel_download_noop_when_idle(tmp_path):
    # Nothing downloading → cancel is a harmless no-op returning the (empty) map — both the
    # cancel-all (no id) and the per-id form.
    svc = _service_for(tmp_path)
    assert svc.cancel_download()["downloads"] == {}
    assert svc.cancel_download("does-not-exist")["downloads"] == {}


# ── CONCURRENT downloads (2026-07-20): the per-model map + the admission gate ──────

def test_two_downloads_run_concurrently(tmp_path):
    # Default limit (4) → both admitted at once: both present as "downloading" PAST "queued".
    gate = threading.Event()
    svc = _service_for(tmp_path, catalog=[_TEST_MODEL, _MODEL_B])
    svc._acquire_model = _gated_acquire(gate, svc._acquire_model)
    svc.download(_TEST_MODEL.id)
    svc.download(_MODEL_B.id)
    _wait_until(lambda: all(_dl_map(svc).get(m, {}).get("detail") == "model weights"
                            for m in (_TEST_MODEL.id, _MODEL_B.id)))
    dl = _dl_map(svc)
    for m in (_TEST_MODEL.id, _MODEL_B.id):
        assert dl[m]["status"] == "downloading" and dl[m]["detail"] != "queued"   # both RUNNING
    gate.set()                                             # release both → they settle
    _await_download(svc, _TEST_MODEL.id)
    _await_download(svc, _MODEL_B.id)
    assert _dl_map(svc) == {}


def test_download_max_concurrent_one_queues_the_second(tmp_path):
    # limit=1 → the second download stays "queued" until the first frees the slot.
    gate = threading.Event()
    svc = _service_for(tmp_path, catalog=[_TEST_MODEL, _MODEL_B])
    svc._config_fn = lambda: SimpleNamespace(download_max_concurrent=1)
    svc._acquire_model = _gated_acquire(gate, svc._acquire_model)
    svc.download(_TEST_MODEL.id)
    _wait_until(lambda: _dl_map(svc).get(_TEST_MODEL.id, {}).get("detail") == "model weights")
    svc.download(_MODEL_B.id)                              # A holds the only slot → B must queue
    time.sleep(0.1)
    assert _dl_map(svc)[_MODEL_B.id]["detail"] == "queued"        # still waiting behind A
    assert _dl_map(svc)[_MODEL_B.id]["status"] == "downloading"   # (queued IS a downloading entry)
    gate.set()                                            # A finishes → B is admitted → both settle
    _await_download(svc, _TEST_MODEL.id)
    _await_download(svc, _MODEL_B.id)
    assert _dl_map(svc) == {}


def test_cancel_one_download_leaves_the_other(tmp_path):
    gate = threading.Event()
    svc = _service_for(tmp_path, catalog=[_TEST_MODEL, _MODEL_B])
    svc._acquire_model = _gated_acquire(gate, svc._acquire_model)
    svc.download(_TEST_MODEL.id)
    svc.download(_MODEL_B.id)
    _wait_until(lambda: all(_dl_map(svc).get(m, {}).get("detail") == "model weights"
                            for m in (_TEST_MODEL.id, _MODEL_B.id)))
    svc.cancel_download(_TEST_MODEL.id)                    # cancel ONLY A
    _await_download(svc, _TEST_MODEL.id)
    assert _TEST_MODEL.id not in _dl_map(svc)             # A cancelled → gone
    assert _dl_map(svc)[_MODEL_B.id]["status"] == "downloading"   # B untouched, still running
    gate.set()
    _await_download(svc, _MODEL_B.id)


def test_delete_path_cancels_its_own_download(tmp_path):
    # delete_model_cache frees the handle first — cancels + joins THIS model's download.
    gate = threading.Event()
    svc = _service_for(tmp_path)
    svc._acquire_model = _gated_acquire(gate, svc._acquire_model)
    svc.download(_TEST_MODEL.id)
    _wait_until(lambda: _dl_map(svc).get(_TEST_MODEL.id, {}).get("detail") == "model weights")
    res = svc.delete_model_cache(_TEST_MODEL.id)          # cancels the in-flight download, then purges
    assert res["ok"] is True
    assert _TEST_MODEL.id not in _dl_map(svc)             # its download was cancelled + reaped


def test_error_entry_persists_and_is_replaced_by_fresh_download(tmp_path):
    svc = _service_for(tmp_path)
    svc._read_meta = _raise_bad_magic                     # → CorruptModelError at the verify gate
    repo_dir = tmp_path / "hf" / ("models--" + _TEST_MODEL.hf_repo.replace("/", "--"))
    svc.download(_TEST_MODEL.id)
    entry = _await_download(svc, _TEST_MODEL.id)
    assert entry["status"] == "error"
    assert _dl_map(svc)[_TEST_MODEL.id]["status"] == "error"     # the error entry PERSISTS in the map

    # A fresh download() REPLACES the error entry (idempotency only short-circuits a "downloading"
    # one). Re-seed good weights + meta so the replacement actually completes and leaves the map.
    snap = repo_dir / "snapshots" / "sha"
    snap.mkdir(parents=True, exist_ok=True)
    (snap / f"model-{_TEST_MODEL.quant}.gguf").write_bytes(b"x" * 1024)
    svc._read_meta = lambda p: SimpleNamespace(block_count=24, embedding_length=2048, is_moe=False, n_kv_heads=8)
    fresh = svc.download(_TEST_MODEL.id)
    assert fresh["status"] == "downloading"               # error → a fresh run, not rejected
    _await_download(svc, _TEST_MODEL.id)
    assert _TEST_MODEL.id not in _dl_map(svc)             # now succeeds → leaves the map


def test_delete_model_cache_removes_repo_dir(tmp_path):
    # The catalog 'Delete' also reclaims disk: the model's `models--<repo>` dir is removed.
    svc = _service_for(tmp_path)
    repo_dir = tmp_path / "hf" / ("models--" + _TEST_MODEL.hf_repo.replace("/", "--"))
    assert repo_dir.is_dir()                       # the fixture seeded the weights
    res = svc.delete_model_cache(_TEST_MODEL.id)
    assert res["ok"] is True and res["bytes"] > 0
    assert not repo_dir.exists()                   # weights removed from disk


def test_delete_model_cache_unknown_is_noop(tmp_path):
    # Unknown id (the row may already be gone) → idle no-op, never an error.
    svc = _service_for(tmp_path)
    res = svc.delete_model_cache("does-not-exist")
    assert res["ok"] is True and res["bytes"] == 0


def test_delete_model_cache_keeps_repo_shared_with_sibling(tmp_path):
    # Two catalog rows on the SAME repo: deleting one KEEPS the repo dir so the sibling's
    # weights survive (reported as kept, not freed).
    sibling = ModelEntry(id="sibling", name="Sibling", tier="mid",
                         hf_repo=_TEST_MODEL.hf_repo, quant="Q8_0")
    svc = _service_for(tmp_path, catalog=[_TEST_MODEL, sibling])
    repo_dir = tmp_path / "hf" / ("models--" + _TEST_MODEL.hf_repo.replace("/", "--"))
    res = svc.delete_model_cache(_TEST_MODEL.id)
    assert res["ok"] is True and res["bytes"] == 0
    assert "kept" in res.get("detail", "")
    assert repo_dir.is_dir()                        # sibling's weights untouched


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


def _win_cuda_hw():
    return HardwareInfo(os="windows", platform="windows", cpu_cores=8, ram_mb=32000,
                        gpus=[GpuInfo(vendor="NVIDIA", name="RTX 2070 SUPER", vram_mb=8192)],
                        runtimes={"cuda": True})


def test_engine_status_follows_disk_when_pin_reverted(tmp_path):
    # QC-13 (user's box, 2026-07-09): the Update flow installed b9929, a DB reset
    # reverted the pin to the seeded b9899, and the app said "Not installed" while
    # llamacpp/b9929/ sat on disk. The user's law: "check the path and if path exe
    # exist assume engine is installed" — and the version shown is the DISK's.
    from llm_runner import default_config
    from llm_runner.runner.binary import acquired_server_exe, build_num, variant_dir

    svc = _service_for(tmp_path, hardware_fn=_win_cuda_hw)
    svc._acquired_exe = acquired_server_exe  # the REAL disk probe (the factory stubs it)
    pinned = default_config().llamacpp.pinned_build
    disk_build = f"b{build_num(pinned) + 30}"  # b9899 → b9929
    d = variant_dir(svc.cache_root, disk_build, "cuda12")
    d.mkdir(parents=True)
    (d / "llama-server.exe").write_bytes(b"MZ")

    es = svc.engine_status()

    assert es["installed"] is True
    assert es["build"] == disk_build


def test_engine_uninstall_removes_disk_build_when_pin_reverted(tmp_path):
    # QC-13 companion: uninstall removes the build STATUS reports (the disk's),
    # not the reverted pin's absent folder.
    from llm_runner import default_config
    from llm_runner.runner.binary import acquired_server_exe, build_num, variant_dir

    svc = _service_for(tmp_path, hardware_fn=_win_cuda_hw)
    svc._acquired_exe = acquired_server_exe
    disk_build = f"b{build_num(default_config().llamacpp.pinned_build) + 30}"
    d = variant_dir(svc.cache_root, disk_build, "cuda12")
    d.mkdir(parents=True)
    (d / "llama-server.exe").write_bytes(b"MZ")

    out = svc.uninstall_engine()

    assert not (svc.cache_root / "llamacpp" / disk_build).exists()
    assert out["installed"] is False


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


def test_cancel_install_engine_returns_to_idle(tmp_path):
    # S1: a cancel during the engine build download (cancel_check threaded into
    # acquire_binary raises DownloadCancelled) is NOT an error — the engine returns to
    # the not-installed idle state, mirroring the model download's cancel.
    started = threading.Event()

    def blocking_acquire(*a, cancel_check=None, **k):
        started.set()
        while not (cancel_check and cancel_check()):  # spin until the test signals cancel
            time.sleep(0.005)
        raise DownloadCancelled()

    svc = _service_for(tmp_path)
    svc._acquire_binary = blocking_acquire
    svc.install_engine()
    assert started.wait(timeout=5)                        # the installer reached the download
    assert svc.engine_status()["status"] == "installing"
    svc.cancel_install_engine()
    svc._engine_thread.join(timeout=5)
    es = svc.engine_status()
    assert es["status"] == "idle"                         # cancelled → idle, not error
    assert es["error"] == ""


def test_cancel_install_engine_noop_when_idle(tmp_path):
    # S1: no install in flight → cancel is a harmless no-op reporting the idle channel.
    svc = _service_for(tmp_path)
    es = svc.cancel_install_engine()
    assert es["status"] == "idle"


def test_stop_during_load_download_aborts_without_error(tmp_path):
    # S2: with cancel_check wired at the load's weights download, a stop() during the
    # (unlocked) download aborts the fetch at the next chunk — the model leaves _resident
    # and the load must NOT set an error state (a user cancel, not a failure).
    started = threading.Event()

    def blocking_acquire(repo, *a, cancel_check=None, **k):
        started.set()
        while not (cancel_check and cancel_check()):  # spin until stop() pops the model
            time.sleep(0.005)
        raise DownloadCancelled()

    svc = _service_for(tmp_path)
    svc._acquire_model = blocking_acquire
    svc.load(_TEST_MODEL.id)
    assert started.wait(timeout=5)                        # the load is blocked mid-download
    svc.stop(_TEST_MODEL.id)                              # pop from _resident → cancel_check flips True
    svc._thread.join(timeout=5)
    st = svc.status()
    assert st["status"] != "error"                        # a cancel is not a failure
    assert st["status"] == "idle"
    assert _TEST_MODEL.id not in svc._resident


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


# ── QC-43b: ensure_model_ready (BLOCK until resident — the dispatch-path trigger) ──

def test_ensure_model_ready_noop_for_falsy_id(tmp_path):
    # A falsy model id (a run that resolved to a non-local / empty model) → immediate no-op.
    svc = _service_for(tmp_path)
    calls = []
    svc.load = lambda *a, **k: calls.append(a)  # type: ignore[method-assign]
    svc.ensure_model_ready("")
    assert calls == []                            # never kicked a load


def test_ensure_model_ready_noop_when_already_resident(tmp_path):
    # Already resident + child loaded → returns immediately WITHOUT re-loading.
    svc = _service_for(tmp_path)
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    assert svc.status()["status"] == "running"
    calls = []
    svc.load = lambda *a, **k: calls.append(a)  # type: ignore[method-assign]
    svc.ensure_model_ready(_TEST_MODEL.id)
    assert calls == []                            # fast path fired → no reload


def test_ensure_model_ready_loads_then_returns(tmp_path):
    # Not resident → drives the normal load path and BLOCKS until the child is loaded.
    # The poll yields the GIL each iteration (_yield_poll) so the background load thread
    # actually runs — a no-op sleep would busy-spin and starve it (see _yield_poll).
    svc = _service_for(tmp_path, sleep=_yield_poll)
    svc.ensure_model_ready(_TEST_MODEL.id, timeout_s=10)
    assert svc.status()["status"] == "running"
    assert svc._arbiter.is_reserved(_TEST_MODEL.id)   # went fully resident + reserved


def test_ensure_model_ready_raises_on_failed_load(tmp_path):
    # A child that reports 'failed' → the background load errors → ensure surfaces a
    # clear RuntimeError (not a silent hang / crash).
    def failed(url):
        return {"object": "list", "data": [{"id": _TEST_MODEL.id, "status": {"value": "failed"}}]}

    svc = _service_for(tmp_path, router_models=failed, sleep=_yield_poll)
    with pytest.raises(RuntimeError, match="failed to load"):
        svc.ensure_model_ready(_TEST_MODEL.id, timeout_s=10)


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


def _spy_compute_fit(monkeypatch):
    """Record every compute_fit kwargs dict, running the REAL function underneath."""
    from llm_runner.runner import lifecycle as lc

    calls: list[dict] = []
    real = lc.compute_fit

    def spy(*a, **kw):
        calls.append(kw)
        return real(*a, **kw)

    monkeypatch.setattr("llm_runner.runner.lifecycle.compute_fit", spy)
    return calls


def test_load_and_preview_charge_the_draft_to_the_fit(tmp_path, monkeypatch):
    # 2026-07-19: a draft is GPU-resident beside the main model, so EVERY fit site must
    # see it or the split over-books. Asserted as wiring (does compute_fit receive the
    # draft's meta + byte size) because this harness injects ONE read_meta shape for
    # every path, which makes the numeric delta degenerate here; the arithmetic itself
    # is pinned by test_runner.py::test_fit_draft_takes_layers_from_the_main_split.
    calls = _spy_compute_fit(monkeypatch)
    svc = _service_for(tmp_path, catalog=[_DRAFT_MODEL],
                       switches_fn=lambda mid: {"spec_type": "draft-mtp"})
    # PREVIEW with the draft not yet downloaded → no term (mirrors the emitter's strip)
    svc.preview_fit(_DRAFT_MODEL.id)
    assert calls[-1]["draft_meta"] is None and calls[-1]["draft_bytes"] == 0
    # …once it is on disk, the preview charges it — so the Tune modal matches the spawn
    snap = tmp_path / "hf" / "models--org--draft-GGUF" / "snapshots" / "sha"
    (snap / "MTP").mkdir(parents=True, exist_ok=True)
    (snap / "MTP" / "d-Q4_0-MTP.gguf").write_bytes(b"g" * 4096)
    svc.preview_fit(_DRAFT_MODEL.id)
    assert calls[-1]["draft_meta"] is not None and calls[-1]["draft_bytes"] == 4096
    # …and the ACTIVE load charges the draft it just acquired
    calls.clear()
    svc.load(_DRAFT_MODEL.id, switches={"spec_type": "draft-mtp"})
    svc._thread.join(timeout=5)
    assert svc.status()["status"] == "running"
    assert calls and all(c["draft_bytes"] == 4096 and c["draft_meta"] is not None for c in calls)


def test_passive_section_charges_its_cached_draft_to_the_fit(tmp_path, monkeypatch):
    # The third fit site: a PASSIVE .ini section carrying model-draft holds those bytes
    # too once the router loads it, so its fit must charge them as well.
    def auto_mtp(mid):
        return {"spec_type": "draft-mtp"} if mid == _DRAFT_MODEL.id else {}

    calls = _spy_compute_fit(monkeypatch)
    svc = _service_for(tmp_path, catalog=[_TEST_MODEL, _DRAFT_MODEL], switches_fn=auto_mtp)
    snap = tmp_path / "hf" / "models--org--draft-GGUF" / "snapshots" / "sha"
    (snap / "MTP").mkdir(parents=True, exist_ok=True)
    (snap / "MTP" / "d-Q4_0-MTP.gguf").write_bytes(b"g" * 4096)
    svc.load(_TEST_MODEL.id)  # the OTHER model loads → draft-model emits PASSIVELY
    svc._thread.join(timeout=5)
    assert any(c.get("draft_bytes") == 4096 for c in calls)      # the passive section
    assert any(c.get("draft_bytes") == 0 for c in calls)         # the draft-less loader


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


def test_ini_emit_strip_warns_when_draft_missing(tmp_path, caplog):
    # 2026-07-19: the strip is now LOUD. Emitting `spec-type = draft-mtp` with no
    # `model-draft` would hand llama-server a broken preset on a router bounce, so the
    # emitter drops spec AND warns, naming the model id — the escape must be proven to
    # FIRE (after the one-acquire change a missing draft is a CORNER case, not normal).
    def auto_mtp_switches(mid):
        return {"spec_type": "draft-mtp"} if mid == _DRAFT_MODEL.id else {}

    svc = _service_for(tmp_path, catalog=[_DRAFT_MODEL, _TEST_MODEL],
                       switches_fn=auto_mtp_switches)  # draft file NOT created
    with caplog.at_level(logging.WARNING, logger="llm_runner.runner.lifecycle"):
        svc.load(_TEST_MODEL.id)  # the OTHER model loads → draft-model emits passively
        svc._thread.join(timeout=5)
    assert any("MTP is OFF for this router section" in r.message and _DRAFT_MODEL.id in r.message
               for r in caplog.records)


# ── Download (own channel) acquires the draft too — one acquire path (2026-07-19) ──

def test_download_acquires_both_legs_for_mtp(tmp_path):
    # The Download button now fetches the external MTP draft too, so "Downloaded ✓" is
    # honest and the first load never surprise-fetches. Two acquire calls in order (main
    # quant, then the draft file), and the draft leg's phase shows in download_state.
    svc = _service_for(tmp_path, catalog=[_DRAFT_MODEL],
                       switches_fn=lambda mid: {"spec_type": "draft-mtp"})
    snap = tmp_path / "hf" / "models--org--draft-GGUF" / "snapshots" / "sha"
    real = svc._acquire_model
    calls, details = [], []

    def spy(repo, second, *a, on_progress=None, **k):
        calls.append((repo, second))
        if second == _DRAFT_MODEL.mtp_draft_file:      # the draft leg → plant the file
            (snap / "MTP").mkdir(parents=True, exist_ok=True)
            (snap / "MTP" / "d-Q4_0-MTP.gguf").write_bytes(b"g" * 64)
        if on_progress:
            on_progress(512, 1024)                     # a real chunk → the leg's phase writes
        details.append(_dl_map(svc).get(_DRAFT_MODEL.id, {}).get("detail"))
        return real(repo, second, *a, **k)

    svc._acquire_model = spy
    svc.download(_DRAFT_MODEL.id)
    _await_download(svc, _DRAFT_MODEL.id)

    assert _DRAFT_MODEL.id not in _dl_map(svc)          # completed cleanly (absent == done)
    assert calls == [(_DRAFT_MODEL.hf_repo, _DRAFT_MODEL.quant),
                     (_DRAFT_MODEL.hf_repo, _DRAFT_MODEL.mtp_draft_file)]
    assert "MTP draft model" in details


def test_download_single_acquire_when_no_draft_wanted(tmp_path):
    # spec_type=draft-mtp but the model declares NO draft file → _wants_draft is False →
    # exactly ONE acquire (the "or no mtp_draft_file" arm of the predicate).
    svc = _service_for(tmp_path, catalog=[_TEST_MODEL],
                       switches_fn=lambda mid: {"spec_type": "draft-mtp"})
    calls = []
    real = svc._acquire_model

    def spy(repo, second, *a, **k):
        calls.append((repo, second))
        return real(repo, second, *a, **k)

    svc._acquire_model = spy
    svc.download(_TEST_MODEL.id)
    _await_download(svc, _TEST_MODEL.id)

    assert _TEST_MODEL.id not in _dl_map(svc)
    assert calls == [(_TEST_MODEL.hf_repo, _TEST_MODEL.quant)]


def test_download_cancel_during_draft_leg_returns_to_idle(tmp_path):
    # A cancel during the SECOND (draft) leg aborts via cancel_check (which now covers
    # BOTH legs) → DownloadCancelled → the channel returns to idle (a user cancel is
    # never an error).
    svc = _service_for(tmp_path, catalog=[_DRAFT_MODEL],
                       switches_fn=lambda mid: {"spec_type": "draft-mtp"})
    real = svc._acquire_model

    def spy(repo, second, *a, cancel_check=None, **k):
        if second == _DRAFT_MODEL.mtp_draft_file:      # the draft leg
            svc.cancel_download(_DRAFT_MODEL.id)         # the user cancels mid-draft
            assert cancel_check is not None and cancel_check()
            raise DownloadCancelled()
        return real(repo, second, *a, **k)

    svc._acquire_model = spy
    svc.download(_DRAFT_MODEL.id)
    _await_download(svc, _DRAFT_MODEL.id)

    assert _DRAFT_MODEL.id not in _dl_map(svc)          # cancelled → gone (a user cancel is not an error)


# ── model_downloaded: the badge counts the draft when the config wants it ─────────

def test_model_downloaded_false_when_wanted_draft_missing_then_true(tmp_path):
    hf_cache = tmp_path / "hf"
    svc = _service_for(tmp_path, catalog=[_DRAFT_MODEL],
                       switches_fn=lambda mid: {"spec_type": "draft-mtp"})
    # Main weights cached (harness seeds them) but the wanted draft is absent → False.
    assert svc.model_downloaded(_DRAFT_MODEL, hf_cache) is False
    # Plant the draft → both legs cached → True.
    snap = hf_cache / "models--org--draft-GGUF" / "snapshots" / "sha"
    (snap / "MTP").mkdir(parents=True, exist_ok=True)
    (snap / "MTP" / "d-Q4_0-MTP.gguf").write_bytes(b"g" * 64)
    assert svc.model_downloaded(_DRAFT_MODEL, hf_cache) is True


def test_model_downloaded_true_when_draft_not_wanted(tmp_path):
    hf_cache = tmp_path / "hf"
    # spec off → the draft isn't wanted, so a present main GGUF is "downloaded" even
    # though the model declares a draft file that was never fetched.
    svc = _service_for(tmp_path, catalog=[_DRAFT_MODEL], switches_fn=lambda mid: {})
    assert svc.model_downloaded(_DRAFT_MODEL, hf_cache) is True


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


def test_main_gguf_resolves_quant_word_bounded(tmp_path):
    # The load-path resolver must pick the file for the EXACT quant token — with a
    # PQ2_0 co-cached beside Q2_0, a plain substring match (+ sort) would return the
    # PQ2_0 file ('p' < 'q') and load the WRONG weights. `_main_gguf` is boundary-aware.
    snap = tmp_path / "snap"
    snap.mkdir()
    (snap / "Ternary-Bonsai-27B-PQ2_0.gguf").write_bytes(b"x")
    (snap / "Ternary-Bonsai-27B-Q2_0.gguf").write_bytes(b"x")
    # `_main_gguf` does not touch self — call it unbound to avoid the heavy service fixture.
    got = RunnerService._main_gguf(None, snap, "Q2_0")
    assert got.name == "Ternary-Bonsai-27B-Q2_0.gguf"
    got_pq = RunnerService._main_gguf(None, snap, "PQ2_0")
    assert got_pq.name == "Ternary-Bonsai-27B-PQ2_0.gguf"


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


def test_fit_placed_unfixable_fails_fast_without_bounce(tmp_path):
    # 1b-F4 guard: a FIT-PLACED load whose spawn log shows an UNFIXABLE error (a rejected CLI
    # flag / unknown architecture) must fail FAST — re-emitting with explicit placement can't
    # fix it, and a bounce would knock down every healthy co-resident model. So the engine
    # spawns EXACTLY ONCE (no retry bounce), unlike the empty-tail case above (which bounces once).
    spawns = {"n": 0}

    paths = {}

    def unfixable_router(*a, **k):
        spawns["n"] += 1
        paths["log"] = k.get("log_path")
        return _fake_router()

    def reject_load(url, mid):
        # The engine rejects the flag DURING this attempt — after the POST watermark
        # (a spawn-time write would be pre-watermark and correctly ignored).
        lp = paths.get("log")
        if lp:
            Path(lp).parent.mkdir(parents=True, exist_ok=True)
            with open(lp, "a", encoding="utf-8") as f:
                f.write("error: invalid argument: --no-such-flag\n")

    def always_failed(url):
        return {"object": "list", "data": [{"id": _TEST_MODEL.id, "status": {"value": "failed"}}]}

    svc = _service_for(tmp_path, start_router=unfixable_router,
                       router_load=reject_load, router_models=always_failed)
    svc.load(_TEST_MODEL.id)  # fit-placed (ngl omitted)
    svc._thread.join(timeout=5)
    assert svc.status()["status"] == "error"
    assert spawns["n"] == 1   # spawned once, NO fit-placed retry bounce on an unfixable failure


def test_fit_placed_stale_log_line_does_not_suppress_retry(tmp_path):
    # Watermark fires-proof (2026-07-21): an unfixable-looking line ALREADY in the router
    # log (an earlier model's failure, written before this attempt's POST watermark) must
    # NOT suppress the fit-placed explicit retry — only THIS attempt's appended lines
    # count. On the pre-watermark code this FAILS: the whole-log tail matched the stale
    # line and the load fail-fasted with spawns == 1.
    spawns = {"n": 0}

    def stale_router(*a, **k):
        spawns["n"] += 1
        lp = k.get("log_path")
        if lp and spawns["n"] == 1:  # the STALE line exists before the first POST
            Path(lp).parent.mkdir(parents=True, exist_ok=True)
            Path(lp).write_text("error: invalid argument: --from-a-previous-model\n")
        return _fake_router()

    def always_failed(url):
        return {"object": "list", "data": [{"id": _TEST_MODEL.id, "status": {"value": "failed"}}]}

    svc = _service_for(tmp_path, start_router=stale_router, router_models=always_failed)
    svc.load(_TEST_MODEL.id)  # fit-placed
    svc._thread.join(timeout=5)
    assert svc.status()["status"] == "error"
    assert spawns["n"] == 2   # the explicit retry STILL happened — the stale line was ignored


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


# ── QC-25: the update check + pin follow the DISK; the pin heals upward at
#    BOOT + POST-INSTALL only — never on a status poll ─────────────────────────

def _newer_disk_build(cache_root, offset=35):
    """Put a build NEWER than the seed pin on disk (the user's reset-regression
    shape: pin reseeded to b9899 while the installed b9934 sits in llamacpp/)."""
    from llm_runner import default_config
    from llm_runner.runner.binary import build_num, variant_dir

    disk_build = f"b{build_num(default_config().llamacpp.pinned_build) + offset}"
    d = variant_dir(cache_root, disk_build, "cuda12")
    d.mkdir(parents=True, exist_ok=True)
    (d / "llama-server.exe").write_bytes(b"MZ")
    return disk_build


def test_update_check_reports_disk_build_when_pin_reverted(tmp_path):
    # QC-25 (user's box, 2026-07-09): a DB reset reverted the pin under an
    # installed newer build and the app offered an "update" TO the build already
    # installed — clicking it would have re-fetched the OLD pin and the stale-
    # build sweep would then delete the newer engine. `current` must be the
    # DISK's build; latest == disk ⇒ no update offered.
    from llm_runner.runner.binary import acquired_server_exe

    svc = _service_for(tmp_path, hardware_fn=_win_cuda_hw)
    svc._acquired_exe = acquired_server_exe
    disk_build = _newer_disk_build(svc.cache_root)
    svc._latest_build_fn = lambda: disk_build

    out = svc.update_check()

    assert out["current"] == disk_build
    assert out["updateAvailable"] is False and out["error"] == ""


def test_update_check_pin_fallback_when_nothing_installed(tmp_path):
    # Nothing on disk → `current` falls back to the pin (the build an install
    # would fetch), and a newer upstream still reports available.
    svc = _service_for(tmp_path, hardware_fn=_win_cuda_hw)
    svc._acquired_exe = lambda *a, **k: None
    svc._latest_build_fn = lambda: "b99999"

    out = svc.update_check()

    assert out["current"] == svc._config_fn().llamacpp.pinned_build
    assert out["updateAvailable"] is True


def test_update_check_deliberate_pin_bump_still_reports(tmp_path):
    # The Update flow writes pinnedBuild=latest BEFORE installing (useEngine
    # updateToLatest): with the pin bumped above the installed build, `current`
    # stays the DISK build and the newer latest still reports available — the
    # bump must not mask the update it is about to perform.
    from llm_runner import default_config
    from llm_runner.runner.binary import acquired_server_exe, build_num

    svc = _service_for(tmp_path, hardware_fn=_win_cuda_hw)
    svc._acquired_exe = acquired_server_exe
    disk_build = _newer_disk_build(svc.cache_root)
    bumped = f"b{build_num(disk_build) + 10}"

    def cfg():
        c = default_config()
        c.llamacpp.pinned_build = bumped
        return c

    svc._config_fn = cfg
    svc._latest_build_fn = lambda: bumped

    out = svc.update_check()

    assert out["current"] == disk_build
    assert out["updateAvailable"] is True


def test_deliberate_downgrade_survives_install(tmp_path):
    # The user deliberately pins an OLDER build and clicks Reinstall: the
    # install fetches the pin, the sweep removes the newer dir, and NOTHING
    # rewrites the pin behind the user's back (the QC-25 heal is GONE —
    # 2026-07-21, the one-source collapse: the pin is only ever user-written).
    from llm_runner import default_config
    from llm_runner.runner.binary import acquired_server_exe, build_num, variant_dir

    svc = _service_for(tmp_path, hardware_fn=_win_cuda_hw)
    svc._acquired_exe = acquired_server_exe
    newer = _newer_disk_build(svc.cache_root)
    older = f"b{build_num(default_config().llamacpp.pinned_build) - 50}"
    state = {"pin": older}

    def cfg():
        c = default_config()
        c.llamacpp.pinned_build = state["pin"]
        return c

    svc._config_fn = cfg

    def fake_acquire(cache_root, config, hardware, on_progress=None, gpu=None, cancel_check=None):
        d = variant_dir(cache_root, config.llamacpp.pinned_build, "cuda12")
        d.mkdir(parents=True, exist_ok=True)
        (d / "llama-server.exe").write_bytes(b"MZ")
        return d / "llama-server.exe"

    svc._acquire_binary = fake_acquire
    svc.install_engine(force=True)
    svc._engine_thread.join(timeout=5)

    assert svc._engine_state["status"] == "installed"
    assert state["pin"] == older                                   # downgrade survived
    assert not (svc.cache_root / "llamacpp" / newer).exists()      # sweep removed the newer
    assert svc.engine_status()["build"] == older


# ── #274 half 2 (2026-07-11): the embed CPU-placement guarantee ───────────────
# The pick rule (ui modelPick.pickBestEmbedId) chooses WHICH embed rides a box assuming
# small embeds run on CPU; these pin the runner-side half that ENFORCES it at load time
# (the 2026-07-11 incident: a full-GPU 32k-ctx embed co-loaded beside the chat model).

_EMBED_CPU = ModelEntry(id="embed-small", name="Small Embed", tier="cpu",
                        hf_repo="org/embed-small-GGUF", quant="Q8_0", pooling="last",
                        embedding=True, recommended_for=RecommendedFor(min_vram_mb=1500))
_EMBED_MID = ModelEntry(id="embed-4b", name="Mid Embed", tier="mid",
                        hf_repo="org/embed-4b-GGUF", quant="Q4_K_M", pooling="last",
                        embedding=True, recommended_for=RecommendedFor(min_vram_mb=4500))
_CHAT_26B = ModelEntry(id="chat-26b", name="Chat", tier="low-vram-moe",
                       hf_repo="org/chat-GGUF", quant="Q4_K_XL",
                       recommended_for=RecommendedFor(min_vram_mb=6000))


def test_embed_tier_cpu_forced_to_ngl0(tmp_path):
    # tier "cpu" (the ROUND-4 law: deliberately CPU on the user's box) → the section
    # carries an EXPLICIT n-gpu-layers = 0 + the capped embed ctx. Fit-by-omission
    # would hand the child the GPU — exactly the 2026-07-11 co-load crash.
    svc = _service_for(tmp_path, catalog=[_EMBED_CPU], embedding_ids_fn=lambda: {_EMBED_CPU.id},
                       hardware_fn=lambda: _fake_hw(8192))
    svc.load(_EMBED_CPU.id)
    svc._thread.join(timeout=5)
    ini = _ini(svc)
    assert "n-gpu-layers = 0" in ini
    assert "ctx-size = 8192" in ini  # _EMBED_CTX_CAP — never a chat-sized KV pool


def test_embed_leftover_gates_gpu_placement(tmp_path):
    # A non-cpu-tier embed rides the GPU only when the STATIC leftover (card minus the
    # LOCAL chat default's curated floor) covers its own floor — else explicit CPU.
    # Static, not live free VRAM: the ask flow loads the embed BEFORE the chat model.
    def build(vram_mb):
        return _service_for(tmp_path / str(vram_mb), catalog=[_EMBED_MID, _CHAT_26B],
                            embedding_ids_fn=lambda: {_EMBED_MID.id},
                            default_llm_id_fn=lambda: _CHAT_26B.id,
                            hardware_fn=lambda: _fake_hw(vram_mb))

    svc = build(8192)   # leftover 8192-6000 = 2192 < 4500 → CPU
    svc.load(_EMBED_MID.id)
    svc._thread.join(timeout=5)
    section = _ini(svc).split(f"[{_EMBED_MID.id}]", 1)[1].split("\n[", 1)[0]
    assert "n-gpu-layers = 0" in section

    svc = build(24576)  # leftover 18576 >= 4500 → GPU (fit-placed → NO explicit ngl)
    svc.load(_EMBED_MID.id)
    svc._thread.join(timeout=5)
    section = _ini(svc).split(f"[{_EMBED_MID.id}]", 1)[1].split("\n[", 1)[0]
    assert "n-gpu-layers" not in section


def test_embed_explicit_tune_ngl_wins_over_policy(tmp_path):
    # A user tune's explicit ngl beats the placement policy (power-user escape hatch).
    svc = _service_for(tmp_path, catalog=[_EMBED_CPU], embedding_ids_fn=lambda: {_EMBED_CPU.id},
                       switches_fn=lambda mid: {"n_gpu_layers": "10"},
                       hardware_fn=lambda: _fake_hw(8192))
    svc.load(_EMBED_CPU.id)
    svc._thread.join(timeout=5)
    assert "n-gpu-layers = 10" in _ini(svc)


def test_non_embed_untouched_by_placement(tmp_path):
    # A chat model (embedding=False) is NEVER forced to CPU by the embed policy.
    svc = _service_for(tmp_path, hardware_fn=lambda: _fake_hw(8192))
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    assert "n-gpu-layers = 0" not in _ini(svc)


# ── 2026-07-11 fail-fast: a dead child must not be polled to the deadline ────

def test_confirm_load_fails_fast_on_child_exit_line(tmp_path):
    # A crashed child can leave the router reporting `loading` forever (the brick) —
    # the confirm must fail on the router log's own death line, not poll a corpse to
    # the full deadline (~6.5 minutes observed live on 2026-07-11).
    def stuck(url):
        return {"object": "list", "data": [{"id": _TEST_MODEL.id, "status": {"value": "loading"}}]}

    svc = _service_for(tmp_path, router_models=stuck, sleep=lambda s: None)
    svc._router = _fake_router()
    log_file = tmp_path / "router.log"
    log_file.write_text("spawning...\ninstance name=test-model exited with status 1\n")
    svc._last_log_path = log_file
    assert svc._confirm_load(_TEST_MODEL.id, log_offset=0) == "failed"


def test_confirm_load_ignores_exit_line_before_watermark(tmp_path):
    # A death line from a PREVIOUS attempt (before this load's log watermark) must not
    # fail THIS load — the scan starts at the offset captured at POST time.
    def stuck(url):
        return {"object": "list", "data": [{"id": _TEST_MODEL.id, "status": {"value": "loading"}}]}

    svc = _service_for(tmp_path, router_models=stuck, sleep=lambda s: None)
    svc._router = _fake_router()
    log_file = tmp_path / "router.log"
    log_file.write_text("instance name=test-model exited with status 1\n")
    svc._last_log_path = log_file
    clock = iter([0.0, 1e9])  # deadline snapshot, then a poll far past it
    svc._now = lambda: next(clock)
    assert svc._confirm_load(_TEST_MODEL.id, log_offset=log_file.stat().st_size) == "timeout"


def test_confirm_load_treats_error_value_as_failed(tmp_path):
    # A router that reports `error` (not just `failed`) is terminal too.
    def err(url):
        return {"object": "list", "data": [{"id": _TEST_MODEL.id, "status": {"value": "error"}}]}

    svc = _service_for(tmp_path, router_models=err, sleep=lambda s: None)
    svc._router = _fake_router()
    assert svc._confirm_load(_TEST_MODEL.id) == "failed"


# ── 2026-07-11 ledger honesty: fresh-spawn reconcile + measured true-up ──────

def test_fresh_spawn_reconciles_stale_ledger(tmp_path):
    # A router that died OUTSIDE stop() leaves resident entries + reservations behind;
    # the fresh spawn must drop them (live: a ghost embed kept ~3.6 GB booked and the
    # header read 19.3/8.0 GB with 0 free).
    arb = VramArbiter()
    svc = _service_for(tmp_path, arbiter=arb, hardware_fn=lambda: _fake_hw(8192))
    svc._resident["ghost-embed"] = {"status": "running"}
    arb.reserve("ghost-embed", 3600, pinned=True)
    svc.load(_TEST_MODEL.id)
    svc._thread.join(timeout=5)
    assert svc.status()["status"] == "running"
    assert "ghost-embed" not in svc._resident
    assert not arb.is_reserved("ghost-embed")
    assert arb.is_reserved(_TEST_MODEL.id)


def test_trued_up_trues_down_to_measured(tmp_path):
    # 2026-07-11 inversion: the ncmoe-blind estimate (Gemma: ~16 GB claimed, ~6.5 GB
    # real) must not wedge the ledger — the measured delta wins in BOTH directions.
    svc = _service_for(tmp_path, used_vram_fn=lambda: 7500)
    assert svc._trued_up_vram_mb(16000, before=1000, hardware=_fake_hw(8192)) == 6500


def test_trued_up_unmeasurable_caps_at_card(tmp_path):
    # No probe → the estimate survives, but a single child can never book more than
    # the card itself.
    svc = _service_for(tmp_path)  # used_vram_fn → None (unmeasurable)
    assert svc._trued_up_vram_mb(16000, before=None, hardware=_fake_hw(8192)) == 8192


def test_trued_up_keeps_driver_ctx_floor(tmp_path):
    # The 2026-07-06 motivation survives the inversion: a GPU-claiming fit whose delta
    # under-counts still books at least the driver-context constant, never ~0.
    svc = _service_for(tmp_path, used_vram_fn=lambda: 5001)
    assert svc._trued_up_vram_mb(4000, before=5000, hardware=_fake_hw(8192)) == 549


# ── 2026-07-11 admission: refuse a DOOMED dense/explicit spawn ────────────────

def test_admit_refuses_dense_explicit_when_only_pinned(tmp_path):
    # The proceed-anyway safety net is a lie for a DENSE entry with EXPLICIT ngl — the
    # child's `--fit` aborts on a user-set ngl and the spawn dies (live 2026-07-11:
    # `invalid vector subscript` on the draft load). Refuse actionably instead.
    arb = VramArbiter()
    svc = _service_for(tmp_path, arbiter=arb, hardware_fn=lambda: _fake_hw(8192))
    arb.reserve("pinned-embed", 8000, pinned=True)
    svc._resident["pinned-embed"] = {"status": "running"}
    with pytest.raises(RuntimeError, match="Not enough free VRAM"):
        svc._admit(_TEST_MODEL.id, 7000, 2, _fake_hw(8192), ngl_explicit=True, is_moe=False)
    # a MoE (its estimate over-books — no ncmoe term) and a fit-placed entry proceed
    svc._admit(_TEST_MODEL.id, 7000, 2, _fake_hw(8192), ngl_explicit=True, is_moe=True)
    svc._admit(_TEST_MODEL.id, 7000, 2, _fake_hw(8192), ngl_explicit=False, is_moe=False)


# ── 2026-07-11 hardening: transient IO is NOT corruption — no purge ──────────

def test_verify_gguf_locked_file_no_purge(tmp_path):
    # A sharing violation / AV scan holding the file open must NOT purge multi-GB good
    # weights: retryable error, nothing deleted. (Purge stays for parse-proven
    # corruption — see test_verify_gguf_raises_corrupt_model_error_and_purges.)
    svc = _service_for(tmp_path)

    def _locked(_p):
        raise PermissionError(13, "sharing violation")

    svc._read_meta = _locked
    model = svc.catalog()[0]
    repo_dir = tmp_path / "hf" / ("models--" + model.hf_repo.replace("/", "--"))
    gguf = repo_dir / "snapshots" / "sha" / f"model-{model.quant}.gguf"
    assert repo_dir.is_dir()
    with pytest.raises(RuntimeError, match="locked"):
        svc._verify_gguf(model, gguf)
    assert repo_dir.is_dir()  # weights NOT deleted


# ── 2026-07-12: an embed SWITCH swaps the embed slot — the chat model never pays ──

def test_embed_switch_evicts_replaced_embed_not_chat(tmp_path):
    # Live repro: switching the embedding default 0.6B→4B auto-loaded the 4B; the OLD
    # embed's STALE load-time pin deflected the models_max=2 count-cap eviction onto
    # Gemma. Pins must re-sync to the live default and the replaced embed must be the
    # preferred victim.
    old_embed = ModelEntry(id="embed-old", name="Old Embed", tier="cpu",
                           hf_repo="org/embed-old-GGUF", quant="Q8_0", pooling="last",
                           embedding=True, recommended_for=RecommendedFor(min_vram_mb=1500))
    unloaded = []
    arb = VramArbiter()
    svc = _service_for(tmp_path, catalog=[_EMBED_CPU, old_embed], arbiter=arb,
                       embedding_ids_fn=lambda: {_EMBED_CPU.id},   # the NEW default
                       router_unload=lambda url, mid: unloaded.append(mid),
                       hardware_fn=lambda: _fake_hw(8192))
    svc._router = _fake_router()
    # Pre-switch world: the chat is the LRU (the pre-fix victim), the old embed still
    # carries the pin it earned when IT was the default.
    arb.reserve("chat-26b", 5900)
    arb.reserve(old_embed.id, 550, pinned=True)
    svc._resident["chat-26b"] = {"status": "running"}
    svc._resident[old_embed.id] = {"status": "running"}

    svc.load(_EMBED_CPU.id)   # the dropdown switch's auto-load (models_max default = 2)
    svc._thread.join(timeout=5)

    assert unloaded == [old_embed.id]          # the REPLACED embed went, not the chat
    assert arb.is_reserved("chat-26b")
    assert arb.is_reserved(_EMBED_CPU.id)
    row = next(r for r in arb.snapshot()["reservations"] if r["key"] == _EMBED_CPU.id)
    assert row["pinned"] is True               # protection followed the new default


def test_embed_leftover_falls_back_to_downloaded_chat_floor(tmp_path):
    # Plan-A boxes leave the routing default LLM empty (task presets rule) - the
    # baseline then falls back to the largest-floor DOWNLOADED chat model, so a
    # mid-tier embed still lands on CPU beside the box's real chat model.
    svc = _service_for(tmp_path, catalog=[_EMBED_MID, _CHAT_26B],
                       embedding_ids_fn=lambda: {_EMBED_MID.id},
                       hardware_fn=lambda: _fake_hw(8192))  # no default_llm_id_fn
    svc.load(_EMBED_MID.id)
    svc._thread.join(timeout=5)
    section = _ini(svc).split(f"[{_EMBED_MID.id}]", 1)[1].split("\n[", 1)[0]
    assert "n-gpu-layers = 0" in section


# ── 2026-07-12: embed switch must NOT churn the .ini (Fix A) ──────────────────

def test_ini_stable_across_embed_default_switch(tmp_path):
    # Switching the embedding default moved the `embeddings = true` marker between
    # sections → the .ini text changed → _bounce_router reloaded Gemma + the incoming
    # embed at once → Gemma's MTP draft crashed on the co-load. All embed sections are
    # now marked regardless of which is the default, so the .ini is byte-stable across a
    # switch (no bounce, the chat model never disturbed).
    active = {"id": _EMBED_CPU.id}
    svc = _service_for(tmp_path, catalog=[_EMBED_CPU, _EMBED_MID, _CHAT_26B],
                       embedding_ids_fn=lambda: {active["id"]},
                       hardware_fn=lambda: _fake_hw(8192))
    svc._last_ini_text = ""
    svc._emit_ini()
    ini_a = _ini(svc)
    active["id"] = _EMBED_MID.id      # the user switches the default embed
    svc._last_ini_text = ""           # force a rewrite so we compare the RESOLVED text
    svc._emit_ini()
    ini_b = _ini(svc)
    assert ini_a == ini_b             # byte-identical → no bounce on switch
    assert ini_a.count("embeddings = true") == 2   # BOTH embeds marked, not just the default
    assert "[chat-26b]" in ini_a and "embeddings = true" not in \
        ini_a.split("[chat-26b]", 1)[1].split("\n[", 1)[0]  # the chat section is not an embed


# ── 2026-07-12: MTP draft co-load crash recovers WITHOUT dropping MTP (Fix B) ──

_GEMMA_MTP = ModelEntry(id="gemma-4-26b-a4b-qat", name="Gemma", tier="low-vram-moe",
                        hf_repo="org/gemma-GGUF", quant="Q4_K_XL",
                        recommended_for=RecommendedFor(min_vram_mb=6000))


def _mtp_entry():
    ov = Overrides(spec_type="draft-mtp", spec_n_max=2, model_draft="/x/mtp-draft.gguf")
    return ModelIniEntry(model_id=_GEMMA_MTP.id, gguf_path="/x/gemma.gguf",
                         n_gpu_layers=30, n_cpu_moe=21, ctx_len=32768, overrides=ov)


def _mtp_fit():
    return FitPlan(n_gpu_layers=30, n_cpu_moe=21, ctx_len=32768, block_count=48,
                   is_moe=True, vram_mb=6000, ngl_explicit=True, ncmoe_explicit=True,
                   ctx_explicit=True)


_DRAFT_CRASH_TEXT = ("E llama_model_load: error loading model: invalid vector subscript\n"
                     "E srv load_model: failed to load draft model, '/x/mtp-draft.gguf'\n")


def _draft_crash_loader(holder):
    """router_load fake: the child crashes on its draft DURING the attempt, so the crash
    text lands AFTER this POST's watermark (the tail read is per-attempt since 2026-07-21;
    the old pre-written-log seeding would sit before the watermark and never match).
    `holder["svc"]` is filled after construction; appends to the CURRENT log path so a
    stage-2 restart's rotated log still receives the signature."""
    def _load(url, mid):
        p = holder["svc"]._last_log_path
        Path(p).parent.mkdir(parents=True, exist_ok=True)
        with open(p, "a", encoding="utf-8") as f:
            f.write(_DRAFT_CRASH_TEXT)
    return _load


def test_draft_crash_unloads_coresident_and_keeps_mtp(tmp_path):
    # Stage 1 (cheap, no restart): the draft crashes beside the resident embed → the embed
    # is unloaded so the draft loads SOLO, and the entry KEEPS its draft (MTP preserved —
    # never dropped for a transient co-load race).
    unloaded = []
    state = {"embed_up": True}

    def models(_url):
        gemma = "failed" if state["embed_up"] else "loaded"   # loads once the embed is gone
        return {"object": "list", "data": [
            {"id": _GEMMA_MTP.id, "status": {"value": gemma}},
            {"id": _EMBED_CPU.id, "status": {"value": "loaded"}},
        ]}

    def unload(_url, mid):
        unloaded.append(mid)
        if mid == _EMBED_CPU.id:
            state["embed_up"] = False

    arb = VramArbiter()
    holder = {}
    svc = _service_for(tmp_path, catalog=[_GEMMA_MTP, _EMBED_CPU], arbiter=arb,
                       router_models=models, router_unload=unload,
                       router_load=_draft_crash_loader(holder),
                       hardware_fn=lambda: _fake_hw(8192), sleep=lambda s: None)
    holder["svc"] = svc
    svc._router = _fake_router()
    svc._last_log_path = tmp_path / "router.log"
    svc._resident[_GEMMA_MTP.id] = {"status": "starting"}
    svc._resident[_EMBED_CPU.id] = {"status": "running"}
    arb.reserve(_EMBED_CPU.id, 44)

    entry = _mtp_entry()
    svc._router_load_with_backoff(entry, _mtp_fit(), tmp_path / "llama-server", svc.config())

    assert unloaded == [_EMBED_CPU.id]                 # co-resident freed, no restart
    assert entry.overrides.model_draft == "/x/mtp-draft.gguf"   # MTP never dropped
    assert entry.overrides.spec_type == "draft-mtp"


def test_draft_crash_escalates_to_restart_keeping_mtp(tmp_path):
    # Stage 2 (last resort): unloading the co-resident didn't clear it (router wedged) →
    # a full engine restart to load the draft ALONE, still with MTP. The restart spawns
    # empty and the model loads solo.
    events = []
    state = {"restarted": False}

    def models(_url):
        # Only after the restart does the (solo) load succeed.
        val = "loaded" if state["restarted"] else "failed"
        return {"object": "list", "data": [{"id": _GEMMA_MTP.id, "status": {"value": val}}]}

    def start_router(*_a, **_k):
        state["restarted"] = True
        events.append("restart")
        return _fake_router()

    arb = VramArbiter()
    holder = {}
    svc = _service_for(tmp_path, catalog=[_GEMMA_MTP], arbiter=arb,
                       router_models=models, start_router=start_router,
                       router_load=_draft_crash_loader(holder),
                       hardware_fn=lambda: _fake_hw(8192), sleep=lambda s: None)
    holder["svc"] = svc
    svc._router = _fake_router()
    svc._active_server_exe = tmp_path / "llama-server"
    svc._last_log_path = tmp_path / "router.log"
    svc._resident[_GEMMA_MTP.id] = {"status": "starting"}

    entry = _mtp_entry()
    # No co-residents → Stage 1 is skipped (nothing to unload); Stage 2 (restart) fires.
    svc._router_load_with_backoff(entry, _mtp_fit(), tmp_path / "llama-server", svc.config())

    assert events == ["restart"]                        # escalated to exactly one restart
    assert entry.overrides.spec_type == "draft-mtp"     # MTP still intact after recovery


def test_draft_crash_solo_still_fails_raises_never_drops_mtp(tmp_path):
    # Solo + restart both still crash on the draft → a GENUINE draft problem (corrupt /
    # too big), not the co-load race. Surface the real error; never silently drop MTP.
    def models(_url):
        return {"object": "list", "data": [{"id": _GEMMA_MTP.id, "status": {"value": "failed"}}]}

    holder = {}
    svc = _service_for(tmp_path, catalog=[_GEMMA_MTP], router_models=models,
                       start_router=lambda *a, **k: _fake_router(),
                       router_load=_draft_crash_loader(holder),
                       hardware_fn=lambda: _fake_hw(8192), sleep=lambda s: None)
    holder["svc"] = svc
    svc._router = _fake_router()
    svc._active_server_exe = tmp_path / "llama-server"
    crash_log = tmp_path / "router.log"
    svc._last_log_path = crash_log
    # The stage-2 restart rotates the log via _router_log_path; pin it so the loader's
    # per-POST crash appends keep landing where the (post-restart) attempt tails from.
    svc._router_log_path = lambda: crash_log
    svc._resident[_GEMMA_MTP.id] = {"status": "starting"}

    entry = _mtp_entry()
    with pytest.raises(RuntimeError, match="speculative-decoding|MTP"):
        svc._router_load_with_backoff(entry, _mtp_fit(), tmp_path / "llama-server", svc.config())
    assert entry.overrides.spec_type == "draft-mtp"     # NOT dropped even on the hard failure
