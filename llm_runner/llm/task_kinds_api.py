# SPDX-License-Identifier: GPL-3.0-or-later
"""Task-kind CRUD + the resolved action→taskKind map — the user-editable "tasks" model.

A TASK (taskKind) is the LLM-work bucket a feature is assigned to; it carries a name +
description and (via `TaskKindPreset`) an engine preset. The nine defaults are SEEDED
(shared `seed.DEFAULT_TASK_KINDS`), but the set is now user-editable: create / rename /
delete CUSTOM tasks (built-ins are protected). The feature→task MAP is likewise
DB-backed (`feature_task_kinds`) + reassignable.

`GET /v1/ai/task-kinds` serves the catalog (from the DB store) PLUS the resolved
action→taskKind map — built by running the wired `task_kind_of` over the prompt-store
keys (NOT a raw table dump), so actions that resolve via the `writerAI.rule.*` prefix
keep their provenance. Mutating calls return the full response so the UI re-renders once.
"""

from __future__ import annotations

from typing import Callable

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel


class TaskKindRow(BaseModel):
    id: str = ""            # "" on create → the store derives a slug from the label
    label: str = ""
    description: str = ""
    position: int = 0
    builtIn: bool = False   # seeded defaults; the store blocks deleting these


class TaskKindsResponse(BaseModel):
    taskKinds: list[TaskKindRow] = []
    # action key → its resolved taskKind (only actions that resolve to one). The UI
    # reads this for per-card provenance + the per-task member list; absent → no tier.
    featureTaskKinds: dict[str, str] = {}


class FeatureTaskAssignment(BaseModel):
    featureKey: str
    taskKind: str = ""   # "" → clear the override (feature re-floats to its factory task)


def make_task_kinds_router(
    get_task_kinds: Callable[[], object],
    get_feature_task_kinds: Callable[[], object],
    get_prompt_store: Callable[[], object],
    task_kind_of: Callable[[str], str] | None = None,
    reset_fn: Callable[[], None] | None = None,
    reset_task_fn: Callable[[str], None] | None = None,
) -> APIRouter:
    """CRUD for tasks + the feature→task assignment + the read the UI needs. Mutating
    calls return the full state (mirror presets_api). `task_kind_of` None → an empty map;
    `reset_fn` → restore all routing assignments to factory (the global reset);
    `reset_task_fn` → reset ONE built-in task to factory (the per-task Reset)."""
    router = APIRouter(tags=["ai"], prefix="/v1/ai")

    def _feature_map() -> dict[str, str]:
        mapping: dict[str, str] = {}
        if task_kind_of is not None:
            for spec in get_prompt_store().list():
                action = getattr(spec, "key", "")
                if not action:
                    continue
                tk = task_kind_of(action)
                if tk:
                    mapping[action] = tk
        return mapping

    def _response() -> TaskKindsResponse:
        return TaskKindsResponse(
            taskKinds=get_task_kinds().list(), featureTaskKinds=_feature_map(),
        )

    @router.get("/task-kinds", response_model=TaskKindsResponse)
    async def list_task_kinds() -> TaskKindsResponse:
        return _response()

    @router.post("/task-kinds", response_model=TaskKindsResponse)
    async def create_task_kind(body: TaskKindRow) -> TaskKindsResponse:
        if not body.label.strip():
            raise HTTPException(status_code=400, detail="label is required")
        body.id = ""          # force a fresh slug-derived id (never overwrite by id)
        body.builtIn = False  # users create custom tasks only
        get_task_kinds().upsert(body)
        return _response()

    # NOTE: this literal-path PUT must be declared BEFORE the `/{task_id}` PUT below,
    # or "feature" would match as a task_id.
    @router.put("/task-kinds/feature", response_model=TaskKindsResponse)
    async def assign_feature(body: FeatureTaskAssignment) -> TaskKindsResponse:
        if not body.featureKey.strip():
            raise HTTPException(status_code=400, detail="featureKey is required")
        get_feature_task_kinds().set(body.featureKey, body.taskKind)
        return _response()

    @router.put("/task-kinds/{task_id}", response_model=TaskKindsResponse)
    async def update_task_kind(task_id: str, body: TaskKindRow) -> TaskKindsResponse:
        if not any(t.id == task_id for t in get_task_kinds().list()):
            raise HTTPException(status_code=404, detail=f"task {task_id!r} not found")
        body.id = task_id
        get_task_kinds().upsert(body)
        return _response()

    @router.delete("/task-kinds/{task_id}", response_model=TaskKindsResponse)
    async def delete_task_kind(task_id: str) -> TaskKindsResponse:
        try:
            get_task_kinds().delete(task_id)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        return _response()

    @router.post("/task-kinds/reset", response_model=TaskKindsResponse)
    async def reset_task_kinds() -> TaskKindsResponse:
        """Restore all routing assignments to factory (custom tasks + presets kept)."""
        if reset_fn is not None:
            reset_fn()
        return _response()

    @router.post("/task-kinds/{task_id}/reset", response_model=TaskKindsResponse)
    async def reset_one_task(task_id: str) -> TaskKindsResponse:
        """Reset ONE built-in task to factory (label/description/preset). 400 on a
        custom task (nothing to reset to)."""
        if reset_task_fn is not None:
            try:
                reset_task_fn(task_id)
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e))
        return _response()

    return router
