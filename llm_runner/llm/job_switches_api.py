# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared per-Profile switch router — a routing job's engine switches
(`job_route_switches`). A Profile = a job + its model + these switches; the lab
edits them through the shared KnobGrid. PUT replaces the whole set for a
(config, job) — the grid sends every row (same shape as switch-presets). Mirrors
`make_switches_router`; the host implements `JobRouteSwitchStore`. Read at load by
`switch_resolve.resolve_profile_switches`.
"""

from __future__ import annotations

from typing import Callable, Protocol

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel


class JobSwitchRow(BaseModel):
    """One spawn-flag on a Profile (job route). `flagName` maps to an `Overrides`
    field or routes to `extra_flags`; `flagValue` is text the runner parses."""

    flagName: str
    flagValue: str = ""
    builtIn: bool = False


class JobSwitchesResponse(BaseModel):
    configId: str
    jobId: str
    switches: list[JobSwitchRow]


class JobSwitchesPut(BaseModel):
    jobId: str
    configId: str = "active"
    switches: list[JobSwitchRow] = []


class JobSwitchesPrefill(BaseModel):
    """Ask the server to fill a Profile's switches from its model's type-default."""

    jobId: str
    model: str = ""
    configId: str = "active"


class JobRouteSwitchStore(Protocol):
    """Persistence boundary the host implements over its own storage."""

    def list(self, config_id: str, job_id: str) -> list[JobSwitchRow]: ...
    def replace(
        self, config_id: str, job_id: str, switches: list[JobSwitchRow]
    ) -> list[JobSwitchRow]: ...  # replaces the whole (config, job) set


def make_job_switches_router(
    get_store: Callable[[], JobRouteSwitchStore], *, prefill: Callable | None = None
) -> APIRouter:
    """GET/PUT a Profile's engine switches (PUT replaces the whole (config, job)
    set). When `prefill(config_id, job_id, model) -> list[JobSwitchRow]` is given,
    also expose POST /job-switches/prefill (fill from the model's type-default)."""
    router = APIRouter(tags=["ai"], prefix="/v1/ai")

    @router.get("/job-switches", response_model=JobSwitchesResponse)
    async def list_switches(jobId: str, configId: str = "active") -> JobSwitchesResponse:
        if not jobId.strip():
            raise HTTPException(status_code=400, detail="jobId is required")
        return JobSwitchesResponse(
            configId=configId, jobId=jobId, switches=get_store().list(configId, jobId)
        )

    @router.put("/job-switches", response_model=JobSwitchesResponse)
    async def put_switches(body: JobSwitchesPut) -> JobSwitchesResponse:
        if not body.jobId.strip():
            raise HTTPException(status_code=400, detail="jobId is required")
        cfg = body.configId or "active"
        rows = get_store().replace(cfg, body.jobId, body.switches)
        return JobSwitchesResponse(configId=cfg, jobId=body.jobId, switches=rows)

    if prefill is not None:
        @router.post("/job-switches/prefill", response_model=JobSwitchesResponse)
        async def prefill_switches(body: JobSwitchesPrefill) -> JobSwitchesResponse:
            if not body.jobId.strip():
                raise HTTPException(status_code=400, detail="jobId is required")
            cfg = body.configId or "active"
            rows = prefill(cfg, body.jobId, body.model)
            return JobSwitchesResponse(configId=cfg, jobId=body.jobId, switches=rows)

    return router
