# SPDX-License-Identifier: GPL-3.0-or-later
"""The engine-preset router + resolver — CRUD, the default/per-action-ref assignment
layers, the ref → default resolve (2026-07-15 one-source; the task tier is gone), the
dangling fall-through, and the factory resets, over an in-memory DB."""

from __future__ import annotations

import pytest
import sqlalchemy as sa
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from llm_runner.llm import db, seed, stores
from llm_runner.llm.presets_api import make_presets_router


@pytest.fixture
def client():
    engine = sa.create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    db.LlmBase.metadata.create_all(engine)
    db.configure_storage(sessionmaker(bind=engine))
    app = FastAPI()
    app.include_router(make_presets_router(
        stores.get_engine_preset_store,
        stores.get_default_preset_id,
        stores.set_default_preset_id,
        stores.get_feature_preset_ref_store,
        reset_all_fn=seed.reset_routing_to_factory,
        reset_one_fn=seed.reset_preset_to_factory,
    ))
    return TestClient(app, raise_server_exceptions=False)


def _pid(resp, name):
    return next(p["id"] for p in resp.json()["presets"] if p["name"] == name)


def test_preset_crud_roundtrip(client):
    r = client.post("/v1/ai/engine-presets", json={
        "name": "Prose", "providerId": "llamacpp", "model": "qwen3-14b-q4_k_m",
        "temperature": 0.9, "maxTokens": 2048,
        "samplers": [{"flagName": "top_k", "flagValue": "40"}],
    })
    assert r.status_code == 200
    presets = r.json()["presets"]
    assert len(presets) == 1
    p = presets[0]
    assert p["id"] and p["model"] == "qwen3-14b-q4_k_m" and p["temperature"] == 0.9
    assert p["samplers"][0]["flagName"] == "top_k"
    # 2026-07-15: presets carry NO json field (the JSON CONTRACT is on the action) and
    # NO launch switches (§7.1) — a stale client key is dropped by pydantic.
    assert "jsonMode" not in p and "switches" not in p
    pid = p["id"]

    r = client.put(f"/v1/ai/engine-presets/{pid}", json={
        "name": "Prose", "providerId": "llamacpp", "model": "qwen3-14b-q4_k_m",
        "temperature": 0.8, "jsonMode": True,  # a stale jsonMode is ignored
        "samplers": [{"flagName": "min_p", "flagValue": "0.05"}],
    })
    p = r.json()["presets"][0]
    assert p["temperature"] == 0.8 and p["samplers"][0]["flagName"] == "min_p"
    assert "jsonMode" not in p

    assert client.delete(f"/v1/ai/engine-presets/{pid}").json()["presets"] == []
    assert client.put("/v1/ai/engine-presets/nope", json={"name": "x"}).status_code == 404


def test_assignment_layers(client):
    a = _pid(client.post("/v1/ai/engine-presets", json={"name": "A", "model": "m-a"}), "A")
    b = _pid(client.post("/v1/ai/engine-presets", json={"name": "B", "model": "m-b"}), "B")
    client.put("/v1/ai/preset-assignments/default", json={"presetId": a})
    asg = client.get("/v1/ai/preset-assignments").json()
    assert asg["defaultPresetId"] == a
    assert asg["features"] == {}
    assert "taskKinds" not in asg   # the task tier is gone (2026-07-15)
    # a per-action ref PUT lands in `features`, keyed by action id
    asg = client.put("/v1/ai/preset-assignments/feature",
                     json={"featureKey": "writerAI.continue", "presetId": b}).json()
    assert asg["features"]["writerAI.continue"] == b
    # clear-features drops the ref(s) → the action falls to the default
    asg = client.post("/v1/ai/preset-assignments/clear-features",
                      json={"featureKeys": ["writerAI.continue"]}).json()
    assert "writerAI.continue" not in asg["features"]


def test_resolve_ref_then_default(client):
    from llm_runner.llm.preset_resolve import resolve_feature_preset, resolve_feature_preset_with_source

    a = _pid(client.post("/v1/ai/engine-presets", json={"name": "A", "model": "m-a"}), "A")
    b = _pid(client.post("/v1/ai/engine-presets", json={"name": "B", "model": "m-b"}), "B")
    client.put("/v1/ai/preset-assignments/default", json={"presetId": a})
    client.put("/v1/ai/preset-assignments/feature", json={"featureKey": "writerAI.continue", "presetId": b})

    # the action's OWN ref wins over the default
    p, src = resolve_feature_preset_with_source("writerAI.continue")
    assert p.model == "m-b" and src == "assigned"
    # no ref → the global default
    p, src = resolve_feature_preset_with_source("writerAI.expand")
    assert p.model == "m-a" and src == "default"

    # clearing the ref → the action falls to the default
    client.put("/v1/ai/preset-assignments/feature", json={"featureKey": "writerAI.continue", "presetId": ""})
    assert resolve_feature_preset("writerAI.continue").model == "m-a"

    # a DANGLING ref (its preset deleted, the ref row survives on the FK-off path)
    # falls THROUGH to the default rather than stranding at None
    stores.get_feature_preset_ref_store().set("writerAI.tighten", "ghost-preset-id")
    assert resolve_feature_preset("writerAI.tighten").model == "m-a"

    # nothing configured → None (the no-preset route)
    client.put("/v1/ai/preset-assignments/default", json={"presetId": ""})
    assert resolve_feature_preset("brainstorm") is None


def test_reset_all_restores_built_ins(client):
    from llm_runner.llm.presets_api import EnginePresetRow

    seed.configure_app_seed(
        engine_presets=[{"id": "p_fac", "name": "Factory", "provider_id": "local-llamacpp",
                         "model": "m-fac", "temperature": 0.4, "samplers": {"min_p": "0.05"}}],
        feature_presets={"critique": "p_fac"},
        default_preset_id="p_fac",
    )
    s = db.session()
    try:
        seed.seed_default_engine_presets(s)
        seed.seed_default_feature_presets(s)
        s.commit()
    finally:
        s.close()
    eps = stores.get_engine_preset_store()
    # user edits the built-in + re-points the action + sets a custom default + custom preset
    eps.save(EnginePresetRow(id="p_fac", name="EDITED", providerId="local-llamacpp", model="hacked"))
    custom = eps.save(EnginePresetRow(name="Mine", providerId="local-llamacpp", model="m-mine"))
    stores.get_feature_preset_ref_store().set("critique", custom.id)
    stores.set_default_preset_id(custom.id)

    assert client.post("/v1/ai/engine-presets/reset").status_code == 200

    fac = next(p for p in eps.list() if p.id == "p_fac")
    assert fac.name == "Factory" and fac.model == "m-fac"                              # built-in restored
    assert any(p.id == custom.id for p in eps.list())                                  # custom kept
    assert stores.get_feature_preset_ref_store().list().get("critique") == "p_fac"     # factory ref restored
    assert stores.get_default_preset_id() == "p_fac"                                   # default restored


def test_reset_one_preset(client):
    from llm_runner.llm.presets_api import EnginePresetRow, PresetFlagRow

    seed.configure_app_seed(
        engine_presets=[{"id": "p_one", "name": "One", "provider_id": "local-llamacpp",
                         "model": "m1", "temperature": 0.2, "samplers": {"seed": "7"}}],
        feature_presets={}, default_preset_id="",
    )
    s = db.session()
    try:
        seed.seed_default_engine_presets(s)
        s.commit()
    finally:
        s.close()
    eps = stores.get_engine_preset_store()
    eps.save(EnginePresetRow(id="p_one", name="WRONG", providerId="local-llamacpp", model="bad",
                             temperature=0.99, samplers=[PresetFlagRow(flagName="top_k", flagValue="1")]))

    assert client.post("/v1/ai/engine-presets/p_one/reset").status_code == 200

    one = next(p for p in eps.list() if p.id == "p_one")
    assert one.name == "One" and one.model == "m1" and one.temperature == 0.2
    assert {x.flagName for x in one.samplers} == {"seed"}                 # factory samplers restored
    # a custom preset has no factory → 400
    custom = eps.save(EnginePresetRow(name="Custom", providerId="local-llamacpp", model="c"))
    assert client.post(f"/v1/ai/engine-presets/{custom.id}/reset").status_code == 400


def test_engine_preset_name_refresh(client):
    # a factory rename (name_was → name) reaches existing DBs for a still-old-named
    # built-in, but a user who renamed the built-in keeps their name (1:1 alignment).
    seed.configure_app_seed(
        engine_presets=[
            {"id": "p_a", "name": "New A", "name_was": "Old A", "provider_id": "local-llamacpp", "model": "m"},
            {"id": "p_b", "name": "New B", "name_was": "Old B", "provider_id": "local-llamacpp", "model": "m"},
        ],
        feature_presets={}, default_preset_id="",
    )
    s = db.session()
    try:
        s.add(db.EnginePreset(id="p_a", name="Old A", provider_id="local-llamacpp", model="m", built_in=True))
        s.add(db.EnginePreset(id="p_b", name="My Own B", provider_id="local-llamacpp", model="m", built_in=True))
        s.commit()
        seed.seed_default_engine_presets(s)
        s.commit()
    finally:
        s.close()
    names = {p.id: p.name for p in stores.get_engine_preset_store().list()}
    assert names["p_a"] == "New A"      # refreshed (still carried the old default name)
    assert names["p_b"] == "My Own B"   # user rename survives


def test_engine_preset_delete_removes_children(client):
    from llm_runner.llm.presets_api import EnginePresetRow, PresetFlagRow

    eps = stores.get_engine_preset_store()
    p = eps.save(EnginePresetRow(
        name="P", providerId="local-llamacpp", model="m",
        samplers=[PresetFlagRow(flagName="top_k", flagValue="40")],
    ))
    s = db.session()
    try:
        assert s.query(db.EnginePresetSampler).filter_by(preset_id=p.id).count() == 1
    finally:
        s.close()

    eps.delete(p.id)

    s = db.session()
    try:
        assert s.query(db.EnginePreset).filter_by(id=p.id).count() == 0
        assert s.query(db.EnginePresetSampler).filter_by(preset_id=p.id).count() == 0
    finally:
        s.close()
