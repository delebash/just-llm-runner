# SPDX-License-Identifier: GPL-3.0-or-later
"""make_routing_router — GET merges catalog + stored pins; PUT persists."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from llm_runner.llm import (
    FeatureCatalogEntry,
    RoutingConfig,
    make_routing_router,
)


class _MemStore:
    def __init__(self):
        self._cfg = RoutingConfig()

    def get_routing(self):
        return self._cfg

    def set_routing(self, cfg):
        self._cfg = cfg


CATALOG = [
    FeatureCatalogEntry(key="critique", label="Critique", hint="line notes", category="Analysis"),
    FeatureCatalogEntry(key="brainstorm", label="Brainstorm", hint="ideas", category="Drafting"),
]


def _client():
    store = _MemStore()
    app = FastAPI()
    app.include_router(make_routing_router(lambda: store, lambda: CATALOG))
    return TestClient(app), store


def test_get_merges_catalog_with_empty_pins():
    client, _ = _client()
    body = client.get("/v1/ai/routing").json()
    assert body["default"] == {"llmId": "", "model": "", "embeddingId": "", "embeddingModel": ""}
    feats = {f["key"]: f for f in body["features"]}
    assert set(feats) == {"critique", "brainstorm"}
    assert feats["critique"]["label"] == "Critique"
    # No pin yet → empty route.
    assert feats["critique"]["providerId"] == "" and feats["critique"]["model"] == ""


def test_put_persists_defaults_and_pins():
    client, store = _client()
    payload = {
        "default": {"llmId": "openai", "embeddingId": "ollama-local"},
        "pins": {
            "critique": {"providerId": "openai", "model": "gpt-4o"},
        },
    }
    r = client.put("/v1/ai/routing", json=payload)
    assert r.status_code == 200
    # Persisted into the store.
    assert store.get_routing().default.llmId == "openai"
    assert store.get_routing().pins["critique"].model == "gpt-4o"
    # GET reflects it, merged onto the catalog rows.
    body = client.get("/v1/ai/routing").json()
    feats = {f["key"]: f for f in body["features"]}
    assert feats["critique"]["providerId"] == "openai" and feats["critique"]["model"] == "gpt-4o"
    assert feats["brainstorm"]["providerId"] == ""


def test_put_response_is_the_merged_view():
    client, _ = _client()
    r = client.put("/v1/ai/routing", json={"default": {"llmId": "x", "embeddingId": ""}})
    body = r.json()
    assert body["default"]["llmId"] == "x"
    assert len(body["features"]) == 2  # catalog still rendered
