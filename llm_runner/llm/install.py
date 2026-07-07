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
from pathlib import Path

from . import db, seed, stores, switch_resolve
from .api import router as shared_api_router
from .config_builder import build_llm_config
from .feature_presets_api import make_feature_presets_router
from .feature_samplers_api import make_feature_samplers_router
from .presets_api import make_presets_router
from .knob_catalog_api import make_knob_catalog_router
from .model_catalog_api import make_catalog_router
from .model_tunes_api import make_model_tunes_router
from .pricing_api import make_pricing_router
from .runner_config_api import make_runner_config_router
from .prompts import make_feature_router, make_prompt_router
from .provider_api import make_provider_router
from .routing_api import make_routing_router
from .switch_presets_api import make_switch_presets_router
from .task_kinds_api import make_task_kinds_router
from .usage import set_ledger
from .usage_sink import DbUsageSink


def _current_hw_key() -> str:
    """The memoized whole-machine tuning key (gpu|vram|cores|ramGB) the
    `hardware_switches` + `model_tunes` layers are stored under (Plan B, D2).
    Lazy import — hardware detection lives runner-side."""
    from ..runner.hardware import current_machine_key

    return current_machine_key()


def _current_class_key() -> str:
    """The memoized coarse hardware-CLASS key (`vram<GB>|ram<GB>`) the seeded/editable
    `class_tunes` layer is matched on (2026-07-07). Lazy import, runner-side detect."""
    from ..runner.hardware import current_class_key

    return current_class_key()


def install_llm(
    app,
    *,
    engine,
    session_factory,
    feature_catalog,
    feature_prompts,
    engine_presets=None,
    taskkind_presets=None,
    feature_task_kinds=None,
    model_catalog_extra=None,
    model_tunes_seed=None,
    prefer_local_features: Iterable[str] | None = None,
    runner_catalog: bool = True,
    data_dir=None,
) -> None:
    """Wire + mount the whole shared LLM stack onto `app`. Idempotent table create."""
    # 1. storage — the app's own engine/session back every shared table.
    db.configure_storage(session_factory)
    db.create_all(engine)
    # 2. register the app's feature DATA (the ONLY per-app inputs): the feature
    # catalog + prompts, plus the routing seed — the built-in engine presets, the
    # taskKind→preset assignments, and the action→taskKind map (all optional; an
    # app that passes none simply seeds no presets → legacy routing).
    seed.configure_app_seed(
        feature_catalog=feature_catalog, feature_prompts=feature_prompts,
        engine_presets=engine_presets, taskkind_presets=taskkind_presets,
        feature_task_kinds=feature_task_kinds,
        model_catalog_extra=model_catalog_extra,
        model_tunes_seed=model_tunes_seed,
        hw_key_fn=_current_hw_key,
    )
    # 2b. per-APP extra model-catalog rows + this box's tune seed now ride the
    # configure_app_seed REGISTRATION above: `seed_llm` seeds them on BOTH paths
    # (boot AND the data-reset endpoint) — the one reseed entrypoint, no drift.
    # The immediate seeding below keeps the boot-order guarantee (rows exist the
    # moment the routers mount, before the host's own seed_llm call runs).
    if model_catalog_extra or model_tunes_seed:
        _s = session_factory()
        try:
            if model_catalog_extra:
                seed.seed_extra_catalog(_s, model_catalog_extra)
            if model_tunes_seed:
                seed.seed_model_tunes_if_missing(_s, _current_hw_key(), model_tunes_seed)
            _s.commit()
        finally:
            _s.close()
    # 3. DB-backed usage ledger (survives restarts).
    set_ledger(DbUsageSink())
    # 4. the dispatch-config builder for the feature-execution router.
    plf = set(prefer_local_features or ())

    def _config():
        return build_llm_config(plf)

    def _task_kind_of(key: str) -> str:
        """An action id (or feature key) → its LLM-work taskKind, for the preset
        cascade at dispatch. Resolution order: the user-editable feature→task DB row
        (a UI reassignment wins) → the app's in-memory seed map (so routing stays
        correct even if the DB seed is empty — JW swallows seed errors) → the
        `writerAI.rule.*→prose.edit` prefix → "" (→ the global default preset). The nav
        `group` is deliberately NOT consulted — routing keys on taskKind (D1)."""
        row = stores.get_feature_task_kind_store().list().get(key)
        if row:
            return row
        work = seed.app_feature_task_kinds()
        if key in work:
            return work[key]
        if key.startswith("writerAI.rule."):
            return "prose.edit"
        return ""

    # 5. mount every LLM router (the same surface in every app).
    app.include_router(shared_api_router)
    app.include_router(make_provider_router(stores.get_provider_store))
    app.include_router(make_prompt_router(stores.get_prompt_store, feature_prompts))
    app.include_router(make_feature_router(stores.get_prompt_store, _config, task_kind_of=_task_kind_of))
    app.include_router(make_task_kinds_router(
        stores.get_task_kind_store, stores.get_feature_task_kind_store,
        stores.get_prompt_store, task_kind_of=_task_kind_of,
        reset_fn=seed.reset_routing_to_factory,
        reset_task_fn=seed.reset_task_to_factory,
    ))
    app.include_router(make_routing_router(stores.get_routing_store, seed.app_feature_catalog))
    app.include_router(make_feature_presets_router(stores.get_feature_preset_store))
    app.include_router(make_presets_router(
        stores.get_engine_preset_store, stores.get_task_kind_preset_store,
        lambda: stores.get_task_kind_preset_store().list().get("", ""),
        lambda pid: stores.get_task_kind_preset_store().set("", pid),
    ))
    app.include_router(make_knob_catalog_router(stores.list_knob_catalog))

    def _inspect_model_from_link(repo: str, quant: str, revision: str = "main") -> dict:
        # Pre-download GGUF inspect for the Add-a-model form (reads the header over the
        # HF link, no weights). Lazy import: identity pulls in the runner remote fetcher.
        from .identity import inspect_model_from_link

        return inspect_model_from_link(repo, quant, revision)

    def _list_repo_files(repo: str, revision: str = "main") -> dict:
        # The Add/Edit form's quant dropdown + MTP-draft detection: ONE HF tree
        # call, classified runner-side (Plan B D9). Lazy import, same pattern.
        from ..runner.models import list_repo_ggufs

        return list_repo_ggufs(repo, revision)

    app.include_router(make_catalog_router(
        stores.get_model_catalog_store,
        class_picks_fn=stores.list_class_picks,
        # Keyed to THIS machine so resolved-defaults (what the Tune modal + Lab
        # pre-fill from) shows the SAME truth the load path uses — including the
        # hardware + per-(model, machine) tune layers (Plan B, D4; seen = run).
        resolve_switches=lambda mid: switch_resolve.resolve_model_switches(mid, _current_hw_key(), _current_class_key()),
        inspect_fn=_inspect_model_from_link,
        list_files_fn=_list_repo_files,
    ))
    app.include_router(make_pricing_router(stores.get_pricing_store))
    app.include_router(make_runner_config_router(stores.get_runner_config_store))
    app.include_router(make_switch_presets_router(stores.get_switch_preset_store))
    app.include_router(make_model_tunes_router(stores.get_model_tune_store, _current_hw_key))
    app.include_router(make_feature_samplers_router(stores.get_feature_sampler_store))

    # Auto-tune (2026-07-06): the runner drives the measured sweep; the llm layer
    # supplies switch resolution + tune persistence via the same DI seam as the
    # catalog router. `save_tune` writes the winner VERBATIM as this machine's
    # tune (identical semantics to the Tune modal's Save — the QuickSetup
    # save-on-done path rides it).
    def _save_tune(model_id: str, switches: dict) -> None:
        from .model_tunes_api import ModelTuneFlag

        rows = [ModelTuneFlag(flagName=k, flagValue=str(v)) for k, v in sorted(switches.items())]
        stores.get_model_tune_store().replace(model_id, _current_hw_key(), rows)

    from ..runner.autotune import make_autotune_router

    app.include_router(make_autotune_router(
        lambda mid: switch_resolve.resolve_model_switches(mid, _current_hw_key(), _current_class_key()),
        _save_tune,
    ))
    # 6. point the bundled runner's catalog/switches at the shared DB.
    if runner_catalog:
        _wire_runner_catalog(data_dir)


def _wire_runner_catalog(data_dir=None) -> None:
    """The bundled llama.cpp runner reads its downloadable-model catalog, per-model
    switches, AND its load config (llama.cpp binaries + VRAM margin) from the
    shared DB — fully replacing runner-manifest.json (A7). When the host passes a
    `data_dir`, the runner's engine + model cache lives under `<data_dir>/ai-cache`
    so all app data shares one portable root; None → the runner default (~/.cache)."""
    from ..runner.lifecycle import configure_service
    from ..runner.schema import ModelEntry, RecommendedFor

    def catalog_fn():
        return [
            ModelEntry(
                id=r.id, name=r.name, tier=r.tier, hf_repo=r.hfRepo, quant=r.quant, mmproj=r.mmproj,
                total_params=r.totalParams or None, active_params=r.activeParams or None, mtp=r.mtp,
                mtp_draft_repo=r.mtpDraftRepo, mtp_draft_file=r.mtpDraftFile, mtp_draft_quant=r.mtpDraftQuant,
                pooling=r.pooling, min_ram_mb=r.minRamMb, recommended_for=RecommendedFor(min_vram_mb=r.minVramMb),
            )
            for r in stores.get_model_catalog_store().list()
        ]

    def embedding_ids_fn() -> set[str]:
        # The catalog id the routing default points at the bundled runner as the embedding provider
        # — the runner marks that `.ini` section `embeddings = true` (so llama-server exposes
        # /v1/embeddings on that child) and PINS it resident (P3, the co-resident embed). Empty when
        # the embedding provider is Ollama/cloud (default_embedding_id != "local-llamacpp") or none is
        # set → the runner keeps no embed pinned. The id == the catalog id == the `.ini` section id
        # clients request — this equality is what routes the embed; the future embed picker
        # (#107/#108) must preserve it.
        d = stores.get_routing_store().get_routing().default
        if d.embeddingId == "local-llamacpp" and d.embeddingModel:
            return {d.embeddingModel}
        return set()

    def switches_fn(model_id: str):
        # Layered model-level resolution (base → type(moe|dense) → gated auto-mtp →
        # per-hardware → per-(model, machine) tune), keyed to THIS machine — the
        # Plan-B wire (D4) that also activates the formerly-DORMANT hardware layer
        # (hw_key was never passed before 2026-07-05). Returned as a flag→value
        # dict that flows through the runner's existing Override path.
        from .switch_resolve import resolve_model_switches

        return resolve_model_switches(model_id, _current_hw_key(), _current_class_key())

    def identify_fn(model_id: str, gguf_path):
        # After a model downloads, read its GGUF header → set model_catalog
        # type/mtp/trained_ctx + the recommended sampler baseline from the file
        # (the GGUF-grounded model layer, Phase 2), so a user-added model's catalog
        # facts are grounded in the file, not a hand-typed guess. Samplers fall back
        # to the origin repo's generation_config.json when the GGUF carries none.
        from ..runner.gguf_remote import fetch_generation_config_samplers
        from .identity import detect_and_store_model_type

        detect_and_store_model_type(
            model_id, gguf_path,
            samplers_fallback=lambda meta: fetch_generation_config_samplers(meta.base_repo_url),
        )

    configure_service(
        catalog_fn=catalog_fn, switches_fn=switches_fn,
        identify_fn=identify_fn, embedding_ids_fn=embedding_ids_fn,
        config_fn=stores.build_runner_config,
        cache_root=(str(Path(data_dir) / "ai-cache") if data_dir else None),
    )
