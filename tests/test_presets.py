# SPDX-License-Identifier: GPL-3.0-or-later
"""The engine-preset router + resolver (2026-06-29 lab + preset model; 2026-07-02
Plan A "task owns the preset") — CRUD, the default/taskKind assignment layers, and the
2-tier resolve cascade, over an in-memory DB."""

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
        stores.get_engine_preset_store, stores.get_task_kind_preset_store,
        lambda: stores.get_task_kind_preset_store().list().get("", ""),
        lambda pid: stores.get_task_kind_preset_store().set("", pid),
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
    client.put("/v1/ai/preset-assignments/task-kind", json={"taskKind": "prose.generate", "presetId": b})
    asg = client.get("/v1/ai/preset-assignments").json()
    assert asg["defaultPresetId"] == a
    assert asg["taskKinds"]["prose.generate"] == b
    assert "features" not in asg  # Plan A: the per-feature override layer is gone
    # clearing a taskKind assignment drops the row
    asg = client.put("/v1/ai/preset-assignments/task-kind",
                     json={"taskKind": "prose.generate", "presetId": ""}).json()
    assert "prose.generate" not in asg["taskKinds"]


def test_resolve_cascade(client):
    from llm_runner.llm.preset_resolve import resolve_task_preset

    a = _pid(client.post("/v1/ai/engine-presets", json={"name": "A", "model": "m-a"}), "A")
    b = _pid(client.post("/v1/ai/engine-presets", json={"name": "B", "model": "m-b"}), "B")
    client.put("/v1/ai/preset-assignments/default", json={"presetId": a})
    client.put("/v1/ai/preset-assignments/task-kind", json={"taskKind": "prose.generate", "presetId": b})
    # a mapped taskKind → the taskKind's preset
    assert resolve_task_preset("prose.generate").model == "m-b"
    # an unmapped taskKind → the global default
    assert resolve_task_preset("judge.scored").model == "m-a"
    # nothing configured at all → None (caller falls back to legacy routing)
    client.put("/v1/ai/preset-assignments/default", json={"presetId": ""})
    client.put("/v1/ai/preset-assignments/task-kind", json={"taskKind": "prose.generate", "presetId": ""})
    assert resolve_task_preset("judge.scored") is None
