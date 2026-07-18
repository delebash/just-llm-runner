# SPDX-License-Identifier: GPL-3.0-or-later
"""CRUD for the per-provider reasoning-level map (U2-T2, 2026-07-14). The level→value
table the ONE resolver (`llm/reasoning.py`) reads to turn a task's Low/Medium/High/
XHigh/Max "ask" into what each provider actually speaks. Generation-aware: each row
carries BOTH a `word` (effort-word adapters: OpenAI `reasoning_effort`, Ollama native
level, new-Anthropic `output_config.effort`) AND `tokens` (budget-number paths: the
local llama.cpp per-request budget, old-Anthropic `budget_tokens`, Gemini
thinkingBudget) — the resolver picks whichever column the resolved backend/model
speaks. Seeded per provider TYPE (fill-if-missing per instance), editable via
GET/PUT /v1/ai/reasoning-map/{provider}. The model_pricing CRUD is the precedent (#75)."""
from __future__ import annotations

from collections.abc import Callable
from typing import Protocol

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

# The reasoning "ask" vocabulary — the levels a task can request, in ascending order.
# ONE source; the resolver, the seeds and the UI all speak these. ("" / "off" is the
# ABSENCE of a level, handled by `think`, not a member here.)
REASONING_LEVELS: tuple[str, ...] = ("low", "medium", "high", "xhigh", "max")


class ReasoningLevelRow(BaseModel):
    level: str                    # one of REASONING_LEVELS
    word: str = ""                # effort word for word-speaking adapters; "" = n/a
    tokens: int | None = None     # budget number; None = no number form (word-only provider types)


# Per provider-TYPE seed for the reasoning_map — the ONE source both the seeder (seed.py)
# and the resolver's missing-row fallback (llm/reasoning.py) read (no duplicate table).
# (word, tokens) per level; `word` "" = the type speaks no effort word, `tokens` None = no
# number form (word-only provider types). LOCAL runs no longer read this map for the budget
# — the resolver reads the layered `reasoning_budget` switch value (llm/reasoning.py); the
# local rows remain editable map DATA. Downmaps where a type lacks a level are baked in
# (openai xhigh/max→"high"; ollama xhigh→"max"). Provider_type vocabulary + adapter routing
# from `registry.construct` (registry.py:70-131 — the SDK-adapter branches, #15 C4).
REASONING_MAP_TYPE_SEEDS: dict[str, dict[str, tuple[str, int | None]]] = {
    "local-llamacpp": {
        "low": ("", 1024), "medium": ("", 4096), "high": ("", 8192),
        # max finite BY POLICY (32768): the Gemma thinking loop is VERIFIED on-box; -1
        # stays legal as a typed value but is never seeded.
        "xhigh": ("", 16384), "max": ("", 32768),
    },
    "anthropic": {  # new models take output_config.effort (word); legacy take budget_tokens (number)
        "low": ("low", 1024), "medium": ("medium", 4096), "high": ("high", 8192),
        "xhigh": ("xhigh", 16384), "max": ("max", 32768),
    },
    "openai": {  # openai-family reasoning_effort words; xhigh/max downmap to "high"
        "low": ("low", None), "medium": ("medium", None), "high": ("high", None),
        "xhigh": ("high", None), "max": ("high", None),
    },
    "ollama": {  # native think levels; ollama also accepts "max"; xhigh downmaps to "max"
        "low": ("low", None), "medium": ("medium", None), "high": ("high", None),
        "xhigh": ("max", None), "max": ("max", None),
    },
    "gemini": {  # thinkingBudget numbers, preserving 2048/8192/24576 + extended xhigh/max [FLAGGED seeds — tune]
        "low": ("", 2048), "medium": ("", 8192), "high": ("", 24576),
        # max = -1 = documented dynamic/unlimited for thinkingBudget-era models (fixes Max
        # silently sending 8192 < High's 24576; gemini 3.x thinkingLevel is a later pass).
        "xhigh": ("", 32768), "max": ("", -1),
    },
    # D5 (#15 C4): xai/mistral emit NO effort param (not in openai_sdk.EMIT_EFFORT_TYPES) —
    # they run thinking at the model's own default. Honest empty rows (nothing to speak);
    # the ProviderForm hides both columns for these types (MODEL_DEFAULT_TYPES).
    "xai": {
        "low": ("", None), "medium": ("", None), "high": ("", None),
        "xhigh": ("", None), "max": ("", None),
    },
    "mistral": {
        "low": ("", None), "medium": ("", None), "high": ("", None),
        "xhigh": ("", None), "max": ("", None),
    },
}

# deepseek/openrouter now ride the official openai SDK adapter (openai_sdk.py, #15 C4);
# openai-compat rides the local httpx adapter. All three still share the "openai" effort-word
# SEED shape here — the rows are harmless DATA; the ADAPTER emission gate governs what's
# actually sent (openai_sdk.EMIT_EFFORT_TYPES: only openai/openrouter emit; deepseek does
# not). xai/mistral are NOT aliased — they carry their own honest empty rows above.
_TYPE_ALIAS: dict[str, str] = {"openai-compat": "openai", "deepseek": "openai", "openrouter": "openai"}


def seed_rows_for_type(provider_type: str) -> list[ReasoningLevelRow]:
    """The seeded reasoning-map rows for a provider TYPE (all five levels). An unknown
    online type defaults to the openai effort-word shape."""
    key = _TYPE_ALIAS.get(provider_type, provider_type)
    table = REASONING_MAP_TYPE_SEEDS.get(key) or REASONING_MAP_TYPE_SEEDS["openai"]
    return [ReasoningLevelRow(level=lvl, word=w, tokens=tok) for lvl, (w, tok) in table.items()]


class ReasoningMapResponse(BaseModel):
    provider: str
    rows: list[ReasoningLevelRow]


class ReasoningMapStore(Protocol):
    """Persistence boundary the host implements over its own storage."""

    def for_provider(self, provider_id: str) -> list[ReasoningLevelRow]: ...
    def upsert(self, provider_id: str, row: ReasoningLevelRow) -> None: ...  # upsert by (provider, level)


def make_reasoning_map_router(get_store: Callable[[], ReasoningMapStore]) -> APIRouter:
    """Per-provider reasoning level→value CRUD. The resolver reads these rows; a row
    absent for a (provider, level) falls back to the seeded type default (one constant
    in `llm/reasoning.py`). Values are editable DATA — no adapter keeps a level table."""
    router = APIRouter(tags=["ai"], prefix="/v1/ai")

    def _resp(provider: str) -> ReasoningMapResponse:
        return ReasoningMapResponse(provider=provider, rows=get_store().for_provider(provider))

    @router.get("/reasoning-map/{provider}", response_model=ReasoningMapResponse)
    async def get_reasoning_map(provider: str) -> ReasoningMapResponse:
        if not provider.strip():
            raise HTTPException(status_code=400, detail="provider is required")
        return _resp(provider)

    @router.put("/reasoning-map/{provider}", response_model=ReasoningMapResponse)
    async def put_reasoning_map(provider: str, body: ReasoningLevelRow) -> ReasoningMapResponse:
        if not provider.strip():
            raise HTTPException(status_code=400, detail="provider is required")
        if body.level not in REASONING_LEVELS:
            raise HTTPException(status_code=400, detail=f"level must be one of {REASONING_LEVELS}")
        get_store().upsert(provider, body)
        return _resp(provider)

    return router
