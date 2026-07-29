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
    def __init__(self, models, *, resident=None, status=None):
        self._models = list(models or [])
        # get_models reads the resident set (P1f) for per-model status; router-down/empty
        # by default → every model falls through to disk/available. (Fit no longer reads
        # anything off the service — it scores the DETECTED card, user decree 2026-07-06.)
        self._resident = resident or {"router": False, "modelsMax": 2, "sleepIdleSeconds": 900, "models": []}
        self._status = status or {"status": "idle", "modelId": "", "url": "", "detail": "", "error": ""}
        self.cache_root = Path("/nonexistent-cache-root")

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

    def model_downloaded(self, m, hf_cache):
        # Nothing is on disk in these endpoint tests → no model reads "downloaded"
        # (the badge moved off a raw is_cached to service.model_downloaded, 2026-07-19,
        # which additionally counts the MTP draft when the resolved config wants it).
        return False

    def ensure_embedding(self):
        # Tests set `_ensure` to the configured shape; default is the no-local-embed case.
        return getattr(self, "_ensure", {"ok": False, "detail": "no local embedding model configured"})


def _resident(*ids_and_statuses):
    """Build a resident-set dict (router up) from (id, status) pairs — what service.resident()
    returns and get_models._status_for reads."""
    return {
        "router": True, "modelsMax": 2, "sleepIdleSeconds": 900,
        "models": [{"id": mid, "status": s} for mid, s in ids_and_statuses],
    }


def _patch(monkeypatch, *, hardware, models, resident=None):
    monkeypatch.setattr(api, "detect", lambda: hardware)
    monkeypatch.setattr(api, "get_service", lambda: _FakeService(models, resident=resident))


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
