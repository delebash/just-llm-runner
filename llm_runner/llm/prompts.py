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

import asyncio
import json
import logging
import re
from dataclasses import dataclass, replace
from typing import Callable, Protocol

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .base import LLMMessage
from .dispatch import (
    LLMNotConfiguredError,
    chat,
    get_ensure_local_model,
    resolve_route,
    stream_chat,
)
from .preset_resolve import resolve_feature_preset, resolve_feature_preset_with_source
from .pricing import cost_for
from .schema import LLMConfig


log = logging.getLogger(__name__)


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
    json_schema: str = ""  # C1: optional JSON Schema text — with json_mode on, upgrades to schema-enforced output
    top_p: float | None = None  # nucleus sampling (#22); None → provider default
    reasoning_effort: str = ""  # "" | low | medium | high (a1/E2); the level when think is on
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
    jsonSchema: str = ""
    topP: float | None = None
    reasoningEffort: str = ""
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
    # Plane-2 fields are PRESERVE-ON-OMIT (None = keep the stored value): the
    # prompt editor sends only the fields it shows, and rebuilding the row from
    # bare defaults silently WIPED the seeded json_mode/max_tokens/top_p/
    # reasoning_effort on every text edit (latent #18 bug, found + fixed with C1).
    maxTokens: int | None = None
    jsonMode: bool | None = None
    jsonSchema: str | None = None
    topP: float | None = None
    reasoningEffort: str | None = None
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
        jsonSchema=r.json_schema,
        topP=r.top_p,
        reasoningEffort=r.reasoning_effort,
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
        # Preserve-on-omit for the Plane-2 fields (None = the editor didn't show
        # it): keep the STORED value so a prompt-text edit never wipes them.
        prev = get_store().get(key)
        get_store().upsert(FeaturePromptRow(
            key=key,
            feature=feature,
            system=body.system,
            user_template=body.userTemplate,
            temperature=body.temperature,
            think=body.think,
            built_in=built_in,
            max_tokens=body.maxTokens if body.maxTokens is not None else (prev.max_tokens if prev else 0),
            json_mode=body.jsonMode if body.jsonMode is not None else (prev.json_mode if prev else False),
            json_schema=body.jsonSchema if body.jsonSchema is not None else (prev.json_schema if prev else ""),
            top_p=body.topP if body.topP is not None else (prev.top_p if prev else None),
            reasoning_effort=body.reasoningEffort if body.reasoningEffort is not None else (prev.reasoning_effort if prev else ""),
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
            json_schema=str(default.get("json_schema") or ""),
            top_p=default.get("top_p"),
            reasoning_effort=str(default.get("reasoning_effort") or ""),
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
    # Reasoning-effort override (a1/E2): "" | low | medium | high; None → the
    # action's stored level. Applied only when reasoning is effectively on.
    reasoningEffort: str | None = None
    # Optional ad-hoc long-tail samplers for a Lab column (Compare / Workbench
    # test): [{flagName, flagValue}] applied to THIS call only — not saved —
    # overriding the action's stored feature_sampler_params. Lets a column vary
    # samplers without persisting them. (#21)
    samplers: list[dict] = []
    # Optional prior conversation turns ({role, content}) for multi-turn features
    # (RAG chat / character chat). Inserted between the system + the rendered user
    # message, so follow-ups keep proper message roles.
    history: list[dict] = []


class RunResponse(BaseModel):
    content: str
    model: str
    # Token usage so a one-shot run can report decode tok/s (a Lab ranks columns
    # by it) — the streaming path already emits these in its done frame.
    promptTokens: int = 0
    completionTokens: int = 0
    # Estimated USD cost of this call — Compare ranks columns by cost too (Decision
    # 23). Server-priced from the RESOLVED model via pricing.cost_for; local models
    # have no price entry → 0.
    cost: float = 0.0


class ResolvedRouteResponse(BaseModel):
    """What a run of `feature` (or a specific `action`) routes to RIGHT NOW —
    the §7.2 read-only "runs on" provenance chips display this. Computed from
    the SAME functions the run path uses (`_resolve_preset` + `resolve_route`),
    so the chip can never drift from what a run actually does. `configured`
    False (+ `detail`) is the honest factory/unregistered state."""

    feature: str
    action: str = ""
    providerId: str = ""
    model: str = ""
    taskKind: str = ""
    presetId: str = ""
    presetName: str = ""
    presetSource: str = ""    # which tier won: "feature" | "task" | "default" | "" (restored 2026-07-14)
    configured: bool = True
    detail: str = ""


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


def _response_format(spec: FeaturePromptRow, action: str) -> dict:
    """The response_format for a JSON action (#18 → C1). A stored schema that
    parses as a non-empty JSON OBJECT upgrades the weak json_object to
    schema-ENFORCED output, emitted in the OpenAI-standard NESTED form — each
    adapter translates to its backend (the builtin runner flattens to the
    b9644-documented {"type":"json_schema","schema":…}; Ollama format=<schema>;
    Gemini responseSchema; Anthropic strips — no such param). The schema is NOT
    injected into the prompt (recorded design: the prompt still describes the
    shape). No/invalid schema → json_object as before; an invalid one logs a
    warning and DEGRADES rather than failing the run."""
    raw = (spec.json_schema or "").strip()
    if raw:
        try:
            obj = json.loads(raw)
        except ValueError:
            obj = None
        if isinstance(obj, dict) and obj:
            # OpenAI constrains the name to ^[A-Za-z0-9_-]+$ — slugify the action
            # id (dots etc. → _) so a cloud pass-through never 400s on the name.
            name = re.sub(r"[^A-Za-z0-9_-]", "_", action or "") or "response"
            return {"type": "json_schema",
                    "json_schema": {"name": name, "schema": obj, "strict": True}}
        log.warning("action %s has an invalid json_schema — falling back to json_object", action)
    return {"type": "json_object"}


def _plane2_extra(spec: FeaturePromptRow, body: RunRequest, preset=None) -> dict | None:
    """Per-request `extra` from the action's Plane-2 params — json_mode/top_p PLUS
    its long-tail sampler knobs, each overridable by the request. Precedence
    (highest→lowest): per-call `body.samplers` → stored `feature_sampler_params` →
    the resolved PRESET's samplers (the lab+preset source of truth). The reserved
    `samplers` key is the sampler ORDER — a comma-joined name list that is split into
    an array for the engine. Merges straight into the OpenAI-compatible chat body
    (the adapter applies `extra`); no model reload. Safe across adapters: openai-compat
    sends all (cloud ignores unknown fields), the others map selectively. (#18 / #22 / §8)"""
    extra: dict = {}
    json_mode = spec.json_mode if body.jsonMode is None else body.jsonMode
    if json_mode:
        extra["response_format"] = _response_format(spec, body.action)
    top_p = spec.top_p if body.topP is None else body.topP
    if top_p is not None:
        extra["top_p"] = top_p
    # Ad-hoc per-call samplers (a Lab column) win over the stored ones — added
    # first so the stored loop's `not in extra` guard skips an overridden key.
    for row in body.samplers or []:
        name = (row.get("flagName") or "").strip()
        if not name:
            continue
        val = _parse_sampler_value(row.get("flagValue") or "")
        if val is not None:
            extra[name] = val
    # Long-tail per-action samplers (stored). Lazy import: stores imports prompts
    # (FeaturePromptRow), so a top-level import would cycle.
    from . import stores

    for row in stores.get_feature_sampler_store().list(body.action):
        val = _parse_sampler_value(row.flagValue)
        if val is not None and row.flagName not in extra:
            extra[row.flagName] = val
    # Resolved preset's long-tail samplers (the lab+preset source of truth) — LOWEST
    # precedence: applied only where a per-call / per-feature value hasn't set it.
    for row in getattr(preset, "samplers", None) or []:
        name = (getattr(row, "flagName", "") or "").strip()
        if name and name not in extra:
            val = _parse_sampler_value(getattr(row, "flagValue", "") or "")
            if val is not None:
                extra[name] = val
    # Reasoning-effort LEVEL (a1/E2) — carried under the reserved `reasoning_effort`
    # key, which each adapter pops + maps to its backend's native reasoning control
    # (Anthropic budget_tokens / Gemini thinkingBudget / OpenAI reasoning_effort /
    # llama.cpp chat_template_kwargs / Ollama think-level). ONLY when reasoning is
    # effectively on (B3: think gated off under json_mode), so it never corrupts JSON.
    if _effective_think(spec, body):
        effort = (body.reasoningEffort if body.reasoningEffort is not None else spec.reasoning_effort) or ""
        if effort:
            extra["reasoning_effort"] = effort
    # The sampler ORDER ("samplers") is an ARRAY of sampler names — accept a
    # comma-joined string from the knob value and split it for the engine.
    if isinstance(extra.get("samplers"), str):
        extra["samplers"] = [s.strip() for s in extra["samplers"].split(",") if s.strip()]
    # The reserved `stop` key is a per-feature STOP-sequence list — one per line in
    # the UI → an ARRAY of strings for the engine. Robust to _parse_sampler_value's
    # numeric coercion (a numeric-looking stop like "42" comes back as int). Each
    # adapter maps the array: openai/llama.cpp `stop`, gemini `stopSequences`,
    # ollama `options.stop`, anthropic `stop_sequences`.
    if "stop" in extra:
        raw = extra["stop"]
        parts = raw.split("\n") if isinstance(raw, str) else [raw]
        stops = [str(s).strip() for s in parts if str(s).strip()]
        if stops:
            extra["stop"] = stops
        else:
            del extra["stop"]
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


def _resolve_preset(action: str, feature: str, task_kind_of):
    """The engine preset for this action — the full 3-tier cascade (restored
    2026-07-14): the action's OWN override (FeaturePresetRef[action]) → the
    action's taskKind preset → the global default. `task_kind_of` maps an action
    (or feature) key → its LLM-work taskKind; None (no map wired, e.g. tests) →
    no preset = legacy routing, so behaviour is unchanged until presets are
    configured. The ACTION's taskKind is tried first (falling back to the
    feature's) so writerAI.continue (prose.generate) and writerAI.tighten
    (prose.edit) resolve to DIFFERENT presets — and the per-feature override is
    keyed on the same action id, so those two can also override independently."""
    if task_kind_of is None:
        return None
    task_kind = task_kind_of(action) or task_kind_of(feature) or ""
    return resolve_feature_preset(action, task_kind)


def _effective_spec(spec: FeaturePromptRow, preset) -> FeaturePromptRow:
    """Overlay a resolved preset's engine params onto the prompt spec. In the
    lab+preset model the PRESET is the source of truth for params (temperature /
    json / top_p / reasoning / max-tokens); the prompt only carries system/user
    text. None → spec unchanged. Request-level overrides still win downstream.
    (The preset's MODEL is applied separately as the provider/model override; its
    long-tail samplers are wired in a follow-up.)"""
    if preset is None:
        return spec
    return replace(
        spec,
        temperature=spec.temperature if preset.temperature is None else preset.temperature,
        think=bool(preset.reasoningEffort),
        max_tokens=preset.maxTokens or spec.max_tokens,
        json_mode=preset.jsonMode,
        top_p=preset.topP,
        reasoning_effort=preset.reasoningEffort,
    )


async def _ensure_local_ready(
    config: LLMConfig,
    feature: str,
    action: str,
    provider_override: str | None,
    model_override: str | None,
) -> None:
    """QC-43b: when a run resolves to the bundled LOCAL runner, make its model resident
    before dispatch — otherwise the adapter talks to a router that may be down and the
    caller sees a bare "Connection refused". Done SERVER-side so chat, features, and the
    Lab are all covered with no client change (embeddings already do the equivalent via
    ensure_embedding). No-op when: no ensure hook is wired (a host without the bundled
    runner), the route resolves to a non-local provider, or no model id resolved. The
    resolved provider id is compared to `config.local_runner_provider_id` (never a
    hardcoded string). The ensure callable is SYNC and BLOCKS until the model loads, so
    it runs off the event loop via asyncio.to_thread. Route-resolution errors
    (LLMNotConfiguredError) and load failures (RuntimeError) propagate to the caller,
    which surfaces them through its existing error shape (run: exception → HTTP error;
    stream: caught into the SSE error frame)."""
    ensure = get_ensure_local_model()
    if ensure is None:
        return
    adapter, model, _tier = resolve_route(
        config, feature, action=action,
        provider_override=provider_override, model_override=model_override,
    )
    if model and adapter.provider_id == config.local_runner_provider_id:
        await asyncio.to_thread(ensure, model)


def make_feature_router(
    get_store: Callable[[], PromptStore],
    get_config: Callable[[], LLMConfig],
    task_kind_of: Callable[[str], str] | None = None,
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
        preset = _resolve_preset(body.action, spec.feature, task_kind_of)
        eff = _effective_spec(spec, preset)
        provider_override = body.providerId or (preset.providerId if preset else "") or None
        model_override = body.model or (preset.model if preset else "") or None
        try:
            # QC-43b: a run routed to the bundled local runner makes its model resident
            # first (else the adapter hits a down router → "Connection refused"). No-op
            # for cloud/remote providers or when no ensure hook is wired; a load failure
            # propagates through this handler's existing exception path.
            await _ensure_local_ready(
                get_config(), spec.feature, body.action, provider_override, model_override,
            )
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
                temperature=eff.temperature if body.temperature is None else body.temperature,
                think=_effective_think(eff, body),
                max_tokens=(body.maxTokens if body.maxTokens is not None else eff.max_tokens) or None,
                provider_override=provider_override,
                model_override=model_override,
                extra=_plane2_extra(eff, body, preset),
            )
        except LLMNotConfiguredError as e:
            # 501 → the UI shows the actionable "wire an LLM provider" message.
            raise HTTPException(status_code=501, detail=str(e)) from e
        return RunResponse(
            content=resp.text, model=resp.model,
            promptTokens=resp.prompt_tokens, completionTokens=resp.completion_tokens,
            cost=cost_for(resp.model, resp.prompt_tokens, resp.completion_tokens),
        )

    @router.post("/stream")
    async def stream_feature(body: RunRequest):
        """Streaming counterpart to /run for the interactive features (writerAI /
        chat / rag). Emits SSE: `data: {"delta": "..."}` per chunk, optional
        `data: {"progress": 0..1}` prompt-eval frames before the first token
        (builtin engine only — §7.4 B6-2), a final `data: {"done": true,
        "promptTokens", "completionTokens", "model", "cost"}` carrying everything
        /run's response carries, then `data: [DONE]`. Errors arrive as
        `data: {"error": "..."}` (the stream has started, so we can't send an
        HTTP status)."""
        spec = get_store().get(body.action)
        if spec is None:
            raise HTTPException(status_code=404, detail=f"unknown AI action {body.action!r}")
        sys_tpl = spec.system if body.system is None else body.system
        usr_tpl = spec.user_template if body.userTemplate is None else body.userTemplate
        messages = _history_messages(body.history) + [LLMMessage(role="user", content=render(usr_tpl, body.variables))]
        system = render(sys_tpl, body.variables)
        preset = _resolve_preset(body.action, spec.feature, task_kind_of)
        eff = _effective_spec(spec, preset)
        provider_override = body.providerId or (preset.providerId if preset else "") or None
        model_override = body.model or (preset.model if preset else "") or None

        # QC-43b: ensure a bundled-runner model is resident BEFORE streaming (else the
        # adapter hits a down router → "Connection refused"). Awaited here in the async
        # handler; any failure is captured and re-emitted as the stream's OWN SSE error
        # frame below (never a pre-stream 500, matching how stream_chat errors surface).
        ensure_error: str | None = None
        try:
            await _ensure_local_ready(
                get_config(), spec.feature, body.action, provider_override, model_override,
            )
        except Exception as e:  # noqa: BLE001 — deferred into the SSE error frame below
            ensure_error = str(e)[:200]

        def gen():
            if ensure_error is not None:
                yield f"data: {json.dumps({'error': ensure_error})}\n\n"
                yield "data: [DONE]\n\n"
                return
            try:
                for delta in stream_chat(
                    config=get_config(),
                    feature=spec.feature,
                    action=body.action,
                    messages=messages,
                    system=system,
                    temperature=eff.temperature if body.temperature is None else body.temperature,
                    think=_effective_think(eff, body),
                    max_tokens=(body.maxTokens if body.maxTokens is not None else eff.max_tokens) or None,
                    provider_override=provider_override,
                    model_override=model_override,
                    extra=_plane2_extra(eff, body, preset),
                ):
                    if delta.done:
                        frame = {
                            "done": True,
                            "promptTokens": delta.prompt_tokens,
                            "completionTokens": delta.completion_tokens,
                            "model": delta.model,
                            "cost": cost_for(
                                delta.model, delta.prompt_tokens, delta.completion_tokens
                            ),
                        }
                    elif delta.progress is not None:
                        frame = {"progress": delta.progress}
                    else:
                        frame = {"delta": delta.text}
                    yield f"data: {json.dumps(frame)}\n\n"
            except LLMNotConfiguredError as e:
                yield f"data: {json.dumps({'error': str(e)})}\n\n"
            except Exception as e:  # noqa: BLE001 — surface as an error frame, not a 500
                yield f"data: {json.dumps({'error': str(e)[:200]})}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(gen(), media_type="text/event-stream")

    @router.get("/resolved-route", response_model=ResolvedRouteResponse)
    async def resolved_route(feature: str, action: str = "") -> ResolvedRouteResponse:
        """The provider+model a run of this feature/action would use right now
        (B5-1, §7.2): the task-preset cascade as the override, then the dispatch
        resolution — mirrored via the run path's own functions, never re-derived."""
        key = action or feature
        task_kind = ""
        if task_kind_of is not None:
            task_kind = task_kind_of(key) or task_kind_of(feature) or ""
        # The same 3-tier cascade the run path uses (via _resolve_preset →
        # resolve_feature_preset), plus which tier won for the provenance chip.
        preset, preset_source = (
            resolve_feature_preset_with_source(key, task_kind)
            if task_kind_of is not None else (None, "")
        )
        base = dict(
            feature=feature, action=action, taskKind=task_kind,
            presetId=preset.id if preset else "",
            presetName=preset.name if preset else "",
            presetSource=preset_source,
        )
        try:
            adapter, model, _tier = resolve_route(
                get_config(), feature, action=key,
                provider_override=(preset.providerId if preset else "") or None,
                model_override=(preset.model if preset else "") or None,
            )
        except LLMNotConfiguredError as e:
            return ResolvedRouteResponse(**base, configured=False, detail=str(e))
        return ResolvedRouteResponse(**base, providerId=adapter.provider_id, model=model)

    return router
