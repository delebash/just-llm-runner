# SPDX-License-Identifier: GPL-3.0-or-later
"""The concrete LLM stores — ONE shared implementation of every storage Protocol
(provider / routing / routing-presets / feature-presets / prompts / recommendations
/ model-catalog / model-switches / jobs / feature-jobs) over the shared session
(`db.session`). Replaces every per-app `*_store.py`: an app installs the shared
LLM stack and gets these — it does not implement storage.

Each store opens a short-lived session per call (the routers call these outside a
request's session). `reset_to_factory` restores factory rows for shipped keys and
preserves user-added rows (lazy-imports the shared `seed` to avoid an import cycle).
"""

from __future__ import annotations

import uuid

from . import db
from .feature_presets_api import FeaturePreset
from .jobs_api import FeatureJobRow, JobRow
from .model_catalog_api import CatalogRow, SwitchRow
from .prompts import FeaturePromptRow
from .switch_presets_api import PresetSwitchRow, SwitchPresetRow
from .recommendations_api import RecommendationRow
from .routing_api import FeaturePin, JobTarget, RoutingConfig, RoutingDefaults, RoutingPreset
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


# ── routing (default + per-job routes + explicit pins) ────────────────────────
def _row_to_routing(s, row: db.RoutingConfigRow) -> RoutingConfig:
    pins = {
        p.feature: FeaturePin(providerId=p.provider_id, model=p.model)
        for p in s.query(db.RoutingPin).filter(db.RoutingPin.config_id == row.id).all()
    }
    jobs = {
        jr.job_id: JobTarget(providerId=jr.provider_id, model=jr.model)
        for jr in s.query(db.JobRoute).filter(db.JobRoute.config_id == row.id).all()
    }
    return RoutingConfig(
        default=RoutingDefaults(
            llmId=row.default_llm_id, model=row.default_model,
            embeddingId=row.default_embedding_id, embeddingModel=row.default_embedding_model,
        ),
        jobs=jobs, pins=pins,
    )


def _apply_routing(s, row: db.RoutingConfigRow, cfg: RoutingConfig) -> None:
    row.default_llm_id = cfg.default.llmId
    row.default_model = cfg.default.model
    row.default_embedding_id = cfg.default.embeddingId
    row.default_embedding_model = cfg.default.embeddingModel
    # Persist the (possibly new) config row before inserting its FK children
    # (job_routes / routing_pins) — the host session has autoflush off + FK on.
    s.add(row)
    s.flush()
    s.query(db.RoutingPin).filter(db.RoutingPin.config_id == row.id).delete()
    for feature, p in cfg.pins.items():
        if p.providerId:  # explicit pin only — inherit-the-job is no row
            s.add(db.RoutingPin(config_id=row.id, feature=feature, provider_id=p.providerId, model=p.model))
    s.query(db.JobRoute).filter(db.JobRoute.config_id == row.id).delete()
    for job_id, t in cfg.jobs.items():
        if t.providerId:
            s.add(db.JobRoute(config_id=row.id, job_id=job_id, provider_id=t.providerId, model=t.model))


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


class RoutingPresetStore:
    def list_presets(self) -> list[RoutingPreset]:
        s = db.session()
        try:
            rows = (
                s.query(db.RoutingConfigRow)
                .filter(db.RoutingConfigRow.is_active.is_(False))
                .order_by(db.RoutingConfigRow.position)
                .all()
            )
            return [RoutingPreset(id=r.id, name=r.name, routing=_row_to_routing(s, r)) for r in rows]
        finally:
            s.close()

    def save_preset(self, preset: RoutingPreset) -> None:
        s = db.session()
        try:
            row = s.get(db.RoutingConfigRow, preset.id) if preset.id else None
            if row is None or row.is_active:
                pos = s.query(db.RoutingConfigRow).filter(db.RoutingConfigRow.is_active.is_(False)).count()
                row = db.RoutingConfigRow(id=preset.id or uuid.uuid4().hex[:12], is_active=False, position=pos)
                s.add(row)
            row.name = preset.name
            _apply_routing(s, row, preset.routing)
            s.commit()
        finally:
            s.close()

    def delete_preset(self, preset_id: str) -> None:
        s = db.session()
        try:
            row = s.get(db.RoutingConfigRow, preset_id)
            if row is not None and not row.is_active:
                s.query(db.RoutingPin).filter(db.RoutingPin.config_id == preset_id).delete()
                s.query(db.JobRoute).filter(db.JobRoute.config_id == preset_id).delete()
                s.delete(row)
                s.commit()
        finally:
            s.close()


# ── feature presets (Feature Workbench) ───────────────────────────────────────
def _preset_to_wire(r: db.FeaturePreset) -> FeaturePreset:
    return FeaturePreset(
        id=r.id, action=r.action, name=r.name, active=r.is_active,
        providerId=r.provider_id, model=r.model, system=r.system,
        userTemplate=r.user_template, temperature=r.temperature, think=r.think,
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
        max_tokens=r.max_tokens, label=r.label, description=r.description, group=r.subgroup,
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
                    max_tokens=row.max_tokens, label=row.label, description=row.description, subgroup=row.group,
                ))
            else:
                existing.feature = row.feature
                existing.system = row.system
                existing.user_template = row.user_template
                existing.temperature = row.temperature
                existing.think = row.think
                existing.max_tokens = row.max_tokens
                existing.label = row.label
                existing.description = row.description
                existing.subgroup = row.group
            s.commit()
        finally:
            s.close()


# ── recommendations ───────────────────────────────────────────────────────────
def _rec_to_wire(r: db.ModelRecommendation) -> RecommendationRow:
    return RecommendationRow(modelId=r.model_id, job=r.job, rank=r.rank, why=r.why, builtIn=r.built_in)


class RecommendationStore:
    def list(self) -> list[RecommendationRow]:
        s = db.session()
        try:
            rows = s.query(db.ModelRecommendation).order_by(
                db.ModelRecommendation.job, db.ModelRecommendation.rank, db.ModelRecommendation.model_id).all()
            return [_rec_to_wire(r) for r in rows]
        finally:
            s.close()

    def upsert(self, row: RecommendationRow) -> RecommendationRow:
        s = db.session()
        try:
            existing = s.get(db.ModelRecommendation, (row.modelId, row.job))
            if existing is None:
                existing = db.ModelRecommendation(model_id=row.modelId, job=row.job)
                s.add(existing)
            existing.rank = row.rank
            existing.why = row.why
            existing.built_in = False
            s.commit()
            return _rec_to_wire(existing)
        finally:
            s.close()

    def delete(self, model_id: str, job: str) -> None:
        s = db.session()
        try:
            existing = s.get(db.ModelRecommendation, (model_id, job))
            if existing is not None:
                s.delete(existing)
                s.commit()
        finally:
            s.close()

    def reset_to_factory(self) -> None:
        from . import seed
        s = db.session()
        try:
            for mid, job in {(r["model_id"], r["job"]) for r in seed.DEFAULT_RECOMMENDATIONS}:
                row = s.get(db.ModelRecommendation, (mid, job))
                if row is not None:
                    s.delete(row)
            s.flush()
            seed.seed_default_recommendations(s)
            s.commit()
        finally:
            s.close()


# ── model catalog + switches ──────────────────────────────────────────────────
def _catalog_to_wire(r: db.ModelCatalog) -> CatalogRow:
    return CatalogRow(
        id=r.id, name=r.name, hfRepo=r.hf_repo, quant=r.quant, mmproj=r.mmproj,
        totalParams=r.total_params, activeParams=r.active_params, mtp=r.mtp, type=r.type,
        minVramMb=r.min_vram_mb, minRamMb=r.min_ram_mb, tier=r.tier,
        position=r.position, builtIn=r.built_in,
    )


def _switch_to_wire(r: db.ModelSwitch) -> SwitchRow:
    return SwitchRow(modelId=r.model_id, flagName=r.flag_name, flagValue=r.flag_value, builtIn=r.built_in)


class ModelCatalogStore:
    def list(self) -> list[CatalogRow]:
        s = db.session()
        try:
            return [_catalog_to_wire(r) for r in s.query(db.ModelCatalog).order_by(db.ModelCatalog.position, db.ModelCatalog.id).all()]
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
            existing.min_vram_mb = row.minVramMb
            existing.min_ram_mb = row.minRamMb
            existing.tier = row.tier or "mid"
            existing.position = row.position
            existing.built_in = False
            s.commit()
            return _catalog_to_wire(existing)
        finally:
            s.close()

    def delete(self, model_id: str) -> None:
        s = db.session()
        try:
            existing = s.get(db.ModelCatalog, model_id)
            if existing is not None:
                s.delete(existing)
                s.commit()
        finally:
            s.close()

    def reset_to_factory(self) -> None:
        from . import seed
        s = db.session()
        try:
            for cid in {c["id"] for c in seed.DEFAULT_CATALOG}:
                row = s.get(db.ModelCatalog, cid)
                if row is not None:
                    s.delete(row)
            s.flush()
            seed.seed_default_catalog(s)
            s.commit()
        finally:
            s.close()


class ModelSwitchStore:
    def list(self) -> list[SwitchRow]:
        s = db.session()
        try:
            return [_switch_to_wire(r) for r in s.query(db.ModelSwitch).order_by(db.ModelSwitch.model_id, db.ModelSwitch.flag_name).all()]
        finally:
            s.close()

    def upsert(self, row: SwitchRow) -> SwitchRow:
        s = db.session()
        try:
            existing = s.get(db.ModelSwitch, (row.modelId, row.flagName))
            if existing is None:
                existing = db.ModelSwitch(model_id=row.modelId, flag_name=row.flagName)
                s.add(existing)
            existing.flag_value = row.flagValue
            existing.built_in = False
            s.commit()
            return _switch_to_wire(existing)
        finally:
            s.close()

    def delete(self, model_id: str, flag_name: str) -> None:
        s = db.session()
        try:
            existing = s.get(db.ModelSwitch, (model_id, flag_name))
            if existing is not None:
                s.delete(existing)
                s.commit()
        finally:
            s.close()

    def reset_to_factory(self) -> None:
        from . import seed
        s = db.session()
        try:
            for mid, fname in {(x["model_id"], x["flag_name"]) for x in seed.DEFAULT_SWITCHES}:
                row = s.get(db.ModelSwitch, (mid, fname))
                if row is not None:
                    s.delete(row)
            s.flush()
            seed.seed_default_switches(s)
            s.commit()
        finally:
            s.close()


# ── capability/type switch presets (base/moe/mtp) ─────────────────────────────
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


# ── jobs + feature→job map ────────────────────────────────────────────────────
def _job_to_wire(r: db.Job) -> JobRow:
    return JobRow(id=r.id, label=r.label, description=r.description, position=r.position, builtIn=r.built_in)


def _feature_job_to_wire(r: db.FeatureJob) -> FeatureJobRow:
    return FeatureJobRow(featureKey=r.feature_key, jobId=r.job_id, builtIn=r.built_in)


class JobStore:
    def list(self) -> list[JobRow]:
        s = db.session()
        try:
            return [_job_to_wire(r) for r in s.query(db.Job).order_by(db.Job.position, db.Job.id).all()]
        finally:
            s.close()

    def upsert(self, row: JobRow) -> JobRow:
        s = db.session()
        try:
            existing = s.get(db.Job, row.id)
            if existing is None:
                existing = db.Job(id=row.id)
                s.add(existing)
            existing.label = row.label
            existing.description = row.description
            existing.position = row.position
            existing.built_in = row.builtIn
            s.commit()
            return _job_to_wire(existing)
        finally:
            s.close()

    def delete(self, job_id: str) -> None:
        s = db.session()
        try:
            existing = s.get(db.Job, job_id)
            if existing is not None:
                s.delete(existing)
                s.commit()
        finally:
            s.close()

    def reset_to_factory(self) -> None:
        from . import seed
        s = db.session()
        try:
            for j in seed.DEFAULT_JOBS:
                row = s.get(db.Job, j["id"])
                if row is not None:
                    s.delete(row)
            s.flush()
            seed.seed_default_jobs(s)
            s.commit()
        finally:
            s.close()


class FeatureJobStore:
    def list(self) -> list[FeatureJobRow]:
        s = db.session()
        try:
            return [_feature_job_to_wire(r) for r in s.query(db.FeatureJob).order_by(db.FeatureJob.feature_key).all()]
        finally:
            s.close()

    def upsert(self, row: FeatureJobRow) -> FeatureJobRow:
        s = db.session()
        try:
            existing = s.get(db.FeatureJob, row.featureKey)
            if existing is None:
                existing = db.FeatureJob(feature_key=row.featureKey)
                s.add(existing)
            existing.job_id = row.jobId
            existing.built_in = False
            s.commit()
            return _feature_job_to_wire(existing)
        finally:
            s.close()

    def delete(self, feature_key: str) -> None:
        s = db.session()
        try:
            existing = s.get(db.FeatureJob, feature_key)
            if existing is not None:
                s.delete(existing)
                s.commit()
        finally:
            s.close()

    def reset_to_factory(self) -> None:
        from . import seed
        s = db.session()
        try:
            for fj in seed.app_feature_jobs():
                row = s.get(db.FeatureJob, fj["feature_key"])
                if row is not None:
                    s.delete(row)
            s.flush()
            seed.seed_default_feature_jobs(s)
            s.commit()
        finally:
            s.close()


# ── singletons (the routers take a getter; one instance each) ─────────────────
_provider = ProviderStore()
_routing = RoutingStore()
_routing_preset = RoutingPresetStore()
_feature_preset = FeaturePresetStore()
_prompt = PromptStore()
_recommendation = RecommendationStore()
_model_catalog = ModelCatalogStore()
_model_switch = ModelSwitchStore()
_switch_preset = SwitchPresetStore()
_job = JobStore()
_feature_job = FeatureJobStore()


def get_provider_store() -> ProviderStore: return _provider
def get_routing_store() -> RoutingStore: return _routing
def get_routing_preset_store() -> RoutingPresetStore: return _routing_preset
def get_feature_preset_store() -> FeaturePresetStore: return _feature_preset
def get_prompt_store() -> PromptStore: return _prompt
def get_recommendation_store() -> RecommendationStore: return _recommendation
def get_model_catalog_store() -> ModelCatalogStore: return _model_catalog
def get_model_switch_store() -> ModelSwitchStore: return _model_switch
def get_switch_preset_store() -> SwitchPresetStore: return _switch_preset
def get_job_store() -> JobStore: return _job
def get_feature_job_store() -> FeatureJobStore: return _feature_job
