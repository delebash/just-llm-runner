# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared LLM config schema — the contract between host apps and the
dispatch layer.

These Pydantic models are lifted from JustVoice's `models.py` (the
LLM-provider / feature-pin / role / production-config shapes) so the
shared dispatch can resolve a feature → provider without importing any
app's settings object. Both JustVoice and JustWrite construct an
`LLMConfig` from their own settings and hand it to `dispatch`.

camelCase aliases (shared llm-ui contract): the models ACCEPT both
snake_case and camelCase on input via `populate_by_name`.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class LLMProviderConfig(BaseModel):
    """A registered LLM provider entry. `provider_type` discriminates
    which adapter (anthropic / openai / openai-compat / gemini / ollama /
    deepseek / openrouter / local-llamacpp) handles the dispatch."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    name: str = ""
    provider_type: str  # "anthropic" | "openai" | "openai-compat" | "gemini" | "ollama" | "deepseek" | "openrouter" | "local-llamacpp"
    base_url: str = ""
    api_key: str | None = None
    default_model: str = ""
    embedding_model: str = ""  # optional — provider doubles as the EMBED source
    timeout_seconds: int = 60
    extra: dict[str, str] = {}  # provider-specific extras (org id, region, etc.)


class FeaturePinConfig(BaseModel):
    """Which provider+model handles each LLM feature. Looked up at
    dispatch time by feature key."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    feature: str
    provider_id: str = ""
    model: str = ""
    tier: str | None = None  # "guided" | "direct" | "reasoned" — null = auto-classify
    # Inherit a model role instead of naming provider+model directly.
    # "quick" | "accuracy" | None. Explicit provider_id/model win over role.
    role: str | None = None


class LLMRoleTarget(BaseModel):
    """One half of the Quick/Accuracy pair."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    provider_id: str
    model: str = ""


class LLMRolesSettings(BaseModel):
    """The two plain-language model roles. Features inherit one of these
    unless pinned to something specific."""

    quick: LLMRoleTarget | None = None
    accuracy: LLMRoleTarget | None = None


class ProductionConfig(BaseModel):
    """A feature frozen exactly as tuned in its Lab — model AND prompts.
    The active config beats pins and roles (precedence step 1). One per
    feature; deleting it reverts the feature to Default (tier-resolved)."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    feature: str
    name: str
    provider_id: str
    model: str = ""
    tier: str | None = None
    temperature: float | None = None
    system_prompt: str | None = None
    user_prompt: str | None = None
    promoted_at: str | None = None  # ISO timestamp
    source: str = "lab"


@dataclass
class LLMConfig:
    """The dispatch-time view of an app's LLM configuration.

    Replaces the JustVoice-specific `settings.engines.*` coupling the old
    dispatch read directly. A host builds this from its own settings:

        LLMConfig(
            providers=settings.engines.llm,
            feature_pins=settings.engines.feature_pins,
            llm_roles=settings.engines.llm_roles,
            production_configs=settings.engines.production_configs,
            default_feature_roles=DEFAULT_FEATURE_ROLES,   # the app's catalog
            prefer_local_features={"speaker_attribution"}, # optional
        )

    `default_feature_roles` and `prefer_local_features` are per-app
    catalog data (which features exist, which default to quick/accuracy,
    which prefer the local runner) — the shared package ships no
    app-specific defaults.
    """

    providers: list[LLMProviderConfig] = field(default_factory=list)
    feature_pins: list[FeaturePinConfig] = field(default_factory=list)
    llm_roles: LLMRolesSettings | None = None
    production_configs: list[ProductionConfig] = field(default_factory=list)
    default_feature_roles: dict[str, str] = field(default_factory=dict)
    prefer_local_features: set[str] = field(default_factory=set)
    local_runner_provider_id: str = "local-llamacpp"
