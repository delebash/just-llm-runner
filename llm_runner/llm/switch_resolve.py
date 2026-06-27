# SPDX-License-Identifier: GPL-3.0-or-later
"""Resolve a model's effective spawn-flag switches by LAYERING the data-driven
switch tables (design §6). A pure read over the shared session; returns a
`{flag_name: flag_value}` dict the runner turns into `process.Overrides` (via
`lifecycle._switches_to_overrides`) at load — so it flows through the EXISTING,
already-tested Override path and never touches the spawn/`compose_flags` logic.

Layer order (later wins), per §6.5:
    base preset  →  the model's TYPE preset (moe | dense)  →  the mtp preset
    (applied ONLY if `mtp` AND `type != "moe"`, so a MoE+MTP model like the
    35B-A3B-MTP keeps the moe preset's `spec_type=none` instead of draft-mtp)  →
    per-model override (`model_switches`, the rare exception)  →  per-hardware
    (`hardware_switches`, the persistent per-machine tune).

The per-JOB and per-FEATURE override layers are deliberately NOT applied here:
they are passed to `POST /v1/llm-runner/load` as explicit `overrides` by the
(GPU-gated) step-4 residency orchestrator, which knows the active job. This
function is the model-level base every job builds on.
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
        is_mtp = bool(getattr(model, "mtp", False)) if model else False

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
        if is_mtp and mtype != "moe":      # mtp preset; the moe preset's spec:none wins (§6.5)
            _apply("mtp")
        # per-model override (the rare instance-specific exception)
        for r in s.query(db.ModelSwitch).filter(db.ModelSwitch.model_id == model_id).all():
            merged[r.flag_name] = r.flag_value
        # per-hardware (the persistent per-machine tune)
        if hw_key:
            for r in s.query(db.HardwareSwitch).filter(db.HardwareSwitch.hw_key == hw_key).all():
                merged[r.flag_name] = r.flag_value
        return merged
    finally:
        s.close()


def resolve_profile_switches(
    job_id: str, hw_key: str = "", config_id: str = "active"
) -> dict[str, str]:
    """The LOAD-time switch dict for a **Profile** (a routing job + its engine).

    A Profile's switches are **frozen** on its job-route (`job_route_switches`),
    pre-filled from the model's type-default when the model is set (design D8) —
    so this does NOT re-layer the base/type/mtp presets at load (that's the
    *pre-fill* resolver's job, `resolve_model_switches`). It returns the Profile's
    own stored switches, then layers this machine's per-hardware tune on top
    (`hardware_switches` — the persistent per-GPU override wins). Empty `{}` when
    the Profile has nothing set, so the load path can fall back to the model-level
    pre-fill resolver during the migration."""
    s = db.session()
    try:
        merged: dict[str, str] = {}
        for r in (
            s.query(db.JobRouteSwitch)
            .filter(db.JobRouteSwitch.config_id == config_id, db.JobRouteSwitch.job_id == job_id)
            .all()
        ):
            merged[r.flag_name] = r.flag_value
        # per-hardware tune layers on top (this machine's saved fast values win)
        if hw_key:
            for r in s.query(db.HardwareSwitch).filter(db.HardwareSwitch.hw_key == hw_key).all():
                merged[r.flag_name] = r.flag_value
        return merged
    finally:
        s.close()


def prefill_job_switches(config_id: str, job_id: str, model: str):
    """Pre-fill a Profile's switches from its model's type-default (base→type→mtp)
    when `model` is a known local (bundled-runner) catalog model; a cloud/unknown
    model gets NO launch switches (llama.cpp flags don't apply to it). Replaces the
    (config, job)'s stored switches and returns the resulting rows. Called when a
    Profile's model is set so "pick a model → get the right moe/dense switches"
    works with no hand-tuning (design S3 / D17). Lazy imports avoid an import cycle."""
    from . import stores
    from .job_switches_api import JobSwitchRow

    catalog_ids = {r.id for r in stores.get_model_catalog_store().list()}
    merged = resolve_model_switches(model) if (model and model in catalog_ids) else {}
    rows = [JobSwitchRow(flagName=k, flagValue=v) for k, v in merged.items()]
    return stores.get_job_route_switch_store().replace(config_id, job_id, rows)
