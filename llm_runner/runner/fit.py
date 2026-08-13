# SPDX-License-Identifier: MIT
"""VRAM-fit math for the local runner — pure functions, no I/O.

Two estimates, for two moments:
  * `coarse_fit()` — a PRE-download band (ok/tight/no/cpu) from the manifest's
    params + quant alone (no GGUF needed), for the catalog badge.
  * `estimate_vram_mb()` / `max_gpu_layers()` — the PRECISE post-download
    estimate from real GGUF metadata, used to choose `--n-gpu-layers` at spawn.

`estimate_vram_mb` re-implements oobabooga's empirically-fitted GGUF VRAM
formula — a regression over ~19,500 real VRAM measurements:
    https://oobabooga.github.io/blog/posts/gguf-vram-formula/
The formula and its fitted constants are a mathematical model (facts); this is
our own implementation in our own style, not a copy of any source file. The
spawn loop's OOM probe-and-back-off (`process.py`) stays the safety net for
residual error, so this only needs to be an accurate first guess.
"""

from __future__ import annotations

import math
import re

# ── Coarse pre-download estimate: params × effective bytes/weight ────────────

# Effective bytes per weight for common GGUF quants, from public bits-per-weight
# tables / file-size measurements (a 7B Q4_K_M GGUF ≈ 4 GB ⇒ ≈ 0.6 B/param).
# Approximate — it only drives the COARSE catalog badge; the precise path uses
# the real GGUF file size, never this table.
_BYTES_PER_PARAM: dict[str, float] = {
    "f32": 4.0, "f16": 2.0, "bf16": 2.0,
    "q8_0": 1.06,
    "q6_k": 0.82,
    "q5_k_m": 0.71, "q5_k_s": 0.69, "q5_0": 0.71, "q5_1": 0.77, "q5_k": 0.70,
    "q4_k_m": 0.60, "q4_k_s": 0.57, "q4_0": 0.59, "q4_1": 0.65, "q4_k": 0.60,
    "iq4_xs": 0.53, "iq4_nl": 0.56,
    "q3_k_l": 0.53, "q3_k_m": 0.49, "q3_k_s": 0.44, "q3_k": 0.49,
    "iq3_xxs": 0.39,
    "q2_k": 0.42, "iq2_xxs": 0.26,
}


def bytes_per_param(quant: str) -> float:
    """Effective bytes/weight for a quant string ('Q4_K_M', 'UD-Q4_K_XL', …).
    Falls back to a known key prefix, then the leading Q<n> bit-width, then 0.6
    (≈ a 4-bit K-quant)."""
    q = (quant or "").strip().lower().removeprefix("ud-")
    if q in _BYTES_PER_PARAM:
        return _BYTES_PER_PARAM[q]
    for key, val in _BYTES_PER_PARAM.items():
        if q.startswith(key):  # e.g. unsloth 'q4_k_xl' → q4_k_* family
            return val
    m = re.match(r"q(\d+)", q)
    if m:
        return max(0.3, int(m.group(1)) / 8 + 0.08)  # bits/8 + a little K-quant overhead
    return 0.6


def parse_params(s: str | None) -> float | None:
    """'35B' → 35e9, '3.6B' → 3.6e9, '500M' → 5e8. None if unparseable."""
    if not s:
        return None
    m = re.match(r"\s*([\d.]+)\s*([bBmM])", str(s))
    if not m:
        return None
    return float(m.group(1)) * (1e9 if m.group(2) in "bB" else 1e6)


def weights_mb(total_params: str | None, quant: str) -> float | None:
    """Estimated weight size in MB from total params × effective bytes/weight."""
    p = parse_params(total_params)
    return None if p is None else p * bytes_per_param(quant) / 1e6


def coarse_fit(
    *,
    total_params: str | None,
    quant: str,
    vram_mb: int,
    ram_mb: int,
    margin_mb: int,
    min_vram_override: int | None = None,
    min_ram_override: int | None = None,
) -> str:
    """Pre-download band: 'ok' | 'tight' | 'no' | 'cpu' | 'unknown'.

    Uses an explicit min-VRAM hint when the manifest sets one (it can encode MoE
    CPU-offload that a raw weights estimate misses); otherwise computes
    params × bytes/weight — so a model needs no hand-tuned number to get a badge.
    """
    # RAW-TO-RAW (fit-redesign §13.5, Phase 2): floors arrive RAW now (computed
    # fresh from the physics facts — file + headroom, never a nominal rung), so
    # detected RAM compares directly and the rung-vs-detected bug class
    # (32,690 vs a 32,768 rung — fails forever, 0.24% short) is unrepresentable.
    # The Phase-0 snap bridge is DELETED — snapping detected RAM through
    # `snap_ram_gb` against a raw floor would FALSE-FAIL carve-out boxes
    # (13.7 GB usable snaps DOWN to 12 and misses a 13 GB floor the box holds).
    # `snap_ram_gb` itself lives on for CLASS keys — a different job. Legacy
    # rung floors in a pre-reset DB may misread until the reset — the accepted
    # pre-release cost (no migrations; the user resets).
    if vram_mb <= 0:
        # CPU-only box: runs on CPU unless RAM can't even hold the model.
        floor = min_ram_override or weights_mb(total_params, quant)
        if floor and ram_mb and ram_mb < floor:
            return "no"
        return "cpu"
    # A GPU box still needs enough system RAM: a MoE offloads its experts to RAM
    # (`--n-cpu-moe`), so an 8 GB-VRAM / 16 GB-RAM box cannot run a 32–64 GB-RAM
    # MoE no matter how the active path fits VRAM. Gate on the DECLARED RAM floor
    # only (a dense model fully in VRAM sets no large floor); absent → no RAM gate.
    if min_ram_override and ram_mb and ram_mb < min_ram_override:
        return "no"
    need = float(min_vram_override) if min_vram_override else weights_mb(total_params, quant)
    if not need:
        return "unknown"
    ratio = need / max(vram_mb - margin_mb, 1)
    if ratio <= 1.0:
        return "ok"
    if ratio <= 1.5:
        return "tight"
    return "no"


# ── Precise post-download estimate: oobabooga's fitted GGUF VRAM formula ─────

def cache_type_bits(cache_type_k: str | None) -> int:
    """KV-cache element bit-width the formula expects: q4_0→4, q8_0→8, else 16."""
    return {"q4_0": 4, "q8_0": 8}.get((cache_type_k or "").strip().lower(), 16)


# Fitted constants from oobabooga's GGUF VRAM regression (see module docstring).
_C0 = 17.99552795246051
_C1 = 3.148552680382576e-05
_C2 = 0.9690636483914102
_C3 = 50.77817218646521
_C4 = 9.987899908205632
_C5 = 1516.522943869404


def kv_bytes_per_token(n_kv_heads: int, cache_type: int) -> float:
    """The regression's per-layer, per-context-token KV factor (`n_kv_heads × cache-type
    bit-width`) — the ONE source of the KV term (model-per-hardware plan, 1b-F3).
    `_slope_offset` consumes it inside the fitted slope (× `_C1` × ctx, per layer) and
    `kv_affordable` consumes it to bound the computed ctx; extracting it keeps the two
    from ever drifting (a drift test pins the equality)."""
    return float(max(1, n_kv_heads) * max(1, cache_type))


def _slope_offset(
    size_mb: float, n_layers: int, n_kv_heads: int, embedding_dim: int, ctx_size: int, cache_type: int,
    kv_mb: float | None = None,
) -> tuple[float, float, float]:
    """(A, B, C) for the linear-in-gpu_layers model  vram = A·(gpu_layers + B) + C.

    `kv_mb` (2026-07-24, the iSWA-honest KV): when the caller computed the model's
    REAL whole-model KV size from per-layer header facts (`GgufMeta.kv_mb_at_ctx` —
    interleaved sliding-window models, where the regression's uniform full-ctx KV
    projection overbooks by GBs), it replaces the fitted `_C1` KV term with
    `kv_mb / n_layers` per layer. None (every non-iSWA model) → the fitted term,
    byte-identical to before."""
    n_layers = max(1, n_layers)
    ctx_size = max(1, ctx_size)
    size_per_layer = size_mb / n_layers
    if kv_mb is not None:
        kv_per_layer = kv_mb / n_layers
    else:
        kv_per_layer = _C1 * kv_bytes_per_token(n_kv_heads, cache_type) * ctx_size
    embedding_per_context = embedding_dim / ctx_size
    a = size_per_layer - _C0 + kv_per_layer
    b = max(_C2, cache_type - (math.floor(_C3 * embedding_per_context) + _C4))
    return a, b, _C5


# The ladder the computed-ctx knob walks — power-of-two context sizes models actually
# train/serve at; the smallest rung is the floor every model is granted.
_CTX_LADDER = (4096, 8192, 16384, 32768, 65536, 131072, 262144)
# Share of the VRAM budget the KV cache may claim when WE pick the context for an
# UNTUNED model (the rest stays for weights + compute). A first-principles split that is
# deliberately BOX-GATED before it retires anything: the §G check "computed ctx == 32768
# on the 2070S" calibrates it against the one machine with a measured optimum
# (model-per-hardware plan, A2 + 1b); a tune's explicit ctx always wins over this.
_KV_CTX_SHARE = 0.5


def kv_affordable(*, vram_budget_mb: float, n_layers: int, n_kv_heads: int, cache_type: int) -> int:
    """Largest ladder ctx whose PROJECTED whole-model KV cost fits `_KV_CTX_SHARE` of the
    VRAM budget — the ctx-POLICY half of the 1b division (we pick ctx as a product
    decision; upstream `--fit` places tensors at it). The KV projection reuses the
    regression's own term via `kv_bytes_per_token` (single source): per-ctx-token MB
    ≈ `_C1 × factor × n_layers`. A zero/CPU budget returns the ladder floor."""
    budget = max(0.0, vram_budget_mb) * _KV_CTX_SHARE
    per_ctx_mb = _C1 * kv_bytes_per_token(n_kv_heads, cache_type) * max(1, n_layers)
    best = _CTX_LADDER[0]
    for ctx in _CTX_LADDER:
        if per_ctx_mb * ctx <= budget:
            best = ctx
        else:
            break
    return best


def estimate_vram_mb(
    *, size_mb: float, n_layers: int, n_kv_heads: int, embedding_dim: int,
    ctx_size: int, cache_type: int, gpu_layers: int, kv_mb: float | None = None,
) -> float:
    """Predicted VRAM (MiB) to offload `gpu_layers` of this GGUF at `ctx_size`.
    `kv_mb`: the precise whole-model KV size when the header supports it (iSWA
    models — see `_slope_offset`); None → the fitted KV term as ever."""
    a, b, c = _slope_offset(size_mb, n_layers, n_kv_heads, embedding_dim, ctx_size, cache_type, kv_mb)
    if a <= 0:
        # Degenerate slope — the regression run OUT OF ITS DOMAIN (a max-offload MoE
        # strips 94-98% of each layer's bytes and the fitted −18 MB/layer credit
        # flips the slope: the real Qwen3.6-35B header gives a = −1.24 MB/layer,
        # fit-redesign §1.2). A negative slope claims each extra GPU layer FREES
        # VRAM — garbage. Mirror `max_gpu_layers`'s guard: per-layer cost is noise
        # here, so the estimate is the base offset, independent of gpu_layers.
        return max(0.0, c)
    return a * (gpu_layers + b) + c


def marginal_vram_mb(
    *, size_mb: float, n_layers: int, n_kv_heads: int, embedding_dim: int,
    ctx_size: int, cache_type: int, gpu_layers: int,
) -> float:
    """Predicted VRAM for a SECOND model sharing an already-in-use GPU — the same
    regression MINUS its base offset `_C5` (≈1.5 GB), floored at 0.

    `_C5` is the fitted per-in-use-GPU constant (CUDA context, scratch/compute
    buffers): it is paid ONCE, by the model that puts the GPU to work. Charging it
    again to a co-resident model would double-count ~1.5 GB and needlessly shed main-
    model layers. The co-resident's own weights AND its KV cache at `ctx_size` DO
    ride in the slope, so they are counted in full.

    THE consumer is `compute_fit`'s speculative-decode draft term (2026-07-19): a
    `--model-draft` GGUF is fully offloaded by llama.cpp alongside the main model,
    so its cost must come off the budget before the main split is computed."""
    return max(0.0, estimate_vram_mb(
        size_mb=size_mb, n_layers=n_layers, n_kv_heads=n_kv_heads,
        embedding_dim=embedding_dim, ctx_size=ctx_size, cache_type=cache_type,
        gpu_layers=gpu_layers,
    ) - _C5)


def moe_gpu_size_share(
    *, n_layers: int, gpu_layers: int, n_cpu_moe: int, expert_share: float,
) -> float:
    """Multiplier on the WHOLE-FILE weight size so the regression's per-layer size term
    reflects what `--n-cpu-moe` actually leaves on the GPU (2026-07-24; the arbiter
    over-booking defect — item 2 of the 2026-07-11 incident, the one root left unbuilt:
    Gemma 26B at ngl 30 / ncmoe 21 booked 20.6 GB against a measured ~6.5 GB, so every
    admission warned "over budget" and co-load admissions ran on fiction).

    Model: of the `gpu_layers` offloaded layers, the first `n_cpu_moe` keep only their
    non-expert bytes on the GPU (attention/dense/shared; share `1 - expert_share`); the
    rest carry full layers. Overlap = min(n_cpu_moe, gpu_layers) — the box-measured
    semantics (ngl 30 / ncmoe 21 ≈ 6.5 GB real fits overlap 21, not the 3 the
    last-layers-first reading would give). `expert_share` comes from the GGUF header
    (`GgufMeta.expert_byte_share`); 0 (dense / unknown dims / ncmoe 0) → 1.0, the exact
    pre-2026-07-24 estimate. Pure math — the caller scales `size_mb` by this before
    `estimate_vram_mb`; the KV term rides the layer count, deliberately untouched."""
    g = min(max(0, gpu_layers), max(1, n_layers))
    if g <= 0 or expert_share <= 0:
        return 1.0
    stripped = min(max(0, n_cpu_moe), g)          # GPU layers whose experts sit in RAM
    share = (g - stripped * expert_share) / g
    return max(0.0, min(1.0, share))


# ── The physics decomposition (fit-redesign Phase 1, §5.1) ───────────────────
# Compute what physics determines; the fitted regression above stays as the CI
# oracle on its dense-CUDA domain (§7.1) and as the inverse-split chooser until
# Phase 6's joint solve. Terms: device-resident weights (placement share) +
# exact KV + a per-backend overhead seed. Scratch/compute buffers ride inside
# the overhead seed until Phase 5 learns their coefficient per machine (§13.6).

# Per-backend overhead seeds (MiB): CUDA context + scratch at typical ubatch —
# cuda inherits the regression's fitted per-in-use-GPU offset `_C5` (the value
# Appendix A's first-principles floors validated); vulkan/rocm = cuda + a
# DOCUMENTED margin (no fitted data — provenance 'seed-guess', self-corrected
# by Phase 5's persisted true-ups); metal = a conservative one-pool constant
# (same provenance). NOT operator knobs — these become DB rows with the
# measurement loop in Phase 5; until then they are seed values, not tunables.
PHYSICS_OVERHEAD_MB: dict[str, float] = {
    "cuda": _C5,
    "vulkan": _C5 + 512.0,
    "rocm": _C5 + 512.0,
    "metal": 1024.0,
    "cpu": 0.0,
}


def kv_exact_mb(
    *, n_layers: int, n_kv_heads: int, ctx_size: int, cache_type: int,
    key_length: int = 0, value_length: int = 0,
    embedding_dim: int = 0, head_count: int = 0,
) -> float:
    """Exact whole-model KV size (MiB) for a UNIFORM-attention model — the §5.1
    generalization of `GgufMeta.kv_mb_at_ctx` (which stays the source for iSWA
    models, where per-layer windows change the answer). Per layer, per token:
    kv_heads × (key_dim + value_dim) × cache_bytes. Missing per-head dims fall
    back to embedding_dim / head_count, then 128 (the typical head_dim — the
    same fallback `compute_fit` uses for missing head counts)."""
    if n_layers <= 0 or n_kv_heads <= 0 or ctx_size <= 0:
        return 0.0
    head_dim = 0
    if head_count > 0 and embedding_dim > 0:
        head_dim = embedding_dim // head_count
    k = key_length or head_dim or 128
    v = value_length or head_dim or 128
    bytes_per_elem = max(1, cache_type) / 8.0
    return n_layers * n_kv_heads * (k + v) * ctx_size * bytes_per_elem / 1e6


def kv_mb_from_facts(facts: dict, ctx: int, cache_bits: int = 16) -> float:
    """KV size (MiB) at `ctx` from the STORED physics facts — the §13.11 scalar
    formula `KV(ctx,bits) = [Wb × min(ctx,window) + Gb × ctx] × bits/8`, byte-
    identical to `GgufMeta.kv_mb_at_ctx`'s per-layer loop (pinned by test).
    Lives HERE (moved from llm/identity.py at Phase 3) because the runner's badge
    speed model reads the same facts pre-download; identity delegates — one
    source. Scalars absent (legacy row) → `kv_exact_mb`'s dim heuristics."""
    wb = float(facts.get("kv_windowed_bytes_per_token") or 0.0)
    gb = float(facts.get("kv_global_bytes_per_token") or 0.0)
    window = int(facts.get("sliding_window") or 0)
    if wb or gb:
        return (wb * min(ctx, window if window > 0 else ctx) + gb * ctx) * (cache_bits / 8.0) / 1e6
    return kv_exact_mb(
        n_layers=int(facts.get("block_count") or 0),
        n_kv_heads=int(facts.get("n_kv_heads") or 0),
        ctx_size=ctx, cache_type=cache_bits,
        embedding_dim=int(facts.get("embedding_length") or 0),
        head_count=int(facts.get("head_count") or 0),
    )


# ── The decode-speed model (fit-redesign Phase 3, §5.5 as corrected 2026-08-13) ──
# decode ceiling ≈ bytes touched per forward pass ÷ effective bandwidth of the
# pool those bytes live in. Bytes/pass: dense = the whole file; MoE = non-expert
# bytes + the ACTIVE expert share (file × expert_byte_share × used/total) — plus
# a KV-read term at the live context (iSWA-aware). Pools are priced separately
# (streamed device reads vs scattered host expert gather are DIFFERENT physical
# processes — Appendix B; never one shared constant) and the per-pool times ADD:
# the serial sum is what Appendix B's host-constant derivation solved, and it is
# the conservative end of "slowest pool wins" (err-slow, §8.17). Speed predicts
# UN-SPED (§13.7 — no seeded acceptance constant); a real measurement outranks
# every prediction at display time.

def active_bytes_per_pass_mb(
    *, size_mb: float, expert_byte_share: float, experts_total: int, expert_used: int,
) -> tuple[float, float]:
    """(non_expert_mb, active_expert_mb) touched per forward pass. Dense (no
    expert dims) → (whole file, 0). Appendix B pins: 26B = 871 + 836 MB;
    12B dense = 6716 + 0 MB."""
    size_mb = max(0.0, size_mb)
    share = max(0.0, min(1.0, expert_byte_share))
    if share <= 0 or experts_total <= 0 or expert_used <= 0:
        return size_mb, 0.0
    used = min(expert_used, experts_total)
    return size_mb * (1.0 - share), size_mb * share * (used / experts_total)


def speed_bytes_split(
    *, non_expert_mb: float, active_expert_mb: float, kv_mb: float,
    one_pool: bool, weight_budget_mb: float,
) -> tuple[float, float]:
    """(device_mb, host_mb) read per pass under the CANONICAL placement the
    verdict prices (max-offload: experts in host RAM, everything else device).
    `weight_budget_mb` = VRAM budget already net of margin + backend overhead.
    Dense that fits → all device; dense/attention overflow spills to host by
    byte fraction (the partial-offload trap honestly reads slow); no budget →
    everything host; one-pool boxes put every byte in the ONE pool (device
    slot — the caller prices it at the pool's bandwidth)."""
    device_want = max(0.0, non_expert_mb) + max(0.0, kv_mb)
    if one_pool:
        return device_want + max(0.0, active_expert_mb), 0.0
    budget = max(0.0, weight_budget_mb)
    frac = 1.0 if device_want <= budget else (budget / device_want if device_want > 0 else 0.0)
    device = device_want * frac
    host = max(0.0, active_expert_mb) + device_want * (1.0 - frac)
    return device, host


def predict_decode_tok_s(
    *, device_mb: float, host_mb: float,
    device_bw_gbps: float | None, host_bw_gbps: float | None,
) -> float | None:
    """Predicted UN-SPED decode tok/s from the per-pool byte split and the
    EFFECTIVE per-pool bandwidths (raw × efficiency family, or measurement-
    derived — the caller resolves the ladder). Per-token time = Σ pool_bytes /
    pool_bw, pools serial (see the section comment). A pool with bytes but no
    usable bandwidth → None: an unknown may never become a number (§8.17's
    spirit — the badge shows no band rather than a guess)."""
    total_s = 0.0
    for mb, bw in ((device_mb, device_bw_gbps), (host_mb, host_bw_gbps)):
        if mb <= 0:
            continue
        if not bw or bw <= 0:
            return None
        total_s += (mb / 1000.0) / bw
    if total_s <= 0:
        return None
    return 1.0 / total_s


def speed_band(tok_s: float | None, *, fast: float, fine: float, slow: float) -> str:
    """tok/s → band label (§8.14: fast/fine/slow/painful; the ~`fine` line is
    reading speed). None/non-positive → "" — never a fabricated band."""
    if not tok_s or tok_s <= 0:
        return ""
    if tok_s >= fast:
        return "fast"
    if tok_s >= fine:
        return "fine"
    if tok_s >= slow:
        return "slow"
    return "painful"


def physics_vram_mb(
    *, size_mb: float, n_layers: int, gpu_layers: int, moe_share: float,
    kv_mb: float, overhead_mb: float,
) -> float:
    """Predicted device-resident VRAM (MiB) from first principles: the weight
    bytes placement leaves on the device (`moe_share` from `moe_gpu_size_share`,
    prorated by offloaded layers) + the KV share riding those layers + the
    backend overhead. gpu_layers == 0 → 0 (no CUDA/Metal context is created —
    the same rule the regression path enforces). This replaces the fitted
    regression for FORWARD booking (§5.1); the regression survives as the CI
    oracle (§7.1) and the inverse chooser (Phase 6 replaces that)."""
    n_layers = max(1, n_layers)
    g = max(0, min(gpu_layers, n_layers))
    if g <= 0:
        return 0.0
    weights = max(0.0, size_mb) * max(0.0, min(1.0, moe_share)) * (g / n_layers)
    kv = max(0.0, kv_mb) * (g / n_layers)
    return weights + kv + max(0.0, overhead_mb)


def moe_joint_split(
    *, size_mb: float, n_layers: int, expert_share: float, kv_mb: float,
    overhead_mb: float, budget_mb: float,
) -> tuple[int, int]:
    """(n_gpu_layers, n_cpu_moe) for an UNTUNED MoE on a two-pool box — the
    Phase 6 joint solve (fit-redesign §5.7): pin ngl = n_layers and walk the
    SMALLEST ncmoe whose forward physics estimate fits `budget_mb` (the caller
    passes it draft-charged). Expert offload is the cheap knob — each step
    frees `size × expert_share / n_layers` (≈0.45 GB/layer on the 26B, the
    §13.9-measured 0.41) while keeping attention + KV on the device; shedding
    a layer moves those too, which is why the old inverse (ngl 8-9 on the 26B)
    never agreed with any measured tune (ngl=all, ncmoe 21). Nothing fits even
    at ncmoe = n_layers → keep all experts in RAM and walk ngl DOWN through
    the same physics (the spawn back-off nets residual error). Both walks are
    monotone; a tiny loop, never a solver."""
    n_layers = max(1, n_layers)
    for nc in range(0, n_layers + 1):
        share = moe_gpu_size_share(
            n_layers=n_layers, gpu_layers=n_layers, n_cpu_moe=nc,
            expert_share=expert_share,
        )
        need = physics_vram_mb(
            size_mb=size_mb, n_layers=n_layers, gpu_layers=n_layers,
            moe_share=share, kv_mb=kv_mb, overhead_mb=overhead_mb,
        )
        if need <= budget_mb:
            return n_layers, nc
        if expert_share <= 0:
            break  # the walk is flat (no expert bytes to strip) — go shed layers
    for g in range(n_layers - 1, -1, -1):
        share = moe_gpu_size_share(
            n_layers=n_layers, gpu_layers=g, n_cpu_moe=n_layers,
            expert_share=expert_share,
        )
        need = physics_vram_mb(
            size_mb=size_mb, n_layers=n_layers, gpu_layers=g,
            moe_share=share, kv_mb=kv_mb, overhead_mb=overhead_mb,
        )
        if need <= budget_mb:
            return g, n_layers
    return 0, n_layers


def max_gpu_layers(
    *, size_mb: float, n_layers: int, n_kv_heads: int, embedding_dim: int,
    ctx_size: int, cache_type: int, vram_budget_mb: float,
) -> int:
    """Largest gpu_layers whose predicted VRAM fits the budget, clamped to [0, n_layers].

    Closed-form inverse of `estimate_vram_mb` (linear in gpu_layers)."""
    n_layers = max(1, n_layers)
    if vram_budget_mb <= 0 or size_mb <= 0:
        return 0
    a, b, c = _slope_offset(size_mb, n_layers, n_kv_heads, embedding_dim, ctx_size, cache_type)
    if a <= 0:  # degenerate tiny per-layer cost: all layers fit if base overhead does
        return n_layers if c <= vram_budget_mb else 0
    return max(0, min(n_layers, math.floor((vram_budget_mb - c) / a - b)))
