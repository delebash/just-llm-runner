# SPDX-License-Identifier: GPL-3.0-or-later
"""The shared storage-free LLM router (classify-tier / usage / ping / models)."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from llm_runner.llm import LLMResponse, get_ledger, get_llm_registry
from llm_runner.llm.api import router
from llm_runner.llm.dispatch import chat
from llm_runner.llm.schema import LLMConfig


class FakeAdapter:
    provider_id = "fake"
    provider_type = "openai-compat"
    default_model = "m"

    def chat(self, messages, **k):
        return LLMResponse(text="ok", model="m", prompt_tokens=2, completion_tokens=3)

    def stream_chat(self, *a, **k):
        yield "ok"

    def models(self):
        return ["m1", "m2"]

    def ping(self):
        return True


def _client():
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def test_classify_tier():
    r = _client().post("/v1/llm-providers/classify-tier", json={"model": "qwen3:14b"})
    assert r.status_code == 200
    body = r.json()
    assert body["tier"] == "reasoned" and body["think"] is True


def test_ping_and_models_use_registry():
    reg = get_llm_registry()
    reg._adapters = {}
    reg.register(FakeAdapter())
    c = _client()
    assert c.post("/v1/llm-providers/fake/ping").json() == {"ok": True}
    assert c.get("/v1/llm-providers/fake/models").json() == {"models": ["m1", "m2"]}
    assert c.post("/v1/llm-providers/nope/ping").status_code == 404
    reg._adapters = {}


def test_ai_usage_reflects_ledger():
    get_ledger().clear()
    reg = get_llm_registry()
    reg._adapters = {}
    reg.register(FakeAdapter())
    chat(config=LLMConfig(), feature="demo", messages=[])
    c = _client()
    snap = c.get("/v1/ai-usage").json()
    assert snap["total_calls"] == 1 and snap["by_feature"]["demo"]["calls"] == 1
    assert c.request("DELETE", "/v1/ai-usage").json() == {"cleared": True}
    assert c.get("/v1/ai-usage").json()["total_calls"] == 0
    reg._adapters = {}
