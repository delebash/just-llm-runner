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

from fastapi import APIRouter

from .hardware import detect
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
