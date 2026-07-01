# SPDX-License-Identifier: GPL-3.0-or-later
"""The canonical taskKind taxonomy + the read endpoint the UI needs for routing.

`TASK_KINDS` is the fixed set of nine LLM-work shapes routing keys on (the
2026-07-01 taskKind model). It is app-agnostic — both apps share the same nine —
so it lives here, not in per-app seed data. An app's per-action MAP (which action
is which taskKind) is host data (`configure_app_seed(feature_task_kinds=…)`),
resolved through `_task_kind_of` at dispatch.

`GET /v1/ai/task-kinds` serves the catalog (the nine, id + label + description)
PLUS the resolved action→taskKind map, so the Feature Workbench can render each
card's `own-override → taskKind preset → global default` provenance and the
assignment surface can list the nine rows.
"""

from __future__ import annotations

from typing import Callable

from fastapi import APIRouter
from pydantic import BaseModel

# The nine canonical LLM-work shapes. `id` is the routing key (matches the
# TaskKindPreset PK + the recommendation task_kind + FEATURE_TASK_KINDS values);
# label/description are UI copy. Ordered prose → structured → chat.
TASK_KINDS: list[dict] = [
    {"id": "prose.generate", "label": "Generate prose",
     "description": "Write new voiced narrative prose."},
    {"id": "prose.edit", "label": "Edit prose",
     "description": "Faithful line-level revision of existing prose."},
    {"id": "ideation", "label": "Ideation",
     "description": "Open-ended brainstorming of names, titles, and plot moves."},
    {"id": "creative.structured", "label": "Structured creative",
     "description": "Creative output emitted as structured JSON."},
    {"id": "summary.grounded", "label": "Grounded summary",
     "description": "A faithful digest grounded in the source text."},
    {"id": "extract.structured", "label": "Structured extraction",
     "description": "Extract facts / entities as structured JSON."},
    {"id": "judge.scored", "label": "Judgment & scoring",
     "description": "Careful analysis and scored critique, emitted as JSON."},
    {"id": "chat.grounded", "label": "Grounded chat",
     "description": "Q&A grounded in retrieved excerpts (RAG)."},
    {"id": "chat.inVoice", "label": "In-character chat",
     "description": "First-person, in-voice answers from a character."},
]


class TaskKindRow(BaseModel):
    id: str
    label: str
    description: str = ""


class TaskKindsResponse(BaseModel):
    taskKinds: list[TaskKindRow]
    # action key → its resolved taskKind (only actions that resolve to one). The UI
    # reads this for per-card provenance; absent action → "" (no taskKind tier).
    featureTaskKinds: dict[str, str] = {}


def make_task_kinds_router(
    get_prompt_store: Callable[[], object],
    task_kind_of: Callable[[str], str] | None = None,
) -> APIRouter:
    """GET /v1/ai/task-kinds — the canonical nine + the resolved action→taskKind map
    (from the host's prompt store keys through `task_kind_of`). `task_kind_of` None
    (no map wired) → an empty map, so the UI degrades to own→default provenance."""
    router = APIRouter(tags=["ai"], prefix="/v1/ai")

    @router.get("/task-kinds", response_model=TaskKindsResponse)
    async def list_task_kinds() -> TaskKindsResponse:
        rows = [TaskKindRow(**t) for t in TASK_KINDS]
        mapping: dict[str, str] = {}
        if task_kind_of is not None:
            for spec in get_prompt_store().list():
                action = getattr(spec, "key", "")
                if not action:
                    continue
                tk = task_kind_of(action)
                if tk:
                    mapping[action] = tk
        return TaskKindsResponse(taskKinds=rows, featureTaskKinds=mapping)

    return router
