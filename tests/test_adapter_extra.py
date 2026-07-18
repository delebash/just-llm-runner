# SPDX-License-Identifier: GPL-3.0-or-later
"""Per-call `extra` routing into Ollama / Gemini backend shapes — previously the
adapters did body/payload.update(extra), which left sampling params top-level and
the backends ignored them (so top_p / response_format / the long-tail samplers all
silently dropped). These verify the corrected nesting/mapping."""

from types import SimpleNamespace as NS

import httpx
import openai
import pytest
from google.genai import errors as gerrors
from google.genai import types as gtypes

from _sdk_fakes import KwargsCapture, load_fixture
from llm_runner.llm.anthropic import AnthropicAdapter
from llm_runner.llm.base import LLMMessage, pop_reasoning
from llm_runner.llm.gemini import GeminiAdapter
from llm_runner.llm.ollama import OllamaAdapter
from llm_runner.llm.openai_compat import OpenAICompatAdapter
from llm_runner.llm.openai_sdk import OpenAISDKAdapter


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


def test_gemini_build_config_maps_typed_and_drops_unsupported():
    # SDK rewrite (#15 C2): _build_config keeps ONLY Gemini's typed params + the stop
    # rename; the min_p-400 trigger bug dies here — unsupported samplers are DROPPED,
    # never merged (red-first against a naive `cfg.update(extra)`).
    cfg = GeminiAdapter._build_config(
        system="s", temperature=0.7, max_tokens=64, think=False, effort="", budget=None,
        extra={"top_p": 0.9, "top_k": 40, "seed": 7, "stop": ["END"],
               "min_p": 0.05, "mirostat": 2, "samplers": ["top_k", "top_p"]},
    )
    assert cfg["top_p"] == 0.9 and cfg["top_k"] == 40 and cfg["seed"] == 7
    assert cfg["stop_sequences"] == ["END"] and "stop" not in cfg   # renamed
    assert cfg["system_instruction"] == "s" and cfg["max_output_tokens"] == 64
    assert "min_p" not in cfg and "mirostat" not in cfg and "samplers" not in cfg
    gtypes.GenerateContentConfig(**cfg)   # builds a REAL typed config (raises on unknown)


def test_gemini_build_config_empty_extra_is_bare():
    cfg = GeminiAdapter._build_config(system=None, temperature=None, max_tokens=None,
                                      think=False, effort="", budget=None, extra=None)
    assert cfg == {}


def test_ollama_apply_extra_none_is_noop():
    body = {"options": {}}
    OllamaAdapter._apply_extra(body, None)
    assert body == {"options": {}}


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


def test_gemini_build_config_thinking_off_word_number():
    base = dict(system=None, temperature=None, max_tokens=None, extra=None)
    # off → OMIT thinking_config (model default = today's semantics)
    assert "thinking_config" not in GeminiAdapter._build_config(think=False, effort="", budget=2048, **base)
    # think on + a NUMBER → thinking_budget (the resolved map value, not a table lookup)
    tc = GeminiAdapter._build_config(think=True, effort="", budget=2048, **base)["thinking_config"]
    assert tc.thinking_budget == 2048 and tc.thinking_level is None
    # -1 passes through verbatim (documented dynamic/unlimited — the gemini `max` seed)
    assert GeminiAdapter._build_config(think=True, effort="", budget=-1, **base)["thinking_config"].thinking_budget == -1
    # think on + a WORD → thinking_level (forward-compat branch, D6-A)
    tl = GeminiAdapter._build_config(think=True, effort="high", budget=None, **base)["thinking_config"]
    assert tl.thinking_level is not None and tl.thinking_budget is None
    # think on but neither a word nor a number resolved → still OMIT (claim nothing)
    assert "thinking_config" not in GeminiAdapter._build_config(think=True, effort="", budget=None, **base)


def test_openai_compat_reasoning_local_and_generic():
    # #15 C4: the cloud "openai" reasoning_effort branch is GONE (that emission moved to
    # openai_sdk) and compat no longer constructs type "openai" (its defaults entry is
    # removed). Compat now serves ONLY local-llamacpp + the generic openai-compat gateway.
    # local: enable_thinking BOTH ways + the per-request reasoning_budget_tokens.
    local = OpenAICompatAdapter("p", "local-llamacpp", api_key="")
    b = {}
    local._apply_reasoning(b, True, "", 1024)
    assert b["chat_template_kwargs"] == {"enable_thinking": True}
    assert b["reasoning_budget_tokens"] == 1024   # the resolved per-request budget (layered switch value)
    assert "reasoning_effort" not in b
    b = {}
    local._apply_reasoning(b, False, "", 1024)
    assert b["chat_template_kwargs"] == {"enable_thinking": False}
    assert b["reasoning_budget_tokens"] == 0      # off → 0 (belt+braces; the toggle already suppresses)
    # generic openai-compat: conservative — on → enable_thinking, off → nothing. No
    # reasoning_effort is ever emitted (the dead cloud branch was deleted with the pivot).
    compat = OpenAICompatAdapter("p", "openai-compat", api_key="")
    b = {}
    compat._apply_reasoning(b, True, "high", None)
    assert b["chat_template_kwargs"] == {"enable_thinking": True}
    assert "reasoning_effort" not in b
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


def test_gemini_build_config_response_schema_and_json_object():
    base = dict(system=None, temperature=None, max_tokens=None, think=False, effort="", budget=None)
    # json_schema → the RAW JSON Schema rides response_json_schema + the JSON mime (proof item 4)
    cfg = GeminiAdapter._build_config(extra={"response_format": {"type": "json_schema",
        "json_schema": {"name": "k", "schema": {"type": "object"}, "strict": True}}}, **base)
    assert cfg["response_mime_type"] == "application/json"
    assert cfg["response_json_schema"] == {"type": "object"}
    # json_object → the mime ONLY, no schema
    cfg2 = GeminiAdapter._build_config(extra={"response_format": {"type": "json_object"}}, **base)
    assert cfg2 == {"response_mime_type": "application/json"}


# ── #15 C2: the google-genai SDK surface (chat/stream/models/embed/errors) over a fake
#    client, with response objects rebuilt from the committed LIVE-PROOF fixtures ──

class _FakeGenaiModels(KwargsCapture):
    """Fake google-genai `client.models` surface (flat: the adapter calls
    self._client.models.<method>). Captures kwargs into self.last; returns canned SDK
    objects, or raises a preset error."""

    def __init__(self, *, response=None, stream=None, model_list=None, embed=None, error=None):
        super().__init__()
        self.models = self  # flat: .models.generate_content etc. resolve to this object
        self._response = response
        self._stream = stream or []
        self._model_list = model_list or []
        self._embed = embed
        self._error = error

    def generate_content(self, *, model, contents, config):
        self._capture(model=model, contents=contents, config=config)
        if self._error:
            raise self._error
        return self._response

    def generate_content_stream(self, *, model, contents, config):
        self._capture(model=model, contents=contents, config=config)
        if self._error:
            raise self._error
        return iter(self._stream)

    def list(self):
        if self._error:
            raise self._error
        return iter(self._model_list)

    def embed_content(self, *, model, contents, config):
        self._capture(model=model, contents=contents, config=config)
        if self._error:
            raise self._error
        return self._embed


def _gemini(**fake):
    a = GeminiAdapter("p", api_key="x")
    a._client = _FakeGenaiModels(**fake)
    return a


def _resp(fixture):
    return gtypes.GenerateContentResponse.model_validate(load_fixture(fixture))


def test_gemini_chat_parses_text_usage_finish():
    a = _gemini(response=_resp("gemini-sdk/chat-create.json"))
    r = a.chat([LLMMessage(role="user", content="hi")], model="models/gemini-3.1-flash-lite")
    assert r.text == "OK."
    assert r.prompt_tokens == 11 and r.completion_tokens == 2
    assert r.finish_reason == "stop"
    assert r.model == "gemini-3.1-flash-lite"          # the models/ prefix is stripped
    assert a._client.last["model"] == "gemini-3.1-flash-lite"
    # the turn was mapped to a real Content/Part (role "user")
    sent = a._client.last["contents"][0]
    assert sent.role == "user" and sent.parts[0].text == "hi"


def test_gemini_chat_max_tokens_maps_to_length():
    data = load_fixture("gemini-sdk/chat-create.json")
    data["candidates"][0]["finish_reason"] = "MAX_TOKENS"
    a = _gemini(response=gtypes.GenerateContentResponse.model_validate(data))
    r = a.chat([LLMMessage(role="user", content="hi")])
    assert r.finish_reason == "length"


def test_gemini_stream_assembles_text_and_final_usage():
    chunks = [gtypes.GenerateContentResponse.model_validate(c)
              for c in load_fixture("gemini-sdk/chat-stream.json")]
    a = _gemini(stream=chunks)
    deltas = list(a.stream_chat([LLMMessage(role="user", content="count")]))
    assert "".join(d.text for d in deltas if d.text) == "One, two, three, four, five."
    done = deltas[-1]
    assert done.done and done.prompt_tokens == 7 and done.completion_tokens == 10


def test_gemini_models_filters_to_usable_and_strips_prefix():
    ms = [
        gtypes.Model(name="models/gemini-3.1-flash-lite", supported_actions=["generateContent"]),
        gtypes.Model(name="models/gemini-embedding-001", supported_actions=["embedContent"]),
        gtypes.Model(name="models/veo-3", supported_actions=["predictLongRunning"]),  # noise
        gtypes.Model(name="models/mystery"),  # None supported_actions → KEEP
    ]
    out = _gemini(model_list=ms).models()
    assert "gemini-3.1-flash-lite" in out and "gemini-embedding-001" in out
    assert "veo-3" not in out            # no generate/embed action → dropped (D7)
    assert "mystery" in out              # missing supported_actions treated as keep
    assert all(not m.startswith("models/") for m in out)


def test_gemini_embed_maps_task_type_and_extracts_vectors():
    er = gtypes.EmbedContentResponse.model_validate(
        {"embeddings": [{"values": [0.1, 0.2]}, {"values": [0.3]}]}
    )
    a = _gemini(embed=er)
    assert a.embed(["a", "b"], task_type="document") == [[0.1, 0.2], [0.3]]
    assert a._client.last["model"] == "gemini-embedding-001"          # default embed model
    assert a._client.last["config"].task_type == "RETRIEVAL_DOCUMENT"  # mapped task side
    a2 = _gemini(embed=er)
    a2.embed(["a"], task_type="")
    assert a2._client.last["config"] is None                          # "" → no config


def test_gemini_chat_error_maps_to_d10():
    err = gerrors.ClientError(404, {"error": {"code": 404, "message": "nope", "status": "NOT_FOUND"}}, None)
    with pytest.raises(RuntimeError) as ei:
        _gemini(error=err).chat([LLMMessage(role="user", content="hi")])
    assert str(ei.value).startswith("gemini 404:")


# ── #15 C3: the anthropic SDK surface (allowlist / chat / stream / models / errors) ──


def test_anthropic_map_extra_is_an_allowlist():
    # C3: _map_extra is now an ALLOWLIST over base.select_allowed — only Anthropic's
    # typed params survive (top_p/top_k/metadata + the stop→stop_sequences rename);
    # min_p/mirostat/seed/samplers/response_format are DROPPED at the boundary
    # (red-first: today's pass-through _map_extra forwarded min_p + seed verbatim).
    out = AnthropicAdapter._map_extra({
        "top_p": 0.9, "top_k": 40, "metadata": {"user_id": "u"},
        "stop": ["END"], "min_p": 0.05, "mirostat": 2, "seed": 7,
        "samplers": ["top_k"], "response_format": {"type": "json_object"},
    })
    assert out == {"top_p": 0.9, "top_k": 40, "metadata": {"user_id": "u"},
                   "stop_sequences": ["END"]}
    assert AnthropicAdapter._map_extra(None) is None
    assert AnthropicAdapter._map_extra({"min_p": 0.05}) is None   # nothing survives → None


class _FakeAnthropicModels:
    def __init__(self, model_list=None, error=None):
        self._model_list = model_list or []
        self._error = error

    def list(self):
        if self._error:
            raise self._error
        return iter(self._model_list)


class _FakeAnthropic(KwargsCapture):
    """Fake anthropic client (flat: the adapter calls self._client.messages.create /
    self._client.models.list). .messages.create captures kwargs and returns a canned
    Message, or with stream=True a canned event iterator, or raises a preset error."""

    def __init__(self, *, message=None, stream=None, model_list=None, error=None, list_error=None):
        super().__init__()
        self.messages = self  # flat: .messages.create → self.create
        self.models = _FakeAnthropicModels(model_list, list_error)
        self._message = message
        self._stream = stream or []
        self._error = error

    def create(self, **kwargs):
        self._capture(**kwargs)
        if self._error:
            raise self._error
        if kwargs.get("stream"):
            return iter(self._stream)
        return self._message


def _anthropic(**fake):
    a = AnthropicAdapter("p", api_key="x")
    a._client = _FakeAnthropic(**fake)
    return a


def test_anthropic_chat_assembles_kwargs_and_parses():
    import anthropic as _sdk
    msg = _sdk.types.Message.model_validate({
        "id": "msg_1", "type": "message", "role": "assistant", "model": "claude-haiku-4-5",
        "content": [{"type": "text", "text": "Hel"}, {"type": "text", "text": "lo"}],
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 11, "output_tokens": 5},
    })
    a = _anthropic(message=msg)
    r = a.chat(
        [LLMMessage(role="system", content="be brief"), LLMMessage(role="user", content="hi")],
        model="claude-haiku-4-5", temperature=0.5, max_tokens=256,
        extra={"top_p": 0.9, "stop": ["END"], "min_p": 0.05},
    )
    assert r.text == "Hello"                     # text blocks concatenated
    assert r.finish_reason == "end_turn"
    assert r.prompt_tokens == 11 and r.completion_tokens == 5
    sent = a._client.last
    assert sent["model"] == "claude-haiku-4-5"
    assert sent["system"] == "be brief"          # swept out via split_system
    assert sent["messages"] == [{"role": "user", "content": "hi"}]   # only the user turn, dict-ified
    assert sent["temperature"] == 0.5 and sent["max_tokens"] == 256
    assert sent["top_p"] == 0.9 and sent["stop_sequences"] == ["END"]  # allowlisted + renamed
    assert "min_p" not in sent                   # dropped at the boundary


def test_anthropic_stream_parses_events_and_final_usage():
    from types import SimpleNamespace as NS
    events = [
        NS(type="message_start", message=NS(usage=NS(input_tokens=11))),
        NS(type="content_block_delta", delta=NS(type="text_delta", text="Hel")),
        NS(type="content_block_delta", delta=NS(type="text_delta", text="lo")),
        NS(type="message_delta", usage=NS(output_tokens=7)),
    ]
    a = _anthropic(stream=events)
    deltas = list(a.stream_chat([LLMMessage(role="user", content="hi")]))
    assert "".join(d.text for d in deltas if d.text) == "Hello"
    assert a._client.last["stream"] is True
    done = deltas[-1]
    assert done.done and done.prompt_tokens == 11 and done.completion_tokens == 7


def test_anthropic_models_live_then_curated_fallback():
    from types import SimpleNamespace as NS
    live = _anthropic(model_list=[NS(id="claude-opus-4-8"), NS(id="claude-haiku-4-5")]).models()
    assert live == ["claude-opus-4-8", "claude-haiku-4-5"]        # D8: the live /v1/models list
    fell_back = _anthropic(list_error=RuntimeError("boom")).models()
    assert "claude-haiku-4-5" in fell_back and len(fell_back) >= 5   # curated fallback on error


def test_anthropic_chat_error_maps_to_d10():
    import anthropic as _sdk
    import httpx
    resp = httpx.Response(429, request=httpx.Request("POST", "https://api.anthropic.com/v1/messages"))
    err = _sdk.APIStatusError("slow down", response=resp, body=None)  # status_code = 429
    with pytest.raises(RuntimeError) as ei:
        _anthropic(error=err).chat([LLMMessage(role="user", content="hi")])
    assert str(ei.value).startswith("anthropic 429:")


# ── #15 C4: the openai SDK adapter — Responses (openai) + CC (deepseek/openrouter/xai/
#    mistral). Fakes are thin subclasses of the _sdk_fakes KwargsCapture base. ──


class _Dumpable(NS):
    """A SimpleNamespace that also answers model_dump() (LLMResponse.raw is not asserted)."""

    def model_dump(self, **_kw):
        return {}


class _FakeResponses(KwargsCapture):
    """Fake client.responses: create() captures kwargs, returns a Response (or, with
    stream=True, an event iterator), or raises. `temp_error` fires on the FIRST call only
    (the temperature-retry-once proof)."""

    def __init__(self, *, response=None, stream=None, error=None, temp_error=None):
        super().__init__()
        self._response = response
        self._stream = stream or []
        self._error = error
        self._temp_error = temp_error
        self._calls = 0

    def create(self, **kwargs):
        self._capture(**kwargs)
        self._calls += 1
        if self._temp_error is not None and self._calls == 1:
            raise self._temp_error
        if self._error:
            raise self._error
        if kwargs.get("stream"):
            return iter(self._stream)
        return self._response


class _FakeChatCompletions(KwargsCapture):
    """Fake client.chat.completions: create() captures kwargs + returns a completion or,
    with stream=True, a chunk iterator, or raises."""

    def __init__(self, *, completion=None, stream=None, error=None):
        super().__init__()
        self._completion = completion
        self._stream = stream or []
        self._error = error

    def create(self, **kwargs):
        self._capture(**kwargs)
        if self._error:
            raise self._error
        if kwargs.get("stream"):
            return iter(self._stream)
        return self._completion


class _FakeEmbeddings(KwargsCapture):
    def __init__(self, *, data=None, error=None):
        super().__init__()
        self._data = data or []
        self._error = error

    def create(self, **kwargs):
        self._capture(**kwargs)
        if self._error:
            raise self._error
        return NS(data=self._data)


class _FakeModelsList:
    def __init__(self, model_list=None, error=None):
        self._model_list = model_list or []
        self._error = error

    def list(self):
        if self._error:
            raise self._error
        return iter(self._model_list)


class _FakeOpenAIClient:
    def __init__(self, *, responses=None, completions=None, embeddings=None, models=None):
        self.responses = responses or _FakeResponses()
        self.chat = NS(completions=completions or _FakeChatCompletions())
        self.embeddings = embeddings or _FakeEmbeddings()
        self.models = models or _FakeModelsList()


def _sdk(provider_type, **client):
    a = OpenAISDKAdapter("p", provider_type, api_key="x")
    a._client = _FakeOpenAIClient(**client)
    return a


def test_openai_sdk_cc_profiles_filter_and_rename():
    # openrouter KEEPS top_k/min_p (extra_body) + renames repeat_penalty →
    # repetition_penalty (OpenRouter's documented name); top_p/seed stay typed; the
    # samplers order array + mirostat are DROPPED (never survive on an SDK type — the
    # min_p-400 fix; today's compat.update(extra) would have passed them all through).
    typed, eb = _sdk("openrouter")._cc_params(
        {"top_p": 0.9, "seed": 7, "top_k": 40, "min_p": 0.05, "repeat_penalty": 1.1,
         "samplers": ["top_k"], "mirostat": 2})
    assert typed == {"top_p": 0.9, "seed": 7}
    assert eb == {"top_k": 40, "min_p": 0.05, "repetition_penalty": 1.1}
    # deepseek + xai DROP min_p/top_k (not in profile); seed stays typed; no extra_body.
    for pt in ("deepseek", "xai"):
        typed, eb = _sdk(pt)._cc_params({"top_p": 0.9, "min_p": 0.05, "top_k": 40, "seed": 7})
        assert typed == {"top_p": 0.9, "seed": 7} and eb == {}, pt
    # mistral renames seed → random_seed via extra_body (Mistral's documented name).
    typed, eb = _sdk("mistral")._cc_params({"seed": 7, "top_p": 0.9, "min_p": 0.05})
    assert typed == {"top_p": 0.9} and eb == {"random_seed": 7}


def test_openai_sdk_cc_response_format_downgrade_and_passthrough():
    js = {"type": "json_schema",
          "json_schema": {"name": "k", "schema": {"type": "object"}, "strict": True}}
    # deepseek documents json_object ONLY → a json_schema downgrades to json_object.
    typed, _ = _sdk("deepseek")._cc_params({"response_format": js})
    assert typed["response_format"] == {"type": "json_object"}
    # xai/mistral document real json_schema → passes through untouched.
    for pt in ("xai", "mistral"):
        typed, _ = _sdk(pt)._cc_params({"response_format": js})
        assert typed["response_format"] == js, pt


def test_openai_sdk_reasoning_emission_per_type():
    turn = [LLMMessage(role="user", content="hi")]
    base = dict(model="m", temperature=None, max_tokens=None, system=None, think=True)
    # openai (Responses): think+word → reasoning={"effort": w}
    kw = _sdk("openai")._responses_kwargs(turn, extra={"reasoning_effort": "high"}, **base)
    assert kw["reasoning"] == {"effort": "high"}
    # openrouter (CC): think+word → reasoning_effort
    kw = _sdk("openrouter")._cc_kwargs(turn, extra={"reasoning_effort": "high"}, stream=False, **base)
    assert kw["reasoning_effort"] == "high"
    # deepseek/xai/mistral emit NOTHING even with a word + think-on (D5 EMIT_EFFORT_TYPES).
    for pt in ("deepseek", "xai", "mistral"):
        kw = _sdk(pt)._cc_kwargs(turn, extra={"reasoning_effort": "high"}, stream=False, **base)
        assert "reasoning_effort" not in kw, pt


def test_openai_sdk_responses_store_false_and_input_shapes():
    a = _sdk("openai")
    kw = a._responses_kwargs(
        [LLMMessage(role="user", content="hi")],
        model="gpt-5", temperature=0.5, max_tokens=64, system="be nice", think=False,
        extra={"top_p": 0.8, "min_p": 0.05})
    assert kw["store"] is False                       # never persist — D2/D3
    assert kw["input"] == "hi"                         # single user turn → plain string
    assert kw["instructions"] == "be nice"             # system swept into instructions
    assert kw["temperature"] == 0.5 and kw["max_output_tokens"] == 64
    assert kw["top_p"] == 0.8 and "min_p" not in kw    # only top_p survives on Responses
    # multi-turn → the typed input array (assistant → output_text, user → input_text).
    kw2 = a._responses_kwargs(
        [LLMMessage(role="user", content="q1"),
         LLMMessage(role="assistant", content="a1"),
         LLMMessage(role="user", content="q2")],
        model="gpt-5", temperature=None, max_tokens=None, system=None, think=False, extra=None)
    assert isinstance(kw2["input"], list) and len(kw2["input"]) == 3
    assert kw2["input"][1] == {"role": "assistant", "content": [{"type": "output_text", "text": "a1"}]}
    assert kw2["input"][0]["content"][0]["type"] == "input_text"
    assert "instructions" not in kw2                   # no system → no instructions key


def test_openai_sdk_responses_text_format_strict_false_and_json_object():
    a = _sdk("openai")
    kw = a._responses_kwargs(
        [LLMMessage(role="user", content="hi")],
        model="gpt-5", temperature=None, max_tokens=None, system=None, think=False,
        extra={"response_format": {"type": "json_schema",
               "json_schema": {"name": "sweep", "schema": {"type": "object"}, "strict": True}}})
    # strict ALWAYS False (our schemas don't meet strict's every-key-required rule).
    assert kw["text"] == {"format": {"type": "json_schema", "name": "sweep",
                                     "strict": False, "schema": {"type": "object"}}}
    kw2 = a._responses_kwargs(
        [LLMMessage(role="user", content="hi")],
        model="gpt-5", temperature=None, max_tokens=None, system=None, think=False,
        extra={"response_format": {"type": "json_object"}})
    assert kw2["text"] == {"format": {"type": "json_object"}}


def test_openai_sdk_responses_parse_incomplete_maps_to_length():
    resp = _Dumpable(output_text="hello", usage=NS(input_tokens=12, output_tokens=3),
                     status="incomplete", incomplete_details=NS(reason="max_output_tokens"),
                     model="gpt-5")
    r = _sdk("openai", responses=_FakeResponses(response=resp)).chat(
        [LLMMessage(role="user", content="hi")], model="gpt-5")
    assert r.text == "hello"
    assert r.finish_reason == "length"                 # incomplete + max_output_tokens → length
    assert r.prompt_tokens == 12 and r.completion_tokens == 3


def test_openai_sdk_responses_temperature_retry_once():
    err = openai.APIStatusError(
        "Unsupported parameter: 'temperature' is not supported with this model.",
        response=httpx.Response(400, request=httpx.Request("POST", "https://api.openai.com/v1/responses")),
        body=None)
    resp = _Dumpable(output_text="ok", usage=NS(input_tokens=1, output_tokens=1),
                     status="completed", incomplete_details=None, model="o3")
    fake = _FakeResponses(response=resp, temp_error=err)
    r = _sdk("openai", responses=fake).chat([LLMMessage(role="user", content="hi")],
                                            model="o3", temperature=0.7)
    assert r.text == "ok"                              # retried WITHOUT temperature → succeeded
    assert fake._calls == 2                            # exactly one retry
    assert "temperature" not in fake.last              # the retry dropped temperature


def test_openai_sdk_responses_stream_parses_text_and_usage():
    events = [
        NS(type="response.output_text.delta", delta="Hel"),
        NS(type="response.output_text.delta", delta="lo"),
        NS(type="response.completed", response=NS(usage=NS(input_tokens=8, output_tokens=5))),
    ]
    deltas = list(_sdk("openai", responses=_FakeResponses(stream=events)).stream_chat(
        [LLMMessage(role="user", content="hi")], model="gpt-5"))
    assert "".join(d.text for d in deltas if d.text) == "Hello"
    done = deltas[-1]
    assert done.done and done.prompt_tokens == 8 and done.completion_tokens == 5


def test_openai_sdk_cc_chat_parses_and_builds_messages():
    comp = _Dumpable(choices=[NS(message=NS(content="hi there"), finish_reason="stop")],
                     usage=NS(prompt_tokens=5, completion_tokens=2), model="deepseek-chat")
    a = _sdk("deepseek", completions=_FakeChatCompletions(completion=comp))
    r = a.chat([LLMMessage(role="system", content="sys"), LLMMessage(role="user", content="hi")],
               model="deepseek-chat", extra={"min_p": 0.05, "top_p": 0.9})
    assert r.text == "hi there" and r.finish_reason == "stop"
    assert r.prompt_tokens == 5 and r.completion_tokens == 2
    sent = a._client.chat.completions.last
    assert sent["messages"][0] == {"role": "system", "content": "sys"}   # build_chat_messages
    assert sent["top_p"] == 0.9 and "min_p" not in sent                  # min_p dropped at boundary


def test_openai_sdk_cc_stream_parses_text_and_usage():
    chunks = [
        NS(usage=None, choices=[NS(delta=NS(content="Hel"))]),
        NS(usage=None, choices=[NS(delta=NS(content="lo"))]),
        NS(usage=NS(prompt_tokens=9, completion_tokens=4), choices=[]),  # final usage frame, empty choices
    ]
    a = _sdk("deepseek", completions=_FakeChatCompletions(stream=chunks))
    deltas = list(a.stream_chat([LLMMessage(role="user", content="hi")], model="deepseek-chat"))
    assert "".join(d.text for d in deltas if d.text) == "Hello"
    done = deltas[-1]
    assert done.done and done.prompt_tokens == 9 and done.completion_tokens == 4
    sent = a._client.chat.completions.last
    assert sent["stream"] is True and sent["stream_options"] == {"include_usage": True}


def test_openai_sdk_embed_extracts_index_ordered_vectors():
    data = [NS(embedding=[0.1, 0.2]), NS(embedding=[0.3, 0.4])]
    a = _sdk("openai", embeddings=_FakeEmbeddings(data=data))
    out = a.embed(["a", "b"], model="text-embedding-3-small", task_type="document")  # task_type ignored
    assert out == [[0.1, 0.2], [0.3, 0.4]]
    assert a._client.embeddings.last["model"] == "text-embedding-3-small"


def test_openai_sdk_cc_error_maps_to_d10():
    err = openai.APIStatusError(
        "rate limited",
        response=httpx.Response(429, request=httpx.Request("POST", "https://api.deepseek.com/v1/chat/completions")),
        body=None)
    with pytest.raises(RuntimeError) as ei:
        _sdk("deepseek", completions=_FakeChatCompletions(error=err)).chat(
            [LLMMessage(role="user", content="hi")], model="deepseek-chat")
    assert str(ei.value).startswith("deepseek 429:")


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
    # (#15 C4: the old ("openai", False) row is now ("openai-compat", False) — "openai" rides
    # openai_sdk and no longer constructs on compat; a non-builtin compat type still gets no
    # return_progress, and openai-compat's default base_url keeps construction valid.)
    for ptype, expected in (("local-llamacpp", True), ("openai-compat", False), ("openai-compat", False)):
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
