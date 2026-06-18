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
from .schema import HardwareInfo, RunnerManifest

router = APIRouter(tags=["llm-runner"])


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
