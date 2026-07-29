# SPDX-License-Identifier: MIT
"""Shared LLM provider/dispatch layer for JustVoice + JustWrite.

The whole AI backend spine — provider adapters (cloud + local), a
registry, tier classification, a usage ledger, and feature dispatch with
the precedence chain production-config → pin → prefer-local → first. Hosts build an
`LLMConfig` from their own settings and call `dispatch.chat(config=..., feature=...)`.

Lifted from JustVoice's `engines/llm/*` (2026-06-21 AI-stack convergence)
so both apps run the SAME code instead of per-app forks.
"""

from __future__ import annotations

from . import dispatch, registry, tiers
from .base import LLMAdapter, LLMMessage, LLMResponse, StreamDelta
from .dispatch import (
    LLMNotConfiguredError,
    active_production_config,
    chat,
    resolve_pin,
    resolve_tier,
    stream_chat,
)
from .prompts import (
    FeaturePromptRow,
    PromptStore,
    make_feature_router,
    make_prompt_router,
    render,
)
from .registry import (
    LLMRegistry,
    construct,
    get_llm_registry,
    load_from_configs,
)
from .model_catalog_api import (
    CatalogResponse,
    CatalogRow,
    ModelCatalogStore,
    make_catalog_router,
)
from .routing_api import (
    FeatureCatalogEntry,
    RoutingConfig,
    RoutingDefaults,
    RoutingStore,
    make_routing_router,
)
from .schema import (
    FeaturePinConfig,
    LLMConfig,
    LLMProviderConfig,
    ProductionConfig,
)
from .tiers import TIERS, TierSpec, classify, spec_for
from .usage import UsageEntry, UsageLedger, UsageSink, get_ledger, set_ledger
from . import stores
from .config_builder import build_llm_config
from .db import LlmBase, configure_storage, create_all, session
from .install import install_llm
from .seed import configure_app_seed, seed_llm

__all__ = [
    # contract
    "LLMAdapter", "LLMMessage", "LLMResponse", "StreamDelta",
    # schema
    "LLMConfig", "LLMProviderConfig", "FeaturePinConfig",
    "ProductionConfig",
    # registry
    "LLMRegistry", "get_llm_registry", "construct", "load_from_configs",
    # dispatch
    "chat", "stream_chat", "resolve_pin", "resolve_tier", "active_production_config",
    "LLMNotConfiguredError",
    # prompts (per-feature prompt store contract + render + router factories)
    "FeaturePromptRow", "PromptStore", "render",
    "make_prompt_router", "make_feature_router",
    # routing (the global default LLM/embedding, behind a host store)
    "RoutingStore", "RoutingConfig", "RoutingDefaults",
    "FeatureCatalogEntry", "make_routing_router",
    # model catalog (the DB-backed downloadable-model source of truth)
    "CatalogRow", "CatalogResponse", "ModelCatalogStore", "make_catalog_router",
    # tiers
    "TIERS", "TierSpec", "classify", "spec_for",
    # usage
    "UsageEntry", "UsageLedger", "UsageSink", "get_ledger", "set_ledger",
    # shared storage + drop-in install (the whole LLM stack, one call)
    "LlmBase", "configure_storage", "create_all", "session",
    "build_llm_config", "configure_app_seed", "seed_llm", "install_llm",
    # submodules
    "dispatch", "registry", "tiers", "stores",
]
