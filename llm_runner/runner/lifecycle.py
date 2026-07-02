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

from .binary import acquire_binary as _acquire_binary
from .binary import acquired_server_exe, binary_dir, select_binary
from .config import default_config as _default_config
from .gguf import read_gguf_metadata as _read_gguf_metadata
from .hardware import detect as _detect
from .models import acquire_model as _acquire_model
from .process import Overrides, _tail_file, compute_fit, start_runner as _start_runner
from .schema import ModelEntry


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
    """Standalone default: no host store wired → no Profile (job) switches."""
    return {}


def _default_measure_probe(url: str, prompt: str, max_tokens: int) -> tuple[int, float]:
    """POST a fixed prompt to the running llama-server → (completion_tokens,
    decode_ms). A real network call to the live model — injected in tests."""
    t0 = time.monotonic()
    resp = requests.post(
        url.rstrip("/") + "/v1/chat/completions",
        json={"messages": [{"role": "user", "content": prompt}], "max_tokens": max_tokens, "stream": False},
        timeout=120,
    )
    ms = (time.monotonic() - t0) * 1000
    resp.raise_for_status()
    usage = (resp.json() or {}).get("usage") or {}
    return int(usage.get("completion_tokens") or 0), ms


def _default_measure_sample() -> dict:
    """The box's resource context (TOTALS, from hardware detect). Per-process USED
    VRAM/RAM is a GPU-box refinement — inject a richer sampler there."""
    hw = _detect()
    return {
        "vramTotalMb": max((g.vram_mb or 0 for g in hw.gpus), default=0),
        "ramTotalMb": hw.ram_mb,
    }


def _default_tokenize_probe(url: str, text: str) -> int:
    """EXACT token count for `text` via the running llama-server's /tokenize
    (b1/E2) — the loaded model's own tokenizer, so no client-side reimplementation.
    A real network call; injected in tests."""
    resp = requests.post(url.rstrip("/") + "/tokenize", json={"content": text}, timeout=30)
    resp.raise_for_status()
    return len((resp.json() or {}).get("tokens") or [])


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


class RunnerService:
    """Owns the single live llama-server + its load state.

    status ∈ idle | downloading | starting | running | error.
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
        start=_start_runner,
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
        self._start = start
        self._state = _idle()
        self._engine_state = _engine_idle()
        self._runner = None
        self._lock = threading.Lock()
        self._thread = None
        self._engine_thread = None
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
        # Reflect a llama-server that died after it came up.
        if self._runner is not None and self._state["status"] == "running" and not self._runner.is_alive():
            self._state.update(status="error", error="llama-server exited")
        return dict(self._state)

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
        with self._lock:
            if self._state["status"] in ("downloading", "starting"):
                return dict(self._state)  # a load is already in flight
            self._state = {"status": "downloading", "modelId": model_id, "url": "", "detail": "queued",
                           "error": "", "downloaded": 0, "total": 0}
            self._thread = threading.Thread(
                target=self._run_load, args=(model_id, overrides or Overrides(), job_id, switches), daemon=True,
            )
            self._thread.start()
        return dict(self._state)

    def stop(self) -> dict:
        with self._lock:
            if self._runner is not None:
                try:
                    self._runner.stop()
                except Exception:  # noqa: BLE001 — best-effort
                    pass
                self._runner = None
            self._state = _idle()
        return dict(self._state)

    def measure(
        self, *, prompt: str = "Write one vivid paragraph about the sea.",
        max_tokens: int = 128, probe=None, sample=None,
    ) -> dict:
        """Probe the RUNNING model with a fixed prompt → decode tok/s + the box's
        resource context (#20 "Tune & measure"). Requires a model running. The real
        tok/s is GPU-gated, but the endpoint shape + timing math are not — `probe`
        / `sample` are injected in tests."""
        runner = self._runner
        if runner is None or self._state.get("status") != "running":
            return {"ok": False, "error": "no model running — load one first"}
        probe = probe or _default_measure_probe
        sample = sample or _default_measure_sample
        try:
            ct, ms = probe(runner.url, prompt, max_tokens)
        except Exception as exc:  # noqa: BLE001 — surface the probe error, don't crash
            return {"ok": False, "error": str(exc)}
        tps = round(ct / (ms / 1000), 1) if ms > 0 and ct else 0.0
        return {
            "ok": True, "modelId": self._state.get("modelId", ""),
            "tokensPerSec": tps, "completionTokens": ct, "ms": round(ms, 1), **sample(),
        }

    def tokenize(self, *, text: str, probe=None) -> dict:
        """Exact token count for `text` via the RUNNING model's own tokenizer
        (b1/E2 — the prompt-preview's exact-when-local count). Requires a model
        running; callers fall back to a client-side heuristic otherwise. `probe`
        injected in tests."""
        runner = self._runner
        if runner is None or self._state.get("status") != "running":
            return {"ok": False, "error": "no model running"}
        probe = probe or _default_tokenize_probe
        try:
            count = probe(runner.url, text)
        except Exception as exc:  # noqa: BLE001 — surface the probe error, don't crash
            return {"ok": False, "error": str(exc)}
        return {"ok": True, "count": int(count)}

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

    def _run_load(
        self, model_id: str, overrides: Overrides | None = None,
        job_id: str | None = None, switches: dict[str, str] | None = None,
    ) -> None:
        try:
            config = self._config_fn()
            hardware = self._hardware_fn()
            # The downloadable catalog is HOST-OWNED (DB-backed via .catalog()).
            model = next((m for m in self.catalog() if m.id == model_id), None)
            if model is None:
                raise ValueError(f"unknown model {model_id!r}")

            # Switch base, UNDER user-supplied overrides (user wins per-field).
            # A Profile (job) context wins wholesale: its frozen-flat
            # job_route_switches (pre-filled from the model's type-default, then
            # tuned) REPLACE the model-level pre-fill. Empty/no job → the model
            # base/moe/mtp presets (resolve_model_switches).
            base_switches = self._profile_switches_fn(job_id) if job_id else {}
            if not base_switches:
                base_switches = self._switches_fn(model_id) or {}
            base_ov = _switches_to_overrides(base_switches)
            ov = _merge_overrides(base_ov, overrides)
            # Ad-hoc #20 "Tune & measure" switches win last (over named-field
            # overrides AND the model/profile base) — the same converter, so an
            # unknown key still routes to extra_flags.
            if switches:
                ov = _merge_overrides(ov, _switches_to_overrides(switches))

            def _progress(downloaded: int, total: int | None) -> None:
                # Live byte counters the GUI polls via status() to draw a bar.
                self._state["downloaded"] = downloaded
                self._state["total"] = total or 0

            # Engine install is its OWN step now (POST /engine/install); a model
            # load REQUIRES it already present and never silently downloads it.
            server_exe = self._acquired_exe(self._cache_root, config, hardware)
            if server_exe is None:
                self._state.update(status="error", detail="Install the engine first",
                                   error="engine-not-installed", downloaded=0, total=0)
                return

            self._state.update(detail="model weights", downloaded=0, total=0)
            snapshot = self._acquire_model(
                model.hf_repo, model.quant, model.mmproj, cache_root=self._cache_root / "hf",
                on_progress=_progress,
            )
            gguf = self._main_gguf(snapshot, model.quant)
            meta = self._read_meta(gguf)
            # Best-effort: auto-detect the catalog `type` (moe|dense) from the
            # downloaded GGUF so a user-added model's switch presets are grounded
            # in the file, not a hand-typed guess. Never fail the load on this.
            try:
                self._identify_fn(model_id, gguf)
            except Exception:  # noqa: BLE001 — identification is advisory only
                log.warning("model type auto-detect failed for %s", model_id, exc_info=True)
            fit = compute_fit(meta, gguf.stat().st_size, hardware, ov,
                              safety_margin_mb=config.safety_margin_mb)

            self._state.update(status="starting", detail="spawning llama-server", downloaded=0, total=0)
            log_path = self._runner_log_path(model_id)
            self._last_log_path = log_path
            runner = self._start(server_exe, gguf, fit, extra_flags=ov.extra_flags,
                                 overrides=ov, log_path=log_path)
            self._runner = runner
            self._state.update(status="running", url=runner.url, detail="", downloaded=0, total=0)
        except Exception as exc:  # noqa: BLE001 — any failure becomes error state
            log.exception("runner load failed")
            self._state.update(status="error", detail="", error=str(exc), downloaded=0, total=0)


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
