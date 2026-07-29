# SPDX-License-Identifier: MIT
"""Shared test-samples router (§7.3, 2026-07-08; re-keyed per ACTION 2026-07-15 —
the task tier is gone) — the canned per-ACTION Lab samples ("sample data we have in
database", the user's #30). GET lists (all, or one action's) for the Lab's Sample
button; PUT/DELETE keep the rows editable (the seed is fill-if-empty, so an edit
sticks). Sibling precedent: class_tunes_api.py (the same Protocol-store + router
seam)."""

from __future__ import annotations

from typing import Callable, Protocol

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel


class TestSampleRow(BaseModel):
    id: int
    action: str
    label: str
    variables: dict[str, str] = {}


class TestSamplesResponse(BaseModel):
    rows: list[TestSampleRow]


class TestSamplePut(BaseModel):
    id: int | None = None  # None → create
    action: str
    label: str
    variables: dict[str, str] = {}


class TestSampleStore(Protocol):
    """Persistence boundary the host implements over its own storage."""

    def list_for_action(self, action: str = "") -> list[dict]: ...
    def upsert(self, action: str, label: str, variables: dict[str, str],
               sample_id: int | None = None) -> int: ...
    def delete(self, sample_id: int) -> None: ...


def make_test_samples_router(get_store: Callable[[], TestSampleStore]) -> APIRouter:
    """GET (?action= filters) / PUT (upsert one) / DELETE (?id=)."""
    router = APIRouter(tags=["ai"], prefix="/v1/ai")

    def _rows(action: str = "") -> TestSamplesResponse:
        return TestSamplesResponse(
            rows=[TestSampleRow(**r) for r in get_store().list_for_action(action)])

    @router.get("/test-samples", response_model=TestSamplesResponse)
    async def list_test_samples(action: str = "") -> TestSamplesResponse:
        return _rows(action.strip())

    @router.put("/test-samples", response_model=TestSamplesResponse)
    async def put_test_sample(body: TestSamplePut) -> TestSamplesResponse:
        if not body.action.strip() or not body.label.strip():
            raise HTTPException(status_code=400, detail="action and label are required")
        get_store().upsert(body.action.strip(), body.label.strip(),
                           body.variables or {}, body.id)
        return _rows(body.action.strip())

    @router.delete("/test-samples", response_model=TestSamplesResponse)
    async def delete_test_sample(id: int) -> TestSamplesResponse:
        get_store().delete(id)
        return _rows()

    return router
