# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared per-feature prompt subsystem — store contract, template renderer, and
the editor + execution routers, behind a host-supplied storage boundary.

Prompt TEXT is per-app data (each app seeds its own feature catalog into its own
`feature_prompts` table); the STORE shape, the `{{var}}` renderer, the
`/v1/ai/prompts` editor API, and the `/v1/ai/run` + `/v1/ai/stream` execution API
are shared here ONCE. A host implements `PromptStore` over its own table and
passes it (plus its seed-defaults dict, and its `llm_config` builder for
execution) to the router factories — the same host-store boundary as
`provider_api.py` (real persistence work, not a forwarding shim — RULE #8).

Headless-first design: prompt text lives in the host DB, seeded from the host's
defaults, edited in the Lab; the server reads it at request time. A missing key
is a 404 — no hardcoded prompt text, no runtime code fallback.

Lifted from JustWrite's `llm/prompt_store.py` + `llm/features.py` +
`api/ai_prompts.py` + `api/ai_features.py` (2026-06-21 AI-stack convergence) so
both apps run the SAME code instead of per-app duplicates.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Callable, Protocol

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .base import LLMMessage
from .dispatch import LLMNotConfiguredError, chat, stream_chat
from .schema import LLMConfig


# ── prompt row + store boundary ─────────────────────────────────────────────
@dataclass
class FeaturePromptRow:
    """One feature's editable prompt — the dispatch-time + Lab-edit view of a
    `feature_prompts` row. The host maps its own table to/from this."""

    key: str
    feature: str
    system: str
    user_template: str
    temperature: float
    think: bool
    built_in: bool


class PromptStore(Protocol):
    """Persistence boundary the host implements over its own storage. (`reset`
    is intentionally absent — the reset endpoint overwrites via `upsert` with the
    seeded defaults, so the store needs no delete path.)"""

    def get(self, key: str) -> FeaturePromptRow | None: ...
    def list(self) -> list[FeaturePromptRow]: ...
    def upsert(self, row: FeaturePromptRow) -> None: ...


# ── template renderer ───────────────────────────────────────────────────────
_VAR = re.compile(r"\{\{\s*(\w+)\s*\}\}")


def render(template: str, variables: dict) -> str:
    """Substitute {{name}} placeholders from `variables` (missing → empty)."""
    return _VAR.sub(lambda m: str(variables.get(m.group(1), "")), template)


def _history_messages(history: list[dict]) -> list[LLMMessage]:
    """Prior conversation turns as LLMMessages — user/assistant with content only."""
    out: list[LLMMessage] = []
    for h in history or []:
        role = str((h or {}).get("role") or "")
        content = str((h or {}).get("content") or "")
        if role in ("user", "assistant") and content:
            out.append(LLMMessage(role=role, content=content))
    return out


# ── wire shapes (camelCase, like the provider router) ───────────────────────
class PromptOut(BaseModel):
    key: str
    feature: str
    system: str
    userTemplate: str
    temperature: float
    think: bool
    builtIn: bool


class PromptList(BaseModel):
    prompts: list[PromptOut]


class PromptUpdate(BaseModel):
    # The editable fields. `feature` defaults to the built-in's routing key (or
    # the key itself for a user-created prompt) when omitted.
    feature: str = ""
    system: str = ""
    userTemplate: str = ""
    temperature: float = 0.7
    think: bool = False


def _out(r: FeaturePromptRow) -> PromptOut:
    return PromptOut(
        key=r.key,
        feature=r.feature,
        system=r.system,
        userTemplate=r.user_template,
        temperature=r.temperature,
        think=r.think,
        builtIn=r.built_in,
    )


# ── editor router: /v1/ai/prompts ───────────────────────────────────────────
def make_prompt_router(
    get_store: Callable[[], PromptStore],
    defaults: dict[str, dict],
) -> APIRouter:
    """Build the /v1/ai/prompts editor over a host `PromptStore`. `defaults` is
    the host's seed catalog (its `DEFAULT_FEATURE_PROMPTS`) — used to mark
    built-ins and to reset a row back to its seeded text."""
    router = APIRouter(tags=["ai"], prefix="/v1/ai")

    @router.get("/prompts", response_model=PromptList)
    async def list_prompts() -> PromptList:
        return PromptList(prompts=[_out(r) for r in get_store().list()])

    @router.get("/prompts/{key}", response_model=PromptOut)
    async def get_prompt(key: str) -> PromptOut:
        row = get_store().get(key)
        if row is None:
            raise HTTPException(status_code=404, detail=f"unknown prompt {key!r}")
        return _out(row)

    @router.put("/prompts/{key}", response_model=PromptOut)
    async def upsert_prompt(key: str, body: PromptUpdate) -> PromptOut:
        """Lab edit (or create). A key present in the seed catalog stays builtIn
        (so it can be reset); anything else is a user-created prompt."""
        default = defaults.get(key)
        built_in = default is not None
        feature = body.feature or (str(default.get("feature")) if default else key) or key
        get_store().upsert(FeaturePromptRow(
            key=key,
            feature=feature,
            system=body.system,
            user_template=body.userTemplate,
            temperature=body.temperature,
            think=body.think,
            built_in=built_in,
        ))
        return _out(get_store().get(key))

    @router.post("/prompts/{key}/reset", response_model=PromptOut)
    async def reset_prompt(key: str) -> PromptOut:
        """Restore a built-in prompt to its seeded default (overwrites the row)."""
        default = defaults.get(key)
        if default is None:
            raise HTTPException(status_code=400, detail=f"no seeded default for {key!r} to reset to")
        get_store().upsert(FeaturePromptRow(
            key=key,
            feature=str(default.get("feature") or key),
            system=str(default.get("system") or ""),
            user_template=str(default.get("user_template") or ""),
            temperature=float(default.get("temperature", 0.7)),
            think=bool(default.get("think", False)),
            built_in=True,
        ))
        return _out(get_store().get(key))

    return router


# ── execution router: /v1/ai/run + /v1/ai/stream ────────────────────────────
class RunRequest(BaseModel):
    action: str
    variables: dict = {}
    # Optional per-call routing override (a Lab runs one action against several
    # providers/models). Empty → the feature's resolved route.
    providerId: str = ""
    model: str = ""
    # Optional per-call temperature override (writerAI's 3-variation mode runs one
    # action at 0.55/0.7/0.95). None → the action's seeded temperature.
    temperature: float | None = None
    # Optional prior conversation turns ({role, content}) for multi-turn features
    # (RAG chat / character chat). Inserted between the system + the rendered user
    # message, so follow-ups keep proper message roles.
    history: list[dict] = []


class RunResponse(BaseModel):
    content: str
    model: str


def make_feature_router(
    get_store: Callable[[], PromptStore],
    get_config: Callable[[], LLMConfig],
) -> APIRouter:
    """Build the /v1/ai/run + /v1/ai/stream feature-execution router. The host
    supplies its `PromptStore` and an `llm_config()` builder (its settings →
    LLMConfig). The action's prompt is read from the store, the user + system
    templates filled from `variables`, and the call routed through the shared
    dispatch honoring the host's pins / roles / default."""
    router = APIRouter(tags=["ai"], prefix="/v1/ai")

    @router.post("/run", response_model=RunResponse)
    async def run_feature(body: RunRequest) -> RunResponse:
        spec = get_store().get(body.action)
        if spec is None:
            raise HTTPException(status_code=404, detail=f"unknown AI action {body.action!r}")
        messages = _history_messages(body.history) + [LLMMessage(role="user", content=render(spec.user_template, body.variables))]
        try:
            resp = chat(
                config=get_config(),
                feature=spec.feature,
                messages=messages,
                # System is templated too — most actions have no system
                # placeholders so render() returns it unchanged; e.g. plotHoles
                # injects the project's world-rules section.
                system=render(spec.system, body.variables),
                temperature=spec.temperature if body.temperature is None else body.temperature,
                think=spec.think,
                provider_override=body.providerId or None,
                model_override=body.model or None,
            )
        except LLMNotConfiguredError as e:
            # 501 → the UI shows the actionable "wire an LLM provider" message.
            raise HTTPException(status_code=501, detail=str(e)) from e
        return RunResponse(content=resp.text, model=resp.model)

    @router.post("/stream")
    async def stream_feature(body: RunRequest):
        """Streaming counterpart to /run for the interactive features (writerAI /
        chat / rag). Emits SSE: `data: {"delta": "..."}` per chunk, a final
        `data: {"done": true, "promptTokens", "completionTokens"}`, then
        `data: [DONE]`. Errors arrive as `data: {"error": "..."}` (the stream has
        started, so we can't send an HTTP status)."""
        spec = get_store().get(body.action)
        if spec is None:
            raise HTTPException(status_code=404, detail=f"unknown AI action {body.action!r}")
        messages = _history_messages(body.history) + [LLMMessage(role="user", content=render(spec.user_template, body.variables))]
        system = render(spec.system, body.variables)

        def gen():
            try:
                for delta in stream_chat(
                    config=get_config(),
                    feature=spec.feature,
                    messages=messages,
                    system=system,
                    temperature=spec.temperature if body.temperature is None else body.temperature,
                    think=spec.think,
                    provider_override=body.providerId or None,
                    model_override=body.model or None,
                ):
                    if delta.done:
                        frame = {
                            "done": True,
                            "promptTokens": delta.prompt_tokens,
                            "completionTokens": delta.completion_tokens,
                        }
                    else:
                        frame = {"delta": delta.text}
                    yield f"data: {json.dumps(frame)}\n\n"
            except LLMNotConfiguredError as e:
                yield f"data: {json.dumps({'error': str(e)})}\n\n"
            except Exception as e:  # noqa: BLE001 — surface as an error frame, not a 500
                yield f"data: {json.dumps({'error': str(e)[:200]})}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(gen(), media_type="text/event-stream")

    return router
