# SPDX-License-Identifier: MIT
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

import logging
import threading
from collections.abc import Iterable
from pathlib import Path

from . import db, seed, stores, switch_resolve
from .api import router as shared_api_router
from .api import set_embed_template_resolver, set_model_list_rules_resolver
from .embed_templates_api import make_embed_templates_router
from .model_list_rules_api import make_model_list_rules_router
from .config_builder import build_llm_config
from .presets_api import make_presets_router
from .cache_api import make_cache_router
from .knob_catalog_api import make_knob_catalog_router
from .model_catalog_api import make_catalog_router
from .class_tunes_api import make_class_tunes_router
from .test_samples_api import make_test_samples_router
from .model_measurements_api import make_model_measurements_router
from .model_tunes_api import make_model_tunes_router
from .pricing_api import make_pricing_router
from .reasoning_map_api import make_reasoning_map_router
from .runner_config_api import make_runner_config_router
from .prompts import make_feature_router, make_prompt_router
from .provider_api import make_provider_router
from .routing_api import make_routing_router
from .switch_presets_api import make_switch_presets_router
from .usage import set_ledger
from .usage_sink import DbUsageSink


def _current_hw_key() -> str:
    """The memoized whole-machine tuning key (gpu|vram|cores|ramGB) the
    `model_tunes` layer is stored under (Plan B, D2; the old `hardware_switches`
    layer was retired 2026-07-07 — no writer/UI ever existed).
    Lazy import — hardware detection lives runner-side."""
    from ..runner.hardware import current_machine_key

    return current_machine_key()


def _current_class_key() -> str:
    """The coarse hardware-CLASS key (`vram<GB>|ram<GB>`) the seeded/editable
    `class_tunes` layer is matched on (2026-07-07). The user's `class_key_override`
    setting wins over detection — "detection proposes, never dictates" (user ruling
    2026-07-22, after the ram0 sensor bug orphaned every class row): a wrong sensor
    must cost one setting, not a dead subsystem. "" = auto. This is THE choke point —
    every class-key consumer (resolve layers, class-tunes router, catalog response,
    tune badges) reads through it. Lazy import, runner-side detect."""
    from ..runner.hardware import current_class_key

    return stores.get_class_key_override() or current_class_key()


def _mount_llm_routers(app, *, feature_prompts, _config, allow_key_reveal: bool,
                       data_dir=None, product: str = "") -> None:
    """Every router the stack serves — the app-bound half of install_llm, split out
    (2026-08-02) so the HEADLESS boot (app=None) shares the storage/seed/wiring path
    without re-implementing it against private imports."""
    app.include_router(shared_api_router)
    # allow_key_reveal threads the host's opt-in to the key/reveal route (#12 C6): the
    # host must guard mutating /v1 with an origin check to enable it. JV mounts
    # make_provider_router directly with the safe default OFF; only JW (below) opts in.
    app.include_router(
        make_provider_router(stores.get_provider_store, allow_key_reveal=allow_key_reveal)
    )
    app.include_router(make_prompt_router(stores.get_prompt_store, feature_prompts))
    app.include_router(make_feature_router(stores.get_prompt_store, _config))
    app.include_router(make_routing_router(stores.get_routing_store, seed.app_feature_catalog))
    app.include_router(make_presets_router(
        stores.get_engine_preset_store,
        stores.get_default_preset_id,
        stores.set_default_preset_id,
        stores.get_feature_preset_ref_store,
        reset_all_fn=seed.reset_routing_to_factory,
        reset_one_fn=seed.reset_preset_to_factory,
    ))
    app.include_router(make_knob_catalog_router(stores.list_knob_catalog))
    app.include_router(make_test_samples_router(stores.get_test_sample_store))
    # Where the engine + models are cached — offered as a CHOICE because two family
    # apps kept the same 14 GB model twice (cache_api's docstring has the measurement).
    app.include_router(make_cache_router(data_dir, product))

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

    def _preview_fit(model_id: str) -> dict:
        # Fix 2 (2026-07-07): the fit-COMPUTED launch values (ngl / n_cpu_moe / ctx)
        # for a model the resolution layers don't pin — resolved-defaults surfaces
        # them so the Tune grid never shows an empty box where the launch has a real
        # value. Lazy import, runner-side service (same pattern as the inspect fn).
        from ..runner.lifecycle import get_service

        return get_service().preview_fit(model_id)

    def _stop_runner_best_effort() -> None:
        # Full runner teardown (unload every child + clear the VRAM ledger). Lazy import
        # + broad except: a reset must never fail because no runner is configured here.
        try:
            from ..runner.lifecycle import get_service

            get_service().stop()
        except Exception:  # noqa: BLE001
            logging.getLogger(__name__).warning("runner stop on reset failed", exc_info=True)

    app.include_router(make_catalog_router(
        stores.get_model_catalog_store,
        # §9 final ruled shape (2026-07-22): the catalog response carries the
        # (model, class) config pairs + THIS box's class — the recommendation IS
        # the visible class-config list; the hidden pick table is gone.
        class_tune_refs_fn=stores.list_class_tune_refs,
        class_key_fn=_current_class_key,
        # Keyed to THIS machine so resolved-defaults (what the Tune modal + Lab
        # pre-fill from) shows the SAME truth the load path uses — including the
        # hardware + per-(model, machine) tune layers (Plan B, D4; seen = run).
        resolve_switches=lambda mid: switch_resolve.resolve_model_switches(mid, _current_hw_key(), _current_class_key()),
        inspect_fn=_inspect_model_from_link,
        list_files_fn=_list_repo_files,
        preview_fit_fn=_preview_fit,
        # Provenance (2026-07-07): values + which-layer-wrote-each — the Tune
        # grid's per-row origin tags.
        resolve_origins=lambda mid: switch_resolve.resolve_model_switches_with_origins(
            mid, _current_hw_key(), _current_class_key()),
        # §7.6: the LAYER baseline (machine tune skipped — hw_key empty) for
        # resolved-defaults?excludeTune=1 → the modal's "Refresh from defaults".
        resolve_baseline_origins=lambda mid: switch_resolve.resolve_model_switches_with_origins(
            mid, "", _current_class_key()),
        # Reset = clean slate INCLUDING the runner (2026-07-11, user decision): unload
        # every resident model + clear the VRAM ledger, so nothing keeps running under
        # pre-reset rows/tunes while the UI claims the new config is active. Best-effort.
        on_reset=_stop_runner_best_effort,
    ))
    app.include_router(make_pricing_router(stores.get_pricing_store))
    app.include_router(make_reasoning_map_router(stores.get_reasoning_map_store))
    # Per-model embed task templates (Move 0, RAG build): CRUD + the resolver
    # seam /v1/ai/embeddings applies (api.py stays storage-free — the injected
    # closure is the set_ledger pattern).
    app.include_router(make_embed_templates_router(stores.get_embed_template_store))
    set_embed_template_resolver(lambda mid: stores.get_embed_template_store().get(mid))
    # Online-provider model-list ruleset (#8): the GET/PUT/reset editor + the resolver the
    # models endpoints apply (adapter.provider_type → its rule dict). Storage is ONE JSON
    # doc in the runner-settings store — no new table (mirrors default_preset_id).
    app.include_router(make_model_list_rules_router(
        stores.get_model_list_rules, stores.set_model_list_rules, stores.reset_model_list_rules))
    set_model_list_rules_resolver(lambda: stores.get_model_list_rules().get("rules", {}))
    app.include_router(make_runner_config_router(stores.get_runner_config_store))
    app.include_router(make_switch_presets_router(stores.get_switch_preset_store))
    app.include_router(make_model_tunes_router(
        stores.get_model_tune_store, _current_hw_key,
        # §7.6 drift + provenance wiring: the layer baseline stored at apply time
        # (drift = today's baseline vs the stored one), the measurement history
        # (an applied tune equal to an autotune trial = "auto"), and the class
        # library + key (the catalog's Class-default badge).
        resolve_baseline=lambda mid: switch_resolve.resolve_model_switches(
            mid, "", _current_class_key()),
        measurements_fn=lambda mid: stores.get_model_measurement_store().list(mid),
        class_key_fn=_current_class_key,
        class_configs_fn=lambda: stores.get_class_tune_store().list_all(),
    ))
    # The editable hardware-class library (ROUND 8 Task C, 2026-07-07; NAMED-class
    # redesign 2026-07-22) — the class-key twin of the model-tunes router;
    # `_current_class_key` badges + defaults saves to THIS box's class. The
    # hardware-class sidecar (name + editable VRAM/RAM) + the class_key format/parse
    # convention are wired through the DI seam (llm/ never imports runner/ directly).
    # derive = the BANDED builder (2026-07-25): a hand-typed vram 10 lands in the 8
    # band, matching what detection emits — an exact-number derive would mint an
    # unmatchable micro-class now that detection keys on bands.
    from ..runner.hardware import banded_class_key, parse_class_key

    app.include_router(make_class_tunes_router(
        stores.get_class_tune_store, _current_class_key,
        hw_class_store=stores.get_hardware_class_store,
        derive_key_fn=banded_class_key,
        parse_key_fn=parse_class_key,
    ))
    # The persistent measurement history (#142 rows 5+6, 2026-07-07): the Tune
    # modal POSTs its "Load & measure" results here; the auto-tune sink below
    # writes every OK trial; DELETE is the Clear-history button.
    app.include_router(make_model_measurements_router(
        stores.get_model_measurement_store, _current_hw_key))

    # Auto-tune (2026-07-06): the runner drives the measured sweep; the llm layer
    # supplies switch resolution + tune persistence via the same DI seam as the
    # catalog router. `save_tune` writes the winner VERBATIM as this machine's
    # tune (identical semantics to the Tune modal's Save — the QuickSetup
    # save-on-done path rides it).
    def _save_tune(model_id: str, switches: dict) -> None:
        from .model_tunes_api import ModelTuneFlag

        rows = [ModelTuneFlag(flagName=k, flagValue=str(v)) for k, v in sorted(switches.items())]
        # §7.6: capture the layer baseline beside the tune (same as the PUT route)
        # so drift detection covers the QuickSetup save-on-done path too.
        try:
            baseline = switch_resolve.resolve_model_switches(model_id, "", _current_class_key())
        except Exception:  # noqa: BLE001 — a baseline failure must not block the save
            baseline = None
        stores.get_model_tune_store().replace(model_id, _current_hw_key(), rows, baseline=baseline)

    # The measurement-history sink for the sweep (#142 rows 5+6): every OK trial
    # is a real measurement — persisted with the trial's own switches + label.
    # Server-stamped identity/clock, matching the POST endpoint's semantics.
    def _record_measurement(model_id: str, trial: dict) -> None:
        import time as _time

        from .model_measurements_api import MeasurementFlag

        rows = [MeasurementFlag(flagName=k, flagValue=str(v))
                for k, v in sorted((trial.get("switches") or {}).items())]
        stores.get_model_measurement_store().record(
            model_id, machine_key=_current_hw_key(), source="autotune",
            label=str(trial.get("label") or ""),
            tokens_per_sec=float(trial.get("tokensPerSec") or 0),
            vram_total_mb=int(trial.get("vramTotalMb") or 0),
            at=int(_time.time() * 1000), rows=rows)

    from ..runner.autotune import make_autotune_router

    app.include_router(make_autotune_router(
        lambda mid: switch_resolve.resolve_model_switches(mid, _current_hw_key(), _current_class_key()),
        _save_tune,
        record_measurement=_record_measurement,
    ))


def install_llm(
    app,
    *,
    engine,
    session_factory,
    feature_catalog=(),
    feature_prompts=None,
    engine_presets=None,
    feature_presets=None,
    default_preset_id="",
    model_catalog_extra=None,
    model_tunes_seed=None,
    class_tunes_seed=None,
    class_tune_identity=None,
    embed_templates=None,
    test_samples=None,
    feature_prompt_heals=None,
    prefer_local_features: Iterable[str] | None = None,
    runner_catalog: bool = True,
    data_dir=None,
    cache_root=None,
    product: str = "",
    allow_key_reveal: bool = False,
) -> None:
    """Wire + mount the whole shared LLM stack onto `app`. Idempotent table create.

    `app=None` is the HEADLESS boot (2026-08-02): everything except the router mounts —
    storage, seeds registration, the usage sink, the runner-catalog wiring. It exists
    because a CLI door has to boot the SAME stack (presets resolve through the stores),
    and the first consumer to need it re-implemented this function's storage half
    against private imports — the exact drift this package exists to prevent.

    THE MINIMAL CONTRACT (2026-08-01): `install_llm(app, engine=…, session_factory=…,
    data_dir=…)` is a complete, legal call. `feature_catalog`/`feature_prompts` default to
    empty because an app with no per-action AI features is a first-class consumer — the
    "any Python app" half of the shared-package goal. The bare call is enforced by
    `tests/test_install_llm.py` AND by check 3 of `scripts/check-clean-install.py`, which
    runs it in a venv holding only the declared dependencies; if a change here breaks the
    stranger's app, one of those fails before a host's luck can hide it.

    STORAGE CAVEAT: this call starts a daemon thread (catalog-derive-backfill) that opens
    a DB session at boot. Hand it a session factory whose sessions get their OWN
    connections — any real file-backed DB does. A single-shared-connection test DB
    (in-memory SQLite on StaticPool) lets that thread's transaction interleave with a
    seed pass on the one connection and silently roll its inserts back; measured
    2026-08-01, 0 of 11 seeded providers surviving one run and 2 of 11 the next."""
    # Normalize the optional feature data. Empty — never None — reaches
    # configure_app_seed, because None there means "leave any prior registration
    # in place" (a stale-state hazard for the second install in one process).
    # Same for every per-app seed registration below: an install that doesn't
    # pass one CLEARS any prior process-state rather than inheriting it.
    feature_catalog = list(feature_catalog or ())
    feature_prompts = dict(feature_prompts or {})
    model_catalog_extra = list(model_catalog_extra or ())
    model_tunes_seed = list(model_tunes_seed or ())
    class_tunes_seed = list(class_tunes_seed or ())
    class_tune_identity = dict(class_tune_identity or {})
    embed_templates = list(embed_templates or ())
    if data_dir is None:
        # Loud, once per install: without a data_dir the runner's engine + every
        # downloaded GGUF land in ~/.cache/just-llm-runner — OUTSIDE the app's data
        # root, so uninstalling the app strands the weights and a data-dir backup
        # silently misses them. Every real host should pass its data dir.
        logging.getLogger(__name__).warning(
            "install_llm: no data_dir passed — the LLM engine and model downloads will "
            "land in the user cache (~/.cache/just-llm-runner), outside your app's data "
            "root. Pass data_dir=<your app's data dir> unless that is deliberate."
        )
    # 1. storage — the app's own engine/session back every shared table.
    db.configure_storage(session_factory)
    db.create_all(engine)
    # 2. register the app's feature DATA (the ONLY per-app inputs): the feature
    # catalog + prompts, the built-in engine presets, and the per-ACTION preset refs
    # (action→preset_id — the one source of what an action runs; all optional).
    seed.configure_app_seed(
        feature_catalog=feature_catalog, feature_prompts=feature_prompts,
        engine_presets=engine_presets, feature_presets=feature_presets,
        default_preset_id=default_preset_id,
        model_catalog_extra=model_catalog_extra,
        model_tunes_seed=model_tunes_seed,
        class_tunes_seed=class_tunes_seed,
        class_tune_identity=class_tune_identity,
        embed_templates=embed_templates,
        hw_key_fn=_current_hw_key,
        test_samples=test_samples,
        feature_prompt_heals=feature_prompt_heals,
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

    # 5. mount every LLM router (the same surface in every app) — skipped wholesale
    # for the headless (app=None) boot; everything storage/registry-shaped above and
    # the runner wiring below run either way.
    if app is not None:
        _mount_llm_routers(app, feature_prompts=feature_prompts,
                           _config=_config, allow_key_reveal=allow_key_reveal,
                           data_dir=data_dir, product=product)

    # 6. point the bundled runner's catalog/switches at the shared DB.
    if runner_catalog:
        _wire_runner_catalog(data_dir, cache_root=cache_root, product=product)
        # 6b. Seed-vs-file self-heal (2026-07-07): re-derive catalog facts from
        # ALREADY-DOWNLOADED GGUFs whose rows never got the identify pass — a DB
        # reset re-seeds rows without samplers/derived facts, and identify only
        # runs at download time, so a cached model's "Recommended samplers" read
        # "—" forever. Daemon thread (boot must never block on file reads); LOCAL
        # header reads only — no generation_config network fallback here (a
        # samplers-less file re-checks each boot: milliseconds, no staleness
        # marker column needed).
        def _backfill():
            try:
                from ..runner.lifecycle import get_service
                from .identity import backfill_derived_from_cache, detect_and_store_model_type

                svc = get_service()
                n = backfill_derived_from_cache(
                    stores.get_model_catalog_store().list(),
                    svc.cached_path,
                    lambda mid, path: detect_and_store_model_type(mid, path),
                )
                if n:
                    logging.getLogger(__name__).info(
                        "catalog derive-backfill: %d cached model(s) re-derived", n)
            except Exception:  # noqa: BLE001 — a backfill failure must never hurt boot
                logging.getLogger(__name__).warning("catalog derive-backfill failed", exc_info=True)

        threading.Thread(target=_backfill, daemon=True, name="catalog-derive-backfill").start()


def resolve_cache_roots(data_dir=None, cache_root=None, stored: str = "") -> tuple:
    """Where the engine + model cache lives, and where THIS app's generated engine
    state lives. Returns `(cache_root, runtime_root, shared)`; either may be None,
    meaning "the runner's own default".

    Precedence: an explicit `cache_root=` argument (a host that hard-wires it) beats
    the user's stored choice, which beats `<data_dir>/ai-cache`.

    The split matters the moment a cache is shared. `hf/` weights and
    `llamacpp/<build>/` binaries are content-addressed — two apps fetching the same
    thing fetch the same bytes, so sharing them saves real gigabytes (14.2 GB of one
    model, twice, measured 2026-08-03). The generated `models.ini` and the per-spawn
    logs are NOT that: each app renders the ini from its OWN catalogue, so a shared
    one would have each app overwrite the other's, and the next router bounce would
    re-read a preset describing somebody else's models. Those go under the app's own
    data dir whenever the cache is shared — and stay exactly where they always were
    when it isn't, so an existing install needs no migration."""
    own = (Path(data_dir) / "ai-cache") if data_dir else None
    chosen = cache_root or stored or None
    root = Path(chosen) if chosen else own
    shared = bool(root and own and root != own)
    runtime = (Path(data_dir) / "ai-runtime") if (shared and data_dir) else None
    return root, runtime, shared


def _wire_runner_catalog(data_dir=None, cache_root=None, product: str = "") -> None:
    """The bundled llama.cpp runner reads its downloadable-model catalog, per-model
    switches, AND its load config (llama.cpp binaries + VRAM margin) from the
    shared DB — fully replacing runner-manifest.json (A7). When the host passes a
    `data_dir`, the runner's engine + model cache lives under `<data_dir>/ai-cache`
    so all app data shares one portable root; None → the runner default (~/.cache).

    That cache MAY instead point at a sibling family app's (`resolve_cache_roots`),
    which is what stops the same 14 GB model being downloaded once per app."""
    from ..runner import cache_registry
    from ..runner.lifecycle import configure_service, get_service
    from ..runner.schema import ModelEntry, RecommendedFor

    from .dispatch import set_ensure_local_model, set_local_runner_base_url

    log = logging.getLogger(__name__)

    def catalog_fn():
        return [
            ModelEntry(
                id=r.id, name=r.name, tier=r.tier, hf_repo=r.hfRepo, quant=r.quant, mmproj=r.mmproj,
                total_params=r.totalParams or None, active_params=r.activeParams or None, mtp=r.mtp,
                mtp_draft_repo=r.mtpDraftRepo, mtp_draft_file=r.mtpDraftFile, mtp_draft_quant=r.mtpDraftQuant,
                pooling=r.pooling, embedding=r.embedding, min_ram_mb=r.minRamMb,
                recommended_for=RecommendedFor(min_vram_mb=r.minVramMb, est_vram_mb=r.estVramMb),
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

    def default_llm_id_fn() -> str:
        # The catalog id the routing default points at the bundled runner as the CHAT
        # provider — the embed CPU-placement guarantee's STATIC baseline (#274 half 2,
        # 2026-07-11): an embedding child only gets the GPU room the card can spare
        # BESIDE this model's curated floor. "" when the chat default is cloud/Ollama
        # (no local co-residence to protect → the embed may use the whole card).
        d = stores.get_routing_store().get_routing().default
        if d.llmId == "local-llamacpp" and d.model:
            return d.model
        return ""

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

    # The user's stored choice of cache (Quick Setup offers a sibling app's, so the
    # same content-addressed gigabytes are fetched once per BOX, not once per app).
    # Best-effort: a DB that cannot answer must not stop a boot — fall back to own.
    try:
        stored = stores.get_runner_config_store().get_cache_root()
    except Exception:  # noqa: BLE001 — pre-seed / mid-migration DB
        stored = ""
    resolved_cache, runtime_root, shared = resolve_cache_roots(data_dir, cache_root, stored)
    if shared:
        log.info("engine cache SHARED at %s (this app's generated state stays in %s)",
                 resolved_cache, runtime_root)
    if resolved_cache and data_dir:
        # Tell the rest of the family where this app keeps its cache, so the NEXT app
        # installed can offer to share it instead of re-downloading. Records a path,
        # never contents.
        cache_registry.register(product or Path(data_dir).name, resolved_cache, data_dir)

    configure_service(
        catalog_fn=catalog_fn, switches_fn=switches_fn,
        identify_fn=identify_fn, embedding_ids_fn=embedding_ids_fn,
        default_llm_id_fn=default_llm_id_fn,
        config_fn=stores.build_runner_config,
        cache_root=(str(resolved_cache) if resolved_cache else None),
        runtime_root=(str(runtime_root) if runtime_root else None),
        # Pass 2 (2026-07-22): per-knob backend applicability from knob_catalog —
        # the runner drops launch flags the active engine family can't use.
        knob_backends_fn=stores.list_knob_backends,
    )

    # QC-43b: wire the dispatch ensure-local hook to the runner service. A run routed
    # to the bundled runner (chat / features / Lab) makes its model resident BEFORE
    # dispatch — the server-side twin of the kit's ensure-embedding — so a cold router
    # no longer surfaces as "Connection refused". The llm/ dispatch never imports
    # runner/; this closure over ensure_model_ready IS the injected seam (like the
    # configure_service fns above). get_service() is resolved at call time so it always
    # hits the configured singleton.
    def _ensure_local_model(model_id: str) -> None:
        get_service().ensure_model_ready(model_id)

    set_ensure_local_model(_ensure_local_model)

    # 2026-08-03: the twin seam for WHERE that model answers. The router binds a free
    # port at spawn (two apps both assuming :8080 sent one app's chat to the other's
    # engine), so the `local-llamacpp` adapter must ask the live service per request
    # rather than trust the baseUrl stored on the provider row. Same closure shape,
    # same call-time get_service().
    set_local_runner_base_url(lambda: get_service().router_url())

    # Pass 2 (2026-07-22): the ACTIVE engine family reaches the llm-side tune layers
    # (stamp at save, filter at resolve/display) through the same injected-closure
    # pattern — the llm/ package never imports runner/.
    from .switch_resolve import set_active_backend_fn

    set_active_backend_fn(lambda: get_service()._active_backend())

    # 2026-08-09 VRAM wiring (step 4): the llm-busy guard. A LOCAL-runner
    # chat/stream marks the arbiter's llm kind busy for its whole duration, so
    # a cross-kind admission (a JV TTS load) can never evict the model mid-run
    # (never-evict-busy). Same injected-seam shape as the hooks above.
    from contextlib import contextmanager

    from ..runner.arbiter import get_arbiter
    from .dispatch import set_local_busy_guard

    @contextmanager
    def _llm_busy():
        arb = get_arbiter()
        arb.busy_begin("llm")
        try:
            yield
        finally:
            arb.busy_end("llm")

    set_local_busy_guard(_llm_busy)
