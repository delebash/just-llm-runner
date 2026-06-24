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

from . import fit
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
    """Coarse pre-download Fit (no GGUF yet): computed from the model's params ×
    quant vs detected VRAM — or an explicit `recommendedFor.minVramMb` override
    when the manifest sets one (it can encode MoE CPU-offload a raw weights
    estimate misses). Bands: ok ≤1.0, tight ≤1.5, else no; no GPU → cpu (no only
    if RAM can't hold it). The precise per-layer fit needs the downloaded GGUF
    (`compute_fit`); the spawn OOM back-off is the final safety net."""
    return fit.coarse_fit(
        total_params=model.total_params,
        quant=model.quant,
        vram_mb=gpu_vram_mb,
        ram_mb=ram_mb,
        margin_mb=margin_mb,
        min_vram_override=model.recommended_for.min_vram_mb,
        min_ram_override=model.min_ram_mb,
    )


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
async def get_models(vram_mb: int | None = None) -> RunnerModelsResponse:
    """The bundled-runner model catalog the GUI shows in the built-in provider's
    form: each manifest model annotated with a coarse Fit (vs detected VRAM),
    whether its GGUF is already cached, and the live load status.

    `vram_mb` overrides the detected VRAM so Quick Setup's card chooser can
    re-score Fit for a card other than the one in this machine (0 = CPU-only)."""
    manifest = load_manifest()
    hardware = detect()
    service = get_service()

    gpu_vram = vram_mb if vram_mb is not None else max((g.vram_mb or 0 for g in hardware.gpus), default=0)
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
