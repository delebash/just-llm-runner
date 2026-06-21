# SPDX-License-Identifier: GPL-3.0-or-later
"""Ollama adapter.

Local-first: defaults to http://localhost:11434. Speaks Ollama's native
`/api/chat` (not `/v1/chat/completions`) so the `think: true` flag for
reasoning models like deepseek-r1 / qwen3-thinking actually surfaces
the <think> blocks.

Lifted verbatim from JustVoice `server/justvoice/engines/llm/ollama.py`
into the shared `llm_runner` package (2026-06-21 AI-stack convergence).
"""

from __future__ import annotations

import json
import logging
from typing import Any, Iterator

import httpx

from .base import LLMMessage, LLMResponse, StreamDelta

log = logging.getLogger(__name__)


DEFAULT_BASE_URL = "http://localhost:11434"
DEFAULT_MODEL = "llama3.2"


class OllamaAdapter:
    """Adapter for a local or remote Ollama server."""

    def __init__(
        self,
        provider_id: str,
        *,
        api_key: str = "",
        base_url: str = "",
        default_model: str = "",
        timeout_seconds: int = 120,
    ):
        self.provider_id = provider_id
        self.provider_type = "ollama"
        self._api_key = api_key  # rarely needed; some hosted Ollamas use bearer
        self._base_url = (base_url or DEFAULT_BASE_URL).rstrip("/")
        self.default_model = default_model or DEFAULT_MODEL
        # Local model loads can be slow; give them more headroom than the
        # cloud-adapter default.
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
            "stream": False,
            "options": {"temperature": temperature},
        }
        if max_tokens is not None:
            body["options"]["num_predict"] = max_tokens
        # think: true → emit reasoning blocks on reasoning models.
        # No-op for non-reasoning models so passing it always is safe.
        if think:
            body["think"] = True
        if extra:
            body.update(extra)

        url = f"{self._base_url}/api/chat"
        try:
            r = self._client.post(url, json=body, headers=self._headers())
        except httpx.HTTPError as e:
            raise RuntimeError(f"ollama request failed: {e}") from e
        if r.status_code >= 400:
            raise RuntimeError(f"ollama {r.status_code}: {r.text[:400]}")

        payload = r.json()
        message = payload.get("message") or {}
        # Strip <think>…</think> blocks from user-facing text — they're
        # available in raw if a caller wants them.
        text = message.get("content") or ""
        return LLMResponse(
            text=text,
            model=payload.get("model") or body["model"],
            finish_reason="stop" if payload.get("done") else "length",
            prompt_tokens=int(payload.get("prompt_eval_count") or 0),
            completion_tokens=int(payload.get("eval_count") or 0),
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
            "stream": True,
            "options": {"temperature": temperature},
        }
        if max_tokens is not None:
            body["options"]["num_predict"] = max_tokens
        if think:
            body["think"] = True
        if extra:
            body.update(extra)

        url = f"{self._base_url}/api/chat"
        pt = ct = 0
        with self._client.stream("POST", url, json=body, headers=self._headers()) as r:
            if r.status_code >= 400:
                detail = r.read().decode("utf-8", errors="replace")
                raise RuntimeError(f"ollama stream {r.status_code}: {detail[:400]}")
            # Ollama emits one JSON object per line (not SSE).
            for line in r.iter_lines():
                if not line:
                    continue
                try:
                    evt = json.loads(line)
                except json.JSONDecodeError:
                    continue
                message = evt.get("message") or {}
                chunk = message.get("content") or ""
                if chunk:
                    yield StreamDelta(text=chunk)
                if evt.get("done"):
                    pt = int(evt.get("prompt_eval_count") or 0)
                    ct = int(evt.get("eval_count") or 0)
                    break
        yield StreamDelta(done=True, prompt_tokens=pt, completion_tokens=ct)

    def models(self) -> list[str]:
        """GET /api/tags lists installed models."""
        try:
            r = self._client.get(f"{self._base_url}/api/tags", headers=self._headers())
            if r.status_code >= 400:
                return []
            payload = r.json()
        except (httpx.HTTPError, json.JSONDecodeError):
            return []
        return [m.get("name") for m in payload.get("models") or [] if m.get("name")]

    def ping(self) -> bool:
        try:
            r = self._client.get(self._base_url, timeout=3.0)
            return r.status_code < 500
        except httpx.HTTPError:
            return False
