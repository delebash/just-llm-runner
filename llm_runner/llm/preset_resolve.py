# SPDX-License-Identifier: GPL-3.0-or-later
"""Resolve a feature's ENGINE PRESET via the cascade (2026-06-29 lab + preset model):

    feature/action override (FeaturePresetRef) → its taskKind's preset (TaskKindPreset)
    → the global default (TaskKindPreset[""]).

Pure reads over the shared stores. Returns the `EnginePresetRow` or `None`. `None`
means "no preset configured for this feature" → the caller falls back to the legacy
routing (pins/default), so the app keeps working through the migration.

The action → taskKind map is host data (the feature-taskKind map), so the caller
passes the resolved `task_kind`; this module owns only the preset cascade.
"""

from __future__ import annotations

from .presets_api import EnginePresetRow


def resolve_feature_preset(feature_key: str, task_kind: str = "") -> EnginePresetRow | None:
    """The engine preset a feature/action runs, or None. Lazy-imports `stores` (it
    imports this module's siblings) to avoid an import cycle."""
    from . import stores

    refs = stores.get_feature_preset_ref_store().list()          # feature_key(action) → preset_id
    tks = stores.get_task_kind_preset_store().list()             # task_kind → preset_id ("" = default)
    preset_id = refs.get(feature_key) or (tks.get(task_kind, "") if task_kind else "") or tks.get("", "")
    if not preset_id:
        return None
    for p in stores.get_engine_preset_store().list():
        if p.id == preset_id:
            return p
    return None  # a dangling id (the preset was deleted) → fall back to legacy routing
