# SPDX-License-Identifier: GPL-3.0-or-later
"""Per-Profile switch store (job_route_switches) — list + replace-the-whole-set."""

import sqlalchemy as sa
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
import pytest

from llm_runner.llm import db, seed, stores, switch_resolve
from llm_runner.llm.job_switches_api import JobSwitchRow


@pytest.fixture
def configured():
    eng = sa.create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    db.create_all(eng)
    db.configure_storage(sessionmaker(bind=eng, autoflush=False))
    s = db.session()
    seed.seed_default_switch_presets(s)  # base/moe/mtp → prefill type-defaults
    seed.seed_default_catalog(s)         # so prefill knows which models are local
    # FK parents: job_route_switches -> job_routes -> routing_configs.
    s.add(db.RoutingConfigRow(id="active"))
    s.add(db.JobRoute(config_id="active", job_id="analysis"))
    s.commit()
    s.close()
    yield


def test_replace_and_list(configured):
    store = stores.get_job_route_switch_store()
    assert store.list("active", "analysis") == []
    out = store.replace(
        "active",
        "analysis",
        [
            JobSwitchRow(flagName="ctx_len", flagValue="32768"),
            JobSwitchRow(flagName="flash_attn", flagValue="on"),
            JobSwitchRow(flagName="", flagValue="dropme"),  # empty name → dropped
        ],
    )
    assert {r.flagName for r in out} == {"ctx_len", "flash_attn"}
    again = {r.flagName: r.flagValue for r in store.list("active", "analysis")}
    assert again == {"ctx_len": "32768", "flash_attn": "on"}


def test_replace_overwrites_prior_set(configured):
    store = stores.get_job_route_switch_store()
    store.replace("active", "analysis", [JobSwitchRow(flagName="ctx_len", flagValue="8192")])
    store.replace("active", "analysis", [JobSwitchRow(flagName="flash_attn", flagValue="off")])
    rows = {r.flagName: r.flagValue for r in store.list("active", "analysis")}
    assert rows == {"flash_attn": "off"}  # the prior ctx_len is gone (whole-set replace)


def test_prefill_moe_model_writes_type_default(configured):
    # Setting a MoE model on a Profile fills the moe type-default switches.
    rows = switch_resolve.prefill_job_switches("active", "analysis", "qwen3.6-35b-a3b-mtp")
    d = {r.flagName: r.flagValue for r in rows}
    assert d["spec_type"] == "none"   # moe preset wins (35B-A3B is type=moe)
    assert d["no_mmap"] == "true"
    assert d["flash_attn"] == "on"    # base preset
    persisted = {r.flagName: r.flagValue for r in stores.get_job_route_switch_store().list("active", "analysis")}
    assert persisted["spec_type"] == "none"


def test_prefill_cloud_or_unknown_model_clears_switches(configured):
    # A model not in the local catalog (e.g. a cloud model) → no launch switches.
    switch_resolve.prefill_job_switches("active", "analysis", "qwen3.6-35b-a3b-mtp")
    rows = switch_resolve.prefill_job_switches("active", "analysis", "gpt-4o-mini")
    assert rows == []
    assert stores.get_job_route_switch_store().list("active", "analysis") == []
