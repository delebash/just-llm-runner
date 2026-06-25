# SPDX-License-Identifier: GPL-3.0-or-later
"""GET /v1/llm-runner/models — the catalog view with hardware Fit + status.

Hardware / manifest / runner-service are injected (the endpoint reads them via
module-level `detect` / `load_manifest` / `get_service`), so the Fit bands and
status mapping are exercised with no GPU and no download.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

import llm_runner.runner.api as api
from llm_runner.runner.schema import (
    GpuInfo,
    HardwareInfo,
    LlamacppSpec,
    ModelEntry,
    RecommendedFor,
    RunnerManifest,
    VramFit,
)


def _client():
    app = FastAPI()
    app.include_router(api.router)
    return TestClient(app)


def _manifest(models):
    return RunnerManifest(
        llamacpp=LlamacppSpec(pinned_build="bTEST"),
        models=models,
        vram_fit=VramFit(safety_margin_mb=1024),
    )


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
    def __init__(self, status, models):
        self._status = status
        self._models = list(models or [])
        self.cache_root = Path("/nonexistent-cache-root")

    def status(self):
        return self._status

    # Mirrors RunnerService.catalog — host-backed; falls through to manifest
    # in production but the test feeds models in directly.
    def catalog(self):
        return self._models


def _patch(monkeypatch, *, hardware, models, status):
    monkeypatch.setattr(api, "detect", lambda: hardware)
    monkeypatch.setattr(api, "load_manifest", lambda: _manifest(models))
    monkeypatch.setattr(api, "get_service", lambda: _FakeService(status, models))
    # Nothing is on disk in these tests.
    monkeypatch.setattr(api, "is_cached", lambda *a, **k: False)


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
    _patch(monkeypatch, hardware=hw, models=models,
           status={"status": "idle", "modelId": "", "url": "", "detail": "", "error": ""})
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
        _model("fits-ram", 8000, min_ram_mb=8000),    # CPU + enough RAM -> cpu
        _model("too-big-ram", 8000, min_ram_mb=64000),  # CPU but RAM too small -> no
    ]
    _patch(monkeypatch, hardware=hw, models=models,
           status={"status": "idle", "modelId": "", "url": "", "detail": "", "error": ""})
    fit = {m["id"]: m["fit"] for m in _client().get("/v1/llm-runner/models").json()["models"]}
    assert fit == {"fits-ram": "cpu", "too-big-ram": "no"}


def test_status_reflects_loaded_model(monkeypatch):
    hw = HardwareInfo(
        os="Linux", platform="linux", cpu_cores=8, ram_mb=32000,
        gpus=[GpuInfo(vendor="nvidia", name="RTX 4070", vram_mb=12288)],
    )
    models = [_model("running-one", 6000), _model("other", 6000)]
    _patch(monkeypatch, hardware=hw, models=models,
           status={"status": "running", "modelId": "running-one", "url": "x", "detail": "", "error": ""})
    status = {m["id"]: m["status"] for m in _client().get("/v1/llm-runner/models").json()["models"]}
    assert status == {"running-one": "loaded", "other": "available"}


def test_models_endpoint_real_camelcase():
    # No patching — exercises the real manifest + hardware detect on this box.
    r = _client().get("/v1/llm-runner/models")
    assert r.status_code == 200
    body = r.json()
    assert "vramMb" in body and "safetyMarginMb" in body and "models" in body
    for m in body["models"]:
        assert m["fit"] in {"ok", "tight", "no", "cpu", "unknown"}
        assert m["status"] in {"loaded", "loading", "error", "disk", "available"}
        assert "minVramMb" in m  # camelCase alias present
