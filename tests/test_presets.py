# SPDX-License-Identifier: GPL-3.0-or-later
"""The engine-preset router + resolver — CRUD, the default/taskKind/per-feature
assignment layers, and the 3-tier resolve cascade (per-feature override → taskKind
preset → global default; the override tier restored 2026-07-14), over an in-memory DB."""

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
        stores.get_feature_preset_ref_store,
    ))
    return TestClient(app, raise_server_exceptions=False)


def _pid(resp, name):
    """The id of the just-created preset by name (the list is position-ordered, so
    the newest isn't index 0)."""
    return next(p["id"] for p in resp.json()["presets"] if p["name"] == name)


def test_preset_crud_roundtrip(client):
    r = client.post("/v1/ai/engine-presets", json={
        "name": "Prose · Qwen-14B", "providerId": "llamacpp", "model": "qwen3-14b-q4_k_m",
        "temperature": 0.9, "maxTokens": 2048,
        "samplers": [{"flagName": "top_k", "flagValue": "40"}],
    })
    assert r.status_code == 200
    presets = r.json()["presets"]
    assert len(presets) == 1
    p = presets[0]
    assert p["id"] and p["model"] == "qwen3-14b-q4_k_m" and p["temperature"] == 0.9
    assert p["samplers"][0]["flagName"] == "top_k"
    # §7.1: presets carry NO launch switches — the wire row has no such field, and a
    # stale client still sending one is ignored (pydantic drops unknown keys).
    assert "switches" not in p and "nglOverride" not in p
    pid = p["id"]

    # update replaces the sampler-tail child; a stale `switches` key is ignored
    r = client.put(f"/v1/ai/engine-presets/{pid}", json={
        "name": "Prose · Qwen-14B", "providerId": "llamacpp", "model": "qwen3-14b-q4_k_m",
        "temperature": 0.8, "switches": [{"flagName": "flash_attn", "flagValue": "on"}],
        "samplers": [{"flagName": "min_p", "flagValue": "0.05"}],
    })
    p = r.json()["presets"][0]
    assert p["temperature"] == 0.8 and p["samplers"][0]["flagName"] == "min_p"
    assert "switches" not in p

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
    assert asg["features"] == {}  # the per-feature override layer is present (restored 2026-07-14), none set yet
    # a per-feature override PUT lands in `features`, keyed by action id
    asg = client.put("/v1/ai/preset-assignments/feature",
                     json={"featureKey": "writerAI.continue", "presetId": a}).json()
    assert asg["features"]["writerAI.continue"] == a
    # clear-features drops the override(s) → the feature re-inherits its taskKind
    asg = client.post("/v1/ai/preset-assignments/clear-features",
                      json={"featureKeys": ["writerAI.continue"]}).json()
    assert "writerAI.continue" not in asg["features"]
    # clearing a taskKind assignment drops the row
    asg = client.put("/v1/ai/preset-assignments/task-kind",
                     json={"taskKind": "prose.generate", "presetId": ""}).json()
    assert "prose.generate" not in asg["taskKinds"]


def test_resolve_cascade(client):
    from llm_runner.llm import stores
    from llm_runner.llm.preset_resolve import resolve_feature_preset, resolve_task_preset

    a = _pid(client.post("/v1/ai/engine-presets", json={"name": "A", "model": "m-a"}), "A")
    b = _pid(client.post("/v1/ai/engine-presets", json={"name": "B", "model": "m-b"}), "B")
    c = _pid(client.post("/v1/ai/engine-presets", json={"name": "C", "model": "m-c"}), "C")
    client.put("/v1/ai/preset-assignments/default", json={"presetId": a})
    client.put("/v1/ai/preset-assignments/task-kind", json={"taskKind": "prose.generate", "presetId": b})
    client.put("/v1/ai/preset-assignments/feature", json={"featureKey": "writerAI.continue", "presetId": c})

    # 3-tier: the feature's OWN override wins over its taskKind preset + the default
    assert resolve_feature_preset("writerAI.continue", "prose.generate").model == "m-c"
    # no override → the taskKind's preset
    assert resolve_feature_preset("writerAI.expand", "prose.generate").model == "m-b"
    # no override, unmapped taskKind → the global default
    assert resolve_feature_preset("brainstorm", "judge.scored").model == "m-a"
    # the task-grain resolver ignores the per-feature override (Tasks page + reset paths)
    assert resolve_task_preset("prose.generate").model == "m-b"

    # clearing the override → the feature re-inherits its taskKind preset
    client.put("/v1/ai/preset-assignments/feature", json={"featureKey": "writerAI.continue", "presetId": ""})
    assert resolve_feature_preset("writerAI.continue", "prose.generate").model == "m-b"

    # a DANGLING override (its preset was deleted, the ref row survives on the FK-off
    # runner path) falls THROUGH to the taskKind preset rather than stranding at None
    stores.get_feature_preset_ref_store().set("writerAI.tighten", "ghost-preset-id")
    assert resolve_feature_preset("writerAI.tighten", "prose.generate").model == "m-b"

    # nothing configured at all → None (caller falls back to legacy routing)
    client.put("/v1/ai/preset-assignments/default", json={"presetId": ""})
    client.put("/v1/ai/preset-assignments/task-kind", json={"taskKind": "prose.generate", "presetId": ""})
    assert resolve_feature_preset("brainstorm", "judge.scored") is None
