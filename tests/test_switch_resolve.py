# SPDX-License-Identifier: GPL-3.0-or-later
"""Layered switch resolver (design §6 + Plan B 2026-07-05) — the model-level merge:
base → type (moe|dense) → GATED auto-mtp → per-hardware → per-(model, machine)
tune (`model_tunes`, always wins). The auto-mtp layer is the 2026-07-05 USER
decision reversing Phase 3's "never auto-enabled": auto-on for a CAPABLE model
(built-in MTP or a configured external draft), user-off persisted in the tune
layer. Pure data/logic; no GPU needed."""

import sqlalchemy as sa
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
import pytest

from llm_runner.llm import db, seed, switch_resolve


@pytest.fixture
def configured():
    eng = sa.create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    db.create_all(eng)
    db.configure_storage(sessionmaker(bind=eng, autoflush=False))
    s = db.session()
    seed.seed_default_switch_presets(s)
    seed.seed_default_catalog(s)
    s.commit()
    s.close()
    yield


def test_mtp_model_auto_enables_draft_mtp(configured):
    # GLM-4.5-Air is type=moe AND mtp=True → base + moe + the GATED mtp preset:
    # spec_type=draft-mtp + the measured spec_n_max=2 auto-apply (Plan B D3 —
    # auto-on because the model is built-in capable; the user can uncheck).
    # (Exhibit was the 35B-A3B until the 2026-07-25 catalog trim removed it.)
    sw = switch_resolve.resolve_model_switches("glm-4.5-air")
    assert sw["spec_type"] == "draft-mtp"
    assert sw["spec_n_max"] == "2"         # the user-measured seed (≠ knob default 3)
    assert sw["no_mmap"] == "true"         # the one genuinely MoE-specific flag
    assert sw["flash_attn"] == "on"
    assert sw["cache_type_k"] == "q8_0"


def test_non_mtp_model_gets_no_spec_flags(configured):
    # 8B dense, mtp=False, no draft file → the mtp preset does NOT apply.
    sw = switch_resolve.resolve_model_switches("qwen3-8b-q4_k_m")
    assert "spec_type" not in sw
    assert "spec_n_max" not in sw
    assert sw["flash_attn"] == "on"
    assert sw["mlock"] == "true"


def test_mtp_enable_flag_governs_regardless_of_draft(configured):
    # 2026-07-13 split: `mtp` is now the ENABLE flag; unchecking it disables the mtp
    # preset EVEN with a draft file still configured (the old `mtp OR draft` gate made
    # uncheck a no-op). A Gemma model enables MTP by setting mtp=True (its external
    # draft is the mechanism, not the gate); mtp=False means "off" whatever the draft.
    s = db.session()
    s.add(db.ModelCatalog(id="gemma-on", name="G", type="moe", mtp=True,
                          mtp_builtin=False, mtp_draft_file="MTP/g-Q4_0-MTP.gguf"))
    s.add(db.ModelCatalog(id="gemma-off", name="G", type="moe", mtp=False,
                          mtp_builtin=False, mtp_draft_file="MTP/g-Q4_0-MTP.gguf"))
    s.commit()
    s.close()
    on = switch_resolve.resolve_model_switches("gemma-on")
    assert on["spec_type"] == "draft-mtp"
    assert on["spec_n_max"] == "2"
    assert on["no_mmap"] == "true"          # type=moe layer still applies
    off = switch_resolve.resolve_model_switches("gemma-off")
    assert "spec_type" not in off           # uncheck wins even though a draft is set
    assert off["no_mmap"] == "true"         # type=moe layer unaffected


def test_model_tune_wins_over_every_layer(configured):
    # The per-(model, machine) MEASURED tune is LAST: it beats every bundle layer
    # for ITS model on ITS machine — including the MTP opt-OUT (uncheck →
    # spec_type=none persisted in the tune). (The old per-machine hardware layer
    # was RETIRED 2026-07-07 — no writer/UI ever existed.)
    s = db.session()
    s.add(db.ModelTune(model_id="qwen3.6-35b-a3b-mtp", hw_key="k1",
                       flag_name="threads", flag_value="8"))
    s.add(db.ModelTune(model_id="qwen3.6-35b-a3b-mtp", hw_key="k1",
                       flag_name="spec_type", flag_value="none"))
    s.add(db.ModelTune(model_id="qwen3.6-35b-a3b-mtp", hw_key="k1",
                       flag_name="n_cpu_moe", flag_value="37"))
    s.commit()
    s.close()
    sw = switch_resolve.resolve_model_switches("qwen3.6-35b-a3b-mtp", hw_key="k1")
    assert sw["threads"] == "8"             # the tune's own value lands
    assert sw["spec_type"] == "none"        # the user's opt-out beats auto-mtp
    assert sw["n_cpu_moe"] == "37"          # the measured allocation rides along


def test_tune_is_scoped_to_its_model_and_machine(configured):
    # A tune for (model A, machine k1) leaks to NEITHER another model on k1 NOR
    # the same model on another machine — the composite key is the point of B.
    s = db.session()
    s.add(db.ModelTune(model_id="qwen3.6-35b-a3b-mtp", hw_key="k1",
                       flag_name="batch_size", flag_value="64"))
    s.commit()
    s.close()
    assert "batch_size" not in switch_resolve.resolve_model_switches("qwen3-8b-q4_k_m", hw_key="k1")
    assert "batch_size" not in switch_resolve.resolve_model_switches("qwen3.6-35b-a3b-mtp", hw_key="k2")
    assert switch_resolve.resolve_model_switches("qwen3.6-35b-a3b-mtp", hw_key="k1")["batch_size"] == "64"


def test_origins_track_the_writing_layer(configured):
    # Provenance (2026-07-07): the with-origins resolver reports WHICH layer last
    # wrote each key — base for the bundle rows, class for a class-tune row, tune
    # for the machine's own saved value (later layers overwrite earlier origins).
    s = db.session()
    s.add(db.ClassTune(model_id="glm-4.5-air", class_key="vram8|ram32",
                       flag_name="n_cpu_moe", flag_value="21", built_in=True))
    s.add(db.ModelTune(model_id="glm-4.5-air", hw_key="k1",
                       flag_name="threads", flag_value="8"))
    s.commit()
    s.close()
    sw, origins = switch_resolve.resolve_model_switches_with_origins(
        "glm-4.5-air", hw_key="k1", class_key="vram8|ram32")
    assert origins["flash_attn"] == "base"
    assert origins["spec_type"] == "mtp"        # the gated auto-MTP layer
    assert origins["n_cpu_moe"] == "class"
    assert origins["threads"] == "tune"
    assert sw["n_cpu_moe"] == "21" and sw["threads"] == "8"
    # the plain resolver stays the values-only view of the same walk
    assert switch_resolve.resolve_model_switches(
        "glm-4.5-air", hw_key="k1", class_key="vram8|ram32") == sw


def test_unknown_model_empty(configured):
    assert switch_resolve.resolve_model_switches("does-not-exist") == {
        "flash_attn": "on", "cache_type_k": "q8_0", "cache_type_v": "q8_0", "mlock": "true",
        # reasoning_budget=1024 RESTORED to the base bundle (2026-07-16, house-layering
        # rewrite): it is the visible GLOBAL tier of the per-request thinking budget, read
        # via switch_resolve at request time — NOT a launch flag (emission retired U2-T4).
        "reasoning_budget": "1024",
        # context_shift + cache_reuse REMOVED from the base (user, 2026-07-07): Gemma 4's
        # iSWA supports neither KV shift nor prefix reuse (llama.cpp auto-disables both) and
        # context_shift measured a net loss — per-model knobs now, not a shipped base value.
    }  # unknown model → treated as dense, base preset only (no mtp gate w/o a row)


def test_class_tune_applies_on_matching_class(configured):
    # The seeded/editable per-(model, hardware-CLASS) layer (2026-07-07): a config
    # portable across boxes of the same class. Applies only when the box's class_key
    # matches, and to its own model.
    s = db.session()
    s.add(db.ClassTune(model_id="qwen3.6-35b-a3b-mtp", class_key="vram8|ram32",
                       flag_name="n_cpu_moe", flag_value="21"))
    s.add(db.ClassTune(model_id="qwen3.6-35b-a3b-mtp", class_key="vram8|ram32",
                       flag_name="ctx_len", flag_value="32768"))
    s.commit()
    s.close()
    sw = switch_resolve.resolve_model_switches("qwen3.6-35b-a3b-mtp", class_key="vram8|ram32")
    assert sw["n_cpu_moe"] == "21"
    assert sw["ctx_len"] == "32768"
    assert sw["flash_attn"] == "on"          # base still layers underneath
    # a DIFFERENT class doesn't get it; no class_key passed → not applied
    assert "n_cpu_moe" not in switch_resolve.resolve_model_switches("qwen3.6-35b-a3b-mtp", class_key="vram24|ram64")
    assert "n_cpu_moe" not in switch_resolve.resolve_model_switches("qwen3.6-35b-a3b-mtp")


def test_model_tune_overrides_class_tune(configured):
    # A machine's OWN measured tune is MORE SPECIFIC than the class default → it wins
    # (the class-seed is the start; a box that ran its own sweep keeps its value).
    s = db.session()
    s.add(db.ClassTune(model_id="qwen3.6-35b-a3b-mtp", class_key="vram8|ram32",
                       flag_name="n_cpu_moe", flag_value="21"))
    s.add(db.ModelTune(model_id="qwen3.6-35b-a3b-mtp", hw_key="k1",
                       flag_name="n_cpu_moe", flag_value="23"))
    s.commit()
    s.close()
    sw = switch_resolve.resolve_model_switches("qwen3.6-35b-a3b-mtp", hw_key="k1", class_key="vram8|ram32")
    assert sw["n_cpu_moe"] == "23"


def test_seed_default_class_tunes_seeds_the_gemma_rows(configured):
    s = db.session()
    assert seed.seed_default_class_tunes(s) == 13   # 4 pre-band + 9 dGPU band recs (incl. the measured vram8|ram16)
    s.commit()
    dgpu = {r.flag_name: r.flag_value for r in s.query(db.ClassTune).filter(
        db.ClassTune.model_id == "gemma-4-26b-a4b-qat", db.ClassTune.class_key == "dgpu-vram8|ram32").all()}
    igpu = {r.flag_name: r.flag_value for r in s.query(db.ClassTune).filter(
        db.ClassTune.model_id == "gemma-4-26b-a4b-qat", db.ClassTune.class_key == "igpu-mem32").all()}
    s.close()
    assert dgpu["n_cpu_moe"] == "21"          # the tested floor (20 OOMs), not the sweep's 23
    assert dgpu["ctx_len"] == "32768"
    assert dgpu["batch_size"] == "512"
    assert dgpu["reasoning_budget"] == "1024"
    assert "context_shift" not in dgpu and "cache_reuse" not in dgpu   # Gemma iSWA: never
    # The integrated-GPU class (kit matrix): UMA one pool -> no expert offload, and
    # flash-attn OFF (it hurts this iGPU; overrides the base bundle's "on", right only for CUDA).
    assert igpu["n_gpu_layers"] == "99"
    assert igpu["n_cpu_moe"] == "0"
    assert igpu["flash_attn"] == "off"
    assert igpu["ubatch_size"] == "512"
    assert "threads" not in igpu             # machine-specific — derived per box, not class-baked
    # idempotent (merge-by-(model, class)) — a re-seed adds nothing
    s = db.session()
    assert seed.seed_default_class_tunes(s) == 0
    s.close()


def test_class_key_bands_to_gb():
    from llm_runner.runner.hardware import class_key

    class _G:
        def __init__(self, vram_mb, name="GPU"): self.vram_mb, self.name = vram_mb, name

    class _H:
        def __init__(self, ram_mb, gpus, platform="linux", runtimes=None):
            self.ram_mb, self.gpus = ram_mb, gpus
            self.platform, self.runtimes = platform, runtimes or {}

    cuda = {"cuda": True}
    # 2070 SUPER reports ~8188 MB (just under 8 GB) → the 8 GB DISCRETE class; RAM rounds to GB.
    assert class_key(_H(32768, [_G(8188)], runtimes=cuda)) == "dgpu-vram8|ram32"
    assert class_key(_H(32768, [_G(8192)], runtimes=cuda)) == "dgpu-vram8|ram32"
    # no GPU → the integrated one-pool fallback (keyed on the single memory number).
    assert class_key(_H(16384, [])) == "igpu-mem16"
    # macOS → unified one-pool (Apple Silicon); fixes the old Mac-as-CPU mis-key.
    assert class_key(_H(196608, [], platform="macos")) == "unified-mem192"


# ── Pass 2 (2026-07-22): backend-stamped tunes ────────────────────────────────


def test_tune_row_applies_matrix():
    # "" row = legacy (cuda-era) → cuda-only; no active context → everything applies.
    f = switch_resolve.tune_row_applies
    assert f("", "cuda") is True
    assert f("", "vulkan") is False
    assert f("vulkan", "vulkan") is True
    assert f("vulkan", "cuda") is False
    assert f("cuda", "") is True          # unknown/unwired context → legacy behavior
    assert f("", "") is True


def test_backend_stamp_and_filter_roundtrip(configured):
    # A tune saved under cuda is stamped, applies under cuda, and is REFUSED (resolve,
    # display) under a different family — the qwen ctx-131072 incident's product fix.
    from llm_runner.llm.model_tunes_api import ModelTuneFlag
    from llm_runner.llm.stores import get_model_tune_store

    store = get_model_tune_store()
    mid, hw = "qwen3.6-35b-a3b-mtp", "BOX|8192|8c|32g"
    try:
        switch_resolve.set_active_backend_fn(lambda: "cuda")
        store.replace(mid, hw, [ModelTuneFlag(flagName="ctx_len", flagValue="131072")])
        s = db.session()
        row = s.query(db.ModelTune).filter(db.ModelTune.model_id == mid).one()
        assert row.backend == "cuda"
        s.close()
        merged, origins = switch_resolve.resolve_model_switches_with_origins(mid, hw_key=hw)
        assert merged["ctx_len"] == "131072" and origins["ctx_len"] == "tune"
        assert [r.flagName for r in store.get(mid, hw)] == ["ctx_len"]

        switch_resolve.set_active_backend_fn(lambda: "cpu")
        merged, origins = switch_resolve.resolve_model_switches_with_origins(mid, hw_key=hw)
        assert "ctx_len" not in merged                # the cuda tune does NOT follow
        assert store.get(mid, hw) == []               # nor display as applied

        switch_resolve.set_active_backend_fn(None)    # unwired → legacy behavior
        merged, _ = switch_resolve.resolve_model_switches_with_origins(mid, hw_key=hw)
        assert merged["ctx_len"] == "131072"
    finally:
        switch_resolve.set_active_backend_fn(None)


def test_legacy_unstamped_tune_reads_as_cuda(configured):
    # A pre-Pass-2 row (backend "") applies under cuda, not under vulkan.
    s = db.session()
    s.add(db.ModelTune(model_id="qwen3.6-35b-a3b-mtp", hw_key="H", flag_name="threads",
                       flag_value="8"))
    s.commit()
    s.close()
    try:
        switch_resolve.set_active_backend_fn(lambda: "cuda")
        merged, _ = switch_resolve.resolve_model_switches_with_origins(
            "qwen3.6-35b-a3b-mtp", hw_key="H")
        assert merged["threads"] == "8"
        switch_resolve.set_active_backend_fn(lambda: "vulkan")
        merged, _ = switch_resolve.resolve_model_switches_with_origins(
            "qwen3.6-35b-a3b-mtp", hw_key="H")
        assert "threads" not in merged
    finally:
        switch_resolve.set_active_backend_fn(None)
