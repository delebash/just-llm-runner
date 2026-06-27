# SPDX-License-Identifier: GPL-3.0-or-later
"""P1.4 — spawn `llama-server` with a VRAM-fit flag set + probe-and-back-off.

Three pieces:
  * `compute_fit` — pure heuristic: how many layers fit on the GPU, and (for
    MoE) how many expert layers to offload to CPU RAM (`--n-cpu-moe`).
  * `compose_flags` — build the llama-server argv from the manifest presets
    + the fit + the model path.
  * `start_runner` / `Runner` — spawn the process, wait for `/health`, and on
    a CUDA-OOM exit shed GPU layers and retry. The back-off is the real
    safety net, so `compute_fit` only needs to be a reasonable first guess.

Self-contained (own hardware/gguf/manifest types; `requests` for the health
probe) so it runs in JustWrite's sidecar with no app coupling.
"""

from __future__ import annotations

import logging
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Sequence

import requests

from . import fit
from .gguf import GgufMeta
from .schema import HardwareInfo, ModelEntry, RunnerManifest

log = logging.getLogger(__name__)

DEFAULT_CTX = 4096
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8080
_BACKOFF_STEP = 4  # GPU layers shed per OOM retry


class RunnerStartError(RuntimeError):
    """llama-server never became healthy (and it wasn't a recoverable OOM)."""


@dataclass
class Overrides:
    """Operator overrides for tuning/testing a model load — any None falls back to
    the computed Fit or the manifest's `base` flag preset. Two groups:
      * fit knobs (n_gpu_layers / n_cpu_moe / ctx_len) — consumed by compute_fit;
      * engine flags — REPLACE the matching base-preset flag in compose_flags (NOT
        appended, so llama-server never sees a duplicated flag with two values).

    WHY this surface exists: POST /v1/llm-runner/load must let the GUI test the
    speed/fit switches on the user's OWN machine (esp. --n-cpu-moe to fit a MoE on
    a small card, and the KV/threads/batch knobs to find the fast split) — the
    engine had the knobs but nothing could set them. Full rationale + per-flag
    when/why: docs/plans/2026-06-24-llamacpp-switches.md (Plane 1).
    WHAT WOULD CHANGE THIS: if llama-server grows a typed config endpoint, these
    map 1:1 to it; until then we compose the CLI argv."""

    # Fit knobs (compute_fit).
    n_gpu_layers: int | None = None
    n_cpu_moe: int | None = None
    ctx_len: int | None = None
    # Engine flags (compose_flags; None = keep the base preset / llama default).
    cache_type_k: str | None = None      # f16 | q8_0 | turbo3/turbo4 (fork only)
    cache_type_v: str | None = None
    flash_attn: str | None = None        # "on" | "off" | "auto"
    no_mmap: bool | None = None          # True → read weights into RAM (MoE offload)
    mlock: bool | None = None            # base sets it; False removes it
    no_kv_offload: bool | None = None    # True → keep KV in system RAM, free VRAM
    batch_size: int | None = None
    ubatch_size: int | None = None
    threads: int | None = None           # CPU gen threads (drive MoE CPU experts)
    threads_batch: int | None = None
    parallel: int | None = None          # server slots (batch sweeps / Compare)
    cont_batching: bool | None = None    # False → emits --no-cont-batching
    cache_reuse: int | None = None       # reuse a prompt prefix's KV across calls
    spec_type: str | None = None         # "none"|"draft-mtp"|"ngram-mod"|… (dense)
    spec_n_max: int | None = None        # drafted tokens / ngram max, per spec_type
    extra_flags: list[str] = field(default_factory=list)


@dataclass
class FitPlan:
    n_gpu_layers: int
    n_cpu_moe: int
    ctx_len: int
    block_count: int  # carried so back-off can recompute n_cpu_moe as layers shed
    is_moe: bool


def _max_vram_mb(hw: HardwareInfo) -> int:
    return max((g.vram_mb or 0 for g in hw.gpus), default=0)


def _flag_value(flags: Sequence[str], name: str) -> str | None:
    for i, f in enumerate(flags):
        if f == name and i + 1 < len(flags):
            return flags[i + 1]
    return None


def _strip_flag(flags: Sequence[str], name: str) -> list[str]:
    """Drop `name` and its single following value from a flag list."""
    out: list[str] = []
    skip = False
    for f in flags:
        if skip:
            skip = False
            continue
        if f == name:
            skip = True
            continue
        out.append(f)
    return out


def _set_flag(flags: list[str], name: str, value: object) -> list[str]:
    """Set a VALUE flag (e.g. --cache-type-k q8_0): drop any existing instance, then
    append name + value. REPLACE semantics so an override beats the base preset
    instead of duplicating the flag (llama-server would otherwise carry two)."""
    return _strip_flag(list(flags), name) + [name, str(value)]


def _set_presence(flags: list[str], name: str, present: bool) -> list[str]:
    """Set a PRESENCE flag (no value — e.g. --mlock / --no-mmap): ensure it appears
    exactly once when present, removed when not. (Can't use _strip_flag here — it
    eats the FOLLOWING token, which for a valueless flag is the next flag.)"""
    out = [f for f in flags if f != name]
    if present:
        out.append(name)
    return out


# Overrides field → its llama-server VALUE flag (presence + spec handled separately).
_VALUE_FLAGS = (
    ("cache_type_k", "--cache-type-k"),
    ("cache_type_v", "--cache-type-v"),
    ("flash_attn", "--flash-attn"),
    ("batch_size", "--batch-size"),
    ("ubatch_size", "--ubatch-size"),
    ("threads", "--threads"),
    ("threads_batch", "--threads-batch"),
    ("parallel", "--parallel"),
    ("cache_reuse", "--cache-reuse"),
)


def _apply_engine_overrides(flags: list[str], ov: Overrides) -> list[str]:
    """Layer an operator's engine overrides onto the preset flags (None = leave the
    preset alone). Value flags replace; presence flags add/remove; spec flags are
    handled together so spec_type='none' fully clears them (incl. the mtp preset)."""
    out = list(flags)
    for attr, flag in _VALUE_FLAGS:
        val = getattr(ov, attr)
        if val is not None:
            out = _set_flag(out, flag, val)
    if ov.mlock is not None:
        out = _set_presence(out, "--mlock", ov.mlock)
    if ov.no_mmap is not None:
        out = _set_presence(out, "--no-mmap", ov.no_mmap)
    if ov.no_kv_offload is not None:
        out = _set_presence(out, "--no-kv-offload", ov.no_kv_offload)
    if ov.cont_batching is not None:
        # Continuous batching is ON upstream by default — only the OFF switch exists.
        out = _set_presence(out, "--no-cont-batching", not ov.cont_batching)
    if ov.spec_type is not None:
        for f in ("--spec-type", "--spec-draft-n-max", "--spec-ngram-mod-n-max"):
            out = _strip_flag(out, f)
        if ov.spec_type != "none":
            out += ["--spec-type", ov.spec_type]
            if ov.spec_n_max is not None:
                nmax = "--spec-ngram-mod-n-max" if "ngram" in ov.spec_type else "--spec-draft-n-max"
                out += [nmax, str(ov.spec_n_max)]
    # Raw passthrough flags (the "new llama.cpp flag, no code" escape) — appended
    # verbatim so a switch the typed Overrides set doesn't know still reaches the
    # server. _switches_to_overrides routes any non-field switch row here.
    if ov.extra_flags:
        out += list(ov.extra_flags)
    return out


def compute_fit(
    manifest: RunnerManifest,
    meta: GgufMeta,
    total_weight_bytes: int,
    hardware: HardwareInfo,
    overrides: Overrides | None = None,
) -> FitPlan:
    """Decide how much of the model fits on the GPU.

    Reserve a safety margin + KV-cache VRAM, then divide the remaining budget
    by the average per-layer weight bytes. MoE expert layers that don't fit
    are offloaded to CPU RAM. Probe-and-back-off at spawn corrects any
    overestimate, so this only needs to be a sane first guess.
    """
    ov = overrides or Overrides()
    ctx_len = ov.ctx_len or DEFAULT_CTX
    n_layers = max(1, meta.block_count)

    if ov.n_gpu_layers is not None:
        n_gpu = max(0, min(n_layers, ov.n_gpu_layers))
    else:
        vram_mb = _max_vram_mb(hardware)
        budget_mb = max(0, vram_mb - manifest.vram_fit.safety_margin_mb)
        cache_type = fit.cache_type_bits(_flag_value(manifest.flag_presets.base, "--cache-type-k"))
        # head_count_kv is absent in some GGUF headers — fall back to MHA
        # (≈ hidden_dim / 128, a typical head_dim) so KV isn't under-counted.
        n_kv_heads = meta.n_kv_heads or max(1, meta.embedding_length // 128)
        # oobabooga's fitted GGUF VRAM formula → the most GPU layers that fit.
        n_gpu = fit.max_gpu_layers(
            size_mb=total_weight_bytes / 1e6,
            n_layers=n_layers,
            n_kv_heads=n_kv_heads,
            embedding_dim=meta.embedding_length,
            ctx_size=ctx_len,
            cache_type=cache_type,
            vram_budget_mb=budget_mb,
        )

    if ov.n_cpu_moe is not None:
        n_cpu_moe = max(0, ov.n_cpu_moe)
    else:
        n_cpu_moe = max(0, n_layers - n_gpu) if meta.is_moe else 0

    return FitPlan(
        n_gpu_layers=n_gpu, n_cpu_moe=n_cpu_moe, ctx_len=ctx_len,
        block_count=n_layers, is_moe=meta.is_moe,
    )


def compose_flags(
    manifest: RunnerManifest,
    model: ModelEntry,
    gguf_path: Path | str,
    n_gpu_layers: int,
    n_cpu_moe: int,
    ctx_len: int,
    host: str = DEFAULT_HOST,
    port: int = DEFAULT_PORT,
    extra: Sequence[str] = (),
    overrides: Overrides | None = None,
) -> list[str]:
    """Build the llama-server argv (after the exe) from the manifest presets, with
    any operator engine overrides replacing the matching preset flags."""
    # Start from base, but drop its placeholder -ngl 999 — we set ours below.
    flags = _strip_flag(_strip_flag(list(manifest.flag_presets.base), "-ngl"), "--n-gpu-layers")
    if model.mtp:
        flags += list(manifest.flag_presets.mtp)
    if overrides is not None:
        flags = _apply_engine_overrides(flags, overrides)
    flags += ["-ngl", str(n_gpu_layers)]
    if n_cpu_moe > 0:
        flags += ["--n-cpu-moe", str(n_cpu_moe)]
    flags += ["-m", str(gguf_path), "--ctx-size", str(ctx_len), "--host", host, "--port", str(port)]
    flags += list(extra)
    return flags


def _looks_like_oom(text: str) -> bool:
    t = (text or "").lower()
    return any(s in t for s in (
        "out of memory", "cudamalloc", "cuda error", "failed to allocate", "oom",
    ))


def _default_health(url: str) -> bool:
    try:
        return requests.get(url + "/health", timeout=2).status_code == 200
    except Exception:  # noqa: BLE001 — any failure means not-yet-healthy
        return False


def _drain(proc) -> str:
    try:
        out, _ = proc.communicate(timeout=2)
        return out or ""
    except Exception:  # noqa: BLE001 — still running / no pipe
        return ""


def _kill(proc) -> None:
    for fn in ("kill", "wait"):
        try:
            getattr(proc, fn)()
        except Exception:  # noqa: BLE001
            pass


@dataclass
class Runner:
    """A live llama-server process (OpenAI-compatible at `url`)."""

    process: object
    url: str
    n_gpu_layers: int
    n_cpu_moe: int

    def is_alive(self) -> bool:
        return self.process.poll() is None

    def health(self) -> bool:
        return _default_health(self.url)

    def stop(self) -> None:
        try:
            self.process.terminate()
        except Exception:  # noqa: BLE001
            pass


def _wait_until_healthy(proc, url, timeout, health, sleep, now) -> bool:
    deadline = now() + timeout
    while now() < deadline:
        if proc.poll() is not None:
            return False  # exited before it ever became healthy
        if health(url):
            return True
        sleep(0.5)
    return False


def start_runner(
    server_exe: Path | str,
    gguf_path: Path | str,
    manifest: RunnerManifest,
    model: ModelEntry,
    fit: FitPlan,
    *,
    host: str = DEFAULT_HOST,
    port: int = DEFAULT_PORT,
    extra_flags: Sequence[str] = (),
    overrides: Overrides | None = None,
    probe_timeout: float = 30.0,
    backoff_step: int = _BACKOFF_STEP,
    _popen: Callable | None = None,
    _health: Callable[[str], bool] | None = None,
    _sleep: Callable[[float], None] = time.sleep,
    _now: Callable[[], float] = time.monotonic,
) -> Runner:
    """Spawn llama-server, wait for `/health`, shed GPU layers on CUDA-OOM.

    Returns a live `Runner`. Raises `RunnerStartError` if it can't become
    healthy for a non-OOM reason (or after backing off to 0 GPU layers).
    `_popen`/`_health`/`_sleep`/`_now` are injection points for tests.
    """
    popen = _popen or subprocess.Popen
    health = _health or _default_health
    url = f"http://{host}:{port}"
    n_gpu = fit.n_gpu_layers

    while True:
        n_cpu_moe = max(0, fit.block_count - n_gpu) if fit.is_moe else 0
        flags = compose_flags(
            manifest, model, gguf_path, n_gpu, n_cpu_moe, fit.ctx_len, host, port, extra_flags,
            overrides=overrides,
        )
        log.info("spawning llama-server: ngl=%d n_cpu_moe=%d ctx=%d", n_gpu, n_cpu_moe, fit.ctx_len)
        proc = popen(
            [str(server_exe), *flags],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        if _wait_until_healthy(proc, url, probe_timeout, health, _sleep, _now):
            return Runner(process=proc, url=url, n_gpu_layers=n_gpu, n_cpu_moe=n_cpu_moe)

        output = _drain(proc)
        _kill(proc)
        if n_gpu > 0 and _looks_like_oom(output):
            n_gpu = max(0, n_gpu - backoff_step)
            log.warning("llama-server OOM — backing off to ngl=%d", n_gpu)
            continue
        raise RunnerStartError(
            f"llama-server failed to become healthy (ngl={n_gpu}): {output[:300]}"
        )
