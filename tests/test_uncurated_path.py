# SPDX-License-Identifier: MIT
"""§7.3 — the uncurated-path acceptance test (fit-redesign, Phase 7).

A FRESH DB with NO seed rows, a MoE hand-added BY LINK (the HF header read
faked with a byte-faithful Gemma-4-26B-class iSWA header), on a simulated
8 GB-VRAM / 32 GB-RAM box: the badge, the floors, the ctx and the split must
come out sane with nobody having curated anything. This is the path where
every defect in the plan's evidence index lived — the MoE-blind floor lie
("Won't fit" on a model the box runs, §1.4), the hand-typed floors, the
ctx handout, the inverse split — because the SEEDED rows had hand-fitted
numbers papering over all of it. The launchable half of the §7.3 pin (a
"no"-badged model still loads) lives in test_lifecycle.py, where the
service harness is."""

import pytest
import sqlalchemy as sa
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from llm_runner.llm import db, identity, stores
from llm_runner.llm.model_catalog_api import CatalogRow
from llm_runner.runner import fit
from llm_runner.runner.gguf import GgufMeta
from llm_runner.runner.process import compute_fit
from llm_runner.runner.schema import GpuInfo, HardwareInfo

# A Gemma-4-26B-class MoE header, byte-faithful where it matters: the 5:1
# windowed:global iSWA pattern with per-layer KV heads reproduces the real
# file's KV scalars (windowed 102400 B/token, global 10240 — the seeded
# facts), and the expert dims give expert_byte_share ≈ 0.92 (real: 0.9389).
_META = GgufMeta(
    architecture="gemma4moe", block_count=30, embedding_length=2816,
    expert_count=128, expert_used_count=8, head_count=16,
    context_length=131072,
    expert_feed_forward_length=1024, feed_forward_length=8192,
    head_count_kv_per_layer=[16 if i % 6 != 5 else 8 for i in range(30)],
    sliding_window=1024,
    sliding_window_pattern=[i % 6 != 5 for i in range(30)],
    key_length=128, value_length=128, key_length_swa=128, value_length_swa=128,
    size_label="128x2.6B",
)
_BYTES = 14_249_047_104


@pytest.fixture
def fresh_db():
    eng = sa.create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    db.create_all(eng)
    db.configure_storage(sessionmaker(bind=eng, autoflush=False))
    yield


def _box_8_32():
    return HardwareInfo(
        os="Windows", platform="windows", cpu_cores=16, ram_mb=32768,
        gpus=[GpuInfo(vendor="NVIDIA", name="dgpu", vram_mb=8192)],
        runtimes={"cuda": True},
    )


def test_hand_added_moe_by_link_is_sane_on_8_32(fresh_db, monkeypatch):
    from llm_runner.runner import gguf_remote, models

    monkeypatch.setattr(gguf_remote, "fetch_gguf_meta",
                        lambda repo, quant, revision="main": (_META, _BYTES))
    # The tier-C drafter probe is advisory network discovery — not this test.
    monkeypatch.setattr(models, "find_inherited_mtp_drafter", lambda *a, **k: None)

    # 1) READ FROM LINK — the Add form's pre-download inspect.
    out = identity.inspect_model_from_link("someone/Big-MoE-GGUF", "UD-Q4_K_XL")
    assert out["type"] == "moe" and out["experts"] == 128
    assert out["sizeBytes"] == _BYTES
    facts = out["physicsFacts"]
    assert facts["block_count"] == 30
    assert facts["kv_windowed_bytes_per_token"] == 102400.0  # the real file's scalar
    assert facts["kv_global_bytes_per_token"] == 10240.0
    assert 0.85 < facts["expert_byte_share"] < 0.99

    # 2) SAVE — the form PUT's door (a chat row types NO floors, §13.17: the
    #    user never enters one; every number below is computed, not curated).
    stores.get_model_catalog_store().upsert(CatalogRow(
        id="hand-added-moe", name="Hand-added MoE", hfRepo="someone/Big-MoE-GGUF",
        quant="UD-Q4_K_XL", type=out["type"], trainedCtx=out["trainedCtx"],
        experts=out["experts"], sizeLabel=out["sizeLabel"],
        totalParams=out["totalParams"], sizeBytes=out["sizeBytes"],
        estVramMb=out["estVramMb"], physicsFacts=facts,
    ))

    # 3) THE WIRE ROW — floors + est computed FRESH from the stored facts.
    row = next(r for r in stores.get_model_catalog_store().list()
               if r.id == "hand-added-moe")
    assert row.minRamMb == round(_BYTES / 1e6 + 4096)         # file + headroom
    assert 1500 < row.minVramMb < 6000    # max-offload floor: non-expert + KV(4k) + overhead
    assert 12000 < row.estVramMb < 20000  # full-residency want at 8k ctx
    assert row.minVramMb < row.estVramMb

    # 4) THE BADGE on the 8/32 box — runnable, never the MoE-blind "no".
    badge = fit.coarse_fit(
        total_params=row.totalParams or None, quant=row.quant,
        vram_mb=8192, ram_mb=32768, margin_mb=1024,
        min_vram_override=row.minVramMb, min_ram_override=row.minRamMb,
    )
    assert badge in ("ok", "tight")
    # The §1.4 lie this test exists to catch, kept visible: without the computed
    # floor the params×quant estimate charges the WHOLE 26B to VRAM → "no".
    assert fit.coarse_fit(
        total_params="26B", quant=row.quant, vram_mb=8192, ram_mb=32768,
        margin_mb=1024, min_vram_override=None, min_ram_override=row.minRamMb,
    ) == "no"

    # 5) THE SPLIT — untuned compute_fit on the same box: all layers on the GPU
    #    with just-enough experts in RAM (the joint solve), ctx a ladder value
    #    under the cap, the booking inside the card.
    plan = compute_fit(_META, _BYTES, _box_8_32())
    assert plan.n_gpu_layers == 30
    assert 15 <= plan.n_cpu_moe <= 30
    assert 4096 <= plan.ctx_len <= 32768
    assert 0 < plan.vram_mb <= 8192
