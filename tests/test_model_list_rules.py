# SPDX-License-Identifier: MIT
"""Online-provider model-list cleanup (#8, 2026-07-20).

Three layers: the pure rule ENGINE (classify / anchored-regex drops / dated-collapse /
invalid-regex resilience / show-all / hiddenCount), the ENDPOINTS applying the SHIPPED
seeds to realistic OpenAI- and Gemini-style fixtures, and the STORE (one JSON doc in the
runner-settings store) with seed / user-edit / reset / seed-refresh + the CRUD router."""

from __future__ import annotations

import json

import sqlalchemy as sa
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from llm_runner.llm import db, get_llm_registry, seed, stores
from llm_runner.llm.api import router, set_model_list_rules_resolver
from llm_runner.llm.model_list_rules import (
    SEED_VERSION,
    apply_rules,
    seed_doc,
)
from llm_runner.llm.model_list_rules_api import make_model_list_rules_router

# ── realistic fixtures (representative ids, NOT a current-flagship allowlist) ──────────
# Every id is here to exercise a PATTERN class, so the fixture proves the shipped seeds
# behave — with no dependence on any specific live model string.
OPENAI_RAW = [
    # modern chat survivors — o-series (reasoning) KEPT; gpt-45 proves the anchored
    # `^gpt-4($|[.o-])` does NOT swallow a future flagship the way a bare "gpt-4" prefix would.
    "gpt-5", "gpt-5-mini", "gpt-45-turbo", "o3", "o3-mini", "o4-mini",
    # legacy chat (dropped)
    "gpt-4", "gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4-turbo",
    "gpt-3.5-turbo", "chatgpt-4o-latest",
    # non-chat families (dropped)
    "gpt-image-1", "gpt-realtime", "gpt-audio", "gpt-live-1", "sora-2",
    "dall-e-3", "tts-1", "tts-1-hd", "whisper-1", "omni-moderation-latest",
    "text-moderation-stable", "computer-use-preview", "davinci-002", "babbage-002",
    # preview / instant snapshots (dropped)
    "gpt-5-chat-preview", "some-model-instant",
    # embeddings (classified into the embed bucket)
    "text-embedding-3-small", "text-embedding-3-large",
]
OPENAI_CHAT = {"gpt-5", "gpt-5-mini", "gpt-45-turbo", "o3", "o3-mini", "o4-mini"}
OPENAI_EMBED = {"text-embedding-3-small", "text-embedding-3-large"}

GEMINI_RAW = [
    "gemini-3.5-flash", "gemini-3.1-pro", "gemini-2.5-flash",
    "gemini-3.5-pro-preview",  # KEPT — Gemini ships preview-first, no blanket -preview drop
    "gemini-1.0-pro", "gemini-1.5-flash", "gemini-2.0-flash",  # legacy, dropped
    "imagen-3.0", "veo-3.1", "lyria-2", "aqa", "learnlm-2",     # families, dropped
    "gemini-2.5-flash-tts", "gemini-live-2.5", "gemini-3-pro-image",  # -tts/-live/-image
    "gemini-flash-exp",                                          # -exp
    "gemini-embedding-001", "text-embedding-004",               # embeddings
]
GEMINI_CHAT = {"gemini-3.5-flash", "gemini-3.1-pro", "gemini-2.5-flash", "gemini-3.5-pro-preview"}
GEMINI_EMBED = {"gemini-embedding-001", "text-embedding-004"}


# ══ 1. the pure rule engine ═══════════════════════════════════════════════════════════

def _openai_rule():
    return seed_doc()["rules"]["openai"]


def test_classifies_embeddings_out_of_chat():
    res = apply_rules(OPENAI_RAW, _openai_rule())
    assert set(res.embeddings) == OPENAI_EMBED
    assert not (set(res.models) & OPENAI_EMBED)  # no embed leaks into chat


def test_drops_legacy_and_non_chat_families_keeps_flagships():
    res = apply_rules(OPENAI_RAW, _openai_rule())
    assert set(res.models) == OPENAI_CHAT
    for gone in ("gpt-4", "gpt-4o", "gpt-3.5-turbo", "dall-e-3", "tts-1",
                 "whisper-1", "sora-2", "computer-use-preview", "davinci-002"):
        assert gone not in res.models


def test_anchor_does_not_swallow_a_future_flagship():
    # The whole reason for anchored regexes over bare prefixes (v2): a prefix "gpt-4"
    # would hide "gpt-45"; the anchored `^gpt-4($|[.o-])` spares it while dropping gpt-4/4o.
    res = apply_rules(["gpt-4", "gpt-4o", "gpt-45-turbo", "gpt-5"], _openai_rule())
    assert "gpt-45-turbo" in res.models and "gpt-5" in res.models
    assert "gpt-4" not in res.models and "gpt-4o" not in res.models


def test_o_series_reasoning_models_kept():
    res = apply_rules(["o1", "o3", "o3-mini", "o4-mini", "gpt-4o"], _openai_rule())
    assert set(res.models) == {"o1", "o3", "o3-mini", "o4-mini"}


def test_gemini_keeps_preview_first_models():
    res = apply_rules(GEMINI_RAW, seed_doc()["rules"]["gemini"])
    assert set(res.models) == GEMINI_CHAT
    assert "gemini-3.5-pro-preview" in res.models  # the no-preview-drop judgment call
    assert set(res.embeddings) == GEMINI_EMBED
    for gone in ("imagen-3.0", "veo-3.1", "lyria-2", "aqa", "gemini-1.5-flash",
                 "gemini-2.0-flash", "gemini-2.5-flash-tts", "gemini-3-pro-image"):
        assert gone not in res.models


def test_collapse_dated_alias_present_prefers_alias():
    rule = {"collapseDated": True, "embedPatterns": [], "dropPatterns": []}
    res = apply_rules(["gpt-x", "gpt-x-2026-05-01", "gpt-x-2026-07-09"], rule)
    assert res.models == ["gpt-x"]        # the bare alias was fetched → wins
    assert res.hidden_count == 2          # two snapshots folded away


def test_collapse_dated_alias_absent_uses_newest_snapshot():
    rule = {"collapseDated": True, "embedPatterns": [], "dropPatterns": []}
    res = apply_rules(["gpt-y-2026-05-01", "gpt-y-2026-07-09"], rule)
    assert res.models == ["gpt-y-2026-07-09"]  # newest snapshot, never the invented alias


def test_collapse_dated_never_invents_an_unfetched_id():
    rule = {"collapseDated": True, "embedPatterns": [], "dropPatterns": []}
    res = apply_rules(["only-2026-01-01"], rule)
    assert res.models == ["only-2026-01-01"]   # emit the fetched id verbatim, not "only"


def test_invalid_regex_is_skipped_not_raised():
    # A user-typed broken pattern must degrade to under-filter, never 500.
    rule = {"collapseDated": False, "embedPatterns": ["("], "dropPatterns": ["[", "^dropme$"]}
    res = apply_rules(["keepme", "dropme"], rule)
    assert res.models == ["keepme"]  # valid drop applied, invalid ones skipped
    assert res.embeddings == []


def test_classification_wins_over_drop():
    # An id matching BOTH an embed and a drop pattern lands in the embed bucket (shown),
    # never dropped.
    rule = {"collapseDated": False, "embedPatterns": ["embed"], "dropPatterns": ["^text-"]}
    res = apply_rules(["text-embedding-3", "text-davinci"], rule)
    assert res.embeddings == ["text-embedding-3"]
    assert res.models == []                # text-davinci dropped
    assert "text-embedding-3" not in res.models


def test_show_all_bypasses_every_rule():
    res = apply_rules(OPENAI_RAW, _openai_rule(), show_all=True)
    assert res.models == OPENAI_RAW
    assert res.embeddings == [] and res.hidden_count == 0


def test_none_rule_is_passthrough():
    res = apply_rules(["a", "b"], None)
    assert res.models == ["a", "b"] and res.embeddings == [] and res.hidden_count == 0


def test_hidden_count_accounts_for_every_removed_id():
    res = apply_rules(OPENAI_RAW, _openai_rule())
    assert res.hidden_count == len(OPENAI_RAW) - len(res.models) - len(res.embeddings)
    assert res.hidden_count > 0


# ══ 2. the endpoints (shipped seeds applied to the fixtures) ═══════════════════════════

class _StubAdapter:
    def __init__(self, provider_id, provider_type, models):
        self.provider_id = provider_id
        self.provider_type = provider_type
        self.default_model = ""
        self._models = models

    def models(self):
        return list(self._models)

    def ping(self):
        return True


def _client():
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def _with_seeds_and_adapter(adapter):
    reg = get_llm_registry()
    reg._adapters = {}
    reg.register(adapter)
    set_model_list_rules_resolver(lambda: seed_doc()["rules"])


def _teardown():
    set_model_list_rules_resolver(None)
    get_llm_registry()._adapters = {}


def test_saved_endpoint_applies_openai_rules():
    _with_seeds_and_adapter(_StubAdapter("oai", "openai", OPENAI_RAW))
    try:
        body = _client().get("/v1/llm-providers/oai/models").json()
        assert set(body["models"]) == OPENAI_CHAT
        assert set(body["embeddings"]) == OPENAI_EMBED
        assert body["hiddenCount"] == len(OPENAI_RAW) - len(OPENAI_CHAT) - len(OPENAI_EMBED)
    finally:
        _teardown()


def test_saved_endpoint_all_query_bypasses():
    _with_seeds_and_adapter(_StubAdapter("oai", "openai", OPENAI_RAW))
    try:
        body = _client().get("/v1/llm-providers/oai/models?all=1").json()
        assert body["models"] == OPENAI_RAW
        assert body["embeddings"] == [] and body["hiddenCount"] == 0
    finally:
        _teardown()


def test_saved_endpoint_gemini_rules():
    _with_seeds_and_adapter(_StubAdapter("gem", "gemini", GEMINI_RAW))
    try:
        body = _client().get("/v1/llm-providers/gem/models").json()
        assert set(body["models"]) == GEMINI_CHAT
        assert set(body["embeddings"]) == GEMINI_EMBED
    finally:
        _teardown()


def test_unknown_type_passes_through():
    # A provider TYPE with no rules row is under-filter-safe: the raw list is returned.
    _with_seeds_and_adapter(_StubAdapter("who", "some-new-vendor", ["a", "b", "c"]))
    try:
        body = _client().get("/v1/llm-providers/who/models").json()
        assert body["models"] == ["a", "b", "c"] and body["hiddenCount"] == 0
    finally:
        _teardown()


def test_probe_endpoint_applies_rules():
    # The draft probe builds a temporary adapter; a dead base URL yields [] from the
    # openai-compat adapter, so assert the SHAPE + the rule application on a live-ish list
    # via the classification of a compat 'embed' id.
    set_model_list_rules_resolver(lambda: seed_doc()["rules"])
    try:
        r = _client().post("/v1/llm-providers/probe-models",
                           json={"providerType": "openai-compat", "baseUrl": "http://127.0.0.1:9/v1"})
        assert r.status_code == 200
        body = r.json()
        assert body["models"] == [] and body["embeddings"] == [] and body["hiddenCount"] == 0
    finally:
        set_model_list_rules_resolver(None)


# ══ 3. the store: one JSON doc in the runner-settings store ════════════════════════════

def _fresh_db():
    eng = sa.create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    db.LlmBase.metadata.create_all(eng)
    db.configure_storage(sessionmaker(bind=eng, autoflush=False))


def test_seed_creates_the_doc():
    _fresh_db()
    s = db.session()
    assert seed.seed_model_list_rules(s) == 1
    s.commit()
    s.close()
    doc = stores.get_model_list_rules()
    assert doc == seed_doc()
    assert doc["seedVersion"] == SEED_VERSION
    assert "openai" in doc["rules"] and "gemini" in doc["rules"]


def test_get_defaults_to_seed_when_unseeded():
    _fresh_db()
    # No row at all → the store still returns a well-formed doc (the resolver never breaks).
    assert stores.get_model_list_rules() == seed_doc()


def test_put_persists_and_marks_user_modified():
    _fresh_db()
    s = db.session()
    seed.seed_model_list_rules(s)
    s.commit()
    s.close()
    custom = {"seedVersion": SEED_VERSION, "rules": {"openai": {
        "embedPatterns": ["^my-embed"], "dropPatterns": [], "collapseDated": False}}}
    stores.set_model_list_rules(custom)
    assert stores.get_model_list_rules() == custom
    s = db.session()
    assert s.get(db.RunnerSetting, "model_list_rules").built_in is False
    s.close()


def test_reseed_never_clobbers_a_user_edit():
    _fresh_db()
    s = db.session()
    seed.seed_model_list_rules(s)
    s.commit()
    s.close()
    stores.set_model_list_rules({"seedVersion": SEED_VERSION, "rules": {"x": {
        "embedPatterns": [], "dropPatterns": ["^drop-me"], "collapseDated": False}}})
    s = db.session()
    seed.seed_model_list_rules(s)  # a boot reseed
    s.commit()
    s.close()
    assert stores.get_model_list_rules()["rules"] == {"x": {
        "embedPatterns": [], "dropPatterns": ["^drop-me"], "collapseDated": False}}


def test_seed_refresh_updates_an_unmodified_stale_doc():
    _fresh_db()
    # A prior seed version, still built_in (the user never PUT it) → a reseed refreshes it.
    s = db.session()
    s.add(db.RunnerSetting(
        key="model_list_rules",
        value=json.dumps({"seedVersion": 0, "rules": {}}, sort_keys=True),
        built_in=True))
    s.commit()
    seed.seed_model_list_rules(s)
    s.commit()
    s.close()
    assert stores.get_model_list_rules() == seed_doc()


def test_reset_snaps_back_to_seed_and_rearms_refresh():
    _fresh_db()
    stores.set_model_list_rules({"seedVersion": 99, "rules": {"custom": {
        "embedPatterns": [], "dropPatterns": [], "collapseDated": True}}})
    stores.reset_model_list_rules()
    assert stores.get_model_list_rules() == seed_doc()
    s = db.session()
    assert s.get(db.RunnerSetting, "model_list_rules").built_in is True
    s.close()


def test_router_get_put_reset_round_trip():
    _fresh_db()
    s = db.session()
    seed.seed_model_list_rules(s)
    s.commit()
    s.close()
    app = FastAPI()
    app.include_router(make_model_list_rules_router(
        stores.get_model_list_rules, stores.set_model_list_rules, stores.reset_model_list_rules))
    c = TestClient(app)

    got = c.get("/v1/ai/model-list-rules").json()
    assert got["seedVersion"] == SEED_VERSION and "openai" in got["rules"]

    edited = {"seedVersion": SEED_VERSION, "rules": {"openai": {
        "embedPatterns": ["^custom-embed"], "dropPatterns": ["^drop"], "collapseDated": True}}}
    put = c.put("/v1/ai/model-list-rules", json=edited).json()
    assert put["rules"]["openai"]["embedPatterns"] == ["^custom-embed"]
    assert stores.get_model_list_rules()["rules"]["openai"]["dropPatterns"] == ["^drop"]

    reset = c.post("/v1/ai/model-list-rules/reset").json()
    assert reset == json.loads(json.dumps(seed_doc()))  # back to the shipped seed
