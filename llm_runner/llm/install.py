# SPDX-License-Identifier: GPL-3.0-or-later
"""install_llm — drop the ENTIRE shared LLM stack into any FastAPI app with ONE
call. The app provides only its DB (engine + session factory) and its feature
seed DATA; install_llm creates the LLM tables, wires storage, mounts every
router, sets the DB usage sink, builds the dispatch config, and injects the
bundled-runner catalog. After this + a seed run, the app's LLM is fully working —
nothing else is per-app.

The app still mounts the runner-management router (`llm_runner.router`) itself
(that's the bundled llama.cpp process API, separate from the llm/ stack); this
only wires the runner's *catalog source* to the shared DB.
"""

from __future__ import annotations

from collections.abc import Iterable

from . import db, seed, stores
from .api import router as shared_api_router
from .config_builder import build_llm_config
from .feature_presets_api import make_feature_presets_router
from .jobs_api import make_feature_jobs_router, make_jobs_router
from .model_catalog_api import make_catalog_router, make_switches_router
from .prompts import make_feature_router, make_prompt_router
from .provider_api import make_provider_router
from .recommendations_api import make_recommendations_router
from .routing_api import make_routing_presets_router, make_routing_router
from .switch_presets_api import make_switch_presets_router
from .usage import set_ledger
from .usage_sink import DbUsageSink


def install_llm(
    app,
    *,
    engine,
    session_factory,
    feature_catalog,
    feature_prompts,
    feature_jobs,
    prefer_local_features: Iterable[str] | None = None,
    runner_catalog: bool = True,
) -> None:
    """Wire + mount the whole shared LLM stack onto `app`. Idempotent table create."""
    # 1. storage — the app's own engine/session back every shared table.
    db.configure_storage(session_factory)
    db.create_all(engine)
    # 2. register the app's feature DATA (the ONLY per-app inputs).
    seed.configure_app_seed(
        feature_catalog=feature_catalog, feature_jobs=feature_jobs, feature_prompts=feature_prompts
    )
    # 3. DB-backed usage ledger (survives restarts).
    set_ledger(DbUsageSink())
    # 4. the dispatch-config builder for the feature-execution router.
    plf = set(prefer_local_features or ())

    def _config():
        return build_llm_config(plf)

    # 5. mount every LLM router (the same surface in every app).
    app.include_router(shared_api_router)
    app.include_router(make_provider_router(stores.get_provider_store))
    app.include_router(make_prompt_router(stores.get_prompt_store, feature_prompts))
    app.include_router(make_feature_router(stores.get_prompt_store, _config))
    app.include_router(make_routing_router(stores.get_routing_store, seed.app_feature_catalog))
    app.include_router(make_routing_presets_router(stores.get_routing_preset_store, stores.get_routing_store))
    app.include_router(make_feature_presets_router(stores.get_feature_preset_store))
    app.include_router(make_recommendations_router(stores.get_recommendation_store))
    app.include_router(make_catalog_router(stores.get_model_catalog_store))
    app.include_router(make_switches_router(stores.get_model_switch_store))
    app.include_router(make_switch_presets_router(stores.get_switch_preset_store))
    app.include_router(make_jobs_router(stores.get_job_store))
    app.include_router(make_feature_jobs_router(stores.get_feature_job_store))
    # 6. point the bundled runner's catalog/switches at the shared DB.
    if runner_catalog:
        _wire_runner_catalog()


def _wire_runner_catalog() -> None:
    """The bundled llama.cpp runner reads its downloadable-model catalog + per-model
    switches from the shared DB (replacing its manifest fallback)."""
    from ..runner.lifecycle import configure_service
    from ..runner.schema import ModelEntry, RecommendedFor

    def catalog_fn():
        return [
            ModelEntry(
                id=r.id, name=r.name, tier=r.tier, hf_repo=r.hfRepo, quant=r.quant, mmproj=r.mmproj,
                total_params=r.totalParams or None, active_params=r.activeParams or None, mtp=r.mtp,
                min_ram_mb=r.minRamMb, recommended_for=RecommendedFor(min_vram_mb=r.minVramMb),
            )
            for r in stores.get_model_catalog_store().list()
        ]

    def switches_fn(model_id: str):
        # Layered model-level resolution (base preset → type → mtp → per-model →
        # per-hardware), returned as a flag→value dict that flows through the
        # runner's existing Override path. Replaces the flat per-model lookup so
        # the MoE/MTP rules come from the type presets, not per-model copies (§6.5).
        from .switch_resolve import resolve_model_switches

        return resolve_model_switches(model_id)

    configure_service(catalog_fn=catalog_fn, switches_fn=switches_fn)
