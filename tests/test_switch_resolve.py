# SPDX-License-Identifier: GPL-3.0-or-later
"""Layered switch resolver (design §6.5) — the model-level merge:
base preset → type preset (moe|dense) → mtp preset (only if mtp and not moe) →
per-hardware. (Per-model overrides were dropped per D9.) Plus the Profile-level
resolver (job_route_switches + hardware). Pure data/logic; no GPU needed."""

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
    sw = switch_resolve.resolve_model_switches("qwen3.5-9b-q4_k_m")
    assert sw["flash_attn"] == "on"
    assert sw["mlock"] == "true"
    assert "spec_type" not in sw


def test_unknown_model_empty(configured):
    assert switch_resolve.resolve_model_switches("does-not-exist") == {
        "flash_attn": "on", "cache_type_k": "q8_0", "cache_type_v": "q8_0", "mlock": "true",
        "context_shift": "true", "cache_reuse": "256",
    }  # unknown model → treated as dense, base preset only (incl. snappy-edit defaults)


def _seed_profile(s, job_id="analysis", config_id="active"):
    # FK chain: job_route_switches -> job_routes -> routing_configs. Seed parents.
    if s.get(db.RoutingConfigRow, config_id) is None:
        s.add(db.RoutingConfigRow(id=config_id))
    if s.get(db.JobRoute, (config_id, job_id)) is None:
        s.add(db.JobRoute(config_id=config_id, job_id=job_id))
    s.flush()


def test_profile_switches_frozen_plus_hardware(configured):
    # A Profile's switches = its OWN frozen job_route_switches (no type re-layer),
    # then this machine's hardware tune on top (hardware wins).
    s = db.session()
    _seed_profile(s, "analysis")
    s.add(db.JobRouteSwitch(config_id="active", job_id="analysis", flag_name="ctx_len", flag_value="32768"))
    s.add(db.JobRouteSwitch(config_id="active", job_id="analysis", flag_name="flash_attn", flag_value="on"))
    s.add(db.HardwareSwitch(hw_key="rtx3060", flag_name="flash_attn", flag_value="off"))
    s.add(db.HardwareSwitch(hw_key="rtx3060", flag_name="n_cpu_moe", flag_value="20"))
    s.commit()
    s.close()
    # No hardware key → just the Profile's frozen switches (no base/type re-layer).
    assert switch_resolve.resolve_profile_switches("analysis") == {
        "ctx_len": "32768", "flash_attn": "on",
    }
    # With a hardware key → the per-GPU tune layers on top (override wins).
    sw = switch_resolve.resolve_profile_switches("analysis", hw_key="rtx3060")
    assert sw["ctx_len"] == "32768"
    assert sw["flash_attn"] == "off"   # hardware override wins
    assert sw["n_cpu_moe"] == "20"


def test_profile_switches_empty_when_unset(configured):
    # A Profile with no stored switches → {} (load path falls back to the
    # model-level pre-fill resolver during the migration).
    assert switch_resolve.resolve_profile_switches("chat") == {}
