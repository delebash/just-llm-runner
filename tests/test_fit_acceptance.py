# SPDX-License-Identifier: MIT
"""The §7.2 five-row measured gate (fit-redesign, Phase 6) — the computed
placement must reproduce the MEASURED class-tune rows (§1.9), within the
plan's tolerance. Before the joint solve this failed by design: the fitted
inverse computed ngl 8-9 on models every measured tune runs at ngl=all.

The metas carry the REAL seeded physics facts (JW seed_presets.py, harvested
from the live GGUF headers by the Phase 2 refresh; the 26B numbers match the
2026-08-13 probe: share 0.9389, 30 layers, window 1024), and KV comes through
the same §13.11 scalar formula the app computes with — so a drifted constant
fails HERE, not on a user's box. Rows are checked at the tune's own ctx
(32768) — a tune's explicit context always overrides, and the measured knob
values were measured AT it. The gryphe row (spec_type A/B verdict) and the
fa/ub rows are excluded per §1.9: unreproducible by fit."""

from llm_runner.runner import fit
from llm_runner.runner.process import Overrides, compute_fit
from llm_runner.runner.schema import GpuInfo, HardwareInfo


class _FactsMeta:
    """A meta whose KV rides the seeded §13.11 scalars (iSWA-honest)."""

    def __init__(self, *, block_count, embedding_length, n_kv_heads, head_count,
                 kv_windowed, kv_global, sliding_window, context_length,
                 expert_count=0, expert_share=0.0):
        self.architecture = "gemma4moe" if expert_count else "gemma4"
        self.block_count = block_count
        self.embedding_length = embedding_length
        self.n_kv_heads = n_kv_heads
        self.head_count = head_count
        self.context_length = context_length
        self.expert_count = expert_count
        self._share = expert_share
        self._facts = {
            "kv_windowed_bytes_per_token": kv_windowed,
            "kv_global_bytes_per_token": kv_global,
            "sliding_window": sliding_window,
        }

    @property
    def is_moe(self):
        return self.expert_count > 0

    def expert_byte_share(self):
        return self._share

    def kv_mb_at_ctx(self, ctx, cache_bits):
        return fit.kv_mb_from_facts(self._facts, ctx, cache_bits)


# The seeded facts, verbatim (seed == detection — Phase 2's refresh ran live).
_26B = dict(block_count=30, embedding_length=2816, n_kv_heads=16, head_count=16,
            kv_windowed=102400.0, kv_global=10240.0, sliding_window=1024,
            context_length=131072, expert_count=128, expert_share=0.9388753056)
_26B_BYTES = 14_249_047_104
_12B = dict(block_count=48, embedding_length=3840, n_kv_heads=16, head_count=16,
            kv_windowed=163840.0, kv_global=8192.0, sliding_window=1024,
            context_length=131072)
_12B_BYTES = 6_716_356_800
_E4B = dict(block_count=42, embedding_length=2560, n_kv_heads=2, head_count=8,
            kv_windowed=35840.0, kv_global=14336.0, sliding_window=512,
            context_length=131072)
_E4B_BYTES = 4_215_695_776
# The external Gemma MTP draft (251,937,728 B on disk); its KV dims are small —
# the [21,23] band below tolerates the whole plausible range of draft-KV sizes.
_DRAFT_BYTES = 251_937_728


class _DraftMeta:
    architecture = "gemma4"
    block_count = 4
    embedding_length = 1152
    n_kv_heads = 4
    is_moe = False


def _dgpu(vram_mb, ram_mb):
    return HardwareInfo(
        os="Windows", platform="windows", cpu_cores=16, ram_mb=ram_mb,
        gpus=[GpuInfo(vendor="NVIDIA", name="dgpu", vram_mb=vram_mb)],
        runtimes={"cuda": True},
    )


def _igpu(ram_mb):
    return HardwareInfo(
        os="Windows", platform="windows", cpu_cores=16, ram_mb=ram_mb,
        gpus=[GpuInfo(vendor="Intel", name="Intel(R) Graphics", vram_mb=128)],
        runtimes={},
    )


def test_26b_on_vram8_ram32_reproduces_the_measured_ncmoe():
    # THE row (measured on the author's 2070S): ngl 99 / ncmoe 21 / ctx 32768,
    # MTP draft on. 20 OOMs on that box, the sweep said 23 — so the computed
    # ncmoe must land in [21, 23]: never below the OOM line, never lazier than
    # the sweep's safe end. ngl = all layers (the joint solve pins it).
    plan = compute_fit(
        _FactsMeta(**_26B), _26B_BYTES, _dgpu(8192, 32768),
        Overrides(ctx_len=32768),
        draft_meta=_DraftMeta(), draft_bytes=_DRAFT_BYTES,
    )
    assert plan.n_gpu_layers == 30
    assert 21 <= plan.n_cpu_moe <= 23
    assert plan.ctx_len == 32768


def test_26b_on_igpu_mem32_keeps_experts_in_the_pool():
    # igpu-mem32's measured truth (Core Ultra 7 ncmoe sweep): offload on one
    # pool is pure loss — ncmoe 0, all layers on the device.
    plan = compute_fit(
        _FactsMeta(**_26B), _26B_BYTES, _igpu(32768), Overrides(ctx_len=32768))
    assert plan.n_gpu_layers == 30
    assert plan.n_cpu_moe == 0


def test_12b_fully_offloads_where_physics_says_it_fits():
    # The 12B tune rows pin ngl 99 on the vram12 classes; the physics agrees —
    # 6716 MB weights + 436 MB iSWA-KV(32k, q8) + the cuda overhead fit a
    # 12 GB card with the default margin. (The old fitted inverse said 37: its
    # uniform KV projection prices this iSWA model's KV ~9× over.)
    plan = compute_fit(
        _FactsMeta(**_12B), _12B_BYTES, _dgpu(12288, 16384), Overrides(ctx_len=32768))
    assert plan.n_gpu_layers == 48
    assert plan.n_cpu_moe == 0


def test_12b_on_vram8_stays_partial_and_that_is_honest():
    # The vram8 row's "ngl 99 · 39.1 tok/s" was llama-bench — which has NO -c
    # flag (§13.13), so its tiny bench KV is not this server config. At the
    # tune's ctx 32768 the card cannot hold all 48 layers (weights + KV +
    # overhead ≈ 8.7 GB > the margined 7.2 GB budget): the computed plan stays
    # partial, and the b9644 engine's own placement remains the final word.
    plan = compute_fit(
        _FactsMeta(**_12B), _12B_BYTES, _dgpu(8192, 16384), Overrides(ctx_len=32768))
    assert 0 < plan.n_gpu_layers < 48


def test_e4b_on_igpu_mem16_fully_offloads():
    # E4B @ igpu-mem16 (Iris Xe): ngl 99 measured at 9.8 tok/s — the pool
    # holds the whole 4.2 GB file with room to spare.
    plan = compute_fit(
        _FactsMeta(**_E4B), _E4B_BYTES, _igpu(16384), Overrides(ctx_len=32768))
    assert plan.n_gpu_layers == 42
    assert plan.n_cpu_moe == 0
