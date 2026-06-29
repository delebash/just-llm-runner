# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared engine-preset router — the 2026-06-29 lab + preset model.

An ENGINE PRESET = a reusable engine config (model + frozen Plane-1 switches +
per-request params + optional hardware-fit-knob overrides) built and saved in the
Lab. It is the SOURCE OF TRUTH for what runs (combined with a feature's prompt).

A feature resolves its preset via the cascade:
    its own override (FeaturePresetRef) → its CATEGORY's preset (CategoryPreset)
    → the global default preset.

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


class CategoryAssignment(BaseModel):
    category: str
    presetId: str = ""   # "" → clear (category falls back to the default)


class FeatureAssignment(BaseModel):
    featureKey: str
    presetId: str = ""   # "" → clear (feature inherits its category)


class DefaultAssignment(BaseModel):
    presetId: str = ""


class EnginePresetStore(Protocol):
    """Persistence boundary the host implements over its own storage."""

    def list(self) -> list[EnginePresetRow]: ...
    def save(self, preset: EnginePresetRow) -> EnginePresetRow: ...  # upsert by id (assigns id when empty)
    def delete(self, preset_id: str) -> None: ...


class CategoryPresetStore(Protocol):
    def list(self) -> dict[str, str]: ...                      # category → preset_id
    def set(self, category: str, preset_id: str) -> None: ...  # "" clears the row


class FeaturePresetRefStore(Protocol):
    def list(self) -> dict[str, str]: ...                      # feature_key → preset_id
    def set(self, feature_key: str, preset_id: str) -> None: ...  # "" clears the row


class PresetsResponse(BaseModel):
    presets: list[EnginePresetRow]


class AssignmentsResponse(BaseModel):
    defaultPresetId: str = ""
    categories: dict[str, str] = {}   # category → preset_id
    features: dict[str, str] = {}     # feature_key → preset_id (overrides)


def make_presets_router(
    get_presets: Callable[[], EnginePresetStore],
    get_categories: Callable[[], CategoryPresetStore],
    get_refs: Callable[[], FeaturePresetRefStore],
    get_default: Callable[[], str],
    set_default: Callable[[str], None],
) -> APIRouter:
    """CRUD for engine presets + the three assignment layers (default · category ·
    per-feature override). Mutating calls return the full list/assignments so the UI
    re-renders from one response."""
    router = APIRouter(tags=["ai"], prefix="/v1/ai")

    def _presets() -> PresetsResponse:
        return PresetsResponse(presets=get_presets().list())

    def _assignments() -> AssignmentsResponse:
        return AssignmentsResponse(
            defaultPresetId=get_default(),
            categories=get_categories().list(),
            features=get_refs().list(),
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

    # ── assignments (default · category · per-feature override) ────────────────
    @router.get("/preset-assignments", response_model=AssignmentsResponse)
    async def list_assignments() -> AssignmentsResponse:
        return _assignments()

    @router.put("/preset-assignments/default", response_model=AssignmentsResponse)
    async def put_default(body: DefaultAssignment) -> AssignmentsResponse:
        set_default(body.presetId)
        return _assignments()

    @router.put("/preset-assignments/category", response_model=AssignmentsResponse)
    async def put_category(body: CategoryAssignment) -> AssignmentsResponse:
        if not body.category.strip():
            raise HTTPException(status_code=400, detail="category is required")
        get_categories().set(body.category, body.presetId)
        return _assignments()

    @router.put("/preset-assignments/feature", response_model=AssignmentsResponse)
    async def put_feature(body: FeatureAssignment) -> AssignmentsResponse:
        if not body.featureKey.strip():
            raise HTTPException(status_code=400, detail="featureKey is required")
        get_refs().set(body.featureKey, body.presetId)
        return _assignments()

    return router
