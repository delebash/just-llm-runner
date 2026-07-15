# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared engine-preset router — the 2026-06-29 lab + preset model, narrowed by
the §7.1 switches⇄params lock (2026-07-08).

An ENGINE PRESET = a reusable ask-config (model + per-request params +
long-tail samplers) built and saved in the Lab. It is the source of truth for
everything a task can own. It holds NO launch switches: launch config belongs to
the MODEL × machine tune stack (`switch_resolve` — global bundles → class_tunes →
model_tunes), edited in Tune & measure, because a loaded model is one process
with one set of launch flags shared by every task that points at it.

An ACTION resolves its preset via a two-tier lookup (2026-07-15, one source — the
task tier is gone): its own ref (FeaturePresetRef) → the global default preset
(the `default_preset_id` RunnerSetting).

The PROMPT is NOT here — it lives on the feature (FeaturePrompt). Long-tail
samplers are a variable-cardinality child.
"""

from __future__ import annotations

import uuid
from typing import Callable, Protocol

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .seed import app_engine_presets


class PresetFlagRow(BaseModel):
    """One long-tail sampler key-value in a preset. `flagName` rides the
    per-call `extra` at dispatch."""

    flagName: str
    flagValue: str = ""


class EnginePresetRow(BaseModel):
    """A reusable ask-config shared by the actions that point at it: model +
    request params + sampler tail.
    The Lab builds these; features point at them. No launch switches (§7.1)."""

    id: str = ""
    name: str = ""
    providerId: str = ""
    model: str = ""
    # Plane-2 per-request params:
    temperature: float | None = None
    topP: float | None = None
    maxTokens: int = 0                  # 0 → no cap
    reasoningEffort: str = ""           # "" | low | medium | high | xhigh | max
    think: bool = False                 # STORED (U2-T3): thinking on/off, no longer derived from the level
    samplers: list[PresetFlagRow] = []  # long-tail Plane-2 samplers
    builtIn: bool = False
    position: int = 0
    # READ-ONLY, filled at list time (D4-1 leg 3, 2026-07-06): the model this preset's
    # FACTORY seed points at (the app's registered library, by id; "" for user-created
    # presets). Clients use it to tell "differs from factory" honestly — writes ignore it.
    factoryModel: str = ""


class FeatureAssignment(BaseModel):
    featureKey: str      # the ACTION id
    presetId: str = ""   # "" → clear the ref (the feature falls to the default preset)


class FeatureClearRequest(BaseModel):
    """Bulk-clear the per-feature overrides for a set of features so each
    falls back to the default preset (used by the per-feature Reset)."""

    featureKeys: list[str] = []


class DefaultAssignment(BaseModel):
    presetId: str = ""


class EnginePresetStore(Protocol):
    """Persistence boundary the host implements over its own storage."""

    def list(self) -> list[EnginePresetRow]: ...
    def save(self, preset: EnginePresetRow) -> EnginePresetRow: ...  # upsert by id (assigns id when empty)
    def delete(self, preset_id: str) -> None: ...


class FeaturePresetRefStore(Protocol):
    def list(self) -> dict[str, str]: ...                         # feature_key(action) → preset_id
    def set(self, feature_key: str, preset_id: str) -> None: ...  # "" clears the row


class PresetsResponse(BaseModel):
    presets: list[EnginePresetRow]


class AssignmentsResponse(BaseModel):
    defaultPresetId: str = ""
    features: dict[str, str] = {}     # action → preset_id (the one-source per-action assignment)


def make_presets_router(
    get_presets: Callable[[], EnginePresetStore],
    get_default: Callable[[], str],
    set_default: Callable[[str], None],
    get_refs: Callable[[], FeaturePresetRefStore],
    reset_all_fn: Callable[[], None] | None = None,
    reset_one_fn: Callable[[str], None] | None = None,
) -> APIRouter:
    """CRUD for engine presets + the two assignment layers (default · per-action ref)
    + the factory resets. Mutating calls return the full list/assignments so the UI
    re-renders from one response. `reset_all_fn` restores all built-in presets + seeded
    refs + the default; `reset_one_fn` resets ONE built-in preset (2026-07-15)."""
    router = APIRouter(tags=["ai"], prefix="/v1/ai")

    def _presets() -> PresetsResponse:
        rows = get_presets().list()
        # D4-1 leg 3: annotate each row with its factory model (the app's registered
        # seed library, joined by preset id) so the wizard can detect "differs from
        # factory" without a second endpoint.
        factory = {str(p.get("id") or ""): str(p.get("model") or "") for p in app_engine_presets()}
        for r in rows:
            r.factoryModel = factory.get(r.id, "")
        return PresetsResponse(presets=rows)

    def _assignments() -> AssignmentsResponse:
        return AssignmentsResponse(
            defaultPresetId=get_default(),
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

    # ── factory resets (Presets page: Reset all · per-preset Reset) ─────────────
    @router.post("/engine-presets/reset", response_model=PresetsResponse)
    async def reset_presets() -> PresetsResponse:
        """Restore all built-in presets + the seeded per-action refs + the default
        preset to factory (custom presets kept)."""
        if reset_all_fn is not None:
            reset_all_fn()
        return _presets()

    @router.post("/engine-presets/{preset_id}/reset", response_model=PresetsResponse)
    async def reset_one_preset(preset_id: str) -> PresetsResponse:
        """Reset ONE built-in preset to factory (params + samplers). 400 on a custom
        preset (nothing to reset to)."""
        if reset_one_fn is not None:
            try:
                reset_one_fn(preset_id)
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e)) from e
        return _presets()

    # ── assignments (default · per-action ref) ─────────────────────────────────
    @router.get("/preset-assignments", response_model=AssignmentsResponse)
    async def list_assignments() -> AssignmentsResponse:
        return _assignments()

    @router.put("/preset-assignments/default", response_model=AssignmentsResponse)
    async def put_default(body: DefaultAssignment) -> AssignmentsResponse:
        set_default(body.presetId)
        return _assignments()

    @router.put("/preset-assignments/feature", response_model=AssignmentsResponse)
    async def put_feature(body: FeatureAssignment) -> AssignmentsResponse:
        """Set (or clear, presetId="") a feature's per-feature preset OVERRIDE —
        the top tier of the cascade. Keyed by ACTION id."""
        if not body.featureKey.strip():
            raise HTTPException(status_code=400, detail="featureKey is required")
        get_refs().set(body.featureKey, body.presetId)
        return _assignments()

    @router.post("/preset-assignments/clear-features", response_model=AssignmentsResponse)
    async def clear_features(body: FeatureClearRequest) -> AssignmentsResponse:
        """Clear the per-feature override for each given feature so it re-inherits
        the default preset (the per-feature Reset path)."""
        refs = get_refs()
        for key in body.featureKeys:
            if key.strip():
                refs.set(key, "")
        return _assignments()

    return router
