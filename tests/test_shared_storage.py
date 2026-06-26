# SPDX-License-Identifier: GPL-3.0-or-later
"""The shared LLM storage stack in isolation — configure_storage + create_all +
seed + store round-trips + build_llm_config, on an in-memory SQLite. Proves the
drop-in works with NO host app (any app that calls install_llm gets this)."""

from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from llm_runner.llm import db, seed, stores
from llm_runner.llm.config_builder import build_llm_config
from llm_runner.llm.routing_api import FeatureCatalogEntry, FeaturePin, JobTarget, RoutingConfig, RoutingDefaults


@pytest.fixture
def wired():
    # StaticPool + a single shared connection so every session sees one in-memory DB.
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    db.configure_storage(SessionLocal)
    db.create_all(engine)
    seed.configure_app_seed(
        feature_catalog=[
            FeatureCatalogEntry(key="critique", label="Critique", category="Analysis"),
            FeatureCatalogEntry(key="chat", label="Ask the book", category="Chat"),
        ],
        feature_jobs=[
            {"feature_key": "critique", "job_id": "analysis"},
            {"feature_key": "chat", "job_id": "chat"},
        ],
        feature_prompts={
            "critique": {"feature": "critique", "system": "S", "user_template": "U", "temperature": 0.4},
        },
    )
    seed.seed_llm()
    return SessionLocal


def test_seed_populates_shared_and_app_data(wired):
    providers = {p.id for p in stores.get_provider_store().list()}
    assert {"local-llamacpp", "openai", "claude", "openrouter"} <= providers  # shared seed
    assert len(stores.get_job_store().list()) == 4  # chat/prose/extraction/analysis
    assert stores.get_routing_store().get_routing().default.llmId == "openai-compat-local"
    fjs = {fj.featureKey: fj.jobId for fj in stores.get_feature_job_store().list()}
    assert fjs == {"critique": "analysis", "chat": "chat"}  # per-app seed via the hook
    assert stores.get_prompt_store().get("critique") is not None  # per-app prompt seed
    assert len(stores.get_model_catalog_store().list()) == len(seed.DEFAULT_CATALOG)


def test_routing_roundtrip_jobs_and_pins(wired):
    rs = stores.get_routing_store()
    rs.set_routing(RoutingConfig(
        default=RoutingDefaults(llmId="openai", model="gpt-4o"),
        jobs={"analysis": JobTarget(providerId="claude", model="claude-sonnet-4-6")},
        pins={"critique": FeaturePin(providerId="openai", model="gpt-4o")},
    ))
    got = rs.get_routing()
    assert got.default.llmId == "openai" and got.default.model == "gpt-4o"
    assert got.jobs["analysis"].providerId == "claude"
    assert got.pins["critique"].model == "gpt-4o"


def test_build_llm_config_is_job_native(wired):
    stores.get_routing_store().set_routing(RoutingConfig(
        jobs={"analysis": JobTarget(providerId="claude", model="big"),
              "chat": JobTarget(providerId="local-llamacpp", model="qwen")},
    ))
    cfg = build_llm_config()
    assert cfg.feature_jobs == {"critique": "analysis", "chat": "chat"}
    assert cfg.jobs["analysis"].model == "big"
    assert [p.feature for p in cfg.feature_pins] == []  # no explicit pins set


def test_reset_to_factory_restores_jobs(wired):
    js = stores.get_job_store()
    # Rename a built-in job, then reset.
    from llm_runner.llm.jobs_api import JobRow
    js.upsert(JobRow(id="chat", label="RENAMED", description="x", position=0, builtIn=True))
    assert {j.id: j.label for j in js.list()}["chat"] == "RENAMED"
    js.reset_to_factory()
    assert {j.id: j.label for j in js.list()}["chat"] == "Chat"
