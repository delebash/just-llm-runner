# SPDX-License-Identifier: MIT
"""Thinking is sent EXACTLY as configured (the gate REMOVAL, ruled
2026-08-06 — "no fancy magic"; decision text in JustVoice's TASKS): no
send-time veto exists. `model_thinks` survives as ROUTING advice only
(JustVoice's Auto reads it) — catalog row (trusted, editable) → family name
patterns → unknown = None. A provider that can't take the thinking
parameter answers with its OWN error, re-raised with one fix-pointer
sentence when (and only when) the provider's message is about the
parameter we sent."""

from __future__ import annotations

import pytest
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
    def __init__(self, provider_id, default_model="m-default", fail_with=None):
        self.provider_id = provider_id
        self.provider_type = "openai-compat"
        self.default_model = default_model
        self.fail_with = fail_with
        self.calls = []

    def chat(self, messages, *, model=None, temperature=0.7, max_tokens=None,
             system=None, think=False, extra=None):
        self.calls.append({"model": model, "think": think, "extra": extra})
        if self.fail_with:
            raise ValueError(self.fail_with)
        return LLMResponse(text="ok", model=model or self.default_model,
                           prompt_tokens=3, completion_tokens=5)

    def stream_chat(self, messages, *, model=None, temperature=0.7, max_tokens=None,
                    system=None, think=False, extra=None):
        self.calls.append({"model": model, "think": think, "extra": extra, "stream": True})
        if self.fail_with:
            raise ValueError(self.fail_with)
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


# ── The name layer's truth table (ROUTING advice — JV's Auto) ────────

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


# ── Dispatch sends thinking EXACTLY as configured — no veto ──────────

def test_think_is_sent_even_to_a_known_nonthinker():
    """The removal's core law: the user's ask always goes out — even where
    the old gate would have stripped it (gpt-4o-class). The provider is the
    only authority that may refuse, with its own error."""
    _fresh_db()
    a = FakeAdapter("cloud")
    resp = chat(
        config=_cfg("gpt-4o"), feature="f", registry=_reg(a),
        messages=[LLMMessage(role="user", content="hi")],
        think=True, extra={"reasoning_effort": "high"},
    )
    assert resp.text == "ok"
    call = a.calls[-1]
    assert call["think"] is True
    # The reasoning ask rides the wire (resolved to the provider's dialect).
    assert (call["extra"] or {}).get("reasoning_effort")


def test_think_off_stays_off():
    _fresh_db()
    a = FakeAdapter("cloud")
    chat(
        config=_cfg("gpt-4o"), feature="f", registry=_reg(a),
        messages=[LLMMessage(role="user", content="hi")], think=False,
    )
    assert a.calls[-1]["think"] is False


def test_stream_path_sends_as_configured():
    _fresh_db()
    a = FakeAdapter("cloud")
    list(stream_chat(
        config=_cfg("gpt-4o"), feature="f", registry=_reg(a),
        messages=[LLMMessage(role="user", content="hi")], think=True,
    ))
    assert a.calls[-1]["think"] is True


# ── The honest error: provider words + ONE fix-pointer sentence ──────

def test_reasoning_rejection_carries_the_fix_pointer():
    _fresh_db()
    a = FakeAdapter(
        "cloud",
        fail_with="Unsupported parameter: 'reasoning_effort' is not supported with this model.",
    )
    with pytest.raises(RuntimeError) as ei:
        chat(
            config=_cfg("gpt-4o"), feature="f", registry=_reg(a),
            messages=[LLMMessage(role="user", content="hi")], think=True,
        )
    msg = str(ei.value)
    assert "reasoning_effort" in msg                      # the provider's own words
    assert "turn thinking off on this feature's preset" in msg  # the one fix line


def test_unrelated_errors_pass_through_untouched():
    """Auth/timeout/quota errors never get the thinking hint — the hint rides
    only when the provider's message is about the parameter we sent."""
    _fresh_db()
    a = FakeAdapter("cloud", fail_with="401 Unauthorized: bad api key")
    with pytest.raises(ValueError) as ei:
        chat(
            config=_cfg("gpt-4o"), feature="f", registry=_reg(a),
            messages=[LLMMessage(role="user", content="hi")], think=True,
        )
    assert "turn thinking off" not in str(ei.value)


def test_think_off_errors_never_get_the_hint():
    _fresh_db()
    a = FakeAdapter("cloud", fail_with="model produced no reasoning output")
    with pytest.raises(ValueError) as ei:
        chat(
            config=_cfg("gpt-4o"), feature="f", registry=_reg(a),
            messages=[LLMMessage(role="user", content="hi")], think=False,
        )
    assert "turn thinking off" not in str(ei.value)
