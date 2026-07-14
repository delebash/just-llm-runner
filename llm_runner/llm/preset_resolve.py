# SPDX-License-Identifier: GPL-3.0-or-later
"""Resolve the ENGINE PRESET a feature/task runs via the 3-tier cascade
(restored 2026-07-14 — reverses Plan A's 2026-07-02 two-tier collapse; the
per-feature override is the user's fine-grain control, see
docs/plans/2026-07-14-feature-override-and-reasoning-plan.md):

    this feature's own override (FeaturePresetRef[feature_key])
      → its taskKind's preset (TaskKindPreset[task_kind])
      → the global default (TaskKindPreset[""]).

Pure reads over the shared stores. Returns the `EnginePresetRow` or `None`.
`None` means "no preset configured" → the caller falls back to the legacy
routing (pins/default), so the app keeps working through the migration.

A tier whose stored preset_id is DANGLING (the preset was deleted while a ref
row survived — reachable on the runner's own FK-off path, where a preset delete
doesn't cascade its override rows) falls through to the next tier, so a stale
override never strands a feature. (This is a deliberate improvement over the
recovered `or`-chain, which short-circuited to None on a dangling top tier; the
3-tier test pins the fall-through.)

The action → taskKind map is host data (the feature-taskKind map), so callers
pass the resolved `task_kind`; this module owns only the preset cascade.
`resolve_feature_preset` is the full 3-tier resolution used by the run path;
`resolve_task_preset` is the task-grain 2-tier resolution used where the grain
is genuinely task-level (the Tasks page + reset paths).
"""

from __future__ import annotations

from .presets_api import EnginePresetRow


def _preset_by_id(preset_id: str) -> EnginePresetRow | None:
    """Look up an engine preset by id, or None (empty id, or a dangling id whose
    preset was deleted). Lazy-imports `stores` (it imports this module's
    siblings) to avoid an import cycle."""
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


def resolve_feature_preset_with_source(feature_key: str, task_kind: str = "") -> tuple[EnginePresetRow | None, str]:
    """The full 3-tier resolution AND which tier won ("feature" | "task" |
    "default" | ""). One implementation of the cascade, shared by the run path
    and the resolved-route provenance endpoint."""
    from . import stores

    refs = stores.get_feature_preset_ref_store().list()          # action → preset_id (the override)
    tks = stores.get_task_kind_preset_store().list()             # task_kind → preset_id ("" = default)
    return _resolve_with_source([
        (refs.get(feature_key, ""), "feature"),
        (tks.get(task_kind, "") if task_kind else "", "task"),
        (tks.get("", ""), "default"),
    ])


def resolve_feature_preset(feature_key: str, task_kind: str = "") -> EnginePresetRow | None:
    """The engine preset a feature/ACTION runs — the full 3-tier cascade.
    `feature_key` is the ACTION id, so writerAI.continue and writerAI.tighten
    override independently."""
    return resolve_feature_preset_with_source(feature_key, task_kind)[0]


def resolve_task_preset(task_kind: str = "") -> EnginePresetRow | None:
    """The engine preset a TASK runs — the 2-tier grain (task preset → global
    default), or None. Used where the caller means the whole task, not one
    feature (the Tasks page + the reset paths). For a run/dispatch resolution
    that honours a per-feature override, use `resolve_feature_preset`."""
    from . import stores

    tks = stores.get_task_kind_preset_store().list()
    return _resolve_with_source([
        (tks.get(task_kind, "") if task_kind else "", "task"),
        (tks.get("", ""), "default"),
    ])[0]
