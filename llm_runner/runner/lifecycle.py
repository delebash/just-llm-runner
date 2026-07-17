# SPDX-License-Identifier: GPL-3.0-or-later
"""Load/run lifecycle for the built-in runner — the "choose → load on demand →
use" half of the shared model (see the JustWrite server-side-LLM decision doc).

A singleton `RunnerService` acquires the llama.cpp binary + the GGUF weights and
spawns llama-server, exposing a pollable status so the GUI can show progress.
The heavy work runs on a background thread. `acquire_binary` / `acquire_model` /
`start_runner` (the parts that download + spawn — not runnable in CI) are
injectable, so the state machine itself is fully testable offline.
"""

from __future__ import annotations

import logging
import os
import shutil
import threading
import time
from pathlib import Path

import requests

from dataclasses import fields as _dc_fields, replace as _dc_replace

from .arbiter import get_arbiter as _get_arbiter
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
from .config import default_config as _default_config
from .gguf import read_gguf_metadata as _read_gguf_metadata
from .hardware import detect as _detect, max_vram_mb as _hw_max_vram, used_vram_mb as _hw_used_vram
from .download import DownloadCancelled, download_kwargs
from .models import acquire_model as _acquire_model, cached_gguf_path
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
    _tail_file,
    compute_fit,
    emit_models_ini,
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
# ignore this — a child must go regardless of its footprint.
_EVICT_MIN_MB = 600

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


def _default_measure_probe(url: str, prompt: str, max_tokens: int, model_id: str = "") -> tuple[int, float]:
    """POST a fixed prompt to the running llama-server → (completion_tokens,
    decode_ms). In router mode the body carries `"model"` so the router dispatches to
    the right resident child. A real network call to the live model — injected in tests."""
    body: dict = {"messages": [{"role": "user", "content": prompt}], "max_tokens": max_tokens, "stream": False}
    if model_id:
        body["model"] = model_id
    t0 = time.monotonic()
    resp = requests.post(url.rstrip("/") + "/v1/chat/completions", json=body, timeout=120)
    ms = (time.monotonic() - t0) * 1000
    resp.raise_for_status()
    usage = (resp.json() or {}).get("usage") or {}
    return int(usage.get("completion_tokens") or 0), ms


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
    arbiter drives this explicitly; auto-sleep is unreliable). Injected in tests."""
    resp = requests.post(url.rstrip("/") + "/models/unload", json={"model": model_id}, timeout=120)
    if resp.status_code >= 400:
        raise RuntimeError(f"/models/unload {model_id!r} failed [{resp.status_code}]: {resp.text[:800]}")


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


def _engine_idle() -> dict:
    # Separate channel from the model-load state (a model load must not clobber
    # engine-install progress, and vice-versa). status ∈ idle|installing|installed|error.
    return {"status": "idle", "detail": "", "error": "", "downloaded": 0, "total": 0}


def _download_idle() -> dict:
    # Its OWN channel too: a download is a file fetch that must NOT clobber a running
    # model's run-state (same isolation reason as _engine_state), so a download can run
    # concurrently with a loaded model. status ∈ idle | downloading | error.
    return {"status": "idle", "modelId": "", "detail": "", "error": "",
            "downloaded": 0, "total": 0}


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
        router_load=_default_router_load,
        router_unload=_default_router_unload,
        router_models=_default_router_models,
        used_vram_fn=_hw_used_vram,
        now=time.monotonic,
        sleep=time.sleep,
        arbiter=None,
        latest_build_fn=None,
        save_pin=None,
    ):
        self._cache_root = Path(cache_root)
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
        self._router_load = router_load
        self._router_unload = router_unload
        self._router_models = router_models
        self._used_vram_fn = used_vram_fn
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
        self._engine_state = _engine_idle()
        self._lock = threading.Lock()           # resident-set queue mutations
        self._router_lock = threading.Lock()    # serialize router spawn/bounce/emit/load
        self._thread = None
        self._engine_thread = None
        self._engine_cancel = threading.Event()  # set → the engine-install worker aborts mid-download
        self._download_state = _download_idle()
        self._download_thread = None
        self._download_cancel = threading.Event()  # set → the download-only worker aborts
        self._last_log_path = None
        # A3: the binary the CURRENT router actually launched with. A fallback
        # spawn may differ from the preferred build; bounces must reuse the
        # PROVEN exe, never re-try the broken preferred one mid-session.
        self._active_server_exe = None
        # QC-25: the host's pin WRITER (None in standalone mode → no healing).
        # The pin heals upward onto a newer on-disk build at BOOT (here) and
        # POST-INSTALL only — never on a status poll (see _heal_pin_upward).
        self._save_pin = save_pin
        self._heal_pin_upward()

    @property
    def cache_root(self) -> Path:
        """The runner's cache root (binaries + the `hf/` model cache live under
        it). Exposed so the catalog endpoint can check on-disk state without
        reaching into a private attr."""
        return self._cache_root

    def catalog(self) -> list[ModelEntry]:
        """Host-backed downloadable model catalog (DB via catalog_fn). Empty for
        standalone runner use (no host store wired) — the manifest's model list
        is gone (A7)."""
        return self._catalog_fn()

    def config(self):
        """The runner config (binaries + VRAM margin): DB-backed in the host (via
        the injected config_fn), or the seed defaults standalone."""
        return self._config_fn()

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

    # ── Engine install — its OWN once-per-machine step, separate from loading a
    #    model (a load REQUIRES the engine present; see _run_load). ──────────────
    def _installed_build(self, config) -> str | None:
        """The build actually ON DISK (the installed exe's dir), or None when
        nothing is installed. QC-13/QC-25: status, uninstall, the update check
        and the pin heal all report/act on the disk truth — a DB-reset-reverted
        pin must never masquerade as the current version."""
        exe = self._acquired_exe(self.cache_root, config, self._hardware_fn())
        return build_of_exe(self.cache_root, exe) if exe else None

    def _heal_pin_upward(self) -> None:
        """QC-25: converge the PIN onto a NEWER build already on disk — at BOOT
        and POST-INSTALL only, never on a status poll (a poll heal would clobber
        a DELIBERATE downgrade: the user pins an older build and the poll would
        rewrite it before they click Reinstall). Closes the reinstall-downgrade
        hole: a DB reset reverts the pin to the seed while a newer engine sits
        on disk — a pin-keyed Reinstall would fetch the OLD build and the
        stale-build sweep (_run_install) would then delete the newer one.
        No-op without a save_pin writer (standalone mode), when nothing is
        installed, or when the disk build isn't newer than the pin. Best-effort:
        healing must never make boot or an install fail."""
        if self._save_pin is None:
            return
        try:
            config = self._config_fn()
            disk = self._installed_build(config)
            if disk and build_num(disk) > build_num(config.llamacpp.pinned_build):
                self._save_pin(disk)
                log.info("engine pin healed upward to on-disk build %s", disk)
        except Exception:  # noqa: BLE001 — healing is best-effort, never fatal
            log.warning("engine pin heal failed", exc_info=True)

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
            # QC-13: the build actually ON DISK (the exe's dir), which a reverted
            # pin may not name; the pin is only reported when nothing is installed
            # (it is then the build an install would fetch).
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
        """Remove the INSTALLED llama.cpp engine binaries (the whole build dir —
        every per-GPU variant incl. the A3 fallback chain IS the engine). The
        build is resolved from the DISK (QC-13): remove what `engine_status`
        reports installed, which a reverted pin may not name; fall back to the
        pin's dir when nothing resolves. Models in the HF cache are untouched.
        Stops any running model first: a live llama-server holds its exe open,
        and Windows cannot delete an open exe. Refused while an install is in
        flight (the installer thread is writing into the very dir)."""
        with self._lock:
            if self._engine_state["status"] == "installing":
                return {**self._engine_state, "error": "install in progress — wait for it to finish"}
        self.stop()
        config = self._config_fn()
        build = self._installed_build(config) or config.llamacpp.pinned_build
        shutil.rmtree(binary_dir(self.cache_root, build), ignore_errors=True)
        with self._lock:
            self._engine_state = _engine_idle()
        return self.engine_status()

    # ── Reclaim disk: the runner owns its cache, so it owns these deletes (the
    #    SIZES are reported by the shared platform GET /v1/disk/usage). ──────────
    def clear_spawn_logs(self) -> dict:
        """Delete every `*.log` under `<cache>/llamacpp/logs` (the per-spawn
        llama-server logs — UNBOUNDED; nothing else sweeps them). The dir itself is
        KEPT so the next spawn can write. Best-effort: a file that won't unlink (a
        live spawn holding it open on Windows) is skipped, never fatal. Returns
        `{removed, bytes}`."""
        logs_dir = self._cache_root / "llamacpp" / "logs"
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

        # Release any open handle before unlinking. Cancel a download of THIS model, then
        # unload it if resident (leave other residents up — this is a per-model delete).
        dl = self._download_state
        if dl.get("modelId") == model_id and dl.get("status") == "downloading":
            self.cancel_download()
            if self._download_thread is not None:
                self._download_thread.join(timeout=5)
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
        This method never writes the pin (no poll heal — a deliberate downgrade
        pin must survive until the user clicks Reinstall); the heal runs at boot
        + post-install only (_heal_pin_upward). A network failure reports as an
        `error`, never as updateAvailable."""
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
            self._last_id = model_id
            log.info("load %s: starting load thread (trigger=%s)", model_id, trigger)
            self._thread = threading.Thread(
                target=self._run_load, args=(model_id, overrides or Overrides(), job_id, switches), daemon=True,
            )
            self._thread.start()
            return dict(self._resident[model_id])

    def download(self, model_id: str) -> dict:
        """Download a model's GGUF into the cache WITHOUT spawning it — the catalog's
        'Download' action, separate from 'Load'. Runs on its OWN state channel + thread
        (like engine-install) so it NEVER touches the running model's state: a download
        can proceed while another model is loaded. Does NOT require the engine installed
        (that is only needed to spawn). On success the model reports as on-disk via
        /models; loading it is a distinct step."""
        with self._lock:
            if self._download_state["status"] == "downloading":
                return dict(self._download_state)  # a download is already in flight
            self._download_cancel.clear()  # arm a fresh run — drop any prior cancel signal
            self._download_state = {"status": "downloading", "modelId": model_id, "detail": "queued",
                                    "error": "", "downloaded": 0, "total": 0}
            self._download_thread = threading.Thread(target=self._run_download, args=(model_id,), daemon=True)
            self._download_thread.start()
        return dict(self._download_state)

    def cancel_download(self) -> dict:
        """Signal an in-flight download-only op to stop at the next chunk/file boundary
        (the worker polls `cancel_check` per chunk and resets to idle on DownloadCancelled).
        Idempotent: a no-op when nothing is downloading. Only the standalone Download
        channel is cancellable — a model load's download leg is not exposed here."""
        with self._lock:
            if self._download_state["status"] == "downloading":
                self._download_cancel.set()
                self._download_state["detail"] = "cancelling…"
        return dict(self._download_state)

    def download_status(self) -> dict:
        """Progress/terminal state of an in-flight download-only op — its own channel,
        separate from the model run-state (status()) and engine install."""
        return dict(self._download_state)

    def stop(self, model_id: str | None = None) -> dict:
        """`stop(id)` unloads ONE resident model (frees its VRAM; the router stays up for
        the others). `stop()` (no id — the back-compat `/v1/llm-runner/stop`) is a FULL
        teardown: unload everything and stop the router process, matching the old
        single-model `stop()`. Held under `_router_lock` so it can't race a load's router
        ops."""
        # The ask logs BEFORE the lock: a stop that then blocks behind a load's router
        # ops still lands in the log at click time (2026-07-17 — timeline correlation
        # was impossible when only the eventual unload-failed WARNING recorded anything).
        log.info("stop %s", model_id or "<full teardown>")
        with self._router_lock:
            router = self._router
            if model_id:
                if router is not None and router.is_alive():
                    try:
                        self._router_unload(router.url, model_id)
                    except Exception:  # noqa: BLE001 — best-effort
                        log.warning("router unload %s failed", model_id, exc_info=True)
                self._resident.pop(model_id, None)
                self._arbiter.release(model_id)  # free its VRAM reservation
                if self._last_id == model_id:
                    self._last_id = next(iter(self._resident), "")
            else:
                if router is not None:
                    try:
                        router.stop()
                    except Exception:  # noqa: BLE001 — best-effort
                        pass
                self._router = None
                self._resident.clear()
                self._arbiter.clear()  # full teardown → drop the whole VRAM ledger
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
        tune pins the value). Errors soft: unknown / not-downloaded → ok:False."""
        model = next((m for m in self.catalog() if m.id == model_id), None)
        if model is None:
            return {"ok": False, "error": f"unknown model: {model_id}"}
        gguf = self.cached_path(model_id)
        if gguf is None:
            return {"ok": False, "error": "model not downloaded"}
        try:
            ov = _switches_to_overrides(dict(switches) if switches else (self._switches_fn(model_id) or {}))
            meta = self._read_meta(gguf)
            f = compute_fit(meta, gguf.stat().st_size, self._hardware_fn(), ov,
                            safety_margin_mb=self._config_fn().safety_margin_mb)
        except Exception as exc:  # noqa: BLE001 — a preview must never raise into the sweep
            return {"ok": False, "error": str(exc)}
        return {"ok": True, "blockCount": f.block_count, "isMoe": f.is_moe,
                "nGpuLayers": f.n_gpu_layers, "nCpuMoe": f.n_cpu_moe, "ctxLen": f.ctx_len}

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
        if router is None or not router.is_alive() or st is None or st.get("status") != "running":
            return {"ok": False, "error": "no model running — load one first"}
        probe = probe or _default_measure_probe
        sample = sample or _default_measure_sample
        try:
            ct, ms = probe(router.url, prompt, max_tokens, model_id=mid)
        except Exception as exc:  # noqa: BLE001 — surface the probe error, don't crash
            return {"ok": False, "error": str(exc)}
        tps = round(ct / (ms / 1000), 1) if ms > 0 and ct else 0.0
        self._arbiter.touch(mid)  # a measure is a use — keep it warm in the LRU
        return {
            "ok": True, "modelId": mid,
            "tokensPerSec": tps, "completionTokens": ct, "ms": round(ms, 1), **sample(),
        }

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
        snap = self._arbiter.snapshot(hw)  # committed/remaining/total VRAM (hw passed → no re-detect)
        out = {
            "router": False,
            "models_max": cfg.models_max,
            "sleep_idle_seconds": cfg.sleep_idle_seconds,
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
            if s not in ("downloading", "starting", "error"):
                continue
            row = by_id.get(mid)
            if row is None:
                models.append({"id": mid, "status": s, "vram_mb": self._arbiter.reserved_mb(mid)})
            elif row["status"] not in ("loaded", "sleeping", "loading"):
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
        cands = sorted(
            p for p in Path(snapshot_dir).rglob("*.gguf") if quant.lower() in p.name.lower()
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

    def _runner_log_path(self, model_id: str) -> Path:
        """Per-load log file — real `start_runner` creates the dir + redirects the
        merged stdout/stderr here (tailed on failure + by `engine_log`)."""
        safe = "".join(c if c.isalnum() or c in "-_." else "_" for c in model_id)[:60]
        ts = time.strftime("%Y%m%d-%H%M%S")
        return self.cache_root / "llamacpp" / "logs" / f"runner-{safe}-{ts}.log"

    def _router_log_path(self) -> Path:
        """The router's merged stdout/stderr log (tailed on a failed spawn + by
        `engine_log`; a child's CUDA-OOM abort typically surfaces here)."""
        ts = time.strftime("%Y%m%d-%H%M%S")
        return self.cache_root / "llamacpp" / "logs" / f"router-{ts}.log"

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

            if force:
                d = binary_dir(self.cache_root, config.llamacpp.pinned_build)
                if d.exists():
                    shutil.rmtree(d, ignore_errors=True)
            self._acquire_binary(self.cache_root, config, hardware, on_progress=_progress,
                                 cancel_check=self._engine_cancel.is_set)
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
                        shutil.rmtree(d, ignore_errors=True)
                        if d.exists():
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
            # QC-25 post-install heal — AFTER the sweep on purpose: a deliberate
            # downgrade (pin edited older + Reinstall) must complete as pinned;
            # this only converges the pin when a NEWER build survived on disk
            # (e.g. a Windows file-lock defeated the sweep), so status/update
            # stay consistent with what is actually installed.
            self._heal_pin_upward()
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

    def _acquire_and_identify(self, model_id: str, on_progress, cancel_check=None):
        """Shared download IO for load + download (ONE source): resolve the catalog
        model, fetch its GGUF into the cache, and ground the catalog `type` (moe|dense)
        from the file. Returns (model, gguf_path); raises ValueError for an unknown
        model. `on_progress(downloaded, total)` reports bytes to the CALLER's channel.
        `cancel_check` (download-only path) is polled per chunk → raises DownloadCancelled."""
        # The downloadable catalog is HOST-OWNED (DB-backed via .catalog()).
        model = next((m for m in self.catalog() if m.id == model_id), None)
        if model is None:
            raise ValueError(f"unknown model {model_id!r}")
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
        return model, gguf

    def _touch(self, model_id: str, **fields) -> bool:
        """Update a resident model's state dict IF it still exists — a concurrent stop()
        may have dropped it, and we must NOT resurrect a cancelled entry. Returns whether
        the model was present. Used for the out-of-`_router_lock` status writes in
        `_run_load` (the ones inside the lock are guarded by the cancellation re-check)."""
        st = self._resident.get(model_id)
        if st is not None:
            st.update(**fields)
        return st is not None

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

            def _progress(downloaded: int, total: int | None) -> None:
                # Live byte counters the GUI polls via status() to draw a bar.
                self._touch(model_id, downloaded=downloaded, total=total or 0)

            # Engine install is its OWN step (POST /engine/install); a model load
            # REQUIRES it present — fail fast BEFORE the multi-GB download.
            server_exe = self._acquired_exe(self._cache_root, config, hardware)
            if server_exe is None:
                self._touch(model_id, status="error", detail="Install the engine first",
                            error="engine-not-installed", downloaded=0, total=0)
                return

            self._touch(model_id, detail="model weights", downloaded=0, total=0)
            # True load abort (S2): a stop() during this (slow, unlocked) download drops
            # model_id from _resident, so this cancel_check flips True and the fetch aborts
            # at the next chunk — raising DownloadCancelled (caught below). Before this, the
            # download ran to completion and the load only unwound at the router-lock re-check.
            _model, gguf = self._acquire_and_identify(
                model_id, _progress, cancel_check=lambda: model_id not in self._resident)

            # Gemma-style external MTP: the model declares a SEPARATE draft GGUF
            # (catalog mtp_draft_* facts). When the resolved config wants draft-mtp
            # and nothing set model_draft explicitly, acquire the draft next to the
            # main weights — REUSING the same acquire path (the exact file path is
            # its own selector: select_files matches path-substrings and the
            # snapshot preserves relative paths) — then point --model-draft at it.
            # A draft failure fails the LOAD with the real reason (the user asked
            # for MTP; never silently drop to no-MTP). (Plan B, D7)
            if ov.spec_type == "draft-mtp" and not ov.model_draft and getattr(_model, "mtp_draft_file", ""):
                self._touch(model_id, detail="MTP draft model", downloaded=0, total=0)
                draft_repo = _model.mtp_draft_repo or _model.hf_repo
                draft_snapshot = self._acquire_model(
                    draft_repo, _model.mtp_draft_file, None,
                    cache_root=self._cache_root / "hf", on_progress=_progress,
                    cancel_check=lambda: model_id not in self._resident,
                    **download_kwargs(config),
                )
                draft_path = Path(draft_snapshot) / _model.mtp_draft_file
                if not draft_path.exists():
                    raise FileNotFoundError(
                        f"MTP draft downloaded but not found in the snapshot: {_model.mtp_draft_file!r}"
                    )
                ov.model_draft = str(draft_path)

            meta = self._read_meta(gguf)
            # #274 half 2 (2026-07-11): an embed is placed by POLICY (CPU unless the
            # static leftover covers it) BEFORE the fit — never by the child's default.
            self._apply_embed_placement(_model, ov, meta, hardware)
            fit = compute_fit(meta, gguf.stat().st_size, hardware, ov,
                              safety_margin_mb=config.safety_margin_mb)
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
                # A stop() during the (slow, unlocked) download cancels this load by
                # dropping model_id from _resident. stop() ALSO holds _router_lock, so
                # once WE hold it the resident set is stable — re-check before spawning,
                # else we leave a ghost router loaded for a model no one wants (a VRAM
                # leak that status() would report as idle).
                if model_id not in self._resident:
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
                self._admit(model_id, fit.vram_mb, config.models_max, hardware,
                            ngl_explicit=fit.ngl_explicit, is_moe=fit.is_moe,
                            stale_embed_ids=stale_embeds)
                self._resident[model_id].update(status="starting", detail="loading into VRAM",
                                                downloaded=0, total=0)
                vram_before = self._probe_used_vram()
                self._load_via_router(entry, fit, server_exe, config)
                # Pin the configured embed so it is NEVER the LRU eviction victim (P3): a chat co-load
                # evicts another chat, never the embed RAG depends on. A chat model reserves unpinned.
                self._arbiter.reserve(model_id, self._trued_up_vram_mb(fit.vram_mb, vram_before, hardware),
                                      pinned=model_id in embed_ids)
                self._resident[model_id].update(status="running", url=self._router.url,
                                                detail="", error="", downloaded=0, total=0)
        except DownloadCancelled:
            # A stop() during the download aborted the fetch (S2). The model is already gone
            # from _resident (stop popped it), so do NOT set an error state (that would read as
            # a real failure) and do NOT resurrect it — just release any reservation.
            log.info("runner load cancelled during download for %s", model_id)
            self._arbiter.release(model_id)
        except Exception as exc:  # noqa: BLE001 — any failure becomes error state
            log.exception("runner load failed")
            # A concurrent stop() may have cancelled + removed the model — don't resurrect it.
            self._touch(model_id, status="error", detail="", error=str(exc), downloaded=0, total=0)
            self._arbiter.release(model_id)  # never leak a reservation on a failed/cancelled load

    # ── Arbiter admission (P2): co-reside if it fits, else evict the LRU ───────
    #    Called from _run_load under `_router_lock`.

    def _probe_used_vram(self) -> int | None:
        """Snapshot of total used VRAM (MiB) via the injected probe (`used_vram_fn`,
        default `hardware.used_vram_mb`); None when unmeasurable (no nvidia-smi —
        AMD/Metal/CPU boxes) or when the probe itself raises — a probe failure must
        never fail a load."""
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
        cap = _hw_max_vram(hardware) if hardware is not None else 0
        est = min(estimate_mb, cap) if cap > 0 else estimate_mb
        after = self._probe_used_vram()
        if before is None or after is None:
            return est
        measured = max(0, after - before)
        floor = min(est, _DRIVER_CTX_MB) if est > 0 else 0
        return max(measured, floor)

    def _embed_gpu_leftover_mb(self, hardware) -> int:
        """The STATIC VRAM leftover an embedding child may claim: card total minus the
        LOCAL chat default's curated floor (`min_vram_mb`). Static — NOT live free VRAM —
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
        if chat_id:
            row = next((m for m in self.catalog() if m.id == chat_id), None)
            floor = (row.recommended_for.min_vram_mb if row is not None else None) or 0
            return max(0, card - floor) if floor > 0 else 0
        floors = [
            (m.recommended_for.min_vram_mb or 0)
            for m in self.catalog()
            if not getattr(m, "embedding", False)
            and (m.recommended_for.min_vram_mb or 0) > 0
            and cached_gguf_path(m.hf_repo, m.quant, cache_root=self._cache_root / "hf",
                                 mmproj=m.mmproj) is not None
        ]
        if not floors:
            return card
        return max(0, card - max(floors))

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
        if (getattr(model, "tier", "") or "") == "cpu":
            ov.n_gpu_layers = 0
            return
        rec = getattr(model, "recommended_for", None)
        need = (rec.min_vram_mb if rec is not None else None) or 0
        if need <= 0 or need > self._embed_gpu_leftover_mb(hardware):
            ov.n_gpu_layers = 0

    def _admit(self, model_id: str, vram_mb: int, models_max: int, hardware,
               *, ngl_explicit: bool = False, is_moe: bool = False,
               stale_embed_ids: set | None = None) -> None:
        """Make room for a load: evict the LRU non-pinned resident(s) until `model_id` fits the VRAM
        budget AND the child count is under `models_max`. Accounts for `model_id`'s OWN prior
        reservation (a re-tune replaces it, doesn't add) and never evicts `model_id`.

        When nothing is evictable (only pinned models, or only `model_id` remains) and it still
        doesn't fit: a DENSE entry with an EXPLICIT ngl is REFUSED with an actionable error
        (2026-07-11) — the child's `--fit` auto-placement ABORTS on a user-set ngl ("n_gpu_layers
        already set by user, abort"), so there is NO safety net and the spawn dies (observed:
        `invalid vector subscript` on the draft load, then a 6-minute poll to timeout). Everything
        else PROCEEDS with a warning — a MoE's fit estimate over-books (no `n-cpu-moe` term), so
        refusing on it would block loads that actually fit; a fit-placed (ngl-omitted) entry keeps
        the child's auto-offload as its net. Caller holds `_router_lock`; `hardware` is passed in
        (already detected) so the arbiter doesn't re-run nvidia-smi per loop."""
        arb = self._arbiter
        own = arb.reserved_mb(model_id) or 0  # freeing our own reservation adds this back to the budget
        while True:
            fits = vram_mb <= arb.remaining_mb(hw=hardware) + own
            n_others = arb.count() - (1 if arb.is_reserved(model_id) else 0)
            if fits and n_others < models_max:
                return
            # A VRAM-driven eviction skips ~zero-VRAM victims (a CPU embed can't make a
            # GPU model fit); a COUNT-cap eviction must remove a child regardless. A
            # REPLACED embed (resident but no longer the routing default) goes FIRST
            # under ANY constraint — dead weight; the embed slot swaps (2026-07-12).
            over_count = n_others >= models_max
            victim = None
            if stale_embed_ids:
                victim = arb.pick_evict(exclude=model_id, min_mb=0, among=stale_embed_ids)
            if victim is None:
                victim = arb.pick_evict(exclude=model_id, min_mb=0 if over_count else _EVICT_MIN_MB)
            if victim is None:
                if not fits and ngl_explicit and not is_moe:
                    others = ", ".join(sorted(k for k in self._resident if k != model_id)) or "none"
                    raise RuntimeError(
                        f"Not enough free VRAM to load {model_id!r}: it needs ~{vram_mb} MB but only "
                        f"{arb.remaining_mb(hw=hardware) + own} MB remain and the resident models "
                        f"({others}) are pinned. Unload a model, pick a smaller embedding model, or "
                        f"lower this model's GPU layers in its tune."
                    )
                if not fits:
                    log.warning(
                        "arbiter: %s over budget (needs %d MB, %d MB remain) with nothing evictable"
                        " — proceeding; the spawn safety nets decide",
                        model_id, vram_mb, arb.remaining_mb(hw=hardware) + own)
                return  # only pinned / just this model → proceed; the safety nets handle over-fit
            log.info("arbiter: evict LRU %s to make room for %s (needs %d MB)", victim, model_id, vram_mb)
            self._evict_resident(victim)

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

    def _resolve_ini_entries(self, override: ModelIniEntry | None) -> list[ModelIniEntry]:
        """One `ModelIniEntry` per ON-DISK catalog model, IN CATALOG ORDER (a STABLE
        `.ini` text so a co-resident load doesn't spuriously bounce — the text only
        changes when a section's flags actually change). `override` (the model being
        loaded) REPLACES that model's section IN PLACE so it carries this load's exact
        fit + any Lab tuning (Option A); the rest are DB-resolved from `switches_fn`. A
        model whose meta/fit fails is skipped, not fatal to the whole `.ini`."""
        hardware = self._hardware_fn()
        margin = self._config_fn().safety_margin_mb
        hf_cache = self._cache_root / "hf"
        entries: list[ModelIniEntry] = []
        catalog = list(self.catalog())
        for m in catalog:
            if override is not None and m.id == override.model_id:
                entries.append(override)  # this load's exact section, in the model's slot
                continue
            gguf = cached_gguf_path(m.hf_repo, m.quant, cache_root=hf_cache, mmproj=m.mmproj)
            if gguf is None:
                continue  # not on disk → no section (a section needs the file for compute_fit)
            try:
                ov = _switches_to_overrides(self._switches_fn(m.id) or {})
                # Plan B D7 (diff-checker fold): the auto-mtp layer can put
                # `draft-mtp` on a PASSIVE co-resident section too. Point it at the
                # CACHED draft when present; if the draft was never downloaded,
                # STRIP spec for this section — no network in the ini emitter, and
                # `spec-type = draft-mtp` without a `model-draft` line would hand
                # llama-server a broken preset on a router bounce. The first ACTIVE
                # load of that model acquires the draft (fail-loud) + re-emits.
                if ov.spec_type == "draft-mtp" and not ov.model_draft and getattr(m, "mtp_draft_file", ""):
                    cached_draft = self._cached_draft_path(m, hf_cache)
                    if cached_draft is not None:
                        ov.model_draft = str(cached_draft)
                    else:
                        ov.spec_type = None
                        ov.spec_n_max = None
                meta = self._read_meta(gguf)
                # #274 half 2 — the same embed placement rule as the active-load path,
                # so a PASSIVE section can't hand the embed to the child's GPU default.
                self._apply_embed_placement(m, ov, meta, hardware)
                fit = compute_fit(meta, gguf.stat().st_size, hardware, ov, safety_margin_mb=margin)
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
        path = self._cache_root / "llamacpp" / "models.ini"
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
        self._router = self._start_router(
            server_exe,
            models_dir=self._cache_root / "hf",
            models_preset=self._cache_root / "llamacpp" / "models.ini",
            models_max=config.models_max,
            sleep_idle_seconds=config.sleep_idle_seconds,
            host=DEFAULT_HOST, port=DEFAULT_PORT, log_path=log_path,
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

    def _child_exited_since(self, model_id: str, offset: int) -> bool:
        """The fail-fast death signal (2026-07-11): the router logs a crashed child as
        `instance name=<id> exited with status N` but can keep reporting the id as
        still-`loading` (the brick). Scan only the bytes appended after `offset` (this
        load's POST watermark). Same log-tail technique the OOM gate already uses."""
        path = self._last_log_path
        if not path:
            return False
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                f.seek(max(0, offset))
                appended = f.read()
        except OSError:
            return False
        return f"instance name={model_id} exited with status" in appended

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
        draft_solo_tried = False     # cheap recovery: unloaded co-residents to load the draft solo
        draft_restart_tried = False  # last resort: restarted the engine to load the draft alone
        while True:
            # POST accepts (2xx) or raises on a synchronous 4xx (bad id / at capacity) — the
            # latter is a real error, not OOM, so it propagates (→ _run_load sets error state).
            # The log watermark is captured per attempt (a bounce swaps the log file), so the
            # confirm's child-death scan only sees THIS attempt's lines (fail-fast, 2026-07-11).
            log_offset = self._router_log_size()
            self._router_load(self._router.url, entry.model_id)
            outcome = self._confirm_load(entry.model_id, log_offset=log_offset)
            if outcome == "loaded":
                return
            # 1b-F4: a FIT-PLACED entry (ngl omitted → the child's own `--fit` placed
            # tensors) that fails for ANY reason — the barely-fits fit bugs present as
            # non-OOM exits (#18066) — retries ONCE with the explicit computed values
            # (today's exact path); the ordinary OOM-shed/fail-fast below then governs
            # the now-explicit entry. Never worse than the pre-1b behavior.
            if entry.n_gpu_layers is None:
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
            tail = _tail_file(self._last_log_path) if self._last_log_path else ""
            # MTP/spec draft-load crash (2026-07-12): llama.cpp's router crashes the DRAFT
            # model ('invalid vector subscript') when it loads WHILE another child is loading —
            # a transient SCHEDULING race (e.g. an embed switch bounced Gemma + the embed in
            # together), NOT a resource problem. So we NEVER drop speculative decoding to work
            # around it: dropping MTP is ONLY ever a deliberate FIT decision for a draft that
            # doesn't fit VRAM (made in compute_fit), because a permanent ~1.5-2x decode loss
            # must not be a reaction to a transient crash. Instead, remove the concurrency and
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
                # no-MTP. The user can re-download the draft or turn MTP off in the tune.
                raise RuntimeError(
                    f"model {entry.model_id!r} could not load its speculative-decoding (MTP) draft "
                    f"even on its own (status={outcome}). The draft file may be corrupt or too "
                    f"large for VRAM — re-download it, or turn MTP off in the model's tune. "
                    f"Details: {tail[-400:]}"
                )
            if ngl > 0 and _looks_like_oom(tail):
                ngl = max(0, ngl - _BACKOFF_STEP)
                n_cpu_moe = max(0, fit.block_count - ngl) if fit.is_moe else entry.n_cpu_moe
                log.warning("router child %s OOM (%s) — re-emit at ngl=%d + reload",
                            entry.model_id, outcome, ngl)
                entry = ModelIniEntry(
                    model_id=entry.model_id, gguf_path=entry.gguf_path, n_gpu_layers=ngl,
                    n_cpu_moe=n_cpu_moe, ctx_len=entry.ctx_len, overrides=entry.overrides,
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
        """Download-only worker (OWN channel): fetch the weights + ground the catalog
        type from the file, then mark the download idle. It NEVER touches the model
        run-state (_state/_runner), so a running model is undisturbed. The engine is
        not required to download — only to load."""
        try:
            def _progress(downloaded: int, total: int | None) -> None:
                self._download_state["downloaded"] = downloaded
                self._download_state["total"] = total or 0

            self._download_state.update(detail="model weights", downloaded=0, total=0)
            self._acquire_and_identify(  # raises ValueError for unknown model
                model_id, _progress, cancel_check=self._download_cancel.is_set)
            self._download_state = _download_idle()  # done; /models reports it on-disk. No spawn.
        except DownloadCancelled:
            # User cancel is not an error — the partial blob stays cached (a re-download
            # resumes past it); return the channel to idle so the row reads "available".
            log.info("runner download cancelled for %s", model_id)
            self._download_state = _download_idle()
        except Exception as exc:  # noqa: BLE001 — any failure becomes error state
            log.exception("runner download failed")
            self._download_state = {"status": "error", "modelId": model_id, "detail": "",
                                    "error": str(exc), "downloaded": 0, "total": 0}


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
    save_pin_fn=None,
    cache_root: str | None = None,
) -> RunnerService:
    """Host hook to construct the singleton with DB-backed catalog/switches/config
    (and any other injections). Call ONCE at boot, before `get_service()`.
    Returns the constructed singleton."""
    global _service
    root = cache_root or os.environ.get("LLM_RUNNER_CACHE") or str(Path.home() / ".cache" / "just-llm-runner")
    kwargs = {}
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
    if save_pin_fn is not None:
        kwargs["save_pin"] = save_pin_fn
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
