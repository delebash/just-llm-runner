# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared per-action sampler router — the long-tail Plane-2 sampler knobs beyond
the built-in temp/top_p/json/think/max (top_k, min_p, typical_p, mirostat*, dry_*,
xtc_*, samplers-order, …). Stored as key/value rows (feature_sampler_params),
edited via the shared KnobGrid, merged into the per-call `extra` at dispatch +
filtered per adapter (design §8 / D14). PUT replaces the whole set for an action
(the grid sends every row). Mirrors make_job_switches_router; the host implements
the store.
"""

from __future__ import annotations

from typing import Callable, Protocol

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel


class FeatureSamplerRow(BaseModel):
    flagName: str  # the sampler param name, e.g. "top_k" (KnobGrid name/value pair)
    flagValue: str = ""
    builtIn: bool = False


class FeatureSamplersResponse(BaseModel):
    feature: str  # the action key, e.g. "writerAI.tighten"
    samplers: list[FeatureSamplerRow]


class FeatureSamplersPut(BaseModel):
    feature: str
    samplers: list[FeatureSamplerRow] = []


class FeatureSamplerStore(Protocol):
    """Persistence boundary the host implements over its own storage."""

    def list(self, key: str) -> list[FeatureSamplerRow]: ...
    def replace(self, key: str, samplers: list[FeatureSamplerRow]) -> list[FeatureSamplerRow]: ...


def make_feature_samplers_router(get_store: Callable[[], FeatureSamplerStore]) -> APIRouter:
    """GET/PUT an action's long-tail sampler knobs. PUT replaces the whole set."""
    router = APIRouter(tags=["ai"], prefix="/v1/ai")

    @router.get("/feature-samplers", response_model=FeatureSamplersResponse)
    async def list_samplers(feature: str) -> FeatureSamplersResponse:
        if not feature.strip():
            raise HTTPException(status_code=400, detail="feature is required")
        return FeatureSamplersResponse(feature=feature, samplers=get_store().list(feature))

    @router.put("/feature-samplers", response_model=FeatureSamplersResponse)
    async def put_samplers(body: FeatureSamplersPut) -> FeatureSamplersResponse:
        if not body.feature.strip():
            raise HTTPException(status_code=400, detail="feature is required")
        rows = get_store().replace(body.feature, body.samplers)
        return FeatureSamplersResponse(feature=body.feature, samplers=rows)

    return router
