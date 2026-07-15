# SPDX-License-Identifier: GPL-3.0-or-later
"""The §7.3 Lab test samples: /v1/ai/test-samples CRUD (keyed per ACTION, 2026-07-15)
+ the fill-if-empty seed with author-once fan-out."""

import sqlalchemy as sa
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from llm_runner.llm import db, stores
from llm_runner.llm.test_samples_api import make_test_samples_router


@pytest.fixture
def client():
    eng = sa.create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    db.create_all(eng)
    db.configure_storage(sessionmaker(bind=eng, autoflush=False))
    app = FastAPI()
    app.include_router(make_test_samples_router(stores.get_test_sample_store))
    return TestClient(app)


def test_put_get_delete_round_trip(client):
    r = client.put("/v1/ai/test-samples", json={
        "action": "writerAI.continue", "label": "Storm scene",
        "variables": {"passage": "The lighthouse keeper counted the storm's breaths."},
    }).json()
    assert len(r["rows"]) == 1
    row = r["rows"][0]
    assert row["action"] == "writerAI.continue" and row["variables"]["passage"].startswith("The lighthouse")
    # action filter: another action sees nothing
    assert client.get("/v1/ai/test-samples", params={"action": "brainstorm"}).json()["rows"] == []
    # upsert by id replaces the variable set wholesale
    r2 = client.put("/v1/ai/test-samples", json={
        "id": row["id"], "action": "writerAI.continue", "label": "Storm scene",
        "variables": {"passage": "New text.", "voiceCanon": "grim"},
    }).json()
    assert r2["rows"][0]["variables"] == {"passage": "New text.", "voiceCanon": "grim"}
    d = client.delete("/v1/ai/test-samples", params={"id": row["id"]}).json()
    assert d["rows"] == []


def test_put_requires_action_and_label(client):
    assert client.put("/v1/ai/test-samples", json={"action": " ", "label": "x"}).status_code == 400
    assert client.put("/v1/ai/test-samples", json={"action": "k", "label": ""}).status_code == 400


def test_seed_fill_fans_actions_and_skips_present(client):
    # ONE authored blob fans to its sibling actions (no copy-paste); fill-if-empty.
    rows = [
        {"actions": ["writerAI.expand", "writerAI.continue"], "label": "Storm",
         "variables": {"passage": "A storm."}},
        {"action": "brainstorm", "label": "Seed", "variables": {"user_content": "A city that forgets."}},
    ]
    s = db.session()
    try:
        # 2 actions in row 1 + 1 in row 2 = 3 rows
        assert stores.get_test_sample_store().seed_fill(s, rows) == 3
        s.commit()
    finally:
        s.close()
    # each sibling action got its own row from the one blob
    assert client.get("/v1/ai/test-samples", params={"action": "writerAI.expand"}).json()["rows"][0]["label"] == "Storm"
    assert client.get("/v1/ai/test-samples", params={"action": "writerAI.continue"}).json()["rows"][0]["label"] == "Storm"

    # the user EDITS one …
    got = client.get("/v1/ai/test-samples", params={"action": "brainstorm"}).json()["rows"][0]
    client.put("/v1/ai/test-samples", json={
        "id": got["id"], "action": "brainstorm", "label": "Seed",
        "variables": {"user_content": "MY edited premise."},
    })
    # … and a reseed adds nothing / clobbers nothing.
    s = db.session()
    try:
        assert stores.get_test_sample_store().seed_fill(s, rows) == 0
        s.commit()
    finally:
        s.close()
    kept = client.get("/v1/ai/test-samples", params={"action": "brainstorm"}).json()["rows"][0]
    assert kept["variables"]["user_content"] == "MY edited premise."
