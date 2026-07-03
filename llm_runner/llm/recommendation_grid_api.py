# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared recommendation-grid router — the unified 'Models' surface's data (Phase 4).

`GET /v1/ai/recommendation-grid` → the per-hardware-tier × per-function grid: a
read-time VIEW over the recommendations + catalog stores joined by `coarse_fit`
(NO schema change, NO new storage). Mirrors recommendations_api / model_catalog_api:
the shared package owns the wire shapes + the router factory over host-supplied
stores; the pure computation lives in `recommendation_grid.build_recommendation_grid`.

The endpoint returns fit + why + the quality/faster picks ONLY; the UI overlays live
download/load status by `modelId` from the `/v1/llm-runner/models` it already holds
(one status truth, no duplication).
"""

from __future__ import annotations

from typing import Callable

from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..runner.config import DEFAULT_SAFETY_MARGIN_MB
from . import seed
from .recommendation_grid import build_recommendation_grid


class GridPick(BaseModel):
    """One model pick in a grid cell (quality or faster). `fit` is the coarse band
    for THIS tier; the UI overlays live download/load status by `modelId`."""

    modelId: str
    name: str = ""
    params: str = ""           # totalParams, e.g. "35B"
    fit: str = ""              # ok | tight | cpu
    rank: int = 100
    why: str = ""


class GridCell(BaseModel):
    tier: str                  # DEFAULT_HARDWARE_TIERS key
    function: str              # chat | prose | extract | analysis | other | embed
    quality: GridPick | None = None   # best-ranked model that fits this tier
    faster: GridPick | None = None    # a lighter model that also fits (or none)


class GridTier(BaseModel):
    key: str
    label: str
    vramMb: int = 0
    ramMb: int = 0


class GridResponse(BaseModel):
    functions: list[str] = Field(default_factory=list)         # column keys present
    functionLabels: dict[str, str] = Field(default_factory=dict)
    tiers: list[GridTier] = Field(default_factory=list)        # rows
    cells: list[GridCell] = Field(default_factory=list)        # len == tiers × functions


def make_recommendation_grid_router(
    get_rec_store: Callable[[], object],
    get_catalog_store: Callable[[], object],
    get_task_kinds: Callable[[], object],
    *,
    get_margin_mb: Callable[[], int] | None = None,
) -> APIRouter:
    """The grid endpoint. Stores are host-supplied (JustWrite: the shared DB stores;
    JustVoice at adoption). `get_margin_mb` None → `DEFAULT_SAFETY_MARGIN_MB` (the coarse
    grid uses the same VRAM safety margin as the catalog Fit badge)."""
    router = APIRouter(tags=["ai"], prefix="/v1/ai")

    @router.get("/recommendation-grid", response_model=GridResponse)
    async def recommendation_grid() -> GridResponse:
        margin = (get_margin_mb() if get_margin_mb is not None else None) or DEFAULT_SAFETY_MARGIN_MB
        data = build_recommendation_grid(
            catalog_rows=get_catalog_store().list(),
            recommendations=get_rec_store().list(),
            task_kinds=get_task_kinds().list(),
            tiers=seed.DEFAULT_HARDWARE_TIERS,
            function_of=seed.function_of,
            function_order=seed.FUNCTION_ORDER,
            function_labels=seed.FUNCTION_LABELS,
            margin_mb=int(margin),
        )
        return GridResponse(**data)

    return router
