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
from llm_runner.llm.routing_api import FeatureCatalogEntry, FeaturePin, RoutingConfig, RoutingDefaults


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
            FeatureCatalogEntry(key="critique", label="Critique", group="Analysis"),
            FeatureCatalogEntry(key="chat", label="Ask the book", group="Chat"),
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
    assert stores.get_routing_store().get_routing().default.llmId == "openai-compat-local"
    assert stores.get_prompt_store().get("critique") is not None  # per-app prompt seed
    assert len(stores.get_model_catalog_store().list()) == len(seed.DEFAULT_CATALOG)


def test_routing_roundtrip_default_and_pins(wired):
    rs = stores.get_routing_store()
    rs.set_routing(RoutingConfig(
        default=RoutingDefaults(llmId="openai", model="gpt-4o"),
        pins={"critique": FeaturePin(providerId="openai", model="gpt-4o")},
    ))
    got = rs.get_routing()
    assert got.default.llmId == "openai" and got.default.model == "gpt-4o"
    assert got.pins["critique"].model == "gpt-4o"


def test_build_llm_config_pins(wired):
    stores.get_routing_store().set_routing(RoutingConfig(
        default=RoutingDefaults(llmId="openai-compat-local"),
        pins={"critique": FeaturePin(providerId="claude", model="big")},
    ))
    cfg = build_llm_config()
    assert {p.feature: p.model for p in cfg.feature_pins} == {"critique": "big"}
