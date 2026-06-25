# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared model-recommendations router behind a host-supplied storage boundary.

The Q3 layer of QuickSetup — "what is this model good FOR?" — the one piece
hardware-fit + auto-spawn flags CANNOT answer (Q1 "will it run?" = `coarse_fit`;
Q2 "how to run it" = `compute_fit` + flag presets). Tracks human-judgment per
model: a list of `jobs` the model is good at (e.g. "quick", "accuracy",
"attribution", "prose"), a `rank` within each job, and a cited `why`. The
QuickSetup wizard pre-fills role picks from these rows (filter by job + Fit-OK,
order by rank); a manual editor surfaces them for the user to add/edit/reset.

Mirrors `routing_api.py` / `feature_presets_api.py`: the shared package owns the
wire shape + the router factory + an abstract `RecommendationStore` Protocol —
no storage. Each host (JustWrite, JustVoice) implements the Protocol over its
own SQLite + ships factory defaults via merge-by-id seed (the
`seed_default_providers` pattern).

`built_in` distinguishes a seeded row from a user-added one — same convention as
`LlmProvider.built_in` — so the editor can offer "reset to factory" by deleting
user edits to a built-in row + re-seeding. The shape is `(modelId, job)` so a
single model can be ranked for multiple jobs without duplicating the rest of
the row.
"""

from __future__ import annotations

from typing import Callable, Protocol

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel


# Suggested job keys (NOT enforced — hosts can add their own). Quick + accuracy
# match the two role names dispatch already understands (routing_api.py:44);
# the rest are catalog-curation tags ("good for prose" / "extraction" / ...).
SUGGESTED_JOBS = ("quick", "accuracy", "attribution", "prose", "chat", "extraction", "embedding")


class RecommendationRow(BaseModel):
    """One curated 'model X is good for job Y' record. `modelId` matches a runner
    catalog id (or any HF GGUF id the user pasted). `rank` orders candidates
    within a job (lower = preferred). `why` is the cited reason the wizard shows
    next to the pick. `built_in` = shipped default vs user-added/edited."""

    modelId: str
    job: str  # one of SUGGESTED_JOBS or any host-defined string
    rank: int = 100
    why: str = ""
    builtIn: bool = False


class RecommendationStore(Protocol):
    """Persistence boundary the host implements over its own storage."""

    def list(self) -> list[RecommendationRow]: ...
    def upsert(self, row: RecommendationRow) -> RecommendationRow: ...  # upsert by (modelId, job)
    def delete(self, model_id: str, job: str) -> None: ...
    def reset_to_factory(self) -> None: ...  # re-seed built_in rows from the host's factory list


class RecommendationsResponse(BaseModel):
    rows: list[RecommendationRow]


def make_recommendations_router(get_store: Callable[[], RecommendationStore]) -> APIRouter:
    """CRUD + reset for per-model job-tag recommendations. Every mutating call
    returns the full list (the editor re-renders from it, like routing-presets).
    """
    router = APIRouter(tags=["ai"], prefix="/v1/ai")

    def _list() -> RecommendationsResponse:
        return RecommendationsResponse(rows=get_store().list())

    @router.get("/recommendations", response_model=RecommendationsResponse)
    async def list_recommendations() -> RecommendationsResponse:
        return _list()

    @router.put("/recommendations", response_model=RecommendationsResponse)
    async def upsert_recommendation(body: RecommendationRow) -> RecommendationsResponse:
        if not body.modelId.strip() or not body.job.strip():
            raise HTTPException(status_code=400, detail="modelId and job are required")
        # User edits to a built-in row stay editable but lose the built_in flag,
        # so reset_to_factory restores the shipped default cleanly.
        body.builtIn = False
        get_store().upsert(body)
        return _list()

    @router.delete("/recommendations", response_model=RecommendationsResponse)
    async def delete_recommendation(modelId: str, job: str) -> RecommendationsResponse:
        if not modelId.strip() or not job.strip():
            raise HTTPException(status_code=400, detail="modelId and job are required")
        get_store().delete(modelId, job)
        return _list()

    @router.post("/recommendations/reset", response_model=RecommendationsResponse)
    async def reset_recommendations() -> RecommendationsResponse:
        get_store().reset_to_factory()
        return _list()

    return router
