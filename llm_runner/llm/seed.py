# SPDX-License-Identifier: MIT
"""Shared LLM seed data + seeders + the per-app registration hook.

SHARED seed data (identical for every app, shipped here): default providers, the
downloadable model catalog, the type switch presets, recommendations, and the live
routing row. PER-APP seed data (the only thing that differs between apps) is
registered by the host via `configure_app_seed`: its feature catalog and its
feature prompts. `seed_llm` runs every seeder; stores'
`reset_to_factory` re-run individual seeders. All seeders merge-by-key and never
clobber user edits (the `seed_default_providers` pattern).
"""

from __future__ import annotations

import logging

from . import db
from ..runner.config import (
    DEFAULT_BINARIES,
    DEFAULT_DOWNLOAD_MAX_CONCURRENT,
    DEFAULT_DOWNLOAD_SEGMENT_COUNT,
    DEFAULT_DOWNLOAD_SEGMENT_MIN_BYTES,
    DEFAULT_DOWNLOAD_SEGMENT_RETRIES,
    DEFAULT_DOWNLOAD_SEGMENTS_ENABLED,
    DEFAULT_MODELS_MAX,
    DEFAULT_PINNED_BUILD,
    DEFAULT_SAFETY_MARGIN_MB,
    DEFAULT_SLEEP_IDLE_SECONDS,
)

log = logging.getLogger(__name__)

# ── per-app registration (the ONLY per-app inputs) ────────────────────────────
_APP: dict = {"feature_catalog": [], "feature_prompts": {},
              "engine_presets": [], "feature_presets": {}, "default_preset_id": ""}


def configure_app_seed(*, feature_catalog=None, feature_prompts=None,
                       engine_presets=None, feature_presets=None,
                       default_preset_id=None, model_catalog_extra=None,
                       model_tunes_seed=None, hw_key_fn=None,
                       test_samples=None, feature_prompt_heals=None,
                       class_tunes_seed=None, class_tune_identity=None,
                       embed_templates=None) -> None:
    """The host registers its feature DATA once at boot (install_llm does this):
    `feature_catalog` (list of FeatureCatalogEntry), `feature_prompts` (dict
    key→spec), and the PRESET seed — `engine_presets` (the built-in preset library),
    `feature_presets` (the per-ACTION action→preset_id refs — the one source of what
    an action runs, 2026-07-15), and `default_preset_id` (the catch-all for an
    unassigned action). All optional; an app that registers none seeds no presets →
    the no-preset route."""
    if feature_catalog is not None:
        _APP["feature_catalog"] = list(feature_catalog)
    if feature_prompts is not None:
        _APP["feature_prompts"] = dict(feature_prompts)
    if engine_presets is not None:
        _APP["engine_presets"] = list(engine_presets)
    if feature_presets is not None:
        _APP["feature_presets"] = dict(feature_presets)
    if default_preset_id is not None:
        _APP["default_preset_id"] = str(default_preset_id)
    # Per-app extra catalog rows + the box tune seed are REGISTERED (not one-shot
    # seeded) so `seed_llm` carries them on BOTH paths — boot AND the data-reset
    # endpoint. (Found 2026-07-06: the old install-time-only seeding meant a
    # POST /v1/data/reset silently LOST the app's extra rows + tunes while the
    # presets kept pointing at the vanished ids — the "reset-proof seed data"
    # promise only held for fresh-DB boots.)
    if model_catalog_extra is not None:
        _APP["model_catalog_extra"] = list(model_catalog_extra)
    # (The old `seed_default_model_catalog` opt-out flag is GONE — family parity
    # batch 2026-08-05, decision ④: the shared DEFAULT_CATALOG is empty now, so
    # every app seeds its whole catalog via model_catalog_extra and there is
    # nothing to opt out of.)
    if model_tunes_seed is not None:
        _APP["model_tunes_seed"] = list(model_tunes_seed)
    if hw_key_fn is not None:
        _APP["hw_key_fn"] = hw_key_fn
    # §7.3 Lab test samples (2026-07-08; per-ACTION since 2026-07-15): synthesized rows for the
    # Lab's Sample button — registered so seed_llm carries them on both paths.
    if test_samples is not None:
        _APP["test_samples"] = list(test_samples)
    # Prompt stale-heals (RAG build 2026-07-11, the QC-43a pattern applied to
    # feature prompts): prompt seeding is insert-if-missing, so a seed-text
    # REVISION can never reach an existing DB by itself. The host registers
    # `{key: [old exact system texts]}` — HOST data, like the prompts
    # themselves (the old JW strings never enter this shared module); the
    # generic heal loop in seed_default_feature_prompts refreshes a row from
    # the current spec ONLY when its system text byte-equals a listed old
    # value, so a user-edited prompt is never touched.
    if feature_prompt_heals is not None:
        _APP["feature_prompt_heals"] = {k: list(v) for k, v in dict(feature_prompt_heals).items()}
    # Per-app class-tune seed + identity + embed templates (family parity batch
    # 2026-08-05, decision ④): a class tune is a MEASUREMENT of an app's model on a
    # PC class, and an embed template is a model fact about an app's catalog row —
    # both are the app's data now, registered here so `seed_llm` carries them on
    # BOTH paths (boot AND data-reset), like model_catalog_extra above.
    #   class_tunes_seed: [{"model_id", "class_key", "switches": {flag: value}}]
    #   class_tune_identity: {model_id: {"hf_repo", "quant"}} — what each tuned id
    #     was measured on, so link_class_tunes_to_catalog can bind the tune to a
    #     differently-named row over the same GGUF.
    #   embed_templates: [{"id", "document", "query"}]
    if class_tunes_seed is not None:
        _APP["class_tunes_seed"] = list(class_tunes_seed)
    if class_tune_identity is not None:
        _APP["class_tune_identity"] = {k: dict(v) for k, v in dict(class_tune_identity).items()}
    if embed_templates is not None:
        _APP["embed_templates"] = list(embed_templates)


def app_feature_catalog() -> list:
    """The host's feature catalog (FeatureCatalogEntry list) — get_catalog for the routing router."""
    return _APP["feature_catalog"]


def app_feature_prompts() -> dict:
    return _APP["feature_prompts"]


def app_engine_presets() -> list:
    """The host's built-in engine presets (list of dicts) — the factory preset library."""
    return _APP["engine_presets"]


def app_feature_presets() -> dict:
    """The host's per-ACTION preset refs (action → preset_id) — the one source of what
    an action runs. Seeded into `feature_preset_refs` (merge-by-key, fill-if-missing)."""
    return _APP["feature_presets"]


def app_default_preset_id() -> str:
    """The host's global default preset id — the catch-all for an unassigned action
    (seeded fill-if-empty into the `default_preset_id` RunnerSetting)."""
    return _APP["default_preset_id"]


# ── SHARED seed data ──────────────────────────────────────────────────────────
# NO seeded default_model on any provider (user, 2026-07-06: "no default chat model
# like gpt-4o-mini, we pull model from provider once connected" — providers-surface
# redesign item 5). The rows are connect-ready endpoints only; the user fetches the
# provider's LIVE model list (probe-models / {id}/models) and picks after connecting.
# Dispatch's `adapter.default_model` fallback stays — it now simply stays empty until
# the user's pick writes it.
DEFAULT_PROVIDERS: list[dict] = [
    {"id": "local-llamacpp", "name": "Built-in provider — llama.cpp",
     "provider_type": "local-llamacpp", "base_url": "http://127.0.0.1:8080/v1", "local": True},
    {"id": "openai-compat-local", "name": "Ollama (local)",
     "provider_type": "ollama", "base_url": "http://localhost:11434", "local": True},
    # LM Studio (user, 2026-07-19: "add lm studio as local provider"). It was already
    # REACHABLE — a preset chip (useProviderConnect.js:18) and a detect-local probe
    # (provider_api.py:233) — but never PRESENT: it only appeared once the user went
    # looking for it. Seeding gives it the same out-of-the-box presence Ollama has.
    # Type stays the generic `openai-compat` adapter: LM Studio speaks OpenAI-compatible,
    # so a dedicated type would buy a label and cost ~8 parallel type lists (the
    # 2026-07-17-provider-native-dialects-plan.md:688-693 checklist). Revisit only if
    # LM Studio's NATIVE surface (/api/v0, JIT model loading) is ever wanted.
    {"id": "lmstudio", "name": "LM Studio (local)",
     "provider_type": "openai-compat", "base_url": "http://localhost:1234/v1", "local": True},
    # Unsloth Studio (user, 2026-07-28: "add unsloth provider"). Same treatment as LM
    # Studio above and for the same reasons: it speaks OpenAI-compatible, so the generic
    # `openai-compat` adapter is right and a dedicated type would buy a label while
    # costing ~8 parallel type lists. Base URL is from Unsloth's OWN curl example
    # (https://unsloth.ai/docs/basics/api — `curl http://localhost:8888/v1/models`);
    # their docs also say "typically 8000 or 8888" and never name one authoritative
    # default, so a user serving on 8000 must edit this row. Flagged, not guessed.
    # DELIBERATELY NOT ADDED to detect-local (provider_api.py:230-235): that probe GETs
    # /v1/models with no key, and Unsloth requires `Authorization: Bearer sk-unsloth-…`
    # on EVERY request with no documented way to disable it — so the probe could only
    # ever 401, i.e. it would be dead code that implies a capability we do not have.
    # This does NOT replace the bundled engine: we run raw llama-server because
    # --n-cpu-moe is the deciding switch and the GUI runners do not reliably expose it
    # (docs/plans/2026-06-24-llamacpp-switches.md:488-495). Unsloth Studio is an
    # OPTIONAL provider a user may already run, never the engine layer.
    {"id": "unsloth", "name": "Unsloth Studio (local)",
     "provider_type": "openai-compat", "base_url": "http://localhost:8888/v1", "local": True},
    {"id": "openai", "name": "OpenAI",
     "provider_type": "openai", "base_url": "https://api.openai.com/v1", "local": False},
    {"id": "claude", "name": "Claude (Anthropic)",
     "provider_type": "anthropic", "base_url": "https://api.anthropic.com", "local": False},
    {"id": "gemini", "name": "Gemini (Google)",
     "provider_type": "gemini",
     "base_url": "https://generativelanguage.googleapis.com", "local": False},
    {"id": "deepseek", "name": "DeepSeek",
     "provider_type": "deepseek", "base_url": "https://api.deepseek.com/v1", "local": False},
    {"id": "openrouter", "name": "OpenRouter (aggregator)",
     "provider_type": "openrouter", "base_url": "https://openrouter.ai/api/v1", "local": False},
    {"id": "xai", "name": "xAI (Grok)",
     "provider_type": "xai", "base_url": "https://api.x.ai/v1", "local": False},
    {"id": "mistral", "name": "Mistral",
     "provider_type": "mistral", "base_url": "https://api.mistral.ai/v1", "local": False},
]

# The downloadable model catalog ships EMPTY (family parity batch 2026-08-05,
# decision ④): a curated model ladder is an APP's data — JustWrite's writing-
# ranked rows moved into its own seed (justwrite_server/seed_presets.py), JV/
# docgen feed theirs — and the shared package carries mechanism only. Every app
# seeds its whole catalog via install_llm(model_catalog_extra=…); the Add-a-model
# flow and the catalog CRUD are unchanged. The old per-app opt-out flag
# (seed_default_model_catalog) died with the content.
DEFAULT_CATALOG: list[dict] = []

# ── Embedding task templates ─────────────────────────────────────────────────
# The task instruction an embed model REQUIRES around its input is a fact about a
# CATALOG ROW — and catalog rows are app data now (decision ④ above), so the
# shared seed carries none. An app registers its rows' templates via
# install_llm(embed_templates=[{"id", "document", "query"}]); /v1/ai/embeddings
# applies them, /v1/ai/embed-templates edits them (mechanism unchanged).
DEFAULT_EMBED_TEMPLATES: list[dict] = []


# (Historical: an old per-model `model_switches` table was DROPPED — it seeded
# per-model COPIES of the dense/moe TYPE rules (a one-source violation). The NEW
# `model_tunes` table (Plan B, 2026-07-05) is a DIFFERENT thing: user-MEASURED
# per-(model, machine) tunes, never seeded — no overlap with these presets.)

# Capability/type switch presets — the switch BASE layer (design §6.5 + Plan B),
# the seeded-editable replacement for the hardcoded runner-manifest `flagPresets`,
# translated into `Overrides` field names. `applies_to`: `all` (every model) |
# `moe`/`dense` (matches `model_catalog.type`) | `mtp` (GATED auto-enable — only
# a model with built-in MTP or a configured external draft file; user decision
# 2026-07-05, reversing the Phase-3 never-auto rule: auto-on, visible, and
# uncheckable — an opt-out persists in `model_tunes` and wins).
# Resolved + layered by `switch_resolve.resolve_model_switches`. (`-ngl` is NOT
# here — it's a computed fit knob, not a constant.)
DEFAULT_SWITCH_PRESETS: list[dict] = [
    {"id": "base", "label": "Base (every model)", "applies_to": "all", "position": 0,
     # reasoning_budget RESTORED to this bundle (2026-07-16, house-layering rewrite),
     # REVERSING the 2026-07-06 removal. Safe now because launch emission is retired
     # (process.py U2-T4): this is NOT a launch flag — it is the visible GLOBAL tier of the
     # per-request thinking budget, read via switch_resolve at request time and layered
     # like any switch (base → hardware class → applied model tune, most-specific wins).
     # 1024 = the tested value.
     # context_shift + cache_reuse REMOVED from the base (user, 2026-07-07, on-box tested):
     # Gemma 4's iSWA context supports neither KV shifting nor prefix reuse (llama.cpp
     # auto-disables both with a warning), and context_shift measured as a net loss; the Qwen
     # config omits both too. Neither is a safe UNIVERSAL default. (They were later REMOVED
     # from knob_catalog ENTIRELY — QC-11, user 2026-07-09, pinned by test_knob_catalog.py:79-80:
     # Gemma iSWA supports neither, so they aren't offered as knobs at all; a one-off A/B can
     # still ride the transient LoadRequest field, which the emitter still honors.)
     "switches": {"flash_attn": "on", "cache_type_k": "q8_0", "cache_type_v": "q8_0",
                  "mlock": "true", "reasoning_budget": "1024"}},
    {"id": "moe", "label": "MoE (mixture-of-experts)", "applies_to": "moe", "position": 1,
     # ONLY no_mmap is genuinely MoE-specific; the spec_type default (none) lives ONCE in
     # knob_catalog — no duplicate here (the phase's own "one source" rule, 2026-07-03 Phase 3).
     "switches": {"no_mmap": "true"}},
    {"id": "mtp", "label": "MTP (multi-token prediction)", "applies_to": "mtp", "position": 2,
     # spec_n_max=2 is the USER-MEASURED sweet spot (2026-07-05, gemma-4-26B) and
     # DIFFERS from the knob default (3) — a value equal to the knob default must
     # NOT be seeded here (it would duplicate the one-source knob default).
     "switches": {"spec_type": "draft-mtp", "spec_n_max": "2"}},
]

# (The hidden class→model pick map `DEFAULT_MODEL_CLASS_PICKS` was DELETED 2026-07-22 —
# the §9 final ruled shape: the recommendation IS the visible class-tunes library
# (`DEFAULT_CLASS_TUNES` below + user rows); a model with a config for YOUR class is
# the recommendation, no match → the §10 speed-floor rule. A second, invisible table
# duplicating "which model for this hardware" was the defect, not a feature.)

# The seeded NAMED hardware classes (2026-07-22 redesign) — the sidecar giving each
# class its label + editable VRAM/RAM. ONE seeded class: the author's 8 GB VRAM /
# 32 GB RAM box, under which the Gemma config below lives. name="" → the UI shows the
# plain-words "8 GB VRAM · 32 GB RAM" (the user flagged not owning a seeded name string).
DEFAULT_HARDWARE_CLASSES: list[dict] = [
    {"class_key": "dgpu-vram8|ram32", "mem_type": "discrete",
     "vram_gb": 8, "ram_gb": 32, "name": ""},
    # The 32 GB integrated-GPU class (e.g. the Core Ultra 7 laptop's Arc iGPU). ONE
    # memory pool → vram_gb 0. name="" → the UI shows "Integrated GPU · 32 GB shared RAM".
    {"class_key": "igpu-mem32", "mem_type": "integrated",
     "vram_gb": 0, "ram_gb": 32, "name": ""},
    # The 16 GB integrated-GPU class (the i7-1355U / Iris Xe laptop; added 2026-07-25 —
    # the "integrated-16 class seed" tracker item). The class row only: its decided model
    # is E4B (user, 2026-07-24), but the (E4B, igpu-mem16) class TUNE is deliberately NOT
    # seeded — no measurement exists yet on that box (recovery doc §17: "a future row once
    # benched"; the seed principle: the seed ships facts and rules, the machine supplies
    # measurements). Detection already classifies the box to this key with or without the
    # row (format_class_key); seeding it gives the class a library entry to attach that
    # future tune to.
    {"class_key": "igpu-mem16", "mem_type": "integrated",
     "vram_gb": 0, "ram_gb": 16, "name": ""},
    # The dGPU BAND classes (2026-07-25, Part 2 of the per-band survey — the user's
    # ruling that every band resolves to appropriate models; keys are BANDS since the
    # same-day band ruling, so exact match covers 10/11 GB cards under vram12's floor
    # sibling vram8, a 20 GB card under vram16, and a 4090/5090 alike under vram24).
    # One row per (band × real RAM rung); the rung duplication is the accepted cost of
    # exact-match simplicity ("two identical rows beat a matching engine").
    # vram8|ram16 (the budget build) is deliberately NOT seeded: its pick is a genuine
    # quality-vs-speed call (12B offloaded vs E4B resident) with zero measurements —
    # the user's future word, recorded in the survey doc.
    # vram8|ram16 (the common budget build) joined 2026-07-25 after its MEASURED
    # decision — no longer the "deliberately not seeded" holdout described above.
    {"class_key": "dgpu-vram8|ram16", "mem_type": "discrete", "vram_gb": 8, "ram_gb": 16, "name": ""},
    {"class_key": "dgpu-vram12|ram16", "mem_type": "discrete", "vram_gb": 12, "ram_gb": 16, "name": ""},
    {"class_key": "dgpu-vram12|ram32", "mem_type": "discrete", "vram_gb": 12, "ram_gb": 32, "name": ""},
    {"class_key": "dgpu-vram12|ram64", "mem_type": "discrete", "vram_gb": 12, "ram_gb": 64, "name": ""},
    {"class_key": "dgpu-vram16|ram16", "mem_type": "discrete", "vram_gb": 16, "ram_gb": 16, "name": ""},
    {"class_key": "dgpu-vram16|ram32", "mem_type": "discrete", "vram_gb": 16, "ram_gb": 32, "name": ""},
    {"class_key": "dgpu-vram16|ram64", "mem_type": "discrete", "vram_gb": 16, "ram_gb": 64, "name": ""},
    {"class_key": "dgpu-vram24|ram32", "mem_type": "discrete", "vram_gb": 24, "ram_gb": 32, "name": ""},
    {"class_key": "dgpu-vram24|ram64", "mem_type": "discrete", "vram_gb": 24, "ram_gb": 64, "name": ""},
]


def seed_default_hardware_classes(s) -> int:
    """Seed the built-in hardware-class rows (merge-by-key: a user-edited class is never
    clobbered). Called BEFORE seed_default_class_tunes so a seeded config's class exists."""
    existing = {r.class_key for r in s.query(db.HardwareClass.class_key).all()}
    added = 0
    for row in DEFAULT_HARDWARE_CLASSES:
        if row["class_key"] in existing:
            continue
        s.add(db.HardwareClass(class_key=row["class_key"], mem_type=row["mem_type"],
                               vram_gb=int(row["vram_gb"]), ram_gb=int(row["ram_gb"]),
                               name=row.get("name", ""), built_in=True))
        added += 1
    return added


# The seeded hardware-CLASS tune library ships EMPTY (decision ④): a class tune
# is a MEASUREMENT of an app's model on a PC class — the most expensive knowledge
# here (somebody sat at a box and measured it) and the app's data, like the row it
# tunes. An app registers its measured rows via install_llm(class_tunes_seed=…)
# (JustWrite carries the family's 13 measured rows now); the editable library, the
# per-class recommendation and the §10 fallback are unchanged mechanism.
DEFAULT_CLASS_TUNES: list[dict] = []


# WHAT A TUNE WAS MEASURED ON — {model_id: {hf_repo, quant}} — lets
# link_class_tunes_to_catalog bind a tune to a differently-named catalog row over
# the SAME GGUF (measured 2026-08-03: the i18n app names JustWrite's daily driver
# `gemma-4-26b-a4b-qat-xl`, and without the identity bridge the measured 8 GB/32 GB
# config silently never applied). The MAP is per-app data now (it describes the
# app's tunes) — registered via install_llm(class_tune_identity=…); this shared
# default stays empty.
DEFAULT_CLASS_TUNE_IDENTITY: dict[str, dict] = {}


def _identity_key(hf_repo, quant) -> tuple[str, str]:
    return ((hf_repo or "").strip().lower(), (quant or "").strip().lower())


def link_class_tunes_to_catalog(s) -> int:
    """Make measured tunes reachable from whatever id THIS app's catalog uses.

    Runs LAST in seed_llm — after the default catalog AND the host's extra rows — and
    copies the rows of any tune whose `model_id` has no catalog row onto the catalog row
    with the same identity (hf_repo + quant). Insert-if-missing, so a tune already
    present for that (model, class) is never touched and a host that names the model the
    same way is a no-op. A tune that matches NOTHING is logged: dead weight should say
    so rather than sit there looking like coverage."""
    # FLUSH FIRST: every row this seed pass just added — the default catalog, the host's
    # extras, the tunes themselves — is still pending, and a host session is built with
    # `autoflush=False` (test_install_llm's fixture mirrors the documented shape). Without
    # this the query sees an empty catalog and binds nothing, silently.
    s.flush()
    catalog = {r.id: r for r in s.query(db.ModelCatalog).all()}
    by_identity: dict[tuple[str, str], str] = {}
    for r in catalog.values():
        by_identity.setdefault(_identity_key(r.hf_repo, r.quant), r.id)

    tuned_ids = {mid for (mid,) in s.query(db.ClassTune.model_id).distinct().all()}
    linked = 0
    for mid in sorted(tuned_ids):
        if mid in catalog:
            continue  # the host names it the same way — nothing to do
        identity_map = {**DEFAULT_CLASS_TUNE_IDENTITY, **_APP.get("class_tune_identity", {})}
        identity = identity_map.get(mid)
        target = (by_identity.get(_identity_key(identity.get("hf_repo"), identity.get("quant")))
                  if identity else None)
        if not target:
            log.warning(
                "class tunes for %r match no model in this catalog — they cannot apply. "
                "Add a catalog row for it, or register its hf_repo+quant via "
                "install_llm(class_tune_identity=…) so it can bind by identity.", mid)
            continue
        rows = s.query(db.ClassTune).filter(db.ClassTune.model_id == mid).all()
        copied = 0
        for ckey in sorted({r.class_key for r in rows}):
            if s.query(db.ClassTune).filter(
                db.ClassTune.model_id == target, db.ClassTune.class_key == ckey
            ).first():
                continue
            for r in [x for x in rows if x.class_key == ckey]:
                s.add(db.ClassTune(model_id=target, class_key=ckey,
                                   flag_name=r.flag_name, flag_value=r.flag_value,
                                   built_in=True))
            copied += 1
        if copied:
            log.info("linked %d measured class-tune row(s) %r → %r (same hf_repo + quant)",
                     copied, mid, target)
        linked += copied
    return linked


def seed_default_class_tunes(s) -> int:
    """Seed the built-in class-tune rows — the (empty) shared set plus the APP's
    registered `class_tunes_seed` (decision ④: measured tunes are app data).
    Merge-by-(model, class): a user-edited or Lab-measured row for the same
    (model, class) is never clobbered — only a class with NO rows yet inserts."""
    added = 0
    for row in [*DEFAULT_CLASS_TUNES, *_APP.get("class_tunes_seed", ())]:
        mid, ckey = row["model_id"], row["class_key"]
        if s.query(db.ClassTune).filter(
            db.ClassTune.model_id == mid, db.ClassTune.class_key == ckey
        ).first():
            continue
        for fname, fval in row["switches"].items():
            s.add(db.ClassTune(model_id=mid, class_key=ckey,
                               flag_name=fname, flag_value=str(fval), built_in=True))
        added += 1
    return added


def retire_orphan_builtin_class_tunes(s) -> int:
    """Delete SEEDED (built_in) class-tune rows that can bind to nothing in THIS
    app's catalog — neither by id nor by registered identity. Runs after
    link_class_tunes_to_catalog, so anything bindable has already been linked.

    Why this exists (the runner-TASKS "class tunes match no model" noise item):
    the shared seed used to push all 13 measured rows into EVERY adopter's DB,
    and seeders never prune — after decision ④ moved the tunes into JustWrite's
    seed, JV's and docgen's existing DBs would keep warning about dead rows
    forever. Safe because a user's own config is never built_in: the class-tunes
    PUT always writes built_in=False (class_tunes_api), so only seed residue
    matches."""
    s.flush()
    catalog_ids = {r.id for r in s.query(db.ModelCatalog.id).all()}
    identity = {**DEFAULT_CLASS_TUNE_IDENTITY, **_APP.get("class_tune_identity", {})}
    removed = 0
    tuned_ids = {mid for (mid,) in s.query(db.ClassTune.model_id).distinct().all()}
    for mid in sorted(tuned_ids):
        if mid in catalog_ids or mid in identity:
            continue
        rows = (s.query(db.ClassTune)
                .filter(db.ClassTune.model_id == mid, db.ClassTune.built_in.is_(True)).all())
        for r in rows:
            s.delete(r)
        if rows:
            log.info("retired %d orphaned seeded class-tune row(s) for %r "
                     "(no catalog row, no identity — decision ④ cleanup)", len(rows), mid)
            removed += len(rows)
    return removed


# Runner config (was runner-manifest.json). The binary list + scalars are
# imported from the runner package (ONE source of truth; the standalone runner
# also reads them via runner.config.default_config) and seeded built_in.
DEFAULT_RUNNER_SETTINGS: list[dict] = [
    {"key": "pinned_build", "value": DEFAULT_PINNED_BUILD},
    {"key": "safety_margin_mb", "value": str(DEFAULT_SAFETY_MARGIN_MB)},
    # Router mode (P1e): DB-editable co-resident cap + idle-unload TTL.
    {"key": "models_max", "value": str(DEFAULT_MODELS_MAX)},
    {"key": "sleep_idle_seconds", "value": str(DEFAULT_SLEEP_IDLE_SECONDS)},
    # Segmented downloads (DL-2): additive rows — an existing DB gains them at
    # the next boot (the fill-empty seeder never clobbers user edits).
    {"key": "download_segments_enabled", "value": "1" if DEFAULT_DOWNLOAD_SEGMENTS_ENABLED else "0"},
    {"key": "download_segment_count", "value": str(DEFAULT_DOWNLOAD_SEGMENT_COUNT)},
    # download_segment_min_bytes is RETIRED (the downloader falls back to single-stream itself)
    # but the row is kept — an existing DB keeps its value and the config API round-trips it; inert.
    {"key": "download_segment_min_bytes", "value": str(DEFAULT_DOWNLOAD_SEGMENT_MIN_BYTES)},
    {"key": "download_segment_retries", "value": str(DEFAULT_DOWNLOAD_SEGMENT_RETRIES)},
    # CONCURRENT model downloads (2026-07-20): parallel per-model download cap.
    {"key": "download_max_concurrent", "value": str(DEFAULT_DOWNLOAD_MAX_CONCURRENT)},
    # Warm the default local chat model into VRAM on app startup (2026-07-21, user).
    # Default ON — but the CLIENT only warms when the routing default IS the built-in
    # provider with a downloaded model (so a cloud-default user never triggers a load).
    # Additive row: an existing DB gains it at the next boot (fill-empty seeder).
    {"key": "warm_default_on_startup", "value": "1"},
    # (reasoning_cap_default REMOVED 2026-07-16: the reasoning budget is no longer a
    # min()-clamped cap — it is a normal layered `reasoning_budget` SWITCH row resolved by
    # switch_resolve (base bundle → class tune → model tune). Existing DBs keep an orphan
    # runner_setting row; the resolver no longer reads it.)
]

# Knob catalog — metadata that turns a raw switch/sampler key into a friendly
# KnobGrid input. Plane 1 = load-time engine switch (maps to a process.Overrides
# field); Plane 2 = per-request sampler (maps to the dispatch `extra`). `options`
# (inline) become enum rows in knob_option. C1: data only, no code per param.
# QC-17 + QC-18 (user, 2026-07-09): plane-1 rows carry NO default_value (the app
# stops storing/claiming the engine's own defaults — an unset switch simply isn't
# sent, the engine does its own thing) and NO options (switch values are plain
# text/number boxes; the HELP names the accepted values — accepted-value lists
# verified against llama.cpp tools/server/README.md, fetched 2026-07-09). Plane-2
# sampler rows keep default_value (OUR enable-prefills — samplers untouched).
# `tier` = common|advanced drives the sampler checklist split. Order within each
# plane is common-first (the seeder sets position=i).
DEFAULT_KNOBS: list[dict] = [
    # ── Plane 1 — load switches: COMMON (fit & memory) ──
    {"flag_name": "ctx_len", "kind": "int", "plane": 1, "tier": "common",
     "help": "Maximum tokens the model can read + write at once. Bigger = more memory (the KV cache grows with it). Set it to fit your longest task; unset, the engine reads the model's own limit."},
    {"flag_name": "flash_attn", "kind": "string", "plane": 1, "tier": "common",
     "help": "Faster attention using less memory. Values: on, off, auto."},
    {"flag_name": "cache_type_k", "kind": "string", "plane": 1, "tier": "common",
     "help": "Compress the K side of the KV cache to save VRAM. q8_0 is near-lossless; q4_0 saves more but can cost quality. Accepts f32, f16, bf16, q8_0, q4_0, q4_1, iq4_nl, q5_0, q5_1."},
    {"flag_name": "cache_type_v", "kind": "string", "plane": 1, "tier": "common",
     "help": "Compress the V side of the KV cache to save VRAM. q8_0 is near-lossless. Accepts f32, f16, bf16, q8_0, q4_0, q4_1, iq4_nl, q5_0, q5_1."},
    {"flag_name": "n_cpu_moe", "backends": "cuda,rocm,vulkan,metal", "kind": "int", "plane": 1, "applies_to": "moe", "tier": "common",
     "help": "Expert layers to run on CPU — frees VRAM (MoE only). Auto-fit sets it; pin the fast value here."},
    # ── Plane 1 — load switches: ADVANCED ──
    # n_gpu_layers ADDED 2026-07-07 (user bug report): it was always a valid Overrides
    # field (lifecycle._parse_switch int_fields) but had no catalog row because fit
    # normally derives it — then the class-tune seed started writing n_gpu_layers=99
    # (the MoE pattern: all layers on GPU, offload via n_cpu_moe) and the Tune grid
    # badged the resolved row "unrecognized". The knob row makes it a first-class,
    # labelled switch; the seeder merges by flag_name so existing DBs gain it on boot.
    {"flag_name": "n_gpu_layers", "backends": "cuda,rocm,vulkan,metal", "kind": "int", "plane": 1, "tier": "advanced",
     "help": "How many model layers run on the GPU (the rest run on CPU). Auto-fit sets it when unset; MoE tunes pin every layer on GPU (99) and free VRAM with CPU MoE layers instead."},
    {"flag_name": "mlock", "kind": "bool", "plane": 1, "tier": "advanced",
     "help": "Keep the model locked in RAM so the OS can't swap it out (steadier speed). Turn off if RAM is tight. Values: true or false."},
    {"flag_name": "no_mmap", "backends": "cuda,rocm,vulkan,metal", "kind": "bool", "plane": 1, "applies_to": "moe", "tier": "advanced",
     "help": "Read the whole model into RAM instead of memory-mapping it. Needed for MoE CPU-offload; otherwise leave off. Values: true or false."},
    {"flag_name": "no_kv_offload", "backends": "cuda,rocm,vulkan,metal", "kind": "bool", "plane": 1, "tier": "advanced",
     "help": "Keep the KV cache in system RAM instead of VRAM — frees VRAM but is slower. Values: true or false."},
    {"flag_name": "batch_size", "kind": "int", "plane": 1, "tier": "advanced",
     "help": "How many prompt tokens are processed together (throughput vs memory)."},
    {"flag_name": "ubatch_size", "kind": "int", "plane": 1, "tier": "advanced",
     "help": "Physical batch — the chunk actually run per step. Lower it if prompt processing runs out of memory."},
    {"flag_name": "threads", "kind": "int", "plane": 1, "tier": "advanced",
     "help": "CPU threads for generation (drive MoE CPU experts). Unset, the engine uses your physical cores."},
    {"flag_name": "threads_batch", "kind": "int", "plane": 1, "tier": "advanced",
     "help": "CPU threads for prompt processing. Unset, the engine matches CPU threads."},
    {"flag_name": "parallel", "kind": "int", "plane": 1, "tier": "advanced",
     "help": "Concurrent server slots (used by batch sweeps / Compare)."},
    {"flag_name": "cont_batching", "kind": "bool", "plane": 1, "tier": "advanced",
     "help": "Overlap requests for throughput; only turn it off to debug. Values: true or false."},
    # context_shift + cache_reuse REMOVED from the catalog (QC-11, user 2026-07-09
    # "remove from catalog" — they were also pulled from the shipped bundles
    # 2026-07-07 as a measured net loss). Still typeable as custom switches.
    # spec_type carries OPTIONS (2026-07-24, the user's go after the "nobe" incident: a
    # typo'd value kills the load with the error visible only in the router log — the
    # server refuses unknown spec types). This deliberately AMENDS QC-18 ("switch values
    # are plain text boxes, never a dropdown") for option-carrying knobs only; knobs
    # without options stay free text.
    {"flag_name": "spec_type", "kind": "string", "plane": 1, "tier": "advanced",
     "help": "Draft-model speculative decode; gains are machine-dependent — measure. draft-mtp auto-uses the catalog's MTP sidecar; dflash/eagle3 need model_draft pointing at a matching trained drafter GGUF (engine >= b10094).",
     "options": [
         {"value": "none"}, {"value": "draft-mtp"}, {"value": "draft-dflash"},
         {"value": "draft-eagle3"}, {"value": "ngram-mod"},
     ]},
    {"flag_name": "spec_n_max", "kind": "int", "plane": 1, "tier": "advanced",
     "help": "How many tokens the draft proposes per step. Measured best: 2 for draft-mtp (2026-07-05); the DFlash author's guidance is 6."},
    # model_draft promoted to a first-class knob (2026-07-24, the DFlash test setup):
    # it was always an Overrides field reachable as a raw switch row (the power-user
    # escape, process.py) — surfacing it with help beats making users guess the name.
    {"flag_name": "model_draft", "kind": "string", "plane": 1, "tier": "advanced",
     "help": "Path to an explicit speculative-draft GGUF (--model-draft). Normally auto-filled from the catalog's MTP sidecar; set by hand to test an alternate drafter (e.g. DFlash) together with spec_type=draft-dflash. The draft is charged to the VRAM fit."},
    {"flag_name": "reasoning_budget", "kind": "int", "plane": 1, "per_request": True, "tier": "advanced",
     "help": "Thinking-token budget for this model, layered like any switch (global → hardware class → your applied config) — but NOT a launch flag: it is sent with EVERY request as JSON and applies immediately, no reload. -1 = unlimited (can think until the context fills), 0 = thinking off, N = at most N thinking tokens."},
    # ── Plane 2 — per-request samplers: COMMON ──
    # NB (#15 C4): cloud delivery of any sampler knob here is gated by the per-type
    # allowlists — openai_sdk.TYPE_PARAM_PROFILES · anthropic._map_extra ·
    # gemini._build_config; ollama + local (llama.cpp) pass everything. Adding a new
    # sampler here means deciding, per cloud, whether it survives that allowlist.
    # temperature + top_p stay in the catalog but are edited in the per-call params
    # row (excluded from the checklist by ConfigColumn) — tier is harmless here.
    {"flag_name": "temperature", "kind": "float", "plane": 2, "default_value": "0.7", "tier": "common",
     "help": "Randomness. Low (≈0) for extraction/JSON; higher (0.8–1.0) for prose."},
    {"flag_name": "top_p", "kind": "float", "plane": 2, "default_value": "0.95", "tier": "common",
     "help": "Nucleus sampling — keep the smallest set of tokens summing to this probability. The cloud-API truncation knob."},
    {"flag_name": "top_k", "kind": "int", "plane": 2, "tier": "common",
     "help": "Keep only the k most-likely tokens (0 = off)."},
    {"flag_name": "min_p", "kind": "float", "plane": 2, "tier": "common",
     "help": "Drop tokens below this fraction of the top token's probability. For local models this is the truncation knob to reach for first (try 0.05–0.1)."},
    {"flag_name": "repeat_penalty", "kind": "float", "plane": 2, "tier": "common",
     "help": "Penalize recently-used tokens (>1 reduces repetition)."},
    {"flag_name": "repeat_last_n", "kind": "int", "plane": 2, "default_value": "64", "tier": "common",
     "help": "How many recent tokens Repeat penalty looks back over (llama.cpp default 64; -1 = whole context, 0 = off)."},
    {"flag_name": "seed", "kind": "int", "plane": 2, "tier": "common",
     "help": "Fixed RNG seed for reproducible output (-1 = random)."},
    # ── Plane 2 — per-request samplers: ADVANCED ──
    {"flag_name": "presence_penalty", "kind": "float", "plane": 2, "tier": "advanced",
     "help": "Penalize tokens that already appeared at all (OpenAI-style; 0 = off)."},
    {"flag_name": "frequency_penalty", "kind": "float", "plane": 2, "tier": "advanced",
     "help": "Penalize tokens by how often they've appeared (OpenAI-style; 0 = off)."},
    {"flag_name": "typical_p", "kind": "float", "plane": 2, "tier": "advanced",
     "help": "Locally-typical sampling — keep tokens near the expected information content (1.0 = off)."},
    {"flag_name": "dry_multiplier", "kind": "float", "plane": 2, "tier": "advanced",
     "help": "Don't-Repeat-Yourself: penalize repeated sequences (0 = off). A stronger anti-repetition than Repeat penalty."},
    {"flag_name": "dry_base", "kind": "float", "plane": 2, "default_value": "1.75", "tier": "advanced",
     "help": "How steeply DRY penalizes longer repeats (llama.cpp default 1.75). Used with DRY penalty."},
    {"flag_name": "dry_allowed_length", "kind": "int", "plane": 2, "default_value": "2", "tier": "advanced",
     "help": "Repeats up to this length are free; longer ones get penalized (llama.cpp default 2)."},
    {"flag_name": "dry_penalty_last_n", "kind": "int", "plane": 2, "default_value": "-1", "tier": "advanced",
     "help": "How many recent tokens DRY scans (-1 = whole context, 0 = off)."},
    {"flag_name": "xtc_probability", "kind": "float", "plane": 2, "tier": "advanced",
     "help": "Exclude-Top-Choices: chance to drop the most-likely tokens for variety (0 = off)."},
    {"flag_name": "xtc_threshold", "kind": "float", "plane": 2, "default_value": "0.1", "tier": "advanced",
     "help": "XTC only removes tokens above this probability (llama.cpp default 0.1; 1.0 = off). Used with XTC probability."},
    {"flag_name": "mirostat", "kind": "int", "plane": 2, "tier": "advanced",
     "help": "Adaptive perplexity sampler: 0 = off, 1 = v1, 2 = v2."},
    {"flag_name": "mirostat_tau", "kind": "float", "plane": 2, "default_value": "5.0", "tier": "advanced",
     "help": "Mirostat target 'surprise' (entropy) — higher = more varied (llama.cpp default 5.0). Used only when Mirostat is on."},
    {"flag_name": "mirostat_eta", "kind": "float", "plane": 2, "default_value": "0.1", "tier": "advanced",
     "help": "Mirostat learning rate — how fast it adapts (llama.cpp default 0.1). Used only when Mirostat is on."},
    {"flag_name": "dynatemp_range", "kind": "float", "plane": 2, "default_value": "0.0", "tier": "advanced",
     "help": "Dynamic temperature: how far temperature can swing per token (0 = off)."},
    {"flag_name": "dynatemp_exponent", "kind": "float", "plane": 2, "default_value": "1.0", "tier": "advanced",
     "help": "Shape of the dynamic-temperature curve (llama.cpp default 1.0). Used with Dynamic temp range."},
    {"flag_name": "top_n_sigma", "kind": "float", "plane": 2, "default_value": "-1.0", "tier": "advanced",
     "help": "Keep tokens within N standard deviations of the top logit (-1 = off). A newer, simple truncation."},
    {"flag_name": "min_keep", "kind": "int", "plane": 2, "default_value": "0", "tier": "advanced",
     "help": "Always keep at least this many candidate tokens through the filters (0 = no minimum)."},
]


# Prior seeded names, per provider id (#3, 2026-07-08 "Built-in server" →
# "Built-in provider"): existing DBs keep their rows on reseed, so a pure rename in
# DEFAULT_PROVIDERS never reaches them. The seeder refreshes a present row's name
# ONLY while it still reads exactly one of these old seeded strings — a user's own
# rename is a different fact and is never touched (the B1-4 fill-empty precedent,
# applied to a rename).
_RENAMED_PROVIDER_NAMES: dict[str, tuple[str, ...]] = {
    "local-llamacpp": ("Built-in server — llama.cpp",),
}


# ── seeders (operate on a passed session, no commit) ──────────────────────────
def seed_default_providers(s) -> int:
    existing = {r.id: r for r in s.query(db.LlmProvider).all()}
    pos = len(existing)
    added = 0
    for p in DEFAULT_PROVIDERS:
        if p["id"] in existing:
            row = existing[p["id"]]
            if row.name in _RENAMED_PROVIDER_NAMES.get(p["id"], ()):
                row.name = str(p.get("name") or "")
            continue
        s.add(db.LlmProvider(
            id=p["id"], name=str(p.get("name") or ""), kind="llm", built_in=True, position=pos,
            provider_type=str(p["provider_type"]), base_url=str(p.get("base_url") or ""), api_key=None,
            default_model=str(p.get("default_model") or ""), embedding_model=str(p.get("embedding_model") or ""),
            timeout_seconds=int(p.get("timeout_seconds") or 60), local=bool(p["local"]),
        ))
        pos += 1
        added += 1
    return added


def seed_default_reasoning_map(s) -> int:
    """Fill-if-missing reasoning_map rows for every provider, keyed by its type (U2-T2).
    Additive — new providers/levels gain rows at boot; a user edit is never clobbered.
    Runs AFTER seed_default_providers — and the flush below is MANDATORY, not politeness:
    the HOST session is autoflush-OFF (JW `database.py` sessionmaker; the `seed.py:924`
    precedent), so without it the provider query hits the DB, sees ZERO just-added
    providers, and seeds NOTHING — silently. That exact bug shipped 2026-07-14: fresh
    boots/resets came up with an empty reasoning map (UI shows no levels; runs still
    worked via the resolver's type-seed fallback) and only a SECOND boot healed it.
    Found on the user's box 2026-07-16; pinned by
    test_reasoning.py::test_map_seeds_on_an_autoflush_off_session.
    Operates on the passed session, no commit."""
    from .reasoning_map_api import seed_rows_for_type
    s.flush()  # make seed_default_providers' pending rows visible (autoflush-OFF host)
    have = {(r.provider_id, r.level)
            for r in s.query(db.ReasoningMap.provider_id, db.ReasoningMap.level).all()}
    added = 0
    for prov in s.query(db.LlmProvider).all():
        for row in seed_rows_for_type(prov.provider_type):
            if (prov.id, row.level) in have:
                continue
            s.add(db.ReasoningMap(provider_id=prov.id, level=row.level,
                                  word=row.word or "", tokens=row.tokens, built_in=True))
            added += 1
    return added


# Use-limited licenses (not free for unrestricted/commercial use) → the ⚠ badge.
# This keyword match runs ONCE at seed time to populate the per-model `use_limited`
# flag, which is then DB-stored + editable per-model — so there is NO hardcoded
# runtime license rule (the old client-side regex is gone).
_USE_LIMITED_TERMS = ("community", "research", "non-commercial", "noncommercial", "llama", "gemma", "cc-by-nc")


def _use_limited(license_id: str) -> bool:
    lic = (license_id or "").lower()
    return any(t in lic for t in _USE_LIMITED_TERMS)


def _catalog_row(c: dict, *, built_in: bool) -> "db.ModelCatalog":
    """One catalog seed dict → a ModelCatalog row. Shared by the built-in seed and
    the per-APP extra rows (`seed_extra_catalog`) so the field mapping — including
    the Gemma-style external MTP draft facts — has a single source."""
    return db.ModelCatalog(
        id=c["id"], name=str(c.get("name") or ""), hf_repo=str(c.get("hf_repo") or ""),
        quant=str(c.get("quant") or ""), mmproj=c.get("mmproj"),
        total_params=str(c.get("total_params") or ""), active_params=str(c.get("active_params") or ""),
        mtp=bool(c.get("mtp") or False), mtp_builtin=bool(c.get("mtp_builtin") or False),
        type=str(c.get("type") or "dense"),
        mtp_draft_repo=str(c.get("mtp_draft_repo") or ""),
        mtp_draft_file=str(c.get("mtp_draft_file") or ""),
        mtp_draft_quant=str(c.get("mtp_draft_quant") or ""),
        trained_ctx=c.get("trained_ctx"),
        min_vram_mb=c.get("min_vram_mb"), min_ram_mb=c.get("min_ram_mb"),
        tier=str(c.get("tier") or "mid"), license=str(c.get("license") or ""),
        use_limited=_use_limited(str(c.get("license") or "")), embedding=bool(c.get("embedding") or False),
        pooling=str(c.get("pooling") or ""),
        quality_rank=int(c.get("quality_rank") or 100), description=str(c.get("description") or ""),
        notes=str(c.get("notes") or ""),
        architecture=str(c.get("architecture") or ""), experts=int(c.get("experts") or 0),
        size_label=str(c.get("size_label") or ""), size_bytes=c.get("size_bytes"),
        est_vram_mb=c.get("est_vram_mb"),
        built_in=built_in, position=int(c.get("position") or 0),
    )


def _seed_samplers(s, model_id: str, samplers: dict | None) -> None:
    """Seed a NEW catalog row's recommended-sampler rows (2026-07-07, the read-from-link
    parity item: the seed ships what the FILE says — these values come from the live
    header/generation_config reads recorded in the design doc ROUND 16). Written with
    built_in=False to be byte-identical with what the download-time identify pass
    (`set_derived`) produces — seed == file, one shape. Only called when the catalog
    row itself was just inserted, so a user's own sampler edits are never touched."""
    for name, val in (samplers or {}).items():
        nm = (name or "").strip()
        if nm:
            s.add(db.ModelSampler(model_id=model_id, param_name=nm, value=str(val), built_in=False))


# Known-stale seeded values, healed at boot (QC-43a, 2026-07-10): a seeded
# FACT that later proved wrong can never self-heal through fill-empty (the
# wrong value isn't empty), so each corrected fact records the exact old
# value(s) it once seeded and the catalog seeder swaps them for the CURRENT
# seed value — only when the row still carries an exact stale value, so a
# user- or inspect-written value never matches and is never touched.
STALE_SEED_VALUES = {
    # Empty since decision ④ (2026-08-05): the entries here healed rows that moved
    # into JustWrite's own seed, and every regularly-booted DB applied them long ago
    # (they shipped 2026-07-13/25; pre-production, no compat shims — decision ②).
    # The MECHANISM stays: a future seed-fact revision for a shared row registers
    # its exact old value here and seed_default_catalog swaps it, user edits safe.
    # (The historical gemma-12B draft-path + StyleTune fatal-drafter heals now live
    # only in git history.)
}


def _fill_inherited_draft(row, c: dict) -> None:
    """Backfill the tier-C BORROWED drafter onto an existing row without a reset — a
    Gemma-style model with no built-in MTP AND no own draft (e.g. gryphe-styletune-v2)
    borrows the official base-family assistant drafter, exactly what Read-from-link
    configures + auto-checks. Empty-only: fire ONLY when the row currently ships no
    draft of its own, so a user's own/edited draft (or a deliberate mtp choice on a
    drafted row) is never clobbered. `mtp` is set to the seed's enable value because a
    draftless row could not have had mtp on to begin with — this is a newly-available
    capability, not an override. No-op when the seed row carries no draft."""
    if row.mtp_draft_file or not c.get("mtp_draft_file"):
        return
    row.mtp_draft_repo = str(c.get("mtp_draft_repo") or "")
    row.mtp_draft_file = str(c["mtp_draft_file"])
    row.mtp_draft_quant = str(c.get("mtp_draft_quant") or "")
    row.mtp = bool(c.get("mtp") or False)


def seed_default_catalog(s) -> int:
    existing = {r.id: r for r in s.query(db.ModelCatalog).all()}
    added = 0
    for c in DEFAULT_CATALOG:
        row = existing.get(c["id"])
        if row is not None:
            # Fill-empty-only touch-up (#12b, 2026-07-08): existing DBs get the
            # harvested size FACTS without a reset. Auto-detected fields only,
            # and only when EMPTY — a value written at download time (the real
            # local file) or by a fresh inspect always wins; user-editable
            # fields are never touched here.
            if row.size_bytes is None and c.get("size_bytes") is not None:
                row.size_bytes = int(c["size_bytes"])
            if row.est_vram_mb is None and c.get("est_vram_mb") is not None:
                row.est_vram_mb = int(c["est_vram_mb"])
            if not row.size_label and c.get("size_label"):
                row.size_label = str(c["size_label"])
            _fill_inherited_draft(row, c)
            # Known-stale heal (QC-43a): swap an exact historically-seeded
            # wrong value for the current seed fact; anything else is a
            # user/inspect value and stays.
            for (rid, field), stale in STALE_SEED_VALUES.items():
                if rid == c["id"] and getattr(row, field, None) in stale and c.get(field):
                    setattr(row, field, c[field])
            continue
        s.add(_catalog_row(c, built_in=True))
        _seed_samplers(s, c["id"], c.get("samplers"))
        added += 1
    return added


def seed_extra_catalog(s, rows) -> int:
    """Per-APP extra model-catalog rows (host input via `install_llm`, e.g. JW's
    tuned Gemma daily drivers). Insert-if-missing by id — a reset re-creates them,
    a user edit is never clobbered. Seeded `built_in=False`: they are the app's
    seed data, not the shared stack's, so the catalog UI treats them as user rows."""
    existing = {r.id: r for r in s.query(db.ModelCatalog).all()}
    added = 0
    for c in rows or ():
        row = existing.get(c["id"])
        if row is not None:
            # Fill-empty-only touch-up (2026-07-13), mirroring seed_default_catalog:
            # an existing DB gets the harvested size + VRAM-estimate FACTS without a
            # reset. Auto-detected fields only, and only when EMPTY — a value written
            # at download or by a fresh inspect always wins; user-editable fields are
            # never touched. (Insert-if-missing skipped these before, so the app's own
            # rows like JW's Gemma never saw a new fact on an existing box.)
            if row.est_vram_mb is None and c.get("est_vram_mb") is not None:
                row.est_vram_mb = int(c["est_vram_mb"])
            if row.size_bytes is None and c.get("size_bytes") is not None:
                row.size_bytes = int(c["size_bytes"])
            if not row.size_label and c.get("size_label"):
                row.size_label = str(c["size_label"])
            _fill_inherited_draft(row, c)
            continue
        s.add(_catalog_row(c, built_in=False))
        _seed_samplers(s, c["id"], c.get("samplers"))
        added += 1
    return added


def seed_model_tunes_if_missing(s, hw_key: str, entries) -> int:
    """Per-APP tune seed for THIS machine (host input via `install_llm`): entries =
    [{"model_id": id, "flags": {flag_name: value}}], keyed under the CURRENT box's
    `hw_key`. The model_tunes design decree ("user-written only, never seeded")
    survives in spirit: strictly insert-if-missing per (model, hw, flag), so a
    user's Quick-tune Save is NEVER clobbered — this only re-creates the app's
    known-good starting tune after a dev-DB reset (pre-production, resets are the
    schema-upgrade path; without this the tuned values would vanish on every reset)."""
    if not hw_key:
        return 0
    existing = {
        (r.model_id, r.flag_name)
        for r in s.query(db.ModelTune).filter(db.ModelTune.hw_key == hw_key).all()
    }
    added = 0
    for e in entries or ():
        mid = e.get("model_id") or ""
        for fname, fval in (e.get("flags") or {}).items():
            if not mid or (mid, fname) in existing:
                continue
            s.add(db.ModelTune(model_id=mid, hw_key=hw_key, flag_name=fname, flag_value=str(fval)))
            added += 1
    return added


def seed_default_pricing(s) -> int:
    """Seed the cloud pricing table from DEFAULT_PRICING (merge-by-id — never
    clobber user edits). Runtime pricing reads the DB (editable), not this dict."""
    from .pricing import DEFAULT_PRICING
    existing = {r.model_id for r in s.query(db.ModelPricing.model_id).all()}
    added = 0
    for mid, (inp, out) in DEFAULT_PRICING.items():
        if mid in existing:
            continue
        s.add(db.ModelPricing(model_id=mid, input_per_m=float(inp), output_per_m=float(out)))
        added += 1
    return added


def seed_default_embed_templates(s) -> int:
    """Seed the per-model embedding task templates — the (empty) shared set plus
    the APP's registered `embed_templates` (decision ④: a template describes an
    app catalog row). Merge-by-id — never clobber user edits. /v1/ai/embeddings
    applies these; editable via /v1/ai/embed-templates."""
    existing = {r.model_id for r in s.query(db.ModelEmbedTemplate.model_id).all()}
    added = 0
    for t in [*DEFAULT_EMBED_TEMPLATES, *_APP.get("embed_templates", ())]:
        if t["id"] in existing:
            continue
        s.add(db.ModelEmbedTemplate(
            model_id=t["id"], document_template=t.get("document") or "",
            query_template=t.get("query") or "", built_in=True,
        ))
        added += 1
    return added


def seed_default_switch_presets(s) -> int:
    """Seed the capability/type switch presets (base + moe + the gated mtp) + their flag rows.
    Flushes each preset before its FK child rows (host session is autoflush=False
    with FK enforcement on — see the routing FK gotcha)."""
    existing = {r.id for r in s.query(db.SwitchPreset.id).all()}
    added = 0
    for p in DEFAULT_SWITCH_PRESETS:
        if p["id"] in existing:
            continue
        s.add(db.SwitchPreset(id=p["id"], label=str(p.get("label") or ""),
                              applies_to=str(p.get("applies_to") or "all"),
                              position=int(p.get("position") or 0), built_in=True))
        s.flush()  # parent in the DB before its FK children
        for fname, fval in (p.get("switches") or {}).items():
            s.add(db.PresetSwitch(preset_id=p["id"], flag_name=fname, flag_value=str(fval), built_in=True))
        added += 1
    return added


def seed_default_engine_presets(s) -> int:
    """Seed the host's built-in engine presets (the factory preset library, the
    2026-06-29 lab+preset model — §7.1: request params + samplers only, NO launch
    switches) + their FK sampler children. Flush each parent before its children
    (host session: autoflush off + FK on — the switch-preset seeder gotcha).
    Per-app data via `app_engine_presets()`. Insert-if-missing, with one refresh: a
    built-in row whose name still equals the app's recorded OLD default (`name_was`)
    is renamed to the current seed name — so a factory rename reaches existing DBs while
    a user who renamed the built-in keeps their name (B2-1 precedent; 1:1 preset-name
    alignment restored 2026-07-14)."""
    existing = {r.id: r for r in s.query(db.EnginePreset).all()}
    added = 0
    for p in app_engine_presets():
        row = existing.get(p["id"])
        if row is not None:
            was = str(p.get("name_was") or "")
            if row.built_in and was and row.name == was:
                row.name = str(p.get("name") or "")
            continue
        s.add(db.EnginePreset(
            id=p["id"], name=str(p.get("name") or ""), provider_id=str(p.get("provider_id") or ""),
            model=str(p.get("model") or ""), temperature=p.get("temperature"), top_p=p.get("top_p"),
            max_tokens=int(p.get("max_tokens") or 0),
            reasoning_effort=str(p.get("reasoning_effort") or ""), think=bool(p.get("think") or False),
            position=int(p.get("position") or 0), built_in=True))
        s.flush()  # parent in the DB before its FK children
        for pname, pval in (p.get("samplers") or {}).items():
            s.add(db.EnginePresetSampler(preset_id=p["id"], param_name=pname, value=str(pval)))
        added += 1
    return added


def seed_default_feature_presets(s) -> int:
    """Seed the built-in per-ACTION preset refs (the one-source assignment,
    `feature_preset_refs`) + the global `default_preset_id`. Merge-by-key,
    fill-if-missing: a user's re-point of an action survives a reseed. FK-safe: skip a
    ref whose preset_id isn't a known EnginePreset (seeded above or already in the DB).
    Per-app data via `app_feature_presets()` (action → preset_id)."""
    existing = {r.key for r in s.query(db.FeaturePresetRef.key).all()}
    valid = {p["id"] for p in app_engine_presets()} | {r.id for r in s.query(db.EnginePreset.id).all()}
    added = 0
    for action, preset_id in app_feature_presets().items():
        if action in existing or preset_id not in valid:
            continue
        s.add(db.FeaturePresetRef(key=action, preset_id=preset_id))
        added += 1
    # The catch-all default preset — fill-if-empty (a user's default is never clobbered).
    want = app_default_preset_id()
    if want and want in valid:
        row = s.get(db.RunnerSetting, "default_preset_id")
        if row is None:
            s.add(db.RunnerSetting(key="default_preset_id", value=want, built_in=True))
        elif not (row.value or "").strip():
            row.value = want
    return added


def restore_built_in_engine_presets(s) -> None:
    """Restore the built-in engine presets to factory: delete the seeded (built_in)
    presets + their FK children, then re-seed. CUSTOM presets are untouched. The
    `s.flush()` is MANDATORY — the host session is autoflush-OFF (see `seed_llm`), so
    without it `seed_default_engine_presets`' existence query (it skips ids already in
    the DB) would still see the pending-deleted rows and refuse to re-add them → the
    built-ins would be permanently gone. Mirrors `SwitchPresetStore.reset_to_factory`."""
    from . import stores
    ids = [r.id for r in s.query(db.EnginePreset.id).filter(db.EnginePreset.built_in.is_(True)).all()]
    stores._delete_engine_preset_rows(s, ids)
    s.flush()
    seed_default_engine_presets(s)


def reset_routing_to_factory() -> None:
    """Restore the preset routing to factory (the Presets page 'Reset all'): clear the
    per-action refs (`feature_preset_refs`) + the global default, RESTORE the built-in
    engine presets, then re-seed the app's factory refs + default. CUSTOM presets are
    KEPT (the app's reset convention — see the model catalog / switch-preset resets);
    only the built-ins + assignments snap back to defaults."""
    s = db.session()
    try:
        s.query(db.FeaturePresetRef).delete()   # clear the per-action assignments
        default = s.get(db.RunnerSetting, "default_preset_id")
        if default is not None:
            default.value = ""                  # cleared → re-seeded below from the app default
        s.flush()
        restore_built_in_engine_presets(s)      # delete → flush → re-seed (custom kept)
        seed_default_feature_presets(s)         # factory action→preset refs + the default (FK-safe)
        s.commit()
    finally:
        s.close()


def reset_preset_to_factory(preset_id: str) -> None:
    """Reset ONE built-in engine preset to its factory config (name + params +
    samplers), keeping its per-action assignments. A CUSTOM preset (not in the app's
    built-in library) has no factory to reset to → ValueError (the API maps it to 400)."""
    factory = {p["id"]: p for p in app_engine_presets()}
    if preset_id not in factory:
        raise ValueError(f"{preset_id!r} is not a built-in preset")
    p = factory[preset_id]
    s = db.session()
    try:
        row = s.get(db.EnginePreset, preset_id)
        if row is None or not row.built_in:
            raise ValueError(f"{preset_id!r} is not a built-in preset")
        row.name = str(p.get("name") or "")
        row.provider_id = str(p.get("provider_id") or "")
        row.model = str(p.get("model") or "")
        row.temperature = p.get("temperature")
        row.top_p = p.get("top_p")
        row.max_tokens = int(p.get("max_tokens") or 0)
        row.reasoning_effort = str(p.get("reasoning_effort") or "")
        row.think = bool(p.get("think") or False)
        s.query(db.EnginePresetSampler).filter(db.EnginePresetSampler.preset_id == preset_id).delete()
        for pname, pval in (p.get("samplers") or {}).items():
            s.add(db.EnginePresetSampler(preset_id=preset_id, param_name=pname, value=str(pval)))
        s.commit()
    finally:
        s.close()


def seed_default_runner_binaries(s) -> int:
    # RETIRED built-ins are PRUNED (user, 2026-07-07: "deleet" the cpu rows — a
    # CPU-only box can't run local LLMs at usable speed, so the cpu variants left
    # DEFAULT_BINARIES entirely): a built_in row whose (platform, gpu) no longer
    # exists in the defaults is removed at seed time, so existing DBs converge on
    # boot; user-ADDED rows (built_in=False) are never touched.
    wanted = {(b["platform"], b["gpu"]) for b in DEFAULT_BINARIES}
    for r in s.query(db.RunnerBinary).filter(db.RunnerBinary.built_in.is_(True)).all():
        if (r.platform, r.gpu) not in wanted:
            s.delete(r)
    existing = {(r.platform, r.gpu) for r in s.query(db.RunnerBinary.platform, db.RunnerBinary.gpu).all()}
    added = 0
    for i, b in enumerate(DEFAULT_BINARIES):
        if (b["platform"], b["gpu"]) in existing:
            continue
        s.add(db.RunnerBinary(
            platform=b["platform"], gpu=b["gpu"], source=str(b.get("source") or "github"),
            asset_url=b.get("asset_url"), runtime_url=b.get("runtime_url"),
            image=b.get("image"), sha256=b.get("sha256"),
            server_exe=str(b.get("server_exe") or "llama-server"), built_in=True, position=i,
        ))
        added += 1
    return added


def seed_default_runner_settings(s) -> int:
    existing = {r.key for r in s.query(db.RunnerSetting.key).all()}
    added = 0
    for r in DEFAULT_RUNNER_SETTINGS:
        if r["key"] in existing:
            continue
        s.add(db.RunnerSetting(key=r["key"], value=str(r.get("value") or ""), built_in=True))
        added += 1
    return added


def seed_model_list_rules(s) -> int:
    """Seed the online-provider model-list ruleset (#8) as ONE JSON document in the
    RunnerSetting store. Seed-REFRESH convention (like the feature-prompt stale-heal, but
    keyed on the `built_in` flag rather than byte-equality): a MISSING row is seeded
    built_in=True; an UNMODIFIED row (still built_in — never PUT by a user) is refreshed
    to the current seed whenever it drifts from it (a `SEED_VERSION`/rules bump reaches
    existing installs); a USER-edited row (built_in=False, set by the PUT store) is NEVER
    clobbered. Returns 1 when a new row was added."""
    import json

    from .model_list_rules import seed_doc

    want = seed_doc()
    row = s.get(db.RunnerSetting, "model_list_rules")
    if row is None:
        s.add(db.RunnerSetting(
            key="model_list_rules", value=json.dumps(want, sort_keys=True), built_in=True))
        return 1
    if row.built_in:
        try:
            cur = json.loads(row.value)
        except (ValueError, TypeError):
            cur = None
        if cur != want:  # unmodified but stale (old seed) → refresh in place
            row.value = json.dumps(want, sort_keys=True)
    return 0


def seed_default_knobs(s) -> int:
    """Seed knob_catalog + its enum options (knob_option). Flush each parent before
    its FK children (host session: autoflush off + FK on).

    The catalog is APP-OWNED, read-only data (GET /v1/ai/knob-catalog is its only
    endpoint — nothing in the app edits knob rows), so built-in rows SYNC to
    DEFAULT_KNOBS on every boot: kind/default_value/help/plane/applies_to/
    tier/position refresh from the seed (QC-17, 2026-07-09: plane-1 rows carry NO
    default_value — the app stopped storing the engine's own defaults), built-in
    rows dropped from the seed are DELETED (QC-11: context_shift + cache_reuse;
    their KnobOption rows cascade), and built-in OPTION rows sync in BOTH
    directions — ones the seed no longer carries are deleted (QC-18: switch
    values are plain text/number boxes; AMENDED 2026-07-24 — spec_type carries
    options again, the sanctioned enum exception after the "nobe" typo killed a
    load: the server refuses unknown spec types, so a dropdown is the honest
    input there) and newly-seeded ones are INSERTED (2026-07-25 audit: the
    insert half was missing, so existing DBs never received spec_type's
    options — a sync that only deletes is not a sync)."""
    existing = {r.flag_name: r for r in s.query(db.KnobCatalog).all()}
    seeded_names = {k["flag_name"] for k in DEFAULT_KNOBS}
    added = 0
    for name, row in existing.items():
        if row.built_in and name not in seeded_names:
            s.delete(row)  # FK ondelete=CASCADE clears its options
    for i, k in enumerate(DEFAULT_KNOBS):
        row = existing.get(k["flag_name"])
        if row is not None:
            if row.built_in:
                row.kind = str(k.get("kind") or "string")
                row.default_value = str(k.get("default_value") or "")
                row.help = str(k.get("help") or "")
                row.plane = int(k.get("plane") or 1)
                row.applies_to = str(k.get("applies_to") or "all")
                row.tier = str(k.get("tier") or "common")
                row.per_request = bool(k.get("per_request") or False)
                row.backends = str(k.get("backends") or "")  # Pass 2: backend applicability
                row.position = i
                # Option SYNC — BOTH halves (the 2026-07-25 audit defect): stale built-in
                # options are deleted AND newly-seeded ones are INSERTED. The insert half
                # was missing — this branch only deleted, so when QC-18's amendment gave
                # spec_type its options back (2026-07-24) a fresh DB got 5 option rows and
                # every EXISTING DB (where QC-18 had deleted them all) got none: the
                # typo-proof dropdown never reached a real install. A user's own option
                # rows (built_in=False) are never deleted and block no insert dedupe.
                seeded_opts = {str(o["value"]) for o in (k.get("options") or [])}
                have = set()
                for opt in s.query(db.KnobOption).filter(db.KnobOption.flag_name == k["flag_name"]).all():
                    if opt.built_in and opt.value not in seeded_opts:
                        s.delete(opt)
                    else:
                        have.add(opt.value)
                for j, o in enumerate(k.get("options") or []):
                    if str(o["value"]) not in have:
                        s.add(db.KnobOption(flag_name=k["flag_name"], value=str(o["value"]),
                                            label=str(o.get("label") or o["value"]),
                                            position=j, built_in=True))
            continue
        s.add(db.KnobCatalog(
            flag_name=k["flag_name"], kind=str(k.get("kind") or "string"),
            default_value=str(k.get("default_value") or ""), help=str(k.get("help") or ""),
            plane=int(k.get("plane") or 1), applies_to=str(k.get("applies_to") or "all"),
            tier=str(k.get("tier") or "common"), per_request=bool(k.get("per_request") or False),
            backends=str(k.get("backends") or ""), position=i, built_in=True,
        ))
        s.flush()
        for j, opt in enumerate(k.get("options") or []):
            s.add(db.KnobOption(flag_name=k["flag_name"], value=str(opt["value"]),
                                label=str(opt.get("label") or opt["value"]), position=j, built_in=True))
        added += 1
    return added


def seed_default_routing(s) -> bool:
    """Seed the live routing row (id='active') if missing — with NO choices made
    (user decision 2026-07-06: "we are shipping with models, just no model is
    automatically set as default, honestly not even embed should be set, this is
    all quick setup or manual"). The catalog ships FULL; the selections ship EMPTY:
    Quick Setup (or a manual Set-as-default / Set-as-embedding) fills them.
    Idempotent (fresh installs only — an existing user's routing is never touched)."""
    if s.get(db.RoutingConfigRow, "active") is not None:
        return False
    s.add(db.RoutingConfigRow(id="active", is_active=True, position=0,
                              default_llm_id="",
                              default_embedding_id="",
                              default_embedding_model=""))
    return True


def seed_default_feature_prompts(s) -> int:
    """Seed the host's registered feature prompts (per-app data; merge by key).
    Insert-if-missing, plus the registered stale-heals: when the host lists a
    key's OLD seed system texts (configure_app_seed feature_prompt_heals) and
    the existing row's system byte-equals one of them, the row is refreshed
    from the CURRENT spec — a user-edited prompt (text ≠ any old seed) is
    never touched (the QC-43a exact-stale-value pattern, applied to prompts)."""
    existing = {r.key for r in s.query(db.FeaturePrompt.key).all()}
    heals = _APP.get("feature_prompt_heals") or {}
    for key, old_texts in heals.items():
        spec = app_feature_prompts().get(key)
        if not spec or key not in existing:
            continue
        row = s.get(db.FeaturePrompt, key)
        if row is None or row.system not in old_texts:
            continue
        # Refresh ONLY the fields a seed revision carries (system + its schema
        # mirror) — a user who edited user_template while keeping the seed
        # system must not lose that edit to a heal.
        row.system = str(spec.get("system") or "")
        row.json_schema = str(spec.get("json_schema") or "")
    # Nav-metadata backfill (parity batch 2026-08-06): a seed revision may ADD
    # label/description to a row that predates them. Fill ONLY when the stored
    # pair is entirely empty — a row anyone named keeps its name.
    for key, spec in app_feature_prompts().items():
        if key not in existing or not (spec.get("label") or spec.get("description")):
            continue
        row = s.get(db.FeaturePrompt, key)
        if row is not None and row.built_in and not row.label and not row.description:
            row.label = str(spec.get("label") or "")
            row.description = str(spec.get("description") or "")
    added = 0
    for key, spec in app_feature_prompts().items():
        if key in existing:
            continue
        s.add(db.FeaturePrompt(
            key=key, feature=str(spec.get("feature") or key), system=str(spec.get("system") or ""),
            user_template=str(spec.get("user_template") or ""), built_in=True,
            json_mode=bool(spec.get("json_mode", False)),
            json_schema=str(spec.get("json_schema") or ""),
            label=str(spec.get("label") or ""), description=str(spec.get("description") or ""),
            subgroup=str(spec.get("group") or ""),
            position=int(spec.get("position") or 0),
        ))
        added += 1
    return added


def seed_llm(s=None) -> None:
    """Run every LLM seeder + commit. Opens its own session when none is given."""
    own = s is None
    if own:
        s = db.session()
    try:
        seed_default_providers(s)
        seed_default_reasoning_map(s)  # after providers exist (same-session autoflush)
        seed_default_routing(s)
        seed_default_catalog(s)  # empty by design (decision ④) — kept for the mechanism
        seed_default_pricing(s)
        seed_default_switch_presets(s)
        seed_default_engine_presets(s)
        seed_default_feature_presets(s)
        seed_default_runner_binaries(s)
        seed_default_runner_settings(s)
        seed_model_list_rules(s)
        seed_default_knobs(s)
        seed_default_hardware_classes(s)  # before class-tunes: the config's class must exist
        seed_default_class_tunes(s)
        seed_default_embed_templates(s)
        seed_default_feature_prompts(s)
        # The registered per-app extras (see configure_app_seed) — insert-if-missing,
        # so user edits / Quick-tune saves are never clobbered by a reseed.
        if _APP.get("model_catalog_extra"):
            seed_extra_catalog(s, _APP["model_catalog_extra"])
        if _APP.get("model_tunes_seed") and _APP.get("hw_key_fn"):
            seed_model_tunes_if_missing(s, _APP["hw_key_fn"](), _APP["model_tunes_seed"])
        if _APP.get("test_samples"):
            # The store owns the one fill-if-empty implementation (lazy import —
            # seed is imported by stores' API-model siblings; keep boot order free).
            from . import stores as _stores
            _stores.get_test_sample_store().seed_fill(s, _APP["test_samples"])
        # LAST, because it needs the whole catalog — defaults AND the host's extras:
        # bind measured class tunes to the id THIS app gave the same GGUF, and say so
        # when a tune can bind to nothing.
        link_class_tunes_to_catalog(s)
        # …then drop seed residue that can never apply (the pre-④ shared tunes still
        # sitting in JV/docgen DBs). User rows are built_in=False — never touched.
        retire_orphan_builtin_class_tunes(s)
        s.commit()
    finally:
        if own:
            s.close()
