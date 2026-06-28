# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared job-preset router behind a host-supplied storage boundary.

A *job preset* is a named, saved Profile config for one **job** (chat / prose /
extraction / …) — its model + its engine switches. A job can have MANY presets;
**promote** writes the preset's model into the live `job_routes` row and replaces
that job's `job_route_switches` with the preset's switches (so the dispatch + the
runner load now use it). This is the per-JOB grain mirror of
`feature_presets_api` (per-action) and the replacement for the deleted whole-config
routing-presets — one preset system, not two (T3).
"""

from __future__ import annotations

import uuid
from typing import Callable, Protocol

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel


class JobPresetSwitchRow(BaseModel):
    flagName: str
    flagValue: str = ""


class JobPreset(BaseModel):
    """A named saved config for one JOB: its model + frozen engine switches.
    `promote` applies it to the live job route."""

    id: str = ""
    jobId: str = ""
    name: str = ""
    providerId: str = ""
    model: str = ""
    switches: list[JobPresetSwitchRow] = []
    builtIn: bool = False


class JobPresetStore(Protocol):
    """Persistence boundary the host implements over its own storage."""

    def list_presets(self) -> list[JobPreset]: ...
    def save_preset(self, preset: JobPreset) -> JobPreset: ...  # upsert by id (assigns id when empty)
    def delete_preset(self, preset_id: str) -> None: ...
    def promote(self, preset_id: str) -> None: ...  # write the live job_route + job_route_switches


class PresetsResponse(BaseModel):
    presets: list[JobPreset]


def make_job_presets_router(get_store: Callable[[], JobPresetStore]) -> APIRouter:
    """CRUD + promote for per-job presets. Every mutating call returns the full
    list (the lab re-renders from it, like feature-presets)."""
    router = APIRouter(tags=["ai"], prefix="/v1/ai")

    def _list() -> PresetsResponse:
        return PresetsResponse(presets=get_store().list_presets())

    def _require(preset_id: str) -> JobPreset:
        for p in get_store().list_presets():
            if p.id == preset_id:
                return p
        raise HTTPException(status_code=404, detail=f"job preset {preset_id!r} not found")

    @router.get("/job-presets", response_model=PresetsResponse)
    async def list_presets() -> PresetsResponse:
        return _list()

    @router.post("/job-presets", response_model=PresetsResponse)
    async def create_preset(body: JobPreset) -> PresetsResponse:
        if not body.jobId.strip() or not body.name.strip():
            raise HTTPException(status_code=400, detail="jobId and name are required")
        body.id = uuid.uuid4().hex[:12]
        get_store().save_preset(body)
        return _list()

    @router.put("/job-presets/{preset_id}", response_model=PresetsResponse)
    async def update_preset(preset_id: str, body: JobPreset) -> PresetsResponse:
        existing = _require(preset_id)
        body.id = existing.id
        body.jobId = existing.jobId  # a preset never changes which job it configures
        get_store().save_preset(body)
        return _list()

    @router.delete("/job-presets/{preset_id}", response_model=PresetsResponse)
    async def delete_preset(preset_id: str) -> PresetsResponse:
        get_store().delete_preset(preset_id)
        return _list()

    @router.post("/job-presets/{preset_id}/promote", response_model=PresetsResponse)
    async def promote_preset(preset_id: str) -> PresetsResponse:
        _require(preset_id)
        get_store().promote(preset_id)  # writes the live job_route + job_route_switches
        return _list()

    return router
