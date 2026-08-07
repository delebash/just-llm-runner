# SPDX-License-Identifier: MIT
"""Per-request Plane-2 `extra` (2026-07-15 one-source): json_mode is the action's
CONTRACT (on the spec); top_p / reasoning / long-tail samplers come from the resolved
PRESET; body values override ephemerally. The feature-sampler store read is gone."""

import sqlalchemy as sa
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
import pytest

from llm_runner.llm import db
from llm_runner.llm.presets_api import EnginePresetRow, PresetFlagRow
from llm_runner.llm.prompts import FeaturePromptRow, RunRequest, _effective_think, _plane2_extra


def _spec(**kw):
    base = dict(key="k", feature="f", system="", user_template="", built_in=False)
    base.update(kw)
    return FeaturePromptRow(**base)


def _preset(**kw):
    return EnginePresetRow(name="p", **kw)


def test_extra_none_when_unset():
    assert _plane2_extra(_spec(), RunRequest(action="k")) is None
    assert _plane2_extra(_spec(), RunRequest(action="k"), _preset()) is None


def test_json_mode_from_spec_top_p_from_preset():
    # json_mode = the action's contract (spec); top_p = the preset.
    e = _plane2_extra(_spec(json_mode=True), RunRequest(action="k"), _preset(topP=0.9))
    assert e == {"response_format": {"type": "json_object"}, "top_p": 0.9}


def test_request_overrides_spec_and_preset():
    # request jsonMode=False overrides the spec's contract; topP override beats the preset.
    e = _plane2_extra(_spec(json_mode=True), RunRequest(action="k", jsonMode=False, topP=0.5), _preset(topP=0.9))
    assert e == {"top_p": 0.5}


def test_preset_samplers_reach_extra():
    e = _plane2_extra(_spec(), RunRequest(action="k"),
                      _preset(samplers=[PresetFlagRow(flagName="min_p", flagValue="0.05")]))
    assert e == {"min_p": 0.05}


def test_body_samplers_override_preset():
    e = _plane2_extra(_spec(), RunRequest(action="k", samplers=[{"flagName": "min_p", "flagValue": "0.2"}]),
                      _preset(samplers=[PresetFlagRow(flagName="min_p", flagValue="0.05")]))
    assert e == {"min_p": 0.2}


def test_reasoning_effort_from_preset_when_thinking():
    e = _plane2_extra(_spec(), RunRequest(action="k"), _preset(think=True, reasoningEffort="high"))
    assert e == {"reasoning_effort": "high"}
    # json_mode forces reasoning off (B3), so the level is NOT threaded.
    e = _plane2_extra(_spec(json_mode=True), RunRequest(action="k"), _preset(think=True, reasoningEffort="high"))
    assert e == {"response_format": {"type": "json_object"}}


def test_effective_think_from_preset_with_json_guardrail():
    # think comes from the PRESET; the B3 guardrail forces it off under json_mode.
    assert _effective_think(_spec(), RunRequest(action="k"), _preset(think=True)) is True
    assert _effective_think(_spec(), RunRequest(action="k"), _preset(think=False)) is False
    assert _effective_think(_spec(json_mode=True), RunRequest(action="k"), _preset(think=True)) is False
    assert _effective_think(_spec(), RunRequest(action="k", jsonMode=True), _preset(think=True)) is False
    # a request think override wins (a Lab column comparing think on vs off); no preset → off
    assert _effective_think(_spec(), RunRequest(action="k", think=True), None) is True
    assert _effective_think(_spec(), RunRequest(action="k"), None) is False


# ── Stop sequences (#73) — the reserved `stop` key rides body.samplers, normalized
# to a string ARRAY; anthropic renames it. ──
def test_stop_sequences_split_to_array():
    e = _plane2_extra(_spec(), RunRequest(action="k", samplers=[{"flagName": "stop", "flagValue": "END\nUSER:"}]))
    assert e == {"stop": ["END", "USER:"]}


def test_stop_numeric_value_kept_as_string():
    e = _plane2_extra(_spec(), RunRequest(action="k", samplers=[{"flagName": "stop", "flagValue": "42"}]))
    assert e == {"stop": ["42"]}


def test_stop_blank_is_dropped():
    e = _plane2_extra(_spec(), RunRequest(action="k", samplers=[{"flagName": "stop", "flagValue": "  \n  "}]))
    assert e is None


def test_anthropic_renames_stop_to_stop_sequences():
    from llm_runner.llm.anthropic import AnthropicAdapter
    assert AnthropicAdapter._map_extra({"stop": ["END"], "top_p": 0.9}) == {"stop_sequences": ["END"], "top_p": 0.9}
    assert AnthropicAdapter._map_extra(None) is None
    assert AnthropicAdapter._map_extra({"top_p": 0.9}) == {"top_p": 0.9}


# ── C1: json_schema (the action's CONTRACT) — schema-ENFORCED output ────────────
def test_json_schema_emits_nested_openai_form():
    schema = '{"type":"object","properties":{"names":{"type":"array"}}}'
    e = _plane2_extra(_spec(json_mode=True, json_schema=schema), RunRequest(action="entity.sweep"))
    assert e == {"response_format": {"type": "json_schema", "json_schema": {
        "name": "entity_sweep",
        "schema": {"type": "object", "properties": {"names": {"type": "array"}}},
        "strict": True}}}


def test_json_schema_invalid_degrades_to_json_object():
    e = _plane2_extra(_spec(json_mode=True, json_schema="{not json"), RunRequest(action="k"))
    assert e == {"response_format": {"type": "json_object"}}
    e = _plane2_extra(_spec(json_mode=True, json_schema="[1, 2]"), RunRequest(action="k"))
    assert e == {"response_format": {"type": "json_object"}}


def test_json_schema_inert_when_json_mode_off():
    e = _plane2_extra(_spec(json_mode=False, json_schema='{"type":"object"}'), RunRequest(action="k"))
    assert e is None


@pytest.fixture
def configured():
    eng = sa.create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    db.create_all(eng)
    db.configure_storage(sessionmaker(bind=eng, autoflush=False))
    yield


def test_prompt_store_roundtrips_contract(configured):
    from llm_runner.llm import stores
    st = stores.get_prompt_store()
    st.upsert(FeaturePromptRow(key="y", feature="y", system="", user_template="",
                               built_in=False, json_mode=True, json_schema='{"type":"object"}'))
    r = st.get("y")
    assert r.json_mode is True and r.json_schema == '{"type":"object"}'


def test_anthropic_strips_response_format():
    from llm_runner.llm.anthropic import AnthropicAdapter
    out = AnthropicAdapter._map_extra({"response_format": {"type": "json_object"}, "top_p": 0.9})
    assert out == {"top_p": 0.9}


def test_openai_compat_flattens_schema_for_builtin_only():
    from llm_runner.llm.openai_compat import OpenAICompatAdapter
    nested = {"response_format": {"type": "json_schema", "json_schema": {
        "name": "k", "schema": {"type": "object"}, "strict": True}}}

    a = OpenAICompatAdapter.__new__(OpenAICompatAdapter)
    a.provider_type = "local-llamacpp"
    body = dict(nested)
    a._adapt_response_format(body)
    assert body["response_format"] == {"type": "json_schema", "schema": {"type": "object"}}

    b = OpenAICompatAdapter.__new__(OpenAICompatAdapter)
    b.provider_type = "openai-compat"
    body = dict(nested)
    b._adapt_response_format(body)
    assert body == nested
