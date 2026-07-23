# SPDX-License-Identifier: GPL-3.0-or-later
"""The concrete LLM stores — ONE shared implementation of every storage Protocol
(provider / routing / routing-presets / feature-presets / prompts / recommendations
/ model-catalog / model-switches) over the shared session
(`db.session`). Replaces every per-app `*_store.py`: an app installs the shared
LLM stack and gets these — it does not implement storage.

Each store opens a short-lived session per call (the routers call these outside a
request's session). `reset_to_factory` restores factory rows for shipped keys and
preserves user-added rows (lazy-imports the shared `seed` to avoid an import cycle).
"""

from __future__ import annotations

import uuid

from . import db
from .class_tunes_api import ClassTuneConfig, ClassTuneFlag
from .embed_templates_api import EmbedTemplateRow
from .model_catalog_api import CatalogRow
from .model_measurements_api import MeasurementFlag, MeasurementRow
from .model_tunes_api import ModelTuneFlag
from .pricing_api import PricingRow
from .reasoning_map_api import REASONING_LEVELS, ReasoningLevelRow, seed_rows_for_type
from .runner_config_api import EngineConfig, RunnerBinaryRow
from .prompts import FeaturePromptRow
from .switch_presets_api import PresetSwitchRow, SwitchPresetRow
from .presets_api import EnginePresetRow, PresetFlagRow
from .routing_api import RoutingConfig, RoutingDefaults
from .schema import LLMProviderConfig

_ACTIVE_ID = "active"


# ── providers ────────────────────────────────────────────────────────────────
def _provider_to_config(row: db.LlmProvider) -> LLMProviderConfig:
    return LLMProviderConfig(
        id=row.id, name=row.name, providerType=row.provider_type, baseUrl=row.base_url,
        apiKey=row.api_key or None, defaultModel=row.default_model,
        embeddingModel=row.embedding_model, timeoutSeconds=row.timeout_seconds, local=row.local,
    )


def _apply_provider(row: db.LlmProvider, cfg: LLMProviderConfig) -> None:
    row.name = cfg.name
    row.provider_type = cfg.providerType
    row.base_url = cfg.baseUrl
    row.api_key = cfg.apiKey or None
    row.default_model = cfg.defaultModel
    row.embedding_model = cfg.embeddingModel
    row.timeout_seconds = cfg.timeoutSeconds
    row.local = cfg.local


class ProviderStore:
    def list(self) -> list[LLMProviderConfig]:
        s = db.session()
        try:
            return [_provider_to_config(r) for r in s.query(db.LlmProvider).order_by(db.LlmProvider.position).all()]
        finally:
            s.close()

    def get(self, provider_id: str) -> LLMProviderConfig | None:
        s = db.session()
        try:
            row = s.get(db.LlmProvider, provider_id)
            return _provider_to_config(row) if row is not None else None
        finally:
            s.close()

    def add(self, cfg: LLMProviderConfig) -> None:
        s = db.session()
        try:
            row = db.LlmProvider(id=cfg.id, kind="llm", built_in=False, position=s.query(db.LlmProvider).count())
            _apply_provider(row, cfg)
            s.add(row)
            s.commit()
            ptype = row.provider_type
        finally:
            s.close()
        # U2-T2: fill the new provider's reasoning-map rows from its type (fill-if-missing).
        _reasoning_map.seed_missing(cfg.id, seed_rows_for_type(ptype))

    def replace(self, provider_id: str, cfg: LLMProviderConfig) -> None:
        s = db.session()
        ptype = ""
        try:
            row = s.get(db.LlmProvider, provider_id)
            if row is None:
                return
            _apply_provider(row, cfg)  # id/built_in/kind/position immutable on edit
            s.commit()
            ptype = row.provider_type
        finally:
            s.close()
        # U2-T2: a type change adds any missing reasoning-map rows for the new type
        # (fill-if-missing — existing rows + user edits untouched).
        if ptype:
            _reasoning_map.seed_missing(provider_id, seed_rows_for_type(ptype))

    def remove(self, provider_id: str) -> None:
        s = db.session()
        try:
            row = s.get(db.LlmProvider, provider_id)
            if row is not None:
                # Cascade the provider's reasoning-map rows (no FK on ReasoningMap):
                # a retype via delete+re-add would otherwise inherit the old type's
                # rows (fill-if-missing never overwrites them) and mis-map thinking.
                s.query(db.ReasoningMap).filter(
                    db.ReasoningMap.provider_id == provider_id
                ).delete()
                s.delete(row)
                s.commit()
        finally:
            s.close()


# ── routing (default + explicit pins) ─────────────────────────────────────────
def _row_to_routing(row: db.RoutingConfigRow) -> RoutingConfig:
    return RoutingConfig(
        default=RoutingDefaults(
            llmId=row.default_llm_id, model=row.default_model,
            embeddingId=row.default_embedding_id, embeddingModel=row.default_embedding_model,
        ),
    )


def _apply_routing(row: db.RoutingConfigRow, cfg: RoutingConfig) -> None:
    # The default LLM + embedding are the whole routing config now — the JW-path
    # per-feature pins were removed 2026-07-15 (presets are the one source).
    row.default_llm_id = cfg.default.llmId
    row.default_model = cfg.default.model
    row.default_embedding_id = cfg.default.embeddingId
    row.default_embedding_model = cfg.default.embeddingModel


class RoutingStore:
    def get_routing(self) -> RoutingConfig:
        s = db.session()
        try:
            row = s.get(db.RoutingConfigRow, _ACTIVE_ID)
            return _row_to_routing(row) if row is not None else RoutingConfig()
        finally:
            s.close()

    def set_routing(self, cfg: RoutingConfig) -> None:
        s = db.session()
        try:
            row = s.get(db.RoutingConfigRow, _ACTIVE_ID)
            if row is None:
                row = db.RoutingConfigRow(id=_ACTIVE_ID, is_active=True, position=0)
                s.add(row)
            _apply_routing(row, cfg)
            s.commit()
        finally:
            s.close()


# ── feature prompts (DB-seeded, Lab-editable) ─────────────────────────────────
def _prompt_to_row(r: db.FeaturePrompt) -> FeaturePromptRow:
    return FeaturePromptRow(
        key=r.key, feature=r.feature, system=r.system, user_template=r.user_template,
        built_in=r.built_in, json_mode=r.json_mode, json_schema=r.json_schema,
        label=r.label, description=r.description, group=r.subgroup,
    )


class PromptStore:
    def get(self, key: str) -> FeaturePromptRow | None:
        s = db.session()
        try:
            row = s.get(db.FeaturePrompt, key)
            return _prompt_to_row(row) if row is not None else None
        finally:
            s.close()

    def list(self) -> list[FeaturePromptRow]:
        s = db.session()
        try:
            return [_prompt_to_row(r) for r in s.query(db.FeaturePrompt).order_by(db.FeaturePrompt.key).all()]
        finally:
            s.close()

    def upsert(self, row: FeaturePromptRow) -> None:
        s = db.session()
        try:
            existing = s.get(db.FeaturePrompt, row.key)
            if existing is None:
                s.add(db.FeaturePrompt(
                    key=row.key, feature=row.feature, system=row.system, user_template=row.user_template,
                    built_in=row.built_in, json_mode=row.json_mode, json_schema=row.json_schema,
                    label=row.label, description=row.description, subgroup=row.group,
                ))
            else:
                existing.feature = row.feature
                existing.system = row.system
                existing.user_template = row.user_template
                existing.json_mode = row.json_mode
                existing.json_schema = row.json_schema
                existing.label = row.label
                existing.description = row.description
                existing.subgroup = row.group
            s.commit()
        finally:
            s.close()


# ── model catalog + switches ──────────────────────────────────────────────────
def _catalog_to_wire(r: db.ModelCatalog, samplers: dict[str, str] | None = None) -> CatalogRow:
    return CatalogRow(
        id=r.id, name=r.name, hfRepo=r.hf_repo, quant=r.quant, mmproj=r.mmproj,
        totalParams=r.total_params, activeParams=r.active_params, mtp=r.mtp, mtpBuiltin=r.mtp_builtin, type=r.type,
        mtpDraftRepo=r.mtp_draft_repo, mtpDraftFile=r.mtp_draft_file, mtpDraftQuant=r.mtp_draft_quant,
        trainedCtx=r.trained_ctx, samplers=dict(samplers or {}),
        minVramMb=r.min_vram_mb, minRamMb=r.min_ram_mb, tier=r.tier, license=r.license,
        useLimited=r.use_limited, embedding=r.embedding, pooling=r.pooling, qualityRank=r.quality_rank, description=r.description,
        notes=r.notes, architecture=r.architecture, experts=r.experts,
        sizeLabel=r.size_label, sizeBytes=r.size_bytes, estVramMb=r.est_vram_mb,
        position=r.position, builtIn=r.built_in,
    )


class ModelCatalogStore:
    def list(self) -> list[CatalogRow]:
        s = db.session()
        try:
            by_model: dict[str, dict[str, str]] = {}
            for sp in s.query(db.ModelSampler).order_by(db.ModelSampler.model_id, db.ModelSampler.param_name).all():
                by_model.setdefault(sp.model_id, {})[sp.param_name] = sp.value
            return [
                _catalog_to_wire(r, by_model.get(r.id))
                for r in s.query(db.ModelCatalog).order_by(db.ModelCatalog.position, db.ModelCatalog.id).all()
            ]
        finally:
            s.close()

    def upsert(self, row: CatalogRow) -> CatalogRow:
        s = db.session()
        try:
            existing = s.get(db.ModelCatalog, row.id)
            if existing is None:
                existing = db.ModelCatalog(id=row.id)
                s.add(existing)
            existing.name = row.name
            existing.hf_repo = row.hfRepo
            existing.quant = row.quant
            existing.mmproj = row.mmproj
            existing.total_params = row.totalParams
            existing.active_params = row.activeParams
            existing.mtp = row.mtp
            existing.mtp_builtin = bool(row.mtpBuiltin)  # header truth round-trips read-only through the form
            existing.type = row.type or "dense"
            existing.mtp_draft_repo = row.mtpDraftRepo or ""
            existing.mtp_draft_file = row.mtpDraftFile or ""
            existing.mtp_draft_quant = row.mtpDraftQuant or ""
            existing.trained_ctx = row.trainedCtx
            existing.min_vram_mb = row.minVramMb
            existing.min_ram_mb = row.minRamMb
            existing.tier = row.tier or "mid"
            existing.license = row.license or ""
            existing.use_limited = bool(row.useLimited)
            existing.embedding = bool(row.embedding)
            existing.pooling = row.pooling or ""
            existing.quality_rank = row.qualityRank
            existing.description = row.description or ""
            existing.notes = row.notes or ""
            existing.architecture = row.architecture or ""
            existing.experts = int(row.experts or 0)
            existing.size_label = row.sizeLabel or ""
            existing.size_bytes = row.sizeBytes
            existing.est_vram_mb = row.estVramMb
            existing.position = row.position
            existing.built_in = False
            s.commit()
            samplers = {sp.param_name: sp.value for sp in
                        s.query(db.ModelSampler).filter(db.ModelSampler.model_id == row.id).all()}
            return _catalog_to_wire(existing, samplers)
        finally:
            s.close()

    def delete(self, model_id: str) -> None:
        s = db.session()
        try:
            existing = s.get(db.ModelCatalog, model_id)
            if existing is not None:
                s.query(db.ModelSampler).filter(db.ModelSampler.model_id == model_id).delete()
                s.delete(existing)
                s.commit()
        finally:
            s.close()

    def reset_to_factory(self) -> None:
        from . import seed
        s = db.session()
        try:
            for cid in {c["id"] for c in seed.DEFAULT_CATALOG}:
                s.query(db.ModelSampler).filter(db.ModelSampler.model_id == cid).delete()
                row = s.get(db.ModelCatalog, cid)
                if row is not None:
                    s.delete(row)
            s.flush()
            seed.seed_default_catalog(s)
            s.commit()
        finally:
            s.close()

    def set_type(self, model_id: str, model_type: str) -> bool:
        """Set ONLY the capability `type` (moe|dense) on a catalog row — for GGUF
        identity auto-detect. Preserves every other field incl. `built_in` (unlike
        `upsert`, which marks the row user-edited). Returns True if it changed."""
        s = db.session()
        try:
            existing = s.get(db.ModelCatalog, model_id)
            if existing is None or existing.type == model_type:
                return False
            existing.type = model_type
            s.commit()
            return True
        finally:
            s.close()

    def set_derived(self, model_id: str, *, model_type: str, mtp_builtin: bool,
                    trained_ctx: int | None, total_params: str | None = None,
                    samplers: dict[str, str] | None = None,
                    architecture: str | None = None, experts: int | None = None,
                    size_label: str | None = None, size_bytes: int | None = None,
                    est_vram_mb: int | None = None) -> bool:
        """Set the FILE-DERIVED catalog fields (`type`/`mtp_builtin`/`trained_ctx`, and
        `total_params` when the file gives one) AND replace the per-model recommended
        sampler rows for `model_id`, from a GGUF header read (the GGUF-grounded model
        layer, Phase 2). Writes `mtp_builtin` (the header `nextn_predict_layers>0`
        truth), NEVER the user-facing `mtp` ENABLE flag — a Gemma external-draft model
        reads mtp_builtin=False here yet stays MTP-enabled via its draft; the old code
        clobbered the enable flag to False on download, which is exactly the grid-vs-
        checkbox disconnect this split fixes (2026-07-13). `total_params` is written
        only when not None — a dense model exposes it via `general.size_label` ("27B"),
        but a MoE expert-label ("128x9.4B") does NOT decompose, so it stays None → the
        curated value is preserved. The identity facts (`architecture`/`experts`/
        `size_label`/`size_bytes`, #141 — the auto-detected-panel parity) write only
        when given (None = leave as is; size_bytes is the QUANT-SPECIFIC file size).
        Preserves every other field incl. `built_in` AND the user's `notes` (unlike
        `upsert`, which marks the row user-edited). The sampler set is always REPLACED
        with the given map (empty clears it). Returns True if a scalar value changed;
        False when the model row is absent."""
        s = db.session()
        try:
            existing = s.get(db.ModelCatalog, model_id)
            if existing is None:
                return False
            changed = (existing.type != model_type or bool(existing.mtp_builtin) != bool(mtp_builtin)
                       or existing.trained_ctx != trained_ctx
                       or (total_params is not None and existing.total_params != total_params)
                       or (architecture is not None and existing.architecture != architecture)
                       or (experts is not None and existing.experts != experts)
                       or (size_label is not None and existing.size_label != size_label)
                       or (size_bytes is not None and existing.size_bytes != size_bytes)
                       or (est_vram_mb is not None and existing.est_vram_mb != est_vram_mb))
            existing.type = model_type or "dense"
            existing.mtp_builtin = bool(mtp_builtin)
            existing.trained_ctx = trained_ctx
            if total_params is not None:
                existing.total_params = total_params
            if architecture is not None:
                existing.architecture = architecture
            if experts is not None:
                existing.experts = int(experts)
            if size_label is not None:
                existing.size_label = size_label
            if size_bytes is not None:
                existing.size_bytes = int(size_bytes)
            if est_vram_mb is not None:
                existing.est_vram_mb = int(est_vram_mb)
            s.query(db.ModelSampler).filter(db.ModelSampler.model_id == model_id).delete()
            for name, val in (samplers or {}).items():
                nm = (name or "").strip()
                if nm:
                    s.add(db.ModelSampler(model_id=model_id, param_name=nm, value=str(val), built_in=False))
            s.commit()
            return changed
        finally:
            s.close()


# ── capability/type switch presets (base/moe/dense) ───────────────────────────
def _switch_preset_to_wire(p: db.SwitchPreset, switches: list[db.PresetSwitch]) -> SwitchPresetRow:
    return SwitchPresetRow(
        id=p.id, label=p.label, appliesTo=p.applies_to, position=p.position, builtIn=p.built_in,
        switches=[PresetSwitchRow(flagName=s.flag_name, flagValue=s.flag_value) for s in switches],
    )


class SwitchPresetStore:
    def list(self) -> list[SwitchPresetRow]:
        s = db.session()
        try:
            presets = s.query(db.SwitchPreset).order_by(db.SwitchPreset.position, db.SwitchPreset.id).all()
            by_preset: dict[str, list] = {}
            for r in s.query(db.PresetSwitch).order_by(db.PresetSwitch.flag_name).all():
                by_preset.setdefault(r.preset_id, []).append(r)
            return [_switch_preset_to_wire(p, by_preset.get(p.id, [])) for p in presets]
        finally:
            s.close()

    def upsert(self, row: SwitchPresetRow) -> SwitchPresetRow:
        s = db.session()
        try:
            existing = s.get(db.SwitchPreset, row.id)
            if existing is None:
                existing = db.SwitchPreset(id=row.id)
                s.add(existing)
            existing.label = row.label
            existing.applies_to = row.appliesTo or "all"
            existing.position = row.position
            existing.built_in = False
            s.flush()  # parent row in the DB before its FK children
            for old in s.query(db.PresetSwitch).filter(db.PresetSwitch.preset_id == row.id).all():
                s.delete(old)
            s.flush()
            for sw in row.switches:
                fn = (sw.flagName or "").strip()
                if fn:
                    s.add(db.PresetSwitch(preset_id=row.id, flag_name=fn, flag_value=sw.flagValue or "", built_in=False))
            s.commit()
            return row
        finally:
            s.close()

    def delete(self, preset_id: str) -> None:
        s = db.session()
        try:
            for old in s.query(db.PresetSwitch).filter(db.PresetSwitch.preset_id == preset_id).all():
                s.delete(old)
            p = s.get(db.SwitchPreset, preset_id)
            if p is not None:
                s.delete(p)
            s.commit()
        finally:
            s.close()

    def reset_to_factory(self) -> None:
        from . import seed
        s = db.session()
        try:
            for p in seed.DEFAULT_SWITCH_PRESETS:
                for old in s.query(db.PresetSwitch).filter(db.PresetSwitch.preset_id == p["id"]).all():
                    s.delete(old)
                row = s.get(db.SwitchPreset, p["id"])
                if row is not None:
                    s.delete(row)
            s.flush()
            seed.seed_default_switch_presets(s)
            s.commit()
        finally:
            s.close()


# ── engine presets (the 2026-06-29 lab+preset model, narrowed §7.1 2026-07-08:
# model + per-request params + samplers — NO launch switches; those are owned by
# the model × machine tune stack in `switch_resolve`). Assigned per-ACTION via
# `feature_preset_refs`, with the `default_preset_id` RunnerSetting as the global
# default (2026-07-15: the task tier is gone — the preset is the one source). ──
def _engine_preset_to_wire(p, samplers) -> EnginePresetRow:
    return EnginePresetRow(
        id=p.id, name=p.name, providerId=p.provider_id, model=p.model,
        temperature=p.temperature, topP=p.top_p, maxTokens=p.max_tokens,
        reasoningEffort=p.reasoning_effort, think=p.think,
        samplers=[PresetFlagRow(flagName=x.param_name, flagValue=x.value) for x in samplers],
        builtIn=p.built_in, position=p.position,
    )


def _delete_engine_preset_rows(s, ids) -> None:
    """Delete engine presets + their FK children (samplers) explicitly, in the
    given session. Host-agnostic — does NOT rely on SQLite ON DELETE CASCADE (the
    runner's own reset path runs with FK enforcement off). ONE teardown path, shared by
    EnginePresetStore.delete + seed.restore_built_in_engine_presets. Also drops any
    per-feature OVERRIDE (`feature_preset_refs`) pointing at a deleted preset so the
    feature falls to the default preset rather than stranding on a dangling id
    (restored 2026-07-14; the resolver also falls through defensively)."""
    ids = [i for i in ids if i]
    if not ids:
        return
    s.query(db.EnginePresetSampler).filter(db.EnginePresetSampler.preset_id.in_(ids)).delete(synchronize_session=False)
    s.query(db.FeaturePresetRef).filter(db.FeaturePresetRef.preset_id.in_(ids)).delete(synchronize_session=False)
    s.query(db.EnginePreset).filter(db.EnginePreset.id.in_(ids)).delete(synchronize_session=False)


class EnginePresetStore:
    def list(self) -> list[EnginePresetRow]:
        s = db.session()
        try:
            sm: dict[str, list] = {}
            for r in s.query(db.EnginePresetSampler).all():
                sm.setdefault(r.preset_id, []).append(r)
            return [
                _engine_preset_to_wire(
                    p,
                    sorted(sm.get(p.id, []), key=lambda x: x.param_name),
                )
                for p in s.query(db.EnginePreset).order_by(db.EnginePreset.position, db.EnginePreset.id).all()
            ]
        finally:
            s.close()

    def save(self, preset: EnginePresetRow) -> EnginePresetRow:
        s = db.session()
        try:
            pid = preset.id or uuid.uuid4().hex[:12]
            row = s.get(db.EnginePreset, pid)
            if row is None:
                row = db.EnginePreset(id=pid, position=s.query(db.EnginePreset).count())
                s.add(row)
            row.name = preset.name
            row.provider_id = preset.providerId
            row.model = preset.model
            row.temperature = preset.temperature
            row.top_p = preset.topP
            row.max_tokens = preset.maxTokens
            row.reasoning_effort = preset.reasoningEffort
            row.think = preset.think
            s.query(db.EnginePresetSampler).filter(db.EnginePresetSampler.preset_id == pid).delete()
            for x in preset.samplers:
                if not (x.flagName or "").strip():
                    continue
                s.add(db.EnginePresetSampler(preset_id=pid, param_name=x.flagName.strip(), value=x.flagValue or ""))
            s.commit()
            preset.id = pid
            return preset
        finally:
            s.close()

    def delete(self, preset_id: str) -> None:
        s = db.session()
        try:
            _delete_engine_preset_rows(s, [preset_id])  # children + parent (host-agnostic)
            s.commit()
        finally:
            s.close()


class FeaturePresetRefStore:
    """The per-ACTION preset assignment store (`feature_preset_refs`) — THE one
    source of what an action runs (2026-07-15). Keyed by ACTION id; "" clears the
    row so the action falls to the global default preset."""

    def list(self) -> dict[str, str]:
        s = db.session()
        try:
            return {r.key: r.preset_id for r in s.query(db.FeaturePresetRef).all()}
        finally:
            s.close()

    def set(self, feature_key: str, preset_id: str) -> None:
        s = db.session()
        try:
            row = s.get(db.FeaturePresetRef, feature_key)
            if not preset_id:
                if row is not None:
                    s.delete(row)
            elif row is None:
                s.add(db.FeaturePresetRef(key=feature_key, preset_id=preset_id))
            else:
                row.preset_id = preset_id
            s.commit()
        finally:
            s.close()


_provider = ProviderStore()
_routing = RoutingStore()
_prompt = PromptStore()
def _pricing_to_wire(r: db.ModelPricing) -> PricingRow:
    return PricingRow(modelId=r.model_id, inputPerM=r.input_per_m, outputPerM=r.output_per_m)


class PricingStore:
    """Cloud model pricing (usage-ledger cost source). Replaces the hardcoded
    pricing.py dict — seeded from DEFAULT_PRICING, editable via /v1/ai/pricing."""

    def list(self) -> list[PricingRow]:
        s = db.session()
        try:
            return [_pricing_to_wire(r) for r in s.query(db.ModelPricing).order_by(db.ModelPricing.model_id).all()]
        finally:
            s.close()

    def as_map(self) -> dict[str, tuple[float, float]]:
        s = db.session()
        try:
            return {r.model_id.lower(): (r.input_per_m, r.output_per_m) for r in s.query(db.ModelPricing).all()}
        finally:
            s.close()

    def upsert(self, row: PricingRow) -> PricingRow:
        s = db.session()
        try:
            mid = (row.modelId or "").strip().lower()
            existing = s.get(db.ModelPricing, mid)
            if existing is None:
                existing = db.ModelPricing(model_id=mid)
                s.add(existing)
            existing.input_per_m = float(row.inputPerM or 0.0)
            existing.output_per_m = float(row.outputPerM or 0.0)
            s.commit()
            return _pricing_to_wire(existing)
        finally:
            s.close()

    def delete(self, model_id: str) -> None:
        s = db.session()
        try:
            existing = s.get(db.ModelPricing, (model_id or "").strip().lower())
            if existing is not None:
                s.delete(existing)
                s.commit()
        finally:
            s.close()


def _reasoning_map_to_wire(r: db.ReasoningMap) -> ReasoningLevelRow:
    return ReasoningLevelRow(level=r.level, word=r.word, tokens=r.tokens)


class ReasoningMapStore:
    """Per-provider reasoning level→value rows (U2-T2). Read by the resolver
    (`llm/reasoning.py`) + the /v1/ai/reasoning-map CRUD; seeded per provider TYPE,
    fill-if-missing per instance (never clobbers a user edit)."""

    _ORDER = {lvl: i for i, lvl in enumerate(REASONING_LEVELS)}

    def for_provider(self, provider_id: str) -> list[ReasoningLevelRow]:
        s = db.session()
        try:
            rows = s.query(db.ReasoningMap).filter(db.ReasoningMap.provider_id == provider_id).all()
            return [_reasoning_map_to_wire(r) for r in sorted(rows, key=lambda r: self._ORDER.get(r.level, 99))]
        finally:
            s.close()

    def map_for(self, provider_id: str) -> dict[str, ReasoningLevelRow]:
        """level → row, for the resolver's lookup."""
        return {r.level: r for r in self.for_provider(provider_id)}

    def upsert(self, provider_id: str, row: ReasoningLevelRow) -> None:
        s = db.session()
        try:
            existing = s.get(db.ReasoningMap, (provider_id, row.level))
            if existing is None:
                existing = db.ReasoningMap(provider_id=provider_id, level=row.level)
                s.add(existing)
            existing.word = row.word or ""
            existing.tokens = row.tokens
            s.commit()
        finally:
            s.close()

    def seed_missing(self, provider_id: str, rows: list[ReasoningLevelRow]) -> None:
        """Fill-if-missing: insert a (provider, level) row only when absent — never
        clobber a user edit. Called at seed + on provider create."""
        s = db.session()
        try:
            have = {r[0] for r in s.query(db.ReasoningMap.level).filter(db.ReasoningMap.provider_id == provider_id).all()}
            changed = False
            for row in rows:
                if row.level in have:
                    continue
                s.add(db.ReasoningMap(provider_id=provider_id, level=row.level,
                                      word=row.word or "", tokens=row.tokens, built_in=True))
                changed = True
            if changed:
                s.commit()
        finally:
            s.close()


def _embed_template_to_wire(r: db.ModelEmbedTemplate) -> EmbedTemplateRow:
    return EmbedTemplateRow(
        modelId=r.model_id, documentTemplate=r.document_template,
        queryTemplate=r.query_template, builtIn=r.built_in,
    )


class EmbedTemplateStore:
    """Per-model embedding task templates (Move 0, RAG build) — the model FACTS
    /v1/ai/embeddings wraps inputs with. Seeded from DEFAULT_EMBED_TEMPLATES,
    editable via /v1/ai/embed-templates; a model with no row passes through."""

    def list(self) -> list[EmbedTemplateRow]:
        s = db.session()
        try:
            return [
                _embed_template_to_wire(r)
                for r in s.query(db.ModelEmbedTemplate).order_by(db.ModelEmbedTemplate.model_id).all()
            ]
        finally:
            s.close()

    def get(self, model_id: str) -> EmbedTemplateRow | None:
        s = db.session()
        try:
            r = s.get(db.ModelEmbedTemplate, (model_id or "").strip())
            return _embed_template_to_wire(r) if r is not None else None
        finally:
            s.close()

    def upsert(self, row: EmbedTemplateRow) -> EmbedTemplateRow:
        s = db.session()
        try:
            mid = (row.modelId or "").strip()
            existing = s.get(db.ModelEmbedTemplate, mid)
            if existing is None:
                existing = db.ModelEmbedTemplate(model_id=mid)
                s.add(existing)
            existing.document_template = str(row.documentTemplate or "")
            existing.query_template = str(row.queryTemplate or "")
            s.commit()
            return _embed_template_to_wire(existing)
        finally:
            s.close()

    def delete(self, model_id: str) -> None:
        s = db.session()
        try:
            existing = s.get(db.ModelEmbedTemplate, (model_id or "").strip())
            if existing is not None:
                s.delete(existing)
                s.commit()
        finally:
            s.close()


def _runner_binary_to_row(b) -> RunnerBinaryRow:
    return RunnerBinaryRow(
        platform=b.platform, gpu=b.gpu, source=b.source, assetUrl=b.asset_url,
        runtimeUrl=b.runtime_url, image=b.image, serverExe=b.server_exe,
    )


class RunnerConfigStore:
    """The bundled llama.cpp engine config — binaries (download URLs) + pinned
    build + VRAM margin. DB-backed + seeded, editable via /v1/ai/engine-config so
    a moved/renamed release asset can be pasted-fixed with no code change. The
    runner reads the SAME rows live via `build_runner_config()`."""

    def get_config(self) -> EngineConfig:
        cfg = build_runner_config()
        # update_policy + ack_hw_fingerprint are API-surface-only config — not part of
        # the runner's RunnerConfig; read the setting rows directly (absent → defaults).
        # ack_hw_fingerprint (Task E, user 2026-07-06/07): the last "gpu-name|vramMb"
        # the user's UI acknowledged — the hardware-change toast fires once per change.
        s = db.session()
        try:
            row = s.get(db.RunnerSetting, "update_policy")
            policy = (row.value if row else "") or "notify"
            ack_row = s.get(db.RunnerSetting, "ack_hw_fingerprint")
            ack_fp = ack_row.value if ack_row else ""
            pref_row = s.get(db.RunnerSetting, "preferred_gpu")
            preferred = (pref_row.value if pref_row else "") or ""
            warm_row = s.get(db.RunnerSetting, "warm_default_on_startup")
            warm = (warm_row.value if warm_row else "1") != "0"
        finally:
            s.close()
        return EngineConfig(
            pinnedBuild=cfg.llamacpp.pinned_build,
            safetyMarginMb=cfg.safety_margin_mb,
            modelsMax=cfg.models_max,
            sleepIdleSeconds=cfg.sleep_idle_seconds,
            downloadSegmentsEnabled=cfg.download_segments_enabled,
            downloadSegmentCount=cfg.download_segment_count,
            downloadSegmentMinBytes=cfg.download_segment_min_bytes,
            downloadSegmentRetries=cfg.download_segment_retries,
            downloadMaxConcurrent=cfg.download_max_concurrent,
            updatePolicy=policy,
            ackHwFingerprint=ack_fp,
            preferredGpu=preferred,
            classKeyOverride=get_class_key_override(),
            warmDefaultOnStartup=warm,
            binaries=[_runner_binary_to_row(b) for b in cfg.llamacpp.binaries],
        )

    def upsert_binary(self, row: RunnerBinaryRow) -> None:
        s = db.session()
        try:
            platform, gpu = row.platform.strip(), row.gpu.strip()
            existing = s.get(db.RunnerBinary, (platform, gpu))
            if existing is None:
                positions = [r.position for r in s.query(db.RunnerBinary.position).all()]
                existing = db.RunnerBinary(platform=platform, gpu=gpu, position=(max(positions, default=0) + 1))
                s.add(existing)
            existing.source = (row.source or "github").strip()
            existing.asset_url = row.assetUrl or None
            existing.runtime_url = row.runtimeUrl or None
            existing.image = row.image or None
            existing.server_exe = (row.serverExe or "llama-server").strip()
            s.commit()
        finally:
            s.close()

    def set_setting(self, key: str, value: str) -> None:
        s = db.session()
        try:
            existing = s.get(db.RunnerSetting, key)
            if existing is None:
                existing = db.RunnerSetting(key=key)
                s.add(existing)
            existing.value = value
            s.commit()
        finally:
            s.close()

    def reset_to_defaults(self) -> None:
        """Restore the shipped binary rows (corrected URLs) + the scalar settings
        (pinned build, VRAM margin, and the two router residency knobs) to their
        seed defaults; user-added custom rows are preserved."""
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
        from . import seed
        s = db.session()
        try:
            for b in DEFAULT_BINARIES:
                row = s.get(db.RunnerBinary, (b["platform"], b["gpu"]))
                if row is not None:
                    s.delete(row)
            s.flush()
            seed.seed_default_runner_binaries(s)
            for key, val in (("pinned_build", DEFAULT_PINNED_BUILD),
                             ("safety_margin_mb", str(DEFAULT_SAFETY_MARGIN_MB)),
                             ("models_max", str(DEFAULT_MODELS_MAX)),
                             ("sleep_idle_seconds", str(DEFAULT_SLEEP_IDLE_SECONDS)),
                             ("preferred_gpu", ""),
                             ("class_key_override", ""),
                             ("download_segments_enabled", "1" if DEFAULT_DOWNLOAD_SEGMENTS_ENABLED else "0"),
                             ("download_segment_count", str(DEFAULT_DOWNLOAD_SEGMENT_COUNT)),
                             ("download_segment_min_bytes", str(DEFAULT_DOWNLOAD_SEGMENT_MIN_BYTES)),
                             ("download_segment_retries", str(DEFAULT_DOWNLOAD_SEGMENT_RETRIES)),
                             ("download_max_concurrent", str(DEFAULT_DOWNLOAD_MAX_CONCURRENT)),
                             ("warm_default_on_startup", "1")):
                existing = s.get(db.RunnerSetting, key)
                if existing is None:
                    existing = db.RunnerSetting(key=key, built_in=True)
                    s.add(existing)
                existing.value = val
            s.commit()
        finally:
            s.close()


_model_catalog = ModelCatalogStore()
_pricing = PricingStore()
_reasoning_map = ReasoningMapStore()
_embed_template = EmbedTemplateStore()
_runner_config = RunnerConfigStore()
_switch_preset = SwitchPresetStore()
_engine_preset = EnginePresetStore()
_feature_preset_ref = FeaturePresetRefStore()


class ModelTuneStore:
    """The per-(model, machine) MEASURED tune rows (Plan B) — Quick tune's Save.
    Never seeded; user data only. `replace` swaps the (model, hw) set wholesale
    (the verbatim-snapshot semantics, D5); empty flag names are dropped."""

    def get(self, model_id: str, hw_key: str) -> list[ModelTuneFlag]:
        # Pass 2 (2026-07-22): only rows applicable under the ACTIVE backend show as
        # "your applied config" — a cuda-measured tune must not display (or apply)
        # under vulkan/cpu. Legacy "" rows read as cuda; unwired context → all rows
        # (pre-Pass-2 behavior). Same predicate the resolution layer uses.
        from .switch_resolve import active_backend, tune_row_applies
        act = active_backend()
        s = db.session()
        try:
            rows = s.query(db.ModelTune).filter(
                db.ModelTune.model_id == model_id, db.ModelTune.hw_key == hw_key
            ).order_by(db.ModelTune.flag_name).all()
            return [
                ModelTuneFlag(flagName=r.flag_name, flagValue=r.flag_value)
                for r in rows if tune_row_applies(getattr(r, "backend", ""), act)
            ]
        finally:
            s.close()

    def replace(self, model_id: str, hw_key: str, rows: list[ModelTuneFlag],
                baseline: dict[str, str] | None = None) -> None:
        """Swap the (model, machine) tune wholesale. `baseline` = the LAYER-resolved
        defaults standing at apply time (§7.6 drift detection) — stored in the same
        transaction; None clears any stored baseline (a caller that can't resolve
        one must not leave a stale one behind)."""
        s = db.session()
        try:
            s.query(db.ModelTune).filter(
                db.ModelTune.model_id == model_id, db.ModelTune.hw_key == hw_key
            ).delete()
            # Pass 2 (2026-07-22): stamp the backend the tune was measured on, so
            # resolution can refuse it under a different engine family. Unwired
            # context stamps "" (legacy semantics: reads as cuda).
            from .switch_resolve import active_backend
            backend = active_backend()
            seen: set[str] = set()
            for r in rows:
                name = (r.flagName or "").strip()
                if not name or name in seen:
                    continue
                seen.add(name)
                s.add(db.ModelTune(model_id=model_id, hw_key=hw_key,
                                   flag_name=name, flag_value=r.flagValue or "",
                                   backend=backend))
            s.query(db.ModelTuneBaseline).filter(
                db.ModelTuneBaseline.model_id == model_id, db.ModelTuneBaseline.hw_key == hw_key
            ).delete()
            for name, value in (baseline or {}).items():
                if (name or "").strip():
                    s.add(db.ModelTuneBaseline(model_id=model_id, hw_key=hw_key,
                                               flag_name=name.strip(), flag_value=str(value or "")))
            s.commit()
        finally:
            s.close()

    def get_baseline(self, model_id: str, hw_key: str) -> dict[str, str] | None:
        """The layer baseline stored when this tune was applied — None when the tune
        predates baseline tracking (no drift claim possible for it)."""
        s = db.session()
        try:
            rows = s.query(db.ModelTuneBaseline).filter(
                db.ModelTuneBaseline.model_id == model_id, db.ModelTuneBaseline.hw_key == hw_key
            ).all()
            return {r.flag_name: r.flag_value for r in rows} if rows else None
        finally:
            s.close()

    def list_for_machine(self, hw_key: str) -> dict[str, list[ModelTuneFlag]]:
        """Every model tuned on THIS machine → its rows (the §7.6 badge state)."""
        s = db.session()
        try:
            out: dict[str, list[ModelTuneFlag]] = {}
            for r in s.query(db.ModelTune).filter(db.ModelTune.hw_key == hw_key).order_by(
                db.ModelTune.model_id, db.ModelTune.flag_name
            ).all():
                out.setdefault(r.model_id, []).append(
                    ModelTuneFlag(flagName=r.flag_name, flagValue=r.flag_value))
            return out
        finally:
            s.close()

    def delete(self, model_id: str, hw_key: str) -> None:
        s = db.session()
        try:
            s.query(db.ModelTune).filter(
                db.ModelTune.model_id == model_id, db.ModelTune.hw_key == hw_key
            ).delete()
            s.query(db.ModelTuneBaseline).filter(
                db.ModelTuneBaseline.model_id == model_id, db.ModelTuneBaseline.hw_key == hw_key
            ).delete()
            s.commit()
        finally:
            s.close()


_model_tune = ModelTuneStore()


class ClassTuneStore:
    """The seeded + editable per-(model, HARDWARE-CLASS) tune rows (ROUND 8 Task C)
    — the class-tune library behind /v1/ai/class-tunes. Same verbatim-snapshot
    semantics as ModelTuneStore (`replace` swaps the (model, class) set wholesale;
    empty flag names dropped), but LIBRARY-shaped: `list_all` returns every config
    grouped, `builtIn` = the whole group is untouched seed rows. `replace` writes
    `built_in=False` — an edited config is the user's (the boot seeder inserts a
    built-in config only when its (model, class) has NO rows, so it never clobbers
    an edit; a fully deleted built-in config re-seeds on the next start)."""

    def list_all(self) -> list[ClassTuneConfig]:
        s = db.session()
        try:
            rows = s.query(db.ClassTune).order_by(
                db.ClassTune.model_id, db.ClassTune.class_key, db.ClassTune.flag_name
            ).all()
            groups: dict[tuple[str, str], list[db.ClassTune]] = {}
            for r in rows:
                groups.setdefault((r.model_id, r.class_key), []).append(r)
            return [
                ClassTuneConfig(
                    modelId=mid, classKey=ckey,
                    builtIn=all(r.built_in for r in grp),
                    rows=[ClassTuneFlag(flagName=r.flag_name, flagValue=r.flag_value) for r in grp],
                )
                for (mid, ckey), grp in groups.items()
            ]
        finally:
            s.close()

    def replace(self, model_id: str, class_key: str, rows: list[ClassTuneFlag]) -> None:
        s = db.session()
        try:
            s.query(db.ClassTune).filter(
                db.ClassTune.model_id == model_id, db.ClassTune.class_key == class_key
            ).delete()
            seen: set[str] = set()
            for r in rows:
                name = (r.flagName or "").strip()
                if not name or name in seen:
                    continue
                seen.add(name)
                s.add(db.ClassTune(model_id=model_id, class_key=class_key,
                                   flag_name=name, flag_value=r.flagValue or "",
                                   built_in=False))
            s.commit()
        finally:
            s.close()

    def delete(self, model_id: str, class_key: str) -> None:
        s = db.session()
        try:
            s.query(db.ClassTune).filter(
                db.ClassTune.model_id == model_id, db.ClassTune.class_key == class_key
            ).delete()
            s.commit()
        finally:
            s.close()


class HardwareClassStore:
    """The NAMED hardware-class sidecar (2026-07-22 user redesign) — name + editable
    whole-GB VRAM/RAM per `class_key`. The class_key stays the identity + join to
    `class_tunes`; this store owns only the label + the integer fields the add/edit
    form binds to. See db.HardwareClass. The class_key is DERIVED from vram/ram by the
    caller (the API, via hardware.format_class_key) — this store takes it explicit."""

    def list_all(self) -> list[dict]:
        s = db.session()
        try:
            rows = s.query(db.HardwareClass).order_by(
                db.HardwareClass.mem_type, db.HardwareClass.vram_gb,
                db.HardwareClass.ram_gb, db.HardwareClass.class_key
            ).all()
            return [{"classKey": r.class_key, "memType": r.mem_type or "discrete",
                     "vramGb": r.vram_gb, "ramGb": r.ram_gb,
                     "name": r.name or "", "builtIn": r.built_in} for r in rows]
        finally:
            s.close()

    def save(self, class_key: str, mem_type: str, vram_gb: int, ram_gb: int, name: str,
             orig_key: str = "") -> None:
        """Upsert a class. One class per key (VRAM+RAM for discrete, memory for the
        one-pool types): a duplicate `class_key` is rejected UNLESS it is the row being
        edited (`orig_key == class_key`). When the edit MOVED the key (type/VRAM/RAM
        changed → a new class_key), the model-configs cascade onto the new key and the
        old sidecar row is dropped. A user save takes ownership (`built_in=False`)."""
        s = db.session()
        try:
            orig = (orig_key or "").strip()
            if s.get(db.HardwareClass, class_key) is not None and orig != class_key:
                raise ValueError(f"a hardware class for {class_key} already exists")
            if orig and orig != class_key:
                for t in s.query(db.ClassTune).filter(db.ClassTune.class_key == orig).all():
                    t.class_key = class_key
                old = s.get(db.HardwareClass, orig)
                if old is not None:
                    s.delete(old)
            row = s.get(db.HardwareClass, class_key)
            if row is None:
                row = db.HardwareClass(class_key=class_key)
                s.add(row)
            row.mem_type = mem_type
            row.vram_gb = int(vram_gb)
            row.ram_gb = int(ram_gb)
            row.name = (name or "").strip()
            row.built_in = False
            s.commit()
        finally:
            s.close()

    def ensure(self, class_key: str, mem_type: str, vram_gb: int, ram_gb: int) -> None:
        """Create a blank-named sidecar row for `class_key` if none exists — the
        Tune-modal 'Save for hardware class' path saves a config for the box's class
        before any class form ran. No-op when the class already exists (never clobbers
        a name)."""
        s = db.session()
        try:
            if s.get(db.HardwareClass, class_key) is None:
                s.add(db.HardwareClass(class_key=class_key, mem_type=mem_type,
                                       vram_gb=int(vram_gb), ram_gb=int(ram_gb),
                                       name="", built_in=False))
                s.commit()
        finally:
            s.close()

    def delete(self, class_key: str) -> None:
        """Delete the class AND all its model-configs (a config is meaningless without
        its class)."""
        s = db.session()
        try:
            s.query(db.ClassTune).filter(db.ClassTune.class_key == class_key).delete()
            row = s.get(db.HardwareClass, class_key)
            if row is not None:
                s.delete(row)
            s.commit()
        finally:
            s.close()


_class_tune = ClassTuneStore()
_hardware_class = HardwareClassStore()


class TestSampleStore:
    """Canned Lab test samples (§7.3): list by ACTION (or all); upsert/delete for
    editability; `seed_fill` inserts only where (action_key, label) is absent so
    edited/deleted-then-reseeded rows behave like every other seeder. A host authors
    each blob ONCE and lists its sibling ACTIONS (the fan-out below) — no copy-paste."""

    def _vars_for(self, s, ids: list[int]) -> dict[int, dict[str, str]]:
        out: dict[int, dict[str, str]] = {}
        if ids:
            for v in s.query(db.TestSampleVar).filter(db.TestSampleVar.sample_id.in_(ids)).all():
                out.setdefault(v.sample_id, {})[v.name] = v.value
        return out

    def list_for_action(self, action: str = "") -> list[dict]:
        s = db.session()
        try:
            q = s.query(db.TestSample)
            if action:
                q = q.filter(db.TestSample.action_key == action)
            samples = q.order_by(db.TestSample.position, db.TestSample.id).all()
            vars_by = self._vars_for(s, [x.id for x in samples])
            return [{"id": x.id, "action": x.action_key, "label": x.label,
                     "variables": vars_by.get(x.id, {})} for x in samples]
        finally:
            s.close()

    def upsert(self, action: str, label: str, variables: dict[str, str],
               sample_id: int | None = None) -> int:
        s = db.session()
        try:
            row = s.get(db.TestSample, sample_id) if sample_id else None
            if row is None:
                row = db.TestSample(action_key=action, label=label)
                s.add(row)
                s.flush()
            else:
                row.action_key = action
                row.label = label
                s.query(db.TestSampleVar).filter(db.TestSampleVar.sample_id == row.id).delete()
            for name, value in (variables or {}).items():
                n = (name or "").strip()
                if n:
                    s.add(db.TestSampleVar(sample_id=row.id, name=n, value=value or ""))
            s.commit()
            return row.id
        finally:
            s.close()

    def delete(self, sample_id: int) -> None:
        s = db.session()
        try:
            s.query(db.TestSampleVar).filter(db.TestSampleVar.sample_id == sample_id).delete()
            s.query(db.TestSample).filter(db.TestSample.id == sample_id).delete()
            s.commit()
        finally:
            s.close()

    def seed_fill(self, s, rows: list[dict]) -> int:
        """Insert missing (action_key, label) samples on the GIVEN session. Each host
        row authors ONE blob and fans it to its sibling actions: `actions` (a list) — or
        a single `action` — names every action the blob seeds, so a shape shared by N
        actions is written once, not copied N times. Returns how many rows were added."""
        added = 0
        pos = 0
        for r in rows or []:
            label = (r.get("label") or "").strip()
            variables = r.get("variables") or {}
            actions = r.get("actions")
            if actions is None:
                one = (r.get("action") or "").strip()
                actions = [one] if one else []
            if not label:
                continue
            for action in actions:
                a = (action or "").strip()
                if not a:
                    continue
                exists = s.query(db.TestSample).filter(
                    db.TestSample.action_key == a, db.TestSample.label == label
                ).first()
                if exists:
                    continue
                row = db.TestSample(action_key=a, label=label, position=pos)
                pos += 1
                s.add(row)
                s.flush()
                for name, value in variables.items():
                    n = (name or "").strip()
                    if n:
                        s.add(db.TestSampleVar(sample_id=row.id, name=n, value=value or ""))
                added += 1
        return added


_test_sample = TestSampleStore()


class ModelMeasurementStore:
    """The persistent measurement history (#142 rows 5+6) — every real
    decode-speed result from the Tune modal + the auto-tune sweep. Append-only
    (`record`), newest-first reads (`list`), user-cleared (`clear` — the
    Clear-history button; per-model or everything). Never seeded. The switches
    that produced a number are child rows deleted explicitly with their parent
    (soft refs, the tune-family convention)."""

    def record(self, model_id: str, *, machine_key: str, source: str, label: str,
               tokens_per_sec: float, vram_total_mb: int, at: int,
               rows: list[MeasurementFlag]) -> int:
        s = db.session()
        try:
            from .switch_resolve import active_backend
            m = db.ModelMeasurement(
                model_id=model_id, machine_key=machine_key or "",
                source=source or "tune", label=label or "",
                tokens_per_sec=float(tokens_per_sec or 0),
                vram_total_mb=int(vram_total_mb or 0), at=int(at or 0),
                backend=active_backend(),  # Pass 2: which engine family measured it
            )
            s.add(m)
            s.flush()  # assigns the autoincrement id the children key on
            seen: set[str] = set()
            for r in rows or []:
                name = (r.flagName or "").strip()
                if not name or name in seen:
                    continue
                seen.add(name)
                s.add(db.MeasurementSwitch(measurement_id=m.id, flag_name=name,
                                           flag_value=r.flagValue or ""))
            s.commit()
            return int(m.id)
        finally:
            s.close()

    def list(self, model_id: str | None = None) -> list[MeasurementRow]:
        s = db.session()
        try:
            q = s.query(db.ModelMeasurement)
            if model_id:
                q = q.filter(db.ModelMeasurement.model_id == model_id)
            ms = q.order_by(db.ModelMeasurement.at.desc(),
                            db.ModelMeasurement.id.desc()).all()
            ids = [m.id for m in ms]
            flags: dict[int, list[MeasurementFlag]] = {}
            if ids:
                for f in s.query(db.MeasurementSwitch).filter(
                    db.MeasurementSwitch.measurement_id.in_(ids)
                ).order_by(db.MeasurementSwitch.flag_name).all():
                    flags.setdefault(f.measurement_id, []).append(
                        MeasurementFlag(flagName=f.flag_name, flagValue=f.flag_value))
            return [
                MeasurementRow(
                    id=m.id, modelId=m.model_id, machineKey=m.machine_key,
                    source=m.source, label=m.label, tokensPerSec=m.tokens_per_sec,
                    vramTotalMb=m.vram_total_mb, at=m.at,
                    switches=flags.get(m.id, []),
                )
                for m in ms
            ]
        finally:
            s.close()

    def clear(self, model_id: str | None = None) -> int:
        s = db.session()
        try:
            q = s.query(db.ModelMeasurement)
            if model_id:
                q = q.filter(db.ModelMeasurement.model_id == model_id)
            ids = [m.id for m in q.all()]
            n = 0
            if ids:
                s.query(db.MeasurementSwitch).filter(
                    db.MeasurementSwitch.measurement_id.in_(ids)
                ).delete(synchronize_session=False)
                n = s.query(db.ModelMeasurement).filter(
                    db.ModelMeasurement.id.in_(ids)
                ).delete(synchronize_session=False)
            s.commit()
            return int(n)
        finally:
            s.close()


_model_measurement = ModelMeasurementStore()


def get_provider_store() -> ProviderStore: return _provider
def get_routing_store() -> RoutingStore: return _routing
def get_prompt_store() -> PromptStore: return _prompt


# The global default engine preset — the one catch-all for an action with no ref.
# Stored as a RunnerSetting scalar (relocated 2026-07-15 from the deleted
# TaskKindPreset[""] row; the reasoning_cap_default precedent).
def get_default_preset_id() -> str:
    s = db.session()
    try:
        row = s.get(db.RunnerSetting, "default_preset_id")
        return row.value if row is not None else ""
    finally:
        s.close()


def set_default_preset_id(preset_id: str) -> None:
    s = db.session()
    try:
        row = s.get(db.RunnerSetting, "default_preset_id")
        if row is None:
            row = db.RunnerSetting(key="default_preset_id", built_in=False)
            s.add(row)
        row.value = preset_id or ""
        s.commit()
    finally:
        s.close()


# The online-provider model-list ruleset (#8) — ONE JSON document in the same
# RunnerSetting store as `default_preset_id` (NOT a new table). `built_in` is the
# unmodified-signal: a seeded/reset doc is built_in=True (a seed bump refreshes it,
# seed.seed_model_list_rules); a user PUT flips it False so a reseed never clobbers it.
def get_model_list_rules() -> dict:
    """The stored rules document {seedVersion, rules}. Missing/corrupt → the factory
    seed (so the endpoint + resolver always have a well-formed doc)."""
    import json

    from .model_list_rules import seed_doc

    s = db.session()
    try:
        row = s.get(db.RunnerSetting, "model_list_rules")
        if row is None or not (row.value or "").strip():
            return seed_doc()
        try:
            doc = json.loads(row.value)
        except (ValueError, TypeError):
            return seed_doc()
        return doc if isinstance(doc, dict) else seed_doc()
    finally:
        s.close()


def set_model_list_rules(doc: dict) -> None:
    """Persist a USER edit — marks the row built_in=False so a reseed never clobbers it."""
    import json

    s = db.session()
    try:
        row = s.get(db.RunnerSetting, "model_list_rules")
        if row is None:
            row = db.RunnerSetting(key="model_list_rules")
            s.add(row)
        row.value = json.dumps(doc or {}, sort_keys=True)
        row.built_in = False
        s.commit()
    finally:
        s.close()


def reset_model_list_rules() -> None:
    """Snap the rules back to the shipped seed and re-arm seed-refresh (built_in=True)."""
    import json

    from .model_list_rules import seed_doc

    s = db.session()
    try:
        row = s.get(db.RunnerSetting, "model_list_rules")
        if row is None:
            row = db.RunnerSetting(key="model_list_rules")
            s.add(row)
        row.value = json.dumps(seed_doc(), sort_keys=True)
        row.built_in = True
        s.commit()
    finally:
        s.close()


def get_model_catalog_store() -> ModelCatalogStore: return _model_catalog


def list_class_tune_refs() -> list[dict]:
    """The (model, class) pairs that HAVE a class config — served on the catalog
    response (one fetch). THE §9 final ruled shape (user, 2026-07-22): the hidden
    class→model pick table is DELETED; the recommendation IS the visible class-config
    list ("the config that matches your hardware names your model"), so QuickSetup
    reads exactly the rows the user sees in the panel."""
    s = db.session()
    try:
        rows = s.query(db.ClassTune.model_id, db.ClassTune.class_key).distinct().all()
        return [{"modelId": m, "classKey": c} for m, c in rows]
    finally:
        s.close()


def get_class_key_override() -> str:
    """The user's class override ("" = auto-detect) — 'detection proposes, never
    dictates' (user ruling 2026-07-22): a wrong sensor must cost one setting, not a
    dead subsystem (the ram0 incident). Stored as an ordinary runner_setting row,
    the preferred_gpu precedent."""
    s = db.session()
    try:
        row = s.get(db.RunnerSetting, "class_key_override")
        return (row.value if row else "") or ""
    finally:
        s.close()
def get_pricing_store() -> PricingStore: return _pricing
def get_reasoning_map_store() -> ReasoningMapStore: return _reasoning_map
def get_embed_template_store() -> EmbedTemplateStore: return _embed_template
def get_runner_config_store() -> RunnerConfigStore: return _runner_config
def get_switch_preset_store() -> SwitchPresetStore: return _switch_preset
def get_engine_preset_store() -> EnginePresetStore: return _engine_preset
def get_feature_preset_ref_store() -> FeaturePresetRefStore: return _feature_preset_ref
def get_model_tune_store() -> ModelTuneStore: return _model_tune
def get_class_tune_store() -> ClassTuneStore: return _class_tune
def get_hardware_class_store() -> HardwareClassStore: return _hardware_class
def get_model_measurement_store() -> ModelMeasurementStore: return _model_measurement
def get_test_sample_store() -> TestSampleStore: return _test_sample


def list_knob_catalog() -> list[dict]:
    """The knob catalog joined with its enum options, as plain dicts (camelCase) —
    name → friendly KnobGrid metadata. The friendly-input source for C1."""
    s = db.session()
    try:
        opts: dict[str, list] = {}
        for o in s.query(db.KnobOption).order_by(db.KnobOption.flag_name, db.KnobOption.position).all():
            opts.setdefault(o.flag_name, []).append({"value": o.value, "label": o.label})
        rows = s.query(db.KnobCatalog).order_by(db.KnobCatalog.plane, db.KnobCatalog.position).all()
        return [
            {
                "flagName": k.flag_name, "kind": k.kind,
                "default": k.default_value, "help": k.help, "plane": k.plane,
                "appliesTo": k.applies_to, "tier": k.tier, "perRequest": k.per_request,
                "backends": k.backends, "options": opts.get(k.flag_name, []),
            }
            for k in rows
        ]
    finally:
        s.close()


def list_knob_backends() -> dict[str, str]:
    """Backend applicability per knob (Pass 2, 2026-07-22): {flag_name: "cuda,rocm,…"}
    for knobs that are NOT applicable everywhere ("" rows are omitted — absent = all).
    Injected into the runner (`knob_backends_fn`) so its section construction can drop
    a flag the ACTIVE engine family can't use; the llm/ package stays decoupled."""
    s = db.session()
    try:
        return {
            k.flag_name: k.backends
            for k in s.query(db.KnobCatalog).all()
            if (k.backends or "").strip()
        }
    finally:
        s.close()


def build_runner_config():
    """Build the bundled runner's RunnerConfig from the DB (runner_binary +
    runner_setting) — the host-side replacement for the old runner-manifest.json.
    Wired into the runner service as its `config_fn` by install_llm. Falls back to
    the runner's seed defaults if the binaries haven't been seeded yet."""
    from ..runner.config import (
        DEFAULT_DOWNLOAD_MAX_CONCURRENT,
        DEFAULT_DOWNLOAD_SEGMENT_COUNT,
        DEFAULT_DOWNLOAD_SEGMENT_MIN_BYTES,
        DEFAULT_DOWNLOAD_SEGMENT_RETRIES,
        DEFAULT_DOWNLOAD_SEGMENTS_ENABLED,
        DEFAULT_MODELS_MAX,
        DEFAULT_PINNED_BUILD,
        DEFAULT_SAFETY_MARGIN_MB,
        DEFAULT_SLEEP_IDLE_SECONDS,
        default_config,
    )
    from ..runner.schema import BinaryAsset, LlamacppSpec, RunnerConfig

    s = db.session()
    try:
        bins = [
            BinaryAsset(
                platform=b.platform, gpu=b.gpu, source=b.source, asset_url=b.asset_url,
                runtime_url=b.runtime_url, image=b.image, sha256=b.sha256, server_exe=b.server_exe,
            )
            for b in s.query(db.RunnerBinary).order_by(db.RunnerBinary.position, db.RunnerBinary.platform).all()
        ]
        if not bins:
            return default_config()  # not seeded yet → the engine defaults
        settings = {r.key: r.value for r in s.query(db.RunnerSetting).all()}

        def _int(key: str, default: int) -> int:
            try:
                return int(settings.get(key) or default)
            except (TypeError, ValueError):
                return default

        def _bool(key: str, default: bool) -> bool:
            raw = (settings.get(key) or "").strip().lower()
            if raw in ("1", "true", "on", "yes"):
                return True
            if raw in ("0", "false", "off", "no"):
                return False
            return default

        return RunnerConfig(
            llamacpp=LlamacppSpec(pinned_build=settings.get("pinned_build") or DEFAULT_PINNED_BUILD, binaries=bins),
            safety_margin_mb=_int("safety_margin_mb", DEFAULT_SAFETY_MARGIN_MB),
            models_max=_int("models_max", DEFAULT_MODELS_MAX),
            sleep_idle_seconds=_int("sleep_idle_seconds", DEFAULT_SLEEP_IDLE_SECONDS),
            preferred_gpu=(settings.get("preferred_gpu") or ""),
            download_segments_enabled=_bool("download_segments_enabled", DEFAULT_DOWNLOAD_SEGMENTS_ENABLED),
            download_segment_count=_int("download_segment_count", DEFAULT_DOWNLOAD_SEGMENT_COUNT),
            download_segment_min_bytes=_int("download_segment_min_bytes", DEFAULT_DOWNLOAD_SEGMENT_MIN_BYTES),
            download_segment_retries=_int("download_segment_retries", DEFAULT_DOWNLOAD_SEGMENT_RETRIES),
            download_max_concurrent=_int("download_max_concurrent", DEFAULT_DOWNLOAD_MAX_CONCURRENT),
        )
    finally:
        s.close()
