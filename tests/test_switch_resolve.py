# SPDX-License-Identifier: GPL-3.0-or-later
"""Layered switch resolver (design §6) — the model-level merge:
base preset → type preset (moe|dense) → per-hardware. NO auto-mtp layer (Phase 3,
2026-07-03): MTP is opt-in/measurable, never auto-applied. (There is no per-model
override layer.) Pure data/logic; no GPU needed."""

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


def test_moe_model_gets_moe_preset_not_auto_mtp(configured):
    # 35B-A3B is type=moe AND mtp=True → base + the moe preset (no_mmap=true; spec_type is
    # absent → the knob default `none` applies). The auto-mtp layer is gone, so MTP is NOT
    # auto-enabled even though the model is mtp=True — it stays an opt-in the user measures.
    sw = switch_resolve.resolve_model_switches("qwen3.6-35b-a3b-mtp")
    assert "spec_type" not in sw           # NOT auto-drafted; the knob default (none) applies
    assert sw["no_mmap"] == "true"         # the one genuinely MoE-specific flag
    assert sw["flash_attn"] == "on"
    assert sw["cache_type_k"] == "q8_0"


def test_dense_mtp_model_no_longer_auto_drafts(configured):
    # 27B-MTP is dense + mtp; after Phase 3 the auto-mtp layer is gone → NO spec flags in
    # the resolved baseline (MTP is opt-in/measurable, default OFF via the knob).
    sw = switch_resolve.resolve_model_switches("qwen3.6-27b-mtp-q4_k_m")
    assert "spec_type" not in sw
    assert "spec_n_max" not in sw
    assert sw["flash_attn"] == "on"        # base flags still apply


def test_moe_can_opt_into_draft_mtp_via_hardware(configured):
    # MTP is no longer BLOCKED for a MoE (the old `mtp != "moe"` skip is gone): a
    # per-machine tune (hardware_switch) can set spec_type=draft-mtp and it WINS over the
    # moe preset's none — proof the resolver treats MTP as an opt-in for any model.
    s = db.session()
    s.add(db.HardwareSwitch(hw_key="gpu0", flag_name="spec_type", flag_value="draft-mtp"))
    s.commit()
    s.close()
    sw = switch_resolve.resolve_model_switches("qwen3.6-35b-a3b-mtp", hw_key="gpu0")
    assert sw["spec_type"] == "draft-mtp"


def test_plain_dense_model_base_only(configured):
    # 9B dense, no mtp → base preset only, no spec flags.
    sw = switch_resolve.resolve_model_switches("qwen3.5-9b-q4_k_m")
    assert sw["flash_attn"] == "on"
    assert sw["mlock"] == "true"
    assert "spec_type" not in sw


def test_unknown_model_empty(configured):
    assert switch_resolve.resolve_model_switches("does-not-exist") == {
        "flash_attn": "on", "cache_type_k": "q8_0", "cache_type_v": "q8_0", "mlock": "true",
        "context_shift": "true", "cache_reuse": "256",
    }  # unknown model → treated as dense, base preset only (incl. snappy-edit defaults)
