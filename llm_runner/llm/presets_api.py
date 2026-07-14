# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared engine-preset router — the 2026-06-29 lab + preset model, narrowed by
the §7.1 switches⇄params lock (2026-07-08).

An ENGINE PRESET = a reusable per-TASK ask-config (model + per-request params +
long-tail samplers) built and saved in the Lab. It is the source of truth for
everything a task can own. It holds NO launch switches: launch config belongs to
the MODEL × machine tune stack (`switch_resolve` — global bundles → class_tunes →
model_tunes), edited in Tune & measure, because a loaded model is one process
with one set of launch flags shared by every task that points at it.

A feature resolves its preset via the 3-tier cascade (per-feature override restored
2026-07-14 — reverses Plan A; see the plan doc):
    its OWN override (FeaturePresetRef) → its taskKind's preset (TaskKindPreset)
      → the global default preset.

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
    """A reusable per-task ask-config: model + request params + sampler tail.
    The Lab builds these; features point at them. No launch switches (§7.1)."""

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
    samplers: list[PresetFlagRow] = []  # long-tail Plane-2 samplers
    builtIn: bool = False
    position: int = 0
    # READ-ONLY, filled at list time (D4-1 leg 3, 2026-07-06): the model this preset's
    # FACTORY seed points at (the app's registered library, by id; "" for user-created
    # presets). Clients use it to tell "differs from factory" honestly — writes ignore it.
    factoryModel: str = ""


class TaskKindAssignment(BaseModel):
    taskKind: str
    presetId: str = ""   # "" → clear (this taskKind falls back to the default)


class FeatureAssignment(BaseModel):
    featureKey: str      # the ACTION id
    presetId: str = ""   # "" → clear the override (the feature re-inherits its taskKind)


class FeatureClearRequest(BaseModel):
    """Bulk-clear the per-feature overrides for a set of features so each
    re-inherits its taskKind's preset (used by the per-task/feature Reset)."""

    featureKeys: list[str] = []


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


class FeaturePresetRefStore(Protocol):
    def list(self) -> dict[str, str]: ...                         # feature_key(action) → preset_id
    def set(self, feature_key: str, preset_id: str) -> None: ...  # "" clears the row


class PresetsResponse(BaseModel):
    presets: list[EnginePresetRow]


class AssignmentsResponse(BaseModel):
    defaultPresetId: str = ""
    taskKinds: dict[str, str] = {}    # task_kind → preset_id
    features: dict[str, str] = {}     # action → preset_id (the per-feature override, restored 2026-07-14)


def make_presets_router(
    get_presets: Callable[[], EnginePresetStore],
    get_task_kinds: Callable[[], TaskKindPresetStore],
    get_default: Callable[[], str],
    set_default: Callable[[str], None],
    get_refs: Callable[[], FeaturePresetRefStore],
) -> APIRouter:
    """CRUD for engine presets + the three assignment layers (default · task-kind ·
    per-feature override). Mutating calls return the full list/assignments so the UI
    re-renders from one response. (The per-feature override layer was restored
    2026-07-14 — reverses Plan A; it is the top tier of the run-path cascade.)"""
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
            taskKinds=get_task_kinds().list(),
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
        its taskKind's preset (the per-task/feature Reset path)."""
        refs = get_refs()
        for key in body.featureKeys:
            if key.strip():
                refs.set(key, "")
        return _assignments()

    return router
