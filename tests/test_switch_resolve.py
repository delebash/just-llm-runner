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
    # The per-(model, machine) MEASURED tune is LAST: it beats the hardware layer
    # AND the auto-mtp layer for ITS model on ITS machine — including the MTP
    # opt-OUT (uncheck → spec_type=none persisted in the tune).
    s = db.session()
    s.add(db.HardwareSwitch(hw_key="k1", flag_name="threads", flag_value="6"))
    s.add(db.ModelTune(model_id="qwen3.6-35b-a3b-mtp", hw_key="k1",
                       flag_name="threads", flag_value="8"))
    s.add(db.ModelTune(model_id="qwen3.6-35b-a3b-mtp", hw_key="k1",
                       flag_name="spec_type", flag_value="none"))
    s.add(db.ModelTune(model_id="qwen3.6-35b-a3b-mtp", hw_key="k1",
                       flag_name="n_cpu_moe", flag_value="37"))
    s.commit()
    s.close()
    sw = switch_resolve.resolve_model_switches("qwen3.6-35b-a3b-mtp", hw_key="k1")
    assert sw["threads"] == "8"             # tune beats hardware
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


def test_hardware_layer_reachable_via_key(configured):
    # The hardware layer (dormant pre-Plan-B: no caller passed hw_key) is live
    # when the machine key is wired: a per-machine row applies to ALL models.
    s = db.session()
    s.add(db.HardwareSwitch(hw_key="k1", flag_name="ubatch_size", flag_value="32"))
    s.commit()
    s.close()
    assert switch_resolve.resolve_model_switches("qwen3-8b-q4_k_m", hw_key="k1")["ubatch_size"] == "32"
    assert "ubatch_size" not in switch_resolve.resolve_model_switches("qwen3-8b-q4_k_m")


def test_unknown_model_empty(configured):
    assert switch_resolve.resolve_model_switches("does-not-exist") == {
        "flash_attn": "on", "cache_type_k": "q8_0", "cache_type_v": "q8_0", "mlock": "true",
        "context_shift": "true", "cache_reuse": "256",
        # reasoning_budget deliberately ABSENT (user, 2026-07-06): thinking on/off is
        # the per-request toggle; a budget is a per-taste knob set per-model, never a
        # shipped base value.
    }  # unknown model → treated as dense, base preset only (no mtp gate w/o a row)
