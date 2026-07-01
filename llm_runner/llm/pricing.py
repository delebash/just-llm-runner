# SPDX-License-Identifier: GPL-3.0-or-later
"""Cloud pricing for the usage ledger. The AUTHORITATIVE source is the DB
`model_pricing` table (seeded from `DEFAULT_PRICING` below, editable via
`/v1/ai/pricing`); `DEFAULT_PRICING` is only the seed source + a no-DB fallback,
so prices are operator-editable and not hardcoded at runtime. Local providers
(Ollama / LM Studio / llama.cpp) have no entry → `price_for` returns None, cost 0.
"""

from __future__ import annotations

# (input, output) USD per 1,000,000 tokens. SEED SOURCE — the live values are the
# `model_pricing` DB table (this dict seeds it + is the no-DB fallback only).
DEFAULT_PRICING: dict[str, tuple[float, float]] = {
    # OpenAI
    "gpt-5": (1.25, 10.00),
    "gpt-5-mini": (0.25, 2.00),
    "gpt-5-nano": (0.05, 0.40),
    "gpt-4o": (2.50, 10.00),
    "gpt-4o-mini": (0.15, 0.60),
    "gpt-4.1": (2.00, 8.00),
    "gpt-4.1-mini": (0.40, 1.60),
    # Anthropic Claude
    "claude-fable-5": (10.00, 50.00),
    "claude-opus-4-8": (5.00, 25.00),
    "claude-opus-4-7": (5.00, 25.00),
    "claude-sonnet-4-6": (3.00, 15.00),
    "claude-haiku-4-5": (1.00, 5.00),
    # Google Gemini
    "gemini-2.5-pro": (1.25, 5.00),
    "gemini-2.5-flash": (0.30, 2.50),
}


def _live_pricing() -> dict[str, tuple[float, float]]:
    """The authoritative price map: the DB `model_pricing` table (seeded from
    DEFAULT_PRICING, editable via /v1/ai/pricing). Falls back to DEFAULT_PRICING
    only when the DB is unavailable/unseeded (bare tests, pre-seed boot)."""
    try:
        from . import stores

        live = stores.get_pricing_store().as_map()
        return live or DEFAULT_PRICING
    except Exception:
        return DEFAULT_PRICING


def price_for(model_id: str | None) -> tuple[float, float] | None:
    """Exact (lowercased) match first, then prefix match (catches dated
    suffixes like `-2026-01-01`). None when unknown (→ cost 0). Reads the LIVE
    DB pricing — DEFAULT_PRICING is only the seed source + no-DB fallback."""
    if not model_id:
        return None
    mid = str(model_id).lower()
    pricing = _live_pricing()
    if mid in pricing:
        return pricing[mid]
    for key, p in pricing.items():
        if mid.startswith(key):
            return p
    return None


def cost_for(model_id: str | None, prompt_tokens: int, completion_tokens: int) -> float:
    p = price_for(model_id)
    if not p:
        return 0.0
    return (prompt_tokens / 1_000_000) * p[0] + (completion_tokens / 1_000_000) * p[1]
