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


def build_chat_messages(
    messages: list[LLMMessage], system: str | None
) -> list[dict]:
    """The OpenAI-shape message list: an optional leading system turn, then each turn
    as ``{"role": …, "content": …}``. The ONE builder shared by the openai-compat +
    ollama + openai-SDK chat-completions paths (was byte-identical copies on each —
    C2.0 reuse consolidation, #15)."""
    out: list[dict] = []
    if system:
        out.append({"role": "system", "content": system})
    for m in messages:
        out.append({"role": m.role, "content": m.content})
    return out


def split_system(
    messages: list[LLMMessage], system: str | None
) -> tuple[str | None, list[LLMMessage]]:
    """Sweep the system text out of a turn list: collect the ``system=`` kwarg plus any
    ``role="system"`` turns, join with a blank line, and return ``(joined_or_None,
    non_system_turns)`` — the remainder as ``LLMMessage``s for each adapter to map to its
    own wire shape (anthropic dict-ifies, gemini → Content/Part, the openai Responses
    input array). Source of truth: anthropic's ``_split_system`` (#15 C2.0)."""
    parts: list[str] = []
    if system:
        parts.append(system)
    rest: list[LLMMessage] = []
    for m in messages:
        if m.role == "system":
            parts.append(m.content)
            continue
        rest.append(m)
    return ("\n\n".join(parts) if parts else None, rest)


def select_allowed(
    extra: dict[str, Any] | None,
    allowed: set[str],
    renames: dict[str, str] | None = None,
) -> dict[str, Any]:
    """The sampler allowlist filter: keep only keys in ``allowed`` from a per-call
    ``extra``, applying ``renames`` (source key → wire key). ``extra=None`` → ``{}``.
    Everything a typed cloud API doesn't speak (min_p, mirostat*, the samplers order
    array, …) is DROPPED here — the min_p-400 fix at the boundary. Shared by anthropic
    ``_map_extra``, gemini ``_build_config``, openai_sdk's param profiles (#15 C2.0)."""
    if not extra:
        return {}
    renames = renames or {}
    out: dict[str, Any] = {}
    for k, v in extra.items():
        if k in allowed:
            out[renames.get(k, k)] = v
    return out


def adapter_http_error(
    provider_type: str,
    status: int | None,
    detail: str,
    *,
    stream: bool = False,
) -> RuntimeError:
    """The D10 adapter-error contract in ONE place so the JW error envelope +
    friendly-error mapping keep parsing (they regex a 3-digit status). Non-stream →
    ``"{ptype} {status}: {detail[:400]}"``; stream → ``"{ptype} stream {status}: …"``;
    ``status=None`` (transport/connection) → ``"{ptype} request failed: {detail}"``
    (#15 C2.0)."""
    if status is None:
        return RuntimeError(f"{provider_type} request failed: {detail}")
    kind = "stream " if stream else ""
    return RuntimeError(f"{provider_type} {kind}{status}: {str(detail)[:400]}")


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
