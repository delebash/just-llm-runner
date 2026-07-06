# SPDX-License-Identifier: GPL-3.0-or-later
"""Per-call `extra` routing into Ollama / Gemini backend shapes — previously the
adapters did body/payload.update(extra), which left sampling params top-level and
the backends ignored them (so top_p / response_format / the long-tail samplers all
silently dropped). These verify the corrected nesting/mapping."""

from llm_runner.llm.anthropic import AnthropicAdapter
from llm_runner.llm.base import pop_reasoning_effort
from llm_runner.llm.gemini import GeminiAdapter
from llm_runner.llm.ollama import OllamaAdapter
from llm_runner.llm.openai_compat import OpenAICompatAdapter


def test_ollama_extra_nests_under_options_and_format():
    body = {"options": {"temperature": 0.7}}
    OllamaAdapter._apply_extra(body, {
        "top_p": 0.9, "top_k": 40, "min_p": 0.05,
        "response_format": {"type": "json_object"},
    })
    assert body["options"]["top_p"] == 0.9
    assert body["options"]["top_k"] == 40
    assert body["options"]["min_p"] == 0.05   # long-tail samplers reach Ollama now
    assert body["format"] == "json"           # structured output → top-level format
    assert "top_p" not in body                # NOT left at the top level (the bug)


def test_gemini_extra_maps_to_generationconfig_and_drops_unsupported():
    payload = {"generationConfig": {"temperature": 0.7}}
    GeminiAdapter._apply_extra(payload, {
        "top_p": 0.9, "top_k": 40, "min_p": 0.05, "mirostat": 2,
        "response_format": {"type": "json_object"},
    })
    gc = payload["generationConfig"]
    assert gc["topP"] == 0.9                   # mapped to camelCase
    assert gc["topK"] == 40
    assert gc["responseMimeType"] == "application/json"
    assert "min_p" not in gc and "mirostat" not in gc  # unsupported by Gemini → dropped
    assert "top_p" not in payload              # NOT left at the top level (the bug)


def test_apply_extra_none_is_noop():
    body = {"options": {}}
    OllamaAdapter._apply_extra(body, None)
    assert body == {"options": {}}
    payload = {"generationConfig": {}}
    GeminiAdapter._apply_extra(payload, None)
    assert payload == {"generationConfig": {}}


# ── reasoning-effort → each backend's native control (a1/E2) ──────────────────

def test_pop_reasoning_effort_splits_reserved_key_without_leaking():
    extra, effort = pop_reasoning_effort({"top_k": 40, "reasoning_effort": "high"})
    assert effort == "high" and extra == {"top_k": 40}   # level removed (no leak)
    assert pop_reasoning_effort(None) == (None, "")
    assert pop_reasoning_effort({"top_k": 40}) == ({"top_k": 40}, "")


def test_ollama_reasoning_maps_level_or_bool():
    b = {}
    OllamaAdapter._apply_reasoning(b, True, "high")
    assert b["think"] == "high"          # level string passes straight through
    b = {}
    OllamaAdapter._apply_reasoning(b, True, "")
    assert b["think"] is True            # on, no level → bool true
    b = {}
    OllamaAdapter._apply_reasoning(b, False, "high")
    assert "think" not in b              # off → omit


def test_anthropic_reasoning_sets_thinking_and_bumps_max_tokens():
    b = {"max_tokens": 4096, "temperature": 0.7}
    AnthropicAdapter._apply_reasoning(b, True, "high")
    assert b["thinking"] == {"type": "enabled", "budget_tokens": 8192}
    assert b["max_tokens"] == 8192 + 2048        # bumped so budget < max_tokens, with answer room
    assert "temperature" not in b                # thinking requires the default temperature
    b2 = {"max_tokens": 4096, "temperature": 0.7}
    AnthropicAdapter._apply_reasoning(b2, False, "high")
    assert "thinking" not in b2 and b2["temperature"] == 0.7   # off → untouched


def test_gemini_reasoning_sets_thinking_budget():
    p = {"generationConfig": {"temperature": 0.7}}
    GeminiAdapter._apply_reasoning(p, True, "low")
    assert p["generationConfig"]["thinkingConfig"] == {"thinkingBudget": 2048}
    p2 = {"generationConfig": {}}
    GeminiAdapter._apply_reasoning(p2, False, "low")
    assert "thinkingConfig" not in p2["generationConfig"]   # off → omit


def test_openai_compat_reasoning_cloud_vs_local():
    cloud = OpenAICompatAdapter("p", "openai", api_key="x")
    b = {}
    cloud._apply_reasoning(b, True, "high")
    assert b["reasoning_effort"] == "high"        # cloud → native reasoning_effort param
    b = {}
    cloud._apply_reasoning(b, True, "")
    assert b["reasoning_effort"] == "medium"      # on, no level → default
    b = {}
    cloud._apply_reasoning(b, False, "high")
    assert b == {}                                # off → nothing
    local = OpenAICompatAdapter("p", "local-llamacpp", api_key="")
    b = {}
    local._apply_reasoning(b, True, "high")
    assert b["chat_template_kwargs"] == {"enable_thinking": True}  # local on → enable_thinking
    assert "reasoning_effort" not in b            # not the cloud param
    b = {}
    local._apply_reasoning(b, False, "high")
    assert b["chat_template_kwargs"] == {"enable_thinking": False}  # local OFF → false (#118: one model, no reload)
    # generic openai-compat: conservative — on → enable_thinking, off → nothing (we don't own its template)
    compat = OpenAICompatAdapter("p", "openai-compat", api_key="")
    b = {}
    compat._apply_reasoning(b, True, "high")
    assert b["chat_template_kwargs"] == {"enable_thinking": True}   # compat on → enable_thinking
    b = {}
    compat._apply_reasoning(b, False, "high")
    assert b == {}                                # compat off → nothing (NOT false)


def test_ollama_schema_rides_format():
    # C1: a json_schema response_format puts the SCHEMA OBJECT in Ollama's
    # `format` (structured outputs); plain json stays the "json" string.
    from llm_runner.llm.ollama import OllamaAdapter
    body = {}
    OllamaAdapter._apply_extra(body, {"response_format": {"type": "json_schema", "json_schema": {
        "name": "k", "schema": {"type": "object"}, "strict": True}}})
    assert body["format"] == {"type": "object"}
    body = {}
    OllamaAdapter._apply_extra(body, {"response_format": {"type": "json_object"}})
    assert body["format"] == "json"


def test_gemini_schema_rides_response_schema():
    # C1: a json_schema response_format sets generationConfig.responseSchema
    # alongside the JSON mime; plain json sets the mime only.
    from llm_runner.llm.gemini import GeminiAdapter
    payload = {}
    GeminiAdapter._apply_extra(payload, {"response_format": {"type": "json_schema", "json_schema": {
        "name": "k", "schema": {"type": "object"}, "strict": True}}})
    gc = payload["generationConfig"]
    assert gc["responseMimeType"] == "application/json"
    assert gc["responseSchema"] == {"type": "object"}
    payload = {}
    GeminiAdapter._apply_extra(payload, {"response_format": {"type": "json_object"}})
    assert payload["generationConfig"] == {"responseMimeType": "application/json"}
