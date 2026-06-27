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
    `feature_prompts` row. The host maps its own table to/from this. `label`,
    `description` + `group` are nav metadata (the action's display name, a short
    blurb, and an optional sub-section label, e.g. writerAI's "Prose actions" /
    "Line edits") the Feature Workbench renders. `label` empty → the UI derives a
    name from the key / falls back to the feature label."""

    key: str
    feature: str
    system: str
    user_template: str
    temperature: float
    think: bool
    built_in: bool
    max_tokens: int = 0  # 0 → no cap (the model's own default)
    json_mode: bool = False  # response_format=json_object (#18)
    top_p: float | None = None  # nucleus sampling (#22); None → provider default
    label: str = ""
    description: str = ""
    group: str = ""


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
    maxTokens: int = 0
    jsonMode: bool = False
    topP: float | None = None
    label: str = ""
    description: str = ""
    group: str = ""


class PromptList(BaseModel):
    prompts: list[PromptOut]


class PromptUpdate(BaseModel):
    # The editable fields. `feature` defaults to the built-in's routing key (or
    # the key itself for a user-created prompt) when omitted. `label`/`description`/
    # `group` are nav metadata — omitted by the prompt editor, so they fall back to
    # the seeded defaults (see upsert) rather than being wiped on a content edit.
    feature: str = ""
    system: str = ""
    userTemplate: str = ""
    temperature: float = 0.7
    think: bool = False
    maxTokens: int = 0
    jsonMode: bool = False
    topP: float | None = None
    label: str = ""
    description: str = ""
    group: str = ""


def _out(r: FeaturePromptRow) -> PromptOut:
    return PromptOut(
        key=r.key,
        feature=r.feature,
        system=r.system,
        userTemplate=r.user_template,
        temperature=r.temperature,
        think=r.think,
        builtIn=r.built_in,
        maxTokens=r.max_tokens,
        jsonMode=r.json_mode,
        topP=r.top_p,
        label=r.label,
        description=r.description,
        group=r.group,
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
        # Nav metadata — the editor omits these, so keep the seeded values rather
        # than wiping them on a prompt-content edit.
        label = body.label or (str(default.get("label") or "") if default else "")
        description = body.description or (str(default.get("description") or "") if default else "")
        group = body.group or (str(default.get("group") or "") if default else "")
        get_store().upsert(FeaturePromptRow(
            key=key,
            feature=feature,
            system=body.system,
            user_template=body.userTemplate,
            temperature=body.temperature,
            think=body.think,
            built_in=built_in,
            max_tokens=body.maxTokens,
            json_mode=body.jsonMode,
            top_p=body.topP,
            label=label,
            description=description,
            group=group,
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
            max_tokens=int(default.get("max_tokens", 0) or 0),
            json_mode=bool(default.get("json_mode", False)),
            top_p=default.get("top_p"),
            label=str(default.get("label") or ""),
            description=str(default.get("description") or ""),
            group=str(default.get("group") or ""),
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
    # Optional prompt overrides — the Feature Workbench Lab tests an in-editor
    # CANDIDATE (a draft / preset not yet promoted to production) without writing
    # it live. None → the stored prompt; `think=None` → the stored think.
    system: str | None = None
    userTemplate: str | None = None
    think: bool | None = None
    maxTokens: int | None = None
    # Optional per-action Plane-2 params (None → the stored value): structured
    # output (JSON) + nucleus sampling. (#18 / #22)
    jsonMode: bool | None = None
    topP: float | None = None
    # Optional prior conversation turns ({role, content}) for multi-turn features
    # (RAG chat / character chat). Inserted between the system + the rendered user
    # message, so follow-ups keep proper message roles.
    history: list[dict] = []


class RunResponse(BaseModel):
    content: str
    model: str


def _parse_sampler_value(v: str):
    """A stored text sampler value → the JSON type the chat API expects
    (bool / int / float / str). Empty → None ('not set')."""
    s = (v or "").strip()
    if not s:
        return None
    low = s.lower()
    if low in ("true", "false"):
        return low == "true"
    try:
        return int(s)
    except ValueError:
        pass
    try:
        return float(s)
    except ValueError:
        pass
    return s


def _plane2_extra(spec: FeaturePromptRow, body: RunRequest) -> dict | None:
    """Per-request `extra` from the action's Plane-2 params — json_mode/top_p PLUS
    its long-tail sampler knobs (feature_sampler_params: top_k/min_p/mirostat/…),
    each overridable by the request. Merges straight into the OpenAI-compatible chat
    body (the adapter applies `extra`); no model reload. Safe across adapters:
    openai-compat sends all (cloud ignores unknown fields), the others map
    selectively. (#18 / #22 / §8)"""
    extra: dict = {}
    json_mode = spec.json_mode if body.jsonMode is None else body.jsonMode
    if json_mode:
        extra["response_format"] = {"type": "json_object"}
    top_p = spec.top_p if body.topP is None else body.topP
    if top_p is not None:
        extra["top_p"] = top_p
    # Long-tail per-action samplers. Lazy import: stores imports prompts
    # (FeaturePromptRow), so a top-level import would cycle.
    from . import stores

    for row in stores.get_feature_sampler_store().list(body.action):
        val = _parse_sampler_value(row.flagValue)
        if val is not None and row.flagName not in extra:
            extra[row.flagName] = val
    return extra or None


def _effective_think(spec: FeaturePromptRow, body: RunRequest) -> bool:
    """The think flag for this call, with the B3 guardrail: a reasoning block
    corrupts strict JSON, so think is FORCED off whenever json_mode is on (the
    request's jsonMode override, else the action's stored json_mode) — even if the
    action/tier would otherwise reason. (Attribution's reason-then-emit two-pass is
    the JV-side refinement; here the guardrail keeps extraction/JSON actions valid.)"""
    think = spec.think if body.think is None else body.think
    json_mode = spec.json_mode if body.jsonMode is None else body.jsonMode
    return bool(think) and not json_mode


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
        # Lab candidate overrides (None → the stored prompt) so a draft/preset can
        # be tested before it's promoted to production.
        sys_tpl = spec.system if body.system is None else body.system
        usr_tpl = spec.user_template if body.userTemplate is None else body.userTemplate
        messages = _history_messages(body.history) + [LLMMessage(role="user", content=render(usr_tpl, body.variables))]
        try:
            resp = chat(
                config=get_config(),
                feature=spec.feature,
                # The action key routes to its own model when it has one, else the
                # feature default (per-action override cascade).
                action=body.action,
                messages=messages,
                # System is templated too — most actions have no system
                # placeholders so render() returns it unchanged; e.g. plotHoles
                # injects the project's world-rules section.
                system=render(sys_tpl, body.variables),
                temperature=spec.temperature if body.temperature is None else body.temperature,
                think=_effective_think(spec, body),
                max_tokens=(body.maxTokens if body.maxTokens is not None else spec.max_tokens) or None,
                provider_override=body.providerId or None,
                model_override=body.model or None,
                extra=_plane2_extra(spec, body),
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
        sys_tpl = spec.system if body.system is None else body.system
        usr_tpl = spec.user_template if body.userTemplate is None else body.userTemplate
        messages = _history_messages(body.history) + [LLMMessage(role="user", content=render(usr_tpl, body.variables))]
        system = render(sys_tpl, body.variables)

        def gen():
            try:
                for delta in stream_chat(
                    config=get_config(),
                    feature=spec.feature,
                    action=body.action,
                    messages=messages,
                    system=system,
                    temperature=spec.temperature if body.temperature is None else body.temperature,
                    think=_effective_think(spec, body),
                    max_tokens=(body.maxTokens if body.maxTokens is not None else spec.max_tokens) or None,
                    provider_override=body.providerId or None,
                    model_override=body.model or None,
                    extra=_plane2_extra(spec, body),
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
