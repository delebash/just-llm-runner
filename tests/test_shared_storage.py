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


def test_seed_routing_points_embedding_at_bundled_runner(wired):
    # #120: fresh installs default local embeddings to the bundled llama.cpp runner + the co-resident
    # qwen3-embedding-0.6b (P3 pinned it; #120 made it the default over nomic), so RAG "Build index"
    # works out of the box (the runner serves it by id). The LLM default is untouched — repointing it
    # at the runner is model-surface #107's QuickSetup scope.
    d = stores.get_routing_store().get_routing().default
    assert d.embeddingId == "local-llamacpp"
    assert d.embeddingModel == "qwen3-embedding-0.6b"
    assert d.llmId == "openai-compat-local"
    # the default embed is a real catalog row carrying LAST-token pooling (#119 per-model pooling)
    embed = next(r for r in stores.get_model_catalog_store().list() if r.id == d.embeddingModel)
    assert embed.pooling == "last"


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
    from llm_runner.llm.task_kinds_api import TaskKindRow

    tks = stores.get_task_kind_store()
    # the shared built-in nine are seeded, and built-ins cannot be deleted
    assert len(tks.list()) == len(seed.DEFAULT_TASK_KINDS)
    assert all(t.builtIn for t in tks.list())
    with pytest.raises(ValueError):
        tks.delete("prose.generate")

    # create a custom task and hang both soft references off it
    created = tks.upsert(TaskKindRow(label="Zzz Custom"))
    assert created.id == "zzz.custom" and created.builtIn is False
    preset = stores.get_engine_preset_store().save(
        EnginePresetRow(name="probe", providerId="local-llamacpp", model="m")
    )
    stores.get_task_kind_preset_store().set("zzz.custom", preset.id)
    stores.get_feature_task_kind_store().set("somefeature", "zzz.custom")
    assert stores.get_task_kind_preset_store().list().get("zzz.custom") == preset.id
    assert stores.get_feature_task_kind_store().list().get("somefeature") == "zzz.custom"

    # delete the custom task → cascade cleans both; the feature re-floats (row gone)
    tks.delete("zzz.custom")
    assert not any(t.id == "zzz.custom" for t in tks.list())
    assert "zzz.custom" not in stores.get_task_kind_preset_store().list()
    assert "somefeature" not in stores.get_feature_task_kind_store().list()


def test_model_catalog_quality_and_description_roundtrip(wired):
    from llm_runner.llm.model_catalog_api import CatalogRow

    cat = stores.get_model_catalog_store()
    # a user-added model carries the editable curation fields (C1a) through upsert -> list
    cat.upsert(CatalogRow(id="probe-model", name="Probe", qualityRank=7, description="a probe model", pooling="last"))
    row = next(r for r in cat.list() if r.id == "probe-model")
    assert row.qualityRank == 7
    assert row.description == "a probe model"
    assert row.pooling == "last"   # pooling round-trips DB<->wire (#119)
    # a fresh custom model defaults to unranked (100 = sorts last), never "best" (0/low)
    cat.upsert(CatalogRow(id="probe-default", name="Probe2"))
    row2 = next(r for r in cat.list() if r.id == "probe-default")
    assert row2.qualityRank == 100
    assert row2.description == ""
    assert row2.pooling == ""   # default "" when unset (#119)


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
    from llm_runner.llm.task_kinds_api import TaskKindRow

    # a factory action->task map for the reset to restore (taskkind_presets empty here).
    seed.configure_app_seed(feature_task_kinds={"critique": "judge.scored"}, taskkind_presets=[])
    ft = stores.get_feature_task_kind_store()
    tks = stores.get_task_kind_store()
    eps = stores.get_engine_preset_store()

    ft.set("critique", "prose.edit")      # user reassigns a factory feature
    ft.set("chat", "chat.inVoice")        # a non-factory override
    tks.upsert(TaskKindRow(id="prose.generate", label="RENAMED", description="x"))   # rename a built-in
    custom_task = tks.upsert(TaskKindRow(label="My Custom"))            # a custom task (must survive)
    custom_preset = eps.save(EnginePresetRow(name="Mine", providerId="local-llamacpp", model="m-custom"))
    stores.get_task_kind_preset_store().set("chat.inVoice", custom_preset.id)   # a custom task->preset

    seed.reset_routing_to_factory()

    assert ft.list().get("critique") == "judge.scored"          # restored to the factory map
    assert "chat" not in ft.list()                              # non-factory override cleared
    assert stores.get_task_kind_preset_store().list() == {}     # task->preset cleared + reseeded (none)
    # a renamed built-in task label is restored from DEFAULT_TASK_KINDS
    assert next(t for t in tks.list() if t.id == "prose.generate").label == "Generate prose"
    # CUSTOM task + custom preset SURVIVE the reset
    assert any(t.id == custom_task.id for t in tks.list())
    assert any(p.id == custom_preset.id for p in eps.list())


def test_reset_restores_built_in_preset(wired):
    from llm_runner.llm import db as _db
    from llm_runner.llm.presets_api import EnginePresetRow

    seed.configure_app_seed(
        feature_task_kinds={},
        engine_presets=[{"id": "p_fac", "name": "Factory", "provider_id": "local-llamacpp", "model": "m-fac"}],
        taskkind_presets=[{"task_kind": "prose.generate", "preset_id": "p_fac"}],
    )
    s = _db.session()
    try:
        seed.seed_default_engine_presets(s)      # add the factory built-in preset
        seed.seed_default_taskkind_presets(s)    # + its factory task->preset
        s.commit()
    finally:
        s.close()
    eps = stores.get_engine_preset_store()
    eps.save(EnginePresetRow(id="p_fac", name="EDITED", providerId="local-llamacpp", model="hacked"))  # edit built-in
    custom = eps.save(EnginePresetRow(name="Mine", providerId="local-llamacpp", model="m-mine"))       # custom preset
    assert next(p for p in eps.list() if p.id == "p_fac").model == "hacked"

    seed.reset_routing_to_factory()

    fac = next(p for p in eps.list() if p.id == "p_fac")
    assert fac.name == "Factory" and fac.model == "m-fac"                              # built-in restored
    assert any(p.id == custom.id for p in eps.list())                                  # custom kept
    assert stores.get_task_kind_preset_store().list().get("prose.generate") == "p_fac"  # factory assignment restored


def test_reset_task_to_factory(wired):
    from llm_runner.llm import db as _db
    from llm_runner.llm.presets_api import EnginePresetRow
    from llm_runner.llm.task_kinds_api import TaskKindRow

    seed.configure_app_seed(
        feature_task_kinds={},
        engine_presets=[{"id": "p_fac", "name": "Factory", "provider_id": "local-llamacpp", "model": "m-fac"}],
        taskkind_presets=[{"task_kind": "prose.edit", "preset_id": "p_fac"}],
    )
    s = _db.session()
    try:
        seed.seed_default_engine_presets(s)
        s.commit()
    finally:
        s.close()
    tks = stores.get_task_kind_store()
    tkp = stores.get_task_kind_preset_store()
    tks.upsert(TaskKindRow(id="prose.edit", label="WRONG", description="x"))       # rename a built-in
    custom = stores.get_engine_preset_store().save(EnginePresetRow(name="Mine", providerId="local-llamacpp", model="m"))
    tkp.set("prose.edit", custom.id)                                               # point it at the wrong preset

    seed.reset_task_to_factory("prose.edit")

    assert next(t for t in tks.list() if t.id == "prose.edit").label == "Edit prose"  # label restored
    assert tkp.list().get("prose.edit") == "p_fac"                                    # factory preset restored

    # a custom task cannot be reset (nothing to reset to) → ValueError
    cst = tks.upsert(TaskKindRow(label="Custom X"))
    with pytest.raises(ValueError):
        seed.reset_task_to_factory(cst.id)

    # a built-in with NO factory preset entry → its assignment is cleared (falls back to default)
    tkp.set("ideation", custom.id)
    seed.reset_task_to_factory("ideation")
    assert "ideation" not in tkp.list()


def test_engine_preset_delete_removes_children(wired):
    from llm_runner.llm import db as _db
    from llm_runner.llm.presets_api import EnginePresetRow, PresetFlagRow

    eps = stores.get_engine_preset_store()
    p = eps.save(EnginePresetRow(
        name="P", providerId="local-llamacpp", model="m",
        switches=[PresetFlagRow(flagName="flash_attn", flagValue="on")],
        samplers=[PresetFlagRow(flagName="top_k", flagValue="40")],
    ))
    s = _db.session()
    try:
        assert s.query(_db.EnginePresetSwitch).filter_by(preset_id=p.id).count() == 1
        assert s.query(_db.EnginePresetSampler).filter_by(preset_id=p.id).count() == 1
    finally:
        s.close()

    eps.delete(p.id)

    s = _db.session()
    try:
        assert s.query(_db.EnginePreset).filter_by(id=p.id).count() == 0
        assert s.query(_db.EnginePresetSwitch).filter_by(preset_id=p.id).count() == 0   # children gone (no orphans)
        assert s.query(_db.EnginePresetSampler).filter_by(preset_id=p.id).count() == 0
    finally:
        s.close()
