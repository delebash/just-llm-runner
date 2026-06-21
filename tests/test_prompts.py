# SPDX-License-Identifier: GPL-3.0-or-later
"""The shared prompt subsystem — render, the editor router, and the
feature-execution router (all over an in-memory PromptStore)."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from llm_runner.llm import (
    FeaturePromptRow,
    LLMConfig,
    LLMResponse,
    StreamDelta,
    get_llm_registry,
    make_feature_router,
    make_prompt_router,
    render,
)

# ── a host store + seed defaults, in memory ─────────────────────────────────
DEFAULTS = {
    "greet": {
        "feature": "greet",
        "system": "You are {{role}}.",
        "user_template": "Hi {{name}}",
        "temperature": 0.3,
        "think": False,
    },
    "farewell": {
        "feature": "greet",  # two actions can share one routing feature
        "system": "You are {{role}}.",
        "user_template": "Bye {{name}}",
        "temperature": 0.5,
        "think": False,
    },
}


class MemPromptStore:
    """In-memory PromptStore for tests; seeded from DEFAULTS."""

    def __init__(self):
        self._rows: dict[str, FeaturePromptRow] = {}
        for key, spec in DEFAULTS.items():
            self._rows[key] = FeaturePromptRow(
                key=key, feature=spec["feature"], system=spec["system"],
                user_template=spec["user_template"], temperature=spec["temperature"],
                think=spec["think"], built_in=True,
            )

    def get(self, key):
        return self._rows.get(key)

    def list(self):
        return [self._rows[k] for k in sorted(self._rows)]

    def upsert(self, row):
        # mirror the real store: built_in is preserved on update, set on insert
        existing = self._rows.get(row.key)
        if existing is not None:
            row.built_in = existing.built_in
        self._rows[row.key] = row


class CaptureAdapter:
    """Records the system + user content it's handed so tests can assert the
    rendered prompt reached the model."""

    def __init__(self):
        self.provider_id = "fake"
        self.provider_type = "openai-compat"
        self.default_model = "m"
        self.last = {}

    def chat(self, messages, *, model=None, temperature=0.7, max_tokens=None,
             system=None, think=False, extra=None):
        self.last = {"system": system, "user": messages[-1].content, "think": think}
        return LLMResponse(text="answer", model=model or self.default_model)

    def stream_chat(self, messages, *, model=None, temperature=0.7, max_tokens=None,
                    system=None, think=False, extra=None):
        self.last = {"system": system, "user": messages[-1].content, "stream": True}
        yield StreamDelta(text="ans")
        yield StreamDelta(text="wer")
        yield StreamDelta(done=True, prompt_tokens=2, completion_tokens=4)

    def models(self):
        return [self.default_model]

    def ping(self):
        return True


def _editor_client(store):
    app = FastAPI()
    app.include_router(make_prompt_router(lambda: store, DEFAULTS))
    return TestClient(app, raise_server_exceptions=False)


def _feature_client(store, *, register=True):
    """Mount the execution router; optionally register a CaptureAdapter into the
    global registry the dispatch reads (the router calls dispatch without an
    explicit registry)."""
    get_llm_registry()._adapters = {}
    adapter = CaptureAdapter()
    if register:
        get_llm_registry().register(adapter)
    app = FastAPI()
    app.include_router(make_feature_router(lambda: store, lambda: LLMConfig()))
    return TestClient(app, raise_server_exceptions=False), adapter


# ── render ──────────────────────────────────────────────────────────────────
def test_render_substitutes_and_blanks_missing():
    assert render("Hi {{name}}, you are {{role}}", {"name": "Sam", "role": "bot"}) == "Hi Sam, you are bot"
    assert render("{{ name }} spaced", {"name": "X"}) == "X spaced"
    assert render("missing {{nope}} here", {}) == "missing  here"


# ── editor router ─────────────────────────────────────────────────────────────
def test_list_get_and_404():
    c = _editor_client(MemPromptStore())
    lst = c.get("/v1/ai/prompts").json()["prompts"]
    assert {p["key"] for p in lst} == {"greet", "farewell"}
    one = c.get("/v1/ai/prompts/greet").json()
    assert one["userTemplate"] == "Hi {{name}}" and one["builtIn"] is True
    assert c.get("/v1/ai/prompts/nope").status_code == 404


def test_edit_then_reset_roundtrip():
    store = MemPromptStore()
    c = _editor_client(store)
    # edit — a built-in key stays builtIn (so it can be reset)
    r = c.put("/v1/ai/prompts/greet", json={
        "system": "EDITED {{role}}", "userTemplate": "Yo {{name}}",
        "temperature": 0.9, "think": True,
    })
    assert r.status_code == 200 and r.json()["builtIn"] is True
    assert store.get("greet").system == "EDITED {{role}}"
    # reset — back to the seeded default text
    r = c.post("/v1/ai/prompts/greet/reset").json()
    assert r["system"] == "You are {{role}}." and r["userTemplate"] == "Hi {{name}}"
    # reset of a non-seeded key → 400
    assert c.post("/v1/ai/prompts/custom/reset").status_code == 400


def test_create_user_prompt_not_builtin():
    store = MemPromptStore()
    c = _editor_client(store)
    r = c.put("/v1/ai/prompts/custom", json={"feature": "custom", "system": "s", "userTemplate": "u"}).json()
    assert r["builtIn"] is False and r["feature"] == "custom"


# ── feature-execution router ─────────────────────────────────────────────────
def test_run_renders_prompt_and_returns_content():
    c, adapter = _feature_client(MemPromptStore())
    r = c.post("/v1/ai/run", json={"action": "farewell", "variables": {"name": "Sam", "role": "bot"}})
    assert r.status_code == 200
    assert r.json() == {"content": "answer", "model": "m"}
    # the DB template was rendered with the caller's variables before dispatch
    assert adapter.last["user"] == "Bye Sam"
    assert adapter.last["system"] == "You are bot."


def test_run_unknown_action_404():
    c, _ = _feature_client(MemPromptStore())
    assert c.post("/v1/ai/run", json={"action": "nope"}).status_code == 404


def test_run_no_provider_501():
    c, _ = _feature_client(MemPromptStore(), register=False)
    assert c.post("/v1/ai/run", json={"action": "greet", "variables": {"name": "x"}}).status_code == 501


def test_edit_changes_what_run_sends():
    store = MemPromptStore()
    editor = _editor_client(store)
    editor.put("/v1/ai/prompts/greet", json={
        "system": "NEW {{role}}", "userTemplate": "CHANGED {{name}}",
        "temperature": 0.3, "think": False,
    })
    c, adapter = _feature_client(store)
    c.post("/v1/ai/run", json={"action": "greet", "variables": {"name": "Sam", "role": "bot"}})
    assert adapter.last["user"] == "CHANGED Sam"
    assert adapter.last["system"] == "NEW bot"


def test_stream_emits_sse_frames():
    c, adapter = _feature_client(MemPromptStore())
    with c.stream("POST", "/v1/ai/stream", json={"action": "greet", "variables": {"name": "Sam"}}) as r:
        body = "".join(chunk for chunk in r.iter_text())
    assert '"delta": "ans"' in body and '"delta": "wer"' in body
    assert '"done": true' in body and '"completionTokens": 4' in body
    assert body.strip().endswith("data: [DONE]")
    assert adapter.last["user"] == "Hi Sam"
