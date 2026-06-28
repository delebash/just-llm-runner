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
from .models import is_cached
from .process import Overrides
from .schema import (
    HardwareInfo,
    LoadRequest,
    ModelEntry,
    RunnerConfig,
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
    "/v1/llm-runner/config",
    response_model=RunnerConfig,
    response_model_by_alias=True,
    summary="Built-in LLM runner config (llama.cpp binaries + VRAM safety margin)",
)
async def get_config() -> RunnerConfig:
    return get_service().config()


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
    hardware = detect()
    service = get_service()

    gpu_vram = vram_mb if vram_mb is not None else max((g.vram_mb or 0 for g in hardware.gpus), default=0)
    margin = service.config().safety_margin_mb
    hf_cache = service.cache_root / "hf"

    st = service.status()
    cur_id = st.get("modelId") or ""
    cur_state = st.get("status") or "idle"

    def _status_for(model_id: str, downloaded: bool) -> str:
        if model_id == cur_id:
            if cur_state == "running":
                return "loaded"
            if cur_state in ("downloading", "starting"):
                return "loading"
            if cur_state == "error":
                return "error"
        return "disk" if downloaded else "available"

    # Catalog is HOST-OWNED (DB-backed via service.catalog()). Falls through
    # to manifest.models inside service.catalog() for standalone runner use.
    catalog = service.catalog()

    models: list[RunnerModelInfo] = []
    for m in catalog:
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
                status=_status_for(m.id, downloaded),
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
async def load_model(body: LoadRequest) -> dict:
    """Load a model, optionally with Plane-1 engine overrides for tuning/testing
    (n_cpu_moe / n_gpu_layers / ctx / KV-cache type / flags / …). Omitted fields
    fall back to the computed Fit + the manifest's base preset. See
    docs/plans/2026-06-24-llamacpp-switches.md (Plane 1)."""
    if not body.model_id:
        raise HTTPException(status_code=400, detail="modelId required")
    overrides = Overrides(
        n_gpu_layers=body.n_gpu_layers, n_cpu_moe=body.n_cpu_moe, ctx_len=body.ctx_len,
        cache_type_k=body.cache_type_k, cache_type_v=body.cache_type_v, flash_attn=body.flash_attn,
        no_mmap=body.no_mmap, mlock=body.mlock, no_kv_offload=body.no_kv_offload,
        batch_size=body.batch_size, ubatch_size=body.ubatch_size,
        threads=body.threads, threads_batch=body.threads_batch, parallel=body.parallel,
        cont_batching=body.cont_batching, cache_reuse=body.cache_reuse,
        spec_type=body.spec_type, spec_n_max=body.spec_n_max,
        extra_flags=list(body.extra_flags or []),
    )
    return get_service().load(body.model_id, overrides=overrides, job_id=body.job_id)


@router.get("/v1/llm-runner/status", summary="Current load/run status")
async def runner_status() -> dict:
    return get_service().status()


@router.post("/v1/llm-runner/stop", summary="Stop the running model")
async def stop_model() -> dict:
    return get_service().stop()
