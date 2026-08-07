# SPDX-License-Identifier: MIT
"""Shared LLM config schema — the contract between host apps and the
dispatch layer.

These Pydantic models are lifted from JustVoice's `models.py` (the
LLM-provider / feature-pin / production-config shapes) so the
shared dispatch can resolve a feature → provider without importing any
app's settings object. Both JustVoice and JustWrite construct an
`LLMConfig` from their own settings and hand it to `dispatch`.

camelCase-native (2026-06-21): the Python field names ARE camelCase, so
the attribute == the JSON key == the JS renderer key. There is exactly
ONE name per field — no snake_case aliases, no `populate_by_name`. This
is the deliberate cross-language-uniformity choice: the JS renderer and
JustWrite already carry camelCase data, so the wire matches them with no
aliasing shim. (`LLMConfig` below is internal plumbing — never serialized
— so it keeps snake field names.)
"""

from __future__ import annotations

from dataclasses import dataclass, field

from pydantic import BaseModel


class LLMProviderConfig(BaseModel):
    """A registered LLM provider entry. `providerType` discriminates
    which adapter (anthropic / openai / openai-compat / gemini / ollama /
    deepseek / openrouter / xai / mistral / local-llamacpp) handles the dispatch."""

    id: str
    name: str = ""
    providerType: str  # "anthropic" | "openai" | "openai-compat" | "gemini" | "ollama" | "deepseek" | "openrouter" | "xai" | "mistral" | "local-llamacpp"
    baseUrl: str = ""
    apiKey: str | None = None
    defaultModel: str = ""
    embeddingModel: str = ""  # optional — provider doubles as the EMBED source
    timeoutSeconds: int = 60
    # Runs on this machine (no key, no per-token cost) vs a metered cloud
    # account. The explicit Local/Online choice from the form — drives the
    # Local-vs-Cloud grouping in the UI; NOT inferred from the URL.
    local: bool = True
    extra: dict[str, str] = {}  # provider-specific extras (org id, region, etc.)


class FeaturePinConfig(BaseModel):
    """An explicit per-feature (or per-action) provider+model override, looked up
    at dispatch time by feature key. A feature with no pin (and no preset) falls
    through to the global default provider."""

    feature: str
    providerId: str = ""
    model: str = ""


class ProductionConfig(BaseModel):
    """A feature frozen exactly as tuned in its Lab — model AND prompts.
    The active config beats pins and roles (precedence step 1). One per
    feature; deleting it reverts the feature to Default (tier-resolved)."""

    feature: str
    name: str
    providerId: str
    model: str = ""
    temperature: float | None = None
    systemPrompt: str | None = None
    userPrompt: str | None = None
    promotedAt: str | None = None  # ISO timestamp
    source: str = "lab"


@dataclass
class LLMConfig:
    """The dispatch-time view of an app's LLM configuration.

    A host builds this from the shared stores (see `config_builder`):

        LLMConfig(
            providers=provider_store.list(),
            feature_pins=[...explicit pins...],
            prefer_local_features={"speaker_attribution"},  # optional, per-app
        )

    A feature resolves: active production config → explicit pin → prefer-local →
    first adapter. Engine presets (each action's preset ref → default) are resolved
    separately in `prompts._resolve_preset` and overlaid onto the call.
    """

    providers: list[LLMProviderConfig] = field(default_factory=list)
    feature_pins: list[FeaturePinConfig] = field(default_factory=list)
    production_configs: list[ProductionConfig] = field(default_factory=list)
    prefer_local_features: set[str] = field(default_factory=set)
    local_runner_provider_id: str = "local-llamacpp"
