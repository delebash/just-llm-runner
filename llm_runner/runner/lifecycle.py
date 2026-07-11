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
            **self._engine_state,
        }

    def install_engine(self, force: bool = False, replace_build: str = "") -> dict:
        """Download + unpack the llama.cpp engine for this box (its OWN step, not
        folded into a model load). Idempotent unless `force`. Runs on a dedicated
        thread so it can't clobber an in-flight model load. `replace_build` (user,
        2026-07-07: "the engine update should delete the old folder"): the OLD
        pinned build this install SUPERSEDES — it gets models.ini carry PRIORITY.
        After ANY successful install, every stale build dir is swept (stop-first
        for the Windows exe lock; see _run_install's cleanup block)."""
        with self._lock:
            if self._engine_state["status"] == "installing":
                return dict(self._engine_state)
            self._engine_state = {"status": "installing", "detail": "llama.cpp engine",
                                  "error": "", "downloaded": 0, "total": 0}
            self._engine_thread = threading.Thread(
                target=self._run_install, args=(force, replace_build), daemon=True,
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
        from ..platform.disk_api import dir_size

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

        # The repo(s) this model's files live under: its main repo + a SEPARATE draft repo
        # if the catalog pins one (a same-repo draft rides the main repo dir already).
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
                other.id != model_id
                and (other.hf_repo == repo or (getattr(other, "mtp_draft_repo", "") or "") == repo)
                for other in catalog
            )
            if shared:
                kept.append(repo)
                continue
            freed += dir_size(repo_dir)
            shutil.rmtree(repo_dir, ignore_errors=True)
        result = {"ok": True, "bytes": freed}
        if kept:
            result["detail"] = "kept weights shared with another model: " + ", ".join(sorted(kept))
        return result

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
        state = self.load(embed_id)
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
        # Same trigger ensure_embedding uses: download-if-needed + lazy-spawn the router
        # + reserve, on the background load thread. A re-load of an already-in-flight /
        # running model is idempotent inside load() (and its router-liveness gate
        # respawns a dead router), so this is safe whatever state the model is in.
        self.load(model_id)
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

    def _run_install(self, force: bool, replace_build: str = "") -> None:
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
                                         on_progress=_progress, gpu=gpu)
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
            _model, gguf = self._acquire_and_identify(model_id, _progress)

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
                    **download_kwargs(config),
                )
                draft_path = Path(draft_snapshot) / _model.mtp_draft_file
                if not draft_path.exists():
                    raise FileNotFoundError(
                        f"MTP draft downloaded but not found in the snapshot: {_model.mtp_draft_file!r}"
                    )
                ov.model_draft = str(draft_path)

            meta = self._read_meta(gguf)
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
                self._admit(model_id, fit.vram_mb, config.models_max, hardware)
                self._resident[model_id].update(status="starting", detail="loading into VRAM",
                                                downloaded=0, total=0)
                vram_before = self._probe_used_vram()
                self._load_via_router(entry, fit, server_exe, config)
                # Pin the configured embed so it is NEVER the LRU eviction victim (P3): a chat co-load
                # evicts another chat, never the embed RAG depends on. A chat model reserves unpinned.
                self._arbiter.reserve(model_id, self._trued_up_vram_mb(fit.vram_mb, vram_before),
                                      pinned=model_id in embed_ids)
                self._resident[model_id].update(status="running", url=self._router.url,
                                                detail="", error="", downloaded=0, total=0)
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

    def _trued_up_vram_mb(self, estimate_mb: int, before: int | None) -> int:
        """The VRAM (MiB) to RESERVE for a just-CONFIRMED load: `max(fit estimate,
        measured used-VRAM growth across the load)` — measure-don't-assume (2026-07-06).

        WHY: the fit formula books an `n-gpu-layers = 0` child as 0 MB, but a
        CUDA-build child still holds ~0.5 GB of driver context (box-measured 549 MB);
        booking 0 over-reports the remaining budget for every CPU-offloaded
        co-resident (e.g. the pinned RAG embed), and the fitted estimate for GPU
        loads can drift from reality too. Loads serialize under `_router_lock`, so
        the growth between the two snapshots is attributable to THIS load.

        FLOOR at the estimate, never below: the delta can UNDER-count (an evicted
        victim's child still draining VRAM at the `before` snapshot, or a co-resident
        going to idle-sleep mid-load, both shrink it) and a shrunken measurement must
        not let the ledger book less than the formula's own floor. Unmeasurable
        (None either side) → keep the estimate unchanged."""
        after = self._probe_used_vram()
        if before is None or after is None:
            return estimate_mb
        return max(estimate_mb, after - before)

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
        # Mark the embedding section(s) — the ONE authority for embed-ness in the .ini, applied BY ID
        # in a single post-pass so EVERY emit path gets it (the override slot, a DB-resolved section,
        # AND the not-in-catalog insert above — a per-branch patch would miss one and emit the embed as
        # a plain chat child, so /v1/embeddings would mis-route). A `[<embed>]` section needs
        # `embeddings = true` (+ pooling) for llama-server to expose /v1/embeddings on that child; the
        # section id = the model id clients request (P3). We deliberately do NOT set `load-on-startup`:
        # the embed is loaded EXPLICITLY via ensure_embedding()/load() (which reserves it PINNED). A
        # router-side auto-load would be invisible to `_resident`, so a later ensure would re-POST
        # /models/load for an already-loaded id (→ 400 → error + release, reporting the working embed as
        # failed) or flip the emitted .ini text into a spurious _bounce_router that thrashes the resident
        # chat (~20 s). The "pin" IS the arbiter reservation; load-on-startup adds only that failure mode.
        embed_ids = self._embedding_ids_fn()
        if embed_ids:
            # pooling is INTRINSIC per-model (nomic=mean, qwen3-embedding=last), resolved BY ID from
            # the catalog HERE in this single post-pass — so it reaches EVERY emit path incl. the
            # PRIMARY P3 override-load slot (a per-branch set would miss it). "" → no `pooling =` line
            # → llama.cpp reads the GGUF's pooling_type (#119).
            pooling_by_id = {m.id: (getattr(m, "pooling", "") or "") for m in catalog}
            entries = [
                _dc_replace(e, embeddings=True, pooling=pooling_by_id.get(e.model_id, ""))
                if e.model_id in embed_ids else e
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
            server_exe = self._spawn_router_with_fallback(server_exe, config)
        else:
            server_exe = self._active_server_exe or server_exe
            if changed:
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
