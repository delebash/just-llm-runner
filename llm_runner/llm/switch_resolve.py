# SPDX-License-Identifier: GPL-3.0-or-later
"""Resolve a model's effective spawn-flag switches by LAYERING the data-driven
switch tables (design §6 + Plan B 2026-07-05). A pure read over the shared
session; returns a `{flag_name: flag_value}` dict the runner turns into
`process.Overrides` (via `lifecycle._switches_to_overrides`) at load — so it
flows through the EXISTING, already-tested Override path and never touches the
spawn/`compose_flags` logic.

Layer order (later wins):
    base preset  →  the model's TYPE preset (moe | dense)  →  the gated auto-MTP
    preset (`mtp`)  →  per-hardware (`hardware_switches`, per-machine, ALL
    models)  →  the per-(model, machine) MEASURED tune (`model_tunes`, Plan B —
    Quick tune's Save; always wins).

AUTO-MTP (user decision 2026-07-05, Plan B D3 — REVERSES Phase 3's "never
auto-enabled"): the `mtp` preset applies when the model can actually RUN it —
built-in MTP (the header-derived `mtp` flag, Qwen-style `nextn_predict_layers`)
OR a configured external draft file (`mtp_draft_file`, Gemma-style; the runner
acquires it and emits `--model-draft`). Everything auto-enabled stays
user-visible + changeable: unchecking MTP in Quick tune saves `spec_type=none`
into the model-tune layer, which WINS. A hand-checked `mtp` on a model that is
neither capable nor draft-configured fails at load with llama-server's own
error — the same user error as hand-setting the knob, documented not special-
cased.

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
    detected machine `hw_key`). Empty when nothing is configured."""
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
        # gated auto-MTP (Plan B D3): built-in capable OR external draft configured.
        # `model.mtp OR mtp_draft_file` — NOT `mtp AND …`: a Gemma-style model's
        # MAIN header has no MTP marker, so the draft arm must fire independently.
        mtp_capable = bool(model is not None and (
            getattr(model, "mtp", False) or getattr(model, "mtp_draft_file", "")
        ))
        if mtp_capable:
            _apply("mtp")
        # per-hardware (per-machine, applies to ALL models on this machine)
        if hw_key:
            for r in s.query(db.HardwareSwitch).filter(db.HardwareSwitch.hw_key == hw_key).all():
                merged[r.flag_name] = r.flag_value
            # per-(model, machine) MEASURED tune — LAST so the user's saved tune
            # (incl. an MTP opt-OUT of the auto layer) always wins (Plan B D1/D3).
            rows = s.query(db.ModelTune).filter(
                db.ModelTune.model_id == model_id, db.ModelTune.hw_key == hw_key
            ).all()
            for r in rows:
                merged[r.flag_name] = r.flag_value
        return merged
    finally:
        s.close()
