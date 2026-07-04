# SPDX-License-Identifier: GPL-3.0-or-later
"""OpenAI-compatible adapter — shared by OpenAI / DeepSeek / OpenRouter
and any other provider speaking the chat-completions shape.

Lifted verbatim from JustVoice `server/justvoice/engines/llm/openai_compat.py`
into the shared `llm_runner` package (2026-06-21 AI-stack convergence).
Provider-specific quirks (Ollama's /api/chat, Anthropic's Messages API,
Gemini's generativelanguage shape) live in their own adapter modules.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Iterator

import httpx

from .base import LLMMessage, LLMResponse, StreamDelta, pop_reasoning_effort

log = logging.getLogger(__name__)


# Per-provider default base URLs. Used when the provider config's base_url
# is empty — the most common case (user only enters an API key).
PROVIDER_DEFAULTS = {
    "openai": {
        "base_url": "https://api.openai.com/v1",
        "default_model": "gpt-4o-mini",
    },
    "openai-compat": {
        # No real default — a "compat" provider always has a custom URL.
        "base_url": "http://localhost:11434/v1",
        "default_model": "llama3.2",
    },
    "deepseek": {
        "base_url": "https://api.deepseek.com/v1",
        "default_model": "deepseek-chat",
    },
    "openrouter": {
        "base_url": "https://openrouter.ai/api/v1",
        "default_model": "openai/gpt-4o-mini",
    },
    "local-llamacpp": {
        # The built-in llama.cpp runner spawns llama-server on loopback
        # (default port 8080). default_model is empty — the model is whatever
        # GGUF the runner loaded; llama-server accepts any model id.
        "base_url": "http://127.0.0.1:8080/v1",
        "default_model": "",
    },
}


class OpenAICompatAdapter:
    """Adapter for any provider that speaks POST /chat/completions in the
    OpenAI shape. Covers OpenAI itself, DeepSeek, OpenRouter, and any
    self-hosted server matching the spec (vLLM, llama.cpp's server,
    LM Studio, Together, Groq, Mistral, etc.)."""

    def __init__(
        self,
        provider_id: str,
        provider_type: str,
        *,
        api_key: str,
        base_url: str = "",
        default_model: str = "",
        timeout_seconds: int = 60,
    ):
        self.provider_id = provider_id
        self.provider_type = provider_type
        self._api_key = api_key

        defaults = PROVIDER_DEFAULTS.get(provider_type) or {}
        self._base_url = (base_url or defaults.get("base_url", "")).rstrip("/")
        self.default_model = default_model or defaults.get("default_model", "")

        if not self._base_url:
            raise ValueError(
                f"provider {provider_id} ({provider_type}) has no base_url "
                f"and no default available — set base_url in the provider config"
            )

        self._client = httpx.Client(timeout=timeout_seconds)

    def _headers(self) -> dict[str, str]:
        h: dict[str, str] = {"content-type": "application/json"}
        if self._api_key:
            h["authorization"] = f"Bearer {self._api_key}"
        return h

    @staticmethod
    def _build_messages(
        messages: list[LLMMessage], system: str | None
    ) -> list[dict]:
        out: list[dict] = []
        if system:
            out.append({"role": "system", "content": system})
        for m in messages:
            out.append({"role": m.role, "content": m.content})
        return out

    def _apply_reasoning(self, body: dict, think: bool, effort: str) -> None:
        """Map reasoning to this server's native control (a1/E2). The bundled local
        llama.cpp runner gets the explicit `chat_template_kwargs.enable_thinking` toggle
        BOTH ways, so ONE resident model serves thinking-on (chat) AND thinking-off
        (extraction) per-request with NO reload / section-swap (box-verified 2026-07-04;
        a per-request toggle works only when no hard `reasoning-budget` is on the CLI —
        we emit none). A generic `openai-compat` server keeps the conservative
        on→enable_thinking / off→nothing: we don't own its chat template, so we don't
        force `false` on it. OpenAI-family clouds take the `reasoning_effort` body param."""
        if self.provider_type == "local-llamacpp":
            body.setdefault("chat_template_kwargs", {})["enable_thinking"] = think
            return
        if not think:
            return
        if self.provider_type == "openai-compat":
            body.setdefault("chat_template_kwargs", {})["enable_thinking"] = True
        else:
            body["reasoning_effort"] = effort or "medium"

    def chat(
        self,
        messages: list[LLMMessage],
        *,
        model: str | None = None,
        temperature: float = 0.7,
        max_tokens: int | None = None,
        system: str | None = None,
        think: bool = False,
        extra: dict[str, Any] | None = None,
    ) -> LLMResponse:
        body: dict[str, Any] = {
            "model": model or self.default_model,
            "messages": self._build_messages(messages, system),
            "temperature": temperature,
        }
        if max_tokens is not None:
            body["max_tokens"] = max_tokens
        extra, effort = pop_reasoning_effort(extra)
        if extra:
            body.update(extra)
        self._apply_reasoning(body, think, effort)

        url = f"{self._base_url}/chat/completions"
        try:
            r = self._client.post(url, json=body, headers=self._headers())
        except httpx.HTTPError as e:
            raise RuntimeError(
                f"{self.provider_type} request failed: {e}"
            ) from e
        if r.status_code >= 400:
            raise RuntimeError(
                f"{self.provider_type} {r.status_code}: {r.text[:400]}"
            )

        payload = r.json()
        choice = (payload.get("choices") or [{}])[0]
        message = choice.get("message") or {}
        usage = payload.get("usage") or {}
        return LLMResponse(
            text=message.get("content") or "",
            model=payload.get("model") or body["model"],
            finish_reason=choice.get("finish_reason") or "stop",
            prompt_tokens=int(usage.get("prompt_tokens") or 0),
            completion_tokens=int(usage.get("completion_tokens") or 0),
            raw=payload,
        )

    def stream_chat(
        self,
        messages: list[LLMMessage],
        *,
        model: str | None = None,
        temperature: float = 0.7,
        max_tokens: int | None = None,
        system: str | None = None,
        think: bool = False,
        extra: dict[str, Any] | None = None,
    ) -> Iterator[StreamDelta]:
        body: dict[str, Any] = {
            "model": model or self.default_model,
            "messages": self._build_messages(messages, system),
            "temperature": temperature,
            "stream": True,
            # Ask for a final usage frame (servers that don't support it ignore
            # the field; we just report 0 tokens then).
            "stream_options": {"include_usage": True},
        }
        if max_tokens is not None:
            body["max_tokens"] = max_tokens
        extra, effort = pop_reasoning_effort(extra)
        if extra:
            body.update(extra)
        self._apply_reasoning(body, think, effort)

        url = f"{self._base_url}/chat/completions"
        pt = ct = 0
        with self._client.stream("POST", url, json=body, headers=self._headers()) as r:
            if r.status_code >= 400:
                detail = r.read().decode("utf-8", errors="replace")
                raise RuntimeError(
                    f"{self.provider_type} stream {r.status_code}: {detail[:400]}"
                )
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
                usage = evt.get("usage")
                if usage:
                    pt = int(usage.get("prompt_tokens") or 0)
                    ct = int(usage.get("completion_tokens") or 0)
                # The final usage frame carries an empty choices list.
                for choice in evt.get("choices") or []:
                    chunk = (choice.get("delta") or {}).get("content") or ""
                    if chunk:
                        yield StreamDelta(text=chunk)
        yield StreamDelta(done=True, prompt_tokens=pt, completion_tokens=ct)

    def models(self) -> list[str]:
        """GET /models — most OpenAI-compat servers expose this."""
        try:
            r = self._client.get(f"{self._base_url}/models", headers=self._headers())
            if r.status_code >= 400:
                return []
            payload = r.json()
        except (httpx.HTTPError, json.JSONDecodeError):
            return []
        # OpenAI shape: {data: [{id, ...}, ...]}
        data = payload.get("data") or []
        return [str(m.get("id")) for m in data if m.get("id")]

    def embed(self, texts: list[str], *, model: str | None = None) -> list[list[float]]:
        """POST /embeddings (OpenAI shape: {data: [{embedding}, ...]})."""
        body = {"model": model or self.default_model, "input": list(texts)}
        url = f"{self._base_url}/embeddings"
        try:
            r = self._client.post(url, json=body, headers=self._headers())
        except httpx.HTTPError as e:
            raise RuntimeError(f"{self.provider_type} embeddings request failed: {e}") from e
        if r.status_code >= 400:
            raise RuntimeError(f"{self.provider_type} embeddings {r.status_code}: {r.text[:400]}")
        data = r.json().get("data") or []
        return [list(d.get("embedding") or []) for d in data]

    def ping(self) -> bool:
        try:
            r = self._client.get(
                f"{self._base_url}/models", headers=self._headers(), timeout=5.0
            )
            return r.status_code < 500
        except httpx.HTTPError:
            return False
