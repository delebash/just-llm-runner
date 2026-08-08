# SPDX-License-Identifier: MIT
"""The shared /v1/prefs router contract (platform.prefs_api).

Dict-backed hooks — the router's own semantics are what's under test; each
host's storage is pinned by that app's suite (JV test_prefs, JW test_prefs,
docgen test_prefs)."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from llm_runner.platform import make_prefs_router


def make_client() -> tuple[TestClient, dict]:
    store: dict = {}
    app = FastAPI()
    app.include_router(
        make_prefs_router(
            read_all=lambda: dict(store),
            write_many=lambda patch: store.update(patch),
            clear=store.clear,
        )
    )
    return TestClient(app), store


def test_get_starts_empty():
    client, _ = make_client()
    r = client.get("/v1/prefs")
    assert r.status_code == 200
    assert r.json() == {}


def test_patch_upserts_and_returns_merged_document():
    client, _ = make_client()
    r = client.patch("/v1/prefs", json={"appearance": {"mode": "dark"}, "n": 1})
    assert r.status_code == 200
    assert r.json() == {"appearance": {"mode": "dark"}, "n": 1}
    r = client.patch("/v1/prefs", json={"n": 2})
    assert r.json() == {"appearance": {"mode": "dark"}, "n": 2}


def test_patch_is_wholesale_per_key_not_a_deep_merge():
    # The donor contract's reason to exist: sending the SMALLER map removes the
    # dropped entry — a deep merge could never express the deletion.
    client, _ = make_client()
    client.patch("/v1/prefs", json={"hidden": {"a": True, "b": True}})
    r = client.patch("/v1/prefs", json={"hidden": {"a": True}})
    assert r.json()["hidden"] == {"a": True}


def test_delete_clears_via_the_host_hook():
    client, store = make_client()
    client.patch("/v1/prefs", json={"x": [1, 2, 3]})
    r = client.delete("/v1/prefs")
    assert r.status_code == 204
    assert store == {}
    assert client.get("/v1/prefs").json() == {}
