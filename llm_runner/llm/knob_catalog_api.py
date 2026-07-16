# SPDX-License-Identifier: GPL-3.0-or-later
"""Knob-catalog endpoint — friendly metadata for the shared KnobGrid (C1).

Turns a raw switch/sampler key into a typed input: the KnobGrid takes a
`catalog` (name → {help, kind}); this serves the seeded metadata so both
the Plane-1 switch editors and the per-action sampler editor (Plane 2) render
friendly inputs. Data-only — no code per param; an unknown key still works as a
raw row (the KnobGrid escape). GET-only: the catalog is app-owned seed data."""

from __future__ import annotations

from typing import Callable

from fastapi import APIRouter
from pydantic import BaseModel


class KnobOption(BaseModel):
    value: str
    label: str = ""


class KnobMeta(BaseModel):
    flagName: str
    kind: str = "string"        # bool | int | float | enum | string
    default: str = ""
    help: str = ""
    plane: int = 1              # 1 = load switch, 2 = sampler
    appliesTo: str = "all"     # all | moe | dense
    tier: str = "common"       # common | advanced (UI checklist split)
    perRequest: bool = False   # plane-1 switch sent per REQUEST, not a launch flag (reasoning_budget)
    options: list[KnobOption] = []


class KnobCatalogResponse(BaseModel):
    knobs: list[KnobMeta]


def make_knob_catalog_router(get_knobs: Callable[[], list[dict]]) -> APIRouter:
    """GET /v1/ai/knob-catalog. `get_knobs` returns the joined catalog rows
    (stores.list_knob_catalog)."""
    router = APIRouter(tags=["ai"], prefix="/v1/ai")

    @router.get("/knob-catalog", response_model=KnobCatalogResponse)
    async def knob_catalog() -> KnobCatalogResponse:
        return KnobCatalogResponse(knobs=[KnobMeta(**k) for k in get_knobs()])

    return router
