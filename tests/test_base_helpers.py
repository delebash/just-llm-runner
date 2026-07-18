# SPDX-License-Identifier: GPL-3.0-or-later
"""Pin the four shared adapter helpers promoted to base.py (#15 C2.0): the OpenAI-shape
message builder, the system-sweep, the sampler allowlist filter, and the one-place D10
error formatter. The compat/ollama migration to build_chat_messages is proven by their
own untouched tests staying green."""

from llm_runner.llm.base import (
    LLMMessage,
    adapter_http_error,
    build_chat_messages,
    select_allowed,
    split_system,
)


def test_build_chat_messages_prepends_system_then_turns():
    out = build_chat_messages(
        [LLMMessage(role="user", content="hi"), LLMMessage(role="assistant", content="yo")],
        "be terse",
    )
    assert out == [
        {"role": "system", "content": "be terse"},
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "yo"},
    ]
    # no system kwarg → no leading system turn
    assert build_chat_messages([LLMMessage(role="user", content="q")], None) == [
        {"role": "user", "content": "q"}
    ]


def test_split_system_sweeps_kwarg_and_system_turns():
    sys_text, rest = split_system(
        [
            LLMMessage(role="system", content="rule A"),
            LLMMessage(role="user", content="q"),
            LLMMessage(role="system", content="rule B"),
            LLMMessage(role="assistant", content="a"),
        ],
        "kwarg sys",
    )
    # kwarg first, then the swept system turns, joined by a blank line
    assert sys_text == "kwarg sys\n\nrule A\n\nrule B"
    # remainder is the non-system turns, as LLMMessages (each adapter maps them)
    assert [(m.role, m.content) for m in rest] == [("user", "q"), ("assistant", "a")]
    # nothing to sweep → None + the turns unchanged
    none_sys, kept = split_system([LLMMessage(role="user", content="x")], None)
    assert none_sys is None and [m.content for m in kept] == ["x"]


def test_select_allowed_keeps_allowed_applies_renames_drops_rest():
    out = select_allowed(
        {"top_p": 0.9, "min_p": 0.05, "mirostat": 2, "samplers": ["a"], "stop": ["END"]},
        {"top_p", "seed", "stop"},
        renames={"stop": "stop_sequences"},
    )
    assert out == {"top_p": 0.9, "stop_sequences": ["END"]}  # min_p/mirostat/samplers dropped
    assert select_allowed(None, {"top_p"}) == {}  # None → {}
    assert select_allowed({}, {"top_p"}) == {}  # empty → {}


def test_adapter_http_error_formats_the_three_D10_forms():
    non_stream = adapter_http_error("gemini", 404, "not found")
    assert str(non_stream) == "gemini 404: not found" and isinstance(non_stream, RuntimeError)
    stream = adapter_http_error("gemini", 500, "boom", stream=True)
    assert str(stream) == "gemini stream 500: boom"
    transport = adapter_http_error("anthropic", None, "connection reset")
    assert str(transport) == "anthropic request failed: connection reset"
    # detail is capped at 400 chars (the envelope's contract)
    assert str(adapter_http_error("openai", 400, "x" * 600)) == "openai 400: " + "x" * 400
