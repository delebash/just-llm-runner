# SPDX-License-Identifier: MIT
"""Per-model embedding task templates (Move 0, RAG build 2026-07-11):
/v1/ai/embeddings wraps inputs with the model's catalog template per taskType
(nomic prefixes both sides, Qwen3 instructs the query side; no row = raw), the
rows are seeded + editable, and the generic feature-prompt stale-heal carries a
host's prompt-text revision to unedited existing DBs."""

from __future__ import annotations

import sqlalchemy as sa
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from llm_runner.llm import LLMResponse, db, get_llm_registry, seed, stores
from llm_runner.llm.api import router, set_embed_template_resolver
from llm_runner.llm.embed_templates_api import EmbedTemplateRow, make_embed_templates_router


class RecordingEmbedAdapter:
    provider_id = "emb"
    provider_type = "openai-compat"
    default_model = "m"
    last_texts: list[str] | None = None

    def chat(self, messages, **k):
        return LLMResponse(text="ok", model="m", prompt_tokens=1, completion_tokens=1)

    def embed(self, texts, *, model=None, task_type=""):
        # task_type accepted + ignored — the route passes it unconditionally now
        # (#15 C5); this fake records the (already template-wrapped) texts.
        RecordingEmbedAdapter.last_texts = list(texts)
        return [[0.1, 0.2] for _ in texts]


class _TplRow:
    def __init__(self, document="", query=""):
        self.documentTemplate = document
        self.queryTemplate = query


def _client():
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def _with_fake_registry():
    reg = get_llm_registry()
    reg._adapters = {}
    reg.register(RecordingEmbedAdapter())
    RecordingEmbedAdapter.last_texts = None


def test_embeddings_apply_document_and_query_templates():
    _with_fake_registry()
    set_embed_template_resolver(
        lambda mid: _TplRow("search_document: {text}", "search_query: {text}") if mid == "nomic" else None
    )
    try:
        c = _client()
        r = c.post("/v1/ai/embeddings", json={
            "providerId": "emb", "model": "nomic", "input": ["a", "b"], "taskType": "document"})
        assert r.status_code == 200
        assert RecordingEmbedAdapter.last_texts == ["search_document: a", "search_document: b"]

        c.post("/v1/ai/embeddings", json={
            "providerId": "emb", "model": "nomic", "input": ["who is X"], "taskType": "query"})
        assert RecordingEmbedAdapter.last_texts == ["search_query: who is X"]
    finally:
        set_embed_template_resolver(None)
        get_llm_registry()._adapters = {}


def test_embeddings_pass_through_cases():
    _with_fake_registry()
    set_embed_template_resolver(
        lambda mid: _TplRow("", "Instruct: task\nQuery: {text}") if mid == "qwen" else None
    )
    try:
        c = _client()
        # No template row for the model (online/BYO) → raw.
        c.post("/v1/ai/embeddings", json={
            "providerId": "emb", "model": "text-embedding-3-small", "input": ["a"], "taskType": "query"})
        assert RecordingEmbedAdapter.last_texts == ["a"]
        # Empty taskType → raw even when a row exists.
        c.post("/v1/ai/embeddings", json={"providerId": "emb", "model": "qwen", "input": ["a"]})
        assert RecordingEmbedAdapter.last_texts == ["a"]
        # Document side empty on a query-only model → raw documents.
        c.post("/v1/ai/embeddings", json={
            "providerId": "emb", "model": "qwen", "input": ["a"], "taskType": "document"})
        assert RecordingEmbedAdapter.last_texts == ["a"]
        # Query side applies.
        c.post("/v1/ai/embeddings", json={
            "providerId": "emb", "model": "qwen", "input": ["a"], "taskType": "query"})
        assert RecordingEmbedAdapter.last_texts == ["Instruct: task\nQuery: a"]
    finally:
        set_embed_template_resolver(None)
        get_llm_registry()._adapters = {}


def test_embeddings_no_resolver_is_raw():
    _with_fake_registry()
    set_embed_template_resolver(None)
    try:
        _client().post("/v1/ai/embeddings", json={
            "providerId": "emb", "model": "nomic-embed-text", "input": ["a"], "taskType": "document"})
        assert RecordingEmbedAdapter.last_texts == ["a"]
    finally:
        get_llm_registry()._adapters = {}


# ── DB: seed + store + router round-trip ─────────────────────────────────────

def _fresh_db():
    eng = sa.create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    db.LlmBase.metadata.create_all(eng)
    db.configure_storage(sessionmaker(bind=eng, autoflush=False))


def test_shared_seed_is_empty_and_registered_app_templates_seed():
    """Decision ④ (family parity batch 2026-08-05): an embed template describes an
    APP's catalog row, so the shared DEFAULT_EMBED_TEMPLATES is empty and an app
    registers its own via install_llm(embed_templates=…) — carried on both seed
    paths by the _APP registration. (The old JW-content assertions — the Qwen3/
    KaLM ladder facts — moved to justwrite-app's server tests with the data.)"""
    assert seed.DEFAULT_EMBED_TEMPLATES == []
    _fresh_db()
    seed.configure_app_seed(embed_templates=[
        {"id": "app-embed", "document": "", "query": "Instruct: app task\nQuery: {text}"},
    ])
    try:
        s = db.session()
        seed.seed_default_embed_templates(s)
        s.commit()
        s.close()
        row = stores.get_embed_template_store().get("app-embed")
        assert row.documentTemplate == "" and row.queryTemplate.startswith("Instruct: ")
    finally:
        seed.configure_app_seed(embed_templates=[])  # never leak into sibling tests


def test_seed_never_clobbers_user_edit():
    _fresh_db()
    seed.configure_app_seed(embed_templates=[
        {"id": "app-embed", "document": "", "query": "Instruct: app task\nQuery: {text}"},
    ])
    try:
        s = db.session()
        seed.seed_default_embed_templates(s)
        s.commit()
        s.close()
        st = stores.get_embed_template_store()
        st.upsert(EmbedTemplateRow(modelId="app-embed", documentTemplate="my: {text}", queryTemplate=""))
        s = db.session()
        seed.seed_default_embed_templates(s)  # reseed = merge-by-id
        s.commit()
        s.close()
        assert st.get("app-embed").documentTemplate == "my: {text}"
    finally:
        seed.configure_app_seed(embed_templates=[])


def test_router_crud_round_trip():
    _fresh_db()
    app = FastAPI()
    app.include_router(make_embed_templates_router(stores.get_embed_template_store))
    c = TestClient(app)
    r = c.put("/v1/ai/embed-templates", json={
        "modelId": "my-embed", "documentTemplate": "d: {text}", "queryTemplate": "q: {text}"})
    assert r.status_code == 200
    rows = {x["modelId"]: x for x in r.json()["rows"]}
    assert rows["my-embed"]["documentTemplate"] == "d: {text}"
    r = c.delete("/v1/ai/embed-templates", params={"modelId": "my-embed"})
    assert all(x["modelId"] != "my-embed" for x in r.json()["rows"])
    assert c.put("/v1/ai/embed-templates", json={"modelId": " "}).status_code == 400


# ── the generic feature-prompt stale-heal (host-provided map) ────────────────

def test_prompt_heal_refreshes_only_unedited_rows():
    _fresh_db()
    old_text = "OLD chat system"
    new_text = "NEW chat system with story bible"
    seed.configure_app_seed(feature_prompts={
        "chat": {"feature": "chat", "system": old_text, "user_template": "u1"},
        "other": {"feature": "other", "system": "other sys", "user_template": "u2"},
    })
    try:
        s = db.session()
        seed.seed_default_feature_prompts(s)
        s.commit()
        s.close()

        # The host revises the seed text and registers the heal for the OLD text.
        seed.configure_app_seed(
            feature_prompts={
                "chat": {"feature": "chat", "system": new_text, "user_template": "u1-new"},
                "other": {"feature": "other", "system": "other sys CHANGED", "user_template": "u2"},
            },
            feature_prompt_heals={"chat": [old_text]},
        )
        s = db.session()
        seed.seed_default_feature_prompts(s)
        s.commit()
        chat_row = s.get(db.FeaturePrompt, "chat")
        other_row = s.get(db.FeaturePrompt, "other")
        # Healed: system byte-equalled the registered old text → system refreshed;
        # user_template is deliberately NOT healed (a user may have edited it).
        assert chat_row.system == new_text and chat_row.user_template == "u1"
        # No heal registered for "other" → insert-if-missing leaves it stale (by design).
        assert other_row.system == "other sys"
        s.close()

        # A USER-EDITED prompt is never touched, even with the heal registered.
        s = db.session()
        s.get(db.FeaturePrompt, "chat").system = "the user's own words"
        s.commit()
        seed.seed_default_feature_prompts(s)
        s.commit()
        assert s.get(db.FeaturePrompt, "chat").system == "the user's own words"
        s.close()
    finally:
        seed.configure_app_seed(feature_prompts={}, feature_prompt_heals={})
