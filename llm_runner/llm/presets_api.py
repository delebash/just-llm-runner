# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared engine-preset router — the 2026-06-29 lab + preset model.

An ENGINE PRESET = a reusable engine config (model + frozen Plane-1 switches +
per-request params + optional hardware-fit-knob overrides) built and saved in the
Lab. It is the SOURCE OF TRUTH for what runs (combined with a feature's prompt).

A feature resolves its preset via the cascade (2026-07-02 "task owns the preset"):
    its taskKind's preset (TaskKindPreset) → the global default preset.
(The per-feature override tier was removed — a feature's preset IS its task's.)

The PROMPT is NOT here — it lives on the feature (FeaturePrompt). Switches and
long-tail samplers are variable-cardinality children; `nglOverride` /
`nCpuMoeOverride` are nullable (null = auto-compute the fit knob at load).
"""

from __future__ import annotations

import uuid
from typing import Callable, Protocol

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel


class PresetFlagRow(BaseModel):
    """One flag/sampler key-value in a preset (a frozen switch, or a long-tail
    sampler). `flagName` maps to an `Overrides` field / `extra_flags` (switches) or
    rides the per-call `extra` (samplers)."""

    flagName: str
    flagValue: str = ""


class EnginePresetRow(BaseModel):
    """A reusable engine config: model + params + frozen switches + sampler tail +
    optional fit-knob overrides. The Lab builds these; features point at them."""

    id: str = ""
    name: str = ""
    providerId: str = ""
    model: str = ""
    # Plane-2 per-request params:
    temperature: float | None = None
    topP: float | None = None
    maxTokens: int = 0                  # 0 → no cap
    jsonMode: bool = False
    reasoningEffort: str = ""           # "" | low | medium | high
    # Hardware-fit knobs: null → auto-compute at load; set → frozen override that wins.
    nglOverride: int | None = None
    nCpuMoeOverride: int | None = None
    switches: list[PresetFlagRow] = []  # frozen Plane-1 engine switches
    samplers: list[PresetFlagRow] = []  # long-tail Plane-2 samplers
    builtIn: bool = False
    position: int = 0


class TaskKindAssignment(BaseModel):
    taskKind: str
    presetId: str = ""   # "" → clear (this taskKind falls back to the default)


class DefaultAssignment(BaseModel):
    presetId: str = ""


class EnginePresetStore(Protocol):
    """Persistence boundary the host implements over its own storage."""

    def list(self) -> list[EnginePresetRow]: ...
    def save(self, preset: EnginePresetRow) -> EnginePresetRow: ...  # upsert by id (assigns id when empty)
    def delete(self, preset_id: str) -> None: ...


class TaskKindPresetStore(Protocol):
    def list(self) -> dict[str, str]: ...                       # task_kind → preset_id
    def set(self, task_kind: str, preset_id: str) -> None: ...  # "" clears the row


class PresetsResponse(BaseModel):
    presets: list[EnginePresetRow]


class AssignmentsResponse(BaseModel):
    defaultPresetId: str = ""
    taskKinds: dict[str, str] = {}    # task_kind → preset_id


def make_presets_router(
    get_presets: Callable[[], EnginePresetStore],
    get_task_kinds: Callable[[], TaskKindPresetStore],
    get_default: Callable[[], str],
    set_default: Callable[[str], None],
) -> APIRouter:
    """CRUD for engine presets + the two assignment layers (default · task-kind).
    Mutating calls return the full list/assignments so the UI re-renders from one
    response. (2026-07-02 Plan A: the per-feature override layer was removed — a
    feature's preset IS its task's.)"""
    router = APIRouter(tags=["ai"], prefix="/v1/ai")

    def _presets() -> PresetsResponse:
        return PresetsResponse(presets=get_presets().list())

    def _assignments() -> AssignmentsResponse:
        return AssignmentsResponse(
            defaultPresetId=get_default(),
            taskKinds=get_task_kinds().list(),
        )

    # ── presets CRUD ──────────────────────────────────────────────────────────
    @router.get("/engine-presets", response_model=PresetsResponse)
    async def list_presets() -> PresetsResponse:
        return _presets()

    @router.post("/engine-presets", response_model=PresetsResponse)
    async def create_preset(body: EnginePresetRow) -> PresetsResponse:
        if not body.name.strip():
            raise HTTPException(status_code=400, detail="name is required")
        body.id = uuid.uuid4().hex[:12]
        get_presets().save(body)
        return _presets()

    @router.put("/engine-presets/{preset_id}", response_model=PresetsResponse)
    async def update_preset(preset_id: str, body: EnginePresetRow) -> PresetsResponse:
        if not any(p.id == preset_id for p in get_presets().list()):
            raise HTTPException(status_code=404, detail=f"preset {preset_id!r} not found")
        body.id = preset_id
        get_presets().save(body)
        return _presets()

    @router.delete("/engine-presets/{preset_id}", response_model=PresetsResponse)
    async def delete_preset(preset_id: str) -> PresetsResponse:
        get_presets().delete(preset_id)
        return _presets()

    # ── assignments (default · task-kind) ──────────────────────────────────────
    @router.get("/preset-assignments", response_model=AssignmentsResponse)
    async def list_assignments() -> AssignmentsResponse:
        return _assignments()

    @router.put("/preset-assignments/default", response_model=AssignmentsResponse)
    async def put_default(body: DefaultAssignment) -> AssignmentsResponse:
        set_default(body.presetId)
        return _assignments()

    @router.put("/preset-assignments/task-kind", response_model=AssignmentsResponse)
    async def put_task_kind(body: TaskKindAssignment) -> AssignmentsResponse:
        if not body.taskKind.strip():
            raise HTTPException(status_code=400, detail="taskKind is required")
        get_task_kinds().set(body.taskKind, body.presetId)
        return _assignments()

    return router
