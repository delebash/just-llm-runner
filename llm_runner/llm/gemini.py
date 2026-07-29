# SPDX-License-Identifier: MIT
"""Google Gemini adapter — the official ``google-genai`` SDK (the 2026-07-17 SDK pivot,
#15 C2).

Speaks the SDK's first-class typed surface ``client.models.generate_content`` /
``generate_content_stream`` (D2, RULED 2026-07-17 "so use generate_content" — NOT the
SDK's ``interactions`` plumbing; generate_content is stateless by construction, creating
no server-side object, which satisfies the never-persist ruling). Gemini's wire quirks —
roles "user"|"model" (not "assistant"), the system prompt in a top-level
``system_instruction``, thinking via ``thinking_config`` — are all typed SDK fields now,
so the ``min_p`` 400 unknown-field bug dies at the boundary: ``_build_config`` only ever
sets params Gemini speaks.

Thinking (D6-A, the user's HELD ruling 2026-07-17: "also keep numeric rows … unless the
interactions sdk changes that"): the reasoning-map keeps its NUMERIC seed rows —
think-off OMITS ``thinking_config`` (model default), think-on + a number →
``thinking_budget=n`` (incl. -1 = documented dynamic), think-on + a word →
``thinking_level=word``. The numeric choice rides THIS generate_content surface; if the
adapter ever moves to the SDK's ``interactions`` surface (which speaks thinking_level
words), the mapping REOPENS for a fresh ruling.

Grounded on the 2026-07-17 LIVE PROOF (real API calls; key never persisted) + installed
``google-genai==2.12.1`` introspection — see
``docs/plans/2026-07-17-provider-native-dialects-plan.md`` §0.5.
"""

from __future__ import annotations

import logging
from typing import Any, Iterator

from ._lazy import lazy_module

# Deferred: importing google-genai here cost ~918 ms on every server boot — the largest single
# item in the ~4.1 s cold start — for an SDK most sessions never call. Each proxy imports its
# module on first attribute access, so every `genai.` / `gtypes.` / `gerrors.` use below is
# unchanged (annotations are strings under `from __future__ import annotations`, so the
# `-> list[gtypes.Content]` signature never forces the import either). See _lazy.py.
genai = lazy_module("google.genai")
gerrors = lazy_module("google.genai.errors")
gtypes = lazy_module("google.genai.types")

from .base import (  # noqa: E402 — kept below the lazy shim so the deferral reads in order
    LLMMessage,
    LLMResponse,
    StreamDelta,
    adapter_http_error,
    pop_reasoning,
    select_allowed,
    split_system,
)

log = logging.getLogger(__name__)


DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com"
# gemini-2.5-* is new-user-blocked on current keys (404 "no longer available to new
# users", live-proven 2026-07-17). The flash-lite alias is live-proven on this tier
# (proof item 7) and tracks Google's current flash-lite tier instead of rotting like the
# dated `gemini-2.5-flash` default did.
DEFAULT_MODEL = "gemini-flash-lite-latest"

# House embed task side ("document"|"query") → Gemini EmbedContentConfig.task_type; ""
# (or any other value) sends no task_type (proof item 5).
_TASK_MAP = {"document": "RETRIEVAL_DOCUMENT", "query": "RETRIEVAL_QUERY"}

# The FinishReason enum name (lowered) → the house LLMResponse.finish_reason contract.
_FINISH_MAP = {"max_tokens": "length", "stop": "stop"}


class GeminiAdapter:
    """LLM adapter for Google Gemini over the official google-genai SDK."""

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
        self.default_model = default_model or DEFAULT_MODEL
        self._api_key = api_key
        self._base_url = base_url.rstrip("/") if base_url else ""
        self._timeout_ms = timeout_seconds * 1000  # the SDK wants ms
        # Lazy client (#16): construct stores config only; the google-genai client is built
        # on first real call (_ensure_client). google-genai validates the key at Client()
        # build (empty key + no env → ValueError), so eager construction of a seeded KEYLESS
        # gemini row used to need a dummy key to register — deferring the build removes that:
        # a keyless row registers, and the first real call surfaces the SDK's own no-key
        # error honestly (chat → RuntimeError "gemini request failed …"; models()/ping()
        # swallow it → []/False, the unchanged keyless degradation).
        self._client = None
        # Embed models that ignore batching (return ONE vector for a list of N — e.g.
        # gemini-embedding-2, verified 2026-07-18). Learned on the first mismatch so
        # later batches skip the wasted batch call and go straight to per-text.
        self._embed_no_batch = set()

    def _ensure_client(self):
        """Build the SDK client once, on first use (#16). Respects an already-set
        ``self._client`` (tests assign a fake), so it never rebuilds over one."""
        if self._client is None:
            http_options = gtypes.HttpOptions(timeout=self._timeout_ms)
            if self._base_url:
                http_options.base_url = self._base_url
            self._client = genai.Client(api_key=self._api_key, http_options=http_options)
        return self._client

    @staticmethod
    def _build_config(
        *,
        system: str | None,
        temperature: float | None,
        max_tokens: int | None,
        think: bool,
        effort: str,
        budget: int | None,
        extra: dict[str, Any] | None,
    ) -> dict[str, Any]:
        """Map the house call contract → GenerateContentConfig kwargs. Typed fields
        ONLY — anything Gemini doesn't speak is dropped HERE (the min_p-400 fix)."""
        cfg: dict[str, Any] = {}
        if system:
            cfg["system_instruction"] = system
        if temperature is not None:
            cfg["temperature"] = temperature
        if max_tokens is not None:
            cfg["max_output_tokens"] = max_tokens
        # Gemini's typed sampler set + the stop→stop_sequences rename; everything else
        # (min_p, mirostat*, the samplers order array, …) drops via the shared allowlist.
        cfg.update(select_allowed(
            extra,
            {"top_p", "top_k", "seed", "presence_penalty", "frequency_penalty", "stop"},
            renames={"stop": "stop_sequences"},
        ))
        rf = (extra or {}).get("response_format")
        if isinstance(rf, dict) and rf.get("type") in ("json_object", "json", "json_schema"):
            cfg["response_mime_type"] = "application/json"
            schema = (rf.get("json_schema") or {}).get("schema")
            if rf.get("type") == "json_schema" and isinstance(schema, dict):
                cfg["response_json_schema"] = schema  # raw JSON Schema — proof item 4
        # Thinking (D6-A): off → OMIT thinking_config (model default = today's semantics);
        # on + number → thinking_budget (incl. -1 dynamic); on + word → thinking_level.
        if think:
            if effort in ("minimal", "low", "medium", "high"):
                # FORWARD-COMPAT / currently unreachable: gemini's seed rows are NUMERIC and
                # the Reasoning-levels editor hides gemini's word column (ProviderForm
                # NUMBER_ONLY_TYPES), so no word reaches here under D6-A today.
                cfg["thinking_config"] = gtypes.ThinkingConfig(thinking_level=effort)
            elif budget is not None:
                cfg["thinking_config"] = gtypes.ThinkingConfig(thinking_budget=budget)
        return cfg

    @staticmethod
    def _contents(turns: list[LLMMessage]) -> list[gtypes.Content]:
        # Content/Part construction offline-verified 2026-07-17 (google-genai==2.12.1):
        # types.Content(role='user', parts=[types.Part(text='x')]) constructs fine.
        return [
            gtypes.Content(
                role=("model" if m.role == "assistant" else "user"),
                parts=[gtypes.Part(text=m.content)],
            )
            for m in turns
        ]

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
        extra, effort, budget = pop_reasoning(extra)
        sys_text, turns = split_system(messages, system)
        config = gtypes.GenerateContentConfig(**self._build_config(
            system=sys_text, temperature=temperature, max_tokens=max_tokens,
            think=think, effort=effort, budget=budget, extra=extra,
        ))
        model_id = (model or self.default_model).removeprefix("models/")
        try:
            r = self._ensure_client().models.generate_content(
                model=model_id, contents=self._contents(turns), config=config
            )
        except gerrors.APIError as e:
            raise adapter_http_error("gemini", e.code, str(e)) from e
        except Exception as e:  # transport / other
            raise adapter_http_error("gemini", None, str(e)) from e

        cand = r.candidates[0] if r.candidates else None
        parts = (cand.content.parts if cand and cand.content else None) or []
        # NOT r.text — it can raise/warn on non-text parts (thought signatures etc.).
        text = "".join(p.text or "" for p in parts)
        finish = "stop"
        if cand is not None and cand.finish_reason is not None:
            name = cand.finish_reason.name.lower()
            finish = _FINISH_MAP.get(name, name)
        um = r.usage_metadata
        return LLMResponse(
            text=text,
            model=model_id,
            finish_reason=finish,
            prompt_tokens=(um.prompt_token_count or 0) if um else 0,
            completion_tokens=(um.candidates_token_count or 0) if um else 0,
            raw=r.model_dump(exclude_none=True),
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
        extra, effort, budget = pop_reasoning(extra)
        sys_text, turns = split_system(messages, system)
        config = gtypes.GenerateContentConfig(**self._build_config(
            system=sys_text, temperature=temperature, max_tokens=max_tokens,
            think=think, effort=effort, budget=budget, extra=extra,
        ))
        model_id = (model or self.default_model).removeprefix("models/")
        pt = ct = 0
        try:
            stream = self._ensure_client().models.generate_content_stream(
                model=model_id, contents=self._contents(turns), config=config
            )
            for chunk in stream:
                um = chunk.usage_metadata
                if um is not None:  # final chunk authoritative (proof item 2)
                    if um.prompt_token_count is not None:
                        pt = um.prompt_token_count
                    if um.candidates_token_count is not None:
                        ct = um.candidates_token_count
                cand = chunk.candidates[0] if chunk.candidates else None
                parts = (cand.content.parts if cand and cand.content else None) or []
                piece = "".join(p.text or "" for p in parts)
                if piece:
                    yield StreamDelta(text=piece)
        except gerrors.APIError as e:
            raise adapter_http_error("gemini", e.code, str(e), stream=True) from e
        except Exception as e:
            raise adapter_http_error("gemini", None, str(e)) from e
        yield StreamDelta(done=True, prompt_tokens=pt, completion_tokens=ct)

    def models(self) -> list[str]:
        try:
            out: list[str] = []
            for m in self._ensure_client().models.list():
                actions = getattr(m, "supported_actions", None)
                # D7: keep only chat/embed-capable ids (drops veo/imagen/lyria/aqa/… noise);
                # a missing/None supported_actions is treated as KEEP.
                if actions and not ({"generateContent", "embedContent"} & set(actions)):
                    continue
                mid = (m.name or "").removeprefix("models/")
                if mid:
                    out.append(mid)
            return out
        except Exception:
            return []

    def _embed_call(self, m, contents, cfg):
        try:
            r = self._ensure_client().models.embed_content(model=m, contents=contents, config=cfg)
        except gerrors.APIError as e:
            raise adapter_http_error("gemini", e.code, str(e)) from e
        except Exception as e:
            raise adapter_http_error("gemini", None, str(e)) from e
        return [list(e.values) for e in r.embeddings]

    def embed(
        self, texts: list[str], *, model: str | None = None, task_type: str = ""
    ) -> list[list[float]]:
        m = (model or "gemini-embedding-001").removeprefix("models/")
        cfg = (
            gtypes.EmbedContentConfig(task_type=_TASK_MAP[task_type])
            if task_type in _TASK_MAP
            else None
        )
        texts = list(texts)
        if not texts:
            return []
        # Most Gemini embed models batch (one vector per input). gemini-embedding-2 does
        # NOT — it returns a SINGLE vector for a list (verified 2026-07-18), which the
        # caller reads as "response length didn't match the batch size". Try the batch;
        # on a count mismatch, remember the model and fall back to one call per text.
        if len(texts) > 1 and m not in self._embed_no_batch:
            vecs = self._embed_call(m, texts, cfg)
            if len(vecs) == len(texts):
                return vecs
            self._embed_no_batch.add(m)
        return [self._embed_call(m, [t], cfg)[0] for t in texts]

    def ping(self) -> bool:
        try:
            next(iter(self._ensure_client().models.list()), None)  # fetches page 1 (a real call)
            return True
        except gerrors.APIError as e:
            return e.code < 500 if isinstance(e.code, int) else False
        except Exception:
            return False
