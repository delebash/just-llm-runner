# SPDX-License-Identifier: MIT
"""Resolve the ENGINE PRESET an action runs — the ONE-SOURCE model (2026-07-15:
the task tier is gone; the preset is the truth). Resolution is now just

    this action's own ref (FeaturePresetRef[action]) → the global default
    (`default_preset_id` RunnerSetting).

Pure reads over the shared stores. Returns the `EnginePresetRow` or `None`.
`None` means "no preset configured" → the caller dispatches on the provider-default
route with NO tunables sent (the no-preset rule; only reachable for a custom action
before assignment — every seeded action ships a ref).

A tier whose stored preset_id is DANGLING (the preset was deleted while a ref row
survived — reachable on the runner's own FK-off path) falls through to the next
tier, so a stale ref never strands an action.
"""

from __future__ import annotations

from .presets_api import EnginePresetRow


def _preset_by_id(preset_id: str) -> EnginePresetRow | None:
    """Look up an engine preset by id, or None (empty id, or a dangling id whose
    preset was deleted). Lazy-imports `stores` (it imports this module's siblings)
    to avoid an import cycle."""
    if not preset_id:
        return None
    from . import stores

    for p in stores.get_engine_preset_store().list():
        if p.id == preset_id:
            return p
    return None


def _resolve_with_source(candidates: list[tuple[str, str]]) -> tuple[EnginePresetRow | None, str]:
    """First (preset_id, source) whose preset EXISTS → (preset, source). A missing
    or dangling id falls through to the next candidate. None matched → (None, "")."""
    for preset_id, source in candidates:
        preset = _preset_by_id(preset_id)
        if preset is not None:
            return preset, source
    return None, ""


def resolve_feature_preset_with_source(
    feature_key: str, feature: str | None = None,
) -> tuple[EnginePresetRow | None, str]:
    """The preset an ACTION runs AND which tier won ("assigned" | "default" | "").
    One implementation of the cascade, shared by the run path and the resolved-route
    provenance endpoint.

    The cascade (the FEATURE layer joined 2026-08-06 — the pieces rework): the
    action's own ref → the action's FEATURE ref (when the caller names one — a
    pieces parent routes ALL its rows through one assignment) → the global
    default. Backward-identical wherever no feature-level ref exists."""
    from . import stores

    refs = stores.get_feature_preset_ref_store().list()   # key -> preset_id (the assignment)
    layers = [(refs.get(feature_key, ""), "assigned")]
    if feature and feature != feature_key:
        layers.append((refs.get(feature, ""), "assigned"))
    layers.append((stores.get_default_preset_id(), "default"))
    return _resolve_with_source(layers)


def resolve_feature_preset(feature_key: str, feature: str | None = None) -> EnginePresetRow | None:
    """The engine preset an ACTION runs — its ref → its feature's ref (when given)
    → the global default. `feature_key` is the ACTION id, so writerAI.continue and
    writerAI.tighten point independently."""
    return resolve_feature_preset_with_source(feature_key, feature)[0]
