# SPDX-License-Identifier: MIT
"""The thinking CAPABILITY GATE (approved 2026-08-06 — decision text in
JustVoice's TASKS): effective thinking = the task's want AND the model can
think. `model_thinks` answers the second half in three layers — catalog row
(trusted, editable) → family name patterns → unknown = None (the gate
PERMITS; never worse than before the gate)."""

from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from llm_runner.llm import (
    FeaturePinConfig,
    LLMConfig,
    LLMMessage,
    LLMRegistry,
    LLMResponse,
    StreamDelta,
    chat,
    db,
    stream_chat,
)
from llm_runner.llm.capability import _name_says, model_thinks


class FakeAdapter:
    def __init__(self, provider_id, default_model="m-default"):
        self.provider_id = provider_id
        self.provider_type = "openai-compat"
        self.default_model = default_model
        self.calls = []

    def chat(self, messages, *, model=None, temperature=0.7, max_tokens=None,
             system=None, think=False, extra=None):
        self.calls.append({"model": model, "think": think, "extra": extra})
        return LLMResponse(text="ok", model=model or self.default_model,
                           prompt_tokens=3, completion_tokens=5)

    def stream_chat(self, messages, *, model=None, temperature=0.7, max_tokens=None,
                    system=None, think=False, extra=None):
        self.calls.append({"model": model, "think": think, "extra": extra, "stream": True})
        yield StreamDelta(text="ok")
        yield StreamDelta(done=True, prompt_tokens=1, completion_tokens=1)

    def models(self):
        return [self.default_model]

    def ping(self):
        return True


def _reg(*adapters):
    reg = LLMRegistry()
    for a in adapters:
        reg.register(a)
    return reg


def _cfg(model: str) -> LLMConfig:
    return LLMConfig(feature_pins=[
        FeaturePinConfig(feature="f", providerId="cloud", model=model),
    ])


def _fresh_db():
    eng = create_engine("sqlite://")
    db.LlmBase.metadata.create_all(eng)
    db.configure_storage(sessionmaker(bind=eng, autoflush=False))


# ── The name layer's truth table ─────────────────────────────────────

def test_name_layer_truth_table():
    yes = [
        "deepseek-r1:14b", "qwen3:0.6b", "qwen3-30b-a3b", "o3-mini", "o1",
        "gpt-5", "claude-fable-5", "claude-3-7-sonnet", "gemini-2.5-pro",
        "magistral-small",            # reasoning-first beats the mistral pattern
        "some-model-thinking",
    ]
    no = [
        "gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo",
        "claude-3-5-sonnet", "claude-3-haiku", "llama-3.1-8b",
        "mistral-small-24b", "gemini-1.5-pro", "phi-3-mini",
    ]
    unknown = ["acme-secret-13b", "gemma-3-12b", ""]
    for m in yes:
        assert _name_says(m) is True, m
    for m in no:
        assert _name_says(m) is False, m
    for m in unknown:
        assert _name_says(m) is None, m


# ── The catalog layer wins over the name layer ───────────────────────

def test_catalog_flag_wins_both_ways():
    _fresh_db()
    s = db.session()
    try:
        # A name that SAYS thinker, flagged off — the row wins (user's edit).
        s.add(db.ModelCatalog(id="deepseek-r1-mine", name="x", thinking=False))
        # A name that says nothing, flagged on.
        s.add(db.ModelCatalog(id="acme-chat-13b", name="y", thinking=True))
        s.commit()
    finally:
        s.close()
    assert model_thinks("deepseek-r1-mine") is False
    assert model_thinks("acme-chat-13b") is True
    # No row → the name layer answers.
    assert model_thinks("gpt-4o") is False
    assert model_thinks("totally-unknown-7b") is None


# ── The gate at dispatch ─────────────────────────────────────────────

def test_gate_blocks_known_nonthinker():
    _fresh_db()
    a = FakeAdapter("cloud")
    resp = chat(
        config=_cfg("gpt-4o"), feature="f", registry=_reg(a),
        messages=[LLMMessage(role="user", content="hi")],
        think=True, extra={"reasoning_effort": "high"},
    )
    assert resp.text == "ok"
    call = a.calls[-1]
    assert call["think"] is False
    # _apply_reasoning strips the ask when think is off — no dead key on the wire.
    assert not (call["extra"] or {}).get("reasoning_effort")
    assert "reasoning_budget_tokens" not in (call["extra"] or {})


def test_gate_permits_unknown_model():
    _fresh_db()
    a = FakeAdapter("cloud")
    chat(
        config=_cfg("acme-secret-13b"), feature="f", registry=_reg(a),
        messages=[LLMMessage(role="user", content="hi")], think=True,
    )
    assert a.calls[-1]["think"] is True


def test_gate_respects_catalog_true_on_nonthinker_name():
    """The user flips the flag on a model our name table is wrong about —
    the catalog wins and thinking flows."""
    _fresh_db()
    s = db.session()
    try:
        s.add(db.ModelCatalog(id="gpt-4o", name="the-exception", thinking=True))
        s.commit()
    finally:
        s.close()
    a = FakeAdapter("cloud")
    chat(
        config=_cfg("gpt-4o"), feature="f", registry=_reg(a),
        messages=[LLMMessage(role="user", content="hi")], think=True,
    )
    assert a.calls[-1]["think"] is True


def test_gate_in_stream_path():
    _fresh_db()
    a = FakeAdapter("cloud")
    list(stream_chat(
        config=_cfg("gpt-4o"), feature="f", registry=_reg(a),
        messages=[LLMMessage(role="user", content="hi")], think=True,
    ))
    assert a.calls[-1]["think"] is False
