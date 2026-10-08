// SPDX-License-Identifier: MIT
// Cloud pricing for the usage ledger (the port of llm/pricing.py). The AUTHORITATIVE
// source is the DB `model_pricing` table (seeded from DEFAULT_PRICING below, editable via
// /v1/ai/pricing); DEFAULT_PRICING is only the seed source + a no-DB fallback. Local
// providers have no entry → `priceFor` returns null, cost 0.

import * as stores from "./stores.js";

// [input, output] USD per 1,000,000 tokens. SEED SOURCE — the live values are the DB.
export const DEFAULT_PRICING = {
  // OpenAI
  "gpt-5": [1.25, 10.0],
  "gpt-5-mini": [0.25, 2.0],
  "gpt-5-nano": [0.05, 0.4],
  "gpt-4o": [2.5, 10.0],
  "gpt-4o-mini": [0.15, 0.6],
  "gpt-4.1": [2.0, 8.0],
  "gpt-4.1-mini": [0.4, 1.6],
  // Anthropic Claude
  "claude-fable-5": [10.0, 50.0],
  "claude-opus-4-8": [5.0, 25.0],
  "claude-opus-4-7": [5.0, 25.0],
  "claude-sonnet-4-6": [3.0, 15.0],
  "claude-haiku-4-5": [1.0, 5.0],
  // Google Gemini
  "gemini-2.5-pro": [1.25, 5.0],
  "gemini-2.5-flash": [0.3, 2.5],
};

/** The live price map (the DB), or DEFAULT_PRICING when the DB is unavailable/unseeded. */
function livePricing() {
  try {
    const live = stores.getPricingStore().asMap();
    return Object.keys(live).length ? live : DEFAULT_PRICING;
  } catch {
    return DEFAULT_PRICING;
  }
}

/** Exact (lowercased) match first, then prefix match (dated suffixes). null = unknown. */
export function priceFor(modelId) {
  if (!modelId) return null;
  const mid = String(modelId).toLowerCase();
  const pricing = livePricing();
  if (Object.hasOwn(pricing, mid)) return pricing[mid];
  for (const [key, p] of Object.entries(pricing)) {
    if (mid.startsWith(key)) return p;
  }
  return null;
}

export function costFor(modelId, promptTokens, completionTokens) {
  const p = priceFor(modelId);
  if (!p) return 0.0;
  return (promptTokens / 1_000_000) * p[0] + (completionTokens / 1_000_000) * p[1];
}
