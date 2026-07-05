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
from .feature_presets_api import FeaturePreset
from .feature_samplers_api import FeatureSamplerRow
from .model_catalog_api import CatalogRow
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
        max_tokens=r.max_tokens, json_mode=r.json_mode, top_p=r.top_p,
        reasoning_effort=r.reasoning_effort,
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
                    max_tokens=row.max_tokens, json_mode=row.json_mode, top_p=row.top_p,
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
        trainedCtx=r.trained_ctx, samplers=dict(samplers or {}),
        minVramMb=r.min_vram_mb, minRamMb=r.min_ram_mb, tier=r.tier, license=r.license,
        useLimited=r.use_limited, embedding=r.embedding, pooling=r.pooling, qualityRank=r.quality_rank, description=r.description,
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
                    samplers: dict[str, str] | None = None) -> bool:
        """Set the FILE-DERIVED catalog fields (`type`/`mtp`/`trained_ctx`, and
        `total_params` when the file gives one) AND replace the per-model recommended
        sampler rows for `model_id`, from a GGUF header read (the GGUF-grounded model
        layer, Phase 2). `total_params` is written only when not None — a dense model
        exposes it via `general.size_label` ("27B"), but a MoE expert-label ("128x9.4B")
        does NOT decompose, so it stays None → the curated value is preserved. Preserves
        every other field incl. `built_in` (unlike `upsert`, which marks the row
        user-edited). The sampler set is always REPLACED with the given map (empty
        clears it). Returns True if a `type`/`mtp`/`trained_ctx`/`total_params` value
        changed; False when the model row is absent."""
        s = db.session()
        try:
            existing = s.get(db.ModelCatalog, model_id)
            if existing is None:
                return False
            changed = (existing.type != model_type or bool(existing.mtp) != bool(mtp)
                       or existing.trained_ctx != trained_ctx
                       or (total_params is not None and existing.total_params != total_params))
            existing.type = model_type or "dense"
            existing.mtp = bool(mtp)
            existing.trained_ctx = trained_ctx
            if total_params is not None:
                existing.total_params = total_params
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


# ── engine presets (the 2026-06-29 lab+preset model: model+switches+params, the
# source of truth for what runs). Assigned by TASKKIND (TaskKindPreset), with
# TaskKindPreset[""] as the global default (2026-07-02: no per-feature override tier). ──
def _engine_preset_to_wire(p, switches, samplers) -> EnginePresetRow:
    return EnginePresetRow(
        id=p.id, name=p.name, providerId=p.provider_id, model=p.model,
        temperature=p.temperature, topP=p.top_p, maxTokens=p.max_tokens,
        jsonMode=p.json_mode, reasoningEffort=p.reasoning_effort,
        nglOverride=p.ngl_override, nCpuMoeOverride=p.n_cpu_moe_override,
        switches=[PresetFlagRow(flagName=x.flag_name, flagValue=x.flag_value) for x in switches],
        samplers=[PresetFlagRow(flagName=x.param_name, flagValue=x.value) for x in samplers],
        builtIn=p.built_in, position=p.position,
    )


def _delete_engine_preset_rows(s, ids) -> None:
    """Delete engine presets + their FK children (switches/samplers) explicitly, in
    the given session. Host-agnostic — does NOT rely on SQLite ON DELETE CASCADE (the
    runner's own reset path runs with FK enforcement off). ONE teardown path, shared by
    EnginePresetStore.delete + seed.restore_built_in_engine_presets."""
    ids = [i for i in ids if i]
    if not ids:
        return
    s.query(db.EnginePresetSwitch).filter(db.EnginePresetSwitch.preset_id.in_(ids)).delete(synchronize_session=False)
    s.query(db.EnginePresetSampler).filter(db.EnginePresetSampler.preset_id.in_(ids)).delete(synchronize_session=False)
    s.query(db.EnginePreset).filter(db.EnginePreset.id.in_(ids)).delete(synchronize_session=False)


class EnginePresetStore:
    def list(self) -> list[EnginePresetRow]:
        s = db.session()
        try:
            sw: dict[str, list] = {}
            for r in s.query(db.EnginePresetSwitch).all():
                sw.setdefault(r.preset_id, []).append(r)
            sm: dict[str, list] = {}
            for r in s.query(db.EnginePresetSampler).all():
                sm.setdefault(r.preset_id, []).append(r)
            return [
                _engine_preset_to_wire(
                    p,
                    sorted(sw.get(p.id, []), key=lambda x: x.flag_name),
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
            row.ngl_override = preset.nglOverride
            row.n_cpu_moe_override = preset.nCpuMoeOverride
            s.query(db.EnginePresetSwitch).filter(db.EnginePresetSwitch.preset_id == pid).delete()
            for x in preset.switches:
                if not (x.flagName or "").strip():
                    continue
                s.add(db.EnginePresetSwitch(preset_id=pid, flag_name=x.flagName.strip(), flag_value=x.flagValue or ""))
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
        return EngineConfig(
            pinnedBuild=cfg.llamacpp.pinned_build,
            safetyMarginMb=cfg.safety_margin_mb,
            modelsMax=cfg.models_max,
            sleepIdleSeconds=cfg.sleep_idle_seconds,
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
                             ("sleep_idle_seconds", str(DEFAULT_SLEEP_IDLE_SECONDS))):
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


def get_provider_store() -> ProviderStore: return _provider
def get_routing_store() -> RoutingStore: return _routing
def get_feature_preset_store() -> FeaturePresetStore: return _feature_preset
def get_prompt_store() -> PromptStore: return _prompt
def get_model_catalog_store() -> ModelCatalogStore: return _model_catalog
def get_pricing_store() -> PricingStore: return _pricing
def get_runner_config_store() -> RunnerConfigStore: return _runner_config
def get_switch_preset_store() -> SwitchPresetStore: return _switch_preset
def get_feature_sampler_store() -> FeatureSamplerStore: return _feature_sampler
def get_engine_preset_store() -> EnginePresetStore: return _engine_preset
def get_task_kind_preset_store() -> TaskKindPresetStore: return _task_kind_preset
def get_task_kind_store() -> TaskKindStore: return _task_kind
def get_feature_task_kind_store() -> FeatureTaskKindStore: return _feature_task_kind


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

        return RunnerConfig(
            llamacpp=LlamacppSpec(pinned_build=settings.get("pinned_build") or DEFAULT_PINNED_BUILD, binaries=bins),
            safety_margin_mb=_int("safety_margin_mb", DEFAULT_SAFETY_MARGIN_MB),
            models_max=_int("models_max", DEFAULT_MODELS_MAX),
            sleep_idle_seconds=_int("sleep_idle_seconds", DEFAULT_SLEEP_IDLE_SECONDS),
        )
    finally:
        s.close()
