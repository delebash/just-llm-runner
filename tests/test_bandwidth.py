# SPDX-License-Identifier: MIT
"""The Phase 3 bandwidth ladder (runner/bandwidth.py) — device arithmetic, the
RAM probe, and the §13.8 derivation rule (config-known, un-sped, pool-matched;
flagless rows NEVER qualify)."""

from llm_runner.runner import bandwidth


def test_nvidia_bw_arithmetic(monkeypatch):
    # 2070 SUPER registers: 256-bit bus × 7001 MHz × 2 (DDR) ÷ 8 = 448.06 GB/s —
    # matching the vendor spec sheet; two cards → the larger wins.
    monkeypatch.setattr(bandwidth, "_nvidia_query", lambda fields: "256, 7001\n128, 6001\n")
    assert abs(bandwidth.nvidia_mem_bw_gbps() - 448.064) < 0.1
    monkeypatch.setattr(bandwidth, "_nvidia_query", lambda fields: None)
    assert bandwidth.nvidia_mem_bw_gbps() is None
    monkeypatch.setattr(bandwidth, "_nvidia_query", lambda fields: "[N/A], [N/A]\n")
    assert bandwidth.nvidia_mem_bw_gbps() is None


def test_ram_probe_returns_a_plausible_number():
    # A tiny probe (16 MB) keeps the test fast; any real machine streams RAM at
    # whole GB/s — the point is "a positive, sane number", not a benchmark.
    gbps = bandwidth.probe_ram_copy_gbps(size_mb=16, repeats=2)
    assert gbps is not None and 0.5 < gbps < 2000


_MK = "gpu|8192|16c|32g"


def _facts(model_id="dense-a", *, dense=True):
    if dense:
        # KV scalars sized so KV(4096) ≈ 201 MB — the 12B's iSWA-windowed shape
        # (the raw uniform projection would be ~1.6 GB and is not this model).
        return {model_id: {"n_layers": 48, "mtp": False, "size_mb": 6716.0,
                           "non_expert_mb": 6716.0, "active_expert_mb": 0.0,
                           "kv_facts": {"kv_global_bytes_per_token": 24576.0,
                                        "kv_windowed_bytes_per_token": 0.0,
                                        "block_count": 48}}}
    return {model_id: {"n_layers": 30, "mtp": False, "size_mb": 14249.0,
                       "non_expert_mb": 871.0, "active_expert_mb": 836.0,
                       "kv_facts": {"kv_global_bytes_per_token": 8192.0,
                                    "kv_windowed_bytes_per_token": 0.0,
                                    "block_count": 30}}}


def _row(model_id="dense-a", tok_s=39.1, switches=None, machine=_MK, backend="cuda"):
    return {"model_id": model_id, "machine_key": machine, "backend": backend,
            "tokens_per_sec": tok_s,
            "switches": switches if switches is not None
            else {"n-gpu-layers": "48", "ctx-size": "4096"}}


def test_device_derivation_from_a_full_offload_dense_row():
    # tok/s × bytes/pass: the whole file + KV(ctx from the recorded switches).
    got = bandwidth.derive_device_bw_gbps([_row()], _facts(), machine_key=_MK, backend="cuda")
    assert got is not None and 250 <= got <= 290  # 39.1 × ~6.9 GB ≈ 270 — the §5.5 shape


def test_derivation_rule_exclusions():
    facts = _facts()
    kw = dict(machine_key=_MK, backend="cuda")
    # Flagless rows NEVER qualify (§13.14 — placement unknown).
    assert bandwidth.derive_device_bw_gbps([_row(switches={})], facts, **kw) is None
    # No recorded ctx → the KV term is unknown → config-unknown → excluded.
    assert bandwidth.derive_device_bw_gbps(
        [_row(switches={"n-gpu-layers": "48"})], facts, **kw) is None
    # Speculative rows are excluded outright (acceptance is not the multiplier).
    assert bandwidth.derive_device_bw_gbps(
        [_row(switches={"n-gpu-layers": "48", "ctx-size": "4096", "model-draft": "d.gguf"})],
        facts, **kw) is None
    # An MTP model's rows are excluded (built-in heads may arm outside switches).
    mtp_facts = _facts()
    mtp_facts["dense-a"]["mtp"] = True
    assert bandwidth.derive_device_bw_gbps([_row()], mtp_facts, **kw) is None
    # Another machine / another backend / a legacy ""-backend row: not this pool.
    assert bandwidth.derive_device_bw_gbps([_row(machine="other|1|2c|4g")], facts, **kw) is None
    assert bandwidth.derive_device_bw_gbps([_row(backend="vulkan")], facts, **kw) is None
    assert bandwidth.derive_device_bw_gbps([_row(backend="")], facts, **kw) is None
    # Partial offload (ngl < layers) is not the clean full-device shape.
    assert bandwidth.derive_device_bw_gbps(
        [_row(switches={"n-gpu-layers": "20", "ctx-size": "4096"})], facts, **kw) is None


def test_host_derivation_prices_the_device_leg_and_solves_the_rest():
    # 26B all-experts-in-RAM at 8.6 tok/s: device leg 871+KV(16k)≈1416 MB at
    # 268.8 → the remaining time is the 836 MB expert gather → ~7.5 GB/s.
    facts = _facts("moe-a", dense=False)
    row = _row("moe-a", tok_s=8.6,
               switches={"n-gpu-layers": "30", "n-cpu-moe": "30", "ctx-size": "16384"})
    got = bandwidth.derive_host_bw_gbps([row], facts, machine_key=_MK, backend="cuda",
                                        device_eff_gbps=268.8)
    assert got is not None and 5 <= got <= 11
    # No device estimate → unsolvable → None (never a guess).
    assert bandwidth.derive_host_bw_gbps([row], facts, machine_key=_MK, backend="cuda",
                                         device_eff_gbps=None) is None


def test_resolve_ladder_order_and_families(monkeypatch):
    # No measurements: device falls to nvidia-reported × the device family;
    # host falls to the probe × the host family.
    monkeypatch.setattr(bandwidth, "nvidia_mem_bw_gbps", lambda: 448.0)
    dev, host = bandwidth.resolve_effective_bw(
        rows=[], facts_by_id={}, machine_key=_MK, backend="cuda", is_macos=False,
        class_vram_bw_gbps=224.0, class_ram_bw_gbps=51.2, probe_gbps=40.0,
        eff_device=0.6, eff_host=0.15)
    assert abs(dev - 448.0 * 0.6) < 0.01
    assert abs(host - 40.0 * 0.15) < 0.01
    # Device unreported (AMD box): the class seed carries source 3; no probe →
    # the class RAM seed. A source-1 row outranks everything and is ALREADY
    # effective (no factor).
    monkeypatch.setattr(bandwidth, "nvidia_mem_bw_gbps", lambda: None)
    dev, host = bandwidth.resolve_effective_bw(
        rows=[_row()], facts_by_id=_facts(), machine_key=_MK, backend="cuda",
        is_macos=False, class_vram_bw_gbps=224.0, class_ram_bw_gbps=51.2,
        probe_gbps=None, eff_device=0.6, eff_host=0.15)
    assert 250 <= dev <= 290          # measured-derived, factor-free
    assert abs(host - 51.2 * 0.15) < 0.01
    # Nothing anywhere → (None, None): the badge shows no band, never a guess.
    dev, host = bandwidth.resolve_effective_bw(
        rows=[], facts_by_id={}, machine_key=_MK, backend="vulkan", is_macos=False,
        class_vram_bw_gbps=0.0, class_ram_bw_gbps=0.0, probe_gbps=None,
        eff_device=0.6, eff_host=0.15)
    assert dev is None and host is None


def test_apple_chip_table_matches_longest_name_first():
    # Pure table check (no Mac needed): "M1 Ultra" must not read as "M1".
    table = dict(bandwidth._APPLE_CHIP_BW_GBPS)
    assert table["M1 Ultra"] == 800.0 and table["M1"] == 68.25
    names = [n for n, _ in bandwidth._APPLE_CHIP_BW_GBPS]
    assert names.index("M1 Ultra") < names.index("M1")
    assert names.index("M4 Max") < names.index("M4")
