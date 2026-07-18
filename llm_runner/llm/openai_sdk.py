# SPDX-License-Identifier: GPL-3.0-or-later
"""OpenAI + OpenAI-shaped clouds — the official ``openai`` SDK (the 2026-07-17 SDK pivot,
#15 C4).

Serves five provider types behind ONE adapter (registry.construct):
  - ``openai``    → the **Responses API** (``client.responses.create``), D3.
  - ``deepseek`` / ``openrouter`` / ``xai`` / ``mistral`` → **chat-completions**
    (``client.chat.completions.create``) at each vendor's base_url, D4.

The SDK owns the wire + retries, and every sampler is a TYPED param, so the ``min_p``
400 unknown-field bug dies at the boundary: per-type ``TYPE_PARAM_PROFILES`` allowlist
what each cloud documents; anything else in ``extra`` is DROPPED. Reasoning emission is
per-type (D5): ``EMIT_EFFORT_TYPES`` only; the rest run at the model's own default.

BUILD-TIME VERIFY (2026-07-17, this session — recorded per the plan, not from memory):
  * ``openai==2.46.0`` introspection — Responses stream event ``type`` strings:
    ``response.output_text.delta`` (ResponseTextDeltaEvent, ``.delta`` str),
    ``response.completed`` (ResponseCompletedEvent, ``.response.usage``),
    ``response.failed`` (ResponseFailedEvent), ``error`` (ResponseErrorEvent),
    ``response.incomplete`` (ResponseIncompleteEvent). Non-stream: ``r.output_text``
    (SDK aggregation property), ``r.usage.input_tokens/output_tokens``, ``r.status``,
    ``r.incomplete_details.reason``. ``APIStatusError`` instances carry ``.status_code``.
  * Vendor DOC verify (official docs, no live call): OpenRouter documents
    ``reasoning_effort`` on chat-completions AND the samplers ``top_k`` / ``min_p`` /
    ``repetition_penalty`` (spelled with the -tion); Mistral uses ``random_seed`` (NOT
    ``seed``) and supports a real ``json_schema`` ``response_format``; DeepSeek's
    ``response_format`` is ``json_object`` ONLY (no ``json_schema``); xAI supports
    ``json_schema``. All CONFIRMED — the tables below match.

See ``docs/plans/2026-07-17-provider-native-dialects-plan.md`` §0.5 / §6.
"""

from __future__ import annotations

import logging
from typing import Any, Iterator

import openai

from .base import (
    LLMMessage,
    LLMResponse,
    StreamDelta,
    adapter_http_error,
    build_chat_messages,
    pop_reasoning,
    select_allowed,
    split_system,
)

log = logging.getLogger(__name__)


# Per-type default base_url + default_model (used when the config leaves them blank).
PROVIDER_DEFAULTS = {
    "openai":     {"base_url": "https://api.openai.com/v1",    "default_model": "gpt-4o-mini"},
    "deepseek":   {"base_url": "https://api.deepseek.com/v1",  "default_model": "deepseek-chat"},
    "openrouter": {"base_url": "https://openrouter.ai/api/v1", "default_model": "openai/gpt-4o-mini"},
    "xai":        {"base_url": "https://api.x.ai/v1",          "default_model": ""},
    "mistral":    {"base_url": "https://api.mistral.ai/v1",    "default_model": ""},
}

# The typed chat-completions params each cloud DOCUMENTS; everything else in `extra` is
# dropped (the min_p-400 fix on the SDK path). openrouter additionally documents the
# llama-family long-tail samplers (top_k/min_p/repetition_penalty), delivered via
# extra_body (see TYPE_EXTRA_BODY_RENAMES). (openai is NOT here — it rides the Responses
# path, which speaks only top_p among samplers.)
TYPE_PARAM_PROFILES = {
    "deepseek":   {"top_p", "stop", "seed", "presence_penalty", "frequency_penalty", "response_format"},
    "openrouter": {"top_p", "stop", "seed", "presence_penalty", "frequency_penalty",
                   "response_format", "top_k", "min_p", "repeat_penalty"},
    "xai":        {"top_p", "stop", "seed", "presence_penalty", "frequency_penalty", "response_format"},
    "mistral":    {"top_p", "stop", "presence_penalty", "frequency_penalty", "response_format", "seed"},
}

# Source-key → wire-name for profile params delivered via `extra_body` (not a typed CC
# param, or provider-renamed). openrouter: top_k/min_p pass through, repeat_penalty →
# repetition_penalty (OpenRouter's documented spelling). mistral: seed → random_seed
# (Mistral's documented name — verified 2026-07-17). Everything not listed is a typed kwarg.
TYPE_EXTRA_BODY_RENAMES = {
    "openrouter": {"top_k": "top_k", "min_p": "min_p", "repeat_penalty": "repetition_penalty"},
    "mistral": {"seed": "random_seed"},
}

# D5: only these types emit a reasoning-effort param. openai → Responses reasoning.effort;
# openrouter → CC reasoning_effort (both documented). deepseek/xai/mistral emit NOTHING —
# the model thinks at its own default (DeepSeek has no such param, xAI varies by model gen,
# Mistral 422-rejects unknown params).
EMIT_EFFORT_TYPES = {"openai", "openrouter"}


class OpenAISDKAdapter:
    """Adapter for OpenAI (Responses API) and the OpenAI-shaped clouds
    (deepseek/openrouter/xai/mistral, chat-completions) over the official openai SDK."""

    def __init__(
        self,
        provider_id: str,
        provider_type: str,
        *,
        api_key: str = "",
        base_url: str = "",
        default_model: str = "",
        timeout_seconds: int = 60,
    ):
        self.provider_id = provider_id
        self.provider_type = provider_type
        # 3-line resolve repeated (not extracted) from openai_compat.py — the DATA splits
        # legitimately and a helper over 3 lines / 2 files is over-abstraction (ruled).
        defaults = PROVIDER_DEFAULTS.get(provider_type) or {}
        self._base_url = (base_url or defaults.get("base_url", "")).rstrip("/")
        self.default_model = default_model or defaults.get("default_model", "")
        if not self._base_url:
            raise ValueError(
                f"provider {provider_id} ({provider_type}) has no base_url "
                f"and no default available — set base_url in the provider config"
            )
        # D9: max_retries=2 (SDK default) + the provider's timeout + base_url. A dummy key
        # keeps the client constructible for a keyless local gateway; real calls 401 without.
        self._client = openai.OpenAI(
            api_key=api_key or "sk-no-key",
            base_url=self._base_url,
            timeout=timeout_seconds,
            max_retries=2,
        )

    # ── param mapping ───────────────────────────────────────────────

    def _cc_params(self, extra: dict[str, Any] | None) -> tuple[dict, dict]:
        """Split the profile-allowed `extra` into (typed_kwargs, extra_body). Keys not in
        this type's profile are DROPPED (the min_p-400 fix); the extra_body renames carry
        openrouter's long-tail samplers + mistral's random_seed."""
        pt = self.provider_type
        kept = select_allowed(extra, TYPE_PARAM_PROFILES.get(pt, set()))
        # DeepSeek documents json_object ONLY (verified) — downgrade a json_schema
        # response_format to json_object (today it would 400 the same run; this is a
        # strict improvement). xai/mistral document real json_schema; openrouter forwards
        # per-model — both pass through untouched.
        rf = kept.get("response_format")
        if pt == "deepseek" and isinstance(rf, dict) and rf.get("type") == "json_schema":
            kept["response_format"] = {"type": "json_object"}
        renames = TYPE_EXTRA_BODY_RENAMES.get(pt, {})
        typed: dict[str, Any] = {}
        extra_body: dict[str, Any] = {}
        for k, v in kept.items():
            if k in renames:
                extra_body[renames[k]] = v
            else:
                typed[k] = v
        return typed, extra_body

    @staticmethod
    def _responses_input(turns: list[LLMMessage]):
        """A single user turn with no history → a plain string; else the typed input
        array (assistant turns use output_text, everything else input_text)."""
        if len(turns) == 1 and turns[0].role == "user":
            return turns[0].content
        return [
            {
                "role": m.role,
                "content": [{
                    "type": "output_text" if m.role == "assistant" else "input_text",
                    "text": m.content,
                }],
            }
            for m in turns
        ]

    @staticmethod
    def _responses_text(extra: dict[str, Any] | None) -> dict | None:
        """Responses `text` format from a response_format contract. json_schema → the
        schema-enforced format with strict ALWAYS False (our schemas don't meet strict's
        every-key-required rule — pre-ruled, never mutate the schema); json_object → the
        json_object format. A json_schema without a usable schema falls back to json_object."""
        rf = (extra or {}).get("response_format")
        if not isinstance(rf, dict):
            return None
        t = rf.get("type")
        if t == "json_schema":
            js = rf.get("json_schema") or {}
            schema = js.get("schema")
            if isinstance(schema, dict):
                return {"format": {
                    "type": "json_schema",
                    "name": js.get("name") or "response",
                    "strict": False,
                    "schema": schema,
                }}
        if t in ("json_schema", "json_object", "json"):
            return {"format": {"type": "json_object"}}
        return None

    def _responses_kwargs(
        self, messages, *, model, temperature, max_tokens, system, think, extra
    ) -> dict[str, Any]:
        extra, effort, _budget = pop_reasoning(extra)
        sys_text, turns = split_system(messages, system)
        kwargs: dict[str, Any] = {
            "model": model or self.default_model,
            "input": self._responses_input(turns),
            "store": False,  # the never-persist ruling — no server-side interaction object
        }
        if sys_text:
            kwargs["instructions"] = sys_text
        if temperature is not None:
            kwargs["temperature"] = temperature
        if max_tokens is not None:
            kwargs["max_output_tokens"] = max_tokens
        # openai speaks only top_p among the samplers on Responses; the rest drop here.
        kwargs.update(select_allowed(extra, {"top_p"}))
        if think and effort:
            kwargs["reasoning"] = {"effort": effort}
        fmt = self._responses_text(extra)
        if fmt is not None:
            kwargs["text"] = fmt
        return kwargs

    def _cc_kwargs(
        self, messages, *, model, temperature, max_tokens, system, think, extra, stream
    ) -> dict[str, Any]:
        extra, effort, _budget = pop_reasoning(extra)
        typed, extra_body = self._cc_params(extra)
        kwargs: dict[str, Any] = {
            "model": model or self.default_model,
            "messages": build_chat_messages(messages, system),
        }
        if temperature is not None:
            kwargs["temperature"] = temperature
        if max_tokens is not None:
            kwargs["max_tokens"] = max_tokens
        if stream:
            kwargs["stream"] = True
            kwargs["stream_options"] = {"include_usage": True}
        if think and effort and self.provider_type in EMIT_EFFORT_TYPES:
            kwargs["reasoning_effort"] = effort
        kwargs.update(typed)
        if extra_body:
            kwargs["extra_body"] = extra_body
        return kwargs

    def _responses_create(self, kwargs: dict, *, stream: bool):
        """Create a Responses call; if a reasoning model 400s on `temperature`, pop it and
        retry ONCE with a single WARNING (no reuse mechanism exists — carried ruling)."""
        try:
            return self._client.responses.create(**kwargs, stream=stream)
        except openai.APIStatusError as e:
            if (e.status_code == 400 and "temperature" in kwargs
                    and "temperature" in str(e).lower()):
                log.warning(
                    "openai Responses rejected temperature — retrying once without it "
                    "(reasoning model)"
                )
                kwargs.pop("temperature", None)
                return self._client.responses.create(**kwargs, stream=stream)
            raise

    # ── Protocol implementation ─────────────────────────────────────

    def chat(
        self,
        messages: list[LLMMessage],
        *,
        model: str | None = None,
        temperature: float | None = 0.7,
        max_tokens: int | None = None,
        system: str | None = None,
        think: bool = False,
        extra: dict[str, Any] | None = None,
    ) -> LLMResponse:
        if self.provider_type == "openai":
            kwargs = self._responses_kwargs(
                messages, model=model, temperature=temperature, max_tokens=max_tokens,
                system=system, think=think, extra=extra,
            )
            try:
                r = self._responses_create(kwargs, stream=False)
            except openai.APIStatusError as e:
                raise adapter_http_error(self.provider_type, e.status_code, str(e)) from e
            except Exception as e:
                raise adapter_http_error(self.provider_type, None, str(e)) from e
            usage = getattr(r, "usage", None)
            finish = "stop"
            if getattr(r, "status", None) == "incomplete":
                reason = getattr(getattr(r, "incomplete_details", None), "reason", None)
                if reason == "max_output_tokens":
                    finish = "length"
            return LLMResponse(
                text=r.output_text or "",
                model=getattr(r, "model", None) or kwargs["model"],
                finish_reason=finish,
                prompt_tokens=int(getattr(usage, "input_tokens", 0) or 0) if usage else 0,
                completion_tokens=int(getattr(usage, "output_tokens", 0) or 0) if usage else 0,
                raw=r.model_dump(exclude_none=True),
            )

        kwargs = self._cc_kwargs(
            messages, model=model, temperature=temperature, max_tokens=max_tokens,
            system=system, think=think, extra=extra, stream=False,
        )
        try:
            resp = self._client.chat.completions.create(**kwargs)
        except openai.APIStatusError as e:
            raise adapter_http_error(self.provider_type, e.status_code, str(e)) from e
        except Exception as e:
            raise adapter_http_error(self.provider_type, None, str(e)) from e
        choice = resp.choices[0] if resp.choices else None
        msg = getattr(choice, "message", None) if choice else None
        usage = getattr(resp, "usage", None)
        return LLMResponse(
            text=(getattr(msg, "content", None) or "") if msg else "",
            model=getattr(resp, "model", None) or kwargs["model"],
            finish_reason=(getattr(choice, "finish_reason", None) or "stop") if choice else "stop",
            prompt_tokens=int(getattr(usage, "prompt_tokens", 0) or 0) if usage else 0,
            completion_tokens=int(getattr(usage, "completion_tokens", 0) or 0) if usage else 0,
            raw=resp.model_dump(exclude_none=True),
        )

    def stream_chat(
        self,
        messages: list[LLMMessage],
        *,
        model: str | None = None,
        temperature: float | None = 0.7,
        max_tokens: int | None = None,
        system: str | None = None,
        think: bool = False,
        extra: dict[str, Any] | None = None,
    ) -> Iterator[StreamDelta]:
        if self.provider_type == "openai":
            yield from self._stream_responses(
                messages, model=model, temperature=temperature, max_tokens=max_tokens,
                system=system, think=think, extra=extra,
            )
        else:
            yield from self._stream_cc(
                messages, model=model, temperature=temperature, max_tokens=max_tokens,
                system=system, think=think, extra=extra,
            )

    def _stream_responses(self, messages, *, model, temperature, max_tokens, system, think, extra):
        kwargs = self._responses_kwargs(
            messages, model=model, temperature=temperature, max_tokens=max_tokens,
            system=system, think=think, extra=extra,
        )
        pt = ct = 0
        try:
            stream = self._responses_create(kwargs, stream=True)
            for event in stream:
                etype = getattr(event, "type", None)
                if etype == "response.output_text.delta":
                    piece = getattr(event, "delta", "") or ""
                    if piece:
                        yield StreamDelta(text=piece)
                elif etype == "response.completed":
                    u = getattr(getattr(event, "response", None), "usage", None)
                    if u is not None:
                        pt = int(getattr(u, "input_tokens", 0) or 0)
                        ct = int(getattr(u, "output_tokens", 0) or 0)
                elif etype in ("response.failed", "error"):
                    raise adapter_http_error(
                        self.provider_type, None, _stream_failure_detail(event), stream=True
                    )
                # every other event type (reasoning deltas, tool calls, …) is ignored
        except openai.APIStatusError as e:
            raise adapter_http_error(self.provider_type, e.status_code, str(e), stream=True) from e
        except RuntimeError:
            raise  # the D10 stream error we just raised — don't re-wrap
        except Exception as e:
            raise adapter_http_error(self.provider_type, None, str(e)) from e
        yield StreamDelta(done=True, prompt_tokens=pt, completion_tokens=ct)

    def _stream_cc(self, messages, *, model, temperature, max_tokens, system, think, extra):
        kwargs = self._cc_kwargs(
            messages, model=model, temperature=temperature, max_tokens=max_tokens,
            system=system, think=think, extra=extra, stream=True,
        )
        pt = ct = 0
        try:
            stream = self._client.chat.completions.create(**kwargs)
            for chunk in stream:
                cu = getattr(chunk, "usage", None)
                if cu is not None:
                    pt = int(getattr(cu, "prompt_tokens", 0) or 0)
                    ct = int(getattr(cu, "completion_tokens", 0) or 0)
                # the final usage frame carries an empty choices list — guard it.
                for choice in (getattr(chunk, "choices", None) or []):
                    delta = getattr(choice, "delta", None)
                    piece = getattr(delta, "content", None) if delta else None
                    if piece:
                        yield StreamDelta(text=piece)
        except openai.APIStatusError as e:
            raise adapter_http_error(self.provider_type, e.status_code, str(e), stream=True) from e
        except Exception as e:
            raise adapter_http_error(self.provider_type, None, str(e)) from e
        yield StreamDelta(done=True, prompt_tokens=pt, completion_tokens=ct)

    def embed(self, texts: list[str], *, model: str | None = None, task_type: str = "") -> list[list[float]]:
        # task_type accepted + ignored (C5): OpenAI-shape embeddings have no task concept.
        try:
            r = self._client.embeddings.create(input=list(texts), model=model or self.default_model)
        except openai.APIStatusError as e:
            raise adapter_http_error(self.provider_type, e.status_code, str(e)) from e
        except Exception as e:
            raise adapter_http_error(self.provider_type, None, str(e)) from e
        return [list(d.embedding) for d in r.data]

    def models(self) -> list[str]:
        try:
            return [m.id for m in self._client.models.list()]
        except Exception:
            return []

    def ping(self) -> bool:
        try:
            self._client.models.list()
            return True
        except openai.APIStatusError as e:
            return (e.status_code or 500) < 500
        except Exception:
            return False


def _stream_failure_detail(event) -> str:
    """Best-effort message off a response.failed / error stream event (no HTTP status on
    a mid-stream failure — the D10 helper renders the request-failed form)."""
    resp = getattr(event, "response", None)
    err = getattr(resp, "error", None)
    msg = (getattr(err, "message", None)
           or getattr(event, "message", None)
           or "stream failed")
    return str(msg)
