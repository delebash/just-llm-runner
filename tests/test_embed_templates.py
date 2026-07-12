# SPDX-License-Identifier: GPL-3.0-or-later
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

    def embed(self, texts, *, model=None):
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


def test_seed_rows_match_model_cards():
    _fresh_db()
    s = db.session()
    seed.seed_default_embed_templates(s)
    s.commit()
    s.close()
    st = stores.get_embed_template_store()
    nomic = st.get("nomic-embed-text")
    assert nomic.documentTemplate == "search_document: {text}"
    assert nomic.queryTemplate == "search_query: {text}"
    for mid in ("qwen3-embedding-0.6b", "qwen3-embedding-4b", "qwen3-embedding-8b"):
        row = st.get(mid)
        assert row.documentTemplate == "" and row.queryTemplate.startswith("Instruct: ")
        assert "{text}" in row.queryTemplate
    assert st.get("bge-m3") is None  # needs no templates → no row


def test_embed_catalog_ladder_and_the_4b_row():
    """The seeded embed ladder (2026-07-12, reversing #274's "small card → 0.6B"). Embeds
    run on CPU by policy, so they are judged on RAM, not the VRAM leftover: the 4B joins the
    CPU band (tier "cpu" → ALWAYS eligible) and, being higher quality than the 0.6B, wins the
    pick on any box that clears its 8 GB RAM floor — while a box below that floor gets
    coarse_fit "no" and falls back to the 0.6B. The 8B stays a VRAM-gated (non-cpu) tier."""
    rows = {r["id"]: r for r in seed.DEFAULT_CATALOG}
    b4 = rows["qwen3-embedding-4b"]
    assert b4["embedding"] is True and b4["pooling"] == "last"
    assert b4["hf_repo"] == "Qwen/Qwen3-Embedding-4B-GGUF" and b4["quant"] == "Q4_K_M"
    assert b4["size_bytes"] == 2496703776 and b4["trained_ctx"] == 40960

    embeds = {rid: r for rid, r in rows.items() if r.get("embedding")}
    ranks = {rid: r["quality_rank"] for rid, r in embeds.items()}
    assert (
        ranks["qwen3-embedding-8b"]
        < ranks["qwen3-embedding-4b"]
        < ranks["qwen3-embedding-0.6b"]
        < ranks["bge-m3"]
        < ranks["nomic-embed-text"]
    )
    # The CPU band (always eligible — judged on RAM, not VRAM leftover) is the tiny trio
    # PLUS the 4B; only the 8B stays a VRAM-gated tier (the big-GPU rung).
    for rid in ("nomic-embed-text", "qwen3-embedding-0.6b", "bge-m3", "qwen3-embedding-4b"):
        assert embeds[rid]["tier"] == "cpu"
    assert embeds["qwen3-embedding-8b"]["tier"] != "cpu"
    # The ladder law: the 4B is the higher-quality CPU embed gated by a HIGHER RAM floor,
    # so ≥8 GB-RAM boxes default to the 4B and boxes below its floor fall back to the 0.6B.
    assert b4["min_ram_mb"] == 8000
    assert b4["min_ram_mb"] > embeds["qwen3-embedding-0.6b"]["min_ram_mb"]
    # The 4B rides the same instruct query template as its Qwen3 siblings.
    tpl = {t["id"]: t for t in seed.DEFAULT_EMBED_TEMPLATES}
    assert tpl["qwen3-embedding-4b"]["document"] == ""
    assert tpl["qwen3-embedding-4b"]["query"].startswith("Instruct: ")


def test_seed_never_clobbers_user_edit():
    _fresh_db()
    s = db.session()
    seed.seed_default_embed_templates(s)
    s.commit()
    s.close()
    st = stores.get_embed_template_store()
    st.upsert(EmbedTemplateRow(modelId="nomic-embed-text", documentTemplate="my: {text}", queryTemplate=""))
    s = db.session()
    seed.seed_default_embed_templates(s)  # reseed = merge-by-id
    s.commit()
    s.close()
    assert st.get("nomic-embed-text").documentTemplate == "my: {text}"


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
