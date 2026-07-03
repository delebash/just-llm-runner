# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared switch-presets router — the capability/type switch bundles
(`base`/`moe`/`dense`) the resolver layers (see `switch_resolve`). Seeded +
user-editable + reset-to-factory, exactly like the model catalog. A preset is a
row (id / label / appliesTo) plus its flag rows (`preset_switches`); the PUT
replaces a preset's WHOLE flag set (the editor sends the full preset).

`appliesTo`: `all` (every model) · `moe`/`dense` (matches `model_catalog.type`).
(An `mtp` applies-to existed pre-2026-07-03 but was dropped in Phase 3 — MTP is
opt-in/measurable, not an auto-applied preset.) The host implements the Protocol
over its DB; the shared store does (JustWrite + JustVoice at adoption).
"""

from __future__ import annotations

from typing import Callable, Protocol

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel


class PresetSwitchRow(BaseModel):
    flagName: str
    flagValue: str = ""


class SwitchPresetRow(BaseModel):
    id: str
    label: str = ""
    appliesTo: str = "all"  # all | moe | dense
    position: int = 0
    builtIn: bool = False
    switches: list[PresetSwitchRow] = []


class SwitchPresetsResponse(BaseModel):
    rows: list[SwitchPresetRow]


class SwitchPresetStore(Protocol):
    """Persistence boundary the host implements over its own storage."""

    def list(self) -> list[SwitchPresetRow]: ...
    def upsert(self, row: SwitchPresetRow) -> SwitchPresetRow: ...  # replaces the preset's switches
    def delete(self, preset_id: str) -> None: ...
    def reset_to_factory(self) -> None: ...


def make_switch_presets_router(get_store: Callable[[], SwitchPresetStore]) -> APIRouter:
    """CRUD + reset for the capability/type switch presets."""
    router = APIRouter(tags=["ai"], prefix="/v1/ai")

    def _list() -> SwitchPresetsResponse:
        return SwitchPresetsResponse(rows=get_store().list())

    @router.get("/switch-presets", response_model=SwitchPresetsResponse)
    async def list_presets() -> SwitchPresetsResponse:
        return _list()

    @router.put("/switch-presets", response_model=SwitchPresetsResponse)
    async def upsert_preset(body: SwitchPresetRow) -> SwitchPresetsResponse:
        if not body.id.strip():
            raise HTTPException(status_code=400, detail="id is required")
        get_store().upsert(body)
        return _list()

    @router.delete("/switch-presets", response_model=SwitchPresetsResponse)
    async def delete_preset(presetId: str) -> SwitchPresetsResponse:
        if not presetId.strip():
            raise HTTPException(status_code=400, detail="presetId is required")
        get_store().delete(presetId)
        return _list()

    @router.post("/switch-presets/reset", response_model=SwitchPresetsResponse)
    async def reset_presets() -> SwitchPresetsResponse:
        get_store().reset_to_factory()
        return _list()

    return router
