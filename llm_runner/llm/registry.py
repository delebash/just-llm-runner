# SPDX-License-Identifier: GPL-3.0-or-later
"""LLM provider registry.

A singleton LLMRegistry holds the live adapter instances keyed by
provider id. `construct(cfg)` picks the right adapter class for the
`provider_type` discriminator. A host wires this at boot via
`load_from_configs(settings.engines.llm)`.

Lifted from JustVoice `server/justvoice/engines/llm/registry.py` into the
shared `llm_runner` package (2026-06-21 AI-stack convergence); the only
change is decoupling from JustVoice's settings object — `construct` takes
an `LLMProviderConfig` from this package's schema, and the boot helper is
`load_from_configs(list[LLMProviderConfig])` rather than a JV-settings walk.
"""

from __future__ import annotations

import logging
import threading
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .base import LLMAdapter
    from .schema import LLMProviderConfig

log = logging.getLogger(__name__)


class LLMRegistry:
    """Holds registered LLM provider adapters keyed by provider id."""

    def __init__(self):
        self._adapters: dict[str, "LLMAdapter"] = {}
        self._lock = threading.RLock()

    def register(self, adapter: "LLMAdapter") -> None:
        with self._lock:
            self._adapters[adapter.provider_id] = adapter
            log.info(
                "LLM provider registered: id=%s type=%s default_model=%s",
                adapter.provider_id,
                adapter.provider_type,
                adapter.default_model,
            )

    def deregister(self, provider_id: str) -> None:
        with self._lock:
            self._adapters.pop(provider_id, None)

    def get(self, provider_id: str) -> "LLMAdapter | None":
        with self._lock:
            return self._adapters.get(provider_id)

    def all(self) -> list["LLMAdapter"]:
        with self._lock:
            return list(self._adapters.values())

    def ids(self) -> list[str]:
        with self._lock:
            return list(self._adapters.keys())


_REGISTRY = LLMRegistry()


def get_llm_registry() -> LLMRegistry:
    return _REGISTRY


def construct(cfg: "LLMProviderConfig") -> "LLMAdapter":
    """Pick the right adapter class for the provider_type discriminator.

    Unknown provider types raise ValueError — callers should catch and
    log so a misconfigured settings entry doesn't kill boot.
    """
    pt = cfg.providerType.lower()
    if pt == "anthropic":
        from .anthropic import AnthropicAdapter

        return AnthropicAdapter(
            cfg.id,
            api_key=cfg.apiKey or "",
            base_url=cfg.baseUrl,
            default_model=cfg.defaultModel,
            timeout_seconds=cfg.timeoutSeconds,
        )
    if pt in ("openai-compat", "local-llamacpp"):
        from .openai_compat import OpenAICompatAdapter

        return OpenAICompatAdapter(
            cfg.id,
            provider_type=pt,
            api_key=cfg.apiKey or "",
            base_url=cfg.baseUrl,
            default_model=cfg.defaultModel,
            timeout_seconds=cfg.timeoutSeconds,
        )
    if pt in ("openai", "deepseek", "openrouter", "xai", "mistral"):
        # The official openai SDK adapter (#15 C4): openai → Responses API; the rest →
        # chat-completions at each vendor's base_url (D3/D4).
        from .openai_sdk import OpenAISDKAdapter

        return OpenAISDKAdapter(
            cfg.id,
            provider_type=pt,
            api_key=cfg.apiKey or "",
            base_url=cfg.baseUrl,
            default_model=cfg.defaultModel,
            timeout_seconds=cfg.timeoutSeconds,
        )
    if pt == "ollama":
        from .ollama import OllamaAdapter

        return OllamaAdapter(
            cfg.id,
            api_key=cfg.apiKey or "",
            base_url=cfg.baseUrl,
            default_model=cfg.defaultModel,
            timeout_seconds=cfg.timeoutSeconds,
        )
    if pt == "gemini":
        from .gemini import GeminiAdapter

        return GeminiAdapter(
            cfg.id,
            api_key=cfg.apiKey or "",
            base_url=cfg.baseUrl,
            default_model=cfg.defaultModel,
            timeout_seconds=cfg.timeoutSeconds,
        )
    raise ValueError(f"unknown LLM providerType: {pt!r}")


def load_from_configs(configs, registry: "LLMRegistry | None" = None) -> None:
    """Boot helper. Constructs an adapter for each provider config and
    registers it. Silently logs adapter-construction failures rather than
    failing the whole boot — a single bad provider config shouldn't block
    the app from starting."""
    reg = registry or get_llm_registry()
    for cfg in configs:
        try:
            reg.register(construct(cfg))
        except Exception as e:
            log.warning("LLM provider %s skipped at boot: %s", getattr(cfg, "id", "?"), e)
