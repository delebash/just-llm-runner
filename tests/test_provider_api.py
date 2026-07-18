# SPDX-License-Identifier: GPL-3.0-or-later
"""The shared provider-CRUD router factory (over an in-memory ProviderStore)."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from llm_runner.llm import get_llm_registry
from llm_runner.llm.provider_api import make_provider_router
from llm_runner.llm.schema import LLMProviderConfig


class MemStore:
    """In-memory ProviderStore for tests."""

    def __init__(self):
        self._rows: list[LLMProviderConfig] = []

    def list(self):
        return list(self._rows)

    def get(self, pid):
        return next((p for p in self._rows if p.id == pid), None)

    def add(self, cfg):
        self._rows.append(cfg)

    def replace(self, pid, cfg):
        self._rows = [cfg if p.id == pid else p for p in self._rows]

    def remove(self, pid):
        self._rows = [p for p in self._rows if p.id != pid]


def _client(store, allow_key_reveal=False):
    get_llm_registry()._adapters = {}
    app = FastAPI()
    app.include_router(make_provider_router(lambda: store, allow_key_reveal=allow_key_reveal))
    return TestClient(app, raise_server_exceptions=False)


def test_crud_lifecycle_and_registry_sync():
    store = MemStore()
    c = _client(store)

    # create — persisted + registered live
    r = c.post("/v1/llm-providers", json={
        "id": "oa", "name": "OpenAI", "providerType": "openai",
        "apiKey": "sk-x", "defaultModel": "gpt-4o-mini",
    })
    assert r.status_code == 201
    body = r.json()
    assert body["hasApiKey"] is True and "apiKey" not in body and body["registered"] is True
    assert body["local"] is True  # default Local/Online choice round-trips
    assert "oa" in get_llm_registry().ids()

    # list reflects the registered flag, never echoes the key
    lst = c.get("/v1/llm-providers").json()
    assert [p["id"] for p in lst["providers"]] == ["oa"]
    assert "openai" in lst["providerTypes"]

    # duplicate id rejected
    assert c.post("/v1/llm-providers", json={"id": "oa", "name": "x", "providerType": "openai"}).status_code == 400
    # bad type rejected
    assert c.post("/v1/llm-providers", json={"id": "z", "name": "x", "providerType": "nope"}).status_code == 400

    # patch — empty apiKey preserves the prior key
    r = c.patch("/v1/llm-providers/oa", json={
        "id": "oa", "name": "OpenAI 2", "providerType": "openai",
        "apiKey": "", "defaultModel": "gpt-4o",
    })
    assert r.status_code == 200 and r.json()["name"] == "OpenAI 2"
    assert store.get("oa").apiKey == "sk-x"  # preserved
    assert store.get("oa").defaultModel == "gpt-4o"

    # patch missing → 404
    assert c.patch("/v1/llm-providers/nope", json={"id": "nope", "name": "x", "providerType": "openai"}).status_code == 404

    # delete — removed + deregistered
    assert c.delete("/v1/llm-providers/oa").json() == {"deleted": True}
    assert store.get("oa") is None and "oa" not in get_llm_registry().ids()
    assert c.delete("/v1/llm-providers/oa").status_code == 404


def test_id_derived_from_name_and_local_flag():
    """No id supplied → slug derived from name (+ deduped); the Local/Online
    choice is stored and echoed, not inferred from the URL."""
    store = MemStore()
    c = _client(store)

    r = c.post("/v1/llm-providers", json={"name": "My Local LLM", "providerType": "openai-compat", "local": True})
    assert r.status_code == 201
    assert r.json()["id"] == "my-local-llm" and r.json()["local"] is True

    # same name again → deduped, not a collision error
    r2 = c.post("/v1/llm-providers", json={"name": "My Local LLM", "providerType": "openai-compat"})
    assert r2.status_code == 201 and r2.json()["id"] == "my-local-llm-2"

    # an online provider keeps local=False even at a non-URL-revealing endpoint
    r3 = c.post("/v1/llm-providers", json={"name": "OpenAI", "providerType": "openai", "local": False})
    assert r3.json()["id"] == "openai" and r3.json()["local"] is False


def test_patch_apikey_empty_preserves_even_when_local_flips():
    """#1 regression (2026-07-08): the form used to send apiKey=None whenever the
    where-it-runs toggle read Local, silently wiping a stored key on every save of
    a mis-flagged online provider. Contract locked here: "" preserves the key no
    matter what `local` says; None stays the EXPLICIT clear for deliberate clients
    (the fixed form only ever sends None on create, where there is nothing to
    preserve)."""
    store = MemStore()
    c = _client(store)
    c.post("/v1/llm-providers", json={
        "name": "Claude", "providerType": "anthropic", "apiKey": "sk-a", "local": False,
    })
    assert store.get("claude").apiKey == "sk-a"

    # the fixed-form edit body: "" preserves — even with local=true in the same body
    r = c.patch("/v1/llm-providers/claude", json={
        "name": "Claude", "providerType": "anthropic", "apiKey": "", "local": True,
    })
    assert r.status_code == 200
    assert store.get("claude").apiKey == "sk-a"
    assert r.json()["hasApiKey"] is True

    # explicit clear remains available: None wipes
    r = c.patch("/v1/llm-providers/claude", json={
        "name": "Claude", "providerType": "anthropic", "apiKey": None, "local": False,
    })
    assert r.status_code == 200
    assert store.get("claude").apiKey is None
    assert r.json()["hasApiKey"] is False


def test_key_reveal_opt_in_returns_stored_key():
    """#12 C6: when the host opts in (allow_key_reveal=True — JW, guarded by its
    origin-check middleware), POST /key/reveal returns the stored plaintext key so the
    form can pre-fill a masked, editable field; an unknown id 404s. The GET/list still
    never echoes the key (test above); reveal is the deliberate, POST-only exception."""
    store = MemStore()
    c = _client(store, allow_key_reveal=True)
    c.post("/v1/llm-providers", json={
        "name": "Claude", "providerType": "anthropic", "apiKey": "sk-secret", "local": False,
    })
    r = c.post("/v1/llm-providers/claude/key/reveal")
    assert r.status_code == 200 and r.json() == {"apiKey": "sk-secret"}
    # a provider with no stored key reveals ""
    c.post("/v1/llm-providers", json={"name": "Keyless", "providerType": "openai-compat", "local": True})
    assert c.post("/v1/llm-providers/keyless/key/reveal").json() == {"apiKey": ""}
    # unknown id → 404
    assert c.post("/v1/llm-providers/nope/key/reveal").status_code == 404


def test_key_reveal_absent_by_default():
    """The SAFE default (allow_key_reveal off) — an app that does NOT guard mutating
    /v1 with an origin check (JustVoice) mounts make_provider_router with no flag, so
    the credential-returning route is simply NOT registered (404). Fires-proof for the
    JV inherits-the-safe-default branch of the origin-guard requirement."""
    store = MemStore()
    c = _client(store)  # default allow_key_reveal=False
    c.post("/v1/llm-providers", json={
        "name": "Claude", "providerType": "anthropic", "apiKey": "sk-secret", "local": False,
    })
    assert c.post("/v1/llm-providers/claude/key/reveal").status_code == 404


def test_detect_local(monkeypatch):
    import httpx

    from llm_runner.llm.provider_api import PROVIDER_TYPES

    class FakeResp:
        status_code = 200

        def __init__(self, payload):
            self._payload = payload

        def json(self):
            return self._payload

    def fake_get(url, timeout=None):
        if "11434" in url:  # Ollama /api/tags
            return FakeResp({"models": [{"name": "qwen3:14b"}]})
        if "1234" in url:  # LM Studio /v1/models (OpenAI shape)
            return FakeResp({"data": [{"id": "lmstudio-model"}]})
        raise ConnectionError("down")

    monkeypatch.setattr(httpx, "get", fake_get)
    det = _client(MemStore()).get("/v1/llm-providers/detect-local").json()["detected"]
    by_type = {d["providerType"]: d for d in det}
    assert "qwen3:14b" in by_type["ollama"]["models"]
    assert by_type["ollama"]["alreadyRegistered"] is False
    # LM Studio must detect as the CANONICAL openai-compat — a creatable
    # PROVIDER_TYPES value, not "openai_compat" which would 400 on create.
    assert "lmstudio-model" in by_type["openai-compat"]["models"]
    assert all(d["providerType"] in PROVIDER_TYPES for d in det)
