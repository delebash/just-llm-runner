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
import re
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Sequence

import requests

from . import fit
from .config import DEFAULT_SAFETY_MARGIN_MB
from .gguf import GgufMeta
from .hardware import max_vram_mb
from .schema import HardwareInfo

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
    the computed Fit or the llama default. Two groups:
      * fit knobs (n_gpu_layers / n_cpu_moe / ctx_len) — consumed by compute_fit;
      * engine flags — rendered into the argv by compose_flags. The base + type
        (moe|dense) preset defaults arrive HERE already (resolved from the DB
        `switch_presets` via the runner's switches_fn), so compose_flags renders
        purely from these.

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
    context_shift: bool | None = None    # True → --context-shift (snappy edits); False → --no-context-shift
    cache_reuse: int | None = None       # reuse a prompt prefix's KV across calls
    spec_type: str | None = None         # "none"|"draft-mtp"|"ngram-mod"|… (dense)
    spec_n_max: int | None = None        # drafted tokens / ngram max, per spec_type
    # Separate draft-model GGUF path (--model-draft, alias of --spec-draft-model) for
    # Gemma-style external-MTP models. Normally filled by LIFECYCLE from the catalog's
    # mtp_draft_* facts after acquiring the draft file — not hand-typed (a raw switch
    # row CAN set it; power-user escape). Verified against llama.cpp b9644.
    model_draft: str | None = None
    # Thinking budget (--reasoning-budget): -1 unlimited (llama default) | 0 = no
    # thinking | N>0 caps the thinking tokens, then --reasoning-budget-message is
    # injected before the end-of-thinking tag. Verified against llama.cpp b9644.
    reasoning_budget: int | None = None
    reasoning_budget_message: str | None = None
    extra_flags: list[str] = field(default_factory=list)


@dataclass
class FitPlan:
    n_gpu_layers: int
    n_cpu_moe: int
    ctx_len: int
    block_count: int  # carried so back-off can recompute n_cpu_moe as layers shed
    is_moe: bool
    vram_mb: int = 0  # estimated GPU-RESIDENT VRAM for n_gpu_layers (the VRAM arbiter reserves this, P2)


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
    ("model_draft", "--model-draft"),
    ("reasoning_budget", "--reasoning-budget"),
    # Free text with spaces is fine in BOTH renderers: argv passes it as one list
    # token; the router .ini parser takes everything after "= " to end-of-line
    # UNQUOTED (llama.cpp b9644 common/preset.cpp — quotes would be literal).
    # Edge: a "#" inside the value starts an .ini comment — avoid it in messages.
    ("reasoning_budget_message", "--reasoning-budget-message"),
)


# Keys that use a SHORT argv form (`-ngl` for n-gpu-layers); everything else is `--{key}`.
_ARGV_SHORT = {"n-gpu-layers": "-ngl"}


def overrides_to_pairs(
    ov: Overrides, *, n_gpu_layers: int, n_cpu_moe: int, ctx_len: int
) -> list[tuple[str, str | None]]:
    """The ONE normalized (flag, value) list for a model's launch config — the single
    source BOTH renderers consume, so the spawn argv (`render_argv`) and the router
    `.ini` section (`render_ini`) can never drift (the "a copy drifts" rule). `value`
    is a string for a value flag, or `None` for a presence flag (a bare `--flag` in
    argv; `key = true` in the ini). Keys are canonical, WITHOUT leading dashes.

    Covers the fit knobs (n-gpu-layers / n-cpu-moe / ctx) + the engine `Overrides`:
    value flags (`_VALUE_FLAGS`), presence flags (mlock / no-mmap / no-kv-offload, with
    the cont-batching + context-shift INVERSIONS preserved), and the spec-decode branch.
    `extra_flags` is NOT here — it is a raw passthrough the caller renders verbatim
    (argv) or parses (ini). The merged `Overrides` already resolved the base preset, so
    there is nothing to strip; the list is built fresh.
    """
    pairs: list[tuple[str, str | None]] = [("n-gpu-layers", str(n_gpu_layers))]
    if n_cpu_moe > 0:
        pairs.append(("n-cpu-moe", str(n_cpu_moe)))
    pairs.append(("ctx-size", str(ctx_len)))
    for attr, flag in _VALUE_FLAGS:
        val = getattr(ov, attr)
        if val is not None:
            pairs.append((flag.lstrip("-"), str(val)))
    if ov.mlock:
        pairs.append(("mlock", None))
    if ov.no_mmap:
        pairs.append(("no-mmap", None))
    if ov.no_kv_offload:
        pairs.append(("no-kv-offload", None))
    if ov.cont_batching is False:
        # Continuous batching is ON upstream by default — only the OFF switch exists.
        pairs.append(("no-cont-batching", None))
    if ov.context_shift is not None:
        # Context shift is OFF upstream by default — emit the explicit flag either way.
        pairs.append(("context-shift" if ov.context_shift else "no-context-shift", None))
    if ov.spec_type is not None and ov.spec_type != "none":
        pairs.append(("spec-type", ov.spec_type))
        if ov.spec_n_max is not None:
            key = "spec-ngram-mod-n-max" if "ngram" in ov.spec_type else "spec-draft-n-max"
            pairs.append((key, str(ov.spec_n_max)))
    return pairs


def render_argv(pairs: list[tuple[str, str | None]]) -> list[str]:
    """Render normalized pairs as llama-server CLI argv tokens (`--flag value` /
    `--flag` presence / the short `-ngl`)."""
    out: list[str] = []
    for key, val in pairs:
        out.append(_ARGV_SHORT.get(key, f"--{key}"))
        if val is not None:
            out.append(str(val))
    return out


def render_ini(pairs: list[tuple[str, str | None]]) -> str:
    """Render normalized pairs as router `.ini` preset lines (`key = value` /
    `key = true`; the dashless canonical keys llama.cpp's preset parser accepts)."""
    return "\n".join(f"{key} = {'true' if val is None else val}" for key, val in pairs)


def _extra_flags_to_ini_pairs(tokens: Sequence[str]) -> list[tuple[str, str | None]]:
    """Parse raw passthrough argv tokens (e.g. ['--top-n-sigma', '0.05', '--some-flag'])
    into (key, value|None) `.ini` pairs. Rule: a flag key starts with '-' and is not a
    number; the NEXT token is that flag's value unless it too is a flag (then the flag is
    a bare toggle → value None). Numeric values, incl. negatives like '-0.5', are
    consumed as values, not mistaken for flags."""
    def _is_flag(tok: str) -> bool:
        return tok.startswith("-") and re.match(r"-?\d", tok) is None

    toks = list(tokens or [])
    pairs: list[tuple[str, str | None]] = []
    i = 0
    while i < len(toks):
        key = toks[i].lstrip("-")
        if i + 1 < len(toks) and not _is_flag(toks[i + 1]):
            pairs.append((key, toks[i + 1]))
            i += 2
        else:
            pairs.append((key, None))
            i += 1
    return pairs


@dataclass
class ModelIniEntry:
    """One resident model's resolved launch config for the router `--models-preset`
    `.ini`. `model_id` is the section name = the id clients request. The fit knobs +
    `overrides` render to per-model `.ini` lines via the SAME `overrides_to_pairs` the
    spawn argv uses (no drift). An embed entry sets `embeddings` (+ `pooling`); the
    arbiter pins a model with `load_on_startup`."""

    model_id: str
    gguf_path: str
    n_gpu_layers: int
    n_cpu_moe: int
    ctx_len: int
    overrides: Overrides = field(default_factory=Overrides)
    embeddings: bool = False
    pooling: str = ""   # "" → no `pooling =` line (llama.cpp reads the GGUF); else mean|cls|last|rank. Set per-model from the catalog (#119).
    load_on_startup: bool = False


def emit_models_ini(entries: Sequence[ModelIniEntry]) -> str:
    """Render the router `--models-preset` `.ini` from resolved per-model entries. The
    DB is the source of truth; this `.ini` is a GENERATED artifact — written from the DB
    when the router (re)starts or the resident set changes, never hand-edited or read
    back. One `[<model_id>]` section per entry; per-model flags come from the shared
    `overrides_to_pairs` (so the `.ini` can't drift from the spawn argv)."""
    blocks: list[str] = []
    for e in entries:
        pairs = overrides_to_pairs(
            e.overrides, n_gpu_layers=e.n_gpu_layers, n_cpu_moe=e.n_cpu_moe, ctx_len=e.ctx_len
        )
        pairs += _extra_flags_to_ini_pairs(e.overrides.extra_flags)
        section = [f"[{e.model_id}]", f"model = {e.gguf_path}", render_ini(pairs)]
        if e.embeddings:
            section.append("embeddings = true")
            if e.pooling:
                section.append(f"pooling = {e.pooling}")
        if e.load_on_startup:
            section.append("load-on-startup = true")
        blocks.append("\n".join(s for s in section if s))
    return ("\n\n".join(blocks) + "\n") if blocks else ""


def compose_router_argv(
    *,
    models_dir: Path | str,
    models_preset: Path | str,
    models_max: int = 2,
    sleep_idle_seconds: int | None = None,
    host: str = DEFAULT_HOST,
    port: int = DEFAULT_PORT,
    extra: Sequence[str] = (),
) -> list[str]:
    """Build the llama-server ROUTER-mode argv (NO `-m`): the router loads models by id
    from the emitted `--models-preset` `.ini`. `--models-max` caps the co-resident count
    (the arbiter works within it); `--sleep-idle-seconds` (when > 0) is the native
    idle-unload TTL. Per-model launch flags live in the `.ini`, not here."""
    argv = [
        "--models-dir", str(models_dir),
        "--models-preset", str(models_preset),
        "--models-max", str(models_max),
        "--host", host, "--port", str(port),
    ]
    if sleep_idle_seconds is not None and sleep_idle_seconds > 0:
        argv += ["--sleep-idle-seconds", str(sleep_idle_seconds)]
    argv += list(extra)
    return argv


def compute_fit(
    meta: GgufMeta,
    total_weight_bytes: int,
    hardware: HardwareInfo,
    overrides: Overrides | None = None,
    *,
    safety_margin_mb: int = DEFAULT_SAFETY_MARGIN_MB,
) -> FitPlan:
    """Decide how much of the model fits on the GPU.

    Reserve a safety margin + KV-cache VRAM, then divide the remaining budget
    by the average per-layer weight bytes. MoE expert layers that don't fit
    are offloaded to CPU RAM. Probe-and-back-off at spawn corrects any
    overestimate, so this only needs to be a sane first guess.

    `safety_margin_mb` comes from the RunnerConfig (DB-backed, host) or its
    default; the KV cache-type is taken from the resolved overrides (the DB
    `base` preset sets q8_0) so it isn't under-counted.
    """
    ov = overrides or Overrides()
    ctx_len = ov.ctx_len or DEFAULT_CTX
    n_layers = max(1, meta.block_count)
    cache_type = fit.cache_type_bits(ov.cache_type_k or "q8_0")
    # head_count_kv is absent in some GGUF headers — fall back to MHA
    # (≈ hidden_dim / 128, a typical head_dim) so KV isn't under-counted.
    n_kv_heads = meta.n_kv_heads or max(1, meta.embedding_length // 128)

    if ov.n_gpu_layers is not None:
        n_gpu = max(0, min(n_layers, ov.n_gpu_layers))
    else:
        total_vram_mb = max_vram_mb(hardware)
        budget_mb = max(0, total_vram_mb - safety_margin_mb)
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

    # GPU-resident VRAM for the chosen split — the SAME fitted formula run forward (cost of n_gpu)
    # rather than inverse (max layers for a budget). The VRAM arbiter reserves this (P2). A
    # fully-CPU load (n_gpu == 0) touches no GPU (no CUDA context), so it reserves 0 — NOT the
    # formula's ~1.5 GB base offset, which represents an in-use GPU.
    vram_mb = int(fit.estimate_vram_mb(
        size_mb=total_weight_bytes / 1e6, n_layers=n_layers, n_kv_heads=n_kv_heads,
        embedding_dim=meta.embedding_length, ctx_size=ctx_len, cache_type=cache_type, gpu_layers=n_gpu,
    )) if n_gpu > 0 else 0

    return FitPlan(
        n_gpu_layers=n_gpu, n_cpu_moe=n_cpu_moe, ctx_len=ctx_len,
        block_count=n_layers, is_moe=meta.is_moe, vram_mb=vram_mb,
    )


def compose_flags(
    gguf_path: Path | str,
    n_gpu_layers: int,
    n_cpu_moe: int,
    ctx_len: int,
    host: str = DEFAULT_HOST,
    port: int = DEFAULT_PORT,
    extra: Sequence[str] = (),
    overrides: Overrides | None = None,
) -> list[str]:
    """Build the llama-server argv (after the exe) from the resolved engine overrides.
    The base + type (moe|dense) flag defaults (flash-attn, KV cache type, mlock,
    spec-decode, …) arrive in `overrides` already — resolved from the DB `switch_presets`
    by the runner's switches_fn — so there is no manifest preset to merge here. We render
    the overrides + fit knobs via the shared `overrides_to_pairs`→`render_argv`, the SAME
    normalized pairs the router `.ini` emitter renders (via `render_ini`), so the spawn
    argv and the `.ini` section can never drift."""
    ov = overrides or Overrides()
    flags = render_argv(overrides_to_pairs(ov, n_gpu_layers=n_gpu_layers, n_cpu_moe=n_cpu_moe, ctx_len=ctx_len))
    flags += ["-m", str(gguf_path), "--host", host, "--port", str(port)]
    flags += list(ov.extra_flags)  # raw passthrough (the "new flag, no code" escape), verbatim
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


def _tail_file(path, max_lines: int = 40) -> str:
    """Last ~max_lines of the redirected llama-server log (lenient decode)."""
    try:
        text = Path(path).read_bytes().decode("utf-8", errors="replace")
    except Exception:  # noqa: BLE001 — no log yet / unreadable → empty tail
        return ""
    return "\n".join(text.splitlines()[-max_lines:])


def _kill(proc) -> None:
    for fn in ("kill", "wait"):
        try:
            getattr(proc, fn)()
        except Exception:  # noqa: BLE001
            pass


@dataclass
class _ServerHandle:
    """A live llama-server process (OpenAI-compatible at `url`) — the ONE
    process-handle surface (`is_alive`/`health`/`stop`) shared by the single-model
    `Runner` and the multi-model `RouterHandle` (so the aliveness/health/terminate
    logic has a single source)."""

    process: object
    url: str

    def is_alive(self) -> bool:
        return self.process.poll() is None

    def health(self) -> bool:
        return _default_health(self.url)

    def stop(self) -> None:
        try:
            self.process.terminate()
        except Exception:  # noqa: BLE001
            pass


@dataclass
class Runner(_ServerHandle):
    """A single-model `llama-server` spawn — the shared handle surface + the
    resolved GPU split it was launched with."""

    n_gpu_layers: int
    n_cpu_moe: int


@dataclass
class RouterHandle(_ServerHandle):
    """A `llama-server` in ROUTER mode (multi-model; routes by model id). Distinct from
    `Runner` (a single-model spawn): the router owns N child servers, so it carries no
    per-model ngl/offload — those live per section in the emitted `.ini`. It is exactly
    the shared `_ServerHandle` surface, so the service treats router and single-model
    spawns uniformly."""


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
    fit: FitPlan,
    *,
    host: str = DEFAULT_HOST,
    port: int = DEFAULT_PORT,
    extra_flags: Sequence[str] = (),
    overrides: Overrides | None = None,
    log_path: Path | str | None = None,
    probe_timeout: float = 30.0,
    backoff_step: int = _BACKOFF_STEP,
    _popen: Callable | None = None,
    _health: Callable[[str], bool] | None = None,
    _sleep: Callable[[float], None] = time.sleep,
    _now: Callable[[], float] = time.monotonic,
) -> Runner:
    """Spawn llama-server, wait for `/health`, shed GPU layers on CUDA-OOM.

    Returns a live `Runner`. Raises `RunnerStartError` if it can't become
    healthy for a non-OOM reason (or after backing off to 0 GPU layers) — the
    error carries the process exit status (None = still running, killed on the
    health timeout = a hang; a number = it exited on its own, e.g. Windows
    3221225781 / 0xC0000135 = a DLL failed to load) plus the tail of the log.
    When `log_path` is set, llama-server's merged stdout+stderr is redirected
    straight to that file (survives a hang/crash/kill and is tailed on failure);
    otherwise it is captured via a pipe (the legacy path used by the offline
    tests that inject `_popen`). `_popen`/`_health`/`_sleep`/`_now` are injection
    points for tests.
    """
    popen = _popen or subprocess.Popen
    health = _health or _default_health
    url = f"http://{host}:{port}"
    n_gpu = fit.n_gpu_layers
    if log_path:
        Path(log_path).parent.mkdir(parents=True, exist_ok=True)

    # One log handle for the whole load: each (re)spawn dups it, so the sequential
    # OOM-backoff attempts append into the same per-load file; the parent copy is
    # closed in the finally (a healthy child keeps its own dup open + keeps writing).
    logf = open(log_path, "wb") if log_path else None
    try:
        while True:
            n_cpu_moe = max(0, fit.block_count - n_gpu) if fit.is_moe else 0
            flags = compose_flags(
                gguf_path, n_gpu, n_cpu_moe, fit.ctx_len, host, port, extra_flags,
                overrides=overrides,
            )
            log.info("spawning llama-server: ngl=%d n_cpu_moe=%d ctx=%d", n_gpu, n_cpu_moe, fit.ctx_len)
            if logf is not None:
                proc = popen([str(server_exe), *flags], stdout=logf, stderr=subprocess.STDOUT)
            else:
                proc = popen(
                    [str(server_exe), *flags],
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                )
            if _wait_until_healthy(proc, url, probe_timeout, health, _sleep, _now):
                return Runner(process=proc, url=url, n_gpu_layers=n_gpu, n_cpu_moe=n_cpu_moe)

            # Capture WHY before killing: poll() is None for a hang (still alive at
            # the deadline) or the self-exit code if it died on its own.
            rc = proc.poll()
            output = _tail_file(log_path) if log_path else _drain(proc)
            _kill(proc)
            if n_gpu > 0 and _looks_like_oom(output):
                n_gpu = max(0, n_gpu - backoff_step)
                log.warning("llama-server OOM — backing off to ngl=%d", n_gpu)
                continue
            status = "still running, killed on timeout" if rc is None else f"exit {rc}"
            where = f"  [log: {log_path}]" if log_path else ""
            raise RunnerStartError(
                f"llama-server failed to become healthy (ngl={n_gpu}, {status}): "
                f"{output[-1000:]}{where}"
            )
    finally:
        if logf is not None:
            logf.close()


def start_router(
    server_exe: Path | str,
    *,
    models_dir: Path | str,
    models_preset: Path | str,
    models_max: int = 2,
    sleep_idle_seconds: int | None = None,
    host: str = DEFAULT_HOST,
    port: int = DEFAULT_PORT,
    log_path: Path | str | None = None,
    probe_timeout: float = 60.0,
    _popen: Callable | None = None,
    _health: Callable[[str], bool] | None = None,
    _sleep: Callable[[float], None] = time.sleep,
    _now: Callable[[], float] = time.monotonic,
) -> RouterHandle:
    """Spawn llama-server in ROUTER mode (no `-m`; it loads models by id from the
    `--models-preset` `.ini`) and wait for `/health`.

    Unlike `start_runner` there is **NO OOM back-off here** — the router process
    itself loads no weights; each CHILD fits independently from its `.ini` section, so
    a child's CUDA-OOM is recovered at the SERVICE level (re-emit that model's section
    at a lower `ngl` + reload), not by shedding layers on the router. Raises
    `RunnerStartError` if the router never becomes healthy. `_popen`/`_health`/`_sleep`/
    `_now` are test injection points (the router spawn is not runnable in CI)."""
    popen = _popen or subprocess.Popen
    health = _health or _default_health
    url = f"http://{host}:{port}"
    argv = compose_router_argv(
        models_dir=models_dir, models_preset=models_preset, models_max=models_max,
        sleep_idle_seconds=sleep_idle_seconds, host=host, port=port,
    )
    if log_path:
        Path(log_path).parent.mkdir(parents=True, exist_ok=True)
    logf = open(log_path, "wb") if log_path else None
    try:
        log.info("spawning llama-server router: models_max=%d sleep_idle=%s", models_max, sleep_idle_seconds)
        if logf is not None:
            proc = popen([str(server_exe), *argv], stdout=logf, stderr=subprocess.STDOUT)
        else:
            proc = popen(
                [str(server_exe), *argv],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            )
        if _wait_until_healthy(proc, url, probe_timeout, health, _sleep, _now):
            return RouterHandle(process=proc, url=url)
        rc = proc.poll()
        output = _tail_file(log_path) if log_path else _drain(proc)
        _kill(proc)
        status = "still running, killed on timeout" if rc is None else f"exit {rc}"
        where = f"  [log: {log_path}]" if log_path else ""
        raise RunnerStartError(
            f"llama-server router failed to become healthy ({status}): {output[-1000:]}{where}"
        )
    finally:
        if logf is not None:
            logf.close()
