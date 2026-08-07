# SPDX-License-Identifier: MIT
"""Dispatch precedence + the honest thinking law for the shared LLM layer.

No network: a FakeAdapter stands in for a provider. Verifies the
config → pin → prefer-local → first chain that JV relied on, and that
thinking is sent EXACTLY as configured (no veto, no tier-derived
fallback — the tier system died 2026-08-07)."""

from __future__ import annotations

import pytest

from llm_runner.llm import (
    FeaturePinConfig,
    LLMConfig,
    LLMMessage,
    LLMNotConfiguredError,
    LLMRegistry,
    LLMResponse,
    ProductionConfig,
    StreamDelta,
    chat,
    get_ledger,
    resolve_pin,
    stream_chat,
)


class FakeAdapter:
    """Satisfies the LLMAdapter protocol without touching the network."""

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
        yield StreamDelta(text="ok-")
        yield StreamDelta(text="stream")
        yield StreamDelta(done=True, prompt_tokens=7, completion_tokens=11)

    def models(self):
        return [self.default_model]

    def ping(self):
        return True


def make_reg(*adapters):
    reg = LLMRegistry()
    for a in adapters:
        reg.register(a)
    return reg


# ── Precedence chain ─────────────────────────────────────────────────

def test_production_config_wins():
    reg = make_reg(FakeAdapter("cloud"), FakeAdapter("local"))
    cfg = LLMConfig(
        production_configs=[ProductionConfig(
            feature="critique", name="strict", providerId="cloud",
            model="claude-sonnet-4-6")],
        feature_pins=[FeaturePinConfig(feature="critique", providerId="local", model="x")],
    )
    adapter, model = resolve_pin(cfg, "critique", reg)
    assert adapter.provider_id == "cloud"
    assert model == "claude-sonnet-4-6"


def test_explicit_pin_resolves():
    reg = make_reg(FakeAdapter("local"), FakeAdapter("cloud"))
    cfg = LLMConfig(
        feature_pins=[FeaturePinConfig(feature="compose", providerId="local", model="qwen3-4b")],
    )
    adapter, model = resolve_pin(cfg, "compose", reg)
    assert adapter.provider_id == "local"  # the explicit pin resolves
    assert model == "qwen3-4b"


def test_prefer_local_runner():
    reg = make_reg(FakeAdapter("other"), FakeAdapter("local-llamacpp", "qwen3-4b"))
    cfg = LLMConfig(prefer_local_features={"speaker_attribution"})
    adapter, model = resolve_pin(cfg, "speaker_attribution", reg)
    assert adapter.provider_id == "local-llamacpp"
    assert model == "qwen3-4b"


def test_first_adapter_fallback():
    reg = make_reg(FakeAdapter("only", "m"))
    cfg = LLMConfig()
    adapter, model = resolve_pin(cfg, "anything", reg)
    assert adapter.provider_id == "only"


def test_no_provider_raises():
    with pytest.raises(LLMNotConfiguredError):
        resolve_pin(LLMConfig(), "x", LLMRegistry())


# ── Action-level override (per-action routing, falls back to the feature) ──

def test_action_pin_beats_feature_default():
    reg = make_reg(FakeAdapter("feat", "feat-model"), FakeAdapter("act", "act-model"))
    cfg = LLMConfig(feature_pins=[
        FeaturePinConfig(feature="writerAI", providerId="feat", model="feat-model"),
        FeaturePinConfig(feature="writerAI.tighten", providerId="act", model="act-model"),
    ])
    adapter, model = resolve_pin(cfg, "writerAI", reg, action="writerAI.tighten")
    assert adapter.provider_id == "act"
    assert model == "act-model"


def test_action_without_pin_falls_back_to_feature():
    reg = make_reg(FakeAdapter("feat", "feat-model"))
    cfg = LLMConfig(feature_pins=[
        FeaturePinConfig(feature="writerAI", providerId="feat", model="feat-model"),
    ])
    # the action has nothing of its own → inherits the feature default
    adapter, model = resolve_pin(cfg, "writerAI", reg, action="writerAI.rewrite")
    assert adapter.provider_id == "feat"
    assert model == "feat-model"


def test_action_production_config_wins_over_feature():
    reg = make_reg(FakeAdapter("feat", "x"), FakeAdapter("prod", "prod-model"))
    cfg = LLMConfig(
        production_configs=[ProductionConfig(
            feature="writerAI.tighten", name="tuned", providerId="prod", model="prod-model")],
        feature_pins=[FeaturePinConfig(feature="writerAI", providerId="feat", model="x")],
    )
    adapter, model = resolve_pin(cfg, "writerAI", reg, action="writerAI.tighten")
    assert adapter.provider_id == "prod"
    assert model == "prod-model"


def test_action_none_is_legacy_feature_resolution():
    # action=None (every legacy caller, incl. all of JustVoice) is unchanged, and
    # action==feature is a harmless no-op that falls through to the feature.
    reg = make_reg(FakeAdapter("feat", "feat-model"))
    cfg = LLMConfig(feature_pins=[FeaturePinConfig(feature="writerAI", providerId="feat")])
    legacy = resolve_pin(cfg, "writerAI", reg)
    same = resolve_pin(cfg, "writerAI", reg, action="writerAI")
    assert legacy[0].provider_id == same[0].provider_id == "feat"


# ── chat() think omitted = OFF (the one-control law) + records usage ──

def test_chat_think_omitted_is_off_and_records_usage():
    get_ledger().clear()
    fake = FakeAdapter("local", "def")
    reg = make_reg(fake)
    cfg = LLMConfig(feature_pins=[FeaturePinConfig(feature="x", providerId="local", model="qwen3:14b")])
    resp = chat(config=cfg, feature="x", messages=[LLMMessage("user", "hi")], registry=reg)
    assert resp.text == "ok"
    # No explicit think = OFF — the preset is the one thinking control; the
    # name-guessed tier fallback died with the tier system (2026-08-07).
    assert fake.calls[0]["think"] is False
    snap = get_ledger().snapshot()
    assert snap["total_calls"] == 1
    assert snap["by_feature"]["x"]["calls"] == 1


def test_stream_chat_yields_deltas_and_records_usage():
    get_ledger().clear()
    fake = FakeAdapter("local", "def")
    reg = make_reg(fake)
    cfg = LLMConfig(feature_pins=[FeaturePinConfig(feature="x", providerId="local", model="qwen3:14b")])
    deltas = list(stream_chat(config=cfg, feature="x", messages=[LLMMessage("user", "hi")], registry=reg))
    assert "".join(d.text for d in deltas if not d.done) == "ok-stream"
    assert fake.calls[0]["think"] is False  # same law on the stream path
    done = [d for d in deltas if d.done]
    assert done and done[0].prompt_tokens == 7 and done[0].completion_tokens == 11
    snap = get_ledger().snapshot()
    assert snap["by_feature"]["x"]["calls"] == 1
    assert snap["by_feature"]["x"]["prompt_tokens"] == 7
    assert snap["by_feature"]["x"]["completion_tokens"] == 11


# ── Thinking is sent EXACTLY as configured — no veto (the gate removal
# 2026-08-06; these tests lived in test_capability_gate.py until the tier
# system + capability resolver died, 2026-08-07) ──────────────────────

def _pin(model):
    return LLMConfig(feature_pins=[FeaturePinConfig(feature="f", providerId="cloud", model=model)])


def test_think_is_sent_even_to_a_known_nonthinker():
    a = FakeAdapter("cloud")
    resp = chat(config=_pin("gpt-4o"), feature="f", registry=make_reg(a),
                messages=[LLMMessage("user", "hi")],
                think=True, extra={"reasoning_effort": "high"})
    assert resp.text == "ok"
    call = a.calls[-1]
    assert call["think"] is True
    # The reasoning ask rides the wire (resolved to the provider's dialect).
    assert (call["extra"] or {}).get("reasoning_effort")


def test_think_off_stays_off():
    a = FakeAdapter("cloud")
    chat(config=_pin("gpt-4o"), feature="f", registry=make_reg(a),
         messages=[LLMMessage("user", "hi")], think=False)
    assert a.calls[-1]["think"] is False


def test_stream_path_sends_as_configured():
    a = FakeAdapter("cloud")
    list(stream_chat(config=_pin("gpt-4o"), feature="f", registry=make_reg(a),
                     messages=[LLMMessage("user", "hi")], think=True))
    assert a.calls[-1]["think"] is True


def test_reasoning_rejection_carries_the_fix_pointer():
    a = FakeAdapter(
        "cloud",
        fail_with="Unsupported parameter: 'reasoning_effort' is not supported with this model.",
    )
    with pytest.raises(RuntimeError) as ei:
        chat(config=_pin("gpt-4o"), feature="f", registry=make_reg(a),
             messages=[LLMMessage("user", "hi")], think=True)
    msg = str(ei.value)
    assert "reasoning_effort" in msg                            # the provider's own words
    assert "turn thinking off on this feature's preset" in msg  # the one fix line


def test_unrelated_errors_pass_through_untouched():
    """Auth/timeout/quota errors never get the thinking hint — the hint rides
    only when the provider's message is about the parameter we sent."""
    a = FakeAdapter("cloud", fail_with="401 Unauthorized: bad api key")
    with pytest.raises(ValueError) as ei:
        chat(config=_pin("gpt-4o"), feature="f", registry=make_reg(a),
             messages=[LLMMessage("user", "hi")], think=True)
    assert "turn thinking off" not in str(ei.value)


def test_think_off_errors_never_get_the_hint():
    a = FakeAdapter("cloud", fail_with="model produced no reasoning output")
    with pytest.raises(ValueError) as ei:
        chat(config=_pin("gpt-4o"), feature="f", registry=make_reg(a),
             messages=[LLMMessage("user", "hi")], think=False)
    assert "turn thinking off" not in str(ei.value)


# ── #15 C4: registry rewire — the openai SDK adapter serves all five cloud types ──

def test_registry_constructs_openai_sdk_for_all_five_types():
    from llm_runner.llm.openai_sdk import OpenAISDKAdapter
    from llm_runner.llm.registry import construct
    from llm_runner.llm.schema import LLMProviderConfig
    for pt in ("openai", "deepseek", "openrouter", "xai", "mistral"):
        a = construct(LLMProviderConfig(id=pt, name=pt, providerType=pt))
        assert isinstance(a, OpenAISDKAdapter) and a.provider_type == pt


def test_registry_compat_openai_without_base_url_raises():
    # C4.2 removed compat's "openai" defaults entry, so a bare "openai" compat no longer
    # resolves a base_url — its construction now raises (openai rides openai_sdk instead).
    from llm_runner.llm.openai_compat import OpenAICompatAdapter
    with pytest.raises(ValueError):
        OpenAICompatAdapter("p", "openai", api_key="x")
