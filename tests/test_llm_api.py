# SPDX-License-Identifier: MIT
"""The shared storage-free LLM router (usage / ping / models)."""

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


def test_ping_and_models_use_registry():
    reg = get_llm_registry()
    reg._adapters = {}
    reg.register(FakeAdapter())
    c = _client()
    assert c.post("/v1/llm-providers/fake/ping").json() == {"ok": True}
    # The models endpoint returns the back-compatible {models, embeddings, hiddenCount}
    # shape (#8). No rules resolver is wired in this bare-router test → passthrough: the
    # raw list is the chat bucket, nothing classified as embedding, nothing hidden.
    assert c.get("/v1/llm-providers/fake/models").json() == {
        "models": ["m1", "m2"], "embeddings": [], "hiddenCount": 0}
    assert c.post("/v1/llm-providers/nope/ping").status_code == 404
    reg._adapters = {}


def _builtin_fixture(monkeypatch, tmp_path, *, cached_repos, installed=True):
    """Wire the built-in branch's three lazy imports (they resolve at CALL time, so
    patching the modules is what reaches them)."""
    from types import SimpleNamespace

    import llm_runner.llm.stores as stores
    import llm_runner.runner.lifecycle as lifecycle
    import llm_runner.runner.models as runner_models

    rows = [
        SimpleNamespace(id="on-disk", hfRepo="org/a", quant="Q4_K_M", mmproj=None),
        SimpleNamespace(id="catalog-only", hfRepo="org/b", quant="Q4_K_M", mmproj=None),
    ]
    monkeypatch.setattr(lifecycle, "get_service", lambda: SimpleNamespace(
        engine_status=lambda: {"installed": installed, "build": "b9993", "gpu": "cuda"},
        cache_root=tmp_path,
    ))
    monkeypatch.setattr(stores, "get_model_catalog_store",
                        lambda: SimpleNamespace(list=lambda: rows))
    monkeypatch.setattr(runner_models, "is_cached",
                        lambda repo, quant, *, cache_root, mmproj=None: repo in cached_repos)


def test_builtin_models_lists_only_downloaded(monkeypatch, tmp_path):
    """The built-in provider answers "what can run RIGHT NOW" — the models list is what
    is ON DISK, never every catalog row (user ruling 2026-07-16; the route's own comment
    always claimed "every downloaded model" but the filter did not exist, so a seeded
    Hugging Face reference appeared in every model picker). The catalog is the place you
    download FROM."""
    _builtin_fixture(monkeypatch, tmp_path, cached_repos={"org/a"})
    body = _client().get("/v1/llm-providers/local-llamacpp/models").json()
    assert body["models"] == ["on-disk"]        # the un-downloaded row is NOT offered
    assert "error" not in body


def test_builtin_health_counts_downloaded_and_total(monkeypatch, tmp_path):
    """The health line names BOTH numbers: a short/empty picker reads as "download one",
    not as a broken provider. And a catalog with nothing on disk is NOT ok — nothing can
    run until something is fetched."""
    _builtin_fixture(monkeypatch, tmp_path, cached_repos=set())
    body = _client().get("/v1/llm-providers/local-llamacpp/models").json()
    assert body["models"] == []
    assert "0 of 2 models downloaded" in body["error"]


class FakeEmbedAdapter(FakeAdapter):
    provider_id = "emb"
    seen_task_type = None  # records what the route passed through (#15 C5)

    def embed(self, texts, *, model=None, task_type=""):
        self.seen_task_type = task_type
        return [[0.1, 0.2, 0.3] for _ in texts]


def test_embeddings_via_registry():
    reg = get_llm_registry()
    reg._adapters = {}
    reg.register(FakeEmbedAdapter())
    reg.register(FakeAdapter())  # has no embed()
    c = _client()
    r = c.post("/v1/ai/embeddings", json={"providerId": "emb", "model": "e", "input": ["a", "b"]})
    assert r.status_code == 200
    body = r.json()
    assert len(body["embeddings"]) == 2 and body["embeddings"][0] == [0.1, 0.2, 0.3]
    assert body["model"] == "e"
    # A registered provider with no embeddings support → clear 400.
    assert c.post("/v1/ai/embeddings", json={"providerId": "fake", "input": ["x"]}).status_code == 400
    # Unregistered → 404.
    assert c.post("/v1/ai/embeddings", json={"providerId": "nope", "input": ["x"]}).status_code == 404
    reg._adapters = {}


def test_embeddings_passes_task_type_through():
    # C5: the route calls embed(task_type=body.taskType) UNCONDITIONALLY (no signature
    # sniffing) — a Gemini embed model needs the RETRIEVAL_* side. Fires-proof: RED
    # before the api.py pass-through (the fake never saw the side); GREEN after.
    reg = get_llm_registry()
    reg._adapters = {}
    fake = FakeEmbedAdapter()
    reg.register(fake)
    c = _client()
    r = c.post("/v1/ai/embeddings",
               json={"providerId": "emb", "model": "e", "input": ["a"], "taskType": "query"})
    assert r.status_code == 200
    assert fake.seen_task_type == "query"   # the route handed body.taskType to the adapter
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
