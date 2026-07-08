# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared test-samples router (§7.3, 2026-07-08) — the canned per-taskKind Lab
samples ("sample data we have in database", the user's #30). GET lists (all, or
one taskKind's) for the Lab's Sample button; PUT/DELETE keep the rows editable
(the seed is fill-if-empty, so an edit sticks). Sibling precedent:
class_tunes_api.py (the same Protocol-store + router-factory seam)."""

from __future__ import annotations

from typing import Callable, Protocol

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel


class TestSampleRow(BaseModel):
    id: int
    taskKind: str
    label: str
    variables: dict[str, str] = {}


class TestSamplesResponse(BaseModel):
    rows: list[TestSampleRow]


class TestSamplePut(BaseModel):
    id: int | None = None  # None → create
    taskKind: str
    label: str
    variables: dict[str, str] = {}


class TestSampleStore(Protocol):
    """Persistence boundary the host implements over its own storage."""

    def list_for_kind(self, task_kind: str = "") -> list[dict]: ...
    def upsert(self, task_kind: str, label: str, variables: dict[str, str],
               sample_id: int | None = None) -> int: ...
    def delete(self, sample_id: int) -> None: ...


def make_test_samples_router(get_store: Callable[[], TestSampleStore]) -> APIRouter:
    """GET (?taskKind= filters) / PUT (upsert one) / DELETE (?id=)."""
    router = APIRouter(tags=["ai"], prefix="/v1/ai")

    def _rows(task_kind: str = "") -> TestSamplesResponse:
        return TestSamplesResponse(
            rows=[TestSampleRow(**r) for r in get_store().list_for_kind(task_kind)])

    @router.get("/test-samples", response_model=TestSamplesResponse)
    async def list_test_samples(taskKind: str = "") -> TestSamplesResponse:
        return _rows(taskKind.strip())

    @router.put("/test-samples", response_model=TestSamplesResponse)
    async def put_test_sample(body: TestSamplePut) -> TestSamplesResponse:
        if not body.taskKind.strip() or not body.label.strip():
            raise HTTPException(status_code=400, detail="taskKind and label are required")
        get_store().upsert(body.taskKind.strip(), body.label.strip(),
                           body.variables or {}, body.id)
        return _rows(body.taskKind.strip())

    @router.delete("/test-samples", response_model=TestSamplesResponse)
    async def delete_test_sample(id: int) -> TestSamplesResponse:
        get_store().delete(id)
        return _rows()

    return router
