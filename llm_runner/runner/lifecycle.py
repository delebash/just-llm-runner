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

from dataclasses import fields as _dc_fields

from .arbiter import get_arbiter as _get_arbiter
from .binary import acquire_binary as _acquire_binary
from .binary import acquired_server_exe, binary_dir, select_binary
from .config import default_config as _default_config
from .gguf import read_gguf_metadata as _read_gguf_metadata
from .hardware import detect as _detect, max_vram_mb as _hw_max_vram
from .models import acquire_model as _acquire_model, cached_gguf_path
from .process import (
    DEFAULT_HOST,
    DEFAULT_PORT,
    ModelIniEntry,
    Overrides,
    RouterHandle,
    _BACKOFF_STEP,
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
        acquire_binary=_acquire_binary,
        acquired_exe=acquired_server_exe,
        acquire_model=_acquire_model,
        read_meta=_read_gguf_metadata,
        start_router=_start_router,
        router_load=_default_router_load,
        router_unload=_default_router_unload,
        router_models=_default_router_models,
        now=time.monotonic,
        sleep=time.sleep,
        arbiter=None,
    ):
        self._cache_root = Path(cache_root)
        self._config_fn = config_fn
        self._hardware_fn = hardware_fn
        self._catalog_fn = catalog_fn
        self._switches_fn = switches_fn
        self._profile_switches_fn = profile_switches_fn
        self._identify_fn = identify_fn
        self._acquire_binary = acquire_binary
        self._acquired_exe = acquired_exe
        self._acquire_model = acquire_model
        self._read_meta = read_meta
        self._start_router = start_router
        self._router_load = router_load
        self._router_unload = router_unload
        self._router_models = router_models
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
        self._download_state = _download_idle()
        self._download_thread = None
        self._last_log_path = None

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
    def engine_status(self) -> dict:
        """Is the llama.cpp engine installed for THIS box? Reports the selected
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
        return {
            "installed": exe is not None,
            "serverExe": str(exe) if exe else "",
            "build": config.llamacpp.pinned_build,
            "gpu": asset.gpu if asset else "",
            "platform": hardware.platform,
            "hasRuntime": has_runtime,
            **self._engine_state,
        }

    def install_engine(self, force: bool = False) -> dict:
        """Download + unpack the llama.cpp engine for this box (its OWN step, not
        folded into a model load). Idempotent unless `force`. Runs on a dedicated
        thread so it can't clobber an in-flight model load."""
        with self._lock:
            if self._engine_state["status"] == "installing":
                return dict(self._engine_state)
            self._engine_state = {"status": "installing", "detail": "llama.cpp engine",
                                  "error": "", "downloaded": 0, "total": 0}
            self._engine_thread = threading.Thread(
                target=self._run_install, args=(force,), daemon=True,
            )
            self._engine_thread.start()
        return dict(self._engine_state)

    def engine_log(self, tail: int = 200) -> dict:
        """Tail of the most recent llama-server spawn log (the 'view log'
        affordance) — empty when nothing has spawned yet."""
        path = self._last_log_path
        if not path or not Path(path).exists():
            return {"path": "", "text": ""}
        return {"path": str(path), "text": _tail_file(path, tail)}

    def load(
        self, model_id: str, overrides: Overrides | None = None,
        job_id: str | None = None, switches: dict[str, str] | None = None,
    ) -> dict:
        """Make `model_id` resident in the router (spawning the router LAZILY on the
        first call). The in-flight guard is PER-MODEL now — loading a DIFFERENT model
        while one is loading proceeds (co-residence within `models_max`); a second load
        of the SAME in-flight model returns its current state. Heavy work runs on a
        background thread (`_run_load`)."""
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
            self._download_state = {"status": "downloading", "modelId": model_id, "detail": "queued",
                                    "error": "", "downloaded": 0, "total": 0}
            self._download_thread = threading.Thread(target=self._run_download, args=(model_id,), daemon=True)
            self._download_thread.start()
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
        seen: set[str] = set()
        for mid, info in live.items():
            meta = info.get("meta") or {}
            models.append({
                "id": mid,
                "status": info.get("value") or "unloaded",
                "n_params": meta.get("n_params"),
                "size_bytes": meta.get("size"),
                "n_ctx": meta.get("n_ctx"),
                "vram_mb": self._arbiter.reserved_mb(mid),  # GPU-resident VRAM the arbiter reserved
            })
            seen.add(mid)
        # A load still downloading/starting — or one that ERRORED before the router saw it (e.g.
        # engine-not-installed → the router never spawned, so GET /models can't report it) — is
        # not a router section; surface it too so the catalog shows progress / the failure (and
        # its install-engine CTA) that would otherwise be lost when reading only the router.
        # Snapshot to a list: `_evict_resident` pops `_resident` from the load thread under
        # `_router_lock`, so iterating the live dict here (the API thread) could raise "dict changed
        # size"; `list(...)` is atomic under the GIL, giving a stable view without a shared lock.
        for mid, st in list(self._resident.items()):
            if mid in seen:
                continue
            s = st.get("status")
            if s in ("downloading", "starting", "error"):
                models.append({"id": mid, "status": s, "vram_mb": self._arbiter.reserved_mb(mid)})
        out["models"] = models
        return out

    def remaining_vram_mb(self, hw=None) -> int:
        """VRAM left after the committed-resident set — the budget-aware VRAM `api.py get_models`
        feeds `coarse_fit` (design §5c). Delegates to the arbiter (the `fit.py` math is unchanged;
        only the VRAM fed in shrinks by what's already resident)."""
        return self._arbiter.remaining_mb(hw)

    # ── internals ─────────────────────────────────────────────────────────

    def _main_gguf(self, snapshot_dir, quant: str) -> Path:
        cands = sorted(
            p for p in Path(snapshot_dir).rglob("*.gguf") if quant.lower() in p.name.lower()
        )
        if not cands:
            raise FileNotFoundError(f"no .gguf for quant {quant!r} in {snapshot_dir}")
        return cands[0]  # first shard of a split model loads the rest

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

    def _run_install(self, force: bool) -> None:
        try:
            config = self._config_fn()
            hardware = self._hardware_fn()
            if force:
                d = binary_dir(self.cache_root, config.llamacpp.pinned_build)
                if d.exists():
                    shutil.rmtree(d, ignore_errors=True)

            def _progress(downloaded: int, total: int | None) -> None:
                self._engine_state["downloaded"] = downloaded
                self._engine_state["total"] = total or 0

            self._acquire_binary(self.cache_root, config, hardware, on_progress=_progress)
            self._engine_state = {"status": "installed", "detail": "", "error": "",
                                  "downloaded": 0, "total": 0}
        except Exception as exc:  # noqa: BLE001 — any failure becomes error state
            log.exception("engine install failed")
            self._engine_state = {"status": "error", "detail": "", "error": str(exc),
                                  "downloaded": 0, "total": 0}

    def _acquire_and_identify(self, model_id: str, on_progress):
        """Shared download IO for load + download (ONE source): resolve the catalog
        model, fetch its GGUF into the cache, and ground the catalog `type` (moe|dense)
        from the file. Returns (model, gguf_path); raises ValueError for an unknown
        model. `on_progress(downloaded, total)` reports bytes to the CALLER's channel."""
        # The downloadable catalog is HOST-OWNED (DB-backed via .catalog()).
        model = next((m for m in self.catalog() if m.id == model_id), None)
        if model is None:
            raise ValueError(f"unknown model {model_id!r}")
        snapshot = self._acquire_model(
            model.hf_repo, model.quant, model.mmproj, cache_root=self._cache_root / "hf",
            on_progress=on_progress,
        )
        gguf = self._main_gguf(snapshot, model.quant)
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
            _model, gguf = self._acquire_and_identify(model_id, _progress)
            meta = self._read_meta(gguf)
            fit = compute_fit(meta, gguf.stat().st_size, hardware, ov,
                              safety_margin_mb=config.safety_margin_mb)
            entry = ModelIniEntry(
                model_id=model_id, gguf_path=str(gguf), n_gpu_layers=fit.n_gpu_layers,
                n_cpu_moe=fit.n_cpu_moe, ctx_len=fit.ctx_len, overrides=ov,
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
                # AFTER a confirmed load (below), so the ledger never holds a non-resident model.
                self._admit(model_id, fit.vram_mb, config.models_max, hardware)
                self._resident[model_id].update(status="starting", detail="loading into VRAM",
                                                downloaded=0, total=0)
                self._load_via_router(entry, fit, server_exe, config)
                self._arbiter.reserve(model_id, fit.vram_mb, pinned=False)
                self._resident[model_id].update(status="running", url=self._router.url,
                                                detail="", error="", downloaded=0, total=0)
        except Exception as exc:  # noqa: BLE001 — any failure becomes error state
            log.exception("runner load failed")
            # A concurrent stop() may have cancelled + removed the model — don't resurrect it.
            self._touch(model_id, status="error", detail="", error=str(exc), downloaded=0, total=0)
            self._arbiter.release(model_id)  # never leak a reservation on a failed/cancelled load

    # ── Arbiter admission (P2): co-reside if it fits, else evict the LRU ───────
    #    Called from _run_load under `_router_lock`.

    def _admit(self, model_id: str, vram_mb: int, models_max: int, hardware) -> None:
        """Make room for a load: evict the LRU non-pinned resident(s) until `model_id` fits the VRAM
        budget AND the child count is under `models_max`. Accounts for `model_id`'s OWN prior
        reservation (a re-tune replaces it, doesn't add) and never evicts `model_id`. If nothing is
        evictable (only pinned models, or only `model_id` remains) it PROCEEDS anyway — the spawn OOM
        back-off + the build's CPU auto-offload are the final safety nets. Caller holds `_router_lock`;
        `hardware` is passed in (already detected) so the arbiter doesn't re-run nvidia-smi per loop."""
        arb = self._arbiter
        own = arb.reserved_mb(model_id) or 0  # freeing our own reservation adds this back to the budget
        while True:
            fits = vram_mb <= arb.remaining_mb(hw=hardware) + own
            n_others = arb.count() - (1 if arb.is_reserved(model_id) else 0)
            if fits and n_others < models_max:
                return
            victim = arb.pick_evict(exclude=model_id)
            if victim is None:
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
        for m in self.catalog():
            if override is not None and m.id == override.model_id:
                entries.append(override)  # this load's exact section, in the model's slot
                continue
            gguf = cached_gguf_path(m.hf_repo, m.quant, cache_root=hf_cache, mmproj=m.mmproj)
            if gguf is None:
                continue  # not on disk → no section (a section needs the file for compute_fit)
            try:
                ov = _switches_to_overrides(self._switches_fn(m.id) or {})
                meta = self._read_meta(gguf)
                fit = compute_fit(meta, gguf.stat().st_size, hardware, ov, safety_margin_mb=margin)
                entries.append(ModelIniEntry(
                    model_id=m.id, gguf_path=str(gguf), n_gpu_layers=fit.n_gpu_layers,
                    n_cpu_moe=fit.n_cpu_moe, ctx_len=fit.ctx_len, overrides=ov,
                ))
            except Exception:  # noqa: BLE001 — skip one model, keep the rest of the .ini
                log.warning("skipping .ini section for %s (meta/fit failed)", m.id, exc_info=True)
        # An override for a model NOT in the catalog still gets its own section.
        if override is not None and not any(e.model_id == override.model_id for e in entries):
            entries.insert(0, override)
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
        from the DB config). Caller holds `_router_lock` and has emitted the `.ini`."""
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
        id with a router-level OOM back-off. Caller holds `_router_lock`."""
        router_up = self._router is not None and self._router.is_alive()
        _, changed = self._emit_ini(override=entry)
        if not router_up:
            self._spawn_router(server_exe, config)
        elif changed:
            self._bounce_router(server_exe, config)
        self._router_load_with_backoff(entry, fit, server_exe, config)

    def _confirm_load(self, model_id: str) -> str:
        """Poll `GET /models` until the child for `model_id` resolves. POST /models/load is
        ASYNC on b9644 (a 2xx only ACCEPTS; the child loads in the background — box-verified),
        so the 200 is NOT a load confirmation. Returns 'loaded' (status.value loaded|sleeping),
        'failed' (value failed, or the router process itself died), or 'timeout' (still loading
        past the deadline). Caller holds `_router_lock`. `_now`/`_sleep`/`_router_models` are
        injected in tests so this polls deterministically offline."""
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
            if value == "failed":
                return "failed"
            if self._now() >= deadline:
                return "timeout"
            self._sleep(self._load_poll_interval)

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
        while True:
            # POST accepts (2xx) or raises on a synchronous 4xx (bad id / at capacity) — the
            # latter is a real error, not OOM, so it propagates (→ _run_load sets error state).
            self._router_load(self._router.url, entry.model_id)
            outcome = self._confirm_load(entry.model_id)
            if outcome == "loaded":
                return
            # failed / timeout: shed GPU layers ONLY on a genuine CUDA-OOM in the spawn log —
            # never on a non-OOM failure (shedding can't fix it and a bounce disrupts residents).
            tail = _tail_file(self._last_log_path) if self._last_log_path else ""
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
            self._acquire_and_identify(model_id, _progress)  # raises ValueError for unknown model
            self._download_state = _download_idle()  # done; /models reports it on-disk. No spawn.
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
    config_fn=None,
    hardware_fn=None,
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
    if config_fn is not None:
        kwargs["config_fn"] = config_fn
    if hardware_fn is not None:
        kwargs["hardware_fn"] = hardware_fn
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
