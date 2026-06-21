# SPDX-License-Identifier: GPL-3.0-or-later
"""Dispatch precedence + tier classification for the shared LLM layer.

No network: a FakeAdapter stands in for a provider. Verifies the
config → pin → role → default-role → prefer-local → first chain that JV
relied on, now decoupled from any app's settings object.
"""

from __future__ import annotations

import pytest

from llm_runner.llm import (
    FeaturePinConfig,
    LLMConfig,
    LLMMessage,
    LLMNotConfiguredError,
    LLMRegistry,
    LLMResponse,
    LLMRolesSettings,
    LLMRoleTarget,
    ProductionConfig,
    StreamDelta,
    chat,
    get_ledger,
    resolve_pin,
    resolve_tier,
    stream_chat,
)


class FakeAdapter:
    """Satisfies the LLMAdapter protocol without touching the network."""

    def __init__(self, provider_id, default_model="m-default"):
        self.provider_id = provider_id
        self.provider_type = "openai-compat"
        self.default_model = default_model
        self.calls = []

    def chat(self, messages, *, model=None, temperature=0.7, max_tokens=None,
             system=None, think=False, extra=None):
        self.calls.append({"model": model, "think": think})
        return LLMResponse(text="ok", model=model or self.default_model,
                           prompt_tokens=3, completion_tokens=5)

    def stream_chat(self, messages, *, model=None, temperature=0.7, max_tokens=None,
                    system=None, think=False, extra=None):
        self.calls.append({"model": model, "think": think, "stream": True})
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
            model="claude-sonnet-4-6", tier="direct")],
        feature_pins=[FeaturePinConfig(feature="critique", providerId="local", model="x")],
    )
    adapter, model, tier = resolve_pin(cfg, "critique", reg)
    assert adapter.provider_id == "cloud"
    assert model == "claude-sonnet-4-6"
    assert tier == "direct"


def test_explicit_pin_beats_role():
    reg = make_reg(FakeAdapter("local"), FakeAdapter("cloud"))
    cfg = LLMConfig(
        feature_pins=[FeaturePinConfig(feature="compose", providerId="local", model="qwen3-4b")],
        llm_roles=LLMRolesSettings(quick=LLMRoleTarget(providerId="cloud", model="gpt")),
    )
    adapter, model, _ = resolve_pin(cfg, "compose", reg)
    assert adapter.provider_id == "local"
    assert model == "qwen3-4b"


def test_pin_inherits_role():
    reg = make_reg(FakeAdapter("local", "qwen3-4b"))
    cfg = LLMConfig(
        feature_pins=[FeaturePinConfig(feature="compose", role="quick")],
        llm_roles=LLMRolesSettings(quick=LLMRoleTarget(providerId="local", model="qwen3-4b")),
    )
    adapter, model, _ = resolve_pin(cfg, "compose", reg)
    assert adapter.provider_id == "local"
    assert model == "qwen3-4b"


def test_default_feature_role():
    reg = make_reg(FakeAdapter("cloud", "big"), FakeAdapter("local"))
    cfg = LLMConfig(
        llm_roles=LLMRolesSettings(accuracy=LLMRoleTarget(providerId="cloud", model="big")),
        default_feature_roles={"speaker_attribution": "accuracy"},
    )
    adapter, model, _ = resolve_pin(cfg, "speaker_attribution", reg)
    assert adapter.provider_id == "cloud"
    assert model == "big"


def test_prefer_local_runner():
    reg = make_reg(FakeAdapter("other"), FakeAdapter("local-llamacpp", "qwen3-4b"))
    cfg = LLMConfig(prefer_local_features={"speaker_attribution"})
    adapter, model, _ = resolve_pin(cfg, "speaker_attribution", reg)
    assert adapter.provider_id == "local-llamacpp"
    assert model == "qwen3-4b"


def test_first_adapter_fallback():
    reg = make_reg(FakeAdapter("only", "m"))
    cfg = LLMConfig()
    adapter, model, _ = resolve_pin(cfg, "anything", reg)
    assert adapter.provider_id == "only"


def test_no_provider_raises():
    with pytest.raises(LLMNotConfiguredError):
        resolve_pin(LLMConfig(), "x", LLMRegistry())


# ── Tier classification through resolve_tier ─────────────────────────

def test_resolve_tier_auto_reasoned():
    reg = make_reg(FakeAdapter("local", "def"))
    cfg = LLMConfig(feature_pins=[FeaturePinConfig(feature="x", providerId="local", model="qwen3:14b")])
    spec = resolve_tier(cfg, "x", reg)
    assert spec.name == "reasoned"
    assert spec.think is True


def test_resolve_tier_override():
    reg = make_reg(FakeAdapter("local", "def"))
    cfg = LLMConfig(feature_pins=[FeaturePinConfig(
        feature="x", providerId="local", model="qwen3:14b", tier="guided")])
    spec = resolve_tier(cfg, "x", reg)
    assert spec.name == "guided"


# ── chat() defaults think from tier + records usage ──────────────────

def test_chat_thinks_from_tier_and_records_usage():
    get_ledger().clear()
    fake = FakeAdapter("local", "def")
    reg = make_reg(fake)
    cfg = LLMConfig(feature_pins=[FeaturePinConfig(feature="x", providerId="local", model="qwen3:14b")])
    resp = chat(config=cfg, feature="x", messages=[LLMMessage("user", "hi")], registry=reg)
    assert resp.text == "ok"
    assert fake.calls[0]["think"] is True  # reasoned tier → think
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
    assert fake.calls[0]["think"] is True  # reasoned tier → think
    done = [d for d in deltas if d.done]
    assert done and done[0].prompt_tokens == 7 and done[0].completion_tokens == 11
    snap = get_ledger().snapshot()
    assert snap["by_feature"]["x"]["calls"] == 1
    assert snap["by_feature"]["x"]["prompt_tokens"] == 7
    assert snap["by_feature"]["x"]["completion_tokens"] == 11
