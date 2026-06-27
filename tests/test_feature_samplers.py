# SPDX-License-Identifier: GPL-3.0-or-later
"""Per-action sampler store (feature_sampler_params) — list + replace-the-set."""

import sqlalchemy as sa
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
import pytest

from llm_runner.llm import db, stores
from llm_runner.llm.feature_samplers_api import FeatureSamplerRow


@pytest.fixture
def configured():
    eng = sa.create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    db.create_all(eng)
    db.configure_storage(sessionmaker(bind=eng, autoflush=False))
    yield


def test_replace_and_list(configured):
    store = stores.get_feature_sampler_store()
    assert store.list("writerAI.tighten") == []
    out = store.replace(
        "writerAI.tighten",
        [
            FeatureSamplerRow(flagName="top_k", flagValue="40"),
            FeatureSamplerRow(flagName="min_p", flagValue="0.05"),
            FeatureSamplerRow(flagName="", flagValue="x"),  # empty name → dropped
        ],
    )
    assert {r.flagName for r in out} == {"top_k", "min_p"}
    again = {r.flagName: r.flagValue for r in store.list("writerAI.tighten")}
    assert again == {"top_k": "40", "min_p": "0.05"}


def test_replace_is_per_action(configured):
    store = stores.get_feature_sampler_store()
    store.replace("a.x", [FeatureSamplerRow(flagName="top_k", flagValue="40")])
    store.replace("a.y", [FeatureSamplerRow(flagName="mirostat", flagValue="2")])
    store.replace("a.x", [FeatureSamplerRow(flagName="min_p", flagValue="0.1")])  # overwrites a.x only
    assert {r.flagName for r in store.list("a.x")} == {"min_p"}
    assert {r.flagName for r in store.list("a.y")} == {"mirostat"}
