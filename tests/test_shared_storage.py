# SPDX-License-Identifier: MIT
"""The shared LLM storage stack in isolation — configure_storage + create_all +
seed + store round-trips + build_llm_config, on an in-memory SQLite.

NOT the drop-in test. This file wires the storage layer by hand and never calls
`install_llm`; until 2026-08-01 its docstring claimed it proved "the drop-in works
with no host app", which nothing here exercised — the entry point itself had zero
direct coverage while this sentence said otherwise. The actual drop-in (routers
mounted, singletons wired, the bare minimal call, the double-seed no-op) is
`tests/test_install_llm.py`, and check 3 of `scripts/check-clean-install.py` runs
the same bare call in a venv holding only the declared dependencies."""

from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from llm_runner.llm import db, seed, stores
from llm_runner.llm.config_builder import build_llm_config
from llm_runner.llm.routing_api import FeatureCatalogEntry, RoutingConfig, RoutingDefaults


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
            "critique": {"feature": "critique", "system": "S", "user_template": "U", "json_mode": True},
        },
        engine_presets=[], feature_presets={}, default_preset_id="",
    )
    seed.seed_llm()
    return SessionLocal


def test_seed_populates_shared_and_app_data(wired):
    providers = {p.id for p in stores.get_provider_store().list()}
    assert {"local-llamacpp", "openai", "claude", "openrouter"} <= providers  # shared seed
    # Catalog-full / selections-empty (user, 2026-07-06): the routing row exists but
    # carries NO choices — Quick Setup or a manual pick fills them.
    assert stores.get_routing_store().get_routing().default.llmId == ""
    assert stores.get_prompt_store().get("critique") is not None  # per-app prompt seed
    assert len(stores.get_model_catalog_store().list()) == len(seed.DEFAULT_CATALOG)


def test_reseed_refreshes_old_seeded_provider_name_only(wired):
    """#3 (2026-07-08): reseed refreshes an old seeded provider name ONLY while the row
    still carries the old seeded string; a user's own rename is never touched."""
    session = wired()
    try:
        row = session.get(db.LlmProvider, "local-llamacpp")
        assert row.name == "Built-in provider — llama.cpp"  # fresh seed = new name

        row.name = "Built-in server — llama.cpp"  # a pre-rename DB
        session.commit()
        seed.seed_default_providers(session)
        session.commit()
        assert session.get(db.LlmProvider, "local-llamacpp").name == "Built-in provider — llama.cpp"

        row = session.get(db.LlmProvider, "local-llamacpp")
        row.name = "My box's engine"  # the user renamed it — a different fact
        session.commit()
        seed.seed_default_providers(session)
        session.commit()
        assert session.get(db.LlmProvider, "local-llamacpp").name == "My box's engine"
    finally:
        session.close()


def test_seed_routing_ships_no_selections(wired):
    d = stores.get_routing_store().get_routing().default
    assert d.embeddingId == ""
    assert d.embeddingModel == ""
    assert d.llmId == ""


def test_routing_roundtrip_default_only(wired):
    # Per-feature pins are gone (2026-07-15) — the routing config is the global default.
    rs = stores.get_routing_store()
    rs.set_routing(RoutingConfig(default=RoutingDefaults(llmId="openai", model="gpt-4o")))
    got = rs.get_routing()
    assert got.default.llmId == "openai" and got.default.model == "gpt-4o"


def test_build_llm_config_has_providers_no_pins(wired):
    stores.get_routing_store().set_routing(RoutingConfig(default=RoutingDefaults(llmId="openai-compat-local")))
    cfg = build_llm_config()
    assert {p.id for p in cfg.providers} >= {"local-llamacpp", "openai"}
    assert cfg.feature_pins == []   # JW never populates pins (the preset is the one source)


def test_model_catalog_quality_and_description_roundtrip(wired):
    from llm_runner.llm.model_catalog_api import CatalogRow

    cat = stores.get_model_catalog_store()
    cat.upsert(CatalogRow(id="probe-model", name="Probe", qualityRank=7, description="a probe model", pooling="last"))
    row = next(r for r in cat.list() if r.id == "probe-model")
    assert row.qualityRank == 7
    assert row.description == "a probe model"
    assert row.pooling == "last"
    cat.upsert(CatalogRow(id="probe-default", name="Probe2"))
    row2 = next(r for r in cat.list() if r.id == "probe-default")
    assert row2.qualityRank == 100
    assert row2.description == ""
    assert row2.pooling == ""


def test_reset_all_to_factory(wired):
    from llm_runner.llm import db as _db
    from llm_runner.llm.presets_api import EnginePresetRow

    seed.configure_app_seed(
        feature_presets={"critique": "p_fac"},
        engine_presets=[{"id": "p_fac", "name": "Factory", "provider_id": "local-llamacpp", "model": "m-fac"}],
        default_preset_id="p_fac",
    )
    s = _db.session()
    try:
        seed.seed_default_engine_presets(s)
        seed.seed_default_feature_presets(s)
        s.commit()
    finally:
        s.close()
    eps = stores.get_engine_preset_store()
    # user edits the built-in, re-points the action, sets a custom default + custom preset
    eps.save(EnginePresetRow(id="p_fac", name="EDITED", providerId="local-llamacpp", model="hacked"))
    custom = eps.save(EnginePresetRow(name="Mine", providerId="local-llamacpp", model="m-custom"))
    stores.get_feature_preset_ref_store().set("critique", custom.id)
    stores.set_default_preset_id(custom.id)

    seed.reset_routing_to_factory()

    fac = next(p for p in eps.list() if p.id == "p_fac")
    assert fac.name == "Factory" and fac.model == "m-fac"                             # built-in restored
    assert any(p.id == custom.id for p in eps.list())                                 # custom kept
    assert stores.get_feature_preset_ref_store().list().get("critique") == "p_fac"    # factory ref restored
    assert stores.get_default_preset_id() == "p_fac"                                  # default restored


def test_engine_preset_name_refresh(wired):
    from llm_runner.llm import db as _db

    seed.configure_app_seed(
        feature_presets={},
        engine_presets=[
            {"id": "p_a", "name": "New A", "name_was": "Old A", "provider_id": "local-llamacpp", "model": "m"},
            {"id": "p_b", "name": "New B", "name_was": "Old B", "provider_id": "local-llamacpp", "model": "m"},
        ],
        default_preset_id="",
    )
    s = _db.session()
    try:  # an existing DB: p_a still under its old name; p_b renamed by the user
        s.add(_db.EnginePreset(id="p_a", name="Old A", provider_id="local-llamacpp", model="m", built_in=True))
        s.add(_db.EnginePreset(id="p_b", name="My Own B", provider_id="local-llamacpp", model="m", built_in=True))
        s.commit()
        seed.seed_default_engine_presets(s)
        s.commit()
    finally:
        s.close()
    names = {p.id: p.name for p in stores.get_engine_preset_store().list()}
    assert names["p_a"] == "New A"      # refreshed (still carried the old default name)
    assert names["p_b"] == "My Own B"   # user rename survives


def test_engine_preset_delete_removes_children(wired):
    from llm_runner.llm import db as _db
    from llm_runner.llm.presets_api import EnginePresetRow, PresetFlagRow

    eps = stores.get_engine_preset_store()
    p = eps.save(EnginePresetRow(
        name="P", providerId="local-llamacpp", model="m",
        samplers=[PresetFlagRow(flagName="top_k", flagValue="40")],
    ))
    s = _db.session()
    try:
        assert s.query(_db.EnginePresetSampler).filter_by(preset_id=p.id).count() == 1
    finally:
        s.close()

    eps.delete(p.id)

    s = _db.session()
    try:
        assert s.query(_db.EnginePreset).filter_by(id=p.id).count() == 0
        assert s.query(_db.EnginePresetSampler).filter_by(preset_id=p.id).count() == 0  # child gone
    finally:
        s.close()
