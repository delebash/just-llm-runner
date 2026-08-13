# SPDX-License-Identifier: MIT
"""Unit tests for the runner VRAM-fit math (llm_runner.runner.fit).

Covers the coarse pre-download band, the ported oobabooga VRAM formula
(magnitude + monotonicity), and the closed-form max-gpu-layers inversion.
"""

from __future__ import annotations

from llm_runner.runner import fit


def test_parse_params():
    assert fit.parse_params("35B") == 35e9
    assert fit.parse_params("3.6B") == 3.6e9
    assert fit.parse_params("500M") == 5e8
    assert fit.parse_params(None) is None
    assert fit.parse_params("weird") is None


def test_bytes_per_param():
    assert fit.bytes_per_param("Q4_K_M") == 0.60
    assert fit.bytes_per_param("q8_0") == 1.06
    assert fit.bytes_per_param("UD-Q4_K_XL") == 0.60  # unsloth dynamic → q4_k family
    assert fit.bytes_per_param("Q3_K_M") == 0.49
    assert fit.bytes_per_param("F16") == 2.0
    assert fit.bytes_per_param("") == 0.6  # fallback


def test_coarse_fit_bands():
    common = dict(total_params="7B", quant="Q4_K_M", ram_mb=32000, margin_mb=1024)
    # 7B Q4_K_M ≈ 7e9 * 0.6 / 1e6 = 4200 MB of weights.
    assert fit.coarse_fit(vram_mb=24000, **common) == "ok"
    assert fit.coarse_fit(vram_mb=6000, **common) == "ok"     # 4200 / 4976 < 1
    assert fit.coarse_fit(vram_mb=5000, **common) == "tight"  # 4200 / 3976 ≈ 1.06
    assert fit.coarse_fit(vram_mb=3000, **common) == "no"     # 4200 / 1976 ≈ 2.1
    assert fit.coarse_fit(vram_mb=0, **common) == "cpu"       # CPU box, RAM ample


def test_coarse_fit_cpu_no_when_ram_short():
    # 70B Q4_K_M ≈ 42 GB of weights; 16 GB RAM can't hold it.
    assert fit.coarse_fit(total_params="70B", quant="Q4_K_M", vram_mb=0,
                          ram_mb=16000, margin_mb=1024) == "no"


def test_coarse_fit_override_and_unknown():
    # Explicit minVram override wins (it can encode MoE CPU-offload).
    assert fit.coarse_fit(total_params="35B", quant="Q4_K_M", vram_mb=8000,
                          ram_mb=64000, margin_mb=1024, min_vram_override=6000) == "ok"
    # No params and no override (with a GPU) → unknown.
    assert fit.coarse_fit(total_params=None, quant="Q4_K_M", vram_mb=8000,
                          ram_mb=64000, margin_mb=1024) == "unknown"


def test_coarse_fit_gpu_ram_gate():
    # A GPU box must ALSO clear the model's RAM floor (MoE experts live in RAM).
    # 35B-A3B: 8 GB VRAM fits the active path, but it needs 32 GB RAM.
    a3b = dict(total_params="35B", quant="UD-Q4_K_XL", vram_mb=8000,
               margin_mb=1024, min_vram_override=6000, min_ram_override=32000)
    assert fit.coarse_fit(ram_mb=16000, **a3b) == "no"   # 8 GB VRAM + 16 GB RAM → not offered
    assert fit.coarse_fit(ram_mb=32000, **a3b) == "ok"   # 8 GB VRAM + 32 GB RAM → offered
    # GLM-4.5-Air needs 64 GB RAM — a 32 GB box is gated out even with VRAM to spare.
    assert fit.coarse_fit(total_params="106B", quant="UD-Q4_K_XL", vram_mb=16000,
                          ram_mb=32000, margin_mb=1024, min_vram_override=12000,
                          min_ram_override=64000) == "no"
    # A dense model with no large RAM floor is unaffected by the gate.
    assert fit.coarse_fit(total_params="12B", quant="Q4_K_M", vram_mb=12000,
                          ram_mb=16000, margin_mb=1024, min_ram_override=13000) == "ok"


def test_coarse_fit_ram_gate_snaps_detected_to_nominal():
    """The rung-vs-detected defect (fit-redesign §1.3): floors are NOMINAL rungs,
    detected RAM is physical-minus-firmware, so every rung floor failed on the very
    box it names. The gate snaps detected RAM through `snap_ram_gb` (the class key's
    own snap) — TEMPORARY until floors go raw (§13.5)."""
    box = dict(total_params="35B", quant="UD-Q4_K_XL", vram_mb=8192,
               margin_mb=1024, min_vram_override=6000)
    # The author's box: 32,690 detected vs the 32,768 rung — 78 MB short, 0.24%.
    assert fit.coarse_fit(ram_mb=32690, min_ram_override=32768, **box) == "ok"
    # The shipped victim: E4B floor 8192 on an 8 GB laptop reporting ~7,900 —
    # the RAM gate must not fire (VRAM given headroom so only the gate is tested).
    assert fit.coarse_fit(total_params="8B", quant="Q4_K_M", vram_mb=8192,
                          ram_mb=7900, margin_mb=512, min_ram_override=8192) == "ok"
    # The honest carve-out: ~13.7 GB usable snaps DOWN to 12 — a 16,384 floor still
    # fails (snap never overstates a box; the one-pool arm is the real fix there).
    assert fit.coarse_fit(ram_mb=14000, min_ram_override=16384, **box) == "no"
    # CPU branch gets the same treatment: 32 GB box vs a 32,768 weights floor.
    assert fit.coarse_fit(total_params="55B", quant="Q4_K_M", vram_mb=0,
                          ram_mb=32690, margin_mb=1024, min_ram_override=32768) == "cpu"


def _cfg(**kw):
    base = dict(size_mb=4400, n_layers=32, n_kv_heads=8, embedding_dim=4096,
                ctx_size=4096, cache_type=16)
    base.update(kw)
    return base


def test_estimate_vram_magnitude():
    # 7B Q4_K_M fully offloaded at 4k ctx ≈ ~6 GB — sanity check on the fitted
    # constants (catches a coefficient typo).
    vram = fit.estimate_vram_mb(gpu_layers=32, **_cfg())
    assert 5000 < vram < 7000, vram


def test_estimate_vram_monotonic():
    cfg = _cfg()
    vrams = [fit.estimate_vram_mb(gpu_layers=g, **cfg) for g in range(0, 33)]
    assert vrams == sorted(vrams)  # more layers on GPU ⇒ more VRAM


def test_moe_gpu_size_share():
    # No discount cases: dense/unknown share, no GPU layers, ncmoe 0 — all 1.0
    # (byte-identical to the pre-2026-07-24 estimate).
    assert fit.moe_gpu_size_share(n_layers=48, gpu_layers=30, n_cpu_moe=21, expert_share=0.0) == 1.0
    assert fit.moe_gpu_size_share(n_layers=48, gpu_layers=0, n_cpu_moe=21, expert_share=0.9) == 1.0
    assert fit.moe_gpu_size_share(n_layers=48, gpu_layers=30, n_cpu_moe=0, expert_share=0.9) == 1.0
    # The incident shape (Gemma 26B, ngl 30 / ncmoe 21): 21 of the 30 GPU layers
    # keep only their non-expert bytes → (30 − 21·e)/30.
    share = fit.moe_gpu_size_share(n_layers=48, gpu_layers=30, n_cpu_moe=21, expert_share=0.9)
    assert abs(share - (30 - 21 * 0.9) / 30) < 1e-9
    # ncmoe beyond the GPU layer count clamps to the GPU layers.
    clamped = fit.moe_gpu_size_share(n_layers=48, gpu_layers=10, n_cpu_moe=99, expert_share=0.9)
    assert abs(clamped - (10 - 10 * 0.9) / 10) < 1e-9
    # Always a sane multiplier.
    assert 0.0 <= clamped <= 1.0


def test_estimate_kv_override():
    # kv_mb=None → byte-identical to the fitted KV term; a small REAL KV (iSWA
    # models, computed from per-layer header facts) undercuts the projection.
    cfg = _cfg()
    base = fit.estimate_vram_mb(gpu_layers=16, **cfg)
    assert fit.estimate_vram_mb(gpu_layers=16, kv_mb=None, **cfg) == base
    assert fit.estimate_vram_mb(gpu_layers=16, kv_mb=450.0, **cfg) < base


def test_max_gpu_layers_inverts_estimate():
    cfg = _cfg()
    budget = 4000.0
    n = fit.max_gpu_layers(vram_budget_mb=budget, **cfg)
    assert 0 <= n <= 32
    assert fit.estimate_vram_mb(gpu_layers=n, **cfg) <= budget
    if n < 32:
        assert fit.estimate_vram_mb(gpu_layers=n + 1, **cfg) > budget


def test_max_gpu_layers_clamps():
    cfg = _cfg()
    assert fit.max_gpu_layers(vram_budget_mb=1_000_000, **cfg) == 32  # huge → all layers
    assert fit.max_gpu_layers(vram_budget_mb=0, **cfg) == 0
    assert fit.max_gpu_layers(vram_budget_mb=500, **cfg) == 0  # below base overhead


def test_marginal_drops_exactly_the_base_offset():
    # A co-resident model (the speculative-decode draft) pays the slope — its own
    # weights + KV — but NOT the per-in-use-GPU base constant, which the first model
    # already paid. Anything else double-counts ~1.5 GB and sheds main-model layers.
    cfg = _cfg()
    full = fit.estimate_vram_mb(gpu_layers=32, **cfg)
    marginal = fit.marginal_vram_mb(gpu_layers=32, **cfg)
    assert marginal == full - fit._C5
    assert marginal > 0


def test_marginal_floors_at_zero_for_a_tiny_model():
    # A draft small enough that the regression's slope can't cover the base offset
    # must not return a NEGATIVE budget credit.
    tiny = fit.marginal_vram_mb(gpu_layers=1, **_cfg(size_mb=1, n_layers=1, ctx_size=512))
    assert tiny == 0.0


def test_gqa_reduces_kv_cost():
    # More KV heads (MHA) ⇒ more VRAM/layer ⇒ no more layers fit than GQA.
    mha = fit.max_gpu_layers(vram_budget_mb=4000, **_cfg(n_kv_heads=32))
    gqa = fit.max_gpu_layers(vram_budget_mb=4000, **_cfg(n_kv_heads=8))
    assert gqa >= mha


# ── The physics decomposition + the regression-as-oracle (fit-redesign Phase 1) ──

def test_regression_oracle_dense_domain():
    """§7.1 — THE oracle: on the regression's OWN fitted domain (dense models, full
    offload, CUDA), the physics decomposition must agree with it. The ~19,500
    measurements behind the fitted constants keep working for us as CI instead of as
    runtime code. Band measured 2026-08-13 at 1.016–1.088 (physics consistently a
    few % conservative — the safe direction); pinned at [0.95, 1.15]. Physics
    dropping BELOW 0.95× the fitted truth is the dangerous direction for a floor."""
    dense_cases = [
        (4400, 32, 8, 4096, 4096),
        (6700, 48, 16, 3840, 8192),
        (6700, 48, 16, 3840, 32768),
        (13000, 40, 8, 5120, 8192),
        (24000, 80, 8, 8192, 4096),
        (42000, 80, 64, 8192, 8192),
        (2000, 24, 4, 2048, 16384),
    ]
    for size, layers, kvh, emb, ctx in dense_cases:
        reg = fit.estimate_vram_mb(size_mb=size, n_layers=layers, n_kv_heads=kvh,
                                   embedding_dim=emb, ctx_size=ctx, cache_type=16,
                                   gpu_layers=layers)
        kv = fit.kv_exact_mb(n_layers=layers, n_kv_heads=kvh, ctx_size=ctx,
                             cache_type=16, embedding_dim=emb,
                             head_count=max(1, emb // 128))
        phy = fit.physics_vram_mb(size_mb=size, n_layers=layers, gpu_layers=layers,
                                  moe_share=1.0, kv_mb=kv,
                                  overhead_mb=fit.PHYSICS_OVERHEAD_MB["cuda"])
        assert 0.95 <= phy / reg <= 1.15, (size, layers, kvh, emb, ctx, phy, reg)


def test_physics_gold_check_flagship_config():
    """§7.5 — the 2026-07-24 gold check, physics edition: the real Gemma-4 26B header
    at the incident config (ngl 30 / ncmoe 21 / ctx 32k iSWA-KV 881 MB) measured
    6.5–7.9 GB on the box. The physics booking must land inside that window."""
    share = fit.moe_gpu_size_share(n_layers=30, gpu_layers=30, n_cpu_moe=21,
                                   expert_share=0.9389)
    booked = fit.physics_vram_mb(size_mb=14249, n_layers=30, gpu_layers=30,
                                 moe_share=share, kv_mb=881,
                                 overhead_mb=fit.PHYSICS_OVERHEAD_MB["cuda"])
    assert 6500 <= booked <= 7900, booked


def test_physics_term_behaviors():
    common = dict(size_mb=10000, n_layers=40, moe_share=1.0, kv_mb=400,
                  overhead_mb=fit.PHYSICS_OVERHEAD_MB["cuda"])
    # zero GPU layers → zero (no device context is created)
    assert fit.physics_vram_mb(gpu_layers=0, **common) == 0.0
    # monotone in gpu_layers; full offload = weights + kv + overhead exactly
    half = fit.physics_vram_mb(gpu_layers=20, **common)
    full = fit.physics_vram_mb(gpu_layers=40, **common)
    assert 0 < half < full
    assert full == 10000 + 400 + fit.PHYSICS_OVERHEAD_MB["cuda"]
    # expert stripping shrinks the device share
    stripped = fit.moe_gpu_size_share(n_layers=40, gpu_layers=40, n_cpu_moe=40,
                                      expert_share=0.94)
    assert fit.physics_vram_mb(gpu_layers=40, **{**common, "moe_share": stripped}) < full


def test_kv_exact_uniform_math():
    # 30 layers × 16 kv-heads × (128+128) dims × 4096 tokens × 2 B (f16) = 1006.6 MB
    kv = fit.kv_exact_mb(n_layers=30, n_kv_heads=16, ctx_size=4096, cache_type=16,
                         key_length=128, value_length=128)
    assert abs(kv - 30 * 16 * 256 * 4096 * 2 / 1e6) < 0.01
    # q8_0 cache halves it; missing dims fall back to embedding/head_count
    assert fit.kv_exact_mb(n_layers=30, n_kv_heads=16, ctx_size=4096, cache_type=8,
                           key_length=128, value_length=128) == kv / 2
    fb = fit.kv_exact_mb(n_layers=30, n_kv_heads=16, ctx_size=4096, cache_type=16,
                         embedding_dim=2048, head_count=16)
    assert abs(fb - kv) < 0.01  # 2048/16 = 128 → same dims
    assert fit.kv_exact_mb(n_layers=0, n_kv_heads=16, ctx_size=4096, cache_type=16) == 0.0


def test_estimate_guards_degenerate_negative_slope():
    """Out-of-domain guard (fit-redesign §1.2/§4 0.2): a max-offload MoE strips
    ~94-98% of layer bytes, the fitted −18 MB/layer credit flips the slope negative
    (the real Qwen header: a = −1.24), and the unguarded regression claimed each
    extra GPU layer FREES VRAM. Qwen-shaped inputs: tiny per-layer size, cheap KV."""
    qwen_shaped = _cfg(size_mb=350, n_layers=41, n_kv_heads=2, embedding_dim=2048)
    lo = fit.estimate_vram_mb(gpu_layers=0, **qwen_shaped)
    hi = fit.estimate_vram_mb(gpu_layers=41, **qwen_shaped)
    assert hi >= 0
    assert hi >= lo  # never decreasing in gpu_layers
    # Mirrors max_gpu_layers' degenerate branch: per-layer cost is noise, the
    # estimate is the base offset, independent of gpu_layers.
    assert hi == lo
