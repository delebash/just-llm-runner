# SPDX-License-Identifier: GPL-3.0-or-later
"""The Fast/Balanced/Best dial endpoint — resolve a job+quality to a concrete
(provider, model, think) for the detected hardware, so the Routing-by-job UI can
show the resolved model as a muted note and persist it.

Router factory over the host's catalog + recommendation stores + a hardware
detector (mirrors the other shared routers). The dial picks among LOCAL runner
models (the curated recommendations), so the resolved provider is the bundled
runner; cloud routes stay explicit pins."""

from __future__ import annotations

from typing import Callable

from fastapi import APIRouter
from pydantic import BaseModel

from .quality import QUALITY_STOPS, resolve_quality


class QualityResolution(BaseModel):
    job: str
    quality: str
    providerId: str = ""      # the local runner when a model resolved, else ""
    model: str = ""           # "" = nothing in the job's recs fits this hardware
    think: bool = False
    candidates: list[str] = []  # the fit-filtered size ladder (smallest → largest)


def make_quality_router(
    get_catalog_store: Callable,
    get_recommendation_store: Callable,
    *,
    detect_fn: Callable,
    local_runner_id: str = "local-llamacpp",
) -> APIRouter:
    router = APIRouter(tags=["ai"], prefix="/v1/ai")

    @router.get("/job-quality", response_model=QualityResolution)
    async def job_quality(job: str, quality: str = "balanced", vram_mb: int | None = None) -> QualityResolution:
        """Resolve `job` at the `quality` stop. `vram_mb` overrides detected VRAM
        so QuickSetup can preview a different card (mirrors /v1/llm-runner/models)."""
        q = quality if quality in QUALITY_STOPS else "balanced"
        hw = detect_fn()
        vram = vram_mb if vram_mb is not None else max((g.vram_mb or 0 for g in hw.gpus), default=0)
        pick = resolve_quality(
            job, q, vram_mb=vram, ram_mb=hw.ram_mb,
            catalog=get_catalog_store().list(),
            recommendations=get_recommendation_store().list(),
        )
        return QualityResolution(
            job=job, quality=q,
            providerId=local_runner_id if pick.model else "",
            model=pick.model or "", think=pick.think, candidates=pick.candidates,
        )

    return router
