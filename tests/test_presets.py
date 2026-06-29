# SPDX-License-Identifier: GPL-3.0-or-later
"""The engine-preset router + resolver (2026-06-29 lab + preset model) — CRUD, the
default/category/feature assignment layers, and the resolve cascade, over an
in-memory DB."""

from __future__ import annotations

import pytest
import sqlalchemy as sa
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from llm_runner.llm import db, stores
from llm_runner.llm.presets_api import make_presets_router


@pytest.fixture
def client():
    engine = sa.create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    db.LlmBase.metadata.create_all(engine)
    db.configure_storage(sessionmaker(bind=engine))
    app = FastAPI()
    app.include_router(make_presets_router(
        stores.get_engine_preset_store, stores.get_category_preset_store,
        stores.get_feature_preset_ref_store,
        lambda: stores.get_category_preset_store().list().get("", ""),
        lambda pid: stores.get_category_preset_store().set("", pid),
    ))
    return TestClient(app, raise_server_exceptions=False)


def _pid(resp, name):
    """The id of the just-created preset by name (the list is position-ordered, so
    the newest isn't index 0)."""
    return next(p["id"] for p in resp.json()["presets"] if p["name"] == name)


def test_preset_crud_roundtrip(client):
    r = client.post("/v1/ai/engine-presets", json={
        "name": "Prose · Qwen-27B", "providerId": "llamacpp", "model": "qwen3.6-27b",
        "temperature": 0.9, "maxTokens": 2048, "nCpuMoeOverride": 28,
        "switches": [{"flagName": "flash_attn", "flagValue": "on"}],
        "samplers": [{"flagName": "top_k", "flagValue": "40"}],
    })
    assert r.status_code == 200
    presets = r.json()["presets"]
    assert len(presets) == 1
    p = presets[0]
    assert p["id"] and p["model"] == "qwen3.6-27b" and p["temperature"] == 0.9
    assert p["nCpuMoeOverride"] == 28 and p["nglOverride"] is None  # set wins, unset stays auto (null)
    assert p["switches"][0]["flagName"] == "flash_attn"
    assert p["samplers"][0]["flagName"] == "top_k"
    pid = p["id"]

    # update replaces the children (frozen switches + sampler tail)
    r = client.put(f"/v1/ai/engine-presets/{pid}", json={
        "name": "Prose · Qwen-27B", "providerId": "llamacpp", "model": "qwen3.6-27b",
        "temperature": 0.8, "switches": [], "samplers": [{"flagName": "min_p", "flagValue": "0.05"}],
    })
    p = r.json()["presets"][0]
    assert p["temperature"] == 0.8 and p["switches"] == [] and p["samplers"][0]["flagName"] == "min_p"

    assert client.delete(f"/v1/ai/engine-presets/{pid}").json()["presets"] == []
    assert client.put("/v1/ai/engine-presets/nope", json={"name": "x"}).status_code == 404


def test_assignment_layers(client):
    a = _pid(client.post("/v1/ai/engine-presets", json={"name": "A", "model": "m-a"}), "A")
    b = _pid(client.post("/v1/ai/engine-presets", json={"name": "B", "model": "m-b"}), "B")
    client.put("/v1/ai/preset-assignments/default", json={"presetId": a})
    client.put("/v1/ai/preset-assignments/category", json={"category": "Writing", "presetId": b})
    client.put("/v1/ai/preset-assignments/feature", json={"featureKey": "brainstorm", "presetId": a})
    asg = client.get("/v1/ai/preset-assignments").json()
    assert asg["defaultPresetId"] == a
    assert asg["categories"]["Writing"] == b
    assert asg["features"]["brainstorm"] == a
    # clearing the feature override drops the row
    asg = client.put("/v1/ai/preset-assignments/feature", json={"featureKey": "brainstorm", "presetId": ""}).json()
    assert "brainstorm" not in asg["features"]


def test_clear_features_bulk(client):
    a = _pid(client.post("/v1/ai/engine-presets", json={"name": "A", "model": "m-a"}), "A")
    for key in ("brainstorm", "describe", "summarize"):
        client.put("/v1/ai/preset-assignments/feature", json={"featureKey": key, "presetId": a})
    # the per-category "reset" clears just that category's feature overrides
    asg = client.post("/v1/ai/preset-assignments/clear-features",
                      json={"featureKeys": ["brainstorm", "describe"]}).json()
    assert "brainstorm" not in asg["features"] and "describe" not in asg["features"]
    assert asg["features"]["summarize"] == a  # an unrelated override is untouched


def test_resolve_cascade(client):
    from llm_runner.llm.preset_resolve import resolve_feature_preset

    a = _pid(client.post("/v1/ai/engine-presets", json={"name": "A", "model": "m-a"}), "A")
    b = _pid(client.post("/v1/ai/engine-presets", json={"name": "B", "model": "m-b"}), "B")
    client.put("/v1/ai/preset-assignments/default", json={"presetId": a})
    client.put("/v1/ai/preset-assignments/category", json={"category": "Writing", "presetId": b})
    # in a mapped category → the category's preset
    assert resolve_feature_preset("brainstorm", "Writing").model == "m-b"
    # in an unmapped category → the global default
    assert resolve_feature_preset("summarize", "Analysis").model == "m-a"
    # a per-feature override wins over the category
    client.put("/v1/ai/preset-assignments/feature", json={"featureKey": "brainstorm", "presetId": a})
    assert resolve_feature_preset("brainstorm", "Writing").model == "m-a"
    # nothing configured at all → None (caller falls back to legacy routing)
    client.put("/v1/ai/preset-assignments/default", json={"presetId": ""})
    client.put("/v1/ai/preset-assignments/category", json={"category": "Writing", "presetId": ""})
    client.put("/v1/ai/preset-assignments/feature", json={"featureKey": "brainstorm", "presetId": ""})
    assert resolve_feature_preset("summarize", "Analysis") is None
