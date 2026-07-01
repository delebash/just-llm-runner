# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared model-recommendations router behind a host-supplied storage boundary.

The "what is this model good FOR?" layer of QuickSetup — the one piece
hardware-fit + auto-spawn flags CANNOT answer (fit = `coarse_fit`; how-to-run =
`compute_fit` + the switch presets). Tracks human judgment per model: which
`taskKind`s the model is good at (e.g. "prose.generate", "extract.structured"),
a `rank` within each taskKind, and a cited `why`. QuickSetup filters by taskKind
+ Fit-OK, orders by rank; a manual editor surfaces them to add/edit/reset.

Mirrors `routing_api.py` / `feature_presets_api.py`: the shared package owns the
wire shape + the router factory + an abstract `RecommendationStore` Protocol —
no storage. Each host implements the Protocol over its own SQLite + ships factory
defaults via merge-by-id seed (the `seed_default_providers` pattern).

`built_in` distinguishes a seeded row from a user-added one — same convention as
`LlmProvider.built_in` — so the editor can offer "reset to factory". The shape is
`(modelId, taskKind)` so a single model can be ranked for multiple taskKinds
without duplicating the rest of the row.
"""

from __future__ import annotations

from typing import Callable, Protocol

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel


class RecommendationRow(BaseModel):
    """One curated 'model X is good for taskKind Y' record. `modelId` matches a
    runner catalog id (or any HF GGUF id the user pasted). `rank` orders
    candidates within a taskKind (lower = preferred). `why` is the cited reason
    the wizard shows next to the pick. `built_in` = shipped default vs user row."""

    modelId: str
    taskKind: str
    rank: int = 100
    why: str = ""
    builtIn: bool = False


class RecommendationStore(Protocol):
    """Persistence boundary the host implements over its own storage."""

    def list(self) -> list[RecommendationRow]: ...
    def upsert(self, row: RecommendationRow) -> RecommendationRow: ...  # upsert by (modelId, taskKind)
    def delete(self, model_id: str, task_kind: str) -> None: ...
    def reset_to_factory(self) -> None: ...  # re-seed built_in rows from the host's factory list


class RecommendationsResponse(BaseModel):
    rows: list[RecommendationRow]


def make_recommendations_router(get_store: Callable[[], RecommendationStore]) -> APIRouter:
    """CRUD + reset for per-model taskKind-tag recommendations. Every mutating
    call returns the full list (the editor re-renders from it)."""
    router = APIRouter(tags=["ai"], prefix="/v1/ai")

    def _list() -> RecommendationsResponse:
        return RecommendationsResponse(rows=get_store().list())

    @router.get("/recommendations", response_model=RecommendationsResponse)
    async def list_recommendations() -> RecommendationsResponse:
        return _list()

    @router.put("/recommendations", response_model=RecommendationsResponse)
    async def upsert_recommendation(body: RecommendationRow) -> RecommendationsResponse:
        if not body.modelId.strip() or not body.taskKind.strip():
            raise HTTPException(status_code=400, detail="modelId and taskKind are required")
        # User edits to a built-in row stay editable but lose the built_in flag,
        # so reset_to_factory restores the shipped default cleanly.
        body.builtIn = False
        get_store().upsert(body)
        return _list()

    @router.delete("/recommendations", response_model=RecommendationsResponse)
    async def delete_recommendation(modelId: str, taskKind: str) -> RecommendationsResponse:
        if not modelId.strip() or not taskKind.strip():
            raise HTTPException(status_code=400, detail="modelId and taskKind are required")
        get_store().delete(modelId, taskKind)
        return _list()

    @router.post("/recommendations/reset", response_model=RecommendationsResponse)
    async def reset_recommendations() -> RecommendationsResponse:
        get_store().reset_to_factory()
        return _list()

    return router
