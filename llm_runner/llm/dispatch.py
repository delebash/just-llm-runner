# SPDX-License-Identifier: GPL-3.0-or-later
"""Feature → provider dispatch.

Every app feature (Compose, Speaker-attribution, Critique, …) resolves
to a provider+model through `resolve_pin` and runs via `chat`. Lifted
from JustVoice `server/justvoice/engines/llm/dispatch.py` into the shared
`llm_runner` package (2026-06-21 AI-stack convergence).

The ONE change from JV: dispatch no longer reads a JustVoice `settings`
object. It takes an `LLMConfig` (this package's schema) so both apps feed
it from their own settings. The precedence chain is unchanged:
    1. active production config
    2. feature pin with explicit provider/model
    3. feature pin inheriting a role ("quick"/"accuracy")
    4. the feature's default role (config.default_feature_roles) → llm_roles
    5. preferred local runner (config.prefer_local_features)
    6. first registered adapter (legacy fallback)
"""

from __future__ import annotations

import logging
import time
from typing import Iterable

from .base import LLMAdapter, LLMMessage, LLMResponse
from .registry import LLMRegistry, get_llm_registry
from .schema import LLMConfig
from .tiers import TierSpec, spec_for
from .usage import UsageEntry, get_ledger

log = logging.getLogger(__name__)


class LLMNotConfiguredError(RuntimeError):
    """Raised when a feature is invoked but no provider is pinned (or
    the pinned provider isn't registered). The API layer maps this to
    HTTP 501 so the UI can show the actionable "wire an LLM provider"
    message rather than a generic 500."""


def _reg(registry: LLMRegistry | None) -> LLMRegistry:
    return registry or get_llm_registry()


def _resolve_role(
    config: LLMConfig, role: str, registry: LLMRegistry | None = None
) -> tuple[LLMAdapter, str] | None:
    """Map a role name to (adapter, model) via config.llm_roles."""
    roles = config.llm_roles
    target = getattr(roles, role, None) if roles else None
    if target is None or not target.providerId:
        return None
    adapter = _reg(registry).get(target.providerId)
    if adapter is None:
        return None
    return adapter, target.model or adapter.default_model


def active_production_config(config: LLMConfig, feature: str):
    """The frozen Lab config for a feature, or None. Precedence step 1."""
    configs = config.production_configs or []
    return next((c for c in configs if c.feature == feature), None)


def resolve_pin(
    config: LLMConfig, feature: str, registry: LLMRegistry | None = None
) -> tuple[LLMAdapter, str, str | None]:
    """Resolve the (provider, model, tier) tuple for a feature key.

    Raises LLMNotConfiguredError when nothing resolves.
    """
    reg = _reg(registry)

    cfg = active_production_config(config, feature)
    if cfg is not None:
        adapter = reg.get(cfg.providerId)
        if adapter is not None:
            return adapter, cfg.model or adapter.default_model, cfg.tier
        log.warning(
            "production config %r for %s names unregistered provider %s — falling through",
            cfg.name, feature, cfg.providerId,
        )

    feature_pins = config.feature_pins or []
    pin = next((p for p in feature_pins if p.feature == feature), None)

    if pin is not None and not pin.providerId and pin.role:
        resolved = _resolve_role(config, pin.role, reg)
        if resolved is not None:
            return resolved[0], resolved[1], pin.tier

    if pin is None or not pin.providerId:
        # Role-default path: the feature's factory role, if configured.
        default_role = config.default_feature_roles.get(feature)
        if default_role:
            resolved = _resolve_role(config, default_role, reg)
            if resolved is not None:
                return resolved[0], resolved[1], None
        # Built-in local runner is the smart default for its target features
        # (e.g. attribution) when nothing more specific is configured.
        if feature in config.prefer_local_features:
            local = reg.get(config.local_runner_provider_id)
            if local is not None:
                return local, local.default_model, None
        # No pin set yet — fall back to the first registered LLM if any.
        adapters = reg.all()
        if not adapters:
            raise LLMNotConfiguredError(
                f"No LLM provider registered. Add one in the AI engines tab, "
                f"then pin it to '{feature}' in feature routing."
            )
        adapter = adapters[0]
        return adapter, adapter.default_model, None

    adapter = reg.get(pin.providerId)
    if adapter is None:
        raise LLMNotConfiguredError(
            f"Feature {feature!r} is pinned to provider {pin.providerId!r} "
            f"but that provider isn't registered."
        )
    return adapter, pin.model or adapter.default_model, pin.tier


def resolve_tier(
    config: LLMConfig, feature: str, registry: LLMRegistry | None = None
) -> TierSpec:
    """Combine pin-resolution + tier auto-classify into one call."""
    _adapter, model, tier_override = resolve_pin(config, feature, registry)
    return spec_for(model, tier_override)


def chat(
    *,
    config: LLMConfig,
    feature: str,
    messages: Iterable[LLMMessage],
    system: str | None = None,
    temperature: float = 0.7,
    max_tokens: int | None = None,
    think: bool | None = None,
    model_override: str | None = None,
    provider_override: str | None = None,
    registry: LLMRegistry | None = None,
) -> LLMResponse:
    """One-shot LLM call for a feature key.

    `think` defaults to the resolved tier's `think` flag so reasoned-tier
    models on Ollama emit reasoning blocks without the caller knowing the
    tier. Pass an explicit bool to override (e.g. a Lab column forcing
    `think: false` to compare reasoned vs direct on the same model).
    """
    reg = _reg(registry)
    adapter, model, tier_override = resolve_pin(config, feature, reg)
    if provider_override:
        # Lab column override — route this call through a specific
        # registered provider instead of the feature's resolved route.
        other = reg.get(provider_override)
        if other is None:
            raise LLMNotConfiguredError(
                f"Provider {provider_override!r} isn't registered."
            )
        adapter = other
        if not model_override:
            model = other.default_model
            tier_override = None
    if model_override:
        # Lab column override — same provider, different model. The tier
        # re-derives from the OVERRIDE (a qwen3:14b column goes Reasoned
        # even when the pin's default model is Guided-class).
        model = model_override
        tier_override = None
    tier = spec_for(model, tier_override)

    started = time.monotonic()
    try:
        resp = adapter.chat(
            list(messages),
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
            system=system,
            think=tier.think if think is None else think,
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
