# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared JOBS + feature→job routers behind host-supplied storage boundaries.

A *job* is the routing unit that replaces the two fixed `role`s (quick/accuracy):
a small, **user-editable** list of task archetypes (seeded `chat · prose ·
extraction · analysis`, not capped). Each feature is classified into one job, and
a job carries the model + switches that run it (the job→model map + switches land
in routing, built separately). This module owns just the two editable lists:

  * JobStore         → /v1/ai/jobs          (GET / POST create / PUT / DELETE / reset)
  * FeatureJobStore  → /v1/ai/feature-jobs  (GET / PUT upsert / DELETE / reset)

Mirrors `recommendations_api.py` / `model_catalog_api.py`: the shared package owns
the wire shape + Protocol + router factory (no storage); each host (JustWrite,
JustVoice) implements the Protocol over its own SQLite and ships factory defaults
via merge-by-key seed (the `seed_default_providers` pattern). `builtIn` marks a
seeded row so the editor can offer "reset to factory".

A job's `id` is IMMUTABLE (a slug minted from the label at create time) so a
rename — which edits only the `label` — never orphans the `feature_jobs` /
`job_routes` / `model_recommendations` rows that reference it. This matches the
provider precedent (`provider_api.py` keeps an id immutable so renames don't
orphan pins). Deleting a job is allowed; a feature whose job no longer exists
falls back to the default job at dispatch (graceful, like an unregistered
provider).
"""

from __future__ import annotations

import re
from typing import Callable, Protocol

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

# The factory job ids (seeded by each host). Not enforced — hosts/users add more.
DEFAULT_JOB_ID = "chat"  # the guaranteed-present fallback when a feature's job is gone


def slugify_job_id(label: str, existing: set[str]) -> str:
    """Mint a stable, readable, unique id from a label (lower-kebab). Falls back
    to `job` when the label has no slug-able chars; de-dupes with -2/-3/…"""
    base = re.sub(r"[^a-z0-9]+", "-", (label or "").strip().lower()).strip("-") or "job"
    if base not in existing:
        return base
    n = 2
    while f"{base}-{n}" in existing:
        n += 1
    return f"{base}-{n}"


# ── Jobs (the editable routing-unit list) ────────────────────────────────────

class JobRow(BaseModel):
    """One job. `id` is an immutable slug; `label`/`description`/`position` are
    editable. `builtIn` = shipped default vs user-added/edited."""

    id: str = ""
    label: str = ""
    description: str = ""
    position: int = 0
    builtIn: bool = False


class JobStore(Protocol):
    """Persistence boundary the host implements over its own storage."""

    def list(self) -> list[JobRow]: ...
    def upsert(self, row: JobRow) -> JobRow: ...  # upsert by id (caller assigns a fresh id on create)
    def delete(self, job_id: str) -> None: ...
    def reset_to_factory(self) -> None: ...


class JobsResponse(BaseModel):
    rows: list[JobRow]


def make_jobs_router(get_store: Callable[[], JobStore]) -> APIRouter:
    """CRUD + reset for the editable job list. Every mutating call returns the
    full list (the editor re-renders from it). `id` is minted on create and never
    changes (rename edits only the label)."""
    router = APIRouter(tags=["ai"], prefix="/v1/ai")

    def _list() -> JobsResponse:
        return JobsResponse(rows=get_store().list())

    @router.get("/jobs", response_model=JobsResponse)
    async def list_jobs() -> JobsResponse:
        return _list()

    @router.post("/jobs", response_model=JobsResponse)
    async def create_job(body: JobRow) -> JobsResponse:
        if not body.label.strip():
            raise HTTPException(status_code=400, detail="label is required")
        existing = {r.id for r in get_store().list()}
        body.id = slugify_job_id(body.label, existing)  # immutable from here on
        body.builtIn = False
        get_store().upsert(body)
        return _list()

    @router.put("/jobs/{job_id}", response_model=JobsResponse)
    async def update_job(job_id: str, body: JobRow) -> JobsResponse:
        rows = {r.id: r for r in get_store().list()}
        existing = rows.get(job_id)
        if existing is None:
            raise HTTPException(status_code=404, detail=f"job {job_id!r} not found")
        body.id = existing.id  # id is immutable — a rename only edits the label
        body.builtIn = existing.builtIn  # edits to a built-in stay built-in (reset restores label/desc)
        get_store().upsert(body)
        return _list()

    @router.delete("/jobs/{job_id}", response_model=JobsResponse)
    async def delete_job(job_id: str) -> JobsResponse:
        if job_id == DEFAULT_JOB_ID:
            raise HTTPException(status_code=400, detail=f"the default job {job_id!r} cannot be deleted")
        get_store().delete(job_id)
        return _list()

    @router.post("/jobs/reset", response_model=JobsResponse)
    async def reset_jobs() -> JobsResponse:
        get_store().reset_to_factory()
        return _list()

    return router


# ── Feature → job map (the per-feature classification dropdown) ───────────────

class FeatureJobRow(BaseModel):
    """One feature's job classification. `featureKey` matches the host feature
    catalog; `jobId` is a `JobRow.id`. A feature with no row falls back to the
    default job. `builtIn` = shipped best-guess vs user-edited."""

    featureKey: str
    jobId: str = ""
    builtIn: bool = False


class FeatureJobStore(Protocol):
    """Persistence boundary the host implements over its own storage."""

    def list(self) -> list[FeatureJobRow]: ...
    def upsert(self, row: FeatureJobRow) -> FeatureJobRow: ...  # upsert by featureKey
    def delete(self, feature_key: str) -> None: ...  # delete = revert that feature to the default job
    def reset_to_factory(self) -> None: ...


class FeatureJobsResponse(BaseModel):
    rows: list[FeatureJobRow]


def make_feature_jobs_router(get_store: Callable[[], FeatureJobStore]) -> APIRouter:
    """GET + upsert + delete + reset for the feature→job map (the per-feature
    dropdown in Routing-by-feature). Upsert by featureKey; delete reverts a
    feature to the default job."""
    router = APIRouter(tags=["ai"], prefix="/v1/ai")

    def _list() -> FeatureJobsResponse:
        return FeatureJobsResponse(rows=get_store().list())

    @router.get("/feature-jobs", response_model=FeatureJobsResponse)
    async def list_feature_jobs() -> FeatureJobsResponse:
        return _list()

    @router.put("/feature-jobs", response_model=FeatureJobsResponse)
    async def upsert_feature_job(body: FeatureJobRow) -> FeatureJobsResponse:
        if not body.featureKey.strip() or not body.jobId.strip():
            raise HTTPException(status_code=400, detail="featureKey and jobId are required")
        body.builtIn = False  # user edit drops the seed marker; reset restores it
        get_store().upsert(body)
        return _list()

    @router.delete("/feature-jobs/{feature_key}", response_model=FeatureJobsResponse)
    async def delete_feature_job(feature_key: str) -> FeatureJobsResponse:
        get_store().delete(feature_key)
        return _list()

    @router.post("/feature-jobs/reset", response_model=FeatureJobsResponse)
    async def reset_feature_jobs() -> FeatureJobsResponse:
        get_store().reset_to_factory()
        return _list()

    return router
