# SPDX-License-Identifier: GPL-3.0-or-later
"""make_routing_router — GET merges catalog + the global default; PUT persists the
default. Per-feature pins were removed 2026-07-15 (the preset is the one source)."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from llm_runner.llm import (
    FeatureCatalogEntry,
    make_routing_router,
)
from llm_runner.llm.routing_api import RoutingConfig


class _MemStore:
    def __init__(self):
        self._cfg = RoutingConfig()

    def get_routing(self):
        return self._cfg

    def set_routing(self, cfg):
        self._cfg = cfg


CATALOG = [
    FeatureCatalogEntry(key="critique", label="Critique", hint="line notes", group="Analysis"),
    FeatureCatalogEntry(key="brainstorm", label="Brainstorm", hint="ideas", group="Drafting"),
]


def _client():
    store = _MemStore()
    app = FastAPI()
    app.include_router(make_routing_router(lambda: store, lambda: CATALOG))
    return TestClient(app), store


def test_get_merges_catalog_with_default():
    client, _ = _client()
    body = client.get("/v1/ai/routing").json()
    assert body["default"] == {"llmId": "", "model": "", "embeddingId": "", "embeddingModel": ""}
    feats = {f["key"]: f for f in body["features"]}
    assert set(feats) == {"critique", "brainstorm"}
    assert feats["critique"]["label"] == "Critique" and feats["critique"]["group"] == "Analysis"
    # Per-feature pins are gone — the row is catalog metadata only, and there is no
    # `pins` map on the response any more.
    assert "providerId" not in feats["critique"]
    assert "pins" not in body


def test_put_persists_defaults():
    client, store = _client()
    r = client.put("/v1/ai/routing", json={
        "default": {"llmId": "openai", "embeddingId": "ollama-local"},
    })
    assert r.status_code == 200
    assert store.get_routing().default.llmId == "openai"
    body = client.get("/v1/ai/routing").json()
    assert body["default"]["llmId"] == "openai"
    assert body["default"]["embeddingId"] == "ollama-local"


def test_put_response_is_the_merged_view():
    client, _ = _client()
    r = client.put("/v1/ai/routing", json={"default": {"llmId": "x", "embeddingId": ""}})
    body = r.json()
    assert body["default"]["llmId"] == "x"
    assert len(body["features"]) == 2  # catalog still rendered
