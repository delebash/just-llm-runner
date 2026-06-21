# SPDX-License-Identifier: GPL-3.0-or-later
"""Mountable FastAPI router — the shared LLM-runner REST surface.

Both apps mount this on their FastAPI app so the GUI talks to an identical
API:
    JustVoice: app.include_router(llm_runner.router)   (in its big server)
    JustWrite: app.include_router(llm_runner.router)   (in its light sidecar)

P1.1/P1.2 surface: manifest + detected hardware. Later items add model
download, spawn/status, provider config.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .hardware import detect
from .lifecycle import get_service
from .manifest import load_manifest
from .models import is_cached
from .schema import (
    HardwareInfo,
    ModelEntry,
    RunnerManifest,
    RunnerModelInfo,
    RunnerModelsResponse,
)

router = APIRouter(tags=["llm-runner"])


def _fit(model: ModelEntry, gpu_vram_mb: int, ram_mb: int, margin_mb: int) -> str:
    """Coarse, honest pre-download Fit from the manifest's `minVramMb` hint.

    Not a precise score (that needs the GGUF — `compute_fit`). Bands on the
    ratio of the model's min VRAM to usable VRAM (VRAM minus the safety margin):
      ok    r <= 1.0   fits within usable VRAM
      tight 1.0 < r <= 1.5  fits with margin-eating / light CPU offload
      no    r > 1.5   too large for this GPU
    No GPU → "cpu" (runs on CPU; "no" only if RAM is below the model's floor).
    """
    need = model.recommended_for.min_vram_mb
    if gpu_vram_mb <= 0:
        if model.min_ram_mb and ram_mb and ram_mb < model.min_ram_mb:
            return "no"
        return "cpu"
    if need is None:
        return "unknown"
    usable = max(gpu_vram_mb - margin_mb, 1)
    ratio = need / usable
    if ratio <= 1.0:
        return "ok"
    if ratio <= 1.5:
        return "tight"
    return "no"


@router.get(
    "/v1/llm-runner/manifest",
    response_model=RunnerManifest,
    response_model_by_alias=True,
    summary="Built-in LLM runner manifest (binaries, model catalog, flags)",
)
async def get_manifest() -> RunnerManifest:
    return load_manifest()


@router.get(
    "/v1/llm-runner/hardware",
    response_model=HardwareInfo,
    response_model_by_alias=True,
    summary="Detected hardware (platform, GPU, driver, RAM, runtimes)",
)
async def get_hardware() -> HardwareInfo:
    return detect()


@router.get(
    "/v1/llm-runner/models",
    response_model=RunnerModelsResponse,
    response_model_by_alias=True,
    summary="Model catalog with hardware Fit + load/disk status",
)
async def get_models() -> RunnerModelsResponse:
    """The bundled-runner model catalog the GUI shows in the built-in provider's
    form: each manifest model annotated with a coarse Fit (vs detected VRAM),
    whether its GGUF is already cached, and the live load status."""
    manifest = load_manifest()
    hardware = detect()
    service = get_service()

    gpu_vram = max((g.vram_mb or 0 for g in hardware.gpus), default=0)
    margin = manifest.vram_fit.safety_margin_mb
    hf_cache = service.cache_root / "hf"

    st = service.status()
    cur_id = st.get("modelId") or ""
    cur_state = st.get("status") or "idle"

    def _status_for(model: ModelEntry, downloaded: bool) -> str:
        if model.id == cur_id:
            if cur_state == "running":
                return "loaded"
            if cur_state in ("downloading", "starting"):
                return "loading"
            if cur_state == "error":
                return "error"
        return "disk" if downloaded else "available"

    models: list[RunnerModelInfo] = []
    for m in manifest.models:
        downloaded = is_cached(m.hf_repo, m.quant, cache_root=hf_cache, mmproj=m.mmproj)
        models.append(
            RunnerModelInfo(
                id=m.id,
                name=m.name,
                tier=m.tier,
                params=m.total_params,
                active_params=m.active_params,
                min_vram_mb=m.recommended_for.min_vram_mb,
                min_ram_mb=m.min_ram_mb,
                fit=_fit(m, gpu_vram, hardware.ram_mb, margin),
                status=_status_for(m, downloaded),
                downloaded=downloaded,
            )
        )

    return RunnerModelsResponse(
        vram_mb=gpu_vram,
        ram_mb=hardware.ram_mb,
        safety_margin_mb=margin,
        models=models,
    )


# ── Lifecycle: choose → load on demand → use ────────────────────────────


@router.post("/v1/llm-runner/load", summary="Download (if needed) + spawn a model")
async def load_model(body: dict) -> dict:
    model_id = (body or {}).get("modelId") or ""
    if not model_id:
        raise HTTPException(status_code=400, detail="modelId required")
    return get_service().load(model_id)


@router.get("/v1/llm-runner/status", summary="Current load/run status")
async def runner_status() -> dict:
    return get_service().status()


@router.post("/v1/llm-runner/stop", summary="Stop the running model")
async def stop_model() -> dict:
    return get_service().stop()
