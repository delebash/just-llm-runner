# SPDX-License-Identifier: GPL-3.0-or-later
"""Google Gemini adapter.

Speaks the v1beta generativelanguage API
(https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent).
Distinct from OpenAI chat-completions: messages are "contents", roles are
"user" | "model" (not "user" | "assistant"), and the system prompt goes
into a top-level `systemInstruction` field.

Lifted verbatim from JustVoice `server/justvoice/engines/llm/gemini.py`
into the shared `llm_runner` package (2026-06-21 AI-stack convergence).
"""

from __future__ import annotations

import json
import logging
from typing import Any, Iterator

import httpx

from .base import LLMMessage, LLMResponse, StreamDelta

log = logging.getLogger(__name__)


DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com"
DEFAULT_MODEL = "gemini-2.5-flash"


# Gemini uses "model" where OpenAI/Anthropic use "assistant".
_ROLE_MAP = {
    "user": "user",
    "assistant": "model",
    "system": "user",  # handled by extraction into systemInstruction
    "tool": "user",
}


class GeminiAdapter:
    """LLM adapter for Google Gemini."""

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
        self.provider_type = "gemini"
        self._api_key = api_key
        self._base_url = (base_url or DEFAULT_BASE_URL).rstrip("/")
        self.default_model = default_model or DEFAULT_MODEL
        self._client = httpx.Client(timeout=timeout_seconds)

    def _params(self) -> dict[str, str]:
        # Gemini takes the key as a query param, not a header.
        return {"key": self._api_key} if self._api_key else {}

    def _build_payload(
        self,
        messages: list[LLMMessage],
        system: str | None,
        *,
        temperature: float,
        max_tokens: int | None,
    ) -> dict[str, Any]:
        contents: list[dict] = []
        sys_parts: list[str] = []
        if system:
            sys_parts.append(system)
        for m in messages:
            if m.role == "system":
                sys_parts.append(m.content)
                continue
            contents.append(
                {
                    "role": _ROLE_MAP.get(m.role, "user"),
                    "parts": [{"text": m.content}],
                }
            )

        payload: dict[str, Any] = {
            "contents": contents,
            "generationConfig": {
                "temperature": temperature,
            },
        }
        if max_tokens is not None:
            payload["generationConfig"]["maxOutputTokens"] = max_tokens
        if sys_parts:
            payload["systemInstruction"] = {
                "parts": [{"text": "\n\n".join(sys_parts)}]
            }
        return payload

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
        model_id = model or self.default_model
        payload = self._build_payload(
            messages, system, temperature=temperature, max_tokens=max_tokens
        )
        if extra:
            payload.update(extra)

        url = f"{self._base_url}/v1beta/models/{model_id}:generateContent"
        try:
            r = self._client.post(url, json=payload, params=self._params())
        except httpx.HTTPError as e:
            raise RuntimeError(f"gemini request failed: {e}") from e
        if r.status_code >= 400:
            raise RuntimeError(f"gemini {r.status_code}: {r.text[:400]}")

        data = r.json()
        candidate = (data.get("candidates") or [{}])[0]
        parts = (candidate.get("content") or {}).get("parts") or []
        text = "".join(p.get("text", "") for p in parts)
        usage = data.get("usageMetadata") or {}
        return LLMResponse(
            text=text,
            model=model_id,
            finish_reason=candidate.get("finishReason", "stop").lower(),
            prompt_tokens=int(usage.get("promptTokenCount") or 0),
            completion_tokens=int(usage.get("candidatesTokenCount") or 0),
            raw=data,
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
        model_id = model or self.default_model
        payload = self._build_payload(
            messages, system, temperature=temperature, max_tokens=max_tokens
        )
        if extra:
            payload.update(extra)

        url = f"{self._base_url}/v1beta/models/{model_id}:streamGenerateContent"
        params = {**self._params(), "alt": "sse"}
        pt = ct = 0
        with self._client.stream("POST", url, json=payload, params=params) as r:
            if r.status_code >= 400:
                detail = r.read().decode("utf-8", errors="replace")
                raise RuntimeError(f"gemini stream {r.status_code}: {detail[:400]}")
            for line in r.iter_lines():
                if not line or not line.startswith("data:"):
                    continue
                data_s = line[5:].strip()
                if not data_s:
                    continue
                try:
                    evt = json.loads(data_s)
                except json.JSONDecodeError:
                    continue
                um = evt.get("usageMetadata") or {}
                if um:
                    pt = int(um.get("promptTokenCount") or 0)
                    ct = int(um.get("candidatesTokenCount") or 0)
                cand = (evt.get("candidates") or [{}])[0]
                parts = (cand.get("content") or {}).get("parts") or []
                chunk = "".join(p.get("text", "") for p in parts)
                if chunk:
                    yield StreamDelta(text=chunk)
        yield StreamDelta(done=True, prompt_tokens=pt, completion_tokens=ct)

    def models(self) -> list[str]:
        try:
            r = self._client.get(
                f"{self._base_url}/v1beta/models", params=self._params()
            )
            if r.status_code >= 400:
                return []
            data = r.json()
        except (httpx.HTTPError, json.JSONDecodeError):
            return []
        out: list[str] = []
        for m in data.get("models") or []:
            mid = m.get("name") or ""
            # Strip the "models/" prefix Google includes.
            if mid.startswith("models/"):
                mid = mid[7:]
            if mid:
                out.append(mid)
        return out

    def ping(self) -> bool:
        try:
            r = self._client.get(
                f"{self._base_url}/v1beta/models",
                params=self._params(),
                timeout=5.0,
            )
            return r.status_code < 500
        except httpx.HTTPError:
            return False
