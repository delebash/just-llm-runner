# SPDX-License-Identifier: GPL-3.0-or-later
"""Layered switch resolver (design §6.5) — the model-level merge:
base preset → type preset (moe|dense) → mtp preset (only if mtp and not moe) →
per-model override → per-hardware. Pure data/logic; no GPU needed."""

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


def test_moe_model_spec_none_beats_mtp(configured):
    # 35B-A3B is type=moe AND mtp=True → the moe preset wins: spec_type=none
    # (NOT draft-mtp), no_mmap=true; plus the base flags. (§6.5)
    sw = switch_resolve.resolve_model_switches("qwen3.6-35b-a3b-mtp")
    assert sw["spec_type"] == "none"
    assert sw["no_mmap"] == "true"
    assert sw["flash_attn"] == "on"
    assert sw["cache_type_k"] == "q8_0"


def test_dense_mtp_model_gets_draft_mtp(configured):
    # 27B-MTP is dense + mtp → the mtp preset applies: spec_type=draft-mtp.
    sw = switch_resolve.resolve_model_switches("qwen3.6-27b-mtp-q4_k_m")
    assert sw["spec_type"] == "draft-mtp"
    assert sw["spec_n_max"] == "3"
    assert sw["flash_attn"] == "on"


def test_plain_dense_model_base_only(configured):
    # 9B dense, no mtp → base preset only, no spec flags.
    sw = switch_resolve.resolve_model_switches("qwen3.5-9b-q4_k_s")
    assert sw["flash_attn"] == "on"
    assert sw["mlock"] == "true"
    assert "spec_type" not in sw


def test_per_model_override_wins(configured):
    # A per-model ModelSwitch row overrides the preset layer for that model.
    s = db.session()
    s.add(db.ModelSwitch(model_id="qwen3.5-9b-q4_k_s", flag_name="ctx_len", flag_value="8192"))
    s.commit()
    s.close()
    sw = switch_resolve.resolve_model_switches("qwen3.5-9b-q4_k_s")
    assert sw["ctx_len"] == "8192"
    assert sw["flash_attn"] == "on"  # base still present


def test_unknown_model_empty(configured):
    assert switch_resolve.resolve_model_switches("does-not-exist") == {
        "flash_attn": "on", "cache_type_k": "q8_0", "cache_type_v": "q8_0", "mlock": "true",
    }  # unknown model → treated as dense, base preset only
