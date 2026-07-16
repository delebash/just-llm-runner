# SPDX-License-Identifier: GPL-3.0-or-later
"""Feature → provider dispatch.

Every app feature (Compose, Speaker-attribution, Critique, …) resolves
to a provider+model through `resolve_pin` and runs via `chat`. Lifted
from JustVoice `server/justvoice/engines/llm/dispatch.py` into the shared
`llm_runner` package (2026-06-21 AI-stack convergence).

Dispatch reads an `LLMConfig` (this package's schema), built by the shared
`config_builder` from the shared stores. The precedence chain:
    1. active production config
    2. feature pin with explicit provider/model
    3. preferred local runner (config.prefer_local_features)
    4. first registered adapter (fallback)
"""

from __future__ import annotations

import logging
import time
from typing import Callable, Iterable, Iterator

from .base import LLMAdapter, LLMMessage, LLMResponse, StreamDelta
from .registry import LLMRegistry, get_llm_registry
from .schema import LLMConfig
from .tiers import TierSpec, spec_for
from .usage import UsageEntry, get_ledger

log = logging.getLogger(__name__)


# ── optional host-injected ensure-local hook (QC-43b) ───────────────────────
# A run that resolves to the BUILT-IN runner provider makes its model resident
# before dispatch, so the first local call doesn't die with "Connection refused"
# when the router/model isn't up yet (the chat/feature twin of the embeddings
# ensure). The llm/ package must NOT import runner/ (they are decoupled — install.py
# is the one coupling point), so this is an INJECTED CALLABLE wired at boot exactly
# like the usage sink (set_ledger): install.py points it at
# RunnerService.ensure_model_ready. None (standalone / non-runner host) → the ensure
# is skipped and dispatch behaves exactly as before.
_ensure_local_model: Callable[[str], None] | None = None


def set_ensure_local_model(fn: Callable[[str], None] | None) -> None:
    """Host wiring at boot: the callable that makes a local-runner model resident
    (blocking until loaded) before a dispatch routed to the bundled runner. Pass None
    to unset. Mirrors `set_ledger` — a module-level seam, no runner import here."""
    global _ensure_local_model
    _ensure_local_model = fn


def get_ensure_local_model() -> Callable[[str], None] | None:
    """The configured ensure-local hook, or None when no host wired one."""
    return _ensure_local_model


class LLMNotConfiguredError(RuntimeError):
    """Raised when a feature is invoked but no provider is pinned (or
    the pinned provider isn't registered). The API layer maps this to
    HTTP 501 so the UI can show the actionable "wire an LLM provider"
    message rather than a generic 500."""


def _reg(registry: LLMRegistry | None) -> LLMRegistry:
    return registry or get_llm_registry()


def active_production_config(config: LLMConfig, feature: str):
    """The frozen Lab config for a feature, or None. Precedence step 1."""
    configs = config.production_configs or []
    return next((c for c in configs if c.feature == feature), None)


def _resolve_action_override(
    config: LLMConfig, action: str, reg: LLMRegistry
) -> tuple[LLMAdapter, str, str | None] | None:
    """Resolve an ACTION's own explicit config (its production config or pin), or
    None to fall back to its feature. Deliberately stops at the action's explicit
    config: it never touches the generic feature fallbacks (job / prefer-local /
    first-adapter) — those belong to the feature, so an action with nothing of its
    own inherits the feature default (then its job, then the global default)."""
    cfg = active_production_config(config, action)
    if cfg is not None:
        adapter = reg.get(cfg.providerId)
        if adapter is not None:
            return adapter, cfg.model or adapter.default_model, cfg.tier
    pin = next((p for p in (config.feature_pins or []) if p.feature == action), None)
    if pin is not None and pin.providerId:
        adapter = reg.get(pin.providerId)
        if adapter is not None:
            return adapter, pin.model or adapter.default_model, pin.tier
    return None


def resolve_pin(
    config: LLMConfig,
    feature: str,
    registry: LLMRegistry | None = None,
    action: str | None = None,
) -> tuple[LLMAdapter, str, str | None]:
    """Resolve the (provider, model, tier) tuple for a feature key.

    When `action` is given (a specific action within the feature, e.g.
    "writerAI.tighten"), the action's OWN explicit config wins; if the action has
    nothing of its own it falls back to the feature — so the cascade is
    action → feature → job → first. `action=None` is pure feature-level resolution.

    Raises LLMNotConfiguredError when nothing resolves.
    """
    reg = _reg(registry)

    # Action-level override (most specific) — falls through to the feature below.
    if action and action != feature:
        hit = _resolve_action_override(config, action, reg)
        if hit is not None:
            return hit

    cfg = active_production_config(config, feature)
    if cfg is not None:
        adapter = reg.get(cfg.providerId)
        if adapter is not None:
            return adapter, cfg.model or adapter.default_model, cfg.tier
        log.warning(
            "production config %r for %s names unregistered provider %s — falling through",
            cfg.name, feature, cfg.providerId,
        )

    pin = next((p for p in (config.feature_pins or []) if p.feature == feature), None)

    # Explicit per-feature pin (provider+model).
    if pin is not None and pin.providerId:
        adapter = reg.get(pin.providerId)
        if adapter is None:
            raise LLMNotConfiguredError(
                f"Feature {feature!r} is pinned to provider {pin.providerId!r} "
                f"but that provider isn't registered."
            )
        return adapter, pin.model or adapter.default_model, pin.tier

    # Built-in local runner is the smart default for its target features
    # (e.g. attribution) when nothing more specific is configured.
    if feature in config.prefer_local_features:
        local = reg.get(config.local_runner_provider_id)
        if local is not None:
            return local, local.default_model, None

    # Nothing routed yet — fall back to the first registered LLM if any.
    adapters = reg.all()
    if not adapters:
        raise LLMNotConfiguredError(
            f"No LLM provider registered. Add one in the AI engines tab, "
            f"then route '{feature}' to a job (or pin it) in feature routing."
        )
    adapter = adapters[0]
    return adapter, adapter.default_model, None


def resolve_tier(
    config: LLMConfig, feature: str, registry: LLMRegistry | None = None
) -> TierSpec:
    """Combine pin-resolution + tier auto-classify into one call."""
    _adapter, model, tier_override = resolve_pin(config, feature, registry)
    return spec_for(model, tier_override)


def resolve_route(
    config: LLMConfig,
    feature: str,
    registry: LLMRegistry | None = None,
    action: str | None = None,
    provider_override: str | None = None,
    model_override: str | None = None,
) -> tuple[LLMAdapter, str, str | None]:
    """The full per-call (provider, model, tier) resolution `chat`/`stream_chat`
    run: `resolve_pin` for the feature/action, then the explicit overrides — a
    preset's provider/model, or a Lab column's — applied over it. A provider
    override with no model override lands on that provider's default model; a
    model override always re-derives the tier from the override. Raises
    LLMNotConfiguredError on an unregistered override provider or when nothing
    resolves to a model (the catalog-full / selections-empty factory state).

    This is also what GET /v1/ai/resolved-route reports, so the read-only
    "runs on" provenance chips display exactly what a run would do (§7.2)."""
    reg = _reg(registry)
    adapter, model, tier_override = resolve_pin(config, feature, reg, action=action)
    if provider_override:
        other = reg.get(provider_override)
        if other is None:
            raise LLMNotConfiguredError(f"Provider {provider_override!r} isn't registered.")
        adapter = other
        if not model_override:
            model = other.default_model
            tier_override = None
    if model_override:
        model = model_override
        tier_override = None
    if not (model or "").strip():
        # Catalog-full / selections-empty factory state (user, 2026-07-06): nothing
        # is chosen by the seed, so a fresh box reaching an AI feature before setup
        # gets guidance, not a raw provider error.
        raise LLMNotConfiguredError(
            "No model is set. Run Quick Setup (Settings → AI) to pick one for this "
            "machine, or choose a model in the catalog (Set as default)."
        )
    return adapter, model, tier_override


def _apply_reasoning(extra: dict | None, adapter: LLMAdapter, model: str, *, think: bool) -> dict | None:
    """Map the reasoning ASK (the raw level carried in `reasoning_effort`, injected by
    `prompts._plane2_extra`) into what the RESOLVED provider/model actually emits (U2-T3)
    — this is the ONE place the resolved model is finally known. Replaces the level with
    the resolved effort `word` + the `reasoning_budget_tokens` (LOCAL: the layered switch
    value, no clamp; number-speaking cloud: the map tokens); each adapter pops BOTH
    (`base.pop_reasoning`) and emits only the one its backend speaks. No-op unless
    reasoning is on for this call (the level is present only when `_effective_think`)."""
    if not extra or "reasoning_effort" not in extra:
        return extra
    level = extra.get("reasoning_effort") or ""
    e = dict(extra)
    e.pop("reasoning_effort", None)
    if not think or not level:
        return e or None
    from .reasoning import resolve_reasoning
    plan = resolve_reasoning(
        think=think, level=level, provider_id=adapter.provider_id,
        provider_type=adapter.provider_type, model_id=model,
    )
    if plan.word:
        e["reasoning_effort"] = plan.word
    if plan.value is not None:
        e["reasoning_budget_tokens"] = plan.value
    return e or None


def chat(
    *,
    config: LLMConfig,
    feature: str,
    messages: Iterable[LLMMessage],
    system: str | None = None,
    temperature: float | None = 0.7,
    max_tokens: int | None = None,
    think: bool | None = None,
    model_override: str | None = None,
    provider_override: str | None = None,
    registry: LLMRegistry | None = None,
    action: str | None = None,
    extra: dict | None = None,
) -> LLMResponse:
    """One-shot LLM call for a feature key.

    `action` (optional) routes to the action's own model when it has one, else the
    feature default (the per-action override cascade). `think` defaults to the
    resolved tier's `think` flag so reasoned-tier models on Ollama emit reasoning
    blocks without the caller knowing the tier. Pass an explicit bool to override
    (e.g. a Lab column forcing `think: false` to compare reasoned vs direct).
    """
    adapter, model, tier_override = resolve_route(
        config, feature, registry, action=action,
        provider_override=provider_override, model_override=model_override,
    )
    tier = spec_for(model, tier_override)
    eff_think = tier.think if think is None else think
    extra = _apply_reasoning(extra, adapter, model, think=eff_think)

    started = time.monotonic()
    try:
        resp = adapter.chat(
            list(messages),
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
            system=system,
            think=eff_think,
            extra=extra,
        )
    except Exception as e:
        get_ledger().record(
            UsageEntry(
                feature=feature, model=model, prompt_tokens=0, completion_tokens=0,
                duration_ms=int((time.monotonic() - started) * 1000),
                ok=False, error=str(e)[:200], provider_id=adapter.provider_id,
            )
        )
        raise
    get_ledger().record(
        UsageEntry(
            feature=feature, model=resp.model or model,
            prompt_tokens=resp.prompt_tokens, completion_tokens=resp.completion_tokens,
            duration_ms=int((time.monotonic() - started) * 1000),
            ok=True, provider_id=adapter.provider_id,
        )
    )
    return resp


def stream_chat(
    *,
    config: LLMConfig,
    feature: str,
    messages: Iterable[LLMMessage],
    system: str | None = None,
    temperature: float | None = 0.7,
    max_tokens: int | None = None,
    think: bool | None = None,
    model_override: str | None = None,
    provider_override: str | None = None,
    registry: LLMRegistry | None = None,
    action: str | None = None,
    extra: dict | None = None,
) -> Iterator[StreamDelta]:
    """Streaming counterpart to `chat`. Resolves the feature's provider (same
    precedence + Lab overrides as `chat`, incl. the optional `action` override),
    yields `StreamDelta` events (text deltas, then one `done` event), and records
    usage to the ledger at the end (from the `done` event's token counts)."""
    adapter, model, tier_override = resolve_route(
        config, feature, registry, action=action,
        provider_override=provider_override, model_override=model_override,
    )
    tier = spec_for(model, tier_override)
    eff_think = tier.think if think is None else think
    extra = _apply_reasoning(extra, adapter, model, think=eff_think)

    started = time.monotonic()
    pt = ct = 0
    try:
        for delta in adapter.stream_chat(
            list(messages),
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
            system=system,
            think=eff_think,
            extra=extra,
        ):
            if delta.done:
                pt, ct = delta.prompt_tokens, delta.completion_tokens
                # Stamp the RESOLVED model on the done event (adapters leave it
                # empty) so the SSE done frame can report model + cost (§7.4 —
                # the stream path carries everything /run's response carries).
                delta.model = model
            yield delta
    except Exception as e:
        get_ledger().record(
            UsageEntry(
                feature=feature, model=model, prompt_tokens=0, completion_tokens=0,
                duration_ms=int((time.monotonic() - started) * 1000),
                ok=False, error=str(e)[:200], provider_id=adapter.provider_id,
            )
        )
        raise
    get_ledger().record(
        UsageEntry(
            feature=feature, model=model, prompt_tokens=pt, completion_tokens=ct,
            duration_ms=int((time.monotonic() - started) * 1000),
            ok=True, provider_id=adapter.provider_id,
        )
    )
