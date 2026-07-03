# SPDX-License-Identifier: GPL-3.0-or-later
"""Resolve a model's effective spawn-flag switches by LAYERING the data-driven
switch tables (design §6). A pure read over the shared session; returns a
`{flag_name: flag_value}` dict the runner turns into `process.Overrides` (via
`lifecycle._switches_to_overrides`) at load — so it flows through the EXISTING,
already-tested Override path and never touches the spawn/`compose_flags` logic.

Layer order (later wins):
    base preset  →  the model's TYPE preset (moe | dense)  →  per-hardware
    (`hardware_switches`, the persistent per-machine tune).

There is NO auto-`mtp` layer (removed 2026-07-03, GGUF-grounded model layer Phase 3):
MTP is machine-dependent (offload can win; full-GPU / Metal can lose — measure, don't
dogmatize), so speculative decode is NEVER auto-enabled. `spec_type` defaults to `none`
(its `knob_catalog` default) and is an opt-in the user sets per-Task in the Lab (or
per-machine via a `hardware_switch`) after measuring — no model is blocked from it, and
none gets it by default. Removing the auto-layer also deleted the old `mtp != "moe"`
skip that wrongly disabled MTP for MoE models.

There is no per-job/per-feature switch layer — engine config is owned by the
taskKind → preset cascade (`engine_presets`), overlaid at dispatch.
"""

from __future__ import annotations

from . import db


def _preset_switches(s, preset_id: str) -> dict[str, str]:
    return {
        r.flag_name: r.flag_value
        for r in s.query(db.PresetSwitch).filter(db.PresetSwitch.preset_id == preset_id).all()
    }


def resolve_model_switches(model_id: str, hw_key: str = "") -> dict[str, str]:
    """The merged model-level switch dict for `model_id` (and optionally the
    detected GPU `hw_key`). Empty when nothing is configured."""
    s = db.session()
    try:
        model = s.get(db.ModelCatalog, model_id)
        mtype = (getattr(model, "type", "") or "dense") if model else "dense"

        presets = s.query(db.SwitchPreset).order_by(db.SwitchPreset.position, db.SwitchPreset.id).all()
        by_applies: dict[str, list] = {}
        for p in presets:
            by_applies.setdefault(p.applies_to, []).append(p)

        merged: dict[str, str] = {}

        def _apply(applies_to: str) -> None:
            for p in by_applies.get(applies_to, []):
                merged.update(_preset_switches(s, p.id))

        _apply("all")                      # base — every model
        _apply(mtype)                      # the model's type preset (moe | dense)
        # NO auto-mtp layer — MTP is opt-in + measurable (Phase 3): spec_type stays its
        # knob default (none) unless set per-Task in the Lab or per-machine just below.
        # per-hardware (the persistent per-machine tune)
        if hw_key:
            for r in s.query(db.HardwareSwitch).filter(db.HardwareSwitch.hw_key == hw_key).all():
                merged[r.flag_name] = r.flag_value
        return merged
    finally:
        s.close()
