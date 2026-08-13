# SPDX-License-Identifier: MIT
"""Load/run lifecycle for the built-in runner — the "choose → load on demand →
use" half of the shared model (see the JustWrite server-side-LLM decision doc).

A singleton `RunnerService` acquires the llama.cpp binary + the GGUF weights and
spawns llama-server, exposing a pollable status so the GUI can show progress.
The heavy work runs on a background thread. `acquire_binary` / `acquire_model` /
`start_runner` (the parts that download + spawn — not runnable in CI) are
injectable, so the state machine itself is fully testable offline.
"""

from __future__ import annotations

import gc
import logging
import os
import shutil
import threading
import time
from pathlib import Path

import requests

from dataclasses import fields as _dc_fields, replace as _dc_replace

from .arbiter import EVICT_MIN_MB as _ARBITER_EVICT_MIN_MB, get_arbiter as _get_arbiter
from .binary import acquire_binary as _acquire_binary
from .binary import (
    acquired_server_exe,
    acquired_server_exes,
    binary_dir,
    build_num,
    build_of_exe,
    concrete_gpu,
    gpu_family,
    select_binary,
)
from .config import (
    DEFAULT_DOWNLOAD_MAX_CONCURRENT,
    MAX_DOWNLOAD_CONCURRENT,
    default_config as _default_config,
)
from .gguf import read_gguf_metadata as _read_gguf_metadata
from .hardware import (
    budget_total_mb as _hw_budget_total,
    detect as _detect,
    max_vram_mb as _hw_max_vram,
    used_device_mem_mb as _hw_used_device_mem,
)
from .download import DownloadCancelled, download_kwargs
from .models import acquire_model as _acquire_model, cached_gguf_path, is_cached, _quant_matches
from .process import (
    DEFAULT_HOST,
    DEFAULT_PORT,
    ModelIniEntry,
    Overrides,
    RouterHandle,
    RunnerStartError,
    _BACKOFF_STEP,
    _looks_like_draft_failure,
    _looks_like_oom,
    _looks_like_unfixable,
    _tail_file,
    compute_fit,
    emit_models_ini,
    find_free_port as _find_free_port,
    start_router as _start_router,
)
from .schema import ModelEntry

# Load-confirmation poll (P1f). POST /models/load is ASYNCHRONOUS on b9644 (box-verified
# 2026-07-04): a 2xx only ACCEPTS the request — the child loads in the background — so the
# 200 is NOT a load confirmation. A load is confirmed by polling GET /models until the
# child reports `loaded`. Generous timeout: a large model cold-loads in ~19–21 s (measured
# on the RTX 2070 SUPER), a 70B on a slow disk longer.
_LOAD_POLL_TIMEOUT = 300.0   # seconds before a still-`loading` child is declared failed
_LOAD_POLL_INTERVAL = 1.0    # seconds between GET /models polls

# Embed placement (#274's missing half; built after the 2026-07-11 co-load incident): an
# embedding child gets the GPU only when the card's STATIC leftover beside the local chat
# default covers its curated floor — otherwise it is forced to CPU with an EXPLICIT
# `n-gpu-layers = 0`. Fit-by-omission would hand placement to the child's GPU-greedy
# `--fit`, which is exactly what co-loaded a full-GPU 32k-ctx embed beside Gemma on an
# 8 GB card and crashed the chat spawn. See `_apply_embed_placement`.
_EMBED_CTX_CAP = 8192        # an embedding input is a ~1k-token chunk, never a chat context
# An ngl-0 CUDA child still holds a driver context (box-measured 549 MB on the 2070 SUPER,
# 2026-07-06) — the floor a measured reservation can't go below when the fit claimed GPU use.
_DRIVER_CTX_MB = 549
# VRAM-driven evictions skip victims reserving less than this (just above the driver-context
# floor): freeing a CPU-placed embed's ~0–550 MB can't make a GPU model fit, but it kills the
# warm embed child the RAG rail wants resident (observed live 2026-07-11). Count-cap evictions
# ignore this — a child must go regardless of its footprint. The value lives in arbiter.py now
# (2026-08-09 seam) so `make_room` and `_admit` share one threshold.
_EVICT_MIN_MB = _ARBITER_EVICT_MIN_MB

# Post-download integrity gate (the corrupt-GGUF fix, 2026-07-11). A freshly-acquired main
# GGUF has its header parsed BEFORE spawn; a corrupt or incomplete download (a file zeroed by
# antivirus mid-write — seen full-size but all-zeros — or a truncated transfer) fails the magic
# check and is surfaced as an ACTIONABLE error instead of llama.cpp's raw "bad magic", which
# otherwise bricks the whole router upstream at spawn. Reading a GGUF header is only a few KB,
# so the check is effectively free — it never scans the multi-GB body.


class CorruptModelError(RuntimeError):
    """A downloaded GGUF failed its integrity check (bad magic / truncated / too small).
    Raised with an actionable, user-facing message; carries `model_id` so a caller can offer
    a one-click re-download."""

    def __init__(self, message: str, model_id: str = ""):
        super().__init__(message)
        self.model_id = model_id


def _default_catalog_fn() -> list[ModelEntry]:
    """Standalone default: no host store wired → empty catalog. Hosts override
    this with a DB-backed function via `RunnerService(catalog_fn=...)`."""
    return []


def _default_switches_fn(model_id: str) -> dict[str, str]:  # noqa: ARG001
    """Standalone default: no host store wired → no per-model switch overrides."""
    return {}


def _default_identify_fn(model_id: str, gguf_path) -> None:  # noqa: ARG001
    """Standalone default: no host store wired → no catalog type auto-detect."""
    return None


def _default_embedding_ids_fn() -> set[str]:
    """Standalone default: no host store wired → no local embedding model configured.
    Hosts override via `RunnerService(embedding_ids_fn=...)` (JustWrite wires it from the
    routing default when the embedding provider points at the bundled runner) so the runner
    knows which catalog id is the co-resident embed — the `.ini` section that gets
    `embeddings = true` + a PINNED reservation so it is never the eviction victim (P3)."""
    return set()


def _default_profile_switches_fn(job_id: str) -> dict[str, str]:  # noqa: ARG001
    """Standalone default for the legacy `job_id` override hook (unused by
    JustWrite, which resolves switches from the model type baseline): no hook
    wired → fall back to the model's own switches."""
    return {}


def _default_measure_probe(url: str, prompt: str, max_tokens: int, model_id: str = "") -> tuple[int, float, dict | None]:
    """POST a fixed prompt to the running llama-server → (completion_tokens, decode_ms,
    draft). `draft` is {"n", "accepted"} read from the response `timings` when speculative
    decoding actually ran (llama.cpp `draft_n` / `draft_n_accepted`), else None — the MTP
    acceptance signal (T3). In router mode the body carries `"model"` so the router
    dispatches to the right resident child. A real network call — injected in tests."""
    body: dict = {"messages": [{"role": "user", "content": prompt}], "max_tokens": max_tokens, "stream": False}
    if model_id:
        body["model"] = model_id
    t0 = time.monotonic()
    resp = requests.post(url.rstrip("/") + "/v1/chat/completions", json=body, timeout=120)
    ms = (time.monotonic() - t0) * 1000
    resp.raise_for_status()
    payload = resp.json() or {}
    usage = payload.get("usage") or {}
    timings = payload.get("timings") or {}
    # `draft_n` is present ONLY when a draft model / built-in MTP head actually speculated.
    draft = ({"n": int(timings.get("draft_n") or 0),
              "accepted": int(timings.get("draft_n_accepted") or 0)}
             if "draft_n" in timings else None)
    return int(usage.get("completion_tokens") or 0), ms, draft


def _default_measure_sample() -> dict:
    """The box's resource context (TOTALS, from hardware detect). Per-process USED
    VRAM/RAM is a GPU-box refinement — inject a richer sampler there."""
    hw = _detect()
    return {
        "vramTotalMb": _hw_max_vram(hw),
        "ramTotalMb": hw.ram_mb,
    }


def _default_tokenize_probe(url: str, text: str, model_id: str = "") -> int:
    """EXACT token count for `text` via the running llama-server's /tokenize
    (b1/E2) — the loaded model's own tokenizer, so no client-side reimplementation. In
    router mode the body carries `"model"` so the router uses that child's tokenizer.
    A real network call; injected in tests."""
    body: dict = {"content": text}
    if model_id:
        body["model"] = model_id
    resp = requests.post(url.rstrip("/") + "/tokenize", json=body, timeout=30)
    resp.raise_for_status()
    return len((resp.json() or {}).get("tokens") or [])


def _default_router_load(url: str, model_id: str) -> None:
    """POST {url}/models/load {"model": id} — ACCEPT a model into the router (it then routes
    requests for that id to the child it spawns). ASYNC on b9644: a 2xx returns BEFORE the
    child is loaded (fire-and-forget), so this signals acceptance only — load success/failure
    is confirmed separately by polling GET /models (`_confirm_load`). Raises on a SYNCHRONOUS
    4xx (unknown id / at `models-max`), which is a real reject, not an OOM. Injected in tests."""
    resp = requests.post(url.rstrip("/") + "/models/load", json={"model": model_id}, timeout=600)
    if resp.status_code >= 400:
        raise RuntimeError(f"/models/load {model_id!r} failed [{resp.status_code}]: {resp.text[:800]}")


def _default_router_unload(url: str, model_id: str) -> None:
    """POST {url}/models/unload {"model": id} — free a resident model's VRAM (the
    arbiter drives this explicitly; auto-sleep is unreliable). Injected in tests.
    Idempotent (defect E, 2026-07-22): a 404 / "not found|running|loaded" answer means
    the goal state already holds — the router's truth wins, never an error (the call
    site swallows exceptions anyway; this keeps the log free of false failures)."""
    resp = requests.post(url.rstrip("/") + "/models/unload", json={"model": model_id}, timeout=120)
    if resp.status_code >= 400:
        body = (resp.text or "")[:800]
        low = body.lower()
        if resp.status_code == 404 or "not found" in low or "not running" in low or "not loaded" in low:
            log.info("router unload %s: already gone [%s] — adopting", model_id, resp.status_code)
            return
        raise RuntimeError(f"/models/unload {model_id!r} failed [{resp.status_code}]: {body}")


def _default_router_models(url: str) -> dict:
    """GET {url}/models → the router's resident-set status (OpenAI-list shape:
    `{"object":"list","data":[{"id":…,"status":{"value":…},"meta":{…}}]}`). Used to CONFIRM
    an async load (POST /models/load returns 200 BEFORE the child is loaded on b9644) and to
    report the live resident set to `/v1/llm-runner/resident`. Injected in tests."""
    resp = requests.get(url.rstrip("/") + "/models", timeout=30)
    resp.raise_for_status()
    return resp.json() or {}


def _parse_router_models(payload: dict) -> dict[str, dict]:
    """Map the router's `GET /models` response to `{model_id: {"value": status[, "meta": {…}]}}`.
    Status is NESTED at `data[].status.value` on b9644 (box-verified 2026-07-04, NOT a flat
    string); a flat `status` string is tolerated too for a hypothetical other build. `meta`
    (n_params / size / n_ctx / …) is present only on a LOADED child — the real resident
    footprint. A malformed / missing entry is skipped, never a crash."""
    out: dict[str, dict] = {}
    for entry in (payload or {}).get("data") or []:
        if not isinstance(entry, dict):
            continue
        mid = entry.get("id")
        if not mid:
            continue
        s = entry.get("status")
        value = s.get("value") if isinstance(s, dict) else (s if isinstance(s, str) else "")
        row: dict = {"value": value or ""}
        meta = entry.get("meta")
        if isinstance(meta, dict) and meta:
            row["meta"] = meta
        out[mid] = row
    return out


# Set of `Overrides` field names — used to validate switch keys at apply time
# (a stored flag_name not in this set is silently dropped, not a crash).
_OVERRIDE_FIELDS = {f.name for f in _dc_fields(Overrides)}


def _parse_switch(name: str, value: str):
    """Parse a stored switch text value into the typed `Overrides` field. Bool
    fields recognize 'true'/'false' (case-insensitive); int fields parse as int;
    everything else stays string. Returns `None` if the value is empty (treated
    as 'not set')."""
    if value is None or value == "":
        return None
    bool_fields = {"no_mmap", "mlock", "no_kv_offload", "cont_batching", "context_shift"}
    int_fields = {
        "n_gpu_layers", "n_cpu_moe", "ctx_len", "batch_size", "ubatch_size",
        "threads", "threads_batch", "parallel", "cache_reuse", "spec_n_max",
        "reasoning_budget",
    }
    if name in bool_fields:
        return value.strip().lower() in ("true", "1", "yes", "on")
    if name in int_fields:
        try:
            return int(value)
        except ValueError:
            return None
    return value


def _merge_overrides(base: Overrides, user: Overrides | None) -> Overrides:
    """Layer user-supplied Overrides ON TOP of catalog-derived ones. User wins
    per-field (a user value REPLACES the catalog default; user None leaves the
    catalog value in place). `extra_flags` are CONCATENATED, not replaced."""
    if user is None:
        return base
    merged = Overrides(extra_flags=list(base.extra_flags or []) + list(user.extra_flags or []))
    for f in _OVERRIDE_FIELDS - {"extra_flags"}:
        u = getattr(user, f, None)
        merged_val = u if u is not None else getattr(base, f, None)
        setattr(merged, f, merged_val)
    return merged


def _switches_to_overrides(switches: dict[str, str]) -> Overrides:
    """Build an `Overrides` from the host's `{flag_name: flag_value}` dict
    (variable-cardinality switch rows).

    A key that matches an `Overrides` field maps to that typed field. ANY OTHER
    key is a raw passthrough flag → it lands in `extra_flags` verbatim (the key is
    the literal llama-server flag token, e.g. `--top-n-sigma`, with the value
    appended when non-empty). So a NEW llama.cpp flag works with **no code change**
    — the host just stores a switch row for it (the shared `<KnobGrid>` escape).
    The literal key `extra_flags` is reserved (not itself a flag) and skipped."""
    ov = Overrides()
    for name, value in (switches or {}).items():
        if name == "extra_flags":
            continue  # reserved: the passthrough list itself, not a flag name
        if name in _OVERRIDE_FIELDS:
            parsed = _parse_switch(name, value)
            if parsed is not None:
                setattr(ov, name, parsed)
            continue
        # Unknown key → raw passthrough flag (the "add a flag, no code" escape).
        ov.extra_flags.append(name)
        if value not in (None, ""):
            ov.extra_flags.append(str(value))
    return ov


_IS_WINDOWS = os.name == "nt"  # patchable seam for the strip-rule tests


def _strip_inert_mlock(ov):
    """THE (b) decision (user, 2026-07-22 — pass-1 plan T7 options; no upstream report):
    on Windows, --mlock combined with --no-mmap can NEVER lock — llama.cpp's no-mmap
    heap buffer is not VirtualLock-able (998 ERROR_NOACCESS; standalone A/B in the
    recovery doc §9: mlock alone locks, the pair fails). The seeded base bundle
    (mlock, every model) and the MoE bundle (no_mmap) compose exactly this pair on
    every MoE model, shipping an inert flag + warning spam. Strip mlock from the
    combination HERE — the flag merge is code's domain (house rules) and this is a
    COMBINATION fact, not per-knob applicability. mlock ALONE stays honored (it works,
    proven); non-Windows is untouched (Linux + IPC_LOCK plausibly locks the pair)."""
    if _IS_WINDOWS and ov.no_mmap and ov.mlock:
        log.info("mlock is inert beside no-mmap on Windows (upstream VirtualLock 998) — "
                 "stripping it from this section")
        ov.mlock = None
    return ov


def _wants_draft(ov, model) -> bool:
    """THE one needs-its-draft predicate: does this resolved config call for an EXTERNAL
    MTP draft that isn't already pinned to a path? True only when the merged overrides
    select `draft-mtp`, no explicit `model_draft` was set, and the catalog model actually
    declares a draft file. Its THREE consumers must agree: `_acquire_and_identify` (fetch
    the draft on load AND download), the router `.ini` emitter (point at the cached draft
    or strip+warn), and `RunnerService.model_downloaded` (the catalog badge)."""
    return (
        ov is not None
        and ov.spec_type == "draft-mtp"
        and not ov.model_draft
        and bool(getattr(model, "mtp_draft_file", ""))
    )

log = logging.getLogger(__name__)


def _idle() -> dict:
    return {"status": "idle", "modelId": "", "url": "", "detail": "", "error": "",
            "downloaded": 0, "total": 0}


def _fetch_latest_llamacpp_tag() -> str:
    """The latest upstream llama.cpp release tag (e.g. "b9888") via the GitHub
    releases API. Used by `update_check` (A5) — injectable in tests and, in the
    dev container, unreachable through the egress proxy (ggml-org is out of
    scope there); the user's box calls it directly."""
    r = requests.get(
        "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest",
        headers={"User-Agent": "just-llm-runner"}, timeout=15,
    )
    r.raise_for_status()
    return str(r.json().get("tag_name") or "")


# Defect D (2026-07-22 pass-1 plan T4, flagged default 1 — user-blessed): how long an
# EXPLICIT stop outranks a zombie request's auto-reload. `ensure_model_ready` (the
# dispatch's ensure — trigger=ensure-ready) refuses to re-load a model stopped within
# this window; a direct user load() clears it (user intent wins). Protocol semantics
# (like retry counts), deliberately NOT a DB row.
_STOP_TOMBSTONE_S = 30.0


def _engine_idle() -> dict:
    # Separate channel from the model-load state (a model load must not clobber
    # engine-install progress, and vice-versa). status ∈ idle|installing|installed|error.
    return {"status": "idle", "detail": "", "error": "", "downloaded": 0, "total": 0}


# How long uninstall waits for an in-flight install thread to unwind after signalling
# cancel. The install's download polls its cancel_check every ~0.3 s and raises promptly,
# so this is generous; a slower-than-this unwind returns a "still cancelling" message
# rather than hanging the request.
ENGINE_INSTALL_JOIN_TIMEOUT = 20.0


def _rmtree_with_retry(path: Path, *, attempts: int = 5, delay: float = 0.2) -> bool:
    """Remove a directory tree, returning True iff it is gone afterwards. Windows can hold
    a just-released exe/DLL open for a moment after the process that used it exits, so a first
    rmtree can fail silently; retry a few times with a short `gc.collect()`-backed pause.
    Best-effort — it never raises; the caller checks the return and reports an honest error on
    a stuck dir."""
    for _ in range(attempts):
        shutil.rmtree(path, ignore_errors=True)
        if not path.exists():
            return True
        gc.collect()          # nudge any lingering handle's finalizer (frees the Windows lock)
        time.sleep(delay)
    return not path.exists()


class RunnerService:
    """Owns the long-lived llama-server ROUTER + the resident-model set.

    The router (spawned LAZILY on the first `load()`) keeps up to `models_max` models
    co-resident and routes each request by its `model` id; the manager emits the
    router's `--models-preset` `.ini` from the DB. Per-model status ∈ downloading |
    starting | running | error (the SAME vocabulary the single-model runner used, so
    `api.py`'s status mapping is unchanged); `status()` exposes a back-compat
    single-model view — the full resident set is P1f.

    Concurrency: `_lock` guards the fast resident-set queue mutations (load/download/
    install guards); `_router_lock` serializes the slow router process ops (spawn /
    bounce / emit / load) so two concurrent loads can't race the shared router.
    """

    def __init__(
        self,
        cache_root,
        *,
        runtime_root=None,
        config_fn=_default_config,
        hardware_fn=_detect,
        catalog_fn=_default_catalog_fn,
        switches_fn=_default_switches_fn,
        profile_switches_fn=_default_profile_switches_fn,
        identify_fn=_default_identify_fn,
        embedding_ids_fn=_default_embedding_ids_fn,
        default_llm_id_fn=None,
        acquire_binary=_acquire_binary,
        acquired_exe=acquired_server_exe,
        acquired_exes=acquired_server_exes,
        acquire_model=_acquire_model,
        read_meta=_read_gguf_metadata,
        start_router=_start_router,
        find_port=_find_free_port,
        router_load=_default_router_load,
        router_unload=_default_router_unload,
        router_models=_default_router_models,
        used_vram_fn=_hw_used_device_mem,
        now=time.monotonic,
        sleep=time.sleep,
        arbiter=None,
        latest_build_fn=None,
        knob_backends_fn=None,
        measurements_fn=None,
        class_bw_fn=None,
        record_probe_fn=None,
        record_load_fn=None,
        fit_relevant_flags_fn=None,
        declared_claim_fn=None,
    ):
        self._cache_root = Path(cache_root)
        # WHAT THIS APP GENERATES, split from what it merely caches. `cache_root` holds
        # artifacts that are identical for everyone who fetches them — `hf/` weights and
        # `llamacpp/<build>/` binaries — so it may be SHARED with a sibling family app.
        # `runtime_root` holds what this app WRITES from its own DB: the generated
        # `models.ini` and the per-spawn logs. Sharing THAT would have each app overwrite
        # the other's preset file, and a router bounce would then re-read a preset
        # describing somebody else's catalogue. Default = the legacy location inside the
        # cache, so an app with its own cache is byte-identical to before.
        self._runtime_root = Path(runtime_root) if runtime_root else self._cache_root / "llamacpp"
        self._config_fn = config_fn
        self._hardware_fn = hardware_fn
        self._catalog_fn = catalog_fn
        self._switches_fn = switches_fn
        self._profile_switches_fn = profile_switches_fn
        self._identify_fn = identify_fn
        self._embedding_ids_fn = embedding_ids_fn
        # The LOCAL chat default's catalog id ("" when the chat default is cloud/Ollama) —
        # the embed placement guarantee's static baseline (#274 half 2).
        self._default_llm_id_fn = default_llm_id_fn or (lambda: "")
        self._acquire_binary = acquire_binary
        self._acquired_exe = acquired_exe
        self._acquired_exes = acquired_exes
        self._acquire_model = acquire_model
        self._latest_build_fn = latest_build_fn or _fetch_latest_llamacpp_tag
        self._read_meta = read_meta
        self._start_router = start_router
        self._find_port = find_port
        self._router_load = router_load
        self._router_unload = router_unload
        self._router_models = router_models
        self._used_vram_fn = used_vram_fn
        # Pass 2 (2026-07-22): {flag_name → "cuda,rocm,…"} for knobs NOT applicable on
        # every engine family (host-wired from knob_catalog; None = no filtering —
        # standalone/tests unchanged). Consumed by _apply_backend_applicability.
        self._knob_backends_fn = knob_backends_fn
        # Fit-redesign Phase 3 (§5.5) — the bandwidth ladder's host-wired reads:
        # the measurement history (source 1 derivation + the persisted RAM-probe
        # row + the badge's measured-replaces-predicted), the class-seeded
        # bandwidths (source 3), and the probe recorder. All None standalone —
        # the ladder just resolves less and the badge shows no band.
        self._measurements_fn = measurements_fn
        self._class_bw_fn = class_bw_fn
        self._record_probe_fn = record_probe_fn
        # Fit-redesign Phase 5 (§6.2-6.4/§13.1-13.3) — the persistence + claim
        # seams: record_load_fn persists a confirmed load's footprint (+ the
        # observed overhead machine row) and prunes to keep-K; the fingerprint
        # SET comes from knob_catalog's fit_relevant classification;
        # declared_claim_fn answers a FOREIGN kind's declared claim (JV wires
        # its engine manifests there — the kit handles kind="llm" itself).
        # All None standalone: loads still true up in-memory, claims resolve
        # down to computed/declared exactly as before.
        self._record_load_fn = record_load_fn
        self._fit_relevant_flags_fn = fit_relevant_flags_fn
        self._declared_claim_fn = declared_claim_fn
        self._probe_lock = threading.Lock()
        self._probe_started = False
        self._probe_value: float | None = None
        self._now = now
        self._sleep = sleep
        self._load_poll_timeout = _LOAD_POLL_TIMEOUT
        self._load_poll_interval = _LOAD_POLL_INTERVAL
        # The VRAM-budget arbiter (P2): the shared per-app singleton unless a test injects one.
        self._arbiter = arbiter if arbiter is not None else _get_arbiter()
        # Router + resident set (replaces the single `_runner` + `_state`).
        self._router: RouterHandle | None = None
        self._resident: dict[str, dict] = {}   # model_id → back-compat state dict
        self._last_id: str = ""                 # primary for the back-compat status()
        self._last_ini_text: str = ""           # re-emit / bounce only on a real change
        # Defect D (2026-07-22 pass-1 plan T4): {model_id → self._now() at its last
        # EXPLICIT stop}. ensure_model_ready refuses a re-load inside the window;
        # a direct load() pops the stamp (user intent wins).
        self._stop_tombstones: dict[str, float] = {}
        # Defect C (2026-07-22 pass-1 plan T3): {model_id → the ModelIniEntry it was
        # ACTUALLY loaded with} — the single truth for HOW a resident model runs. The
        # emitter renders a resident co-model's section from THIS (never re-derived
        # from DB switch rows, which silently reverted ephemeral launch configs on any
        # later emit — the ctx-8192→131072 RAM exhaustion). Recorded at the confirmed
        # load (the FINAL entry, after any fit-retry/OOM-shed rebind); pruned against
        # `_resident` inside the emitter, so every removal path converges without
        # per-site mirror pops.
        self._active_entries: dict[str, ModelIniEntry] = {}
        self._engine_state = _engine_idle()
        self._lock = threading.Lock()           # resident-set queue mutations
        # RLock since the 2026-08-09 arbiter seam: the reservation's registered evictor
        # (_evict_from_arbiter) acquires this lock so a FOREIGN thread (a JV TTS admission
        # running make_room) evicts safely — and the runner's own _admit → make_room path
        # re-enters it on the same thread. Cross-thread serialization is unchanged.
        self._router_lock = threading.RLock()   # serialize router spawn/bounce/emit/load
        # T2 (2026-07-17 approved plan): one cancel token per IN-FLIGHT load. stop() on a
        # mid-load model SETS the event and returns at once (never touching _router_lock —
        # the old stop blocked behind the load's router ops for the whole VRAM phase); the
        # LOAD THREAD honors it at checkpoints and owns all cleanup. Guarded by _lock.
        self._cancel_events: dict[str, threading.Event] = {}
        self._thread = None
        self._engine_thread = None
        self._engine_cancel = threading.Event()  # set → the engine-install worker aborts mid-download
        # CONCURRENT model downloads (2026-07-20): each downloaded model gets its OWN map
        # entry + cancel Event + worker thread, so clicking Download on several models runs
        # them in parallel (the old single `_download_state` made the 2nd click a silent
        # no-op). ABSENT from `_download_states` == idle/done; an "error" entry PERSISTS until
        # a fresh download() replaces it. All three maps are guarded by `self._lock`.
        self._download_states: dict[str, dict] = {}   # modelId → {status, modelId, detail, error, downloaded, total}
        self._download_cancels: dict[str, threading.Event] = {}   # modelId → its cancel token
        self._download_threads: dict[str, threading.Thread] = {}  # modelId → its worker thread
        # Admission gate: a queued worker parks here until fewer than `download_max_concurrent`
        # downloads are RUNNING. Shares `self._lock` so the map reads/writes and the wait/notify
        # are one critical section; a completing worker notifies it to wake the next in line.
        self._download_gate = threading.Condition(self._lock)
        self._last_log_path = None
        # A3: the binary the CURRENT router actually launched with. A fallback
        # spawn may differ from the preferred build; bounces must reuse the
        # PROVEN exe, never re-try the broken preferred one mid-session.
        self._active_server_exe = None

    @property
    def cache_root(self) -> Path:
        """The runner's cache root (binaries + the `hf/` model cache live under
        it). Exposed so the catalog endpoint can check on-disk state without
        reaching into a private attr. MAY be shared with a sibling family app —
        everything under it is content-addressed by (repo, quant, snapshot) or by
        build number, so two apps fetching the same artifact fetch the same bytes."""
        return self._cache_root

    @property
    def runtime_root(self) -> Path:
        """Where THIS app's generated engine state lives — `models.ini` and the
        per-spawn `logs/`. Always app-private, even when the cache is shared."""
        return self._runtime_root

    def repoint_cache(self, cache_root, runtime_root=None) -> None:
        """Point this service at a different cache root, live. Raises if the engine is
        busy — the caller then tells the user it applies on the next start.

        Why not "restart required, always": the choice is offered during Quick Setup,
        BEFORE the first download, and its whole purpose is to stop a 14 GB model being
        fetched into the wrong place. A setting that needed a restart would be recorded
        and then immediately contradicted by the download the same wizard starts. Idle
        is the normal state at that moment.

        Nothing on disk moves. The previous cache keeps every byte it had, which is what
        makes the choice reversible."""
        with self._router_lock:
            if self._router is not None and self._router.is_alive():
                raise RuntimeError("the engine is running — unload the model first, or "
                                   "restart the app to apply this")
            if self._thread is not None and self._thread.is_alive():
                raise RuntimeError("a download or load is in progress — wait for it to "
                                   "finish, or restart the app to apply this")
            self._cache_root = Path(cache_root)
            self._runtime_root = Path(runtime_root) if runtime_root else self._cache_root / "llamacpp"
            # The emitter writes only when the render differs from what it last wrote;
            # against a NEW root that comparison is meaningless and would leave the new
            # location with no models.ini at all. The proven exe goes for the same
            # reason — its path pointed into the old cache.
            self._last_ini_text = ""
            self._active_server_exe = None
            log.info("engine cache re-pointed to %s (this app's generated state: %s)",
                     self._cache_root, self._runtime_root)

    def catalog(self) -> list[ModelEntry]:
        """Host-backed downloadable model catalog (DB via catalog_fn). Empty for
        standalone runner use (no host store wired) — the manifest's model list
        is gone (A7)."""
        return self._catalog_fn()

    @property
    def catalog_wired(self) -> bool:
        """Did a host actually supply a catalog source, or is this the standalone default?

        The two states LOOK identical from `catalog()` — both return `[]` — and that
        ambiguity is a real trap for a new consumer (2026-08-01 audit): mount the router,
        call `/v1/llm-runner/models`, get `{"models": []}`, and there is nothing to
        distinguish "you never called `configure_service(catalog_fn=…)`" from "your catalog
        is genuinely empty". JustVoice has been in the first state for months without
        noticing, because nothing in its UI reads the endpoint. Exposed so the endpoint can
        say which one it is instead of shrugging."""
        return self._catalog_fn is not _default_catalog_fn

    def config(self):
        """The runner config (binaries + VRAM margin): DB-backed in the host (via
        the injected config_fn), or the seed defaults standalone."""
        return self._config_fn()

    def measurement_rows(self) -> list:
        """The FULL measurement history (host-wired wire rows) — the bandwidth
        ladder's source-1 raw material + the badge's measured-replaces-predicted
        read. [] when unwired or the store hiccups (a badge read must never 500
        the catalog)."""
        if self._measurements_fn is None:
            return []
        try:
            return list(self._measurements_fn() or [])
        except Exception as e:  # noqa: BLE001 — display plumbing, never fatal
            log.debug("measurements read failed: %s", e)
            return []

    def class_bw(self, class_key_str: str) -> tuple[float, float]:
        """(vram_bw_gbps, ram_bw_gbps) of a class row — ladder source 3.
        (0, 0) when unwired/absent: the ladder skips, never fabricates."""
        if self._class_bw_fn is None:
            return (0.0, 0.0)
        try:
            vram_bw, ram_bw = self._class_bw_fn(class_key_str)
            return (float(vram_bw or 0.0), float(ram_bw or 0.0))
        except Exception as e:  # noqa: BLE001
            log.debug("class bandwidth read failed: %s", e)
            return (0.0, 0.0)

    def host_probe_bw_gbps(self, machine_key_str: str) -> float | None:
        """The RAM copy probe's GB/s for THIS box (§5.5 source 2, host pool).
        Reads the persisted machine measurement row first (one-time per box);
        absent → kicks the ~2 s probe ONCE per process on a background thread
        (the catalog poll must never block on it) and returns None until it
        lands. Clear-history deletes the row → the probe simply re-runs (§8.22
        self-heal)."""
        from .bandwidth import RAM_PROBE_LABEL, RAM_PROBE_MODEL_ID, probe_ram_copy_gbps

        for r in self.measurement_rows():
            if getattr(r, "modelId", "") == RAM_PROBE_MODEL_ID \
                    and getattr(r, "machineKey", "") == machine_key_str:
                return float(getattr(r, "tokensPerSec", 0) or 0) or None
        with self._probe_lock:
            if self._probe_started:
                return self._probe_value
            self._probe_started = True

        def _run() -> None:
            gbps = probe_ram_copy_gbps()
            if not gbps:
                return
            self._probe_value = gbps
            if self._record_probe_fn is not None:
                try:
                    self._record_probe_fn(gbps, machine_key_str, RAM_PROBE_MODEL_ID, RAM_PROBE_LABEL)
                except Exception as e:  # noqa: BLE001 — persistence is best-effort
                    log.debug("RAM probe record failed: %s", e)

        threading.Thread(target=_run, name="llm-runner-ram-probe", daemon=True).start()
        return None

    def status(self) -> dict:
        """Back-compat SINGLE-model view: the primary (most-recently-loaded) model's
        state, reconciled against a live router. The full resident-set shape lands on
        `/v1/llm-runner/resident` in P1f. A router that died while a model was resident
        surfaces as `error`."""
        st = self._resident.get(self._last_id)
        if st is None:
            return _idle()
        router = self._router
        if st.get("status") == "running" and (router is None or not router.is_alive()):
            st.update(status="error", error="llama-server router exited")
        return dict(st)

    def router_url(self) -> str:
        """Where the bundled engine is ACTUALLY listening (`http://host:port`, no
        `/v1`), or "" when no router is up.

        THE one answer to that question. The port is allocated at spawn
        (`find_free_port`), so a stored provider `baseUrl` — seeded with the preferred
        port — is a guess, and acting on a guess is how one app's chat request reached
        another app's router. `install_llm` points the dispatch seam here so the
        `local-llamacpp` adapter resolves per request instead of freezing a string at
        registry-build time."""
        router = self._router
        return router.url if router is not None and router.is_alive() else ""

    # ── Engine install — its OWN once-per-machine step, separate from loading a
    #    model (a load REQUIRES the engine present; see _run_load). ──────────────
    def _installed_build(self, config) -> str | None:
        """The build actually ON DISK (the installed exe's dir), or None when
        nothing is installed. QC-13: status, uninstall and the update check
        report/act on the disk truth — what is installed is a fact of the disk,
        while the pin is the user's CHOICE of what an install should fetch."""
        exe = self._acquired_exe(self.cache_root, config, self._hardware_fn())
        return build_of_exe(self.cache_root, exe) if exe else None

    def engine_status(self) -> dict:
        """Is the llama.cpp engine installed for THIS box? Reports the installed
        build/gpu, whether the exe + (on Windows CUDA) its cudart companion are
        present, and any in-flight install progress (`_engine_state`)."""
        config = self._config_fn()
        hardware = self._hardware_fn()
        exe = self._acquired_exe(self.cache_root, config, hardware)
        asset = select_binary(config, hardware)
        has_runtime = True
        if exe is not None and asset is not None and asset.runtime_url:
            # A Windows CUDA build needs the cudart DLLs unpacked next to the exe.
            has_runtime = any(exe.parent.glob("cudart*"))
        # Backend switcher (2026-07-14): the concrete variants ON DISK, the one the
        # router is actually running (or would select), the user's pinned family, and
        # the families offerable on this box (a detected runtime that also has a real
        # binary) — so the UI can render a truthful backend selector instead of a
        # phantom "available" label.
        try:
            acquired = self._acquired_exes(self.cache_root, config, hardware)
        except Exception:  # noqa: BLE001 — the probe must never break status
            acquired = []
        installed_gpus = [g for g, _ in acquired]
        active_gpu = ""
        if self._active_server_exe:
            active_gpu = next((g for g, e in acquired if str(e) == str(self._active_server_exe)), "")
        if not active_gpu:
            active_gpu = asset.gpu if asset else ""
        runtimes = hardware.runtimes or {}
        fams_with_binary = {
            gpu_family(b.gpu) for b in config.llamacpp.binaries
            if b.platform == hardware.platform and b.source != "docker"
        }
        offer_backends = [
            f for f in ("cuda", "rocm", "vulkan", "metal")
            if runtimes.get(f) and f in fams_with_binary
        ]
        return {
            "installed": exe is not None,
            "serverExe": str(exe) if exe else "",
            # QC-13: the build actually ON DISK (the exe's dir), which the pin may not
            # name; the pin is reported only when nothing is installed (then it's the
            # build an install would fetch). Folder and binary agree because the UI keeps
            # every stored download URL in lock-step with the pin.
            "build": (build_of_exe(self.cache_root, exe) if exe else None)
            or config.llamacpp.pinned_build,
            "gpu": asset.gpu if asset else "",
            "platform": hardware.platform,
            "hasRuntime": has_runtime,
            # Backend-switcher fields (concrete keys except preferredGpu = family).
            "installedGpus": installed_gpus,
            "activeGpu": active_gpu,
            "preferredGpu": config.preferred_gpu,
            "offerBackends": offer_backends,
            **self._engine_state,
        }

    def install_engine(self, force: bool = False, replace_build: str = "", gpu: str = "") -> dict:
        """Download + unpack the llama.cpp engine for this box (its OWN step, not
        folded into a model load). Idempotent unless `force`. Runs on a dedicated
        thread so it can't clobber an in-flight model load. `replace_build` (user,
        2026-07-07: "the engine update should delete the old folder"): the OLD
        pinned build this install SUPERSEDES — it gets models.ini carry PRIORITY.
        After ANY successful install, every stale build dir is swept (stop-first
        for the Windows exe lock; see _run_install's cleanup block). `gpu` (a
        FAMILY, 2026-07-14) targets ONE variant for the backend selector — a
        lightweight ADD into the pinned build, with no force-wipe and no sweep, so
        a working backend is never disturbed while the user tries another."""
        with self._lock:
            if self._engine_state["status"] == "installing":
                return dict(self._engine_state)
            self._engine_cancel.clear()  # arm a fresh run — drop any prior cancel signal
            self._engine_state = {"status": "installing",
                                  "detail": (f"{gpu} engine build" if gpu else "llama.cpp engine"),
                                  "error": "", "downloaded": 0, "total": 0}
            self._engine_thread = threading.Thread(
                target=self._run_install, args=(force, replace_build, gpu), daemon=True,
            )
            self._engine_thread.start()
        return dict(self._engine_state)

    def cancel_install_engine(self) -> dict:
        """Signal an in-flight engine install to stop at the next chunk boundary (the
        installer thread threads `self._engine_cancel.is_set` into acquire_binary's
        download, which raises DownloadCancelled). Idempotent: a no-op when nothing is
        installing. Mirrors cancel_download."""
        with self._lock:
            if self._engine_state["status"] == "installing":
                self._engine_cancel.set()
                self._engine_state["detail"] = "cancelling…"
        return dict(self._engine_state)

    def engine_log(self, tail: int = 200) -> dict:
        """Tail of the most recent llama-server spawn log (the 'view log'
        affordance) — empty when nothing has spawned yet."""
        path = self._last_log_path
        if not path or not Path(path).exists():
            return {"path": "", "text": ""}
        return {"path": str(path), "text": _tail_file(path, tail)}

    def uninstall_engine(self) -> dict:
        """Remove EVERY installed llama.cpp engine build (each build dir under `llamacpp/`,
        every per-GPU variant incl. the A3 fallback chain — the whole engine). Models in the
        HF cache are untouched; `logs/` and the loose `models.ini` are kept.

        Three fixes over the old one-dir version (all seen on the user's box, 2026-07-21):
        • It deleted only ONE resolved build — with two builds on disk (e.g. a b9993 left
          beside a b10075) it removed one, status re-resolved the other, and the UI stayed
          "Installed" (the button appeared to do nothing). Now it sweeps them ALL.
        • `shutil.rmtree(..., ignore_errors=True)` swallowed Windows lock failures silently
          (the "still present after cleanup (files in use?)" race). Now each delete retries
          the lock-release lag and, if a dir is STILL there, the call returns an honest
          `error` naming it instead of a false success.
        • It refused outright while an install was "installing" ("wait for it to finish") —
          during a crawling download that is never. Now it CANCELS the in-flight install and
          joins its thread (bounded) before deleting.

        Stops any running model first: a live llama-server holds its exe open, and Windows
        cannot delete an open exe."""
        # Cancel + join an in-flight install BEFORE touching the dirs it writes into. Signal
        # under the lock, join OUTSIDE it (the installer thread takes self._lock at its
        # checkpoints — joining while holding it would deadlock).
        install_thread = None
        with self._lock:
            if self._engine_state["status"] == "installing":
                self._engine_cancel.set()
                install_thread = self._engine_thread
        if install_thread is not None and install_thread.is_alive():
            install_thread.join(timeout=ENGINE_INSTALL_JOIN_TIMEOUT)
            if install_thread.is_alive():
                return {**self.engine_status(),
                        "error": "an install is still cancelling — try again in a moment"}
        self.stop()  # free the exe locks (a live llama-server holds its exe open on Windows)
        root = self.cache_root / "llamacpp"
        removed: list[str] = []
        stuck: list[str] = []
        if root.is_dir():
            for d in [d for d in root.iterdir() if d.is_dir() and d.name != "logs"]:
                (removed if _rmtree_with_retry(d) else stuck).append(d.name)
        with self._lock:
            self._engine_state = _engine_idle()
        if removed:
            log.info("engine uninstall: removed build(s) %s", ", ".join(sorted(removed)))
        if stuck:
            log.warning("engine uninstall: build(s) still locked after retry: %s", ", ".join(sorted(stuck)))
            return {**self.engine_status(),
                    "error": f"could not remove {', '.join(sorted(stuck))} — files in use; "
                             "close any running model and try again"}
        return self.engine_status()

    # ── Reclaim disk: the runner owns its cache, so it owns these deletes (the
    #    SIZES are reported by the shared platform GET /v1/disk/usage). ──────────
    def clear_spawn_logs(self) -> dict:
        """Delete every `*.log` under `<cache>/llamacpp/logs` (the per-spawn
        llama-server logs — UNBOUNDED; nothing else sweeps them). The dir itself is
        KEPT so the next spawn can write. Best-effort: a file that won't unlink (a
        live spawn holding it open on Windows) is skipped, never fatal. Returns
        `{removed, bytes}`."""
        logs_dir = self._runtime_root / "logs"
        removed = 0
        freed = 0
        if logs_dir.is_dir():
            for p in logs_dir.glob("*.log"):
                try:
                    size = p.stat().st_size
                    p.unlink()
                except OSError:
                    log.warning("could not remove spawn log %s", p, exc_info=True)
                    continue
                removed += 1
                freed += size
        return {"removed": removed, "bytes": freed}

    def clear_models_cache(self) -> dict:
        """Delete every downloaded model GGUF under `<cache>/hf`. SAFE BY DESIGN:
        the catalog rows live in the host DB, not here, so a cleared model simply
        RE-DOWNLOADS on demand the next time it is loaded — nothing here is
        unrecoverable.

        SAFETY GUARD: refuses (`ok: false`, "unload models first") while any model
        is resident or loading — its weights are open/mmap'd, and deleting them out
        from under a running llama-server would crash it (and on Windows an open
        file can't be unlinked). The caller unloads first, then retries. A
        download-only op runs on a separate channel invisible to `resident()`; that
        edge stays safe-by-design (the wipe just makes the download re-fetch)."""
        busy = {"loaded", "sleeping", "loading", "downloading", "starting"}
        in_use = [m.get("id") for m in self.resident().get("models", []) if m.get("status") in busy]
        if in_use:
            return {"ok": False, "detail": "unload models first", "models": in_use}
        # One walk, one source: the same size measurement the /v1/disk/usage panel shows.
        from ..platform.disk_api import dir_size

        hf = self._cache_root / "hf"
        freed = dir_size(hf)
        shutil.rmtree(hf, ignore_errors=True)
        try:
            hf.mkdir(parents=True, exist_ok=True)  # recreate empty so the next download has a home
        except OSError:
            log.warning("could not recreate empty hf cache dir at %s", hf, exc_info=True)
        return {"ok": True, "bytes": freed}

    def delete_model_cache(self, model_id: str) -> dict:
        """Delete THIS model's downloaded weights from `<cache>/hf` — the catalog 'Delete'
        reclaims disk, not just the DB row. Resolves the model's repo(s) from the catalog and
        removes each `models--<repo>` cache dir (blobs + snapshots + any same-repo MTP draft).
        SAFE BY DESIGN: the weights re-download on demand if the model is re-added.

        Frees the file handle first — cancels an in-flight download of this model, and unloads
        it when resident (its GGUF is mmap'd; an open file can't be unlinked on Windows). A repo
        still referenced by ANOTHER catalog row is KEPT (deleting it would strand that sibling's
        weights) and reported in `detail`. Idempotent: ok:True/bytes:0 when nothing is cached or
        the id is unknown (the row may already be gone). Best-effort unlink (locked file skipped)."""
        catalog = self.catalog()
        model = next((m for m in catalog if m.id == model_id), None)
        if model is None:
            return {"ok": True, "bytes": 0, "detail": "unknown model — nothing cached"}

        # Release any open handle before unlinking. Cancel a download of THIS model only
        # (other models may be downloading concurrently — leave them running), then join its
        # worker so its file handle is freed before rmtree. cancel_download(id) is a harmless
        # no-op when this model isn't downloading.
        self.cancel_download(model_id)
        t = self._download_threads.get(model_id)
        if t is not None:
            t.join(timeout=5)
        if model_id in {r.get("id") for r in self.resident().get("models", [])}:
            self.stop(model_id)

        freed, kept = self._purge_model_weights(model, catalog)
        result = {"ok": True, "bytes": freed}
        if kept:
            result["detail"] = "kept weights shared with another model: " + ", ".join(sorted(kept))
        return result

    def _purge_model_weights(self, model, catalog=None) -> tuple[int, list[str]]:
        """Delete `model`'s downloaded weights from `<cache>/hf` — its main repo dir plus a
        SEPARATE MTP-draft repo if the catalog pins one (a same-repo draft rides the main dir).
        Returns `(freed_bytes, kept_repos)`. A repo another catalog row still needs is KEPT
        (deleting it would strand that sibling's weights). Assumes the file handle is already
        free — the caller unloads / cancels any in-flight download first. Shared by
        `delete_model_cache` and the post-download integrity gate (`_verify_gguf`)."""
        from ..platform.disk_api import dir_size

        catalog = catalog if catalog is not None else self.catalog()
        repos = {model.hf_repo}
        draft_repo = getattr(model, "mtp_draft_repo", "") or ""
        if draft_repo:
            repos.add(draft_repo)

        hf = self._cache_root / "hf"
        freed = 0
        kept: list[str] = []
        for repo in repos:
            repo_dir = hf / ("models--" + repo.replace("/", "--"))
            if not repo_dir.is_dir():
                continue
            # KEEP a repo another catalog row still needs — those weights aren't ours to delete.
            shared = any(
                other.id != model.id
                and (other.hf_repo == repo or (getattr(other, "mtp_draft_repo", "") or "") == repo)
                for other in catalog
            )
            if shared:
                kept.append(repo)
                continue
            freed += dir_size(repo_dir)
            shutil.rmtree(repo_dir, ignore_errors=True)
        return freed, kept

    def _verify_gguf(self, model, gguf: Path) -> None:
        """Fail-fast integrity gate on a freshly-acquired main GGUF: parse its header (magic + KV).
        A corrupt / incomplete / zeroed download (or a missing file) fails the parse and is PURGED
        — so the next load or download re-fetches clean — then raised as an actionable
        `CorruptModelError`, rather than surfacing llama.cpp's raw "bad magic" or bricking the
        router upstream at spawn. Runs BEFORE spawn, when nothing has the file mmap'd, so the purge
        always succeeds. The header read is a few KB — it never scans the multi-GB body. `_read_meta`
        is the injected reader (fake in tests → this is a no-op offline), so only a REAL corrupt
        file trips it."""
        try:
            self._read_meta(gguf)  # magic + KV header; raises on bad magic / truncation / missing file
        except (ValueError, FileNotFoundError) as exc:
            # Parse-PROVEN corruption (bad magic / truncated header — gguf.py raises ValueError
            # for both) or a file the OS says is GONE (AV quarantine): purge + actionable error.
            log.warning("integrity check failed for %s at %s: %s", model.id, gguf, exc)
            try:
                self._purge_model_weights(model)
            except Exception:  # noqa: BLE001 — purge is best-effort; the actionable error still stands
                log.warning("could not purge corrupt weights for %s", model.id, exc_info=True)
            raise CorruptModelError(
                f'The downloaded file for "{model.name or model.id}" is corrupted or incomplete, '
                f"so it can't be loaded. It has been removed — re-download the model to repair it. "
                f"If this keeps happening, add your models folder to your antivirus exclusions.",
                model_id=model.id,
            ) from exc
        except OSError as exc:
            # Transient IO — a sharing violation / an AV scan holding the file open is NOT
            # corruption (2026-07-11 hardening): purging here would delete multi-GB GOOD
            # weights on a race. No purge; surface a retryable error instead.
            log.warning("integrity check could not read %s at %s: %s", model.id, gguf, exc)
            raise RuntimeError(
                f'Could not read the model file for "{model.name or model.id}" — it may be '
                f"locked by an antivirus scan or another program. Nothing was deleted; "
                f"try again in a moment."
            ) from exc

    def update_check(self) -> dict:
        """A5 (user "do", 2026-07-06): the latest upstream llama.cpp release vs the
        INSTALLED build. NEVER auto-applies — the pin is a VERIFIED pin (flag
        semantics move between builds: reasoning-budget, the ini fields, the
        PR#16653 --fit behavior were each verified AT a pin), so the surface is
        notify-then-deliberate-click. QC-25 (the user's box: a DB reset reverted
        the pin to b9899 under an installed b9934 and the app offered an "update"
        that would have DOWNGRADED): `current` is the build actually ON DISK —
        the same resolve engine_status reports — with the pin only as the
        nothing-installed fallback (it is then the build an install would fetch).
        This method never writes the pin — NOTHING does except the user (the
        engine-config PUT / the update flow's deliberate click). A network
        failure reports as an `error`, never as updateAvailable."""
        config = self._config_fn()
        current = self._installed_build(config) or config.llamacpp.pinned_build
        try:
            latest = self._latest_build_fn()
        except Exception as exc:  # noqa: BLE001 — any fetch failure = the same honest answer
            return {"current": current, "latest": "", "updateAvailable": False, "error": str(exc)}
        return {
            "current": current,
            "latest": latest,
            "updateAvailable": build_num(latest) > build_num(current),
            "error": "",
        }

    def load(
        self, model_id: str, overrides: Overrides | None = None,
        job_id: str | None = None, switches: dict[str, str] | None = None,
        trigger: str = "api",
    ) -> dict:
        """Make `model_id` resident in the router (spawning the router LAZILY on the
        first call). The in-flight guard is PER-MODEL now — loading a DIFFERENT model
        while one is loading proceeds (co-residence within `models_max`); a second load
        of the SAME in-flight model returns its current state. Heavy work runs on a
        background thread (`_run_load`).

        `trigger` names the ASK's origin in the log — "api" (a user's HTTP call, the
        default) / "ensure-ready" (dispatch's auto-load before a local AI run) /
        "ensure-embedding" / "autotune". Telemetry only, never behavior. Added
        2026-07-17: an unload-then-respawn hunt died because NOTHING recorded who asked
        for a load — every internal caller must pass its own name, so an unnamed caller
        showing up as "api" in a log stays a signal, not a lie."""
        # Log EVERY ask — including the warm no-op and in-flight returns below. The
        # respawn hunt needs the asks that DIDN'T start a load too.
        log.info("load %s (trigger=%s)", model_id, trigger)
        with self._lock:
            # Defect D (T4): a direct load is fresh intent — it clears the model's
            # stop-tombstone. (ensure_model_ready checks the tombstone BEFORE calling
            # load(), so this pop cannot defeat the ensure guard.)
            self._stop_tombstones.pop(model_id, None)
            cur = self._resident.get(model_id)
            if cur is not None and cur.get("status") in ("downloading", "starting"):
                return dict(cur)  # THIS model's load is already in flight
            # A plain re-load of an already-running model (no tuning) is idempotent — keep it warm
            # (touch the LRU) rather than re-POST /models/load and get a 400 "already loaded" from
            # the router, which would then error + RELEASE the reservation while the child is still
            # resident (a VRAM-ledger drift). A Lab re-tune (real overrides/switches/job) still
            # re-loads to apply the ephemeral .ini section. NB: the HTTP path (api.load_model) always
            # passes an Overrides() — empty when the body carries no tuning — so "no overrides" must
            # compare EQUAL to the default, not `is None` (which is only ever true for internal callers).
            # The router-liveness gate is essential: `_resident[id]=="running"` can be STALE after a
            # router crash (status() only reconciles the _last_id primary, not a co-resident like the
            # pinned embed), and swallowing a re-load then would never respawn the dead router — so a
            # re-load when the router is down MUST fall through to _run_load's recovery spawn.
            router = self._router
            no_tuning = (overrides is None or overrides == Overrides()) and not switches and not job_id
            if (cur is not None and cur.get("status") == "running" and no_tuning
                    and router is not None and router.is_alive()):
                self._last_id = model_id  # a re-load promotes to primary, as the non-guard path does
                self._arbiter.touch(model_id)
                return dict(cur)
            self._resident[model_id] = {"status": "downloading", "modelId": model_id, "url": "",
                                        "detail": "queued", "error": "", "downloaded": 0, "total": 0}
            # A FRESH event per load — never setdefault: a stale set event from a prior
            # cancelled load would silently self-cancel this one at the first checkpoint.
            self._cancel_events[model_id] = threading.Event()
            self._last_id = model_id
            log.info("load %s: starting load thread (trigger=%s)", model_id, trigger)
            self._thread = threading.Thread(
                target=self._run_load, args=(model_id, overrides or Overrides(), job_id, switches), daemon=True,
            )
            self._thread.start()
            return dict(self._resident[model_id])

    def _download_limit(self) -> int:
        """The admission ceiling, read LIVE at each gate check so the knob is tunable
        without a restart: `download_max_concurrent` clamped to [1, MAX_DOWNLOAD_CONCURRENT]
        (the same ONE-source clamp the config-API write path applies — a raw DB poke can't
        route around it)."""
        raw = getattr(self._config_fn(), "download_max_concurrent", DEFAULT_DOWNLOAD_MAX_CONCURRENT)
        try:
            return max(1, min(MAX_DOWNLOAD_CONCURRENT, int(raw)))
        except (TypeError, ValueError):
            return DEFAULT_DOWNLOAD_MAX_CONCURRENT

    def _await_slot(self, model_id: str, cancel_ev: threading.Event) -> None:
        """Park a queued download until a slot frees, then CLAIM it atomically. A slot is
        free when fewer than `_download_limit()` downloads are RUNNING (an entry whose detail
        has moved past "queued"). Re-checks its own cancel token every ~0.2 s so a cancel
        while QUEUED still takes effect; on admission flips the entry's detail to the running
        phase UNDER the lock so the running-count is race-free."""
        with self._download_gate:
            while True:
                entry = self._download_states.get(model_id)
                if entry is None or cancel_ev.is_set():
                    raise DownloadCancelled()   # cancelled (or removed) before we ever ran
                running = sum(1 for e in self._download_states.values()
                              if e.get("status") == "downloading" and e.get("detail") != "queued")
                if running < self._download_limit():
                    entry["detail"] = "model weights"   # claim the slot → now counted as running
                    return
                self._download_gate.wait(timeout=0.2)

    def download(self, model_id: str) -> dict:
        """Download a model's GGUF into the cache WITHOUT spawning it — the catalog's
        'Download' action, separate from 'Load'. Runs on its OWN per-model channel + thread
        (like engine-install) so it NEVER touches the running model's state: a download can
        proceed while another model is loaded, AND several models download concurrently (up
        to `download_max_concurrent`; the rest queue). Idempotent: a second click while THIS
        model is already downloading/queued returns its live state. A prior "error" entry is
        replaced by a fresh run. Does NOT require the engine installed (only loading does)."""
        with self._lock:
            entry = self._download_states.get(model_id)
            if entry is not None and entry.get("status") == "downloading":
                return dict(entry)   # already in flight (queued or running) — idempotent
            cancel_ev = threading.Event()
            self._download_cancels[model_id] = cancel_ev
            entry = {"status": "downloading", "modelId": model_id, "detail": "queued",
                     "error": "", "downloaded": 0, "total": 0}
            self._download_states[model_id] = entry   # replaces any prior "error" entry
            t = threading.Thread(target=self._run_download, args=(model_id,), daemon=True)
            self._download_threads[model_id] = t
            t.start()
            return dict(entry)

    def cancel_download(self, model_id: str | None = None) -> dict:
        """Signal a download-only op to stop at the next chunk/file boundary (a running
        worker polls `cancel_check` per chunk; a QUEUED one is woken and aborts before it
        runs). With `model_id` → cancel just that one; `None` → cancel ALL (the back-compat
        no-id path any engine-panel 'cancel everything' uses). Idempotent: unknown/idle ids
        are no-ops. Returns the full download_status() snapshot."""
        with self._lock:
            if model_id is not None:
                targets = [model_id]
            else:
                # ALL: every live cancel token PLUS any terminal (errored) row, so a
                # "cancel everything" genuinely empties the map instead of leaving dead
                # rows behind for the UI to keep rendering.
                targets = list(self._download_cancels.keys()) + [
                    mid for mid, e in self._download_states.items()
                    if e.get("status") == "error"
                ]
            for mid in targets:
                ev = self._download_cancels.get(mid)
                if ev is not None:
                    ev.set()
                e = self._download_states.get(mid)
                if e is None:
                    continue
                if e.get("status") == "downloading":
                    e["detail"] = "cancelling…"
                elif e.get("status") == "error":
                    # DROP a dead row (2026-07-24). An errored download has no worker to
                    # signal, so cancelling it used to be a pure no-op and the row stayed in
                    # the map forever — download_status() kept returning it, the UI's
                    # downloadingSet (which matches "downloading" OR "error") never reaped its
                    # task, and the catalog row was stuck showing a failure whose only action
                    # was Retry. Removing it here is what makes "dismiss" real. Only terminal
                    # rows are dropped; a live download is signalled, never deleted.
                    self._download_states.pop(mid, None)
            self._download_gate.notify_all()   # wake any parked (queued) workers to re-check
        return self.download_status()

    def download_status(self) -> dict:
        """Snapshot of EVERY in-flight/errored download keyed by model id — its own channel,
        separate from the model run-state (status()) and engine install. Shape:
        `{"downloads": {modelId: {status, modelId, detail, error, downloaded, total}}}`.
        An id ABSENT from the map is idle/done (its weights are on disk)."""
        with self._lock:
            return {"downloads": {mid: dict(e) for mid, e in self._download_states.items()}}

    def stop(self, model_id: str | None = None) -> dict:
        """`stop(id)` cancels an IN-FLIGHT load or unloads a resident model; `stop()`
        (no id — the back-compat `/v1/llm-runner/stop`) is a FULL teardown.

        T2 (2026-07-17 approved plan) — the three shapes:
        • MID-LOAD (`downloading`/`starting`): set the model's cancel token, mark
          `cancelling`, return AT ONCE — never touching `_router_lock` (the old stop
          blocked behind the load's router ops for the whole VRAM phase while the UI's
          "Cancelled" lied). The LOAD THREAD owns all cleanup at its checkpoints.
        • RESIDENT: mark `stopping` BEFORE the lock (visible even while queued), unload
          under it, then CONFIRM-UNLOAD — poll GET /models until the router agrees the
          model is gone, so "stop returned" can never flicker back to "● loaded" during
          child teardown. The final removal is a COMPARE-AND-POP: only the `stopping`
          entry THIS stop wrote is popped — a fresher `downloading` entry written by a
          concurrent load() (e.g. ensure_model_ready's auto-load) is left alone, else
          that load's thread would abort at its membership checkpoint and its waiter
          would die at the 180 s timeout.
        • Already `cancelling`/`stopping`: a double-stop is a no-op."""
        # The ask logs BEFORE any lock: a stop that then queues still lands in the log
        # at click time (2026-07-17 — timeline correlation was impossible before).
        log.info("stop %s", model_id or "<full teardown>")
        if model_id:
            # Defect D (T4): an EXPLICIT stop tombstones the model — ensure-ready
            # (a possibly-zombie request's auto-load) must not undo it for
            # _STOP_TOMBSTONE_S; a direct user load() pops the stamp.
            self._stop_tombstones[model_id] = self._now()
            st = (self._resident.get(model_id) or {}).get("status")
            if st in ("downloading", "starting"):
                ev = self._cancel_events.get(model_id)
                if ev is not None:
                    ev.set()
                self._touch(model_id, status="cancelling", detail="")
                return self.status()
            if st in ("cancelling", "stopping"):
                return self.status()  # a second click while the first resolves
            # Resident (or errored) → the unload path. The status write is UNLOCKED and
            # deliberate: a stop queued behind a load's router ops must already read
            # "stopping", not "● loaded" (the user's unload-×3, 2026-07-17).
            self._touch(model_id, status="stopping", detail="")
            with self._router_lock:
                router = self._router
                router_still_live = False  # timeout with the child still listed live (defect E)
                if router is not None and router.is_alive():
                    try:
                        self._router_unload(router.url, model_id)
                    except Exception:  # noqa: BLE001 — best-effort
                        log.warning("router unload %s failed", model_id, exc_info=True)
                    # Confirm-unload (bounded): the unload POST can return while the
                    # child is still exiting, and GET /models keeps saying loaded until
                    # it has — popping then would let the next poll paint "● loaded"
                    # again and invite the second click.
                    deadline = self._now() + 5.0
                    while True:
                        try:
                            live = _parse_router_models(self._router_models(router.url))
                        except Exception:  # noqa: BLE001 — router died mid-teardown = gone
                            break
                        if (live.get(model_id) or {}).get("value") not in ("loaded", "sleeping", "loading"):
                            break
                        if self._now() >= deadline:
                            # Defect E (2026-07-22, pass-1 plan T5): do NOT pop while the
                            # router still lists the child live — a ledger that says gone
                            # while the child serves on is the drift that later surfaces
                            # as "/models/load … already running". Keep the entry at
                            # "stopping"; resident()'s self-heal pops it the moment the
                            # router agrees the child is gone (its compare-and-pop).
                            router_still_live = True
                            log.warning("confirm-unload timeout: router still reports %s "
                                        "after unload — keeping 'stopping' for the reconcile", model_id)
                            break
                        self._sleep(self._load_poll_interval)
                with self._lock:
                    cur = self._resident.get(model_id)
                    if cur is not None and cur.get("status") == "stopping" and not router_still_live:
                        self._resident.pop(model_id, None)
                        if self._last_id == model_id:
                            self._last_id = next(iter(self._resident), "")
                # The OLD residency's reservation goes either way; a concurrent fresh
                # load reserves anew only after its own confirmed load (it cannot have
                # reserved yet — reserve happens under the router lock stop holds).
                self._arbiter.release(model_id)
        else:
            with self._router_lock:
                # Defect D (T4): a full teardown tombstones every resident model.
                now = self._now()
                for mid in list(self._resident):
                    self._stop_tombstones[mid] = now
                router = self._router
                if router is not None:
                    try:
                        router.stop()
                    except Exception:  # noqa: BLE001 — best-effort
                        pass
                self._router = None
                self._resident.clear()
                self._cancel_events.clear()
                self._arbiter.clear()  # full teardown → drop the whole VRAM ledger
                self._active_entries.clear()  # T3: nothing resident → no loaded-with configs
                self._last_ini_text = ""
                self._last_id = ""
        return self.status()

    def cached_path(self, model_id: str):
        """The model's on-disk GGUF path, or None (unknown id / not downloaded) — the
        one catalog+cache lookup, shared by preview_fit and the boot derive-backfill
        (identity.backfill_derived_from_cache, 2026-07-07)."""
        model = next((m for m in self.catalog() if m.id == model_id), None)
        if model is None:
            return None
        return cached_gguf_path(model.hf_repo, model.quant,
                                cache_root=self._cache_root / "hf", mmproj=model.mmproj)

    def preview_fit(self, model_id: str, switches: dict[str, str] | None = None) -> dict:
        """Pure fit PREVIEW for a CACHED model: block count / MoE-ness + the computed
        layer split for the given switches — no download, no spawn. The auto-tune
        sweep anchors its n-cpu-moe candidates on this (falling back to it when no
        tune pins the value). Errors soft: unknown / not-downloaded → ok:False.

        GROWN into the claim-resolver door at Phase 5 (§6.2 — the DO-NOT list
        forbids a second resolver standing beside this): every return now carries
        `claim` = {vramMb, ramMb, source, matches} resolved down the four-arm
        ladder (resident-live → persisted-measured → computed → declared), even
        for a not-downloaded model (the declared arm needs no file)."""
        model = next((m for m in self.catalog() if m.id == model_id), None)
        if model is None:
            return {"ok": False, "error": f"unknown model: {model_id}"}
        claim = self._resolve_claim(model, switches)
        gguf = self.cached_path(model_id)
        if gguf is None:
            return {"ok": False, "error": "model not downloaded", "claim": claim}
        try:
            ov = _switches_to_overrides(dict(switches) if switches else (self._switches_fn(model_id) or {}))
            # Mirror the `.ini` emitter's draft resolve (2026-07-19) so the PREVIEW's
            # layer split matches what the spawn will actually get: a wanted draft that
            # is on disk is charged to the fit; one not downloaded yet contributes
            # nothing, exactly like the emitter's strip branch.
            if _wants_draft(ov, model):
                cached_draft = self._cached_draft_path(model, self._cache_root / "hf")
                if cached_draft is not None:
                    ov.model_draft = str(cached_draft)
            meta = self._read_meta(gguf)
            draft_meta, draft_bytes = self._draft_fit_inputs(ov)
            cfg = self._config_fn()
            f = compute_fit(meta, gguf.stat().st_size, self._hardware_fn(), ov,
                            safety_margin_mb=cfg.safety_margin_mb,
                            ctx_cap_tokens=cfg.ctx_cap_tokens,
                            draft_meta=draft_meta, draft_bytes=draft_bytes)
        except Exception as exc:  # noqa: BLE001 — a preview must never raise into the sweep
            return {"ok": False, "error": str(exc), "claim": claim}
        return {"ok": True, "blockCount": f.block_count, "isMoe": f.is_moe,
                "nGpuLayers": f.n_gpu_layers, "nCpuMoe": f.n_cpu_moe, "ctxLen": f.ctx_len,
                "claim": claim}

    def _resolve_claim(self, model, switches: dict[str, str] | None = None) -> dict:
        """The four-arm claim ladder (§6.2; the INTERNAL engine `preview_fit`
        and `_embed_gpu_leftover_mb` share — the public door stays preview_fit):

            resident-live → persisted-measured → computed → declared

        Returns {vramMb, ramMb, source, matches}. The claim follows the RESOLVED
        DEVICE (a load at ngl 0 books 0 VRAM); ramMb is the §13.12 rule (file +
        headroom; display-only per §8.18) on every arm — measured rows don't
        capture RAM. Foreign kinds (JV's TTS/STT engines) come through the
        `declared_claim_fn` seam their wiring registers; this method is the
        kit's own kind="llm" path."""
        import statistics

        cfg = self._config_fn()
        size_mb = (model.size_bytes / 1e6) if model.size_bytes else None
        ram_mb = int(round(size_mb + max(0, cfg.ram_headroom_mb))) if size_mb \
            else int(model.min_ram_mb or 0)
        # Arm 1 — resident-live: the arbiter's booked number, with its §13.1
        # provenance (a measured true-up reads "measured"; a probe-less box's
        # booking reads "computed" — never dressed up).
        res = self._arbiter.reservation_of(model.id)
        if res is not None:
            return {"vramMb": int(res["vram_mb"]), "ramMb": ram_mb,
                    "source": res.get("source") or "computed", "matches": 0}
        gguf = self.cached_path(model.id)
        if gguf is not None:
            try:
                ov = _switches_to_overrides(dict(switches) if switches
                                            else (self._switches_fn(model.id) or {}))
                if _wants_draft(ov, model):
                    cached_draft = self._cached_draft_path(model, self._cache_root / "hf")
                    if cached_draft is not None:
                        ov.model_draft = str(cached_draft)
                meta = self._read_meta(gguf)
                draft_meta, draft_bytes = self._draft_fit_inputs(ov)
                hardware = self._hardware_fn()
                f = compute_fit(meta, gguf.stat().st_size, hardware, ov,
                                safety_margin_mb=cfg.safety_margin_mb,
                                ctx_cap_tokens=cfg.ctx_cap_tokens,
                                draft_meta=draft_meta, draft_bytes=draft_bytes)
                from .bandwidth import _norm_switches
                from .fit import PHYSICS_OVERHEAD_MB
                from .hardware import active_backend, machine_key as _mkey

                backend = active_backend(hardware)
                mkey = _mkey(hardware)
                fset = set()
                if self._fit_relevant_flags_fn is not None:
                    try:
                        fset = set(self._fit_relevant_flags_fn() or ())
                    except Exception:  # noqa: BLE001 — a store hiccup falls to computed
                        fset = set()
                rows = self.measurement_rows()
                # Arm 2 — persisted-measured: MEDIAN over fingerprint-matched
                # 'load' rows on THIS box + backend (§13.2). A fingerprint miss
                # falls to computed, full stop — the ctx-adjust cleverness was
                # CUT (§13.4). No fingerprint set wired → no matching possible.
                if fset:
                    want = tuple(sorted(
                        (k, v) for k, v in self._fit_config_switches(f, ov).items()
                        if k in fset))
                    matched = []
                    for r in rows:
                        if (getattr(r, "modelId", "") != model.id
                                or getattr(r, "machineKey", "") != mkey
                                or getattr(r, "backend", "") != backend
                                or getattr(r, "source", "") != "load"):
                            continue
                        mb = int(getattr(r, "vramModelMb", 0) or 0)
                        if mb <= 0:
                            continue
                        row_sw = _norm_switches({fl.flagName: fl.flagValue
                                                 for fl in (getattr(r, "switches", None) or [])})
                        got = tuple(sorted((k, v) for k, v in row_sw.items() if k in fset))
                        if got == want:
                            matched.append(mb)
                    if matched:
                        # A single row is usable but LOW-CONFIDENCE (§13.2) —
                        # `matches` says how much evidence stands behind it.
                        return {"vramMb": int(statistics.median(matched)), "ramMb": ram_mb,
                                "source": "measured", "matches": len(matched)}
                # Arm 3 — computed: the physics booking, with the LEARNED per-
                # (backend × machine × build) overhead replacing the seed when
                # true-ups have taught it (§13.2/§13.6; a build bump invalidates
                # old rows by label non-match — recalibration by construction).
                vram = float(f.vram_mb)
                if f.n_gpu_layers > 0 and vram > 0:
                    build = cfg.llamacpp.pinned_build
                    learned = [int(getattr(r, "vramModelMb", 0) or 0) for r in rows
                               if getattr(r, "modelId", "") == "__overhead__"
                               and getattr(r, "machineKey", "") == mkey
                               and getattr(r, "backend", "") == backend
                               and str(getattr(r, "label", "")).endswith(build)
                               and int(getattr(r, "vramModelMb", 0) or 0) > 0]
                    if learned:
                        seed = PHYSICS_OVERHEAD_MB.get(backend, PHYSICS_OVERHEAD_MB["cuda"])
                        vram = max(0.0, vram - seed + statistics.median(learned))
                return {"vramMb": int(round(vram)), "ramMb": ram_mb,
                        "source": "computed", "matches": 0}
            except Exception:  # noqa: BLE001 — a claim read must never raise into a caller
                log.debug("claim resolve fell to declared for %s", model.id, exc_info=True)
        # Arm 4 — declared: the catalog's price. For chat rows the WANT
        # (est_vram_mb) over the bare floor — the conservative pre-download
        # number the 2026-07-25 embed-guard ruling chose; understating here
        # re-opens the co-load crash class.
        rec = model.recommended_for
        declared = int((rec.est_vram_mb or rec.min_vram_mb) or 0)
        return {"vramMb": declared, "ramMb": ram_mb, "source": "declared", "matches": 0}

    def measure(
        self, *, prompt: str = "Write one vivid paragraph about the sea.",
        max_tokens: int = 128, probe=None, sample=None, model_id: str | None = None,
    ) -> dict:
        """Probe a RESIDENT model with a fixed prompt → decode tok/s + the box's resource
        context (#20 "Tune & measure"). `model_id` defaults to the primary (most-recently
        loaded); in router mode the probe routes by that id. Requires the model resident.
        The real tok/s is GPU-gated, but the timing math is not — `probe` / `sample` are
        injected in tests."""
        mid = model_id or self._last_id
        st = self._resident.get(mid)
        router = self._router
        if router is None or not router.is_alive() or not mid:
            return {"ok": False, "error": "no model running — load one first"}
        if st is None or st.get("status") != "running":
            # The internal ledger can be stale/reconciled while the child serves on —
            # observed 2026-07-21: BOTH bench legs' measures refused ("no model running")
            # while the router was serving every feature run fine, which is why the
            # summary's MTP-acceptance table came back empty. The ROUTER is the authority
            # on residency (the same source `resident()` reports and the bench polls), so
            # consult it before refusing; loaded OR sleeping counts (a sleeper wakes on
            # the probe request, exactly as it does for a real feature run).
            try:
                live = _parse_router_models(self._router_models(router.url))
            except Exception:  # noqa: BLE001 — router GET failed → the refusal stands
                live = {}
            live_status = str((live.get(mid) or {}).get("value") or "").lower()
            if live_status not in ("loaded", "sleeping"):
                return {"ok": False, "error": "no model running — load one first"}
            log.info(
                "measure: internal ledger says %r for %s but the router reports %r — "
                "proceeding on the router's authority",
                (st or {}).get("status"), mid, live_status)
        probe = probe or _default_measure_probe
        sample = sample or _default_measure_sample
        try:
            ct, ms, draft = probe(router.url, prompt, max_tokens, model_id=mid)
        except Exception as exc:  # noqa: BLE001 — surface the probe error, don't crash
            return {"ok": False, "error": str(exc)}
        tps = round(ct / (ms / 1000), 1) if ms > 0 and ct else 0.0
        self._arbiter.touch(mid)  # a measure is a use — keep it warm in the LRU
        out = {
            "ok": True, "modelId": mid,
            "tokensPerSec": tps, "completionTokens": ct, "ms": round(ms, 1), **sample(),
        }
        # Speculative-decoding acceptance (MTP, T3): present ONLY when the probe's
        # completion carried draft timings (spec actually ran). draftN==0 while a model is
        # MTP-configured is the "configured but not engaging" signal the bench flags.
        if draft is not None:
            n, acc = draft["n"], draft["accepted"]
            out["draftN"], out["draftNAccepted"] = n, acc
            out["draftAcceptance"] = round(acc / n, 4) if n > 0 else 0.0
        return out

    def tokenize(self, *, text: str, probe=None, model_id: str | None = None) -> dict:
        """Exact token count for `text` via a RESIDENT model's own tokenizer (b1/E2 — the
        prompt-preview's exact-when-local count). `model_id` defaults to the primary; the
        router routes /tokenize by that id. Requires the model resident; callers fall back
        to a client-side heuristic otherwise. `probe` injected in tests."""
        mid = model_id or self._last_id
        st = self._resident.get(mid)
        router = self._router
        if router is None or not router.is_alive() or st is None or st.get("status") != "running":
            return {"ok": False, "error": "no model running"}
        probe = probe or _default_tokenize_probe
        try:
            count = probe(router.url, text, model_id=mid)
        except Exception as exc:  # noqa: BLE001 — surface the probe error, don't crash
            return {"ok": False, "error": str(exc)}
        self._arbiter.touch(mid)  # a tokenize is a use — keep it warm in the LRU
        return {"ok": True, "count": int(count)}

    def resident(self, hw=None) -> dict:
        """The LIVE resident set for `GET /v1/llm-runner/resident`: the router's own
        `GET /models` view (per-model status + the `meta` footprint of a LOADED child), the
        two operator knobs that bound it (`models_max` / `sleep_idle_seconds`), and any
        in-flight load not yet visible to the router. Read-only, safe to poll. Snake_case
        keys matching `RunnerResidentResponse` (FastAPI emits camelCase). Router down (the
        lazy-spawn common case) → `router: False`, empty set. The per-model VRAM budget lands
        here in P2 (the arbiter)."""
        cfg = self._config_fn()
        snap = self._arbiter.snapshot(hw)  # committed/remaining/total budget (hw passed → no re-detect)
        out = {
            "router": False,
            "models_max": cfg.models_max,
            "sleep_idle_seconds": cfg.sleep_idle_seconds,
            "mem_arch": snap.get("mem_arch", "discrete"),
            "vram_total_mb": snap["vram_total_mb"],
            "committed_mb": snap["committed_mb"],
            "remaining_mb": snap["remaining_mb"],
            "models": [],
        }
        router = self._router
        live: dict[str, dict] = {}
        if router is not None and router.is_alive():
            out["router"] = True
            try:
                live = _parse_router_models(self._router_models(router.url))
            except Exception:  # noqa: BLE001 — a GET failure just yields an empty live set
                log.warning("GET /models failed while reading the resident set", exc_info=True)
        models: list[dict] = []
        by_id: dict[str, dict] = {}
        for mid, info in live.items():
            meta = info.get("meta") or {}
            row = {
                "id": mid,
                "status": info.get("value") or "unloaded",
                "n_params": meta.get("n_params"),
                "size_bytes": meta.get("size"),
                "n_ctx": meta.get("n_ctx"),
                "vram_mb": self._arbiter.reserved_mb(mid),  # GPU-resident VRAM the arbiter reserved
            }
            models.append(row)
            by_id[mid] = row
        # Overlay OUR in-flight ledger onto the router's view. Two cases:
        #  • The router doesn't list the id (never spawned — e.g. engine-not-installed
        #    errors, or a load mid-download with the router down): APPEND it, as ever.
        #  • The router DOES list the id but as IDLE: our in-flight status OVERRIDES it.
        #    The router lists EVERY preset model, loaded or not — so the old `if mid in
        #    seen: continue` masked the WHOLE pre-router phase of a load (disk check,
        #    fit, .ini emit, lock wait) behind the router's stale "unloaded", and the
        #    catalog's Load button looked dead while the load was already running (the
        #    user's 3-click repro, 2026-07-17). An ACTIVE router state (loaded|sleeping|
        #    loading) is the child's own truth and always wins the other way.
        # Snapshot to a list: `_evict_resident` pops `_resident` from the load thread under
        # `_router_lock`, so iterating the live dict here (the API thread) could raise "dict changed
        # size"; `list(...)` is atomic under the GIL, giving a stable view without a shared lock.
        for mid, st in list(self._resident.items()):
            s = st.get("status")
            if s not in ("downloading", "starting", "error", "cancelling", "stopping"):
                continue
            row = by_id.get(mid)
            router_live = row is not None and row["status"] in ("loaded", "sleeping", "loading")
            # SELF-HEAL a stuck "Unloading…" (2026-07-21): a "stopping" model the ROUTER no longer
            # reports as live (gone from its list, or listed as "unloaded") has ACTUALLY unloaded —
            # do NOT keep painting a phantom "Unloading…". Its ledger entry is cleaned by stop()'s
            # compare-and-pop, but that runs AFTER stop() acquires `_router_lock`, which a slow/hung
            # load can hold — so a cancelled/evicted model showed "Unloading…" indefinitely. Once the
            # router confirms it's gone, drop it here so the UI clears at once (the router's own
            # "unloaded" row, if present, stays → the catalog renders it Downloaded/idle, correct).
            if s == "stopping" and not router_live:
                # …and CONVERGE THE LEDGER (defect E, 2026-07-22 pass-1 plan T5):
                # stop()'s confirm-unload timeout now KEEPS the entry at "stopping"
                # instead of popping while the router still lists the child (the old
                # "popping anyway" — the drift that later answered a load with
                # "already running"). Once the router agrees the child is gone, THIS
                # is the one cleanup. Compare-and-pop under the lock: a concurrent
                # fresh load() has already overwritten the entry ("downloading"), so
                # the guard refuses and nothing is lost.
                with self._lock:
                    cur = self._resident.get(mid)
                    if cur is not None and cur.get("status") == "stopping":
                        self._resident.pop(mid, None)
                        if self._last_id == mid:
                            self._last_id = next(iter(self._resident), "")
                continue
            if row is None:
                models.append({"id": mid, "status": s, "vram_mb": self._arbiter.reserved_mb(mid)})
            elif s == "stopping" or row["status"] not in ("loaded", "sleeping", "loading"):
                # T2b: while the child is genuinely tearing down (router still "loaded"),
                # "stopping" overrides that active listing so a stale "● loaded" can't re-invite
                # a second Unload click. Bounded: cleared the moment the router agrees (above).
                row["status"] = s
        out["models"] = models
        return out

    def ensure_embedding(self) -> dict:
        """Make the configured local embedding model resident + PINNED, downloading its GGUF first if
        needed — the LAZY trigger the host (JustWrite RAG "Build index" / Chat-with-book) calls before
        it uses local embeddings. The embed request path hits the router directly (the OpenAI-compat
        adapter → :8080/v1/embeddings), so the embed must already be resident; this is what makes it
        so. No local embed configured (routing points at Ollama/cloud, or none set) → `{"ok": False}`
        and the caller falls back to that provider unchanged (JV, which uses no embeddings, never calls
        this). Delegates to `load()` (download-if-needed + lazy-spawn the router + reserve PINNED via
        `_run_load`); idempotent + cheap when the embed is already resident. Returns IMMEDIATELY (the
        load runs on a background thread): the caller polls `GET /v1/llm-runner/resident` for the
        returned `modelId` until it reads loaded|sleeping before embedding."""
        embed_ids = self._embedding_ids_fn()
        if not embed_ids:
            return {"ok": False, "detail": "no local embedding model configured"}
        embed_id = next(iter(embed_ids))
        state = self.load(embed_id, trigger="ensure-embedding")
        return {"ok": True, "modelId": embed_id, **state}

    def _resident_ready(self, model_id: str) -> bool:
        """True when `model_id` is resident AND its router child is loaded|sleeping —
        i.e. the internal load reached `running` (set ONLY after `_confirm_load` saw the
        router report loaded|sleeping) and the router is still alive. Same lock-free
        best-effort read `status()`/`resident()` do; drives ensure_model_ready's
        already-ready fast path and its poll-success test."""
        st = self._resident.get(model_id)
        if st is None or st.get("status") != "running":
            return False
        router = self._router
        return router is not None and router.is_alive()

    def ensure_model_ready(self, model_id: str, timeout_s: float = 180.0) -> None:
        """BLOCK until `model_id` is resident (loaded|sleeping), driving the SAME load
        path `ensure_embedding` uses — download-if-needed + lazy-spawn the router +
        reserve — differing only in that this WAITS for the child instead of returning
        immediately. The server-side twin of the kit's ensure-embedding, so a LOCAL
        chat/feature/Lab run no longer dies with "Connection refused" when the built-in
        router/model isn't up yet (QC-43b).

        Falsy id → immediate no-op (the caller resolved to a non-local / empty model).
        Already resident+ready → immediate return, no reload. Raises RuntimeError on a
        failed/error load or when the model isn't ready within `timeout_s`. Runs on the
        CALLER's thread (dispatch calls it via asyncio.to_thread); the actual load runs
        on the service's own background thread, whose `_resident` state this polls every
        ~1s through the injected clock (deterministic offline, like `_confirm_load`)."""
        if not model_id:
            return
        if self._resident_ready(model_id):
            return
        # Defect D (2026-07-22 pass-1 plan T4): an EXPLICIT stop outranks a zombie
        # request. The 07:00 incident: the bench client died mid-chat, its server-side
        # dispatch kept retrying, and every user stop was answered ten seconds later by
        # this ensure re-loading a 21 GB model. Inside the tombstone window the ensure
        # REFUSES instead — the user starts the model again from the app if they meant to
        # (any direct load() clears the stamp; expiry is _STOP_TOMBSTONE_S).
        ts = self._stop_tombstones.get(model_id)
        if ts is not None and (self._now() - ts) < _STOP_TOMBSTONE_S:
            raise RuntimeError(
                f'the local model "{model_id}" was just stopped — '
                f"start it again from the app to use it"
            )
        # Same path ensure_embedding uses: download-if-needed + lazy-spawn the router
        # + reserve, on the background load thread. A re-load of an already-in-flight /
        # running model is idempotent inside load() (and its router-liveness gate
        # respawns a dead router), so this is safe whatever state the model is in.
        # This is THE auto-load a manual Unload races (2026-07-17): any pending local
        # AI run re-loads its model here, by design — the trigger names it in the log.
        self.load(model_id, trigger="ensure-ready")
        deadline = self._now() + timeout_s
        while True:
            if self._resident_ready(model_id):
                return
            st = self._resident.get(model_id) or {}
            if st.get("status") == "error":
                raise RuntimeError(
                    f'The local model "{model_id}" failed to load: '
                    f'{st.get("error") or "unknown error"}'
                )
            if self._now() >= deadline:
                raise RuntimeError(
                    f'Timed out preparing the local model "{model_id}" after {int(timeout_s)}s.'
                )
            self._sleep(self._load_poll_interval)

    # ── internals ─────────────────────────────────────────────────────────

    def _main_gguf(self, snapshot_dir, quant: str) -> Path:
        # Word-bounded quant match (the ONE `_quant_matches` rule, shared with
        # select_files/cached_gguf_path) — a plain substring would resolve quant
        # "Q2_0" to a co-cached "…-PQ2_0.gguf" (sorts first) and load the WRONG file.
        cands = sorted(
            p for p in Path(snapshot_dir).rglob("*.gguf") if _quant_matches(quant, p.name)
        )
        if not cands:
            raise FileNotFoundError(f"no .gguf for quant {quant!r} in {snapshot_dir}")
        return cands[0]  # first shard of a split model loads the rest

    @staticmethod
    def _cached_draft_path(model, hf_cache: Path) -> Path | None:
        """The on-disk path of a model's declared MTP draft file, or None when not
        downloaded — the acquire-free sibling of the `_run_load` draft acquire
        (the snapshot preserves the draft's relative path, so an exact join per
        snapshot dir suffices; no name matching)."""
        repo = getattr(model, "mtp_draft_repo", "") or model.hf_repo
        snaps = hf_cache / ("models--" + repo.replace("/", "--")) / "snapshots"
        if not snaps.is_dir():
            return None
        for snap in sorted(snaps.iterdir()):
            p = snap / model.mtp_draft_file
            if p.exists():
                return p
        return None

    def acquire_draft_file(self, repo: str, file: str, cancel_check=None,
                           on_progress=None) -> Path:
        """THE draft-GGUF fetch: acquire ONE draft by exact path, return where it landed.

        The single body behind BOTH consumers — `_acquire_and_identify`'s configured-draft
        leg (load + download) and the auto-tune sweep's A/B trials, which measure
        alternates the catalog row does not name. It owns the whole rule, not just the
        `_acquire_model` call: the file path is its own selector, the snapshot preserves
        relative paths so an exact join resolves it, and a snapshot that lacks the file
        after a fetch is FAIL-LOUD (never a silent drop to no-MTP — the user asked for
        MTP). Keeping the join + that check in one place is the point; they were briefly
        duplicated here and drifting was only a matter of time. Downloads into the normal
        HF cache, so delete-model-cache / Reclaim disk semantics are unchanged."""
        cancel_kw = {"cancel_check": cancel_check} if cancel_check is not None else {}
        snapshot = self._acquire_model(
            repo, file, None, cache_root=self._cache_root / "hf", on_progress=on_progress,
            **cancel_kw, **download_kwargs(self._config_fn()),
        )
        path = Path(snapshot) / file
        if not path.exists():
            raise FileNotFoundError(
                f"MTP draft downloaded but not found in the snapshot: {file!r}"
            )
        return path

    def _draft_fit_inputs(self, ov) -> tuple:
        """`(draft_meta, draft_bytes)` for `compute_fit` when the resolved config pins a
        draft GGUF path, else `(None, 0)` — THE one reader shared by the three fit sites
        (active load · `.ini` emit · `preview_fit`), so a draft's VRAM can never be
        counted by one and missed by another (2026-07-19). Keyed on `ov.model_draft`,
        which each site has already resolved to a real on-disk path by the time it
        computes a fit. Best-effort: an unreadable header yields no term rather than
        failing the caller — the load path's own fail-loud acquire covers a genuinely
        missing draft, and the spawn OOM back-off remains the safety net."""
        path = getattr(ov, "model_draft", "") or ""
        if not path:
            return None, 0
        try:
            p = Path(path)
            return self._read_meta(p), p.stat().st_size
        except Exception:  # noqa: BLE001 — a fit input, never a load blocker
            log.warning("draft header read failed for %r — its VRAM is not charged to "
                        "the fit", path, exc_info=True)
            return None, 0

    def model_downloaded(self, m, hf_cache) -> bool:
        """Is this catalog model FULLY downloaded — main weights AND, when the resolved
        config wants an external MTP draft, the draft too? THE catalog badge's source of
        truth (replaces a raw `is_cached`, which saw only the main weights and so read
        "Downloaded ✓" for an MTP model still missing its draft). Called per row per
        /models poll — switch resolution here is pure DB reads (`_switches_fn`),
        acceptable at catalog scale."""
        if not is_cached(m.hf_repo, m.quant, cache_root=hf_cache, mmproj=m.mmproj):
            return False
        ov = _switches_to_overrides(self._switches_fn(m.id) or {})
        return not _wants_draft(ov, m) or self._cached_draft_path(m, hf_cache) is not None

    def _runner_log_path(self, model_id: str) -> Path:
        """Per-load log file — real `start_runner` creates the dir + redirects the
        merged stdout/stderr here (tailed on failure + by `engine_log`)."""
        safe = "".join(c if c.isalnum() or c in "-_." else "_" for c in model_id)[:60]
        ts = time.strftime("%Y%m%d-%H%M%S")
        return self._runtime_root / "logs" / f"runner-{safe}-{ts}.log"

    def _router_log_path(self) -> Path:
        """The router's merged stdout/stderr log (tailed on a failed spawn + by
        `engine_log`; a child's CUDA-OOM abort typically surfaces here)."""
        ts = time.strftime("%Y%m%d-%H%M%S")
        return self._runtime_root / "logs" / f"router-{ts}.log"

    def _run_install(self, force: bool, replace_build: str = "", gpu: str = "") -> None:
        try:
            config = self._config_fn()
            hardware = self._hardware_fn()

            def _progress(downloaded: int, total: int | None) -> None:
                self._engine_state["downloaded"] = downloaded
                self._engine_state["total"] = total or 0

            # Backend switch/add (2026-07-14): install ONE specific variant into the
            # pinned build for the acceleration-backend selector — a targeted ADD, NOT a
            # full (re)install. No force-wipe, no stale-build sweep, so a working backend
            # (and the other coexisting variants) is never disturbed while the user tries
            # another. `gpu` is a FAMILY ("cuda"/"vulkan"); resolve it to this box's
            # concrete asset key first.
            if gpu:
                concrete = concrete_gpu(hardware, gpu)
                self._engine_state["detail"] = f"{concrete or gpu} engine build"
                self._acquire_binary(self.cache_root, config, hardware,
                                     on_progress=_progress, gpu=concrete,
                                     cancel_check=self._engine_cancel.is_set)
                self._engine_state = {"status": "installed", "detail": "", "error": "",
                                      "downloaded": 0, "total": 0}
                return

            # NO pre-delete of the live build on force (2026-07-21): acquire_binary now stages
            # the download, launch-verifies it, and only ATOMICALLY swaps it in on success — so
            # a failed/broken update can no longer wipe a working engine and strand the box on a
            # build that won't launch. `force` makes it re-fetch even when a variant exists.
            self._acquire_binary(self.cache_root, config, hardware, on_progress=_progress,
                                 cancel_check=self._engine_cancel.is_set, force=force)
            # A3-REVISED (user, 2026-07-07: "you are downloading cpu version when i have
            # nvidia card, we do not even use cpu version"): the CPU build is NO LONGER
            # pre-downloaded as a universal fallback — a multi-hundred-MB download the
            # spawn never uses in practice. The A3 spawn retry chain simply degrades to
            # fewer local candidates (it already tolerates an absent extra). The one
            # KEPT extra is Vulkan on a ROCm pick (AMD's rocm→vulkan fallback is real).
            # BEST-EFFORT: a failed extra never fails the install — the selected build
            # above is the one that gates "installed".
            selected = select_binary(config, hardware)
            extras: list[str] = []
            if selected is not None and selected.gpu == "rocm":
                extras.append("vulkan")
            for gpu in extras:
                try:
                    self._engine_state["detail"] = f"fallback build ({gpu})"
                    self._acquire_binary(self.cache_root, config, hardware,
                                         on_progress=_progress, gpu=gpu,
                                         cancel_check=self._engine_cancel.is_set)
                except DownloadCancelled:
                    raise  # a user cancel aborts the whole install, not a best-effort miss
                except Exception:  # noqa: BLE001 — the net is a bonus, never a blocker
                    log.warning("fallback build %s failed to install (spawn chain will "
                                "have fewer candidates)", gpu, exc_info=True)
            # An UPDATE replaces the old build (user, 2026-07-07) — generalized to EVERY
            # stale build dir (a DB reset can re-pin an older build and strand folders):
            # after the new build is fully in place, every OTHER build dir under
            # llamacpp/ is removed ("logs" and loose files — the app's generated
            # models.ini sibling — are never touched). A hand-maintained models.ini
            # living INSIDE a removed build dir (the manual-router layout) is carried
            # into the new build dir first; `replace_build` (the update's superseded
            # pin) has carry priority. STOP-FIRST (the uninstall precedent: "a live
            # llama-server holds its exe open, and Windows cannot delete an open exe"):
            # a router still running an old build's exe would make the delete fail
            # SILENTLY on Windows, so the engine stops before the sweep — an engine
            # swap wants the router respawned on the NEW build anyway (it respawns
            # lazily at the next load). BEST-EFFORT: cleanup never fails a completed
            # install.
            root = self.cache_root / "llamacpp"
            keep = {config.llamacpp.pinned_build, "logs"}
            stale = [d for d in root.iterdir() if d.is_dir() and d.name not in keep] if root.is_dir() else []
            if stale:
                try:
                    self._engine_state["detail"] = "removing old builds"
                    self.stop()  # free exe locks; the router respawns on the new build at the next load
                    new_dir = binary_dir(self.cache_root, config.llamacpp.pinned_build)
                    if not (new_dir / "models.ini").is_file():
                        candidates = sorted(stale, reverse=True)  # newest build name first
                        if replace_build:
                            pref = binary_dir(self.cache_root, replace_build)
                            if pref in candidates:
                                candidates.remove(pref)
                                candidates.insert(0, pref)
                        for d in candidates:
                            ini = d / "models.ini"
                            if ini.is_file():
                                self._engine_state["detail"] = "carrying models.ini over"
                                shutil.copy2(ini, new_dir / "models.ini")
                                break
                    for d in stale:
                        self._engine_state["detail"] = f"removing old build {d.name}"
                        # Same robust delete as uninstall (ONE source): a just-superseded build's
                        # exe/DLL can stay locked for a moment on Windows after the router exits,
                        # so a bare rmtree warns spuriously (the user's log showed exactly this
                        # "still present after cleanup" line for b9993). Retry the lock lag; only a
                        # genuine survivor warns. Best-effort — a straggler never fails the install.
                        if not _rmtree_with_retry(d):
                            log.warning("old engine build %s still present after cleanup (files in use?)", d.name)
                except Exception:  # noqa: BLE001 — cleanup is best-effort, never install-fatal
                    log.warning("old engine build cleanup failed", exc_info=True)
            # #138 (user screenshot, 2026-07-07): a load attempted BEFORE the engine
            # existed parks that model at status=error ("Install the engine first"),
            # and nothing cleared it when the install completed — the grid kept the
            # red "install engine ↑" (and hid the row's Unload) on a working box.
            # Drop error-status entries now: they were attempts under a missing/old
            # engine; the next use retries fresh.
            with self._router_lock:
                stale_errors = [m for m, st in self._resident.items() if st.get("status") == "error"]
                for mid in stale_errors:
                    self._resident.pop(mid, None)
                    self._arbiter.release(mid)
            if stale_errors:
                log.info("engine install: cleared %d stale model error state(s)", len(stale_errors))
            self._engine_state = {"status": "installed", "detail": "", "error": "",
                                  "downloaded": 0, "total": 0}
        except DownloadCancelled:
            # A user cancel is not an error — restore the not-installed idle state. The
            # partial archive stays on disk, but a FRESH install re-fetches from the start:
            # acquire_binary's single-stream fetch truncates dest, and the segmented path
            # re-preallocates + resets its per-segment offsets to 0 (segment_retries only
            # resume WITHIN one call), so there is no cross-call resume — the next install
            # overwrites the partial. Mirrors _run_download's cancel handling.
            log.info("engine install cancelled")
            self._engine_state = _engine_idle()
        except Exception as exc:  # noqa: BLE001 — any failure becomes error state
            log.exception("engine install failed")
            self._engine_state = {"status": "error", "detail": "", "error": str(exc),
                                  "downloaded": 0, "total": 0}

    def _acquire_and_identify(self, model_id: str, on_progress, cancel_check=None,
                              *, overrides=None, on_progress_draft=None, reset_progress=None,
                              skip_if_cached=False):
        """Shared download IO for load + download (ONE source, main + draft): resolve the
        catalog model, fetch its GGUF into the cache, ground the catalog `type` (moe|dense)
        from the file, and — when `_wants_draft(overrides, model)` — fetch the model's
        EXTERNAL MTP draft too via the SAME acquire path, so download and load pull the
        identical bytes ("Downloaded ✓" is honest; first load never surprise-fetches).
        Returns (model, gguf_path, draft_path_or_None); raises ValueError for an unknown
        model. `on_progress(downloaded, total)` reports main-weight bytes to the CALLER's
        channel; `on_progress_draft` the draft leg's; `reset_progress` (optional) zeroes
        the neutral phase between the two legs. `cancel_check` is polled per chunk on BOTH
        legs → raises DownloadCancelled (the two callers pass DIFFERENT cancel tokens)."""
        # The downloadable catalog is HOST-OWNED (DB-backed via .catalog()).
        model = next((m for m in self.catalog() if m.id == model_id), None)
        if model is None:
            raise ValueError(f"unknown model {model_id!r}")

        # FAST PATH (2026-07-21, LOAD only — the user's "don't rerun what we don't have to"):
        # the weights are already on disk → skip the HF resolve (select_files' two API
        # round-trips: revision-sha + tree) AND the download. The load never needs their output —
        # the GGUF is resolved by _main_gguf's on-disk rglob and the router .ini takes the ABSOLUTE
        # path; only the download DECISION + upstream-freshness used the API, and an on-disk model
        # needs neither (Re-download forces a refresh). Gated to the LOAD via `skip_if_cached`; the
        # DOWNLOAD endpoint always does the full acquire (that's its whole job). The gate matches
        # the "Downloaded ✓" badge's OWN parts (cached_gguf_path + the draft check) so the two can
        # never disagree; _verify_gguf below stays the integrity gate — a corrupt/partial cache
        # still fails loud → purge → re-download.
        if skip_if_cached:
            hf_cache = self._cache_root / "hf"
            wants_draft = _wants_draft(overrides, model)
            cached_gguf = cached_gguf_path(model.hf_repo, model.quant, cache_root=hf_cache, mmproj=model.mmproj)
            cached_draft = self._cached_draft_path(model, hf_cache) if wants_draft else None
            if cached_gguf is not None and (not wants_draft or cached_draft is not None):
                self._verify_gguf(model, cached_gguf)
                try:
                    self._identify_fn(model_id, cached_gguf)
                except Exception:  # noqa: BLE001 — identification is advisory only
                    log.warning("model type auto-detect failed for %s", model_id, exc_info=True)
                return model, cached_gguf, (cached_draft if wants_draft else None)

        # Pass cancel_check ONLY when supplied (the download-only path) so the load
        # path's call signature is unchanged — it never cancels through here.
        cancel_kw = {"cancel_check": cancel_check} if cancel_check is not None else {}
        snapshot = self._acquire_model(
            model.hf_repo, model.quant, model.mmproj, cache_root=self._cache_root / "hf",
            on_progress=on_progress, **cancel_kw, **download_kwargs(self._config_fn()),
        )
        gguf = self._main_gguf(snapshot, model.quant)
        # Integrity gate (fail-fast): a corrupt / incomplete download is purged + raised as an
        # actionable CorruptModelError HERE — before _read_meta's raw "bad magic" or a router
        # spawn that would brick the whole :8080 upstream. This is the ONE download chokepoint,
        # so it covers BOTH the load (_run_load) and download-only (_run_download) channels.
        self._verify_gguf(model, gguf)
        # Best-effort: auto-detect the catalog `type` (moe|dense) from the downloaded
        # GGUF so a user-added model's switch presets are grounded in the file, not a
        # hand-typed guess. Never fail the caller on this.
        try:
            self._identify_fn(model_id, gguf)
        except Exception:  # noqa: BLE001 — identification is advisory only
            log.warning("model type auto-detect failed for %s", model_id, exc_info=True)
        # Gemma-style external MTP: the model declares a SEPARATE draft GGUF (catalog
        # mtp_draft_* facts). When the resolved config wants draft-mtp and nothing set
        # model_draft explicitly, fetch it next to the main weights through
        # `acquire_draft_file` — THE one draft-fetch body (path-as-selector, snapshot
        # join, fail-loud check), shared with the auto-tune sweep's draft A/B so the two
        # cannot drift. A draft failure fails the CALLER with the real reason, never a
        # silent drop to no-MTP. The load path then points --model-draft at the result.
        draft_path = None
        if _wants_draft(overrides, model):
            # Neutral phase + zeroed counters between the legs (the main model's bytes
            # must not linger under the draft's label); the draft's own phase comes from
            # on_progress_draft, only when it actually downloads (T1: a phase is set by
            # the download itself, never ahead of it).
            if reset_progress is not None:
                reset_progress()
            draft_path = self.acquire_draft_file(
                model.mtp_draft_repo or model.hf_repo, model.mtp_draft_file,
                cancel_check=cancel_check, on_progress=on_progress_draft,
            )
        return model, gguf, draft_path

    def _touch(self, model_id: str, **fields) -> bool:
        """Update a resident model's state dict IF it still exists — a concurrent stop()
        may have dropped it, and we must NOT resurrect a cancelled entry. Returns whether
        the model was present. Used for the out-of-`_router_lock` status writes in
        `_run_load` (the ones inside the lock are guarded by the cancellation re-check)."""
        st = self._resident.get(model_id)
        if st is not None:
            st.update(**fields)
        return st is not None

    def _cancelled(self, model_id: str) -> bool:
        """Has stop() asked THIS load to cancel? (T2 — the per-load token.)"""
        ev = self._cancel_events.get(model_id)
        return ev is not None and ev.is_set()

    def _cleanup_cancelled(self, model_id: str, *, unload_child: bool = False) -> None:
        """The ONE cancel cleanup (T2's per-exit matrix): pop the ledger entry, release
        the arbiter reservation, drop the event — idempotent, exactly-once per field.
        `unload_child=True` for the post-spawn checkpoint (the q2 ruling: a child that
        spawned after the cancel is unloaded SILENTLY; the absent state speaks).
        A bare return at any checkpoint would wedge a permanent `cancelling` entry —
        stop() no longer pops for mid-load cancels, the load thread must."""
        if unload_child:
            router = self._router
            if router is not None and router.is_alive():
                try:
                    self._router_unload(router.url, model_id)
                except Exception:  # noqa: BLE001 — best-effort; the pop below still runs
                    log.warning("cancel: unload of just-spawned %s failed", model_id, exc_info=True)
        with self._lock:
            self._resident.pop(model_id, None)
            self._cancel_events.pop(model_id, None)
        self._arbiter.release(model_id)
        log.info("load %s: cancelled — cleaned up (child_unloaded=%s)", model_id, unload_child)

    def _run_load(
        self, model_id: str, overrides: Overrides | None = None,
        job_id: str | None = None, switches: dict[str, str] | None = None,
    ) -> None:
        try:
            config = self._config_fn()
            hardware = self._hardware_fn()
            embed_ids = self._embedding_ids_fn()  # the configured local embed(s) → reserve them PINNED (P3)

            # Switch base, UNDER user-supplied overrides (user wins per-field). An
            # optional legacy `job_id` hook can REPLACE the base wholesale; normally
            # there is no job → the model's own base/type (moe|dense) presets. Ad-hoc
            # #20 "Tune & measure" switches win last (an unknown key → extra_flags via
            # the same converter) — the Lab per-load tuning (Option A) rides in `ov`.
            base_switches = self._profile_switches_fn(job_id) if job_id else {}
            if not base_switches:
                base_switches = self._switches_fn(model_id) or {}
            ov = _merge_overrides(_switches_to_overrides(base_switches), overrides)
            if switches:
                ov = _merge_overrides(ov, _switches_to_overrides(switches))
            # After the FULL merge: backend applicability (Pass 2) then the (b) rule.
            ov = _strip_inert_mlock(self._apply_backend_applicability(ov))

            def _progress(downloaded: int, total: int | None) -> None:
                # Live byte counters the GUI polls via status() to draw a bar. The PHASE
                # is set HERE, by the download itself — never ahead of it (T1, 2026-07-17
                # approved plan): a cached file fires no chunks, so a bar for a download
                # that isn't happening can no longer appear (the user's phantom
                # "Downloading the model" on an already-cached load).
                self._touch(model_id, detail="model weights", downloaded=downloaded, total=total or 0)

            def _progress_draft(downloaded: int, total: int | None) -> None:
                # Same rule for the SEPARATE MTP draft leg — its phase only when its
                # bytes actually flow (a cached main + missing draft still shows this).
                self._touch(model_id, detail="MTP draft model", downloaded=downloaded, total=total or 0)

            # Engine install is its OWN step (POST /engine/install); a model load
            # REQUIRES it present — fail fast BEFORE the multi-GB download.
            server_exe = self._acquired_exe(self._cache_root, config, hardware)
            if server_exe is None:
                self._touch(model_id, status="error", detail="Install the engine first",
                            error="engine-not-installed", downloaded=0, total=0)
                return

            self._touch(model_id, detail="preparing", downloaded=0, total=0)
            # True load abort (S2 → T2): a stop() during this (slow, unlocked) download
            # SETS the cancel token, so this cancel_check flips True and the fetch aborts
            # at the next chunk — raising DownloadCancelled (caught below). The membership
            # half stays as the belt for the no-id FULL teardown, which clears _resident
            # wholesale and arms no per-model event (the two cover disjoint paths).
            # ONE acquire path for main + draft (2026-07-19): the shared function fetches
            # the external MTP draft too when the resolved config wants it — never a
            # silent drop to no-MTP (the user asked for MTP; a draft failure fails the
            # LOAD with the real reason). Download uses the identical path, so a
            # "Downloaded ✓" model already has its draft on disk.
            _model, gguf, draft_path = self._acquire_and_identify(
                model_id, _progress,
                cancel_check=lambda: self._cancelled(model_id) or model_id not in self._resident,
                overrides=ov, on_progress_draft=_progress_draft,
                reset_progress=lambda: self._touch(model_id, detail="preparing", downloaded=0, total=0),
                skip_if_cached=True)
            if draft_path:
                ov.model_draft = str(draft_path)

            meta = self._read_meta(gguf)
            # #274 half 2 (2026-07-11): an embed is placed by POLICY (CPU unless the
            # static leftover covers it) BEFORE the fit — never by the child's default.
            self._apply_embed_placement(_model, ov, meta, hardware)
            # The draft (just acquired + pinned above) is GPU-resident alongside the
            # main model — charge its VRAM to the fit, or it silently sheds main layers.
            draft_meta, draft_bytes = self._draft_fit_inputs(ov)
            fit = compute_fit(meta, gguf.stat().st_size, hardware, ov,
                              safety_margin_mb=config.safety_margin_mb,
                              ctx_cap_tokens=config.ctx_cap_tokens,
                              draft_meta=draft_meta, draft_bytes=draft_bytes)
            # 1b fit-by-omission: only tune/preset/request-EXPLICIT placement knobs are
            # emitted; a non-explicit knob is omitted so the child's default `--fit`
            # places tensors at our always-emitted ctx. Tuned boxes render identically
            # to before (every knob explicit there).
            entry = ModelIniEntry(
                model_id=model_id, gguf_path=str(gguf),
                n_gpu_layers=fit.n_gpu_layers if fit.ngl_explicit else None,
                n_cpu_moe=fit.n_cpu_moe if fit.ncmoe_explicit else None,
                ctx_len=fit.ctx_len, overrides=ov,
            )

            with self._router_lock:
                # T2 checkpoint 1: a cancel (token) or a full teardown (membership) that
                # landed during the unlocked download phase. Cleanup, never a bare
                # return — stop() no longer pops for mid-load cancels, so a bare return
                # would wedge a permanent "cancelling" entry with the UI inert.
                if self._cancelled(model_id) or model_id not in self._resident:
                    self._cleanup_cancelled(model_id)
                    return
                # Arbiter admission (P2): evict the LRU non-pinned resident(s) until this model
                # fits the VRAM budget within models_max, THEN load. Under _router_lock so the
                # eviction serializes with other loads/stops. The reservation is recorded only
                # AFTER a confirmed load (below), so the ledger never holds a non-resident model —
                # and it is TRUED-UP against the measured used-VRAM delta across the load
                # (measure-don't-assume; see _trued_up_vram_mb).
                # Pins mirror the LIVE routing default (2026-07-12): a load-time pin goes
                # stale when the default moves — the replaced 0.6B kept its pin and the
                # count-cap eviction took Gemma instead of it. Re-sync before every
                # admission, and make replaced embeds the PREFERRED victims (the embed
                # slot swaps; the chat model never pays for an embed switch).
                self._arbiter.sync_pins(embed_ids)
                embed_rows = {m.id for m in self.catalog() if getattr(m, "embedding", False)}
                stale_embeds = {
                    mid for mid in self._resident
                    if mid in embed_rows and mid not in embed_ids and mid != model_id
                }
                # T2 checkpoint 2 — IMMEDIATELY before _admit, not only at the lock
                # entry: `catalog()` above is a DB round-trip, so a cancel can land
                # between the two, and _admit EVICTS other residents to make room — a
                # cancelled load must never cost the user a model they were using (the
                # panel's architecture finding: the first plan's killer, surviving in
                # this window). Adjacency is the guarantee.
                if self._cancelled(model_id):
                    self._cleanup_cancelled(model_id)
                    return
                self._admit(model_id, fit.vram_mb, config.models_max, hardware,
                            ngl_explicit=fit.ngl_explicit, is_moe=fit.is_moe,
                            stale_embed_ids=stale_embeds)
                self._resident[model_id].update(status="starting", detail="loading into VRAM",
                                                downloaded=0, total=0)
                vram_before = self._probe_used_vram()
                self._load_via_router(entry, fit, server_exe, config)
                # T2 checkpoint 3: the router op itself is not interruptible — a cancel
                # that landed while the child was spawning takes effect HERE: unload the
                # child we just spawned, SILENTLY (the user's q2 ruling — the absent
                # state speaks), release, and never reach reserve/running.
                if self._cancelled(model_id):
                    self._cleanup_cancelled(model_id, unload_child=True)
                    return
                # Pin the configured embed so it is NEVER the LRU eviction victim (P3): a chat co-load
                # evicts another chat, never the embed RAG depends on. A chat model reserves unpinned.
                # kind + evict_fn (2026-08-09 seam): a foreign-kind admission (a JV TTS load) evicts
                # this model through make_room → _evict_from_arbiter, which takes _router_lock itself.
                trued_mb, trued_src = self._trued_up_vram_mb(fit.vram_mb, vram_before, hardware)
                self._arbiter.reserve(model_id, trued_mb,
                                      pinned=model_id in embed_ids, kind="llm",
                                      evict_fn=lambda mid=model_id: self._evict_from_arbiter(mid),
                                      source=trued_src)
                # Phase 5 (§6.3): persist the confirmed load's footprint as a
                # source='load' measurement row (switches = the fingerprint raw
                # material), and — when the true-up really measured — the observed
                # per-backend overhead as a machine row (§13.2/§13.6: the physics
                # overhead seed's correction data; the build stamp rides the label
                # so an engine-pin bump naturally invalidates old rows).
                self._persist_load_footprint(model_id, trued_mb, trued_src, fit, ov,
                                             hardware, config)
                self._resident[model_id].update(status="running", url=self._router.url,
                                                detail="", error="", downloaded=0, total=0)
        except DownloadCancelled:
            # A stop() during the download aborted the fetch (S2 → T2). Under the token
            # design stop() no longer pops the entry (it sits at "cancelling") — the
            # cleanup is OURS: pop + release + drop the event. Never an error state
            # (a user-requested stop must not read as a failure).
            log.info("runner load cancelled during download for %s", model_id)
            self._cleanup_cancelled(model_id)
        except Exception as exc:  # noqa: BLE001 — any failure becomes error state
            log.exception("runner load failed")
            # A concurrent stop() may have cancelled + removed the model — don't resurrect it.
            self._touch(model_id, status="error", detail="", error=str(exc), downloaded=0, total=0)
            self._arbiter.release(model_id)  # never leak a reservation on a failed/cancelled load
        finally:
            # The token dies with its load, every path (the cancelled paths already
            # popped it — idempotent). A survivor would self-cancel a FUTURE load only
            # if load() reused it; load() arms a fresh Event, this is the second belt.
            self._cancel_events.pop(model_id, None)

    # ── Arbiter admission (P2): co-reside if it fits, else evict the LRU ───────
    #    Called from _run_load under `_router_lock`.

    def _probe_used_vram(self) -> int | None:
        """Snapshot of the used BUDGET-POOL memory (MiB) via the injected probe
        (`used_vram_fn`, default `hardware.used_device_mem_mb` — Phase 4's
        backend-aware door: nvidia-smi → rocm-smi → amdgpu sysfs → Windows GPU
        counters on discrete boxes; the used SYSTEM pool on one-pool boxes, so a
        load's delta counts its bytes once). None when unmeasurable or when the
        probe itself raises — a probe failure must never fail a load."""
        try:
            return self._used_vram_fn()
        except Exception:  # noqa: BLE001 — measurement is best-effort, never load-fatal
            return None

    def _trued_up_vram_mb(self, estimate_mb: int, before: int | None, hardware=None) -> int:
        """The VRAM (MiB) to RESERVE for a just-CONFIRMED load: the MEASURED used-VRAM
        growth across the load, floored at the driver-context constant when the fit
        claimed GPU use, and capped at the card (one child can never exceed it).

        WHY measured-first (INVERTED 2026-07-11; was `max(estimate, measured)`): the fit
        regression has no `n-cpu-moe` term, so a CPU-offloaded MoE (Gemma 26B at ngl 30 /
        ncmoe 21 — real footprint ~6.5 GB) estimates ~16 GB; flooring at that estimate
        wedged the ledger at 19.3/8 GB with 0 free, evicting or refusing every later load.
        Measurement is ground truth here — loads serialize under `_router_lock`, so the
        growth between the snapshots is attributable to THIS load. The old under-count
        worries (an evicted victim still draining at `before`, a co-resident idle-sleeping
        mid-load) now degrade to a too-small reservation, which `_admit` handles with a
        warning + the spawn safety nets — strictly better than a permanently-poisoned
        ledger. The `_DRIVER_CTX_MB` floor keeps the original 2026-07-06 motivation: an
        ngl-0 CUDA child still holds ~549 MB of driver context and must not book 0 when
        the fit claimed GPU use. Unmeasurable (None either side) → the card-capped
        estimate (deterministic offline)."""
        # ARCH-AWARE cap (Phase 4): the ceiling is the budget POOL — the card on
        # discrete boxes (the historical meaning), the shared pool on one-pool
        # boxes (where max_vram is 0/absent and the old cap never engaged).
        # Returns (mb, source) since Phase 5 (§13.1): "measured" when a real
        # before/after delta produced the number, "computed" when the probe
        # couldn't measure and the estimate stands — the reservation carries it
        # so no consumer presents an estimate as live truth.
        cap = _hw_budget_total(hardware) if hardware is not None else 0
        est = min(estimate_mb, cap) if cap > 0 else estimate_mb
        after = self._probe_used_vram()
        if before is None or after is None:
            return est, "computed"
        measured = max(0, after - before)
        floor = min(est, _DRIVER_CTX_MB) if est > 0 else 0
        return max(measured, floor), "measured"

    @staticmethod
    def _fit_config_switches(f, ov) -> dict[str, str]:
        """The confirmed load's launch config as an UNDERSCORE-canon switch dict —
        the fingerprint raw material a source='load' row carries (§6.3/§13.3).
        The fit knobs come from the RESOLVED FitPlan (what actually launched, not
        what was asked); the rest from the merged Overrides, set fields only.
        spec/model_draft ride along so a speculative load is identifiable."""
        sw = {"n_gpu_layers": str(f.n_gpu_layers), "n_cpu_moe": str(f.n_cpu_moe),
              "ctx_len": str(f.ctx_len)}
        for name in ("cache_type_k", "cache_type_v", "flash_attn", "no_kv_offload",
                     "parallel", "batch_size", "ubatch_size", "mlock", "no_mmap",
                     "spec_type", "model_draft"):
            v = getattr(ov, name, None)
            if v not in (None, "", False):
                sw[name] = str(v)
        return sw

    def _persist_load_footprint(self, model_id: str, trued_mb: int, source: str,
                                f, ov, hardware, config) -> None:
        """Phase 5 (§6.3/§13.2): write the confirmed load's footprint as a
        source='load' measurement row (vram_model_mb + the launch switches — the
        fingerprint), and, when the true-up REALLY measured and the load used the
        device, the observed per-backend overhead as a machine row
        (`__overhead__`, label stamped with the engine build so a pin bump
        invalidates old rows by simple non-match). Best-effort: persistence must
        never fail a load; unwired (standalone/tests) → no-op."""
        if self._record_load_fn is None:
            return
        try:
            switches = self._fit_config_switches(f, ov)
            self._record_load_fn(model_id, vram_model_mb=int(trued_mb),
                                 switches=switches, source="load",
                                 label=f"load footprint ({source})")
            if source == "measured" and f.n_gpu_layers > 0 and f.vram_mb > 0:
                from .fit import PHYSICS_OVERHEAD_MB
                from .hardware import active_backend

                backend = active_backend(hardware)
                seed = PHYSICS_OVERHEAD_MB.get(backend, PHYSICS_OVERHEAD_MB["cuda"])
                # f.vram_mb is the physics booking = weights-share + kv-share +
                # the seed overhead; the observed overhead is the measured total
                # minus the physics weights+kv part.
                observed = max(0.0, trued_mb - (f.vram_mb - seed))
                build = config.llamacpp.pinned_build if config is not None else ""
                self._record_load_fn("__overhead__", vram_model_mb=int(observed),
                                     switches={}, source="probe",
                                     label=f"physics-overhead {build}")
        except Exception:  # noqa: BLE001 — persistence is best-effort, never load-fatal
            log.debug("load-footprint persist failed for %s", model_id, exc_info=True)

    def _embed_gpu_leftover_mb(self, hardware) -> int:
        """The STATIC VRAM leftover an embedding child may claim: card total minus the
        LOCAL chat default's claim (`est_vram_mb` when known, else `min_vram_mb` —
        the 2026-07-25 chat-first baseline). Static — NOT live free VRAM —
        because the ask flow loads the embed BEFORE the chat model; a live reading would
        see an empty card, place the embed on GPU, and the chat load then can't fit (the
        2026-07-11 co-load crash). Baseline resolution, in order: the routing default's
        LOCAL chat model's floor; empty (Plan-A boxes route via task presets, the global
        default stays "") → the largest-floor DOWNLOADED local chat model — the embed
        must co-exist with whatever big model this box actually runs; nothing
        downloaded → the whole card (no co-residence yet). A named default with no
        catalog row / no curated floor → 0 (conservative: the chat model is the
        primary workload)."""
        card = _hw_max_vram(hardware)
        if card <= 0:
            return 0
        try:
            chat_id = self._default_llm_id_fn() or ""
        except Exception:  # noqa: BLE001 — a routing-store hiccup must never kill a load
            chat_id = ""
        # The chat baseline CONSUMES THE CLAIM RESOLVER since Phase 5 (§6.6 —
        # the est-else-floor chain retired into the ladder): a resident chat
        # model's TRUE booked footprint, else a fingerprint-matched measured
        # footprint, else the physics booking, else the old declared want
        # (est_vram_mb over min_vram_mb — the 2026-07-25 conservative baseline,
        # still the not-downloaded arm: understating the chat claim re-opens
        # the 2026-07-11 co-load crash). POLICY is unchanged: chat-first,
        # static-not-live — a reservation/measurement IS a claim, never a
        # live-free-VRAM read.
        def _chat_claim(m) -> int:
            rec = m.recommended_for
            return (rec.est_vram_mb or rec.min_vram_mb) or 0
        if chat_id:
            row = next((m for m in self.catalog() if m.id == chat_id), None)
            if row is None:
                return 0
            try:
                claim = int(self._resolve_claim(row).get("vramMb") or 0)
            except Exception:  # noqa: BLE001 — a resolver hiccup falls to the declared chain
                claim = _chat_claim(row)
            return max(0, card - claim) if claim > 0 else 0
        claims = [
            _chat_claim(m)
            for m in self.catalog()
            if not getattr(m, "embedding", False)
            and _chat_claim(m) > 0
            and cached_gguf_path(m.hf_repo, m.quant, cache_root=self._cache_root / "hf",
                                 mmproj=m.mmproj) is not None
        ]
        if not claims:
            return card
        return max(0, card - max(claims))

    def _apply_embed_placement(self, model, ov, meta, hardware) -> None:
        """#274's missing half — the embed CPU-placement GUARANTEE. The pick rule
        (ui modelPick.pickBestEmbedId) chooses WHICH embed rides a box assuming small
        embeds run on CPU; nothing enforced it at load time, so llama.cpp's default
        placement put the whole embed (weights + a 32k KV pool) on the GPU beside the
        chat model (the 2026-07-11 incident). Rules, first match wins; an EXPLICIT tune
        ngl always wins over the policy:
          * ctx: capped at min(trained, _EMBED_CTX_CAP) unless a tune set it — an
            embedding input is a ~1k-token chunk, never a chat context;
          * tier "cpu" → ngl 0 (the ROUND-4 law: deliberately CPU on the user's box);
          * curated floor fits the static leftover → GPU (the fit places it);
          * otherwise (including no curated floor) → ngl 0.
        ngl 0 is set as an EXPLICIT override so the `.ini` emits `n-gpu-layers = 0` —
        fit-by-omission would hand placement back to the child's GPU-greedy `--fit`."""
        if not getattr(model, "embedding", False):
            return
        if not ov.ctx_len:
            trained = int(getattr(meta, "context_length", 0) or 0)
            ov.ctx_len = min(trained, _EMBED_CTX_CAP) if trained > 0 else _EMBED_CTX_CAP
        if ov.n_gpu_layers is not None:
            return
        placement, _left = self.embed_placement(model, hardware)
        if placement != "gpu":
            ov.n_gpu_layers = 0

    def embed_placement(self, model, hardware) -> tuple[str, int]:
        """Where the POLICY puts this embedding model on this box — ("cpu"|"gpu",
        static leftover MB). THE one source (2026-07-25): the load-time enforcement
        (`_apply_embed_placement`) and the models-endpoint display both read this,
        so the catalog badge can never promise a placement the loader then refuses.
        tier "cpu" never claims the GPU (the ROUND-4 law); anything else only when
        its curated floor fits the static leftover beside the chat default. An
        explicit tune ngl still overrides at load time — the power-user escape."""
        left = self._embed_gpu_leftover_mb(hardware)
        if (getattr(model, "tier", "") or "") == "cpu":
            return ("cpu", left)
        rec = getattr(model, "recommended_for", None)
        need = (rec.min_vram_mb if rec is not None else None) or 0
        return ("gpu" if 0 < need <= left else "cpu", left)

    def _admit(self, model_id: str, vram_mb: int, models_max: int, hardware,
               *, ngl_explicit: bool = False, is_moe: bool = False,
               stale_embed_ids: set | None = None) -> None:
        """Make room for a load: evict the LRU non-pinned resident(s) until `model_id` fits the VRAM
        budget AND the llm child count is under `models_max`. Accounts for `model_id`'s OWN prior
        reservation (a re-tune replaces it, doesn't add) and never evicts `model_id`.

        Refactored ONTO the arbiter's shared `make_room` (2026-08-09 seam): the VRAM-fit phase runs
        the one policy home, so a foreign-kind resident (a JV TTS engine) is evicted through ITS
        registered evictor — never a router unload of a key the router doesn't own (the pass-3
        ledger-corruption scenario) — and BUSY kinds are protected (never-evict-busy, which also
        closes the old same-kind hole: loading LLM B can no longer evict mid-stream LLM A). The
        replaced-embed preference and the count cap stay HERE — both are runner-only concerns, and
        the count is llm-scoped now (P5-3: a resident TTS engine must not eat a child slot).

        When nothing is evictable and it still doesn't fit: a DENSE entry with an EXPLICIT ngl is
        REFUSED with an actionable error (2026-07-11) — the child's `--fit` auto-placement ABORTS on
        a user-set ngl ("n_gpu_layers already set by user, abort"), so there is NO safety net and the
        spawn dies. Everything else PROCEEDS with a warning — a MoE's fit estimate over-books (no
        `n-cpu-moe` term), so refusing on it would block loads that actually fit; a fit-placed
        (ngl-omitted) entry keeps the child's auto-offload as its net. Caller holds `_router_lock`
        (make_room's evictor re-enters it — RLock); `hardware` is passed in (already detected) so
        the arbiter doesn't re-run nvidia-smi per loop."""
        arb = self._arbiter
        own = arb.reserved_mb(model_id) or 0  # freeing our own reservation adds this back to the budget

        def _fits() -> bool:
            return vram_mb <= arb.remaining_mb(hw=hardware) + own

        def _n_others() -> int:
            return arb.count(kind="llm") - (1 if arb.is_reserved(model_id) else 0)

        # Phase A — a REPLACED embed (resident but no longer the routing default) goes
        # FIRST under ANY constraint: dead weight; the embed slot swaps (2026-07-12).
        while stale_embed_ids and not (_fits() and _n_others() < models_max):
            victim = arb.pick_evict(exclude=model_id, min_mb=0, among=stale_embed_ids)
            if victim is None:
                break
            log.info("arbiter: evict replaced embed %s to make room for %s", victim, model_id)
            self._evict_resident(victim)
            arb.record_eviction(victim, "llm", f"replaced embedding model (loading {model_id})")

        # Phase B — the count cap, llm-scoped: only the runner's own children count,
        # and only they are count-cap victims (min_mb=0 — a child must go regardless).
        # Busy wins over the cap (never-evict-busy): a mid-stream child is untouchable,
        # so the load proceeds over models_max and idle-sleep trims the excess later.
        while _n_others() >= models_max:
            if "llm" in arb.busy_kinds():
                log.warning("arbiter: models_max reached but llm is busy — proceeding "
                            "over the cap (never-evict-busy)")
                break
            victim = arb.pick_evict(exclude=model_id, min_mb=0, kind="llm")
            if victim is None:
                break
            log.info("arbiter: evict LRU %s (models_max) to make room for %s", victim, model_id)
            self._evict_resident(victim)
            arb.record_eviction(victim, "llm", f"model count cap (loading {model_id})")

        # Phase C — the VRAM fit, through the shared policy home. Victims may be ANY
        # kind (an idle TTS engine on a small card); each dies by its own evictor.
        # self_evict covers llm reservations recorded without an evict_fn (tests,
        # pre-seam rows) — the runner knows how to unload its own children.
        made = _fits() or arb.make_room(
            max(0, vram_mb - own), exclude=model_id, hardware=hardware,
            reason=f"loading {model_id}",
            self_kind="llm", self_evict=self._evict_resident,
        )
        if not made:
            if ngl_explicit and not is_moe:
                others = ", ".join(sorted(k for k in self._resident if k != model_id)) or "none"
                raise RuntimeError(
                    f"Not enough free VRAM to load {model_id!r}: it needs ~{vram_mb} MB but only "
                    f"{arb.remaining_mb(hw=hardware) + own} MB remain and the resident models "
                    f"({others}) are pinned or busy. Unload a model, pick a smaller embedding "
                    f"model, or lower this model's GPU layers in its tune."
                )
            log.warning(
                "arbiter: %s over budget (needs %d MB, %d MB remain) with nothing evictable"
                " — proceeding; the spawn safety nets decide",
                model_id, vram_mb, arb.remaining_mb(hw=hardware) + own)

    def _evict_from_arbiter(self, model_id: str) -> None:
        """The evictor `make_room` executes for a runner reservation — safe from ANY
        thread: a JV TTS admission calls it without `_router_lock`; the runner's own
        `_admit` → `make_room` path re-enters the (R)Lock it already holds."""
        with self._router_lock:
            self._evict_resident(model_id)

    def _evict_resident(self, model_id: str) -> None:
        """Unload one co-resident model to free its VRAM for an incoming load: POST /models/unload,
        drop it from `_resident`, release its arbiter reservation, and re-home `_last_id` if it was
        the primary. Caller holds `_router_lock`.

        DECISION — release the reservation on the unload ATTEMPT, not only on a confirmed unload:
        (1) it guarantees `_admit`'s loop terminates (an un-released victim would keep coming back
        from `pick_evict`), and (2) a failed unload almost always means the child is ALREADY gone (a
        4xx "not loaded" or a router that's down), so releasing is correct. The rare "unload failed
        but the child is still resident" case under-counts committed VRAM → a possible OOM on the
        next co-resident load, which the spawn OOM back-off + the build's CPU auto-offload catch."""
        router = self._router
        if router is not None and router.is_alive():
            try:
                self._router_unload(router.url, model_id)
            except Exception:  # noqa: BLE001 — best-effort; reservation freed on attempt (see docstring)
                log.warning("arbiter evict: unload %s failed", model_id, exc_info=True)
        self._resident.pop(model_id, None)
        self._arbiter.release(model_id)
        if self._last_id == model_id:
            self._last_id = next(iter(self._resident), "")

    # ── Router: emit the .ini from the DB → spawn/bounce → load a model by id ──
    #    All of these assume the caller holds `_router_lock` (they mutate `_router`).

    def _active_backend(self) -> str:
        """The engine FAMILY the next child will run on ("cuda" | "rocm" | "vulkan" |
        "metal" | "cpu"; "" unknown) — the same derivation engine_status uses: the
        running router's exe matched against the acquired variants, else the variant
        select_binary would pick. Best-effort: any failure returns "" (no filtering)."""
        try:
            config = self._config_fn()
            hardware = self._hardware_fn()
            acquired = self._acquired_exes(self.cache_root, config, hardware)
            variant = ""
            if self._active_server_exe:
                variant = next(
                    (g for g, e in acquired if str(e) == str(self._active_server_exe)), "")
            if not variant:
                asset = select_binary(config, hardware)
                variant = asset.gpu if asset else ""
                if not variant and acquired:
                    variant = acquired[0][0]  # e.g. a hand-registered variant on disk
            return gpu_family(variant) if variant else ""
        except Exception:  # noqa: BLE001 — applicability is best-effort, never load-fatal
            return ""

    def _apply_backend_applicability(self, ov):
        """Pass 2 (2026-07-22): drop typed launch knobs the ACTIVE engine family can't
        use — the knob_catalog's `backends` column, host-wired via knob_backends_fn
        ({flag: "cuda,rocm,…"}; absent flag = applies everywhere). A dropped knob is
        simply OMITTED (fit-by-omission: the child's own default governs), which is
        what un-applied CUDA tuning should mean on a cpu engine — the 2026-07-22
        incident shipped no_mmap/placement flags onto the cpu band's children."""
        rules = self._knob_backends_fn() if self._knob_backends_fn else None
        if not rules:
            return ov
        backend = self._active_backend()
        if not backend:
            return ov
        for flag, spec in rules.items():
            allowed = {p.strip() for p in str(spec).split(",") if p.strip()}
            if allowed and backend not in allowed and getattr(ov, flag, None) is not None:
                log.info("knob %s is not applicable on the %s engine — omitting it "
                         "(backends=%s)", flag, backend, spec)
                setattr(ov, flag, None)
        return ov

    def _resolve_ini_entries(self, override: ModelIniEntry | None) -> list[ModelIniEntry]:
        """One `ModelIniEntry` per ON-DISK catalog model, IN CATALOG ORDER (a STABLE
        `.ini` text so a co-resident load doesn't spuriously bounce — the text only
        changes when a section's flags actually change). `override` (the model being
        loaded) REPLACES that model's section IN PLACE so it carries this load's exact
        fit + any Lab tuning (Option A); the rest are DB-resolved from `switches_fn`. A
        model whose meta/fit fails is skipped, not fatal to the whole `.ini`."""
        hardware = self._hardware_fn()
        cfg = self._config_fn()
        margin = cfg.safety_margin_mb
        ctx_cap = cfg.ctx_cap_tokens
        hf_cache = self._cache_root / "hf"
        entries: list[ModelIniEntry] = []
        catalog = list(self.catalog())
        # Defect C (2026-07-22 pass-1 plan T3): prune loaded-with entries for models
        # that left residency — THE one convergence point, so no removal site needs a
        # mirror pop. Snapshot-read of _resident (same GIL-atomicity argument as
        # resident()'s overlay); caller holds `_router_lock`.
        self._active_entries = {
            k: v for k, v in self._active_entries.items() if k in self._resident
        }
        for m in catalog:
            if override is not None and m.id == override.model_id:
                entries.append(override)  # this load's exact section, in the model's slot
                continue
            kept = self._active_entries.get(m.id)
            if kept is not None:
                # A RESIDENT co-model renders the entry it was LOADED WITH — never a
                # fresh DB derivation, which silently reverted ephemeral launch configs
                # on any later co-load's emit and bounce-respawned the child at the
                # wrong config (defect C: ctx 8192 → tune's 131072 → ~21 GB on CPU).
                entries.append(kept)
                continue
            gguf = cached_gguf_path(m.hf_repo, m.quant, cache_root=hf_cache, mmproj=m.mmproj)
            if gguf is None:
                continue  # not on disk → no section (a section needs the file for compute_fit)
            try:
                ov = _strip_inert_mlock(self._apply_backend_applicability(
                    _switches_to_overrides(self._switches_fn(m.id) or {})))
                # Plan B D7 (diff-checker fold): the auto-mtp layer can put `draft-mtp`
                # on a PASSIVE co-resident section too. Point it at the CACHED draft —
                # which Download now fetches (2026-07-19 one-acquire change), so it
                # normally is present.
                if _wants_draft(ov, m):
                    cached_draft = self._cached_draft_path(m, hf_cache)
                    if cached_draft is not None:
                        ov.model_draft = str(cached_draft)
                    else:
                        # A CORNER case now (cancelled mid-draft / hand-deleted / a
                        # pre-fix download) — no longer the normal downloaded-but-not-
                        # yet-loaded state. Strip spec LOUDLY: no network in the ini
                        # emitter, and for a DECLARED-DRAFTER model (this branch runs ONLY
                        # when `_wants_draft` is True, i.e. `m.mtp_draft_file` is set),
                        # `spec-type = draft-mtp` without a `model-draft` line would hand
                        # llama-server a broken preset on a router bounce. (A BUILT-IN-MTP
                        # model — no `mtp_draft_file`, e.g. qwen3.6-27b — legitimately
                        # runs spec-type with NO model-draft, self-drafting from the main
                        # GGUF, and never reaches this branch — verified working on-box
                        # 2026-07-21.) The first ACTIVE load re-acquires the draft (fail-loud).
                        log.warning(
                            "model %s wants MTP (draft-mtp) but its draft %r is not "
                            "downloaded — MTP is OFF for this router section; Re-download "
                            "the model to restore it", m.id, m.mtp_draft_file)
                        ov.spec_type = None
                        ov.spec_n_max = None
                meta = self._read_meta(gguf)
                # #274 half 2 — the same embed placement rule as the active-load path,
                # so a PASSIVE section can't hand the embed to the child's GPU default.
                self._apply_embed_placement(m, ov, meta, hardware)
                # Same draft-VRAM charge as the active-load path: a PASSIVE section that
                # carries `model-draft` holds those bytes too once the router loads it.
                draft_meta, draft_bytes = self._draft_fit_inputs(ov)
                fit = compute_fit(meta, gguf.stat().st_size, hardware, ov, safety_margin_mb=margin,
                                  ctx_cap_tokens=ctx_cap,
                                  draft_meta=draft_meta, draft_bytes=draft_bytes)
                # Same 1b fit-by-omission rule as the active-load path above.
                entries.append(ModelIniEntry(
                    model_id=m.id, gguf_path=str(gguf),
                    n_gpu_layers=fit.n_gpu_layers if fit.ngl_explicit else None,
                    n_cpu_moe=fit.n_cpu_moe if fit.ncmoe_explicit else None,
                    ctx_len=fit.ctx_len, overrides=ov,
                ))
            except Exception:  # noqa: BLE001 — skip one model, keep the rest of the .ini
                log.warning("skipping .ini section for %s (meta/fit failed)", m.id, exc_info=True)
        # An override for a model NOT in the catalog still gets its own section.
        if override is not None and not any(e.model_id == override.model_id for e in entries):
            entries.insert(0, override)
        # Mark EVERY embedding-capable section — not just the routing default (2026-07-12).
        # Marking only the active embed meant switching the default MOVED the `embeddings = true`
        # marker between sections, which changed the .ini TEXT → _bounce_router → the router
        # reloaded Gemma + the incoming embed AT ONCE, and Gemma's MTP draft then crashed on the
        # simultaneous co-load (bricking the chat). All embed models are embed-ONLY (the catalog
        # `embedding` flag), so marking the idle ones is harmless AND makes the .ini STABLE across
        # an embed-default switch → no bounce → the chat model is never disturbed. The ACTIVE
        # embed is still selected two ways that don't touch the .ini: the client requests it by
        # model id (routing), and the arbiter PINS it (`embed_ids`, below / sync_pins). Applied BY
        # ID in a single post-pass so EVERY emit path gets it (the override slot, a DB-resolved
        # section, the not-in-catalog insert). We deliberately do NOT set `load-on-startup`: an
        # idle embed's section must not auto-load (that would be invisible to `_resident`, so a
        # later ensure would re-POST /models/load for an already-loaded id → 400 → error). The
        # "pin" is the arbiter reservation; the marker is only "IF spawned, serve /v1/embeddings".
        # pooling is INTRINSIC per-model (nomic=mean, qwen3-embedding=last); "" → no `pooling =`
        # line → llama.cpp reads the GGUF's pooling_type (#119). The mark set is the UNION of
        # every catalog `embedding` row AND the routing default (`embed_ids`) — the flag gives
        # Fix A's cross-switch stability for real embeds, and the default is always covered even
        # if a user pointed the embedding default at a row that isn't flagged (misconfig-safe).
        embed_ids = self._embedding_ids_fn()
        embed_pooling = {
            m.id: (getattr(m, "pooling", "") or "")
            for m in catalog if getattr(m, "embedding", False) or m.id in embed_ids
        }
        if embed_pooling:
            entries = [
                _dc_replace(e, embeddings=True, pooling=embed_pooling.get(e.model_id, ""))
                if e.model_id in embed_pooling else e
                for e in entries
            ]
        return entries

    def _emit_ini(self, override: ModelIniEntry | None = None) -> tuple[Path, bool]:
        """Write `<cache_root>/llamacpp/models.ini` from the on-disk catalog. Returns
        (path, changed): `changed` is True only when the rendered text differs from what
        the running router was started with — the signal to spawn (if down) or bounce (if
        up). The DB is the source of truth; this `.ini` is GENERATED, never read back."""
        entries = self._resolve_ini_entries(override)
        text = emit_models_ini(entries)
        path = self._runtime_root / "models.ini"
        changed = text != self._last_ini_text
        if changed:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
            self._last_ini_text = text
        return path, changed

    def _spawn_router(self, server_exe, config) -> None:
        """Spawn the long-lived router from the just-emitted `.ini` (models_max + idle-TTL
        from the DB config). Caller holds `_router_lock` and has emitted the `.ini`.
        On success the exe becomes the session's PROVEN binary (`_active_server_exe`) —
        bounces reuse it rather than re-trying a preferred build that failed to launch."""
        log_path = self._router_log_path()
        self._last_log_path = log_path
        # The port is ALLOCATED here, never assumed: a sibling family app, a stray
        # router from a crashed run, or the user's own llama.cpp may already hold the
        # preferred one, and a health probe cannot tell their server from ours
        # (find_free_port carries the measured incident). Callers must read the live
        # URL off the handle — or `router_url()` — not rebuild it from DEFAULT_PORT.
        port = self._find_port(DEFAULT_HOST, DEFAULT_PORT)
        if port != DEFAULT_PORT:
            log.info("engine port %d is taken — starting the router on %d instead",
                     DEFAULT_PORT, port)
        self._router = self._start_router(
            server_exe,
            models_dir=self._cache_root / "hf",
            models_preset=self._runtime_root / "models.ini",
            models_max=config.models_max,
            sleep_idle_seconds=config.sleep_idle_seconds,
            host=DEFAULT_HOST, port=port, log_path=log_path,
        )
        self._active_server_exe = server_exe

    def _spawn_router_with_fallback(self, server_exe, config):
        """A3: spawn the router, chaining across INSTALLED builds when the preferred
        binary fails to LAUNCH (bad driver/runtime → `RunnerStartError`, e.g. a CUDA
        build on a box whose CUDA runtime is broken). Candidates come from
        `acquired_server_exes` — builds ALREADY on disk in preference order (rocm →
        vulkan → cpu after the CUDA keys); a load NEVER downloads an engine
        (decision A, the 2026-07-02 install/load split). Returns the exe that
        actually launched. All candidates failing raises ONE `RunnerStartError`
        aggregating each backend's own reason (each already carries its exit code +
        log tail from the spawn diagnostics). Caller holds `_router_lock`."""
        candidates: list[tuple[str, object]] = [("preferred", server_exe)]
        try:
            installed = self._acquired_exes(self._cache_root, self._config_fn(), self._hardware_fn())
        except Exception:  # noqa: BLE001 — the probe must never kill the load path
            installed = []
        for gpu, exe in installed:
            if str(exe) != str(server_exe):
                candidates.append((gpu, exe))
        errors: list[str] = []
        for idx, (gpu, exe) in enumerate(candidates):
            try:
                self._spawn_router(exe, config)
            except RunnerStartError as e:
                errors.append(f"[{gpu}] {e}")
                log.warning("router spawn failed on %s build (%s) — trying next installed backend",
                            gpu, exe)
                continue
            if idx > 0:
                log.warning("router running on FALLBACK backend %s (%s); the preferred build "
                            "failed to launch — see the engine log", gpu, exe)
            return exe
        raise RunnerStartError(
            "the engine failed to launch on every installed backend:\n" + "\n".join(errors)
        )

    def _bounce_router(self, server_exe, config) -> None:
        """Restart the router so it re-reads a changed `.ini`, PRESERVING the resident set
        (reload each previously-running model). Only taken when a re-emitted `.ini` changed
        while the router was up (a new/tuned section) — the common co-residence path (model
        already in the `.ini`) never bounces. Whether llama.cpp instead HOT-READS the `.ini`
        on `/models/load` is the P1d runtime unknown (design §8.2); the bounce is correct
        either way."""
        prev = [mid for mid, st in self._resident.items() if st.get("status") == "running"]
        if self._router is not None:
            try:
                self._router.stop()
            except Exception:  # noqa: BLE001 — best-effort
                pass
            self._router = None
        self._spawn_router(server_exe, config)
        for mid in prev:
            try:
                self._router_load(self._router.url, mid)
            except Exception:  # noqa: BLE001 — a resident that won't reload keeps its own status
                log.warning("reloading %s after router bounce failed", mid, exc_info=True)

    def _load_via_router(self, entry: ModelIniEntry, fit, server_exe, config) -> None:
        """Ensure the router is up with `entry`'s section present, then load the model by
        id with a router-level OOM back-off. Caller holds `_router_lock`. A fresh spawn
        goes through the A3 fallback chain; once ANY binary is proven (this spawn or an
        earlier one), that exe is what bounces/backoffs reuse — a broken preferred build
        is never re-tried mid-session (it would knock down every healthy resident)."""
        router_up = self._router is not None and self._router.is_alive()
        _, changed = self._emit_ini(override=entry)
        if not router_up:
            # RECONCILE before a FRESH spawn (2026-07-11): the new router starts EMPTY,
            # so resident entries + arbiter reservations left by a router that died
            # OUTSIDE `stop()` are stale — a ghost embed's reservation kept ~3.6 GB
            # booked and the header read 19.3/8 GB. Only this load's model survives.
            for mid in [m for m in self._resident if m != entry.model_id]:
                self._resident.pop(mid, None)
                self._arbiter.release(mid)
            if self._last_id != entry.model_id:
                self._last_id = entry.model_id if entry.model_id in self._resident else ""
            server_exe = self._spawn_router_with_fallback(server_exe, config)
        else:
            server_exe = self._active_server_exe or server_exe
            if changed:
                self._bounce_router(server_exe, config)
        self._router_load_with_backoff(entry, fit, server_exe, config)

    def _confirm_load(self, model_id: str, log_offset: int | None = None) -> str:
        """Poll `GET /models` until the child for `model_id` resolves. POST /models/load is
        ASYNC on b9644 (a 2xx only ACCEPTS; the child loads in the background — box-verified),
        so the 200 is NOT a load confirmation. Returns 'loaded' (status.value loaded|sleeping),
        'failed' (value failed/error, the router process itself died, or — 2026-07-11 — the
        CHILD died: a crashed child can leave the router reporting its id as still-`loading`
        forever (the brick), so with `log_offset` set we also scan the router log appended
        since this load's POST for the router's own `instance name=<id> exited with status`
        death line; without it a corpse was polled for the full deadline, ~6.5 min observed),
        or 'timeout' (still loading past the deadline). Caller holds `_router_lock`.
        `_now`/`_sleep`/`_router_models` are injected in tests so this polls deterministically
        offline."""
        deadline = self._now() + self._load_poll_timeout
        while True:
            router = self._router
            if router is None or not router.is_alive():
                return "failed"  # the router itself is gone → nothing to load into
            try:
                live = _parse_router_models(self._router_models(router.url))
            except Exception:  # noqa: BLE001 — a transient GET failure ≠ a load failure; keep polling
                live = {}
            value = (live.get(model_id) or {}).get("value") or ""
            if value in ("loaded", "sleeping"):
                return "loaded"
            if value in ("failed", "error"):
                return "failed"
            if log_offset is not None and self._child_exited_since(model_id, log_offset):
                return "failed"
            if self._now() >= deadline:
                return "timeout"
            self._sleep(self._load_poll_interval)

    def _router_log_size(self) -> int:
        """Byte size of the live router log — the watermark `_confirm_load` scans from,
        so a PREVIOUS attempt's exit line can't fail THIS load."""
        try:
            return os.path.getsize(self._last_log_path) if self._last_log_path else 0
        except OSError:
            return 0

    def _log_appended_since(self, offset: int) -> str:
        """The router-log bytes appended after `offset` (this attempt's POST watermark).
        THE one per-attempt log read (2026-07-21): every failure-signature check —
        child-exit, OOM shed, draft crash, the 1b-F4 unfixable gate — reads THIS, never
        an unwatermarked whole-log tail, so a stale line from a previous attempt or an
        earlier model's failure in the shared router log can never trigger a match."""
        path = self._last_log_path
        if not path:
            return ""
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                f.seek(max(0, offset))
                return f.read()
        except OSError:
            return ""

    def _child_exited_since(self, model_id: str, offset: int) -> bool:
        """The fail-fast death signal (2026-07-11): the router logs a crashed child as
        `instance name=<id> exited with status N` but can keep reporting the id as
        still-`loading` (the brick). Scans only this attempt's appended bytes."""
        return f"instance name={model_id} exited with status" in self._log_appended_since(offset)

    def _router_load_with_backoff(self, entry: ModelIniEntry, fit, server_exe, config) -> None:
        """`POST /models/load` the model, then CONFIRM it went resident by polling `GET /models`
        (the POST is async — a 2xx only accepts). On a child that fails to load AND the spawn log
        looks like CUDA-OOM, re-emit that model's section at a lower `ngl` (+ derived `n_cpu_moe`
        for a MoE) and reload — a router-level mirror of `start_runner`'s ngl-shed back-off, which
        the router bypasses (design §5b, the ngl=999 over-fit).

        The OOM gate matters: a NON-OOM failure (a bad `extra_flags` passthrough, a corrupt or
        mismatched GGUF, a flag the engine rejects) re-emits the SAME overrides, so shedding
        cannot fix it — and each `_bounce_router` knocks down + reloads EVERY healthy co-resident
        model. So a non-OOM failure fails FAST, no shed, no bounce. b9644 auto-offloads an over-fit
        (loads, not fails), so the OOM path rarely fires; whether a router CHILD's OOM text reaches
        the router spawn log is a P1g box-check — if it doesn't, we fail fast (acceptable: the
        emitter never emits ngl=999 and P2's arbiter pre-checks fit). A SYNCHRONOUS reject from the
        POST itself (a 4xx: unknown id / at `models-max`) is NOT an OOM — it propagates out of here
        as the load error. Caller holds `_router_lock`."""
        ngl = fit.n_gpu_layers
        # The shed tracks BOTH knobs (fit-redesign §5.7): a MoE OOM raises ncmoe
        # first (expert bytes leave the GPU, attention + KV stay); ngl sheds only
        # once ncmoe is maxed. Start from the entry's own value — a tune's ncmoe
        # (e.g. 21) must never be silently replaced by a derived one (§1.7's
        # 21 → 4-at-ngl-26 regression, strictly worse each retry).
        ncmoe = entry.n_cpu_moe if entry.n_cpu_moe is not None else fit.n_cpu_moe
        draft_solo_tried = False     # cheap recovery: unloaded co-residents to load the draft solo
        draft_restart_tried = False  # last resort: restarted the engine to load the draft alone
        while True:
            # POST accepts (2xx) or raises on a synchronous 4xx (bad id / at capacity) — the
            # latter is a real error, not OOM, so it propagates (→ _run_load sets error state).
            # The log watermark is captured per attempt (a bounce swaps the log file), so the
            # confirm's child-death scan only sees THIS attempt's lines (fail-fast, 2026-07-11).
            log_offset = self._router_log_size()
            try:
                self._router_load(self._router.url, entry.model_id)
            except RuntimeError as exc:
                # Idempotent adopt (defect E, 2026-07-22 pass-1 plan T5): the router
                # answering "already running" is TRUTH, not a failure — the ledger had
                # drifted (e.g. an unload the child outlived). Fall through to
                # _confirm_load, which verifies the resident child like any other load.
                # Caught HERE (not in _default_router_load) so injected router_load
                # fakes get the same tolerance and the behavior is unit-testable.
                if "already running" not in str(exc).lower():
                    raise
                log.info("router says %s is already running — adopting", entry.model_id)
            outcome = self._confirm_load(entry.model_id, log_offset=log_offset)
            if outcome == "loaded":
                # Defect C (T3): record the entry AS FINALLY LOADED — after any
                # explicit-placement retry / OOM-shed rebind above — so re-emits and
                # bounce-reloads reproduce THIS config, not a DB-derived one. Caller
                # holds `_router_lock` (serialized with every other emit).
                self._active_entries[entry.model_id] = entry
                return
            # 1b-F4: a FIT-PLACED entry (ngl omitted → the child's own `--fit` placed
            # tensors) that fails for ANY reason — the barely-fits fit bugs present as
            # non-OOM exits (#18066) — retries ONCE with the explicit computed values
            # (today's exact path); the ordinary OOM-shed/fail-fast below then governs
            # the now-explicit entry. Never worse than the pre-1b behavior.
            if entry.n_gpu_layers is None:
                # 1b-F4 guard (2026-07-21): the fit-placed retry exists to fix #18066 —
                # barely-fits placement bugs that exit NON-OOM, which explicit placement
                # repairs. But an UNFIXABLE non-OOM failure (a rejected engine flag, an
                # unknown model architecture) re-emits the SAME flags/model, so the retry
                # cannot help — and each _bounce_router knocks down + reloads EVERY healthy
                # co-resident model. Fail FAST on those (no emit, no bounce). Draft-load
                # crashes are EXEMPT: they keep the retry so their solo-escalation path
                # below is reached once placement is explicit.
                _tail = self._log_appended_since(log_offset)  # THIS attempt's lines only
                # An UNFIXABLE failure (rejected flag / unknown architecture) can't be repaired by a
                # retry OR the solo-escalation below — fail fast (no bounce that disrupts other
                # models). This now covers an unfixable DRAFT crash too (e.g. an unknown/unsupported
                # MTP-draft architecture like dspark): the solo path exists for the TRANSIENT co-load
                # RACE ("invalid vector subscript", which is NOT unfixable), never for a draft the
                # engine simply can't load — so a permanently-bad draft no longer wastes two engine
                # restarts before erroring. When a draft is configured, the message names MTP so the
                # user knows to turn it off or set a compatible draft (2026-07-21, the user's ask).
                if _looks_like_unfixable(_tail):
                    _has_draft = bool(entry.overrides.model_draft) or (
                        entry.overrides.spec_type not in (None, "none"))
                    _hint = (
                        " If this is the MTP draft (an unsupported/unknown draft architecture), turn "
                        "MTP off for this model or set a draft the built-in engine can load."
                        if _has_draft else ""
                    )
                    raise RuntimeError(
                        f"model {entry.model_id!r} failed to load (status={outcome}) with an "
                        f"unfixable error — not retrying, since a retry would restart the engine and "
                        f"disrupt other loaded models.{_hint} Details: {_tail[-600:]}"
                    )
                log.warning("router child %s failed under engine fit (%s) — retrying with "
                            "explicit computed placement ngl=%d ncmoe=%d",
                            entry.model_id, outcome, fit.n_gpu_layers, fit.n_cpu_moe)
                entry = ModelIniEntry(
                    model_id=entry.model_id, gguf_path=entry.gguf_path,
                    n_gpu_layers=fit.n_gpu_layers, n_cpu_moe=fit.n_cpu_moe,
                    ctx_len=entry.ctx_len, overrides=entry.overrides,
                    embeddings=entry.embeddings, pooling=entry.pooling,
                    load_on_startup=entry.load_on_startup,
                )
                self._emit_ini(override=entry)
                self._bounce_router(server_exe, config)
                continue
            # failed / timeout: shed GPU layers ONLY on a genuine CUDA-OOM in the spawn log —
            # never on a non-OOM failure (shedding can't fix it and a bounce disrupts residents).
            # Watermarked (2026-07-21): only THIS attempt's appended lines. The old
            # whole-log _tail_file read could match a STALE line — a previous model's
            # OOM shedding this one's layers, or a previous attempt's draft crash
            # re-triggering solo-escalation on an unrelated failure.
            tail = self._log_appended_since(log_offset)
            # MTP/spec draft-load crash (2026-07-12): llama.cpp's router crashes the DRAFT
            # model ('invalid vector subscript') when it loads WHILE another child is loading —
            # a transient SCHEDULING race (e.g. an embed switch bounced Gemma + the embed in
            # together), NOT a resource problem. So we NEVER drop speculative decoding to work
            # around it, because a permanent ~1.5-2x decode loss must not be a reaction to a
            # transient crash. (Nothing drops MTP automatically for VRAM reasons: since
            # 2026-07-19 `compute_fit` CHARGES the draft's weights + KV to the budget, so a
            # draft that doesn't fit sheds MAIN-model layers instead of silently disabling
            # speculation. The only automatic strip is the .ini emitter's missing-draft one,
            # which is loud. An earlier version of this comment credited compute_fit with a
            # drop-MTP decision it has never made.) Instead, remove the concurrency and
            # load the draft SOLO — keeping MTP — escalating cheapest-first, and surface WHY the
            # load runs long so the user isn't watching a silent spinner.
            has_draft = bool(entry.overrides.model_draft) or (
                entry.overrides.spec_type not in (None, "none"))
            if _looks_like_draft_failure(tail) and has_draft:
                others = [mid for mid in list(self._resident) if mid != entry.model_id]
                # Stage 1 (cheap, NO restart): unload the co-resident(s) that raced the draft,
                # then reload the draft-model solo. They reload lazily on next use — an embed
                # has no draft, so it co-loads fine beside the warm draft-model afterwards.
                if not draft_solo_tried and others:
                    draft_solo_tried = True
                    log.warning("router child %s crashed loading its MTP draft beside %s — "
                                "unloading co-residents to load the draft solo (MTP kept; they "
                                "reload on next use)", entry.model_id, ", ".join(sorted(others)))
                    self._touch(entry.model_id,
                                detail="freeing another model so fast generation (MTP) loads cleanly…")
                    for mid in others:
                        self._evict_resident(mid)
                    continue
                # Stage 2 (last resort): a full engine restart to load the draft-model ALONE.
                # entry KEEPS its draft — MTP preserved. Stale co-residents dropped first so the
                # restart comes up empty (this still-`starting` model isn't in the bounce's
                # reload set), then the loop below re-POSTs it solo.
                if not draft_restart_tried:
                    draft_restart_tried = True
                    log.warning("router child %s still crashed on its MTP draft — restarting the "
                                "engine to load it alone (MTP kept)", entry.model_id)
                    self._touch(entry.model_id,
                                detail="restarting the engine to load fast generation (MTP) cleanly — this takes a little longer…")
                    for mid in [m for m in list(self._resident) if m != entry.model_id]:
                        self._resident.pop(mid, None)
                        self._arbiter.release(mid)
                    self._emit_ini(override=entry)
                    self._bounce_router(server_exe, config)
                    continue
                # Solo AND a clean restart both still crashed on the draft → NOT the co-load
                # race: the draft itself is the problem (corrupt/mismatched draft GGUF, or it
                # genuinely doesn't fit). Surface the real error — never silently degrade to
                # no-MTP. Ordered by likelihood (2026-07-24, user report): the common cause is
                # a tune that lowered n_cpu_moe (more experts on the GPU → no room left for the
                # draft), so raising it back is the FIRST fix; re-download / MTP-off follow.
                raise RuntimeError(
                    f"model {entry.model_id!r} could not load its speculative-decoding (MTP) draft "
                    f"even on its own (status={outcome}). Most often the tune left too little VRAM "
                    f"for the draft — raise n_cpu_moe (fewer experts on the GPU) in the model's "
                    f"tune. Otherwise the draft may be corrupt (re-download it) or you can turn MTP "
                    f"off. Details: {tail[-400:]}"
                )
            can_raise_ncmoe = fit.is_moe and (ncmoe or 0) < fit.block_count
            if (ngl > 0 or can_raise_ncmoe) and _looks_like_oom(tail):
                if can_raise_ncmoe:
                    ncmoe = min(fit.block_count, (ncmoe or 0) + _BACKOFF_STEP)
                    log.warning("router child %s OOM (%s) — raising n-cpu-moe to %d "
                                "(ngl stays %d) + reload",
                                entry.model_id, outcome, ncmoe, ngl)
                else:
                    ngl = max(0, ngl - _BACKOFF_STEP)
                    log.warning("router child %s OOM (%s) — re-emit at ngl=%d + reload",
                                entry.model_id, outcome, ngl)
                entry = ModelIniEntry(
                    model_id=entry.model_id, gguf_path=entry.gguf_path, n_gpu_layers=ngl,
                    n_cpu_moe=ncmoe, ctx_len=entry.ctx_len, overrides=entry.overrides,
                    embeddings=entry.embeddings, pooling=entry.pooling,
                    load_on_startup=entry.load_on_startup,
                )
                self._emit_ini(override=entry)
                self._bounce_router(server_exe, config)
                continue
            raise RuntimeError(
                f"model {entry.model_id!r} failed to load (status={outcome}, ngl={ngl}): {tail[-600:]}"
            )

    def _run_download(self, model_id: str) -> None:
        """Per-model download-only worker (OWN channel): wait for an admission slot, fetch the
        weights — AND the external MTP draft when the resolved config wants it (2026-07-19), so
        "Downloaded ✓" is honest and the first load never surprise-fetches — ground the catalog
        type from the file, then DROP this model's map entry (absent == done; /models reports it
        on-disk). It NEVER touches the model run-state (_resident/_router), so a running model —
        or a sibling download — is undisturbed. The engine is NOT required to download, only to
        load: the draft decision reads the effective config via `_switches_to_overrides` (a pure
        DB read + memoized hardware keys), so the engine-free promise still HOLDS. Success/cancel
        remove the entry; a failure leaves a persistent "error" entry until a fresh download()."""
        cancel_ev = self._download_cancels.get(model_id) or threading.Event()
        try:
            self._await_slot(model_id, cancel_ev)   # park while at the concurrency ceiling; sets detail

            def _progress(downloaded: int, total: int | None) -> None:
                e = self._download_states.get(model_id)
                if e is not None:   # a concurrent cancel may have dropped it
                    e["downloaded"] = downloaded
                    e["total"] = total or 0

            def _progress_draft(downloaded: int, total: int | None) -> None:
                e = self._download_states.get(model_id)
                if e is not None:
                    e["detail"] = "MTP draft model"
                    e["downloaded"] = downloaded
                    e["total"] = total or 0

            def _reset_progress() -> None:
                # Neutral phase + zeroed counters between the legs (main bytes must not linger
                # under the draft's label); the draft's phase comes from its own callback, only
                # when it actually downloads.
                e = self._download_states.get(model_id)
                if e is not None:
                    e["detail"] = "preparing"
                    e["downloaded"] = 0
                    e["total"] = 0

            ov = _switches_to_overrides(self._switches_fn(model_id) or {})
            self._acquire_and_identify(  # raises ValueError for unknown model
                model_id, _progress, cancel_check=cancel_ev.is_set,
                overrides=ov, on_progress_draft=_progress_draft, reset_progress=_reset_progress)
            with self._lock:
                self._download_states.pop(model_id, None)   # done → idle (weights on disk)
        except DownloadCancelled:
            # User cancel is not an error — the partial part-files stay cached (a re-download
            # resumes past them); drop the entry so the row reads "available" again.
            log.info("runner download cancelled for %s", model_id)
            with self._lock:
                self._download_states.pop(model_id, None)
        except Exception as exc:  # noqa: BLE001 — any failure becomes a persistent error entry
            log.exception("runner download failed")
            with self._lock:
                self._download_states[model_id] = {"status": "error", "modelId": model_id,
                                                   "detail": "", "error": str(exc),
                                                   "downloaded": 0, "total": 0}
        finally:
            # Release the admission slot + wake the next queued worker; drop this model's
            # thread + cancel refs (the map ENTRY may persist on error, but the machinery
            # that ran it is done). One critical section via the shared gate lock.
            with self._download_gate:
                self._download_cancels.pop(model_id, None)
                self._download_threads.pop(model_id, None)
                self._download_gate.notify_all()


_service: RunnerService | None = None


def configure_service(
    *,
    catalog_fn=None,
    switches_fn=None,
    profile_switches_fn=None,
    identify_fn=None,
    embedding_ids_fn=None,
    default_llm_id_fn=None,
    config_fn=None,
    hardware_fn=None,
    cache_root: str | None = None,
    runtime_root: str | None = None,
    knob_backends_fn=None,
    measurements_fn=None,
    class_bw_fn=None,
    record_probe_fn=None,
    record_load_fn=None,
    fit_relevant_flags_fn=None,
    declared_claim_fn=None,
) -> RunnerService:
    """Host hook to construct the singleton with DB-backed catalog/switches/config
    (and any other injections). Call ONCE at boot, before `get_service()`.
    Returns the constructed singleton.

    `runtime_root` splits what this app GENERATES (models.ini, spawn logs) out of the
    cache. Pass it whenever `cache_root` is shared with a sibling app — otherwise the
    two apps overwrite each other's preset file. None keeps the legacy in-cache spot."""
    global _service
    root = cache_root or os.environ.get("LLM_RUNNER_CACHE") or str(Path.home() / ".cache" / "just-llm-runner")
    kwargs = {}
    if runtime_root:
        kwargs["runtime_root"] = runtime_root
    if catalog_fn is not None:
        kwargs["catalog_fn"] = catalog_fn
    if switches_fn is not None:
        kwargs["switches_fn"] = switches_fn
    if profile_switches_fn is not None:
        kwargs["profile_switches_fn"] = profile_switches_fn
    if identify_fn is not None:
        kwargs["identify_fn"] = identify_fn
    if embedding_ids_fn is not None:
        kwargs["embedding_ids_fn"] = embedding_ids_fn
    if default_llm_id_fn is not None:
        kwargs["default_llm_id_fn"] = default_llm_id_fn
    if config_fn is not None:
        kwargs["config_fn"] = config_fn
    if hardware_fn is not None:
        kwargs["hardware_fn"] = hardware_fn
    if knob_backends_fn is not None:
        kwargs["knob_backends_fn"] = knob_backends_fn
    if measurements_fn is not None:
        kwargs["measurements_fn"] = measurements_fn
    if class_bw_fn is not None:
        kwargs["class_bw_fn"] = class_bw_fn
    if record_probe_fn is not None:
        kwargs["record_probe_fn"] = record_probe_fn
    if record_load_fn is not None:
        kwargs["record_load_fn"] = record_load_fn
    if fit_relevant_flags_fn is not None:
        kwargs["fit_relevant_flags_fn"] = fit_relevant_flags_fn
    if declared_claim_fn is not None:
        kwargs["declared_claim_fn"] = declared_claim_fn
    _service = RunnerService(root, **kwargs)
    return _service


def get_service() -> RunnerService:
    """Process-wide singleton. Cache root from LLM_RUNNER_CACHE or the user
    cache home (the runner is app-agnostic — it owns its own cache dir).
    Hosts should call `configure_service(...)` once at boot to wire DB-backed
    catalog/switches; otherwise this falls back to the manifest-only standalone."""
    global _service
    if _service is None:
        root = os.environ.get("LLM_RUNNER_CACHE") or str(Path.home() / ".cache" / "just-llm-runner")
        _service = RunnerService(root)
    return _service


def configured_service() -> RunnerService | None:
    """The singleton IF a host wired one — never the standalone fallback.

    `get_service()` cannot answer "is the runner actually wired here?": it builds a
    default pointed at `~/.cache/just-llm-runner` and hands it back, so a caller
    asking only for the cache path gets a confident wrong answer in an app that
    mounts the platform routers without the runner. Anything that MEASURES or
    REPORTS (rather than drives) the engine should ask this and fall back itself."""
    return _service
