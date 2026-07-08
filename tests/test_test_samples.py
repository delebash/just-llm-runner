# SPDX-License-Identifier: GPL-3.0-or-later
"""The §7.3 Lab test samples: /v1/ai/test-samples CRUD + the fill-if-empty seed."""

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
        "taskKind": "prose.generate", "label": "Storm scene",
        "variables": {"text": "The lighthouse keeper counted the storm's breaths."},
    }).json()
    assert len(r["rows"]) == 1
    row = r["rows"][0]
    assert row["taskKind"] == "prose.generate" and row["variables"]["text"].startswith("The lighthouse")
    # taskKind filter: another kind sees nothing
    assert client.get("/v1/ai/test-samples", params={"taskKind": "ideation"}).json()["rows"] == []
    # upsert by id replaces the variable set wholesale
    r2 = client.put("/v1/ai/test-samples", json={
        "id": row["id"], "taskKind": "prose.generate", "label": "Storm scene",
        "variables": {"text": "New text.", "tone": "grim"},
    }).json()
    assert r2["rows"][0]["variables"] == {"text": "New text.", "tone": "grim"}
    d = client.delete("/v1/ai/test-samples", params={"id": row["id"]}).json()
    assert d["rows"] == []


def test_put_requires_kind_and_label(client):
    assert client.put("/v1/ai/test-samples", json={"taskKind": " ", "label": "x"}).status_code == 400
    assert client.put("/v1/ai/test-samples", json={"taskKind": "k", "label": ""}).status_code == 400


def test_seed_fill_inserts_only_missing(client):
    rows = [
        {"taskKind": "ideation", "label": "Premise seeds", "variables": {"user_content": "A city that forgets."}},
        {"taskKind": "prose.edit", "label": "Flabby paragraph", "variables": {"text": "It was very really quite windy."}},
    ]
    s = db.session()
    try:
        assert stores.get_test_sample_store().seed_fill(s, rows) == 2
        s.commit()
    finally:
        s.close()
    # The user EDITS one row (same kind+label, new variables) …
    got = client.get("/v1/ai/test-samples", params={"taskKind": "ideation"}).json()["rows"][0]
    client.put("/v1/ai/test-samples", json={
        "id": got["id"], "taskKind": "ideation", "label": "Premise seeds",
        "variables": {"user_content": "MY edited premise."},
    })
    # … and a reseed adds nothing / clobbers nothing.
    s = db.session()
    try:
        assert stores.get_test_sample_store().seed_fill(s, rows) == 0
        s.commit()
    finally:
        s.close()
    kept = client.get("/v1/ai/test-samples", params={"taskKind": "ideation"}).json()["rows"][0]
    assert kept["variables"]["user_content"] == "MY edited premise."
