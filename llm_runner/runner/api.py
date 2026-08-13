# SPDX-License-Identifier: MIT
"""Mountable FastAPI router — the shared LLM-runner REST surface.

Both apps mount this on their FastAPI app so the GUI talks to an identical
API:
    JustVoice: app.include_router(llm_runner.router)   (in its big server)
    JustWrite: app.include_router(llm_runner.router)   (in its light sidecar)

P1.1/P1.2 surface: manifest + detected hardware. Later items add model
download, spawn/status, provider config.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException

from . import bandwidth, fit
from .hardware import active_backend, class_key, detect, machine_key, max_vram_mb, mem_arch
from .lifecycle import get_service
from .process import Overrides
from .schema import (
    DownloadCancelRequest,
    HardwareInfo,
    LoadRequest,
    ModelEntry,
    RunnerConfig,
    RunnerModelInfo,
    RunnerModelsResponse,
    RunnerResidentResponse,
)

log = logging.getLogger(__name__)

router = APIRouter(tags=["llm-runner"])

_warned_catalog_unwired = False


def _warn_catalog_unwired() -> None:
    """Once per process: this router is mounted but no host catalog was ever wired.

    Not an error — the runner is legitimately usable for hardware detection and engine
    install alone — but it IS the difference between "nothing to download yet" and
    "downloading anything is impossible here", and it was previously invisible."""
    global _warned_catalog_unwired
    if not _warned_catalog_unwired:
        _warned_catalog_unwired = True
        log.warning(
            "llm-runner: /models is empty because no catalog source is wired. Call "
            "configure_service(catalog_fn=...) at boot (llm_runner.llm.install_llm does "
            "this for you), or the engine has nothing it can download or load."
        )


def _fit(model: ModelEntry, gpu_vram_mb: int, ram_mb: int, margin_mb: int) -> str:
    """Coarse pre-download Fit (no GGUF yet): computed from the model's params ×
    quant vs detected VRAM — or an explicit `recommendedFor.minVramMb` override
    when the manifest sets one (it can encode MoE CPU-offload a raw weights
    estimate misses). Bands: ok ≤1.0, tight ≤1.5, else no; no GPU → cpu (no only
    if RAM can't hold it). The precise per-layer fit needs the downloaded GGUF
    (`compute_fit`); the spawn OOM back-off is the final safety net."""
    return fit.coarse_fit(
        total_params=model.total_params,
        quant=model.quant,
        vram_mb=gpu_vram_mb,
        ram_mb=ram_mb,
        margin_mb=margin_mb,
        min_vram_override=model.recommended_for.min_vram_mb,
        min_ram_override=model.min_ram_mb,
    )


def _speed_facts(m: ModelEntry) -> dict | None:
    """The per-model byte facts the speed model and the bandwidth derivation
    share (fit-redesign §5.5): bytes/pass split into non-expert + active-expert
    legs, plus the §13.11 KV scalars. None for embeds (no decode-speed story)
    and for rows whose header was never read — those get NO band, never a guess."""
    facts = m.physics_facts or {}
    if m.embedding or not m.size_bytes or not facts.get("block_count"):
        return None
    size_mb = m.size_bytes / 1e6
    non_expert, active_expert = fit.active_bytes_per_pass_mb(
        size_mb=size_mb,
        expert_byte_share=float(facts.get("expert_byte_share") or 0.0),
        experts_total=int(m.experts or 0),
        expert_used=int(facts.get("expert_used_count") or 0),
    )
    return {"n_layers": int(facts.get("block_count") or 0), "mtp": bool(m.mtp),
            "size_mb": size_mb, "non_expert_mb": non_expert,
            "active_expert_mb": active_expert, "kv_facts": facts}


@router.get(
    "/v1/llm-runner/config",
    response_model=RunnerConfig,
    response_model_by_alias=True,
    summary="Built-in LLM runner config (llama.cpp binaries + VRAM safety margin)",
)
async def get_config() -> RunnerConfig:
    return get_service().config()


class HardwareWithKeys(HardwareInfo):
    """HardwareInfo + the two DERIVED tuning identities (2026-07-07, the debug ask):
    `machineKey` is what `model_tunes` (the machine's own tunes) are stored under and
    `classKey` is what the seeded/editable `class_tunes` layer matches on — served
    here so a debug surface can explain exactly which tune layers apply to this box."""

    machine_key: str = ""
    class_key: str = ""


@router.get(
    "/v1/llm-runner/hardware",
    response_model=HardwareWithKeys,
    response_model_by_alias=True,
    summary="Detected hardware (platform, GPU, driver, RAM, runtimes) + the tuning keys",
)
async def get_hardware() -> HardwareWithKeys:
    hw = detect()
    return HardwareWithKeys(**hw.model_dump(), machine_key=machine_key(hw), class_key=class_key(hw))


@router.get(
    "/v1/llm-runner/models",
    response_model=RunnerModelsResponse,
    response_model_by_alias=True,
    summary="Model catalog with hardware Fit + load/disk status",
)
async def get_models(vram_mb: int | None = None) -> RunnerModelsResponse:
    """The bundled-runner model catalog the GUI shows in the built-in provider's
    form: each manifest model annotated with a coarse Fit (vs detected VRAM),
    whether its GGUF is already cached, and the live load status.

    `vram_mb` overrides the detected VRAM so Quick Setup's card chooser can
    re-score Fit for a card other than the one in this machine (0 = CPU-only)."""
    hardware = detect()
    service = get_service()

    # Fit answers "how does this model run on THIS MACHINE'S CARD" — scored against the
    # card's TOTAL VRAM. (User decree 2026-07-06 "fix it": the former P2 §5c budget-aware
    # scoring fed the VRAM *remaining* after the resident set, so a sleeping model on an
    # 8 GB box flipped EVERY row to "CPU" while the same screen's header showed the card —
    # two truths on one screen. Reverted: the load-moment budget belongs to the arbiter,
    # which evicts/swaps at load; the live remaining number stays on the engine panel's
    # VRAM line.) A card-chooser override (vram_mb passed) is used as-is (0 = CPU-only).
    gpu_vram = vram_mb if vram_mb is not None else max_vram_mb(hardware)
    margin = service.config().safety_margin_mb
    hf_cache = service.cache_root / "hf"

    # Resident-set aware (P1f): the router co-resides up to models_max models, so read the
    # LIVE per-model status (GET /models via service.resident()) rather than the single-model
    # status() — multiple models can be loaded independently. Router down (lazy-spawn common
    # case) → empty set → every model falls through to disk/available. The download-only
    # channel still overlays independently (it can run while a model is resident).
    live = {m["id"]: m.get("status") for m in service.resident(hardware).get("models", [])}
    # Downloads are now concurrent + per-model keyed: {modelId: {status, …}}. A model absent
    # from the map is idle on that channel (its weights are simply on disk or not).
    downloads = service.download_status().get("downloads", {})

    def _status_for(model_id: str, downloaded: bool) -> str:
        s = live.get(model_id)
        # T2b (2026-07-17): a model being torn down or cancel-resolved says so — the
        # card renders "Unloading…" with its buttons inert instead of a live "● loaded"
        # that invites the second click (the user's unload-×3).
        if s in ("stopping", "cancelling"):
            return "stopping"
        if s in ("loaded", "sleeping"):
            return "loaded"
        if s in ("loading", "downloading", "starting"):
            return "loading"
        if s in ("failed", "error"):
            return "error"
        # A download-only op runs on its OWN per-model channel (it can overlap a loaded model).
        dl = downloads.get(model_id)
        if dl is not None:
            if dl.get("status") == "downloading":
                return "loading"
            if dl.get("status") == "error":
                return "error"
        return "disk" if downloaded else "available"

    # Catalog is HOST-OWNED (DB-backed via service.catalog()). There is NO fallback:
    # a host that never called `configure_service(catalog_fn=…)` gets an EMPTY list.
    # (This comment claimed a fall-through "to manifest.models for standalone runner
    # use" until 2026-08-01. That file was deleted with A7 — see runner/config.py's
    # opening line — so the sentence described a path that had not existed for months,
    # and a clean-mount audit measured what actually happens: `{"models": []}`.)
    catalog = service.catalog()
    if not service.catalog_wired:
        # Say it once per process rather than per request: silence here is what let
        # JustVoice mount this router and serve an empty catalog unnoticed.
        _warn_catalog_unwired()

    # ── The SPEED half of the badge (fit-redesign Phase 3; §5.4: feasibility ×
    # band ship together). Bandwidth is a MACHINE property, resolved once per
    # request down the §5.5 ladder (measurement-derived → device-reported →
    # class-seeded); each chat row with header facts then gets its per-pass byte
    # split priced. A row without facts, or a pool without bandwidth, keeps band
    # "" — the chip shows plain feasibility rather than a guess (§8.17's rule).
    cfg = service.config()
    backend = active_backend(hardware)
    arch = mem_arch(hardware)
    # Same one-pool condition as compute_fit's arch arm (§13.10): a GPU-less
    # Windows/Linux box stays the plain CPU path (budget 0 → all bytes host).
    one_pool = arch in ("integrated", "unified") and (bool(hardware.gpus) or hardware.platform == "macos")
    mkey = machine_key(hardware)
    speed_facts: dict[str, dict] = {}
    for m in catalog:
        sf = _speed_facts(m)
        if sf:
            speed_facts[m.id] = sf
    meas_plain = [{
        "model_id": getattr(r, "modelId", ""), "machine_key": getattr(r, "machineKey", ""),
        "backend": getattr(r, "backend", ""),
        "tokens_per_sec": float(getattr(r, "tokensPerSec", 0) or 0),
        "switches": {f.flagName: f.flagValue for f in (getattr(r, "switches", None) or [])},
    } for r in service.measurement_rows()]
    cls_vram_bw, cls_ram_bw = service.class_bw(class_key(hardware))
    dev_bw, host_bw = bandwidth.resolve_effective_bw(
        rows=meas_plain, facts_by_id=speed_facts, machine_key=mkey, backend=backend,
        is_macos=(hardware.platform == "macos"),
        class_vram_bw_gbps=cls_vram_bw, class_ram_bw_gbps=cls_ram_bw,
        probe_gbps=service.host_probe_bw_gbps(mkey),
        eff_device=cfg.bw_eff_device, eff_host=cfg.bw_eff_host,
        eff_host_probe=cfg.bw_eff_host_probe)
    overhead = fit.PHYSICS_OVERHEAD_MB.get(backend, fit.PHYSICS_OVERHEAD_MB["cuda"])
    weight_budget = max(0.0, gpu_vram - margin - overhead)
    # Newest REAL measurement per model on THIS box + backend — measurement
    # outranks estimate at display AND for the band. Rows arrive newest-first;
    # the RAM-probe pseudo-row never matches a catalog id.
    measured_by_id: dict[str, float] = {}
    for r in meas_plain:
        if r["machine_key"] == mkey and r["backend"] == backend and r["tokens_per_sec"] > 0:
            measured_by_id.setdefault(r["model_id"], r["tokens_per_sec"])
    # §7.4-as-ranking: ANY persisted row for this machine — a tune, an autotune
    # trial, or a Phase 5 load footprint (tok/s 0, so measured_by_id skips it) —
    # is THIS-box evidence the model ran here. Machine-keyed only (the plan's
    # words): a backend switch changes speed, not the fact that it ran. The
    # pseudo-rows (__machine_ram_bw__, __overhead__) never match a catalog id.
    ran_here_ids = {r["model_id"] for r in meas_plain if r["machine_key"] == mkey}

    def _speed(m: ModelEntry) -> tuple[str, float | None, float | None]:
        """(band, predicted tok/s, measured tok/s) for one chat row."""
        sf = speed_facts.get(m.id)
        if not sf:
            return "", None, None
        # The band prices the config the row would actually launch: capped ctx
        # (§8.1) — larger ctx reads more KV per token, the err-slow direction.
        cap = cfg.ctx_cap_tokens
        ctx = min(m.trained_ctx or cap, cap) if cap else (m.trained_ctx or 4096)
        kv = fit.kv_mb_from_facts(sf["kv_facts"], max(1, ctx))
        dev_mb, host_mb = fit.speed_bytes_split(
            non_expert_mb=sf["non_expert_mb"], active_expert_mb=sf["active_expert_mb"],
            kv_mb=kv, one_pool=one_pool, weight_budget_mb=weight_budget)
        if one_pool:
            # The one pool is priced by ITS efficiency family (§5.5): Metal
            # streams like a device (Apple published BW × device family); an
            # iGPU/CPU pool gathers like a host (Appendix B's laptop rows sit
            # in the host range — err-slow keeps them there).
            tok = fit.predict_decode_tok_s(
                device_mb=dev_mb, host_mb=0,
                device_bw_gbps=(dev_bw if backend == "metal" else host_bw),
                host_bw_gbps=None)
        else:
            tok = fit.predict_decode_tok_s(device_mb=dev_mb, host_mb=host_mb,
                                           device_bw_gbps=dev_bw, host_bw_gbps=host_bw)
        meas = measured_by_id.get(m.id)
        band = fit.speed_band(meas or tok, fast=cfg.band_fast_toks,
                              fine=cfg.band_fine_toks, slow=cfg.band_slow_toks)
        return band, (round(tok, 1) if tok else None), (round(meas, 1) if meas else None)

    models: list[RunnerModelInfo] = []
    for m in catalog:
        downloaded = service.model_downloaded(m, hf_cache)  # main weights AND the MTP draft when wanted
        # Embedding rows carry the placement TRUTH (2026-07-25): the same service rule
        # the loader enforces, so the badge never claims a GPU fit the load then refuses
        # (the old chip graded raw-card VRAM for models the policy puts on CPU).
        # Placement reflects THIS box — the card-chooser vram_mb override re-scores
        # `fit` only (placement on a hypothetical card would be fiction: the leftover
        # depends on which chat model this box actually defaults to).
        place, left = service.embed_placement(m, hardware) if m.embedding else ("", 0)
        band, pred, meas = _speed(m)
        models.append(
            RunnerModelInfo(
                id=m.id,
                name=m.name,
                tier=m.tier,
                params=m.total_params,
                active_params=m.active_params,
                min_vram_mb=m.recommended_for.min_vram_mb,
                min_ram_mb=m.min_ram_mb,
                fit=_fit(m, gpu_vram, hardware.ram_mb, margin),
                status=_status_for(m.id, downloaded),
                downloaded=downloaded,
                embed_placement=place,
                embed_leftover_mb=(left if place else None),
                speed_band=band,
                pred_tok_s=pred,
                measured_tok_s=meas,
                ran_here=m.id in ran_here_ids,
            )
        )

    return RunnerModelsResponse(
        vram_mb=gpu_vram,
        ram_mb=hardware.ram_mb,
        safety_margin_mb=margin,
        models=models,
        catalog_wired=service.catalog_wired,
    )


# ── Lifecycle: choose → load on demand → use ────────────────────────────


@router.post("/v1/llm-runner/load", summary="Download (if needed) + spawn a model")
async def load_model(body: LoadRequest) -> dict:
    """Load a model, optionally with Plane-1 engine overrides for tuning/testing
    (n_cpu_moe / n_gpu_layers / ctx / KV-cache type / flags / …). Omitted fields
    fall back to the computed Fit + the manifest's base preset. See
    docs/plans/2026-06-24-llamacpp-switches.md (Plane 1)."""
    if not body.model_id:
        raise HTTPException(status_code=400, detail="modelId required")
    overrides = Overrides(
        n_gpu_layers=body.n_gpu_layers, n_cpu_moe=body.n_cpu_moe, ctx_len=body.ctx_len,
        cache_type_k=body.cache_type_k, cache_type_v=body.cache_type_v, flash_attn=body.flash_attn,
        no_mmap=body.no_mmap, mlock=body.mlock, no_kv_offload=body.no_kv_offload,
        batch_size=body.batch_size, ubatch_size=body.ubatch_size,
        threads=body.threads, threads_batch=body.threads_batch, parallel=body.parallel,
        cont_batching=body.cont_batching, context_shift=body.context_shift, cache_reuse=body.cache_reuse,
        spec_type=body.spec_type, spec_n_max=body.spec_n_max,
        model_draft=body.model_draft, reasoning_budget=body.reasoning_budget,
        reasoning_budget_message=body.reasoning_budget_message,
        extra_flags=list(body.extra_flags or []),
    )
    return get_service().load(
        body.model_id, overrides=overrides, job_id=body.job_id, switches=body.switches,
        trigger="api",
    )


@router.post("/v1/llm-runner/download", summary="Download a model's GGUF to the cache (no spawn)")
async def download_model(body: LoadRequest) -> dict:
    """Fetch a model's weights into the local cache WITHOUT loading it — the catalog's
    'Download' action, separate from 'Load'. Does not require the engine installed; the
    model then reports as on-disk via /models. Any overrides in the body are ignored."""
    if not body.model_id:
        raise HTTPException(status_code=400, detail="modelId required")
    return get_service().download(body.model_id)


@router.get("/v1/llm-runner/download/status", summary="Progress of in-flight download-only ops")
async def download_status() -> dict:
    """Every in-flight/errored model download keyed by model id:
    `{"downloads": {modelId: {status, modelId, detail, error, downloaded, total}}}`.
    Downloads run concurrently, so a model absent from the map is idle on this channel."""
    return get_service().download_status()


@router.post("/v1/llm-runner/download/cancel", summary="Cancel a model download (one id, or all)")
async def download_cancel(body: DownloadCancelRequest | None = None) -> dict:
    """Signal a download to stop at the next chunk boundary. With `modelId` → cancel just
    that model's download; with no body / null → cancel ALL (the back-compat path). A queued
    download cancels before it starts. Idempotent: unknown/idle ids are no-ops. Returns the
    live download status — the cancelled row reads 'cancelling…' briefly, then leaves the map."""
    return get_service().cancel_download((body.model_id if body else None) or None)


@router.get("/v1/llm-runner/status", summary="Current load/run status")
async def runner_status() -> dict:
    """Back-compat SINGLE-model view (most-recently-loaded model's progress/state) — the
    existing UI (catalog poller, QuickSetup, Tune modal) reads this shape. The full
    co-resident set is /resident."""
    return get_service().status()


@router.get(
    "/v1/llm-runner/resident",
    response_model=RunnerResidentResponse,
    response_model_by_alias=True,
    summary="Live resident set (router mode): which models are loaded/sleeping + the knobs that bound it",
)
async def runner_resident() -> RunnerResidentResponse:
    """The router's LIVE per-model status (loaded | sleeping | loading | failed) with each
    loaded child's real footprint (`meta` sizes), plus `modelsMax` / `sleepIdleSeconds`.
    Router down → `router: false`, empty set. The committed/remaining VRAM budget joins this
    in P2 (the arbiter)."""
    return get_service().resident()


@router.post(
    "/v1/llm-runner/ensure-embedding",
    summary="Ensure the configured local embedding model is resident + pinned (lazy RAG prep)",
)
async def ensure_embedding() -> dict:
    """LAZY embed prep (P3): download-if-needed + load + PIN the embedding model the routing default
    points at the bundled runner, so local RAG works out of the box. `{"ok": false}` when no local
    embed is configured (the embedding provider is Ollama/cloud, or none set) — the caller then uses
    that provider unchanged. The load is ASYNC: poll `GET /v1/llm-runner/resident` for the returned
    `modelId` until it reads loaded|sleeping before embedding."""
    return get_service().ensure_embedding()


@router.post("/v1/llm-runner/stop", summary="Stop one resident model (modelId) or everything (no body)")
async def stop_model(body: dict | None = None) -> dict:
    # With a modelId this unloads ONE resident model and frees its VRAM (the router
    # stays up for the others) — the catalog row's Unload button (user, 2026-07-07:
    # "no way to unload"). No body keeps the original full-teardown semantics.
    model_id = str((body or {}).get("modelId") or "")
    return get_service().stop(model_id or None)


# ── Engine (the llama.cpp binary): install as its OWN step, separate from
#    downloading a model — a model load requires the engine already installed. ──


@router.get("/v1/llm-runner/engine/status", summary="Is the llama.cpp engine installed for this box?")
async def engine_status() -> dict:
    return get_service().engine_status()


@router.post("/v1/llm-runner/engine/install", summary="Download + install the llama.cpp engine (its own step)")
async def engine_install(body: dict | None = None) -> dict:
    force = bool((body or {}).get("force"))
    # An UPDATE passes the build it supersedes (user, 2026-07-07: "the engine update
    # should delete the old folder") — the service removes that old build dir after
    # the new one installs, carrying over a models.ini found inside it first.
    replace_build = str((body or {}).get("replaceBuild") or "")
    # A backend switch/add (2026-07-14) targets ONE variant family ("cuda"/"vulkan"):
    # a lightweight ADD into the pinned build — force/replaceBuild are ignored then.
    gpu = str((body or {}).get("gpu") or "")
    return get_service().install_engine(force=force, replace_build=replace_build, gpu=gpu)


@router.post("/v1/llm-runner/engine/install/cancel", summary="Cancel an in-flight engine install")
async def engine_install_cancel() -> dict:
    """Signal the engine install to stop at the next chunk boundary — the same shape as the
    model /download/cancel. Idempotent: a no-op (returns the current status) when nothing is
    installing. Returns the live engine status — 'cancelling…' immediately, then not-installed
    (idle) once the installer thread unwinds."""
    return get_service().cancel_install_engine()


@router.get("/v1/llm-runner/engine/log", summary="Tail the most recent llama-server spawn log")
async def engine_log(tail: int = 200) -> dict:
    return get_service().engine_log(tail=tail)


@router.post("/v1/llm-runner/engine/uninstall", summary="Remove the installed llama.cpp engine binaries (models are kept)")
async def engine_uninstall() -> dict:
    return get_service().uninstall_engine()


@router.get("/v1/llm-runner/engine/update-check", summary="Latest upstream llama.cpp build vs the pinned one (never auto-applies)")
async def engine_update_check() -> dict:
    return get_service().update_check()


# ── Reclaim disk: the runner OWNS its cache, so it owns the deletes. The sizes
#    are reported by the shared platform GET /v1/disk/usage; these do the freeing. ──


@router.post("/v1/llm-runner/spawn-logs/clear", summary="Delete the per-spawn llama-server logs (reclaim disk; the dir is kept)")
async def spawn_logs_clear() -> dict:
    """Remove every `*.log` under the runner's `llamacpp/logs` dir — the per-spawn
    llama-server logs, which are otherwise UNBOUNDED (nothing else sweeps them). The
    dir is kept so the next spawn can write. Best-effort: a locked file is skipped.
    Returns `{removed, bytes}`."""
    return get_service().clear_spawn_logs()


@router.post("/v1/llm-runner/models-cache/clear", summary="Delete downloaded model weights to reclaim disk (models re-download on demand)")
async def models_cache_clear() -> dict:
    """Delete every downloaded model GGUF from the HF cache. SAFE BY DESIGN: the
    catalog rows persist in the host DB, so each model simply RE-DOWNLOADS the next
    time it is loaded — nothing here is lost permanently. Refuses with
    `{ok: false, detail: "unload models first"}` (HTTP 200) while any model is
    resident/loading, because its weights are open/mmap'd (and on Windows an open
    file can't be unlinked); the caller unloads, then retries. On success returns
    `{ok: true, bytes}`."""
    return get_service().clear_models_cache()


@router.post("/v1/llm-runner/models-cache/delete", summary="Delete ONE model's downloaded weights (reclaim disk)")
async def models_cache_delete(body: LoadRequest) -> dict:
    """Delete a single model's GGUF(s) from the HF cache — the disk half of the catalog
    'Delete'. SAFE BY DESIGN: the weights re-download on demand if the model is re-added.
    Frees the handle first (cancels an in-flight download of it, unloads it if resident);
    a repo shared with another catalog row is kept. Returns `{ok: true, bytes, detail?}`."""
    if not body.model_id:
        raise HTTPException(status_code=400, detail="modelId required")
    return get_service().delete_model_cache(body.model_id)


@router.post("/v1/llm-runner/measure", summary="Probe the running model → decode tok/s + resource context")
async def measure_model(prompt: str = "Write one vivid paragraph about the sea.", max_tokens: int = 128,
                        model_id: str | None = None) -> dict:
    """#20 'Tune & measure': run a fixed probe against the loaded model and return
    decode tok/s + the box's VRAM/RAM context. Requires a model running. `model_id`
    names the model explicitly (the bench names its leg's model); omitted → the
    primary (most-recently loaded)."""
    return get_service().measure(prompt=prompt, max_tokens=max_tokens, model_id=model_id)


@router.post("/v1/llm-runner/tokenize", summary="Exact token count for text via the running model")
async def tokenize_text(body: dict) -> dict:
    """b1 'prompt preview': exact token count via the loaded model's own tokenizer
    (/tokenize). Requires a model running — the UI falls back to a heuristic when
    `ok` is false (no local model)."""
    return get_service().tokenize(text=str((body or {}).get("text") or ""))
