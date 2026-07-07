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
    # 35B-A3B is type=moe AND mtp=True → base + moe + the GATED mtp preset:
    # spec_type=draft-mtp + the measured spec_n_max=2 auto-apply (Plan B D3 —
    # auto-on because the model is built-in capable; the user can uncheck).
    sw = switch_resolve.resolve_model_switches("qwen3.6-35b-a3b-mtp")
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


def test_draft_file_alone_fires_the_gate(configured):
    # Gemma-style: the MAIN header has no MTP marker (mtp=False) but a SEPARATE
    # draft file is configured → the draft arm fires INDEPENDENTLY of model.mtp
    # (the panel's T1 fix — `mtp OR draft`, never `mtp AND …`).
    s = db.session()
    s.add(db.ModelCatalog(id="gemma-draft", name="G", type="moe", mtp=False,
                          mtp_draft_file="MTP/g-Q4_0-MTP.gguf"))
    s.commit()
    s.close()
    sw = switch_resolve.resolve_model_switches("gemma-draft")
    assert sw["spec_type"] == "draft-mtp"
    assert sw["spec_n_max"] == "2"
    assert sw["no_mmap"] == "true"          # type=moe layer still applies


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
    s.add(db.ClassTune(model_id="qwen3.6-35b-a3b-mtp", class_key="vram8|ram32",
                       flag_name="n_cpu_moe", flag_value="21", built_in=True))
    s.add(db.ModelTune(model_id="qwen3.6-35b-a3b-mtp", hw_key="k1",
                       flag_name="threads", flag_value="8"))
    s.commit()
    s.close()
    sw, origins = switch_resolve.resolve_model_switches_with_origins(
        "qwen3.6-35b-a3b-mtp", hw_key="k1", class_key="vram8|ram32")
    assert origins["flash_attn"] == "base"
    assert origins["spec_type"] == "mtp"        # the gated auto-MTP layer
    assert origins["n_cpu_moe"] == "class"
    assert origins["threads"] == "tune"
    assert sw["n_cpu_moe"] == "21" and sw["threads"] == "8"
    # the plain resolver stays the values-only view of the same walk
    assert switch_resolve.resolve_model_switches(
        "qwen3.6-35b-a3b-mtp", hw_key="k1", class_key="vram8|ram32") == sw


def test_unknown_model_empty(configured):
    assert switch_resolve.resolve_model_switches("does-not-exist") == {
        "flash_attn": "on", "cache_type_k": "q8_0", "cache_type_v": "q8_0", "mlock": "true",
        # context_shift + cache_reuse REMOVED from the base (user, 2026-07-07): Gemma 4's
        # iSWA supports neither KV shift nor prefix reuse (llama.cpp auto-disables both) and
        # context_shift measured a net loss — per-model knobs now, not a shipped base value.
        # reasoning_budget likewise ABSENT (user, 2026-07-06): a per-taste knob, never base.
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


def test_seed_default_class_tunes_seeds_the_gemma_row(configured):
    s = db.session()
    assert seed.seed_default_class_tunes(s) == 1
    s.commit()
    rows = {r.flag_name: r.flag_value for r in s.query(db.ClassTune).filter(
        db.ClassTune.model_id == "gemma-4-26b-a4b-qat", db.ClassTune.class_key == "vram8|ram32").all()}
    s.close()
    assert rows["n_cpu_moe"] == "21"          # the tested floor (20 OOMs), not the sweep's 23
    assert rows["ctx_len"] == "32768"
    assert rows["batch_size"] == "512"
    assert rows["reasoning_budget"] == "1024"
    assert "context_shift" not in rows and "cache_reuse" not in rows   # Gemma iSWA: never
    # idempotent (merge-by-(model, class)) — a re-seed adds nothing
    s = db.session()
    assert seed.seed_default_class_tunes(s) == 0
    s.close()


def test_class_key_bands_to_gb():
    from llm_runner.runner.hardware import class_key

    class _G:
        def __init__(self, vram_mb): self.vram_mb = vram_mb

    class _H:
        def __init__(self, ram_mb, gpus): self.ram_mb, self.gpus = ram_mb, gpus

    # 2070 SUPER reports ~8188 MB (just under 8 GB) → the 8 GB class; RAM rounds to GB.
    assert class_key(_H(32768, [_G(8188)])) == "vram8|ram32"
    assert class_key(_H(32768, [_G(8192)])) == "vram8|ram32"
    assert class_key(_H(16384, [])) == "cpu|ram16"          # no GPU
