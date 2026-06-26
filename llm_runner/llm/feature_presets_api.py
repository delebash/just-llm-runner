# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared feature-preset router behind a host-supplied storage boundary.

A *preset* is a named, saved AI config for one **action** (e.g. `writerAI.tighten`
or `critique`) — its model/role, prompt, and params. An action can have MANY
presets; the one marked **active** is that action's **production** config (the
Feature Workbench's "Use as production"). Actions are the unit; a "feature" like
writerAI is just the visual group its actions live under. Mirrors
`make_routing_presets_router`: a router factory over a host `FeaturePresetStore`
(real persistence — JustWrite a `feature_presets` table, JustVoice its own), so
both apps mount the SAME `/v1/ai/feature-presets*` surface the shared Feature
Workbench drives.

"Use as production" applies the active preset to the live config (the action's
prompt row + its routing pin), so the live config the dispatch runs IS the active
preset — this router is purely the CRUD + activate surface.
"""

from __future__ import annotations

import uuid
from typing import Callable, Protocol

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel


class FeaturePreset(BaseModel):
    """A named saved config for one ACTION. `active` marks the production one
    (at most one active per action). Model is an explicit provider+model;
    prompt/params override the action's seeded defaults."""

    id: str = ""
    action: str = ""  # the action key this configures, e.g. "writerAI.tighten"
    name: str = ""
    active: bool = False
    providerId: str = ""
    model: str = ""
    system: str = ""
    userTemplate: str = ""
    temperature: float | None = None
    think: bool = False


class FeaturePresetStore(Protocol):
    """Persistence boundary the host implements over its own storage."""

    def list_presets(self) -> list[FeaturePreset]: ...
    def save_preset(self, preset: FeaturePreset) -> FeaturePreset: ...  # upsert by id (assigns id when empty)
    def delete_preset(self, preset_id: str) -> None: ...
    def set_active(self, preset_id: str) -> None: ...  # mark active for its action; clears the action's others


class PresetsResponse(BaseModel):
    presets: list[FeaturePreset]


def make_feature_presets_router(get_store: Callable[[], FeaturePresetStore]) -> APIRouter:
    """CRUD + activate for per-feature presets. Every mutating call returns the
    full list (the workbench re-renders from it, like routing-presets)."""
    router = APIRouter(tags=["ai"], prefix="/v1/ai")

    def _list() -> PresetsResponse:
        return PresetsResponse(presets=get_store().list_presets())

    def _require(preset_id: str) -> FeaturePreset:
        for p in get_store().list_presets():
            if p.id == preset_id:
                return p
        raise HTTPException(status_code=404, detail=f"feature preset {preset_id!r} not found")

    @router.get("/feature-presets", response_model=PresetsResponse)
    async def list_presets() -> PresetsResponse:
        return _list()

    @router.post("/feature-presets", response_model=PresetsResponse)
    async def create_preset(body: FeaturePreset) -> PresetsResponse:
        if not body.action.strip() or not body.name.strip():
            raise HTTPException(status_code=400, detail="action and name are required")
        body.id = uuid.uuid4().hex[:12]
        get_store().save_preset(body)
        return _list()

    @router.put("/feature-presets/{preset_id}", response_model=PresetsResponse)
    async def update_preset(preset_id: str, body: FeaturePreset) -> PresetsResponse:
        existing = _require(preset_id)
        body.id = existing.id
        body.action = existing.action  # a preset never changes which action it configures
        body.active = existing.active
        get_store().save_preset(body)
        return _list()

    @router.delete("/feature-presets/{preset_id}", response_model=PresetsResponse)
    async def delete_preset(preset_id: str) -> PresetsResponse:
        get_store().delete_preset(preset_id)
        return _list()

    @router.post("/feature-presets/{preset_id}/use", response_model=PresetsResponse)
    async def use_preset(preset_id: str) -> PresetsResponse:
        _require(preset_id)
        get_store().set_active(preset_id)  # production: this one on, the feature's others off
        return _list()

    return router
