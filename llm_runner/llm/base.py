# SPDX-License-Identifier: GPL-3.0-or-later
"""LLM adapter contract — every provider implements this.

Structurally typed (Protocol) so third-party provider packages can
satisfy it without importing this module at runtime.

Lifted verbatim from JustVoice `server/justvoice/engines/llm/base.py`
into the shared `llm_runner` package (2026-06-21 AI-stack convergence).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterator, Protocol, runtime_checkable


@dataclass
class LLMMessage:
    """Single conversation turn. `role` follows OpenAI conventions
    (system / user / assistant / tool) which every modern provider
    accepts; adapters map to provider-specific shapes internally."""

    role: str  # "system" | "user" | "assistant" | "tool"
    content: str


@dataclass
class LLMResponse:
    """Non-streaming chat completion result."""

    text: str
    model: str
    finish_reason: str = "stop"  # "stop" | "length" | "tool_use" | "error"
    prompt_tokens: int = 0
    completion_tokens: int = 0
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass
class StreamDelta:
    """One streamed event. Text chunks carry `text`; the final event carries
    `done=True` plus token usage (0 when the provider didn't report it). Adapters
    yield text deltas as they arrive, then one `done` event so the dispatch layer
    can record usage and the client can finalize.

    `progress` (§7.4 B6-2): prompt-eval progress 0..1 from the builtin engine's
    `prompt_progress` frames (llama-server `return_progress`, PR 15827 — overall
    progress = processed/total); None on text/done events and on adapters whose
    backend doesn't report it (cloud). `model` is set by the DISPATCH layer on
    the done event (the resolved model — adapters leave it empty)."""

    text: str = ""
    done: bool = False
    prompt_tokens: int = 0
    completion_tokens: int = 0
    progress: float | None = None
    model: str = ""


def pop_reasoning(
    extra: dict[str, Any] | None,
) -> tuple[dict[str, Any] | None, str, int | None]:
    """Split the reserved reasoning keys out of a per-call ``extra`` (U2-T5): the resolved
    effort ``reasoning_effort`` (word) AND the resolved ``reasoning_budget_tokens`` (number),
    both injected by ``dispatch._apply_reasoning`` from the ONE resolver (``llm/reasoning``).
    Returns ``(extra_without_them, effort_word, budget_tokens)`` — a COPY, so NEITHER reserved
    key leaks into a backend body verbatim; each adapter emits only the form its backend
    speaks. ``effort`` is "" and ``budget`` is None when absent."""
    if not extra:
        return extra, "", None
    e = dict(extra)
    effort = e.pop("reasoning_effort", "") or ""
    budget = e.pop("reasoning_budget_tokens", None)
    return e, effort, budget


@runtime_checkable
class LLMAdapter(Protocol):
    """The contract every LLM provider adapter satisfies."""

    provider_id: str
    provider_type: str
    default_model: str

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
        """Single non-streaming chat completion.

        `temperature=None` OMITS the param entirely (the provider's own default
        applies) — the no-preset rule; a float is sent as given.
        `system` is a convenience for "prepend a system message" — most
        callers pass it instead of building the messages list manually.
        `think` enables reasoning-block emission on providers that
        support it (Ollama's `/api/chat` with `think: true`); ignored
        otherwise.
        """
        ...

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
        """Stream completion events: a `StreamDelta(text=…)` per chunk, then a
        final `StreamDelta(done=True, prompt_tokens=…, completion_tokens=…)`."""
        ...

    def models(self) -> list[str]:
        """Return the list of model ids this provider exposes. May hit
        the network (e.g. GET /models) — callers should cache."""
        ...

    def embed(self, texts: list[str], *, model: str | None = None) -> list[list[float]]:
        """Embed texts into vectors — one vector per input, same order.

        Only providers that expose an embeddings endpoint implement this
        (OpenAI-compatible `/embeddings`, Ollama `/api/embed`); adapters that
        don't (Anthropic, Gemini) omit it, and the embeddings endpoint reports a
        clear 400. Raises RuntimeError on an upstream/transport error.
        """
        ...

    def ping(self) -> bool:
        """Cheap connectivity check. Returns True if the provider's
        baseUrl is reachable + the credentials are accepted."""
        ...
