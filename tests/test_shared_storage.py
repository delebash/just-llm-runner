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


def test_task_kind_delete_cascades_and_builtin_guard(wired):
    from llm_runner.llm.presets_api import EnginePresetRow
    from llm_runner.llm.recommendations_api import RecommendationRow
    from llm_runner.llm.task_kinds_api import TaskKindRow

    tks = stores.get_task_kind_store()
    # the shared built-in nine are seeded, and built-ins cannot be deleted
    assert len(tks.list()) == len(seed.DEFAULT_TASK_KINDS)
    assert all(t.builtIn for t in tks.list())
    with pytest.raises(ValueError):
        tks.delete("prose.generate")

    # create a custom task and hang all three soft references off it
    created = tks.upsert(TaskKindRow(label="Zzz Custom"))
    assert created.id == "zzz.custom" and created.builtIn is False
    preset = stores.get_engine_preset_store().save(
        EnginePresetRow(name="probe", providerId="local-llamacpp", model="m")
    )
    stores.get_task_kind_preset_store().set("zzz.custom", preset.id)
    stores.get_feature_task_kind_store().set("somefeature", "zzz.custom")
    stores.get_recommendation_store().upsert(
        RecommendationRow(modelId="m1", taskKind="zzz.custom", rank=1, why="")
    )
    assert stores.get_task_kind_preset_store().list().get("zzz.custom") == preset.id
    assert stores.get_feature_task_kind_store().list().get("somefeature") == "zzz.custom"
    assert any(r.taskKind == "zzz.custom" for r in stores.get_recommendation_store().list())

    # delete the custom task → cascade cleans all three; the feature re-floats (row gone)
    tks.delete("zzz.custom")
    assert not any(t.id == "zzz.custom" for t in tks.list())
    assert "zzz.custom" not in stores.get_task_kind_preset_store().list()
    assert "somefeature" not in stores.get_feature_task_kind_store().list()
    assert not any(r.taskKind == "zzz.custom" for r in stores.get_recommendation_store().list())


def test_task_kind_slug_collision_suffixes(wired):
    from llm_runner.llm.task_kinds_api import TaskKindRow

    tks = stores.get_task_kind_store()
    a = tks.upsert(TaskKindRow(label="My Task"))
    b = tks.upsert(TaskKindRow(label="My Task"))
    assert a.id == "my.task"
    assert b.id == "my.task-2"   # collision → numeric suffix, never clobber
    # a label that slugs to the reserved "feature" is deflected
    assert tks.upsert(TaskKindRow(label="Feature")).id == "feature.task"


def test_reset_routing_to_factory(wired):
    from llm_runner.llm.presets_api import EnginePresetRow

    # a factory action->task map for the reset to restore (taskkind_presets empty here).
    seed.configure_app_seed(feature_task_kinds={"critique": "judge.scored"}, taskkind_presets=[])
    ft = stores.get_feature_task_kind_store()
    ft.set("critique", "prose.edit")      # user reassigns a factory feature
    ft.set("chat", "chat.inVoice")        # a non-factory override
    p = stores.get_engine_preset_store().save(EnginePresetRow(name="x", providerId="local-llamacpp", model="m"))
    stores.get_feature_preset_ref_store().set("critique", p.id)     # a per-feature preset override
    stores.get_task_kind_preset_store().set("chat.inVoice", p.id)   # a custom task->preset

    seed.reset_routing_to_factory()

    m = ft.list()
    assert m.get("critique") == "judge.scored"                 # restored to the factory map
    assert "chat" not in m                                     # non-factory override cleared
    assert stores.get_feature_preset_ref_store().list() == {}  # per-feature overrides cleared
    assert stores.get_task_kind_preset_store().list() == {}    # task->preset cleared + reseeded (none)
