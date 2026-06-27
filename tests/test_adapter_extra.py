# SPDX-License-Identifier: GPL-3.0-or-later
"""Per-call `extra` routing into Ollama / Gemini backend shapes — previously the
adapters did body/payload.update(extra), which left sampling params top-level and
the backends ignored them (so top_p / response_format / the long-tail samplers all
silently dropped). These verify the corrected nesting/mapping."""

from llm_runner.llm.gemini import GeminiAdapter
from llm_runner.llm.ollama import OllamaAdapter


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
