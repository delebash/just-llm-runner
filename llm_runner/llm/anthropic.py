# SPDX-License-Identifier: MIT
"""Anthropic Claude adapter — the official ``anthropic`` SDK (the 2026-07-17 SDK pivot,
#15 C3).

Speaks the Messages API through ``client.messages.create`` (system prompt in a top-level
``system`` field, not a system-role message). The SDK owns the wire format + the
``anthropic-version`` header + retries, so this adapter no longer hand-builds headers or
parses SSE — and the ``min_p`` 400 unknown-field bug class dies at the boundary because
``_map_extra`` is now an ALLOWLIST (only Anthropic's typed params survive).

Kept verbatim from the httpx era: the model-generation split
(``_ADAPTIVE_SUBSTRINGS`` / ``_ALWAYS_THINKS_SUBSTRINGS``) and ``_apply_reasoning`` — the
adaptive/legacy/always-thinks logic is unchanged (its static tests pin that it carried).

Grounded on installed ``anthropic==0.117.0`` introspection (2026-07-17): the exception
surface, ``messages.create`` typed params, the ``Raw*Event`` stream shapes, and
``ModelInfo.id`` for the live ``models.list`` (D8) — see
``docs/plans/2026-07-17-provider-native-dialects-plan.md`` §0.5 / §5.
"""

from __future__ import annotations

from typing import Any, Iterator

from ._lazy import lazy_module

# Deferred: `import anthropic` here cost ~584 ms on every server boot. Imported on first
# attribute access instead; every `anthropic.X` below is unchanged. See _lazy.py.
anthropic = lazy_module("anthropic")

from .base import (  # noqa: E402 — kept below the lazy shim so the deferral reads in order
    LLMMessage,
    LLMResponse,
    StreamDelta,
    adapter_http_error,
    pop_reasoning,
    select_allowed,
    split_system,
)

DEFAULT_BASE_URL = "https://api.anthropic.com"
DEFAULT_MODEL = "claude-haiku-4-5"

# The keyless / offline fallback for models() (D8). Anthropic's /v1/models endpoint exists
# (since 2025) and models() prefers it; this curated list survives on ANY error so the
# works-without-a-key behavior is preserved. Re-verify the ids at each model launch.
_CURATED_MODELS = [
    "claude-fable-5",
    "claude-mythos-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-sonnet-5",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
    "claude-haiku-4-5-20251001",
]


class AnthropicAdapter:
    """LLM adapter for Anthropic's Claude family over the official anthropic SDK."""

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
        self._base_url = (base_url or DEFAULT_BASE_URL).rstrip("/")
        self.default_model = default_model or DEFAULT_MODEL
        self._api_key = api_key
        self._timeout_seconds = timeout_seconds
        # Lazy client (#16): unify the SDK-adapter shape. anthropic.Anthropic already
        # constructs fine with an empty key (it never needed a dummy), but building it on
        # first real call keeps all three SDK adapters identical — construct stores config,
        # _ensure_client builds once. Keyless first call 401s at request time as before.
        self._client = None

    def _ensure_client(self):
        """Build the SDK client once, on first use (#16). Respects an already-set
        ``self._client`` (tests assign a fake), so it never rebuilds over one."""
        if self._client is None:
            # D9: max_retries=2 (the SDK default) + the provider's timeout + base_url
            # (equals-default is harmless). The SDK owns the anthropic-version header.
            self._client = anthropic.Anthropic(
                api_key=self._api_key or "",
                base_url=self._base_url,
                timeout=self._timeout_seconds,
                max_retries=2,
            )
        return self._client

    # ── Helpers ─────────────────────────────────────────────────────

    def _split_system(
        self, messages: list[LLMMessage], system: str | None
    ) -> tuple[str | None, list[dict]]:
        """Anthropic wants system in a top-level field and the messages list to hold only
        user/assistant turns. Thin call to the shared base.split_system (#15 C2.0), then
        dict-ify the non-system remainder for the Messages API."""
        sys_text, turns = split_system(messages, system)
        return sys_text, [{"role": m.role, "content": m.content} for m in turns]

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

    @staticmethod
    def _map_extra(extra: dict | None) -> dict | None:
        """Allowlist — Anthropic's typed params only (top_p/top_k/metadata) + the
        stop→stop_sequences rename. Everything else (min_p, mirostat*, dry_*, xtc_*,
        seed, samplers, response_format) is DROPPED — the Messages API has none of them.
        Built on the shared base.select_allowed (#15 C2.0/C3); preserves the None-for-empty
        return contract (test_plane2_params.py: `_map_extra(None) is None`)."""
        out = select_allowed(extra, {"top_p", "top_k", "metadata", "stop"},
                             renames={"stop": "stop_sequences"})
        return out or None

    def _build_kwargs(
        self,
        messages: list[LLMMessage],
        *,
        model: str | None,
        temperature: float | None,
        max_tokens: int | None,
        system: str | None,
        think: bool,
        extra: dict[str, Any] | None,
    ) -> dict[str, Any]:
        """Assemble the messages.create kwargs: model/messages/max_tokens (default 4096 —
        Anthropic requires it)/temperature-if-set/system-if-any + the allowlisted extra +
        the model-aware reasoning mutation (same contract as the httpx era)."""
        sys_prompt, msgs = self._split_system(messages, system)
        model_id = model or self.default_model
        kwargs: dict[str, Any] = {
            "model": model_id,
            "messages": msgs,
            "max_tokens": max_tokens or 4096,
        }
        if temperature is not None:
            kwargs["temperature"] = temperature
        if sys_prompt:
            kwargs["system"] = sys_prompt
        extra, effort, budget = pop_reasoning(extra)
        mapped = self._map_extra(extra)
        if mapped:
            kwargs.update(mapped)
        self._apply_reasoning(kwargs, think, effort, budget, model_id)
        return kwargs

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
        kwargs = self._build_kwargs(
            messages, model=model, temperature=temperature, max_tokens=max_tokens,
            system=system, think=think, extra=extra,
        )
        try:
            msg = self._ensure_client().messages.create(**kwargs)
        except anthropic.APIStatusError as e:
            raise adapter_http_error("anthropic", e.status_code, str(e)) from e
        except Exception as e:  # connection / timeout / other
            raise adapter_http_error("anthropic", None, str(e)) from e

        text = "".join(
            blk.text for blk in msg.content if getattr(blk, "type", None) == "text"
        )
        usage = msg.usage
        return LLMResponse(
            text=text,
            model=getattr(msg, "model", None) or kwargs["model"],
            finish_reason=getattr(msg, "stop_reason", None) or "stop",
            prompt_tokens=int(getattr(usage, "input_tokens", 0) or 0),
            completion_tokens=int(getattr(usage, "output_tokens", 0) or 0),
            raw=msg.model_dump(),
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
        kwargs = self._build_kwargs(
            messages, model=model, temperature=temperature, max_tokens=max_tokens,
            system=system, think=think, extra=extra,
        )
        pt = ct = 0
        try:
            events = self._ensure_client().messages.create(**kwargs, stream=True)
            # Raw stream events (introspected on 0.117.0): message_start carries usage on
            # .message.usage; content_block_delta with a text_delta carries .delta.text;
            # message_delta carries the running output_tokens on .usage.
            for event in events:
                etype = getattr(event, "type", None)
                if etype == "message_start":
                    u = getattr(getattr(event, "message", None), "usage", None)
                    if u is not None and getattr(u, "input_tokens", None) is not None:
                        pt = int(u.input_tokens or 0)
                elif etype == "content_block_delta":
                    delta = getattr(event, "delta", None)
                    if delta is not None and getattr(delta, "type", None) == "text_delta":
                        chunk = getattr(delta, "text", "") or ""
                        if chunk:
                            yield StreamDelta(text=chunk)
                elif etype == "message_delta":
                    u = getattr(event, "usage", None)
                    if u is not None and getattr(u, "output_tokens", None) is not None:
                        ct = int(u.output_tokens or 0)
        except anthropic.APIStatusError as e:
            raise adapter_http_error("anthropic", e.status_code, str(e), stream=True) from e
        except Exception as e:
            raise adapter_http_error("anthropic", None, str(e)) from e
        yield StreamDelta(done=True, prompt_tokens=pt, completion_tokens=ct)

    def models(self) -> list[str]:
        # D8: the real /v1/models endpoint (exists since 2025); fall back to the curated
        # list on ANY error so the works-without-a-key behavior survives.
        try:
            return [m.id for m in self._ensure_client().models.list()]
        except Exception:
            return list(_CURATED_MODELS)

    # No embed(): Anthropic exposes no embeddings endpoint. The Protocol's embed is
    # optional (base.py) — omitting the attribute makes /v1/ai/embeddings report the
    # documented clear 400 (api.py getattr(adapter, "embed", None)).

    def ping(self) -> bool:
        try:
            # Tiny ping: ask for 1 token. Cheap + validates the key.
            self._ensure_client().messages.create(
                model=self.default_model,
                messages=[{"role": "user", "content": "ping"}],
                max_tokens=1,
            )
            return True
        except anthropic.APIStatusError as e:
            # reachable but rejected (e.g. 401) = up; a ≥500 = down.
            return (e.status_code or 500) < 500
        except Exception:
            return False
