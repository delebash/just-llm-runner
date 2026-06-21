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
import threading
from pathlib import Path

from .binary import acquire_binary as _acquire_binary
from .gguf import read_gguf_metadata as _read_gguf_metadata
from .hardware import detect as _detect
from .manifest import load_manifest as _load_manifest
from .models import acquire_model as _acquire_model
from .process import Overrides, compute_fit, start_runner as _start_runner

log = logging.getLogger(__name__)


def _idle() -> dict:
    return {"status": "idle", "modelId": "", "url": "", "detail": "", "error": ""}


class RunnerService:
    """Owns the single live llama-server + its load state.

    status ∈ idle | downloading | starting | running | error.
    """

    def __init__(
        self,
        cache_root,
        *,
        manifest_fn=_load_manifest,
        hardware_fn=_detect,
        acquire_binary=_acquire_binary,
        acquire_model=_acquire_model,
        read_meta=_read_gguf_metadata,
        start=_start_runner,
    ):
        self._cache_root = Path(cache_root)
        self._manifest_fn = manifest_fn
        self._hardware_fn = hardware_fn
        self._acquire_binary = acquire_binary
        self._acquire_model = acquire_model
        self._read_meta = read_meta
        self._start = start
        self._state = _idle()
        self._runner = None
        self._lock = threading.Lock()
        self._thread = None

    def status(self) -> dict:
        # Reflect a llama-server that died after it came up.
        if self._runner is not None and self._state["status"] == "running" and not self._runner.is_alive():
            self._state.update(status="error", error="llama-server exited")
        return dict(self._state)

    def load(self, model_id: str) -> dict:
        with self._lock:
            if self._state["status"] in ("downloading", "starting"):
                return dict(self._state)  # a load is already in flight
            self._state = {"status": "downloading", "modelId": model_id, "url": "", "detail": "queued", "error": ""}
            self._thread = threading.Thread(target=self._run_load, args=(model_id,), daemon=True)
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

    # ── internals ─────────────────────────────────────────────────────────

    def _main_gguf(self, snapshot_dir, quant: str) -> Path:
        cands = sorted(
            p for p in Path(snapshot_dir).rglob("*.gguf") if quant.lower() in p.name.lower()
        )
        if not cands:
            raise FileNotFoundError(f"no .gguf for quant {quant!r} in {snapshot_dir}")
        return cands[0]  # first shard of a split model loads the rest

    def _run_load(self, model_id: str) -> None:
        try:
            manifest = self._manifest_fn()
            hardware = self._hardware_fn()
            model = next((m for m in manifest.models if m.id == model_id), None)
            if model is None:
                raise ValueError(f"unknown model {model_id!r}")

            self._state.update(status="downloading", detail="llama.cpp binary")
            server_exe = self._acquire_binary(self._cache_root, manifest, hardware)

            self._state.update(detail="model weights")
            snapshot = self._acquire_model(
                model.hf_repo, model.quant, model.mmproj, cache_root=self._cache_root / "hf",
            )
            gguf = self._main_gguf(snapshot, model.quant)
            meta = self._read_meta(gguf)
            fit = compute_fit(manifest, meta, gguf.stat().st_size, hardware, Overrides())

            self._state.update(status="starting", detail="spawning llama-server")
            runner = self._start(server_exe, gguf, manifest, model, fit)
            self._runner = runner
            self._state.update(status="running", url=runner.url, detail="")
        except Exception as exc:  # noqa: BLE001 — any failure becomes error state
            log.exception("runner load failed")
            self._state.update(status="error", detail="", error=str(exc))


_service: RunnerService | None = None


def get_service() -> RunnerService:
    """Process-wide singleton. Cache root from LLM_RUNNER_CACHE or the user
    cache home (the runner is app-agnostic — it owns its own cache dir)."""
    global _service
    if _service is None:
        root = os.environ.get("LLM_RUNNER_CACHE") or str(Path.home() / ".cache" / "just-llm-runner")
        _service = RunnerService(root)
    return _service
