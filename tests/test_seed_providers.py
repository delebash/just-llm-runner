# SPDX-License-Identifier: GPL-3.0-or-later
"""Pin the seeded DEFAULT_PROVIDERS to their NATIVE provider types (#15 C1, the
2026-07-17 SDK pivot). Official SDK adapters back claude/gemini/ollama now, so the
seed rows carry the real types + the SDK-native base URLs: no `/v1` on the native
clouds (Anthropic), no `/v1beta/openai` shim on Gemini, and the local Ollama row
loses `/v1` (the native adapter appends `/api/chat`; keeping `/v1` yields the broken
`…/v1/api/chat`). Also proves ProviderStore.remove CASCADES the provider's
reasoning-map rows — else a delete+re-add leaves the old alias's rows behind and
poisons the retyped provider.
"""

from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from llm_runner.llm import db, stores
from llm_runner.llm.schema import LLMProviderConfig
from llm_runner.llm.seed import DEFAULT_PROVIDERS

# The native-type end state — id -> (provider_type, base_url). One source: any seed
# drift breaks this pin.
_EXPECTED = {
    "local-llamacpp": ("local-llamacpp", "http://127.0.0.1:8080/v1"),
    "openai-compat-local": ("ollama", "http://localhost:11434"),
    # LM Studio rides the generic openai-compat adapter (2026-07-19) — seeded so it is
    # PRESENT out of the box like Ollama, not merely reachable via the preset chip.
    "lmstudio": ("openai-compat", "http://localhost:1234/v1"),
    "openai": ("openai", "https://api.openai.com/v1"),
    "claude": ("anthropic", "https://api.anthropic.com"),
    "gemini": ("gemini", "https://generativelanguage.googleapis.com"),
    "deepseek": ("deepseek", "https://api.deepseek.com/v1"),
    "openrouter": ("openrouter", "https://openrouter.ai/api/v1"),
    # xAI + Mistral join as dedicated SDK-chat-completions types (#15 C4, D4).
    "xai": ("xai", "https://api.x.ai/v1"),
    "mistral": ("mistral", "https://api.mistral.ai/v1"),
}


def test_default_providers_carry_native_types_and_urls():
    by_id = {p["id"]: p for p in DEFAULT_PROVIDERS}
    assert set(by_id) == set(_EXPECTED)
    for pid, (ptype, base_url) in _EXPECTED.items():
        assert by_id[pid]["provider_type"] == ptype, pid
        assert by_id[pid]["base_url"] == base_url, pid
    # the local row is renamed to its native adapter (Ollama).
    assert by_id["openai-compat-local"]["name"] == "Ollama (local)"


def test_remove_cascades_reasoning_map_rows():
    # StaticPool + one shared connection so every store session sees one in-memory DB.
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    db.configure_storage(sessionmaker(bind=engine, autocommit=False, autoflush=False))
    db.create_all(engine)

    store = stores.get_provider_store()
    store.add(LLMProviderConfig(
        id="tmp-anthropic", name="Tmp", providerType="anthropic",
        baseUrl="https://api.anthropic.com", local=False,
    ))
    # add() fills the type's five reasoning-map rows (fill-if-missing on create).
    rmap = stores.get_reasoning_map_store()
    assert len(rmap.for_provider("tmp-anthropic")) == 5

    store.remove("tmp-anthropic")
    # the map rows go with the provider — this FAILS on the pre-cascade remove().
    assert rmap.for_provider("tmp-anthropic") == []
