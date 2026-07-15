# SPDX-License-Identifier: GPL-3.0-or-later
"""Anthropic Claude adapter.

Speaks the Anthropic Messages API (POST /v1/messages). Distinct from
the OpenAI chat-completions shape — system prompt goes in a top-level
`system` field, not as a system-role message.

Uses httpx directly (not the anthropic SDK) so this adapter has no
runtime dependency on the `anthropic` pip package. Lifted verbatim from
JustVoice `server/justvoice/engines/llm/anthropic.py` into the shared
`llm_runner` package (2026-06-21 AI-stack convergence).
"""

from __future__ import annotations

import json
import logging
from typing import Any, Iterator

import httpx

from .base import LLMMessage, LLMResponse, StreamDelta, pop_reasoning

log = logging.getLogger(__name__)


DEFAULT_BASE_URL = "https://api.anthropic.com"
DEFAULT_MODEL = "claude-haiku-4-5"
ANTHROPIC_VERSION = "2023-06-01"


class AnthropicAdapter:
    """LLM adapter for Anthropic's Claude family."""

    def __init__(
        self,
        provider_id: str,
        *,
        api_key: str,
        base_url: str = "",
        default_model: str = "",
        timeout_seconds: int = 60,
    ):
        self.provider_id = provider_id
        self.provider_type = "anthropic"
        self._api_key = api_key
        self._base_url = (base_url or DEFAULT_BASE_URL).rstrip("/")
        self.default_model = default_model or DEFAULT_MODEL
        self._client = httpx.Client(timeout=timeout_seconds)

    # ── Helpers ─────────────────────────────────────────────────────

    def _headers(self) -> dict[str, str]:
        return {
            "x-api-key": self._api_key,
            "anthropic-version": ANTHROPIC_VERSION,
            "content-type": "application/json",
        }

    def _split_system(
        self, messages: list[LLMMessage], system: str | None
    ) -> tuple[str | None, list[dict]]:
        """Anthropic wants system in a top-level field and the messages
        list to contain only user/assistant turns. Honor an explicit
        `system=` kwarg, then sweep any role="system" messages out of
        the list and concatenate them after."""
        system_parts: list[str] = []
        if system:
            system_parts.append(system)
        out: list[dict] = []
        for m in messages:
            if m.role == "system":
                system_parts.append(m.content)
                continue
            out.append({"role": m.role, "content": m.content})
        return ("\n\n".join(system_parts) if system_parts else None, out)

    # Model-generation split (U2-T5, verified 2026-07-14 at platform.claude.com/docs
    # effort + adaptive-thinking): NEW models take ADAPTIVE thinking + output_config.effort
    # (the effort WORD from the reasoning_map) and 400-REJECT the legacy budget_tokens +
    # sampler params; LEGACY models (claude-haiku-4-5 and older) take the classic
    # budget_tokens (the NUMBER from the reasoning_map, via the resolver — no adapter table
    # any more; the old _THINK_BUDGET is gone). Re-verify this id list at each model launch.
    _ADAPTIVE_SUBSTRINGS = ("opus-4-6", "opus-4-7", "opus-4-8", "sonnet-4-6", "sonnet-5", "fable-5", "mythos-5")
    _ALWAYS_THINKS_SUBSTRINGS = ("fable-5", "mythos-5")

    @staticmethod
    def _apply_reasoning(body: dict, think: bool, effort: str, budget: int | None, model: str) -> None:
        """Anthropic extended thinking (a1/E2), model-aware (U2-T5). NEW models: adaptive
        thinking + output_config.effort (the map WORD); drop temperature/top_p/top_k the
        newest models 400-reject; a model that can't disable thinking (Fable/Mythos 5) sends
        no explicit disable. LEGACY models: a `thinking` block with budget_tokens (the map
        NUMBER, ≥1024 AND < max_tokens) + a max_tokens bump; drop the temperature override."""
        m = (model or "").lower()
        adaptive = any(s in m for s in AnthropicAdapter._ADAPTIVE_SUBSTRINGS)
        always_thinks = any(s in m for s in AnthropicAdapter._ALWAYS_THINKS_SUBSTRINGS)
        if not think:
            if adaptive and not always_thinks:
                body["thinking"] = {"type": "disabled"}  # new models: explicit off (e.g. Sonnet 5)
            return
        if adaptive:
            body["thinking"] = {"type": "adaptive"}
            if effort:
                body["output_config"] = {"effort": effort}
            for k in ("temperature", "top_p", "top_k"):
                body.pop(k, None)  # the newest models 400-reject sampler params under thinking
        else:
            b = budget if budget is not None else 4096
            body["thinking"] = {"type": "enabled", "budget_tokens": b}
            body["max_tokens"] = max(int(body.get("max_tokens") or 4096), b + 2048)
            body.pop("temperature", None)  # thinking requires the default temperature

    # ── Protocol implementation ─────────────────────────────────────

    @staticmethod
    def _map_extra(extra: dict | None) -> dict | None:
        """Anthropic uses `stop_sequences` (array), not the OpenAI `stop`; rename so
        the shared per-feature stop-sequence list reaches Claude. `response_format`
        is STRIPPED — the Messages API has no such parameter (the prompt describes
        the JSON shape; enforcement is a llama.cpp/OpenAI/Ollama/Gemini capability);
        forwarding it was a latent #18 leak, fixed with C1. Other keys pass through
        unchanged."""
        if not extra:
            return extra
        out = dict(extra)
        if "stop" in out:
            out["stop_sequences"] = out.pop("stop")
        out.pop("response_format", None)
        return out

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
        sys_prompt, msgs = self._split_system(messages, system)
        body: dict[str, Any] = {
            "model": model or self.default_model,
            "messages": msgs,
            # Anthropic requires max_tokens — pick a high default if not set.
            "max_tokens": max_tokens or 4096,
        }
        if temperature is not None:
            body["temperature"] = temperature
        if sys_prompt:
            body["system"] = sys_prompt
        extra, effort, budget = pop_reasoning(extra)
        extra = self._map_extra(extra)
        if extra:
            body.update(extra)
        self._apply_reasoning(body, think, effort, budget, body["model"])

        url = f"{self._base_url}/v1/messages"
        try:
            r = self._client.post(url, json=body, headers=self._headers())
        except httpx.HTTPError as e:
            raise RuntimeError(f"anthropic request failed: {e}") from e
        if r.status_code >= 400:
            raise RuntimeError(
                f"anthropic {r.status_code}: {r.text[:400]}"
            )
        payload = r.json()
        # `content` is a list of {type, text} blocks (multi-modal future-proof).
        text_parts = [
            blk.get("text", "")
            for blk in payload.get("content", [])
            if blk.get("type") == "text"
        ]
        text = "".join(text_parts)
        usage = payload.get("usage") or {}
        return LLMResponse(
            text=text,
            model=payload.get("model") or body["model"],
            finish_reason=payload.get("stop_reason") or "stop",
            prompt_tokens=int(usage.get("input_tokens") or 0),
            completion_tokens=int(usage.get("output_tokens") or 0),
            raw=payload,
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
        sys_prompt, msgs = self._split_system(messages, system)
        body: dict[str, Any] = {
            "model": model or self.default_model,
            "messages": msgs,
            "max_tokens": max_tokens or 4096,
            "stream": True,
        }
        if temperature is not None:
            body["temperature"] = temperature
        if sys_prompt:
            body["system"] = sys_prompt
        extra, effort, budget = pop_reasoning(extra)
        extra = self._map_extra(extra)
        if extra:
            body.update(extra)
        self._apply_reasoning(body, think, effort, budget, body["model"])

        url = f"{self._base_url}/v1/messages"
        pt = ct = 0
        with self._client.stream("POST", url, json=body, headers=self._headers()) as r:
            if r.status_code >= 400:
                detail = r.read().decode("utf-8", errors="replace")
                raise RuntimeError(f"anthropic stream {r.status_code}: {detail[:400]}")
            for line in r.iter_lines():
                if not line or not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if not data or data == "[DONE]":
                    continue
                try:
                    evt = json.loads(data)
                except json.JSONDecodeError:
                    continue
                t = evt.get("type")
                if t == "message_start":
                    u = ((evt.get("message") or {}).get("usage")) or {}
                    pt = int(u.get("input_tokens") or 0)
                elif t == "content_block_delta":
                    chunk = (evt.get("delta") or {}).get("text") or ""
                    if chunk:
                        yield StreamDelta(text=chunk)
                elif t == "message_delta":
                    u = evt.get("usage") or {}
                    if u.get("output_tokens") is not None:
                        ct = int(u.get("output_tokens") or 0)
        yield StreamDelta(done=True, prompt_tokens=pt, completion_tokens=ct)

    def models(self) -> list[str]:
        # Anthropic doesn't expose a public /v1/models endpoint that
        # enumerates the consumer-facing model ids. Return a curated
        # static list — users can override with a custom model id in
        # the dispatch call.
        return [
            "claude-fable-5",
            "claude-mythos-5",
            "claude-opus-4-8",
            "claude-opus-4-7",
            "claude-sonnet-5",
            "claude-sonnet-4-6",
            "claude-haiku-4-5",
            "claude-haiku-4-5-20251001",
        ]

    def ping(self) -> bool:
        try:
            # Tiny ping: ask for 1 token. Cheap + validates key.
            r = self._client.post(
                f"{self._base_url}/v1/messages",
                json={
                    "model": self.default_model,
                    "messages": [{"role": "user", "content": "ping"}],
                    "max_tokens": 1,
                },
                headers=self._headers(),
            )
            return r.status_code < 500
        except httpx.HTTPError:
            return False
