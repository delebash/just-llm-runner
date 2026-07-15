# SPDX-License-Identifier: GPL-3.0-or-later
"""Resolve a model's effective spawn-flag switches by LAYERING the data-driven
switch tables (design §6 + Plan B 2026-07-05). A pure read over the shared
session; returns a `{flag_name: flag_value}` dict the runner turns into
`process.Overrides` (via `lifecycle._switches_to_overrides`) at load — so it
flows through the EXISTING, already-tested Override path and never touches the
spawn/`compose_flags` logic.

Layer order (later wins):
    base preset  →  the model's TYPE preset (moe | dense)  →  the gated auto-MTP
    preset (`mtp`)  →  the seeded/editable per-(model, hardware-CLASS) tune
    (`class_tunes`, 2026-07-07 — a config portable across boxes of the same class)
    →  the per-(model, machine) MEASURED tune (`model_tunes`, Plan B — Quick
    tune's Save; always wins over the class default).

(The old per-machine `hardware_switches` layer was RETIRED 2026-07-07 — the
user's switch-provenance review: it had no writer, no seeder, and no UI, so it
existed only as mental-model weight; `class_tunes` (portable) + `model_tunes`
(this machine) cover its use cases. The DB table is simply no longer read; the
per-MACHINE `hw_key` itself lives on under `model_tunes`.)

PROVENANCE (2026-07-07, the user's "what do we compute and auto set" question):
`resolve_model_switches_with_origins` also returns WHICH layer last wrote each
key — the UI's per-row provenance tags ride it. Origin ids are stable strings:
`base` · `type` · `mtp` · `class` · `tune`.

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
action → preset refs (`engine_presets` own every tunable, 2026-07-15).
"""

from __future__ import annotations

from . import db


def _preset_switches(s, preset_id: str) -> dict[str, str]:
    return {
        r.flag_name: r.flag_value
        for r in s.query(db.PresetSwitch).filter(db.PresetSwitch.preset_id == preset_id).all()
    }


def resolve_model_switches_with_origins(
    model_id: str, hw_key: str = "", class_key: str = ""
) -> tuple[dict[str, str], dict[str, str]]:
    """The merged model-level switch dict for `model_id` PLUS the provenance map
    (flag_name -> the layer that last wrote it: base|type|mtp|class|tune). Empty
    when nothing is configured."""
    s = db.session()
    try:
        model = s.get(db.ModelCatalog, model_id)
        mtype = (getattr(model, "type", "") or "dense") if model else "dense"

        presets = s.query(db.SwitchPreset).order_by(db.SwitchPreset.position, db.SwitchPreset.id).all()
        by_applies: dict[str, list] = {}
        for p in presets:
            by_applies.setdefault(p.applies_to, []).append(p)

        merged: dict[str, str] = {}
        origins: dict[str, str] = {}

        def _apply(applies_to: str, origin: str) -> None:
            for p in by_applies.get(applies_to, []):
                for k, v in _preset_switches(s, p.id).items():
                    merged[k] = v
                    origins[k] = origin

        _apply("all", "base")              # base — every model
        _apply(mtype, "type")              # the model's type preset (moe | dense)
        # gated auto-MTP: apply the mtp preset when MTP is ENABLED (2026-07-13 split).
        # `model.mtp` is now the single user-facing enable flag — checking the box (or
        # the seed default) turns it on, UNCHECKING turns it off even if a draft file is
        # still configured (the old `mtp OR mtp_draft_file` gate re-enabled it and made
        # uncheck a no-op). Availability (built-in `mtp_builtin` OR a draft) is a
        # separate fact surfaced as `mtpCapable`; enablement is this flag.
        if bool(model is not None and getattr(model, "mtp", False)):
            _apply("mtp", "mtp")
        # seeded/editable per-(model, HARDWARE-CLASS) tune (2026-07-07): a config
        # measured on one box, portable to every box of the same class. Applies BELOW
        # the machine's own tune (more specific wins) and ABOVE base/type/mtp.
        if class_key:
            for r in s.query(db.ClassTune).filter(
                db.ClassTune.model_id == model_id, db.ClassTune.class_key == class_key
            ).all():
                merged[r.flag_name] = r.flag_value
                origins[r.flag_name] = "class"
        if hw_key:
            # per-(model, machine) MEASURED tune — LAST so the user's saved tune
            # (incl. an MTP opt-OUT of the auto layer) always wins (Plan B D1/D3).
            rows = s.query(db.ModelTune).filter(
                db.ModelTune.model_id == model_id, db.ModelTune.hw_key == hw_key
            ).all()
            for r in rows:
                merged[r.flag_name] = r.flag_value
                origins[r.flag_name] = "tune"
        return merged, origins
    finally:
        s.close()


def resolve_model_switches(model_id: str, hw_key: str = "", class_key: str = "") -> dict[str, str]:
    """The merged model-level switch dict for `model_id` (and optionally the detected
    machine `hw_key` + hardware `class_key`). Empty when nothing is configured.
    (The values-only view of `resolve_model_switches_with_origins` — every existing
    caller keeps this shape.)"""
    return resolve_model_switches_with_origins(model_id, hw_key, class_key)[0]
