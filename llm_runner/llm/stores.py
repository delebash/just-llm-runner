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
from .feature_samplers_api import FeatureSamplerRow
from .job_presets_api import JobPreset, JobPresetSwitchRow
from .job_switches_api import JobSwitchRow
from .jobs_api import FeatureJobRow, JobRow
from .model_catalog_api import CatalogRow
from .pricing_api import PricingRow
from .runner_config_api import EngineConfig, RunnerBinaryRow
from .prompts import FeaturePromptRow
from .switch_presets_api import PresetSwitchRow, SwitchPresetRow
from .presets_api import EnginePresetRow, PresetFlagRow
from .recommendations_api import RecommendationRow
from .routing_api import FeaturePin, JobTarget, RoutingConfig, RoutingDefaults
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
        jr.job_id: JobTarget(providerId=jr.provider_id, model=jr.model, quality=jr.quality or "")
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
            s.add(db.JobRoute(config_id=row.id, job_id=job_id, provider_id=t.providerId,
                              model=t.model, quality=t.quality or ""))


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
        minVramMb=r.min_vram_mb, minRamMb=r.min_ram_mb, tier=r.tier, license=r.license,
        useLimited=r.use_limited, position=r.position, builtIn=r.built_in,
    )


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
            existing.license = row.license or ""
            existing.use_limited = bool(row.useLimited)
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


class JobRouteSwitchStore:
    """Per-Profile (job-route) engine switches — read at load by
    `resolve_profile_switches`, written by the lab via `make_job_switches_router`."""

    def list(self, config_id: str, job_id: str) -> list[JobSwitchRow]:
        s = db.session()
        try:
            return [
                JobSwitchRow(flagName=r.flag_name, flagValue=r.flag_value, builtIn=r.built_in)
                for r in s.query(db.JobRouteSwitch)
                .filter(db.JobRouteSwitch.config_id == config_id, db.JobRouteSwitch.job_id == job_id)
                .order_by(db.JobRouteSwitch.flag_name)
                .all()
            ]
        finally:
            s.close()

    def replace(
        self, config_id: str, job_id: str, switches: list[JobSwitchRow]
    ) -> list[JobSwitchRow]:
        """Replace the whole switch set for a (config, job). The lab sends every
        row; empty-named rows are dropped. Requires the parent `job_routes` row to
        exist (the Profile's model is set first)."""
        s = db.session()
        try:
            s.query(db.JobRouteSwitch).filter(
                db.JobRouteSwitch.config_id == config_id, db.JobRouteSwitch.job_id == job_id
            ).delete()
            for sw in switches:
                if not (sw.flagName or "").strip():
                    continue
                s.add(db.JobRouteSwitch(
                    config_id=config_id, job_id=job_id,
                    flag_name=sw.flagName, flag_value=sw.flagValue or "", built_in=False,
                ))
            s.commit()
        finally:
            s.close()
        return self.list(config_id, job_id)


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
def _job_preset_to_wire(s, r) -> JobPreset:
    switches = [
        JobPresetSwitchRow(flagName=sw.flag_name, flagValue=sw.flag_value)
        for sw in s.query(db.JobPresetSwitch)
        .filter(db.JobPresetSwitch.preset_id == r.id)
        .order_by(db.JobPresetSwitch.flag_name)
        .all()
    ]
    return JobPreset(
        id=r.id, jobId=r.job_id, name=r.name, providerId=r.provider_id, model=r.model,
        switches=switches, builtIn=r.built_in,
    )


class JobPresetStore:
    """Named saved (job + model + switches) configs; `promote` applies one to the
    live job route + its job_route_switches."""

    def list_presets(self) -> list[JobPreset]:
        s = db.session()
        try:
            rows = s.query(db.JobPreset).order_by(db.JobPreset.job_id, db.JobPreset.position, db.JobPreset.id).all()
            return [_job_preset_to_wire(s, r) for r in rows]
        finally:
            s.close()

    def save_preset(self, preset: JobPreset) -> JobPreset:
        s = db.session()
        try:
            pid = preset.id or uuid.uuid4().hex[:12]
            row = s.get(db.JobPreset, pid)
            if row is None:
                pos = s.query(db.JobPreset).filter(db.JobPreset.job_id == preset.jobId).count()
                row = db.JobPreset(id=pid, position=pos)
                s.add(row)
            row.job_id = preset.jobId
            row.name = preset.name
            row.provider_id = preset.providerId
            row.model = preset.model
            row.built_in = False
            s.flush()  # parent before its FK switch children
            s.query(db.JobPresetSwitch).filter(db.JobPresetSwitch.preset_id == pid).delete()
            for sw in preset.switches:
                if (sw.flagName or "").strip():
                    s.add(db.JobPresetSwitch(preset_id=pid, flag_name=sw.flagName.strip(), flag_value=sw.flagValue or ""))
            s.commit()
            return _job_preset_to_wire(s, row)
        finally:
            s.close()

    def delete_preset(self, preset_id: str) -> None:
        s = db.session()
        try:
            row = s.get(db.JobPreset, preset_id)
            if row is not None:
                s.delete(row)
                s.commit()
        finally:
            s.close()

    def promote(self, preset_id: str) -> None:
        """Write the preset's model into the live `job_routes` row + replace that
        job's `job_route_switches` with the preset's switches."""
        s = db.session()
        try:
            p = s.get(db.JobPreset, preset_id)
            if p is None:
                return
            row = s.get(db.RoutingConfigRow, _ACTIVE_ID)
            if row is None:
                row = db.RoutingConfigRow(id=_ACTIVE_ID, is_active=True, position=0)
                s.add(row)
                s.flush()
            jr = s.get(db.JobRoute, (_ACTIVE_ID, p.job_id))
            if jr is None:
                jr = db.JobRoute(config_id=_ACTIVE_ID, job_id=p.job_id)
                s.add(jr)
            jr.provider_id = p.provider_id
            jr.model = p.model
            jr.quality = ""  # an explicit promoted model — the dial isn't driving it
            s.flush()
            s.query(db.JobRouteSwitch).filter(
                db.JobRouteSwitch.config_id == _ACTIVE_ID, db.JobRouteSwitch.job_id == p.job_id
            ).delete()
            for sw in s.query(db.JobPresetSwitch).filter(db.JobPresetSwitch.preset_id == preset_id).all():
                s.add(db.JobRouteSwitch(config_id=_ACTIVE_ID, job_id=p.job_id,
                                        flag_name=sw.flag_name, flag_value=sw.flag_value))
            s.commit()
        finally:
            s.close()


# ── engine presets (the 2026-06-29 lab+preset model: model+switches+params, the
# source of truth for what runs). Assigned by CATEGORY (CategoryPreset[""] = the
# global default) or a per-feature override (FeaturePresetRef). ──
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
            row = s.get(db.EnginePreset, preset_id)
            if row is not None:
                s.delete(row)
                s.commit()
        finally:
            s.close()


class CategoryPresetStore:
    def list(self) -> dict[str, str]:
        s = db.session()
        try:
            return {r.category: r.preset_id for r in s.query(db.CategoryPreset).all()}
        finally:
            s.close()

    def set(self, category: str, preset_id: str) -> None:
        s = db.session()
        try:
            row = s.get(db.CategoryPreset, category)
            if not preset_id:
                if row is not None:
                    s.delete(row)
            elif row is None:
                s.add(db.CategoryPreset(category=category, preset_id=preset_id))
            else:
                row.preset_id = preset_id
            s.commit()
        finally:
            s.close()


class FeaturePresetRefStore:
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
_job_preset = JobPresetStore()
_feature_preset = FeaturePresetStore()
_prompt = PromptStore()
_recommendation = RecommendationStore()
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
        """Restore the shipped binary rows (corrected URLs) + the two scalar
        settings to their seed defaults; user-added custom rows are preserved."""
        from ..runner.config import DEFAULT_BINARIES, DEFAULT_PINNED_BUILD, DEFAULT_SAFETY_MARGIN_MB
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
                             ("safety_margin_mb", str(DEFAULT_SAFETY_MARGIN_MB))):
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
_job = JobStore()
_feature_job = FeatureJobStore()
_job_route_switch = JobRouteSwitchStore()
_feature_sampler = FeatureSamplerStore()
_engine_preset = EnginePresetStore()
_category_preset = CategoryPresetStore()
_feature_preset_ref = FeaturePresetRefStore()


def get_provider_store() -> ProviderStore: return _provider
def get_routing_store() -> RoutingStore: return _routing
def get_job_preset_store() -> JobPresetStore: return _job_preset
def get_feature_preset_store() -> FeaturePresetStore: return _feature_preset
def get_prompt_store() -> PromptStore: return _prompt
def get_recommendation_store() -> RecommendationStore: return _recommendation
def get_model_catalog_store() -> ModelCatalogStore: return _model_catalog
def get_pricing_store() -> PricingStore: return _pricing
def get_runner_config_store() -> RunnerConfigStore: return _runner_config
def get_switch_preset_store() -> SwitchPresetStore: return _switch_preset
def get_job_store() -> JobStore: return _job
def get_feature_job_store() -> FeatureJobStore: return _feature_job
def get_job_route_switch_store() -> JobRouteSwitchStore: return _job_route_switch
def get_feature_sampler_store() -> FeatureSamplerStore: return _feature_sampler
def get_engine_preset_store() -> EnginePresetStore: return _engine_preset
def get_category_preset_store() -> CategoryPresetStore: return _category_preset
def get_feature_preset_ref_store() -> FeaturePresetRefStore: return _feature_preset_ref


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
    from ..runner.config import DEFAULT_PINNED_BUILD, DEFAULT_SAFETY_MARGIN_MB, default_config
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
        try:
            margin = int(settings.get("safety_margin_mb") or DEFAULT_SAFETY_MARGIN_MB)
        except (TypeError, ValueError):
            margin = DEFAULT_SAFETY_MARGIN_MB
        return RunnerConfig(
            llamacpp=LlamacppSpec(pinned_build=settings.get("pinned_build") or DEFAULT_PINNED_BUILD, binaries=bins),
            safety_margin_mb=margin,
        )
    finally:
        s.close()
