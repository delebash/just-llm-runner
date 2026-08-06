# SPDX-License-Identifier: MIT
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
from dataclasses import dataclass
from typing import Callable, Protocol

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .base import LLMMessage, LLMResponse
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
    """One action's editable prompt — the dispatch-time + Lab-edit view of a
    `feature_prompts` row. Prompt TEXT + the JSON CONTRACT (`json_mode`/`json_schema`,
    kept on the action because the app's parsers are per-action) + nav metadata
    (`label`/`description`/`group`). EVERY tunable (temperature/top_p/think/reasoning/
    max_tokens) moved to the engine preset 2026-07-15 — the one source. `label` empty
    → the UI derives a name from the key / falls back to the feature label."""

    key: str
    feature: str
    system: str
    user_template: str
    built_in: bool
    json_mode: bool = False  # response_format=json_object (#18) — the action's JSON CONTRACT
    json_schema: str = ""  # C1: optional JSON Schema text — with json_mode on, upgrades to schema-enforced output
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


class MissingTemplateVariables(ValueError):
    """A template referenced {{names}} the variables dict does not carry."""

    def __init__(self, names):
        self.names = list(names)
        super().__init__("missing template variable(s): " + ", ".join(self.names))


def render(template: str, variables: dict) -> str:
    """Substitute {{name}} placeholders from `variables` — FAIL-LOUD on absence.

    A placeholder whose name is ABSENT from `variables` raises
    MissingTemplateVariables naming every missing key (2026-08-05, the gate the
    family template-row conversion shares: the silent missing→empty behavior
    let a mis-wired caller ship a prompt with holes and nobody saw it). A key
    that IS present renders str(value), "" included — present-but-empty is a
    caller's legitimate "nothing here"; absence is a wiring bug. The run routes
    convert this to HTTP 400 naming the action + keys."""
    missing = sorted({m.group(1) for m in _VAR.finditer(template)} - set(variables))
    if missing:
        raise MissingTemplateVariables(missing)
    return _VAR.sub(lambda m: str(variables.get(m.group(1), "")), template)


def _render_pair(sys_tpl: str, usr_tpl: str, variables: dict) -> tuple[str, str]:
    """Render an action's system + user templates together, reporting the UNION
    of missing names in one error — rendering one at a time would name only the
    first template's gap and the author would fix variables twice."""
    missing = sorted(
        ({m.group(1) for m in _VAR.finditer(sys_tpl)}
         | {m.group(1) for m in _VAR.finditer(usr_tpl)}) - set(variables)
    )
    if missing:
        raise MissingTemplateVariables(missing)
    return render(sys_tpl, variables), render(usr_tpl, variables)


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
    builtIn: bool
    jsonMode: bool = False
    jsonSchema: str = ""
    label: str = ""
    description: str = ""
    group: str = ""


class PromptList(BaseModel):
    prompts: list[PromptOut]


class PromptUpdate(BaseModel):
    # The editable fields: prompt TEXT + the JSON CONTRACT (jsonMode/jsonSchema) + nav
    # metadata. Tunables are GONE from the wire (2026-07-15 — they live on the engine
    # preset). `feature` defaults to the built-in's routing key when omitted; the
    # contract fields are PRESERVE-ON-OMIT (None = keep the stored value) so a
    # text-only edit never wipes the seeded json_mode/json_schema.
    feature: str = ""
    system: str = ""
    userTemplate: str = ""
    jsonMode: bool | None = None
    jsonSchema: str | None = None
    label: str = ""
    description: str = ""
    group: str = ""


def _out(r: FeaturePromptRow) -> PromptOut:
    return PromptOut(
        key=r.key,
        feature=r.feature,
        system=r.system,
        userTemplate=r.user_template,
        builtIn=r.built_in,
        jsonMode=r.json_mode,
        jsonSchema=r.json_schema,
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
        (so it can be reset); anything else is a user-created prompt. Text + the JSON
        CONTRACT + nav only — every tunable lives on the engine preset now."""
        default = defaults.get(key)
        built_in = default is not None
        feature = body.feature or (str(default.get("feature")) if default else key) or key
        # Nav metadata — the editor omits these, so keep the seeded values rather
        # than wiping them on a prompt-content edit.
        label = body.label or (str(default.get("label") or "") if default else "")
        description = body.description or (str(default.get("description") or "") if default else "")
        group = body.group or (str(default.get("group") or "") if default else "")
        # Preserve-on-omit for the JSON contract (None = the editor didn't send it):
        # keep the STORED value so a prompt-text edit never wipes the contract.
        prev = get_store().get(key)
        get_store().upsert(FeaturePromptRow(
            key=key,
            feature=feature,
            system=body.system,
            user_template=body.userTemplate,
            built_in=built_in,
            json_mode=body.jsonMode if body.jsonMode is not None else (prev.json_mode if prev else False),
            json_schema=body.jsonSchema if body.jsonSchema is not None else (prev.json_schema if prev else ""),
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
            built_in=True,
            json_mode=bool(default.get("json_mode", False)),
            json_schema=str(default.get("json_schema") or ""),
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
    # overriding the resolved preset's samplers. Lets a column vary
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
    the SAME functions the run path uses (`resolve_feature_preset` + `resolve_route`),
    so the chip can never drift from what a run actually does. `configured`
    False (+ `detail`) is the honest factory/unregistered state."""

    feature: str
    action: str = ""
    providerId: str = ""
    model: str = ""
    presetId: str = ""
    presetName: str = ""
    presetSource: str = ""    # which tier won: "assigned" | "default" | ""
    # Reasoning (U2-T6): what this run's thinking resolves to RIGHT NOW — think on/off, the
    # ask level, the resolved effort word, and the emitted budget value + the layer it came
    # from. The chip/picker read these (no client math — the mirror/drift law); a cloud
    # word route carries value=None.
    think: bool = False
    level: str = ""
    reasoningWord: str = ""
    value: int | None = None
    valueSource: str = ""     # local: "tune"|"class"|"base"|"default"|"invalid" · cloud: "map" · "" = none
    # The capability gate's honest state (approved 2026-08-06): the preset WANTS
    # thinking but the resolved model can't think, so the run is gated off.
    # The chip + Lab MUST annotate this ("thinking on — inactive: this model
    # doesn't think") — an invisible gate would be the magic the gate exists
    # to kill. `think` above stays the EFFECTIVE value (False when gated).
    thinkInactive: bool = False
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


def _response_format(spec: FeaturePromptRow | None, action: str) -> dict:
    """The response_format for a JSON action (#18 → C1). A stored schema that
    parses as a non-empty JSON OBJECT upgrades the weak json_object to
    schema-ENFORCED output, emitted in the OpenAI-standard NESTED form — each
    adapter translates to its backend (the builtin runner flattens to the
    b9644-documented {"type":"json_schema","schema":…}; Ollama format=<schema>;
    Gemini responseSchema; Anthropic strips — no such param). The schema is NOT
    injected into the prompt (recorded design: the prompt still describes the
    shape). No/invalid schema → json_object as before; an invalid one logs a
    warning and DEGRADES rather than failing the run."""
    raw = ((spec.json_schema if spec else "") or "").strip()
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


def _plane2_extra(spec: FeaturePromptRow | None, body: RunRequest, preset=None) -> dict | None:
    """Per-request `extra` from the action's JSON CONTRACT (json_mode, on the spec) +
    the resolved PRESET's tunables (top_p, reasoning, samplers — the one source,
    2026-07-15), each overridable by the request. Precedence (highest→lowest): per-call
    `body.samplers` → the resolved PRESET's samplers. The reserved `samplers` key is the
    sampler ORDER — a comma-joined name list split into an array for the engine. Merges
    straight into the OpenAI-compatible chat body (the adapter applies `extra`); no model
    reload. Safe across adapters: openai-compat sends all (cloud ignores unknown fields),
    the others map selectively. (#18 / #22 / §8)"""
    extra: dict = {}
    json_mode = (spec.json_mode if spec else False) if body.jsonMode is None else body.jsonMode
    if json_mode:
        extra["response_format"] = _response_format(spec, body.action)
    top_p = (preset.topP if preset else None) if body.topP is None else body.topP
    if top_p is not None:
        extra["top_p"] = top_p
    # Ad-hoc per-call samplers (a Lab column) win over the preset's — added first so
    # the preset loop's `not in extra` guard skips an overridden key.
    for row in body.samplers or []:
        name = (row.get("flagName") or "").strip()
        if not name:
            continue
        val = _parse_sampler_value(row.get("flagValue") or "")
        if val is not None:
            extra[name] = val
    # Resolved preset's long-tail samplers (the lab+preset source of truth) — applied
    # only where a per-call value hasn't already set it.
    for row in getattr(preset, "samplers", None) or []:
        name = (getattr(row, "flagName", "") or "").strip()
        if name and name not in extra:
            val = _parse_sampler_value(getattr(row, "flagValue", "") or "")
            if val is not None:
                extra[name] = val
    # Reasoning-effort LEVEL (a1/E2) — from the PRESET, carried under the reserved
    # `reasoning_effort` key each adapter pops + maps to its backend's native control
    # (Anthropic budget_tokens / Gemini thinkingBudget / OpenAI reasoning_effort /
    # llama.cpp chat_template_kwargs / Ollama think-level). ONLY when reasoning is
    # effectively on (B3: think gated off under json_mode), so it never corrupts JSON.
    if _effective_think(spec, body, preset):
        effort = (body.reasoningEffort if body.reasoningEffort is not None else (preset.reasoningEffort if preset else "")) or ""
        # ALWAYS injected under effective think — the key's PRESENCE marks think-on for
        # dispatch._apply_reasoning. "" is a real state (2026-07-16 preset tier): local
        # ⇒ FOLLOW the model's layered budget; cloud ⇒ provider default (no word sent).
        # Gating on non-empty effort would silently skip the local budget for the
        # follow state — the default state of every seeded thinking preset.
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


def _effective_think(spec: FeaturePromptRow | None, body: RunRequest, preset=None) -> bool:
    """The think flag for this call = the PRESET's think (the one source, 2026-07-15),
    with the B3 guardrail: a reasoning block corrupts strict JSON, so think is FORCED
    off whenever json_mode is on (the request's jsonMode override, else the action's
    CONTRACT json_mode). A request `think` override still wins (a Lab column comparing
    reasoned vs direct). No preset → think off."""
    think = body.think if body.think is not None else (preset.think if preset else False)
    json_mode = (spec.json_mode if spec else False) if body.jsonMode is None else body.jsonMode
    return bool(think) and not json_mode


def _ensure_local_ready_sync(
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
    hardcoded string). SYNC and BLOCKING until the model loads (`run_action` is a
    blocking call by contract; the async routes run off the event loop via
    asyncio.to_thread). Route-resolution errors (LLMNotConfiguredError) and load
    failures (RuntimeError) propagate to the caller, which surfaces them through its
    existing error shape (run: exception → HTTP error; stream: caught into the SSE
    error frame)."""
    ensure = get_ensure_local_model()
    if ensure is None:
        return
    adapter, model, _tier = resolve_route(
        config, feature, action=action,
        provider_override=provider_override, model_override=model_override,
    )
    if model and adapter.provider_id == config.local_runner_provider_id:
        ensure(model)


async def _ensure_local_ready(
    config: LLMConfig,
    feature: str,
    action: str,
    provider_override: str | None,
    model_override: str | None,
) -> None:
    """The stream route's awaitable face of _ensure_local_ready_sync (the model
    load blocks, so it runs off the event loop)."""
    await asyncio.to_thread(
        _ensure_local_ready_sync, config, feature, action, provider_override, model_override,
    )


class UnknownActionError(KeyError):
    """`run_action` got an action with no prompt row AND no body-supplied
    templates — nothing to run. The route maps it to 404."""


def run_action(store: PromptStore, config: LLMConfig, body: RunRequest) -> LLMResponse:
    """THE one non-stream run path (extracted 2026-08-05, JV F1 Phase 2): resolve
    the action's prompt row — or the body-supplied system/userTemplate, the
    explicit-system door a composed caller rides — render both templates
    (fail-loud on missing variables), resolve the action's ENGINE PRESET,
    overlay every tunable (preset first, request-body ephemerally on top),
    make a bundled-runner model resident, and dispatch.

    Shared by POST /v1/ai/run AND in-server feature callers (JustVoice's
    features run in-process); before this existed the overlay lived only in
    the route's closure, so an in-server caller would have re-implemented it —
    the exact drift this package exists to prevent. SYNC + BLOCKING (chat is;
    a local model load can take seconds): async callers use asyncio.to_thread.
    Raises UnknownActionError / MissingTemplateVariables / LLMNotConfiguredError;
    usage lands in the ledger via dispatch, same as every run."""
    spec = store.get(body.action)
    # PROMPTLESS actions (a pipeline-owned app registers feature_prompts={}) have
    # no spec row — but the Lab's columns always carry the app-built prompt as
    # system+userTemplate, so the run goes through against the action's resolved
    # preset (found live 2026-08-04: docgen's Lab ▶ Run 404'd "unknown AI action").
    # jsonMode/schema have no spec home there: body.jsonMode only, no schema.
    if spec is None and (body.system is None or body.userTemplate is None):
        raise UnknownActionError(body.action)
    # Lab candidate overrides (None → the stored prompt) so a draft/preset can
    # be tested before it's promoted to production.
    feature_key = spec.feature if spec else body.action
    sys_tpl = (spec.system if spec else "") if body.system is None else body.system
    usr_tpl = (spec.user_template if spec else "") if body.userTemplate is None else body.userTemplate
    system_text, user_text = _render_pair(sys_tpl, usr_tpl, body.variables)
    messages = _history_messages(body.history) + [LLMMessage(role="user", content=user_text)]
    preset = resolve_feature_preset(body.action)
    provider_override = body.providerId or (preset.providerId if preset else "") or None
    model_override = body.model or (preset.model if preset else "") or None
    # Every tunable comes from the resolved PRESET (the one source, 2026-07-15);
    # request-body values override ephemerally. No preset → provider-default route,
    # NO tunables sent (temperature None omits it), think off — the no-preset rule.
    temperature = body.temperature if body.temperature is not None else (preset.temperature if preset else None)
    max_tokens = (body.maxTokens if body.maxTokens is not None else (preset.maxTokens if preset else 0)) or None
    # QC-43b: a run routed to the bundled local runner makes its model resident
    # first (else the adapter hits a down router → "Connection refused").
    _ensure_local_ready_sync(config, feature_key, body.action, provider_override, model_override)
    return chat(
        config=config,
        feature=feature_key,
        # The action key routes to its own model when it has one, else the
        # feature default (per-action override cascade).
        action=body.action,
        messages=messages,
        # System is templated too — most actions have no system placeholders so
        # render() returns it unchanged; e.g. plotHoles injects world rules.
        system=system_text,
        temperature=temperature,
        think=_effective_think(spec, body, preset),
        max_tokens=max_tokens,
        provider_override=provider_override,
        model_override=model_override,
        extra=_plane2_extra(spec, body, preset),
    )


def make_feature_router(
    get_store: Callable[[], PromptStore],
    get_config: Callable[[], LLMConfig],
) -> APIRouter:
    """Build the /v1/ai/run + /v1/ai/stream feature-execution router. The host
    supplies its `PromptStore` and an `llm_config()` builder (its settings →
    LLMConfig). The action's prompt is read from the store, the user + system
    templates filled from `variables`, its ENGINE PRESET resolved (ref → default),
    and the call routed through the shared dispatch with the preset's model + params."""
    router = APIRouter(tags=["ai"], prefix="/v1/ai")

    @router.post("/run", response_model=RunResponse)
    async def run_feature(body: RunRequest) -> RunResponse:
        # The whole resolve→render→overlay→ensure→dispatch path IS run_action
        # (the helper in-server feature callers share — one source, no drift).
        # to_thread because run_action blocks: the ensure hook loads a model and
        # chat() is a synchronous network call.
        try:
            resp = await asyncio.to_thread(run_action, get_store(), get_config(), body)
        except UnknownActionError as e:
            raise HTTPException(status_code=404, detail=f"unknown AI action {body.action!r}") from e
        except MissingTemplateVariables as e:
            # 400, not 500: the caller's variables don't cover the template — a
            # wiring/sample bug the author must see named, never a blank prompt.
            raise HTTPException(status_code=400, detail=f"{body.action}: {e}") from e
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
        # Same promptless rule as /run: body-supplied templates stand in for the
        # missing spec (the §7.4 stream-first transport must work promptless too).
        if spec is None and (body.system is None or body.userTemplate is None):
            raise HTTPException(status_code=404, detail=f"unknown AI action {body.action!r}")
        feature_key = spec.feature if spec else body.action
        sys_tpl = (spec.system if spec else "") if body.system is None else body.system
        usr_tpl = (spec.user_template if spec else "") if body.userTemplate is None else body.userTemplate
        try:
            # Rendered BEFORE the stream starts, so a variables gap is a clean
            # HTTP 400 naming the keys — not an in-stream error frame.
            system, user_text = _render_pair(sys_tpl, usr_tpl, body.variables)
        except MissingTemplateVariables as e:
            raise HTTPException(status_code=400, detail=f"{body.action}: {e}") from e
        messages = _history_messages(body.history) + [LLMMessage(role="user", content=user_text)]
        preset = resolve_feature_preset(body.action)
        provider_override = body.providerId or (preset.providerId if preset else "") or None
        model_override = body.model or (preset.model if preset else "") or None
        # Every tunable comes from the resolved PRESET (the one source, 2026-07-15);
        # request-body values override ephemerally. No preset → provider-default route.
        temperature = body.temperature if body.temperature is not None else (preset.temperature if preset else None)
        max_tokens = (body.maxTokens if body.maxTokens is not None else (preset.maxTokens if preset else 0)) or None

        # QC-43b: ensure a bundled-runner model is resident BEFORE streaming (else the
        # adapter hits a down router → "Connection refused"). Awaited here in the async
        # handler; any failure is captured and re-emitted as the stream's OWN SSE error
        # frame below (never a pre-stream 500, matching how stream_chat errors surface).
        ensure_error: str | None = None
        try:
            await _ensure_local_ready(
                get_config(), feature_key, body.action, provider_override, model_override,
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
                    feature=feature_key,
                    action=body.action,
                    messages=messages,
                    system=system,
                    temperature=temperature,
                    think=_effective_think(spec, body, preset),
                    max_tokens=max_tokens,
                    provider_override=provider_override,
                    model_override=model_override,
                    extra=_plane2_extra(spec, body, preset),
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
    async def resolved_route(
        feature: str, action: str = "", providerId: str = "", model: str = "",
    ) -> ResolvedRouteResponse:
        """The provider+model a run of this feature/action would use right now
        (B5-1, §7.2): its preset (ref → default) as the override, then the dispatch
        resolution — mirrored via the run path's own functions, never re-derived.
        Optional `providerId`/`model` override params (mirror RunRequest) let a Lab
        column ask for ITS pinned route's reasoning cap."""
        key = action or feature
        # The same ref → default resolution the run path uses, plus which tier won.
        preset, preset_source = resolve_feature_preset_with_source(key)
        base = dict(
            feature=feature, action=action,
            presetId=preset.id if preset else "",
            presetName=preset.name if preset else "",
            presetSource=preset_source,
        )
        # A Lab column's route override wins over the preset's (cap-hint pick).
        provider_override = providerId or (preset.providerId if preset else "") or None
        model_override = model or (preset.model if preset else "") or None
        try:
            adapter, model, _tier = resolve_route(
                get_config(), feature, action=key,
                provider_override=provider_override,
                model_override=model_override,
            )
        except LLMNotConfiguredError as e:
            return ResolvedRouteResponse(**base, configured=False, detail=str(e))
        # U2-T6: the SAME resolver the run path uses (the dispatch mirror), so the chip
        # shows exactly what a run emits — think/level/word + the layered budget value +
        # its origin layer, no client math. The capability gate mirrors here too
        # (approved 2026-08-06): want-on + model-can't-think serves think=False with
        # thinkInactive=True so the chip/Lab annotate instead of lying either way.
        from .capability import model_thinks
        from .reasoning import resolve_reasoning
        want = preset.think if preset else False
        gated = bool(want) and model_thinks(model) is False
        rp = resolve_reasoning(
            think=bool(want) and not gated,
            level=(preset.reasoningEffort if preset else ""),
            provider_id=adapter.provider_id, provider_type=adapter.provider_type, model_id=model,
        )
        return ResolvedRouteResponse(
            **base, providerId=adapter.provider_id, model=model,
            think=rp.think, level=rp.level, reasoningWord=rp.word,
            value=rp.value, valueSource=rp.source, thinkInactive=gated,
        )

    return router
