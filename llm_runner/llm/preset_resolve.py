# SPDX-License-Identifier: GPL-3.0-or-later
"""Resolve a TASK's ENGINE PRESET via the cascade (2026-07-02 "task owns the preset"):

    the task's preset (TaskKindPreset[task_kind]) → the global default (TaskKindPreset[""]).

Pure reads over the shared stores. Returns the `EnginePresetRow` or `None`. `None`
means "no preset configured for this task" → the caller falls back to the legacy
routing (pins/default), so the app keeps working through the migration.

The action → taskKind map is host data (the feature-taskKind map), so the caller
passes the resolved `task_kind`; this module owns only the preset cascade. (The
per-feature FeaturePresetRef override tier was removed 2026-07-02 — Plan A: a
feature's preset IS its task's preset.)
"""

from __future__ import annotations

from .presets_api import EnginePresetRow


def resolve_task_preset(task_kind: str = "") -> EnginePresetRow | None:
    """The engine preset a task runs, or None. Lazy-imports `stores` (it
    imports this module's siblings) to avoid an import cycle."""
    from . import stores

    tks = stores.get_task_kind_preset_store().list()             # task_kind → preset_id ("" = default)
    preset_id = (tks.get(task_kind, "") if task_kind else "") or tks.get("", "")
    if not preset_id:
        return None
    for p in stores.get_engine_preset_store().list():
        if p.id == preset_id:
            return p
    return None  # a dangling id (the preset was deleted) → fall back to legacy routing
