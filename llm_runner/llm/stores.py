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

import re
import uuid

from . import db
from .class_tunes_api import ClassTuneConfig, ClassTuneFlag
from .feature_presets_api import FeaturePreset
from .feature_samplers_api import FeatureSamplerRow
from .model_catalog_api import CatalogRow
from .model_measurements_api import MeasurementFlag, MeasurementRow
from .model_tunes_api import ModelTuneFlag
from .pricing_api import PricingRow
from .runner_config_api import EngineConfig, RunnerBinaryRow
from .prompts import FeaturePromptRow
from .switch_presets_api import PresetSwitchRow, SwitchPresetRow
from .presets_api import EnginePresetRow, PresetFlagRow
from .routing_api import FeaturePin, RoutingConfig, RoutingDefaults
from .task_kinds_api import TaskKindRow
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
        finally:
            s.close()

    def replace(self, provider_id: str, cfg: LLMProviderConfig) -> None:
        s = db.session()
        try:
            row = s.get(db.LlmProvider, provider_id)
            if row is None:
                return
            _apply_provider(row, cfg)  # id/built_in/kind/position immutable on edit
            s.commit()
        finally:
            s.close()

    def remove(self, provider_id: str) -> None:
        s = db.session()
        try:
            row = s.get(db.LlmProvider, provider_id)
            if row is not None:
                s.delete(row)
                s.commit()
        finally:
            s.close()


# ── routing (default + explicit pins) ─────────────────────────────────────────
def _row_to_routing(s, row: db.RoutingConfigRow) -> RoutingConfig:
    pins = {
        p.feature: FeaturePin(providerId=p.provider_id, model=p.model)
        for p in s.query(db.RoutingPin).filter(db.RoutingPin.config_id == row.id).all()
    }
    return RoutingConfig(
        default=RoutingDefaults(
            llmId=row.default_llm_id, model=row.default_model,
            embeddingId=row.default_embedding_id, embeddingModel=row.default_embedding_model,
        ),
        pins=pins,
    )


def _apply_routing(s, row: db.RoutingConfigRow, cfg: RoutingConfig) -> None:
    row.default_llm_id = cfg.default.llmId
    row.default_model = cfg.default.model
    row.default_embedding_id = cfg.default.embeddingId
    row.default_embedding_model = cfg.default.embeddingModel
    # Persist the (possibly new) config row before inserting its FK children
    # (routing_pins) — the host session has autoflush off + FK on.
    s.add(row)
    s.flush()
    s.query(db.RoutingPin).filter(db.RoutingPin.config_id == row.id).delete()
    for feature, p in cfg.pins.items():
        if p.providerId:  # explicit pin only
            s.add(db.RoutingPin(config_id=row.id, feature=feature, provider_id=p.providerId, model=p.model))


class RoutingStore:
    def get_routing(self) -> RoutingConfig:
        s = db.session()
        try:
            row = s.get(db.RoutingConfigRow, _ACTIVE_ID)
            return _row_to_routing(s, row) if row is not None else RoutingConfig()
        finally:
            s.close()

    def set_routing(self, cfg: RoutingConfig) -> None:
        s = db.session()
        try:
            row = s.get(db.RoutingConfigRow, _ACTIVE_ID)
            if row is None:
                row = db.RoutingConfigRow(id=_ACTIVE_ID, is_active=True, position=0)
                s.add(row)
            _apply_routing(s, row, cfg)
            s.commit()
        finally:
            s.close()


# ── feature presets (Feature Workbench) ───────────────────────────────────────
def _preset_to_wire(r: db.FeaturePreset) -> FeaturePreset:
    return FeaturePreset(
        id=r.id, action=r.action, name=r.name, active=r.is_active,
        providerId=r.provider_id, model=r.model, system=r.system,
        userTemplate=r.user_template, temperature=r.temperature, think=r.think,
        maxTokens=r.max_tokens, jsonMode=r.json_mode,
        topP=r.top_p, reasoningEffort=r.reasoning_effort,
    )


def _apply_preset(row: db.FeaturePreset, p: FeaturePreset) -> None:
    row.action = p.action
    row.name = p.name
    row.provider_id = p.providerId
    row.model = p.model
    row.system = p.system
    row.user_template = p.userTemplate
    row.temperature = p.temperature
    row.think = p.think
    row.max_tokens = p.maxTokens
    row.json_mode = p.jsonMode
    row.top_p = p.topP
    row.reasoning_effort = p.reasoningEffort


class FeaturePresetStore:
    def list_presets(self) -> list[FeaturePreset]:
        s = db.session()
        try:
            return [_preset_to_wire(r) for r in s.query(db.FeaturePreset).order_by(db.FeaturePreset.action, db.FeaturePreset.position).all()]
        finally:
            s.close()

    def save_preset(self, preset: FeaturePreset) -> FeaturePreset:
        s = db.session()
        try:
            row = s.get(db.FeaturePreset, preset.id) if preset.id else None
            if row is None:
                row = db.FeaturePreset(id=preset.id or uuid.uuid4().hex[:12], is_active=False,
                                       position=s.query(db.FeaturePreset).filter(db.FeaturePreset.action == preset.action).count())
                _apply_preset(row, preset)
                s.add(row)
            else:
                _apply_preset(row, preset)
            s.commit()
            return _preset_to_wire(row)
        finally:
            s.close()

    def delete_preset(self, preset_id: str) -> None:
        s = db.session()
        try:
            row = s.get(db.FeaturePreset, preset_id)
            if row is not None:
                s.delete(row)
                s.commit()
        finally:
            s.close()

    def set_active(self, preset_id: str) -> None:
        s = db.session()
        try:
            row = s.get(db.FeaturePreset, preset_id)
            if row is None:
                return
            for other in s.query(db.FeaturePreset).filter(db.FeaturePreset.action == row.action, db.FeaturePreset.is_active.is_(True)).all():
                other.is_active = False
            row.is_active = True
            s.commit()
        finally:
            s.close()


# ── feature prompts (DB-seeded, Lab-editable) ─────────────────────────────────
def _prompt_to_row(r: db.FeaturePrompt) -> FeaturePromptRow:
    return FeaturePromptRow(
        key=r.key, feature=r.feature, system=r.system, user_template=r.user_template,
        temperature=r.temperature, think=r.think, built_in=r.built_in,
        max_tokens=r.max_tokens, json_mode=r.json_mode, json_schema=r.json_schema,
        top_p=r.top_p, reasoning_effort=r.reasoning_effort,
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
                    temperature=row.temperature, think=row.think, built_in=row.built_in,
                    max_tokens=row.max_tokens, json_mode=row.json_mode,
                    json_schema=row.json_schema, top_p=row.top_p,
                    reasoning_effort=row.reasoning_effort,
                    label=row.label, description=row.description, subgroup=row.group,
                ))
            else:
                existing.feature = row.feature
                existing.system = row.system
                existing.user_template = row.user_template
                existing.temperature = row.temperature
                existing.think = row.think
                existing.max_tokens = row.max_tokens
                existing.json_mode = row.json_mode
                existing.json_schema = row.json_schema
                existing.top_p = row.top_p
                existing.reasoning_effort = row.reasoning_effort
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
        totalParams=r.total_params, activeParams=r.active_params, mtp=r.mtp, type=r.type,
        mtpDraftRepo=r.mtp_draft_repo, mtpDraftFile=r.mtp_draft_file, mtpDraftQuant=r.mtp_draft_quant,
        trainedCtx=r.trained_ctx, samplers=dict(samplers or {}),
        minVramMb=r.min_vram_mb, minRamMb=r.min_ram_mb, tier=r.tier, license=r.license,
        useLimited=r.use_limited, embedding=r.embedding, pooling=r.pooling, qualityRank=r.quality_rank, description=r.description,
        notes=r.notes, architecture=r.architecture, experts=r.experts,
        sizeLabel=r.size_label, sizeBytes=r.size_bytes,
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

    def set_derived(self, model_id: str, *, model_type: str, mtp: bool,
                    trained_ctx: int | None, total_params: str | None = None,
                    samplers: dict[str, str] | None = None,
                    architecture: str | None = None, experts: int | None = None,
                    size_label: str | None = None, size_bytes: int | None = None) -> bool:
        """Set the FILE-DERIVED catalog fields (`type`/`mtp`/`trained_ctx`, and
        `total_params` when the file gives one) AND replace the per-model recommended
        sampler rows for `model_id`, from a GGUF header read (the GGUF-grounded model
        layer, Phase 2). `total_params` is written only when not None — a dense model
        exposes it via `general.size_label` ("27B"), but a MoE expert-label ("128x9.4B")
        does NOT decompose, so it stays None → the curated value is preserved. The
        identity facts (`architecture`/`experts`/`size_label`/`size_bytes`, #141 —
        the auto-detected-panel parity) write only when given (None = leave as is;
        size_bytes is the QUANT-SPECIFIC file size). Preserves every other field
        incl. `built_in` AND the user's `notes` (unlike `upsert`, which marks the
        row user-edited). The sampler set is always REPLACED with the given map
        (empty clears it). Returns True if a scalar value changed; False when the
        model row is absent."""
        s = db.session()
        try:
            existing = s.get(db.ModelCatalog, model_id)
            if existing is None:
                return False
            changed = (existing.type != model_type or bool(existing.mtp) != bool(mtp)
                       or existing.trained_ctx != trained_ctx
                       or (total_params is not None and existing.total_params != total_params)
                       or (architecture is not None and existing.architecture != architecture)
                       or (experts is not None and existing.experts != experts)
                       or (size_label is not None and existing.size_label != size_label)
                       or (size_bytes is not None and existing.size_bytes != size_bytes))
            existing.type = model_type or "dense"
            existing.mtp = bool(mtp)
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
            s.query(db.ModelSampler).filter(db.ModelSampler.model_id == model_id).delete()
            for name, val in (samplers or {}).items():
                nm = (name or "").strip()
                if nm:
                    s.add(db.ModelSampler(model_id=model_id, param_name=nm, value=str(val), built_in=False))
            s.commit()
            return changed
        finally:
            s.close()


class FeatureSamplerStore:
    """Per-action long-tail sampler knobs (feature_sampler_params) — edited by the
    lab via make_feature_samplers_router, merged into the per-call extra at dispatch."""

    def list(self, key: str) -> list[FeatureSamplerRow]:
        s = db.session()
        try:
            return [
                FeatureSamplerRow(flagName=r.param_name, flagValue=r.value, builtIn=r.built_in)
                for r in s.query(db.FeatureSamplerParam)
                .filter(db.FeatureSamplerParam.key == key)
                .order_by(db.FeatureSamplerParam.param_name)
                .all()
            ]
        finally:
            s.close()

    def replace(self, key: str, samplers: list[FeatureSamplerRow]) -> list[FeatureSamplerRow]:
        """Replace the whole sampler set for an action. The lab sends every row;
        empty-named rows are dropped."""
        s = db.session()
        try:
            s.query(db.FeatureSamplerParam).filter(db.FeatureSamplerParam.key == key).delete()
            for sp in samplers:
                if not (sp.flagName or "").strip():
                    continue
                s.add(db.FeatureSamplerParam(
                    key=key, param_name=sp.flagName.strip(), value=sp.flagValue or "", built_in=False,
                ))
            s.commit()
        finally:
            s.close()
        return self.list(key)


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
# the model × machine tune stack in `switch_resolve`). Assigned by TASKKIND
# (TaskKindPreset), with TaskKindPreset[""] as the global default (2026-07-02: no
# per-feature override tier). ──
def _engine_preset_to_wire(p, samplers) -> EnginePresetRow:
    return EnginePresetRow(
        id=p.id, name=p.name, providerId=p.provider_id, model=p.model,
        temperature=p.temperature, topP=p.top_p, maxTokens=p.max_tokens,
        jsonMode=p.json_mode, reasoningEffort=p.reasoning_effort,
        samplers=[PresetFlagRow(flagName=x.param_name, flagValue=x.value) for x in samplers],
        builtIn=p.built_in, position=p.position,
    )


def _delete_engine_preset_rows(s, ids) -> None:
    """Delete engine presets + their FK children (samplers) explicitly, in the
    given session. Host-agnostic — does NOT rely on SQLite ON DELETE CASCADE (the
    runner's own reset path runs with FK enforcement off). ONE teardown path, shared by
    EnginePresetStore.delete + seed.restore_built_in_engine_presets."""
    ids = [i for i in ids if i]
    if not ids:
        return
    s.query(db.EnginePresetSampler).filter(db.EnginePresetSampler.preset_id.in_(ids)).delete(synchronize_session=False)
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
            row.json_mode = preset.jsonMode
            row.reasoning_effort = preset.reasoningEffort
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


class TaskKindPresetStore:
    def list(self) -> dict[str, str]:
        s = db.session()
        try:
            return {r.task_kind: r.preset_id for r in s.query(db.TaskKindPreset).all()}
        finally:
            s.close()

    def set(self, task_kind: str, preset_id: str) -> None:
        s = db.session()
        try:
            row = s.get(db.TaskKindPreset, task_kind)
            if not preset_id:
                if row is not None:
                    s.delete(row)
            elif row is None:
                s.add(db.TaskKindPreset(task_kind=task_kind, preset_id=preset_id))
            else:
                row.preset_id = preset_id
            s.commit()
        finally:
            s.close()


def _slugify_task(label: str) -> str:
    s = re.sub(r"[^a-z0-9]+", ".", (label or "").strip().lower()).strip(".")
    if not s:
        return "task"
    # "feature" is a reserved id: PUT /task-kinds/feature is a literal route that would
    # shadow PUT /task-kinds/{id}, so a task with that id could never be renamed.
    return "feature.task" if s == "feature" else s


def _task_kind_to_wire(r: db.TaskKind) -> TaskKindRow:
    return TaskKindRow(id=r.id, label=r.label, description=r.description, position=r.position, builtIn=r.built_in)


class TaskKindStore:
    """The user-editable TASK catalog (`db.TaskKind`). Seeded with the shared built-in
    nine; users create / rename / delete CUSTOM tasks. Built-ins are protected from
    delete; a custom delete cascades cleanup across the SOFT-referencing tables (no FK)."""

    def list(self) -> list[TaskKindRow]:
        s = db.session()
        try:
            return [_task_kind_to_wire(r) for r in s.query(db.TaskKind).order_by(db.TaskKind.position, db.TaskKind.id).all()]
        finally:
            s.close()

    def upsert(self, row: TaskKindRow) -> TaskKindRow:
        s = db.session()
        try:
            tid = (row.id or "").strip()
            if not tid:
                # new: derive a stable id from the label; suffix on collision, never clobber.
                base = _slugify_task(row.label)
                tid = base
                n = 2
                while s.get(db.TaskKind, tid) is not None:
                    tid = f"{base}-{n}"
                    n += 1
            existing = s.get(db.TaskKind, tid)
            if existing is None:
                existing = db.TaskKind(id=tid, position=s.query(db.TaskKind).count())
                s.add(existing)
            existing.label = row.label
            existing.description = row.description or ""
            if row.position:
                existing.position = row.position
            # built_in is set only by the seeder; upsert never promotes/demotes it.
            s.commit()
            return _task_kind_to_wire(existing)
        finally:
            s.close()

    def delete(self, task_id: str) -> None:
        s = db.session()
        try:
            row = s.get(db.TaskKind, task_id)
            if row is None:
                return
            if row.built_in:
                raise ValueError("cannot delete a built-in task")
            # cascade cleanup across every SOFT reference (no FK to task_kinds): its
            # preset assignment + every feature assigned to it.
            s.query(db.TaskKindPreset).filter(db.TaskKindPreset.task_kind == task_id).delete()
            s.query(db.FeatureTaskKind).filter(db.FeatureTaskKind.task_kind == task_id).delete()
            s.delete(row)
            s.commit()
        finally:
            s.close()


class FeatureTaskKindStore:
    """feature/action key → its task (the user-editable reassignment layer). "" clears
    the row → the feature re-floats to its factory task via `install._task_kind_of`."""

    def list(self) -> dict[str, str]:
        s = db.session()
        try:
            return {r.key: r.task_kind for r in s.query(db.FeatureTaskKind).all()}
        finally:
            s.close()

    def set(self, feature_key: str, task_kind: str) -> None:
        s = db.session()
        try:
            row = s.get(db.FeatureTaskKind, feature_key)
            if not task_kind:
                if row is not None:
                    s.delete(row)
            elif row is None:
                s.add(db.FeatureTaskKind(key=feature_key, task_kind=task_kind))
            else:
                row.task_kind = task_kind
            s.commit()
        finally:
            s.close()


_provider = ProviderStore()
_routing = RoutingStore()
_feature_preset = FeaturePresetStore()
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
            updatePolicy=policy,
            ackHwFingerprint=ack_fp,
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
                             ("download_segments_enabled", "1" if DEFAULT_DOWNLOAD_SEGMENTS_ENABLED else "0"),
                             ("download_segment_count", str(DEFAULT_DOWNLOAD_SEGMENT_COUNT)),
                             ("download_segment_min_bytes", str(DEFAULT_DOWNLOAD_SEGMENT_MIN_BYTES)),
                             ("download_segment_retries", str(DEFAULT_DOWNLOAD_SEGMENT_RETRIES))):
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
_runner_config = RunnerConfigStore()
_switch_preset = SwitchPresetStore()
_feature_sampler = FeatureSamplerStore()
_engine_preset = EnginePresetStore()
_task_kind_preset = TaskKindPresetStore()
_task_kind = TaskKindStore()
_feature_task_kind = FeatureTaskKindStore()


class ModelTuneStore:
    """The per-(model, machine) MEASURED tune rows (Plan B) — Quick tune's Save.
    Never seeded; user data only. `replace` swaps the (model, hw) set wholesale
    (the verbatim-snapshot semantics, D5); empty flag names are dropped."""

    def get(self, model_id: str, hw_key: str) -> list[ModelTuneFlag]:
        s = db.session()
        try:
            rows = s.query(db.ModelTune).filter(
                db.ModelTune.model_id == model_id, db.ModelTune.hw_key == hw_key
            ).order_by(db.ModelTune.flag_name).all()
            return [ModelTuneFlag(flagName=r.flag_name, flagValue=r.flag_value) for r in rows]
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
            seen: set[str] = set()
            for r in rows:
                name = (r.flagName or "").strip()
                if not name or name in seen:
                    continue
                seen.add(name)
                s.add(db.ModelTune(model_id=model_id, hw_key=hw_key,
                                   flag_name=name, flag_value=r.flagValue or ""))
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


_class_tune = ClassTuneStore()


class TestSampleStore:
    """Canned Lab test samples (§7.3): list by taskKind (or all); upsert/delete
    for editability; `seed_fill` inserts only where (task_kind, label) is absent
    so edited/deleted-then-reseeded rows behave like every other seeder."""

    def _vars_for(self, s, ids: list[int]) -> dict[int, dict[str, str]]:
        out: dict[int, dict[str, str]] = {}
        if ids:
            for v in s.query(db.TestSampleVar).filter(db.TestSampleVar.sample_id.in_(ids)).all():
                out.setdefault(v.sample_id, {})[v.name] = v.value
        return out

    def list_for_kind(self, task_kind: str = "") -> list[dict]:
        s = db.session()
        try:
            q = s.query(db.TestSample)
            if task_kind:
                q = q.filter(db.TestSample.task_kind == task_kind)
            samples = q.order_by(db.TestSample.position, db.TestSample.id).all()
            vars_by = self._vars_for(s, [x.id for x in samples])
            return [{"id": x.id, "taskKind": x.task_kind, "label": x.label,
                     "variables": vars_by.get(x.id, {})} for x in samples]
        finally:
            s.close()

    def upsert(self, task_kind: str, label: str, variables: dict[str, str],
               sample_id: int | None = None) -> int:
        s = db.session()
        try:
            row = s.get(db.TestSample, sample_id) if sample_id else None
            if row is None:
                row = db.TestSample(task_kind=task_kind, label=label)
                s.add(row)
                s.flush()
            else:
                row.task_kind = task_kind
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
        """Insert missing (task_kind, label) samples on the GIVEN session (the
        seed_llm transaction); returns how many were added."""
        added = 0
        for i, r in enumerate(rows or []):
            kind = (r.get("taskKind") or "").strip()
            label = (r.get("label") or "").strip()
            if not kind or not label:
                continue
            exists = s.query(db.TestSample).filter(
                db.TestSample.task_kind == kind, db.TestSample.label == label
            ).first()
            if exists:
                continue
            row = db.TestSample(task_kind=kind, label=label, position=i)
            s.add(row)
            s.flush()
            for name, value in (r.get("variables") or {}).items():
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
            m = db.ModelMeasurement(
                model_id=model_id, machine_key=machine_key or "",
                source=source or "tune", label=label or "",
                tokens_per_sec=float(tokens_per_sec or 0),
                vram_total_mb=int(vram_total_mb or 0), at=int(at or 0),
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
def get_feature_preset_store() -> FeaturePresetStore: return _feature_preset
def get_prompt_store() -> PromptStore: return _prompt
def get_model_catalog_store() -> ModelCatalogStore: return _model_catalog


def list_class_picks() -> list[dict]:
    """The class→model map rows (Phase 3), ascending min_vram_mb — served on the
    catalog response (one fetch, no extra endpoint; useCatalogMeta maps them)."""
    s = db.session()
    try:
        rows = s.query(db.ModelClassPick).order_by(db.ModelClassPick.min_vram_mb).all()
        return [{"minVramMb": int(r.min_vram_mb), "modelId": r.model_id} for r in rows]
    finally:
        s.close()
def get_pricing_store() -> PricingStore: return _pricing
def get_runner_config_store() -> RunnerConfigStore: return _runner_config
def get_switch_preset_store() -> SwitchPresetStore: return _switch_preset
def get_feature_sampler_store() -> FeatureSamplerStore: return _feature_sampler
def get_engine_preset_store() -> EnginePresetStore: return _engine_preset
def get_task_kind_preset_store() -> TaskKindPresetStore: return _task_kind_preset
def get_task_kind_store() -> TaskKindStore: return _task_kind
def get_feature_task_kind_store() -> FeatureTaskKindStore: return _feature_task_kind
def get_model_tune_store() -> ModelTuneStore: return _model_tune
def get_class_tune_store() -> ClassTuneStore: return _class_tune
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
                "flagName": k.flag_name, "label": k.label, "kind": k.kind,
                "default": k.default_value, "help": k.help, "plane": k.plane,
                "appliesTo": k.applies_to, "tier": k.tier, "options": opts.get(k.flag_name, []),
            }
            for k in rows
        ]
    finally:
        s.close()


def build_runner_config():
    """Build the bundled runner's RunnerConfig from the DB (runner_binary +
    runner_setting) — the host-side replacement for the old runner-manifest.json.
    Wired into the runner service as its `config_fn` by install_llm. Falls back to
    the runner's seed defaults if the binaries haven't been seeded yet."""
    from ..runner.config import (
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
            download_segments_enabled=_bool("download_segments_enabled", DEFAULT_DOWNLOAD_SEGMENTS_ENABLED),
            download_segment_count=_int("download_segment_count", DEFAULT_DOWNLOAD_SEGMENT_COUNT),
            download_segment_min_bytes=_int("download_segment_min_bytes", DEFAULT_DOWNLOAD_SEGMENT_MIN_BYTES),
            download_segment_retries=_int("download_segment_retries", DEFAULT_DOWNLOAD_SEGMENT_RETRIES),
        )
    finally:
        s.close()
