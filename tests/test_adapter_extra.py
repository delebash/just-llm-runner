# SPDX-License-Identifier: GPL-3.0-or-later
"""Per-call `extra` routing into Ollama / Gemini backend shapes — previously the
adapters did body/payload.update(extra), which left sampling params top-level and
the backends ignored them (so top_p / response_format / the long-tail samplers all
silently dropped). These verify the corrected nesting/mapping."""

from llm_runner.llm.anthropic import AnthropicAdapter
from llm_runner.llm.base import pop_reasoning
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


# ── reasoning: the resolved word/budget → each backend's native control (U2-T5) ──

def test_pop_reasoning_splits_both_reserved_keys_without_leaking():
    extra, effort, budget = pop_reasoning({"top_k": 40, "reasoning_effort": "high", "reasoning_budget_tokens": 1024})
    assert effort == "high" and budget == 1024 and extra == {"top_k": 40}   # both removed (no leak)
    assert pop_reasoning(None) == (None, "", None)
    assert pop_reasoning({"top_k": 40}) == ({"top_k": 40}, "", None)


def test_ollama_reasoning_maps_level_or_bool():
    b = {}
    OllamaAdapter._apply_reasoning(b, True, "high")
    assert b["think"] == "high"          # the resolved level word passes straight through
    b = {}
    OllamaAdapter._apply_reasoning(b, True, "")
    assert b["think"] is True            # on, no level → bool true
    b = {}
    OllamaAdapter._apply_reasoning(b, False, "high")
    assert "think" not in b              # off → omit


def test_anthropic_reasoning_legacy_vs_new_model():
    # LEGACY model (haiku-4-5): classic budget_tokens = the resolved map NUMBER + max bump.
    b = {"max_tokens": 4096, "temperature": 0.7}
    AnthropicAdapter._apply_reasoning(b, True, "high", 8192, "claude-haiku-4-5")
    assert b["thinking"] == {"type": "enabled", "budget_tokens": 8192}
    assert b["max_tokens"] == 8192 + 2048
    assert "temperature" not in b
    # NEW model (opus-4-8): adaptive + output_config.effort (the WORD); sampler params dropped.
    b2 = {"max_tokens": 4096, "temperature": 0.7, "top_p": 0.9}
    AnthropicAdapter._apply_reasoning(b2, True, "high", 8192, "claude-opus-4-8")
    assert b2["thinking"] == {"type": "adaptive"}
    assert b2["output_config"] == {"effort": "high"}
    assert "temperature" not in b2 and "top_p" not in b2 and "budget_tokens" not in b2["thinking"]
    # NEW model, think off → explicit disabled.
    b3 = {}
    AnthropicAdapter._apply_reasoning(b3, False, "high", None, "claude-sonnet-5")
    assert b3["thinking"] == {"type": "disabled"}
    # Fable (always thinks), off → no thinking config forced.
    b4 = {}
    AnthropicAdapter._apply_reasoning(b4, False, "high", None, "claude-fable-5")
    assert "thinking" not in b4
    # LEGACY off → untouched.
    b5 = {"temperature": 0.7}
    AnthropicAdapter._apply_reasoning(b5, False, "high", 8192, "claude-haiku-4-5")
    assert "thinking" not in b5 and b5["temperature"] == 0.7


def test_gemini_reasoning_uses_resolved_budget():
    p = {"generationConfig": {"temperature": 0.7}}
    GeminiAdapter._apply_reasoning(p, True, "", 2048)   # the resolved NUMBER, not a table lookup
    assert p["generationConfig"]["thinkingConfig"] == {"thinkingBudget": 2048}
    p2 = {"generationConfig": {}}
    GeminiAdapter._apply_reasoning(p2, False, "", 2048)
    assert "thinkingConfig" not in p2["generationConfig"]   # off → omit


def test_openai_compat_reasoning_cloud_vs_local():
    cloud = OpenAICompatAdapter("p", "openai", api_key="x")
    b = {}
    cloud._apply_reasoning(b, True, "high", None)
    assert b["reasoning_effort"] == "high"        # cloud → the resolved reasoning_effort WORD
    b = {}
    cloud._apply_reasoning(b, True, "", None)
    assert "reasoning_effort" not in b            # on, no word → nothing (no adapter default any more)
    b = {}
    cloud._apply_reasoning(b, False, "high", None)
    assert b == {}                                # off → nothing
    # local: enable_thinking BOTH ways + the per-request reasoning_budget_tokens.
    local = OpenAICompatAdapter("p", "local-llamacpp", api_key="")
    b = {}
    local._apply_reasoning(b, True, "", 1024)
    assert b["chat_template_kwargs"] == {"enable_thinking": True}
    assert b["reasoning_budget_tokens"] == 1024   # the resolved hardware-capped budget
    assert "reasoning_effort" not in b
    b = {}
    local._apply_reasoning(b, False, "", 1024)
    assert b["chat_template_kwargs"] == {"enable_thinking": False}
    assert b["reasoning_budget_tokens"] == 0      # off → 0 (belt+braces; the toggle already suppresses)
    # generic openai-compat: conservative — on → enable_thinking, off → nothing.
    compat = OpenAICompatAdapter("p", "openai-compat", api_key="")
    b = {}
    compat._apply_reasoning(b, True, "high", None)
    assert b["chat_template_kwargs"] == {"enable_thinking": True}
    b = {}
    compat._apply_reasoning(b, False, "high", None)
    assert b == {}


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


# ── §7.4 B6-2: return_progress + prompt_progress on the builtin engine ────────

class _FakeStreamResponse:
    def __init__(self, lines, status_code=200):
        self.status_code = status_code
        self._lines = lines

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def iter_lines(self):
        yield from self._lines

    def read(self):
        return b""


class _FakeStreamClient:
    """Stands in for the adapter's httpx.Client: records the request body and
    replays canned SSE lines."""

    def __init__(self, lines):
        self._lines = lines
        self.last_body = None

    def stream(self, method, url, json=None, headers=None):
        self.last_body = json
        return _FakeStreamResponse(self._lines)


def _stream_adapter(provider_type, lines):
    a = OpenAICompatAdapter("p", provider_type, api_key="")
    a._client = _FakeStreamClient(lines)
    return a


def test_stream_chat_return_progress_only_for_builtin():
    # §7.4: the builtin engine asks llama-server for prompt-eval progress
    # (return_progress, PR 15827); cloud/compat providers never see the field.
    from llm_runner.llm.base import LLMMessage
    lines = ['data: {"choices":[{"delta":{"content":"hi"}}]}', "data: [DONE]"]
    for ptype, expected in (("local-llamacpp", True), ("openai-compat", False), ("openai", False)):
        a = _stream_adapter(ptype, lines)
        list(a.stream_chat([LLMMessage(role="user", content="q")]))
        assert (a._client.last_body.get("return_progress") is True) is expected, ptype


def test_stream_chat_parses_prompt_progress_frames():
    # Overall progress = processed/total per the upstream contract; progress
    # deltas are progress-only (no text), and the final delta stays the done
    # event with the usage counts.
    from llm_runner.llm.base import LLMMessage
    a = _stream_adapter("local-llamacpp", [
        'data: {"prompt_progress": {"total": 200, "cache": 0, "processed": 100, "time_ms": 5}}',
        'data: {"prompt_progress": {"total": 200, "cache": 0, "processed": 200, "time_ms": 9}}',
        'data: {"choices":[{"delta":{"content":"tok"}}]}',
        'data: {"choices":[],"usage":{"prompt_tokens":200,"completion_tokens":1}}',
        "data: [DONE]",
    ])
    deltas = list(a.stream_chat([LLMMessage(role="user", content="q")]))
    assert [d.progress for d in deltas if d.progress is not None] == [0.5, 1.0]
    assert [d.text for d in deltas if d.text] == ["tok"]
    done = deltas[-1]
    assert done.done and done.prompt_tokens == 200 and done.completion_tokens == 1


def test_stream_chat_prompt_progress_guards_zero_total():
    # A total of 0 must not divide — the frame is simply skipped.
    from llm_runner.llm.base import LLMMessage
    a = _stream_adapter("local-llamacpp", [
        'data: {"prompt_progress": {"total": 0, "processed": 0}}',
        "data: [DONE]",
    ])
    deltas = list(a.stream_chat([LLMMessage(role="user", content="q")]))
    assert all(d.progress is None for d in deltas)
