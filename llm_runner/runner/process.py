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
import sys
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
    # The three values stay CONCRETE ints — the arbiter (vram_mb), preview_fit, and the
    # OOM back-off all read them as numbers even when the launch omits the flags (1b-F2).
    n_gpu_layers: int
    n_cpu_moe: int
    ctx_len: int
    block_count: int  # carried so back-off can recompute n_cpu_moe as layers shed
    is_moe: bool
    vram_mb: int = 0  # estimated GPU-RESIDENT VRAM for n_gpu_layers (the VRAM arbiter reserves this, P2)
    # WHICH knobs were user/tune-EXPLICIT (from Overrides) vs computed here. The emission
    # layer omits non-explicit ngl/ncmoe so the engine's own `--fit` (default-on at the
    # b9870 pin) places tensors; ctx is ALWAYS emitted — ctx policy is ours (1b design).
    ngl_explicit: bool = False
    ncmoe_explicit: bool = False
    ctx_explicit: bool = False


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
    # reasoning_budget + reasoning_budget_message launch flags RETIRED (U2-T4, 2026-07-14,
    # decision 1a): the engine launches at its default (-1 = unlimited) and EVERY request
    # carries the resolved per-request `reasoning_budget_tokens` from the ONE resolver
    # (llm/reasoning.py). The pre-b9982 "request key honored only when launch == -1" gate is
    # satisfied by construction; post-b9982 the request value wins anyway. The
    # `reasoning_budget` VALUE lives on as DATA — the class-tune cap the resolver reads — it
    # is simply no longer a launch flag. (The raw runner-API load fields stay untouched.)
)


# Keys that use a SHORT argv form (`-ngl` for n-gpu-layers); everything else is `--{key}`.
_ARGV_SHORT = {"n-gpu-layers": "-ngl"}


def overrides_to_pairs(
    ov: Overrides, *, n_gpu_layers: int | None, n_cpu_moe: int | None, ctx_len: int
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
    # 1b fit-by-omission: a None fit knob is NOT rendered, so the engine's own default
    # `--fit` places tensors (untuned models); explicit values render as ever and
    # legitimately disable upstream fitting for that arg. ctx-size is ALWAYS rendered
    # (ctx policy is ours — computed or explicit, never delegated).
    pairs: list[tuple[str, str | None]] = []
    if n_gpu_layers is not None:
        pairs.append(("n-gpu-layers", str(n_gpu_layers)))
    if n_cpu_moe is not None and n_cpu_moe > 0:
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
    # None = OMIT the flag from this section — the child's default `--fit` places
    # tensors (the 1b untuned path); an int renders as ever. ctx_len stays required.
    n_gpu_layers: int | None
    n_cpu_moe: int | None
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
    draft_meta: GgufMeta | None = None,
    draft_bytes: int = 0,
) -> FitPlan:
    """Decide how much of the model fits on the GPU.

    Reserve a safety margin + KV-cache VRAM, then divide the remaining budget
    by the average per-layer weight bytes. MoE expert layers that don't fit
    are offloaded to CPU RAM. Probe-and-back-off at spawn corrects any
    overestimate, so this only needs to be a sane first guess.

    `safety_margin_mb` comes from the RunnerConfig (DB-backed, host) or its
    default; the KV cache-type is taken from the resolved overrides (the DB
    `base` preset sets q8_0) so it isn't under-counted.

    `draft_meta`/`draft_bytes` (2026-07-19) describe the speculative-decode DRAFT
    GGUF when the resolved config carries one (`ov.model_draft`). A draft is a
    SECOND model in the same process — GPU-placed by the engine itself (`-ngld`
    defaults to `auto`, and we emit no override) — so its weights + its own KV are
    charged to the budget before the main split. Omit them and the draft silently
    steals main-model layers: the #274 embed-co-load defect in a new coat. Callers
    that resolve a draft path MUST pass these; absent → byte-identical to the
    pre-2026-07-19 plan.
    """
    ov = overrides or Overrides()
    n_layers = max(1, meta.block_count)
    cache_type = fit.cache_type_bits(ov.cache_type_k or "q8_0")
    # head_count_kv is absent in some GGUF headers — fall back to MHA
    # (≈ hidden_dim / 128, a typical head_dim) so KV isn't under-counted.
    n_kv_heads = meta.n_kv_heads or max(1, meta.embedding_length // 128)
    budget_mb = max(0, max_vram_mb(hardware) - safety_margin_mb)

    # ctx POLICY is ours (1b): an explicit override (tune/preset/request) wins; else the
    # computed knob — the trained window capped by what the KV budget affords on this box
    # (kv_affordable walks the ctx ladder on the regression's own KV term). DEFAULT_CTX
    # remains the floor for headerless files (context_length=0 → min() picks the ladder
    # floor anyway; keep the `or` so a zero trained-ctx never wins the min).
    if ov.ctx_len:
        ctx_len = ov.ctx_len
        ctx_explicit = True
    else:
        ctx_len = min(
            getattr(meta, "context_length", 0) or DEFAULT_CTX,
            fit.kv_affordable(vram_budget_mb=budget_mb, n_layers=n_layers,
                              n_kv_heads=n_kv_heads, cache_type=cache_type),
        )
        ctx_explicit = False

    # The speculative-decode DRAFT's share of the budget, taken BEFORE the main split.
    # `marginal_vram_mb` drops the regression's per-in-use-GPU base offset — the main
    # model already pays that once — while keeping the draft's weights AND its KV at
    # our chosen ctx. ctx itself was picked against the UNdiminished budget just above
    # (one pass, no iteration): that leaves the ctx choice slightly optimistic — and note
    # `kv_affordable`'s _KV_CTX_SHARE now effectively covers main + draft KV together
    # rather than main alone — which the spawn probe-and-back-off nets, per this
    # function's docstring. A CPU-only box (budget 0) has no GPU to charge, so the term
    # is a no-op there.
    draft_marginal_mb = 0.0
    draft_full_mb = 0.0
    if draft_meta is not None and budget_mb > 0:
        d_layers = max(1, draft_meta.block_count)
        d_kw = dict(
            size_mb=draft_bytes / 1e6,
            n_layers=d_layers,
            n_kv_heads=draft_meta.n_kv_heads or max(1, draft_meta.embedding_length // 128),
            embedding_dim=draft_meta.embedding_length,
            ctx_size=ctx_len,
            cache_type=cache_type,
            # We emit no `-ngld`, whose default is `auto` — read from the INSTALLED
            # b10068 `--help` (the PIN is b9993, config.py:49; not re-read there, and
            # upstream's server README agrees) — so the engine sizes the draft's offload
            # itself. Charge ALL its layers anyway: over-reserving costs a main layer at
            # worst, under-reserving is what OOMs. Same build shows NO draft-specific
            # context flag, so the draft rides our chosen ctx.
            gpu_layers=d_layers,
        )
        draft_marginal_mb = fit.marginal_vram_mb(**d_kw)
        draft_full_mb = fit.estimate_vram_mb(**d_kw)
    main_budget_mb = max(0.0, budget_mb - draft_marginal_mb)

    if ov.n_gpu_layers is not None:
        n_gpu = max(0, min(n_layers, ov.n_gpu_layers))
    else:
        # oobabooga's fitted GGUF VRAM formula → the most GPU layers that fit.
        n_gpu = fit.max_gpu_layers(
            size_mb=total_weight_bytes / 1e6,
            n_layers=n_layers,
            n_kv_heads=n_kv_heads,
            embedding_dim=meta.embedding_length,
            ctx_size=ctx_len,
            cache_type=cache_type,
            vram_budget_mb=main_budget_mb,
        )

    if ov.n_cpu_moe is not None:
        n_cpu_moe = max(0, ov.n_cpu_moe)
    else:
        n_cpu_moe = max(0, n_layers - n_gpu) if meta.is_moe else 0

    # GPU-resident VRAM for the chosen split — the SAME fitted formula run forward (cost of n_gpu)
    # rather than inverse (max layers for a budget). The VRAM arbiter reserves this (P2). A
    # fully-CPU load (n_gpu == 0) touches no GPU (no CUDA context), so it reserves 0 — NOT the
    # formula's ~1.5 GB base offset, which represents an in-use GPU. A draft rides ON TOP: the
    # arbiter must reserve what the process actually holds, or a co-resident admission
    # over-books by the draft's size (the very miss this term exists to close).
    #
    # THE ncmoe TERM (2026-07-24, the 2026-07-11 incident's item 2 — the last unbuilt root):
    # `--n-cpu-moe` keeps the expert tensors of the first N layers in system RAM, but this
    # forward estimate booked the FULL file size per GPU layer — Gemma 26B (ngl 30/ncmoe 21)
    # reserved 20.6 GB against a measured ~6.5 GB, so every admission cried "over budget" and
    # co-load decisions ran on fiction. The size term is now scaled by `moe_gpu_size_share`
    # (expert share from the GGUF header; 0 → the exact old estimate). The INVERSE split
    # (`max_gpu_layers` above) deliberately stays undiscounted: for an untuned MoE it would
    # push MORE layers onto the GPU — a behavior change that needs its own measurement round,
    # while this reservation fix is pure accounting (the true-up still corrects post-load).
    # ... and its sibling (same date): for an iSWA model (Gemma 3/4 — most layers hold
    # only a small KV window) the header's per-layer facts give the REAL KV size;
    # `kv_mb_at_ctx` returns None on every other model → the fitted term as ever.
    # Together on the real Gemma-4 26B (ngl 30/ncmoe 21/ctx 32k): 19.8 GB → ~7 GB
    # against a measured 6.5-7.9 GB.
    if n_gpu > 0:
        # getattr-guarded like `context_length` above: tests + duck-typed callers pass
        # minimal meta objects without the 2026-07-24 methods → 0/None → the old estimate.
        share_fn = getattr(meta, "expert_byte_share", None)
        kv_fn = getattr(meta, "kv_mb_at_ctx", None)
        moe_share = fit.moe_gpu_size_share(
            n_layers=n_layers, gpu_layers=n_gpu, n_cpu_moe=n_cpu_moe,
            expert_share=share_fn() if (meta.is_moe and callable(share_fn)) else 0.0,
        )
        vram_mb = int(fit.estimate_vram_mb(
            size_mb=total_weight_bytes / 1e6 * moe_share, n_layers=n_layers, n_kv_heads=n_kv_heads,
            embedding_dim=meta.embedding_length, ctx_size=ctx_len, cache_type=cache_type,
            gpu_layers=n_gpu, kv_mb=kv_fn(ctx_len, cache_type) if callable(kv_fn) else None,
        ) + draft_marginal_mb)
    elif draft_full_mb > 0:
        # Main fell fully to CPU, but the draft still lands on the GPU — it is then the
        # ONLY tenant, so it pays the base offset itself (full estimate, not marginal).
        vram_mb = int(draft_full_mb)
    else:
        vram_mb = 0

    return FitPlan(
        n_gpu_layers=n_gpu, n_cpu_moe=n_cpu_moe, ctx_len=ctx_len,
        block_count=n_layers, is_moe=meta.is_moe, vram_mb=vram_mb,
        ngl_explicit=ov.n_gpu_layers is not None,
        ncmoe_explicit=ov.n_cpu_moe is not None,
        ctx_explicit=ctx_explicit,
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


def _looks_like_draft_failure(text: str) -> bool:
    """The MTP/speculative-decode draft-load crash (2026-07-12): llama.cpp's router
    crashes the DRAFT model ('invalid vector subscript') when it loads beside another
    LOADING/active child — the co-load bug. The signature is the router's own
    'failed to load draft model' line; the load backoff recovers by loading the
    draft-carrying model solo (co-residents unloaded), never losing speculative decoding."""
    return "failed to load draft model" in (text or "").lower()


def _looks_like_unfixable(text: str) -> bool:
    """A load failure that re-emitting the model with EXPLICIT placement cannot fix — so the
    1b-F4 fit-placed retry must fail fast rather than restart the engine (a bounce that knocks
    down + reloads every healthy co-resident model) for nothing. The signatures are llama.cpp's
    own stderr, verified 2026-07-21 against the master source (llama.cpp is NOT vendored —
    re-verify at an engine bump):
      - "error: invalid argument:" — common/arg.cpp raises std::invalid_argument("error: invalid
        argument: %s") on an unrecognized flag; a rejected `--ngl` prints "error: invalid
        argument: --ngl" (github.com/ggml-org/llama.cpp/issues/23739).
      - "error while handling argument" — common/arg.cpp raises 'error while handling argument
        "%s": %s' when a known flag's value is rejected.
      - "unknown model architecture" — the loader emits "unknown model architecture: '<name>'"
        for an arch this build doesn't know (github.com/ggml-org/llama.cpp/issues/21320).
    A bad extra_flags passthrough re-sends identically, so the retry can't fix it. Kept TIGHT:
    a false NEGATIVE is only today's single bounce; a false POSITIVE cannot wrongly refuse a
    #18066 fixable fit-bug (the fit vs explicit-retry argv differ ONLY by added ngl/ncmoe lines,
    and all three signatures are parse-/load-time errors independent of placement), so bare
    "invalid argument" (also a CUDA runtime error, not an arg reject) is NOT matched."""
    t = (text or "").lower()
    return any(s in t for s in (
        "error: invalid argument:", "error while handling argument", "unknown model architecture",
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


# ── The Windows orphan-child fix (model-per-hardware plan Phase 4 + amendment A3) ──
# On-box incident (2026-07-06): stopping the JW server ORPHANED its llama-server child
# on Windows — :8080 survived, serving a stale generated ini. A Job Object with
# JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE ties the child's lifetime to the job HANDLE: when
# the parent dies (or stop() closes the handle), the OS kills the child. The handle is
# RETAINED on the returned _ServerHandle — dropping it early would kill the child
# immediately, which is why every spawn goes through the ONE `_spawn_child` seam below
# (A3: four ad-hoc Popen sites would each need this wiring and would drift).
_KILL_ON_JOB_CLOSE = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
_JOB_EXTENDED_INFO_CLASS = 9  # JobObjectExtendedLimitInformation


def _win_job_for_child(proc):
    """Enclose a freshly-spawned child in a kill-on-close Job Object (win32 only).
    Returns the job handle to retain, or None (off-Windows, or on ANY failure —
    the job is a safety net; it must never block a spawn). Real kill-on-parent-
    death behavior is a box check (§G) — this seam is unit-tested for the
    degrade-gracefully contract only.

    Win32 facts WEB-VERIFIED 2026-07-06 (the upstream hard rule — none of this is
    from recall): JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000 and
    JobObjectExtendedLimitInformation = 9, both verbatim in golang/sys
    (raw.githubusercontent.com/golang/sys/master/windows/types_windows.go, the
    SDK-generated Go bindings) with the kill-on-last-handle-close semantics per
    Microsoft Learn (winnt.h JOBOBJECT_BASIC_LIMIT_INFORMATION — "requires
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION"). The EXTENDED layout (Basic +
    IO_COUNTERS IoInfo + 4×SIZE_T) and IO_COUNTERS (6×ULONGLONG) are verbatim in
    golang/sys — IoInfo IS an inline IO_COUNTERS, not a pointer. The BASIC layout
    (LARGE_INTEGER×2 · DWORD LimitFlags · SIZE_T×2 · DWORD · ULONG_PTR Affinity ·
    DWORD×2) matches Microsoft's own windows-rs bindings
    (microsoft.github.io/windows-docs-rs …JobObjects/struct.JOBOBJECT_BASIC_
    LIMIT_INFORMATION: i64,i64,u32,usize,usize,u32,usize,u32,u32). `proc._handle`
    is CPython's Windows Popen process handle (Lib/subprocess.py: `self._handle =
    Handle(hp)`; Handle subclasses int). restype/argtypes are set explicitly —
    HANDLE is pointer-width, and the ctypes default c_int return would truncate
    handles on Win64 (the checker's catch)."""
    if sys.platform != "win32":
        return None
    try:
        import ctypes

        k32 = ctypes.windll.kernel32
        k32.CreateJobObjectW.restype = ctypes.c_void_p
        k32.CreateJobObjectW.argtypes = (ctypes.c_void_p, ctypes.c_wchar_p)
        k32.SetInformationJobObject.restype = ctypes.c_int
        k32.SetInformationJobObject.argtypes = (
            ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32)
        k32.AssignProcessToJobObject.restype = ctypes.c_int
        k32.AssignProcessToJobObject.argtypes = (ctypes.c_void_p, ctypes.c_void_p)
        job = k32.CreateJobObjectW(None, None)
        if not job:
            return None

        class _IoCounters(ctypes.Structure):
            _fields_ = [(n, ctypes.c_uint64) for n in (
                "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

        class _BasicLimits(ctypes.Structure):
            _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64),
                        ("PerJobUserTimeLimit", ctypes.c_int64),
                        ("LimitFlags", ctypes.c_uint32),
                        ("MinimumWorkingSetSize", ctypes.c_size_t),
                        ("MaximumWorkingSetSize", ctypes.c_size_t),
                        ("ActiveProcessLimit", ctypes.c_uint32),
                        ("Affinity", ctypes.c_size_t),
                        ("PriorityClass", ctypes.c_uint32),
                        ("SchedulingClass", ctypes.c_uint32)]

        class _ExtendedLimits(ctypes.Structure):
            _fields_ = [("BasicLimitInformation", _BasicLimits),
                        ("IoInfo", _IoCounters),
                        ("ProcessMemoryLimit", ctypes.c_size_t),
                        ("JobMemoryLimit", ctypes.c_size_t),
                        ("PeakProcessMemoryUsed", ctypes.c_size_t),
                        ("PeakJobMemoryUsed", ctypes.c_size_t)]

        info = _ExtendedLimits()
        info.BasicLimitInformation.LimitFlags = _KILL_ON_JOB_CLOSE
        if not k32.SetInformationJobObject(job, _JOB_EXTENDED_INFO_CLASS,
                                           ctypes.byref(info), ctypes.sizeof(info)):
            k32.CloseHandle(job)
            return None
        if not k32.AssignProcessToJobObject(job, ctypes.c_void_p(int(proc._handle))):
            k32.CloseHandle(job)
            return None
        return job
    except Exception:  # noqa: BLE001 — a safety net must never block a spawn
        return None


def _close_job(job) -> None:
    """Close a retained job handle (kills the enclosed child under KILL_ON_JOB_CLOSE).
    No-op off-Windows / on None / on any failure."""
    if job is None or sys.platform != "win32":
        return
    try:
        import ctypes

        k32 = ctypes.windll.kernel32
        k32.CloseHandle.argtypes = (ctypes.c_void_p,)  # HANDLE is pointer-width
        k32.CloseHandle(job)
    except Exception:  # noqa: BLE001
        pass


def _spawn_child(popen, argv, logf):
    """The ONE spawn seam every llama-server child goes through (A3): the shared
    stdout/stderr wiring + the Windows Job Object enclosure. Returns
    `(proc, job_handle)` — the caller stores the handle on its _ServerHandle."""
    if logf is not None:
        proc = popen(argv, stdout=logf, stderr=subprocess.STDOUT)
    else:
        proc = popen(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    return proc, _win_job_for_child(proc)


@dataclass
class _ServerHandle:
    """A live llama-server process (OpenAI-compatible at `url`) — the ONE
    process-handle surface (`is_alive`/`health`/`stop`) shared by the single-model
    `Runner` and the multi-model `RouterHandle` (so the aliveness/health/terminate
    logic has a single source)."""

    process: object
    url: str
    # The retained Windows Job Object handle (None off-win32) — see _spawn_child.
    # kw_only so subclass non-default fields stay legal after this defaulted one.
    job_handle: object = field(default=None, kw_only=True)

    def is_alive(self) -> bool:
        return self.process.poll() is None

    def health(self) -> bool:
        return _default_health(self.url)

    def stop(self) -> None:
        try:
            self.process.terminate()
        except Exception:  # noqa: BLE001
            pass
        # Closing the job (win32) guarantees the whole child tree dies with us.
        _close_job(self.job_handle)


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
            proc, job = _spawn_child(popen, [str(server_exe), *flags], logf)
            if _wait_until_healthy(proc, url, probe_timeout, health, _sleep, _now):
                return Runner(process=proc, url=url, n_gpu_layers=n_gpu, n_cpu_moe=n_cpu_moe,
                              job_handle=job)

            # Capture WHY before killing: poll() is None for a hang (still alive at
            # the deadline) or the self-exit code if it died on its own.
            rc = proc.poll()
            output = _tail_file(log_path) if log_path else _drain(proc)
            _kill(proc)
            _close_job(job)  # a failed spawn's job dies with its child
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
        proc, job = _spawn_child(popen, [str(server_exe), *argv], logf)
        if _wait_until_healthy(proc, url, probe_timeout, health, _sleep, _now):
            return RouterHandle(process=proc, url=url, job_handle=job)
        rc = proc.poll()
        output = _tail_file(log_path) if log_path else _drain(proc)
        _kill(proc)
        _close_job(job)  # a failed spawn's job dies with its child
        status = "still running, killed on timeout" if rc is None else f"exit {rc}"
        where = f"  [log: {log_path}]" if log_path else ""
        raise RunnerStartError(
            f"llama-server router failed to become healthy ({status}): {output[-1000:]}{where}"
        )
    finally:
        if logf is not None:
            logf.close()
