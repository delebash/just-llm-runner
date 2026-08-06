# SPDX-License-Identifier: MIT
"""Shared LLM provider/dispatch layer for JustVoice + JustWrite.

The whole AI backend spine — provider adapters (cloud + local), a
registry, tier classification, a usage ledger, and feature dispatch with
the precedence chain production-config → pin → prefer-local → first. Hosts build an
`LLMConfig` from their own settings and call `dispatch.chat(config=..., feature=...)`.

Lifted from JustVoice's `engines/llm/*` (2026-06-21 AI-stack convergence)
so both apps run the SAME code instead of per-app forks.

WHY EVERY EXPORT IS LAZY (2026-08-01). This module used to import all of the above
EAGERLY, and line 3 of that block was `from .db import ...`. `db.py` is the only file in
this package that touches SQLAlchemy, but because the package `__init__` pulled it in on
the way to everything else, ONE missing dependency made the ENTIRE package unimportable —
adapters, dispatch, registry, tiers and schema included, none of which touch storage. A
clean-venv audit measured it: `import llm_runner.llm.anthropic` died with
`ModuleNotFoundError: No module named 'sqlalchemy'`.

The dependency is now declared (see `pyproject.toml`), so that specific failure is fixed at
the root. The laziness is the SECOND half, and it is what makes the storage-free core
genuinely usable: an app that only wants the runner + the cloud adapters no longer imports
the ORM, the table definitions or the seeder to get them. It also keeps the boot cost off
the path that does not ask for it — the same argument `_lazy.py` records for the vendor SDKs,
where deferring three module imports removed 2,088 ms of a 4,100 ms cold start.

Every name in `__all__` still resolves exactly as before — `from llm_runner.llm import
install_llm` works unchanged — it just imports its module on first access instead of at
package import. A name is cached into globals() once resolved, so it costs one dict lookup
thereafter. `scripts/check-clean-install.py` asserts the storage-free subset stays importable
with SQLAlchemy absent, so this cannot silently regress into an eager import again.

NO `if TYPE_CHECKING:` MIRROR, deliberately. The obvious way to keep IDEs happy is a guarded
block re-importing all ~50 names — but that is a hand-maintained SECOND copy of `_EXPORTS`
that nothing forces to agree with it, which is the same one-fact-two-places defect the
2026-08-01 audit spent its day on. `_EXPORTS` is the single source; `__all__` is generated
from it and `__dir__` reports it. No type checker is configured in this repo for such a
block to serve.
"""

from __future__ import annotations

import importlib

# Submodules re-exported as attributes (`llm_runner.llm.dispatch`, …). Importing a submodule
# binds it on the parent package itself, so these need no globals() caching.
_SUBMODULES = ("dispatch", "registry", "tiers", "stores")

# name → the module inside this package that defines it. This map IS the public surface;
# `__all__` below is generated from it so the two can never drift.
_EXPORTS = {
    # contract
    "LLMAdapter": "base", "LLMMessage": "base", "LLMResponse": "base", "StreamDelta": "base",
    # schema
    "LLMConfig": "schema", "LLMProviderConfig": "schema", "FeaturePinConfig": "schema",
    "ProductionConfig": "schema",
    # registry
    "LLMRegistry": "registry", "get_llm_registry": "registry", "construct": "registry",
    "load_from_configs": "registry",
    # dispatch
    "chat": "dispatch", "stream_chat": "dispatch", "resolve_pin": "dispatch",
    "resolve_tier": "dispatch", "active_production_config": "dispatch",
    "LLMNotConfiguredError": "dispatch", "set_not_configured_message": "dispatch",
    # prompts (per-feature prompt store contract + render + router factories +
    # run_action — THE non-stream run path the route and in-server callers share)
    "FeaturePromptRow": "prompts", "PromptStore": "prompts", "render": "prompts",
    "MissingTemplateVariables": "prompts",
    "run_action": "prompts", "UnknownActionError": "prompts", "RunRequest": "prompts",
    "make_prompt_router": "prompts", "make_feature_router": "prompts",
    # routing (the global default LLM/embedding, behind a host store)
    "RoutingStore": "routing_api", "RoutingConfig": "routing_api",
    "RoutingDefaults": "routing_api", "FeatureCatalogEntry": "routing_api",
    "make_routing_router": "routing_api",
    # model catalog (the DB-backed downloadable-model source of truth)
    "CatalogRow": "model_catalog_api", "CatalogResponse": "model_catalog_api",
    "ModelCatalogStore": "model_catalog_api", "make_catalog_router": "model_catalog_api",
    # tiers
    "TIERS": "tiers", "TierSpec": "tiers", "classify": "tiers", "spec_for": "tiers",
    # usage
    "UsageEntry": "usage", "UsageLedger": "usage", "UsageSink": "usage",
    "get_ledger": "usage", "set_ledger": "usage",
    # shared storage + drop-in install (the whole LLM stack, one call). These are the
    # SQLAlchemy-backed half — reaching for any of them imports the ORM, by design.
    "LlmBase": "db", "configure_storage": "db", "create_all": "db", "session": "db",
    "build_llm_config": "config_builder",
    "configure_app_seed": "seed", "seed_llm": "seed",
    "install_llm": "install",
}

__all__ = [*sorted(_EXPORTS), *_SUBMODULES]


def __getattr__(name: str):
    """PEP 562 — resolve an export to its module on first access, then cache it."""
    if name in _SUBMODULES:
        return importlib.import_module(f".{name}", __name__)
    module = _EXPORTS.get(name)
    if module is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    value = getattr(importlib.import_module(f".{module}", __name__), name)
    globals()[name] = value  # subsequent lookups skip __getattr__ entirely
    return value


def __dir__() -> list[str]:
    return sorted(__all__)
