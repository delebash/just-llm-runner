# SPDX-License-Identifier: MIT
"""GET /v1/llm-runner/models — the catalog view with hardware Fit + status.

Hardware / runner-service are injected (the endpoint reads them via module-level
`detect` / `get_service`), so the Fit bands and status mapping are exercised with
no GPU and no download. Post-A7 the VRAM safety margin comes from the service's
RunnerConfig (was the manifest)."""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

import llm_runner.runner.api as api
from llm_runner.runner import lifecycle
from llm_runner.runner.config import default_config
from llm_runner.runner.schema import (
    GpuInfo,
    HardwareInfo,
    LlamacppSpec,
    ModelEntry,
    RecommendedFor,
    RunnerConfig,
)

_TEST_CONFIG = RunnerConfig(llamacpp=LlamacppSpec(pinned_build="bTEST"), safety_margin_mb=1024)


def _client():
    app = FastAPI()
    app.include_router(api.router)
    return TestClient(app)


def _model(mid, min_vram_mb, *, min_ram_mb=None, total_params="14B"):
    return ModelEntry(
        id=mid,
        name=mid.upper(),
        tier="mid",
        hf_repo=f"org/{mid}-GGUF",
        quant="Q4_K_M",
        total_params=total_params,
        min_ram_mb=min_ram_mb,
        recommended_for=RecommendedFor(min_vram_mb=min_vram_mb),
    )


class _FakeService:
    def __init__(self, models, *, resident=None, status=None, catalog_wired=True):
        self._models = list(models or [])
        # get_models reads the resident set (P1f) for per-model status; router-down/empty
        # by default → every model falls through to disk/available. (Fit no longer reads
        # anything off the service — it scores the DETECTED card, user decree 2026-07-06.)
        self._resident = resident or {"router": False, "modelsMax": 2, "sleepIdleSeconds": 900, "models": []}
        self._status = status or {"status": "idle", "modelId": "", "url": "", "detail": "", "error": ""}
        self.cache_root = Path("/nonexistent-cache-root")
        # Did a host wire a catalog source? These tests all supply one, so True by default;
        # the unwired case has its own test at the bottom of this file (2026-08-01).
        self.catalog_wired = catalog_wired

    def status(self):
        return self._status

    def resident(self, hw=None):
        return self._resident

    def catalog(self):
        return self._models

    def config(self):
        return _TEST_CONFIG  # safety_margin_mb=1024

    def download_status(self):
        return {"downloads": {}}   # per-model map; empty == nothing downloading

    def op_progress(self):
        # The live operation behind `status` (2026-08-14). Empty by default —
        # tests that exercise a bar set `_ops`.
        return getattr(self, "_ops", {})

    def model_downloaded(self, m, hf_cache):
        # Nothing is on disk in these endpoint tests → no model reads "downloaded"
        # (the badge moved off a raw is_cached to service.model_downloaded, 2026-07-19,
        # which additionally counts the MTP draft when the resolved config wants it).
        return False

    def ensure_embedding(self):
        # Tests set `_ensure` to the configured shape; default is the no-local-embed case.
        return getattr(self, "_ensure", {"ok": False, "detail": "no local embedding model configured"})

    # ── Phase 3 speed-badge reads (bandwidth ladder) — the unwired defaults:
    # no measurements, no class bandwidths, no probe → every row keeps band ""
    # (the honest-unknown shape these endpoint tests ran under before).
    def measurement_rows(self):
        return getattr(self, "_measurements", [])

    def class_bw(self, class_key_str):
        return getattr(self, "_class_bw", (0.0, 0.0))

    def host_probe_bw_gbps(self, machine_key_str):
        return getattr(self, "_probe_gbps", None)


def _resident(*ids_and_statuses):
    """Build a resident-set dict (router up) from (id, status) pairs — what service.resident()
    returns and get_models._status_for reads."""
    return {
        "router": True, "modelsMax": 2, "sleepIdleSeconds": 900,
        "models": [{"id": mid, "status": s} for mid, s in ids_and_statuses],
    }


def _patch(monkeypatch, *, hardware, models, resident=None, catalog_wired=True):
    monkeypatch.setattr(api, "detect", lambda: hardware)
    monkeypatch.setattr(
        api, "get_service",
        lambda: _FakeService(models, resident=resident, catalog_wired=catalog_wired),
    )


def test_fit_bands_on_a_12gb_gpu(monkeypatch):
    # usable = 12288 - 1024 = 11264; ratio = need / usable
    hw = HardwareInfo(
        os="Linux", platform="linux", cpu_cores=8, ram_mb=32000,
        gpus=[GpuInfo(vendor="nvidia", name="RTX 4070", vram_mb=12288)],
    )
    models = [
        _model("small", 6000),                        # override 6000 -> ratio 0.53 -> ok
        _model("mid", 14000),                         # override 14000 -> ratio 1.24 -> tight
        _model("huge", 40000),                        # override 40000 -> ratio 3.55 -> no
        _model("nohint", None),                       # no override -> 14B×0.6=8400 -> ok
        _model("noparams", None, total_params=None),  # no override, no params -> unknown
    ]
    _patch(monkeypatch, hardware=hw, models=models)  # no resident → all available
    body = _client().get("/v1/llm-runner/models").json()
    assert body["vramMb"] == 12288
    assert body["safetyMarginMb"] == 1024
    fit = {m["id"]: m["fit"] for m in body["models"]}
    assert fit == {"small": "ok", "mid": "tight", "huge": "no", "nohint": "ok", "noparams": "unknown"}
    # All available (none cached, none loaded).
    assert all(m["status"] == "available" for m in body["models"])


def test_cpu_only_machine(monkeypatch):
    hw = HardwareInfo(os="Linux", platform="linux", cpu_cores=8, ram_mb=16000, gpus=[])
    models = [
        _model("fits-ram", 8000, min_ram_mb=8000),      # CPU + enough RAM -> cpu
        _model("too-big-ram", 8000, min_ram_mb=64000),  # CPU but RAM too small -> no
    ]
    _patch(monkeypatch, hardware=hw, models=models)  # no resident → fit bands only
    fit = {m["id"]: m["fit"] for m in _client().get("/v1/llm-runner/models").json()["models"]}
    assert fit == {"fits-ram": "cpu", "too-big-ram": "no"}


def test_fit_scores_total_card_even_with_models_resident(monkeypatch):
    # User decree 2026-07-06 ("fix it"): Fit answers "how does this model run on this
    # CARD", never "what fits this instant". The former P2 §5c budget-aware scoring fed
    # the VRAM remaining after the resident set — on an 8 GB box a SLEEPING model flipped
    # every catalog row to "CPU" while the same screen's header showed the card. A
    # resident model must not change Fit; the load-moment budget is the arbiter's job.
    hw = HardwareInfo(os="Linux", platform="linux", cpu_cores=8, ram_mb=32000,
                      gpus=[GpuInfo(vendor="nvidia", name="RTX 4070", vram_mb=12288)])
    models = [_model("mid", 14000)]  # whole card: 14000/(12288-1024)=1.24 → tight
    # A resident model is committed (would have shrunk the old budget to 4288 → 'no'):
    svc = _FakeService(models, resident=_resident(("mid", "sleeping")))
    monkeypatch.setattr(api, "detect", lambda: hw)
    monkeypatch.setattr(api, "get_service", lambda: svc)
    body = _client().get("/v1/llm-runner/models").json()
    assert body["models"][0]["fit"] == "tight"  # the card's answer, resident or not
    assert body["vramMb"] == 12288  # the response reports the card, matching the labels
    # The card-chooser override (the vram_mb query param) stays: score the given VRAM
    # as-is (a hypothetical card; 0 = CPU-only).
    assert _client().get("/v1/llm-runner/models?vram_mb=12288").json()["models"][0]["fit"] == "tight"


def test_status_reflects_loaded_model(monkeypatch):
    hw = HardwareInfo(
        os="Linux", platform="linux", cpu_cores=8, ram_mb=32000,
        gpus=[GpuInfo(vendor="nvidia", name="RTX 4070", vram_mb=12288)],
    )
    models = [_model("running-one", 6000), _model("other", 6000)]
    _patch(monkeypatch, hardware=hw, models=models, resident=_resident(("running-one", "loaded")))
    status = {m["id"]: m["status"] for m in _client().get("/v1/llm-runner/models").json()["models"]}
    assert status == {"running-one": "loaded", "other": "available"}


def test_status_reflects_co_resident_set(monkeypatch):
    # Router mode: MULTIPLE models resident at once — each shows its own status. A sleeping
    # model still reads 'loaded' in the catalog (it is resident, reloadable instantly; the
    # precise word is on /resident); an 'unloaded' section that isn't on disk → available.
    hw = HardwareInfo(
        os="Linux", platform="linux", cpu_cores=8, ram_mb=32000,
        gpus=[GpuInfo(vendor="nvidia", name="RTX 4070", vram_mb=12288)],
    )
    models = [_model("chat", 6000), _model("embed", 2000), _model("cold", 6000)]
    _patch(monkeypatch, hardware=hw, models=models,
           resident=_resident(("chat", "loaded"), ("embed", "sleeping"), ("cold", "unloaded")))
    status = {m["id"]: m["status"] for m in _client().get("/v1/llm-runner/models").json()["models"]}
    assert status == {"chat": "loaded", "embed": "loaded", "cold": "available"}


def test_status_reflects_load_error(monkeypatch):
    # A load that errored (e.g. engine-not-installed → the router never spawned) is carried by
    # resident()'s in-flight overlay as 'error', so the catalog shows 'error' (→ the UI's
    # install-engine CTA) rather than silently 'available'. Guards the T5 regression the
    # rules-checker caught: dropping service.status() must not lose the error state.
    hw = HardwareInfo(os="Linux", platform="linux", cpu_cores=8, ram_mb=32000, gpus=[])
    models = [_model("boom", 6000)]
    _patch(monkeypatch, hardware=hw, models=models,
           resident={"router": False, "modelsMax": 2, "sleepIdleSeconds": 900,
                     "models": [{"id": "boom", "status": "error"}]})
    status = {m["id"]: m["status"] for m in _client().get("/v1/llm-runner/models").json()["models"]}
    assert status == {"boom": "error"}


def test_status_reflects_download_channel(monkeypatch):
    # A download-only op runs on its OWN channel — the downloading model shows
    # "loading" via _status_for even though the run-state (status()) is idle.
    hw = HardwareInfo(
        os="Linux", platform="linux", cpu_cores=8, ram_mb=32000,
        gpus=[GpuInfo(vendor="nvidia", name="RTX 4070", vram_mb=12288)],
    )
    models = [_model("dl-one", 6000), _model("other", 6000)]
    svc = _FakeService(models)  # router-down/empty resident; the download channel drives status
    # Per-model download map now: {modelId: entry}. Only "dl-one" is downloading.
    svc.download_status = lambda: {"downloads": {
        "dl-one": {"status": "downloading", "modelId": "dl-one", "detail": "", "error": "",
                   "downloaded": 0, "total": 0},
    }}
    monkeypatch.setattr(api, "detect", lambda: hw)
    monkeypatch.setattr(api, "get_service", lambda: svc)
    status = {m["id"]: m["status"] for m in _client().get("/v1/llm-runner/models").json()["models"]}
    assert status == {"dl-one": "loading", "other": "available"}


def test_models_endpoint_real_camelcase():
    # No per-call patching — exercise the real endpoint with a clean default-backed
    # service (empty standalone catalog), confirming the camelCase contract.
    lifecycle.configure_service(config_fn=default_config)
    r = _client().get("/v1/llm-runner/models")
    assert r.status_code == 200
    body = r.json()
    assert "vramMb" in body and "safetyMarginMb" in body and "models" in body
    for m in body["models"]:
        assert m["fit"] in {"ok", "tight", "no", "cpu", "unknown"}
        assert m["status"] in {"loaded", "loading", "error", "disk", "available"}
        assert "minVramMb" in m  # camelCase alias present


def test_resident_endpoint_camelcase(monkeypatch):
    # GET /v1/llm-runner/resident: the live set serialized camelCase (modelsMax /
    # sleepIdleSeconds / nParams / sizeBytes / nCtx) via RunnerResidentResponse.
    hw = HardwareInfo(os="Linux", platform="linux", cpu_cores=8, ram_mb=32000, gpus=[])
    svc = _FakeService([], resident={
        "router": True, "models_max": 3, "sleep_idle_seconds": 600,
        "vram_total_mb": 8000, "committed_mb": 5000, "remaining_mb": 3000,
        "models": [{"id": "chat", "status": "loaded", "n_params": 7, "size_bytes": 9,
                    "n_ctx": 4096, "vram_mb": 5000}],
    })
    monkeypatch.setattr(api, "detect", lambda: hw)
    monkeypatch.setattr(api, "get_service", lambda: svc)
    body = _client().get("/v1/llm-runner/resident").json()
    assert body["router"] is True
    assert body["modelsMax"] == 3 and body["sleepIdleSeconds"] == 600
    assert body["vramTotalMb"] == 8000 and body["committedMb"] == 5000 and body["remainingMb"] == 3000
    row = body["models"][0]
    assert row["id"] == "chat" and row["status"] == "loaded"
    assert row["nParams"] == 7 and row["sizeBytes"] == 9 and row["nCtx"] == 4096
    assert row["vramMb"] == 5000


def test_resident_endpoint_router_down(monkeypatch):
    # Router not up (lazy-spawn, nothing loaded) → router:false, empty set, the knob defaults.
    hw = HardwareInfo(os="Linux", platform="linux", cpu_cores=8, ram_mb=32000, gpus=[])
    monkeypatch.setattr(api, "detect", lambda: hw)
    monkeypatch.setattr(api, "get_service", lambda: _FakeService([]))
    body = _client().get("/v1/llm-runner/resident").json()
    assert body["router"] is False
    assert body["models"] == []
    assert body["modelsMax"] == 2 and body["sleepIdleSeconds"] == 900


def test_load_carries_new_flags_into_overrides(monkeypatch):
    # POST /load: the EXPLICIT field-by-field LoadRequest → Overrides constructor
    # must carry model_draft + reasoning_budget(+message) — LoadRequest fields
    # without this wiring would be silently dead (Plan B D6, wiring point 3).
    captured = {}

    class _Svc:
        def load(self, model_id, overrides=None, job_id=None, switches=None, trigger="api"):
            captured["ov"] = overrides
            return {"status": "loading"}

    monkeypatch.setattr(api, "get_service", lambda: _Svc())
    r = _client().post("/v1/llm-runner/load", json={
        "modelId": "m1", "modelDraft": "/d/MTP/g-Q4_0-MTP.gguf",
        "reasoningBudget": 1024, "reasoningBudgetMessage": "wrap up now",
    })
    assert r.status_code == 200
    ov = captured["ov"]
    assert ov.model_draft == "/d/MTP/g-Q4_0-MTP.gguf"
    assert ov.reasoning_budget == 1024
    assert ov.reasoning_budget_message == "wrap up now"


def test_ensure_embedding_endpoint_configured(monkeypatch):
    # P3 lazy prep: a configured local embed → ok:true + the modelId the client polls /resident for.
    svc = _FakeService([])
    svc._ensure = {"ok": True, "modelId": "nomic-embed-text", "status": "starting"}
    monkeypatch.setattr(api, "get_service", lambda: svc)
    body = _client().post("/v1/llm-runner/ensure-embedding").json()
    assert body["ok"] is True
    assert body["modelId"] == "nomic-embed-text"


def test_ensure_embedding_endpoint_not_configured(monkeypatch):
    # No local embed configured (routing points at Ollama/cloud) → ok:false; the caller falls back.
    monkeypatch.setattr(api, "get_service", lambda: _FakeService([]))
    body = _client().post("/v1/llm-runner/ensure-embedding").json()
    assert body["ok"] is False


# ── catalogWired: telling "nothing downloaded yet" from "no catalog wired" ──────
# Both states return `models: []`, and until 2026-08-01 the endpoint could not tell them
# apart — a new consumer mounting the router saw an empty list and no reason for it.
# JustVoice sat in the unwired state for months without anyone noticing.


def test_models_reports_catalog_wired_when_a_host_supplied_one(monkeypatch):
    hw = HardwareInfo(os="Linux", platform="linux", cpu_cores=8, ram_mb=16000, gpus=[])
    _patch(monkeypatch, hardware=hw, models=[_model("a", 4000)], catalog_wired=True)
    assert _client().get("/v1/llm-runner/models").json()["catalogWired"] is True


def test_models_says_catalog_unwired_and_an_EMPTY_wired_catalog_does_not(monkeypatch):
    """The bite: an empty list alone must not be read as 'unwired'. A host that wired a
    catalog which happens to hold nothing reports wired=True — the two states are
    distinguishable in BOTH directions, which is the entire point of the field."""
    hw = HardwareInfo(os="Linux", platform="linux", cpu_cores=8, ram_mb=16000, gpus=[])

    _patch(monkeypatch, hardware=hw, models=[], catalog_wired=False)
    unwired = _client().get("/v1/llm-runner/models").json()
    assert unwired["models"] == [] and unwired["catalogWired"] is False

    _patch(monkeypatch, hardware=hw, models=[], catalog_wired=True)
    wired_but_empty = _client().get("/v1/llm-runner/models").json()
    assert wired_but_empty["models"] == [] and wired_but_empty["catalogWired"] is True


def test_real_service_knows_whether_a_catalog_was_wired(monkeypatch):
    """Against the REAL RunnerService, not the double: the standalone default reports
    unwired, and configure_service(catalog_fn=…) flips it. This is what the endpoint's
    answer is derived from, so it is the claim that actually has to hold."""
    monkeypatch.setattr(lifecycle, "_service", None)
    assert lifecycle.get_service().catalog_wired is False, "standalone default must read unwired"

    monkeypatch.setattr(lifecycle, "_service", None)
    svc = lifecycle.configure_service(catalog_fn=lambda: [])
    assert svc.catalog_wired is True, "a host-supplied catalog_fn must read wired"


# ── Phase 3: feasibility × speed band, shipped together (§5.4/§8.3) ───────────

class _Flag:
    def __init__(self, name, value):
        self.flagName, self.flagValue = name, value


class _Meas:
    def __init__(self, model_id, tok_s, machine_key, backend="cuda", switches=()):
        self.modelId, self.tokensPerSec = model_id, tok_s
        self.machineKey, self.backend = machine_key, backend
        self.switches = list(switches)


def _moe_with_facts(mid="flagship"):
    m = _model(mid, None, total_params="26B")
    m.size_bytes = 14_249_000_000
    m.trained_ctx = 131072
    m.experts = 128
    # The 26B shape: iSWA scalars sized so KV(32k) ≈ 881 MB (Appendix B).
    m.physics_facts = {"block_count": 30, "n_kv_heads": 16, "expert_used_count": 8,
                       "expert_byte_share": 0.9389,
                       "kv_windowed_bytes_per_token": 102636.0,
                       "kv_global_bytes_per_token": 10236.0, "sliding_window": 1024}
    return m


def _author_box():
    return HardwareInfo(os="Windows", platform="windows", cpu_cores=16, ram_mb=32768,
                        gpus=[GpuInfo(vendor="NVIDIA", name="RTX 2070 SUPER", vram_mb=8192)],
                        runtimes={"cuda": True})


def test_band_rides_the_fit_and_factless_rows_stay_bandless(monkeypatch):
    hw = _author_box()
    svc = _FakeService([_moe_with_facts(), _model("bare", 6000)])
    svc._class_bw = (448.0, 51.2)  # ladder source 3 (no measurements, no probe)
    monkeypatch.setattr(api, "detect", lambda: hw)
    monkeypatch.setattr(api, "get_service", lambda: svc)
    rows = {m["id"]: m for m in _client().get("/v1/llm-runner/models").json()["models"]}
    # The MoE at the seeded constants: device leg ~1.75 GB @ 268.8 effective +
    # expert leg 836 MB @ 7.68 effective → ~8.7 tok/s → "fine" (the ≥8 line).
    band_row = rows["flagship"]
    assert band_row["speedBand"] == "fine"
    assert band_row["predTokS"] and 6 <= band_row["predTokS"] <= 12
    assert band_row["measuredTokS"] is None
    # No header facts → NO band, never a guess — the chip shows plain fit.
    assert rows["bare"]["speedBand"] == "" and rows["bare"]["predTokS"] is None


def test_measured_outranks_predicted_for_value_and_band(monkeypatch):
    from llm_runner.runner.hardware import machine_key as mk

    hw = _author_box()
    svc = _FakeService([_moe_with_facts()])
    svc._class_bw = (448.0, 51.2)
    # A real measured run on THIS box + backend (the July campaign's 28.6): the
    # row shows it, and the band is computed FROM it (fast ≥ 20), not from the
    # ~8.7 prediction. Newest-first order is the store's contract.
    svc._measurements = [_Meas("flagship", 28.6, mk(hw), "cuda",
                               [_Flag("n-cpu-moe", "21"), _Flag("ctx-size", "16384")])]
    monkeypatch.setattr(api, "detect", lambda: hw)
    monkeypatch.setattr(api, "get_service", lambda: svc)
    row = _client().get("/v1/llm-runner/models").json()["models"][0]
    assert row["measuredTokS"] == 28.6
    assert row["speedBand"] == "fast"
    # A different box's measurement must NOT be claimed for this one.
    svc._measurements = [_Meas("flagship", 28.6, "other|1|2c|4g", "cuda")]
    row = _client().get("/v1/llm-runner/models").json()["models"][0]
    assert row["measuredTokS"] is None and row["speedBand"] == "fine"


def test_ran_here_flags_this_box_evidence(monkeypatch):
    # §7.4-as-ranking: ANY persisted row for this machine — here a Phase 5 load
    # FOOTPRINT (tok/s 0, so measuredTokS stays None) — flags ranHere, the
    # evidence bit the recommendation ranking reads so the estimate can never
    # veto a model this box has demonstrably run. Another box's row proves
    # nothing here.
    from llm_runner.runner.hardware import machine_key as mk

    hw = _author_box()
    svc = _FakeService([_moe_with_facts()])
    svc._measurements = [_Meas("flagship", 0, mk(hw), "cuda",
                               [_Flag("n_gpu_layers", "30")])]
    monkeypatch.setattr(api, "detect", lambda: hw)
    monkeypatch.setattr(api, "get_service", lambda: svc)
    row = _client().get("/v1/llm-runner/models").json()["models"][0]
    assert row["ranHere"] is True and row["measuredTokS"] is None
    svc._measurements = [_Meas("flagship", 0, "other|1|2c|4g", "cuda")]
    row = _client().get("/v1/llm-runner/models").json()["models"][0]
    assert row["ranHere"] is False


def test_no_bandwidth_source_means_no_band(monkeypatch):
    # An AMD/Intel box with no class row: nvidia-smi absent, class (0,0), no
    # probe yet → the host pool is unpriced → band "" (§8.17: an unknown never
    # becomes a number). Feasibility still renders.
    hw = HardwareInfo(os="Windows", platform="windows", cpu_cores=8, ram_mb=32768,
                      gpus=[GpuInfo(vendor="AMD", name="RX 7600", vram_mb=8192)],
                      runtimes={"vulkan": True})
    svc = _FakeService([_moe_with_facts()])
    from llm_runner.runner import bandwidth as bw
    monkeypatch.setattr(bw, "nvidia_mem_bw_gbps", lambda: None)  # hermetic — the dev box HAS nvidia-smi
    monkeypatch.setattr(api, "detect", lambda: hw)
    monkeypatch.setattr(api, "get_service", lambda: svc)
    row = _client().get("/v1/llm-runner/models").json()["models"][0]
    assert row["speedBand"] == "" and row["predTokS"] is None
    assert row["fit"]  # feasibility unaffected


# ── The operation behind `status` rides the row (2026-08-14) ─────────


def test_row_carries_the_live_operation_so_a_bar_needs_no_browser_task(monkeypatch):
    """One control, one source (user ruling): the row itself carries the caption,
    byte counters and error text, so a reloaded page — or any second surface —
    renders the SAME bar the page that started the operation sees."""
    monkeypatch.setattr(api, "detect", lambda: HardwareInfo(
        os="Linux", platform="linux", cpu_cores=8, ram_mb=32000,
        gpus=[GpuInfo(vendor="nvidia", name="RTX 4070", vram_mb=12288)]))
    svc = _FakeService([_model("m1", 4096), _model("m2", 4096)])
    svc._resident = _resident(("m1", "downloading"), ("m2", "error"))
    svc._ops = {
        "m1": {"detail": "model weights", "done": 512, "total": 2048, "error": ""},
        "m2": {"detail": "", "done": 0, "total": 0, "error": "engine-not-installed"},
    }
    monkeypatch.setattr(api, "get_service", lambda: svc)

    rows = {r["id"]: r for r in _client().get("/v1/llm-runner/models").json()["models"]}
    assert rows["m1"]["status"] == "loading"
    assert rows["m1"]["detail"] == "model weights"
    assert (rows["m1"]["opDone"], rows["m1"]["opTotal"]) == (512, 2048)
    assert rows["m1"]["error"] == ""
    # The failure travels too — this is what the empty husk could never show.
    assert rows["m2"]["status"] == "error"
    assert rows["m2"]["error"] == "engine-not-installed"


def test_idle_rows_carry_an_empty_operation(monkeypatch):
    """No operation → empty fields, never stale text from a previous one."""
    monkeypatch.setattr(api, "detect", lambda: HardwareInfo(
        os="Linux", platform="linux", cpu_cores=8, ram_mb=32000,
        gpus=[GpuInfo(vendor="nvidia", name="RTX 4070", vram_mb=12288)]))
    svc = _FakeService([_model("m1", 4096)])
    monkeypatch.setattr(api, "get_service", lambda: svc)
    row = _client().get("/v1/llm-runner/models").json()["models"][0]
    assert (row["detail"], row["error"], row["opDone"], row["opTotal"]) == ("", "", 0, 0)
