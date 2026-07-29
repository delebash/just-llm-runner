# SPDX-License-Identifier: MIT
"""The draft-model-probe endpoint — lists a provider's models from an UNSAVED
draft (the Add/Edit form's "Fetch models" before the provider is registered)."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from llm_runner.llm.api import router


def _client():
    app = FastAPI()
    app.include_router(router)
    return TestClient(app, raise_server_exceptions=False)


def test_unknown_provider_type_400():
    r = _client().post("/v1/llm-providers/probe-models", json={"providerType": "nope"})
    assert r.status_code == 400


def test_known_type_unreachable_is_graceful():
    # A constructable type pointed at a dead port returns 200 with an empty list
    # (never a 500). The openai-compat adapter swallows its own connection error
    # and returns [], so the form just shows "no models" rather than crashing.
    r = _client().post(
        "/v1/llm-providers/probe-models",
        json={"providerType": "openai-compat", "baseUrl": "http://127.0.0.1:9/v1"},
    )
    assert r.status_code == 200
    assert r.json()["models"] == []
