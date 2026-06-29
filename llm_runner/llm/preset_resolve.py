# SPDX-License-Identifier: GPL-3.0-or-later
"""Resolve a feature's ENGINE PRESET via the cascade (2026-06-29 lab + preset model):

    feature override (FeaturePresetRef) → its CATEGORY's preset (CategoryPreset)
    → the global default (CategoryPreset[""]).

Pure reads over the shared stores. Returns the `EnginePresetRow` or `None`. `None`
means "no preset configured for this feature" → the caller falls back to the legacy
routing (pins/job/default), so the app keeps working through the migration.

The feature → category map is host data (the feature catalog), so the caller passes
the feature's `category`; this module owns only the preset cascade.
"""

from __future__ import annotations

from .presets_api import EnginePresetRow


def resolve_feature_preset(feature_key: str, category: str = "") -> EnginePresetRow | None:
    """The engine preset a feature runs, or None. Lazy-imports `stores` (it imports
    this module's siblings) to avoid an import cycle."""
    from . import stores

    refs = stores.get_feature_preset_ref_store().list()          # feature_key → preset_id
    cats = stores.get_category_preset_store().list()             # category → preset_id ("" = default)
    preset_id = refs.get(feature_key) or (cats.get(category, "") if category else "") or cats.get("", "")
    if not preset_id:
        return None
    for p in stores.get_engine_preset_store().list():
        if p.id == preset_id:
            return p
    return None  # a dangling id (the preset was deleted) → fall back to legacy routing
