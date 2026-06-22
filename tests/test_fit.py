# SPDX-License-Identifier: GPL-3.0-or-later
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


def test_gqa_reduces_kv_cost():
    # More KV heads (MHA) ⇒ more VRAM/layer ⇒ no more layers fit than GQA.
    mha = fit.max_gpu_layers(vram_budget_mb=4000, **_cfg(n_kv_heads=32))
    gqa = fit.max_gpu_layers(vram_budget_mb=4000, **_cfg(n_kv_heads=8))
    assert gqa >= mha
