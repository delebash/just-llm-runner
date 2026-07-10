# SPDX-License-Identifier: GPL-3.0-or-later
"""Mountable FastAPI router — the shared LLM-runner REST surface.

Both apps mount this on their FastAPI app so the GUI talks to an identical
API:
    JustVoice: app.include_router(llm_runner.router)   (in its big server)
    JustWrite: app.include_router(llm_runner.router)   (in its light sidecar)

P1.1/P1.2 surface: manifest + detected hardware. Later items add model
download, spawn/status, provider config.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from . import fit
from .hardware import class_key, detect, machine_key, max_vram_mb
from .lifecycle import get_service
from .models import is_cached
from .process import Overrides
from .schema import (
    HardwareInfo,
    LoadRequest,
    ModelEntry,
    RunnerConfig,
    RunnerModelInfo,
    RunnerModelsResponse,
    RunnerResidentResponse,
)

router = APIRouter(tags=["llm-runner"])


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
    dl = service.download_status()
    dl_id = dl.get("modelId") or ""
    dl_state = dl.get("status") or "idle"

    def _status_for(model_id: str, downloaded: bool) -> str:
        s = live.get(model_id)
        if s in ("loaded", "sleeping"):
            return "loaded"
        if s in ("loading", "downloading", "starting"):
            return "loading"
        if s in ("failed", "error"):
            return "error"
        # A download-only op runs on its OWN channel (it can overlap a loaded model).
        if model_id == dl_id:
            if dl_state == "downloading":
                return "loading"
            if dl_state == "error":
                return "error"
        return "disk" if downloaded else "available"

    # Catalog is HOST-OWNED (DB-backed via service.catalog()). Falls through
    # to manifest.models inside service.catalog() for standalone runner use.
    catalog = service.catalog()

    models: list[RunnerModelInfo] = []
    for m in catalog:
        downloaded = is_cached(m.hf_repo, m.quant, cache_root=hf_cache, mmproj=m.mmproj)
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
            )
        )

    return RunnerModelsResponse(
        vram_mb=gpu_vram,
        ram_mb=hardware.ram_mb,
        safety_margin_mb=margin,
        models=models,
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
        body.model_id, overrides=overrides, job_id=body.job_id, switches=body.switches
    )


@router.post("/v1/llm-runner/download", summary="Download a model's GGUF to the cache (no spawn)")
async def download_model(body: LoadRequest) -> dict:
    """Fetch a model's weights into the local cache WITHOUT loading it — the catalog's
    'Download' action, separate from 'Load'. Does not require the engine installed; the
    model then reports as on-disk via /models. Any overrides in the body are ignored."""
    if not body.model_id:
        raise HTTPException(status_code=400, detail="modelId required")
    return get_service().download(body.model_id)


@router.get("/v1/llm-runner/download/status", summary="Progress of an in-flight download-only op")
async def download_status() -> dict:
    return get_service().download_status()


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
    return get_service().install_engine(force=force, replace_build=replace_build)


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


@router.post("/v1/llm-runner/measure", summary="Probe the running model → decode tok/s + resource context")
async def measure_model(prompt: str = "Write one vivid paragraph about the sea.", max_tokens: int = 128) -> dict:
    """#20 'Tune & measure': run a fixed probe against the loaded model and return
    decode tok/s + the box's VRAM/RAM context. Requires a model running."""
    return get_service().measure(prompt=prompt, max_tokens=max_tokens)


@router.post("/v1/llm-runner/tokenize", summary="Exact token count for text via the running model")
async def tokenize_text(body: dict) -> dict:
    """b1 'prompt preview': exact token count via the loaded model's own tokenizer
    (/tokenize). Requires a model running — the UI falls back to a heuristic when
    `ok` is false (no local model)."""
    return get_service().tokenize(text=str((body or {}).get("text") or ""))
