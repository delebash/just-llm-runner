// SPDX-License-Identifier: MIT
// The per-provider reasoning-level map's models and seeds — from llm/reasoning_map_api.py.
//
// The level→value table the ONE resolver (`llm/reasoning.js`) reads to turn a task's
// Low/Medium/High/XHigh/Max "ask" into what each provider actually speaks.
// Generation-aware: each row carries BOTH a `word` (effort-word adapters: OpenAI
// `reasoning_effort`, Ollama native level, new-Anthropic `output_config.effort`) AND
// `tokens` (budget-number paths: the local llama.cpp per-request budget, old-Anthropic
// `budget_tokens`, Gemini thinkingBudget) — the resolver picks whichever column the
// resolved backend/model speaks. Seeded per provider TYPE (fill-if-missing per instance),
// editable via GET/PUT /v1/ai/reasoning-map/{provider}. The model_pricing CRUD is the
// precedent (#75).

import { HttpError } from "../platform/errors.js";
import { model, nullable, opt, T } from "../platform/models.js";

// The reasoning "ask" vocabulary — the levels a task can request, in ascending order.
// ONE source; the resolver, the seeds and the UI all speak these. ("" / "off" is the
// ABSENCE of a level, handled by `think`, not a member here.)
export const REASONING_LEVELS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);

export const ReasoningLevelRow = T.Object({
  level: T.String(), // one of REASONING_LEVELS
  word: opt(T.String(), ""), // effort word for word-speaking adapters; "" = n/a
  tokens: opt(nullable(T.Integer()), null), // budget number; null = no number form (word-only provider types)
});

// Per provider-TYPE seed for the reasoning_map — the ONE source both the seeder (seed.js)
// and the resolver's missing-row fallback (llm/reasoning.js) read (no duplicate table).
// [word, tokens] per level; `word` "" = the type speaks no effort word, `tokens` null = no
// number form (word-only provider types). LOCAL runs no longer read this map for the
// budget — the resolver reads the layered `reasoning_budget` switch value; the local rows
// remain editable map DATA. Downmaps where a type lacks a level are baked in (openai
// xhigh/max→"high"; ollama xhigh→"max"). Provider-type vocabulary + adapter routing from
// `registry.construct`.
export const REASONING_MAP_TYPE_SEEDS = {
  "local-llamacpp": {
    low: ["", 1024],
    medium: ["", 4096],
    high: ["", 8192],
    // max finite BY POLICY (32768): the Gemma thinking loop is VERIFIED on-box; -1
    // stays legal as a typed value but is never seeded.
    xhigh: ["", 16384],
    max: ["", 32768],
  },
  anthropic: {
    // new models take output_config.effort (word); legacy take budget_tokens (number)
    low: ["low", 1024],
    medium: ["medium", 4096],
    high: ["high", 8192],
    xhigh: ["xhigh", 16384],
    max: ["max", 32768],
  },
  openai: {
    // openai-family reasoning_effort words; xhigh/max downmap to "high"
    low: ["low", null],
    medium: ["medium", null],
    high: ["high", null],
    xhigh: ["high", null],
    max: ["high", null],
  },
  ollama: {
    // native think levels; ollama also accepts "max"; xhigh downmaps to "max"
    low: ["low", null],
    medium: ["medium", null],
    high: ["high", null],
    xhigh: ["max", null],
    max: ["max", null],
  },
  gemini: {
    // thinkingBudget numbers, preserving 2048/8192/24576 + extended xhigh/max [FLAGGED seeds — tune]
    low: ["", 2048],
    medium: ["", 8192],
    high: ["", 24576],
    // max = -1 = documented dynamic/unlimited for thinkingBudget-era models (fixes Max
    // silently sending 8192 < High's 24576; gemini 3.x thinkingLevel is a later pass).
    xhigh: ["", 32768],
    max: ["", -1],
  },
  // xai/mistral emit NO effort param (not in openai_sdk's EMIT_EFFORT_TYPES) — they run
  // thinking at the model's own default. Honest empty rows (nothing to speak); the
  // ProviderForm hides both columns for these types (MODEL_DEFAULT_TYPES).
  xai: { low: ["", null], medium: ["", null], high: ["", null], xhigh: ["", null], max: ["", null] },
  mistral: { low: ["", null], medium: ["", null], high: ["", null], xhigh: ["", null], max: ["", null] },
};

// deepseek/openrouter ride the official openai SDK adapter; openai-compat rides the local
// HTTP adapter. All three share the "openai" effort-word SEED shape here — the rows are
// harmless DATA; the ADAPTER emission gate governs what's actually sent (only
// openai/openrouter emit; deepseek does not). xai/mistral are NOT aliased — they carry
// their own honest empty rows above.
const TYPE_ALIAS = { "openai-compat": "openai", deepseek: "openai", openrouter: "openai" };

/** The seeded reasoning-map rows for a provider TYPE (all five levels). An unknown online
 * type defaults to the openai effort-word shape. */
export function seedRowsForType(providerType) {
  const key = Object.hasOwn(TYPE_ALIAS, providerType) ? TYPE_ALIAS[providerType] : providerType;
  const table = (Object.hasOwn(REASONING_MAP_TYPE_SEEDS, key) && REASONING_MAP_TYPE_SEEDS[key]) || REASONING_MAP_TYPE_SEEDS.openai;
  return Object.entries(table).map(([level, [word, tokens]]) => model(ReasoningLevelRow, { level, word, tokens }));
}

export const ReasoningMapResponse = T.Object({
  provider: T.String(),
  rows: T.Array(ReasoningLevelRow),
});

/** Python's repr of the levels tuple, for the 400 detail. */
const LEVELS_REPR = `(${REASONING_LEVELS.map((l) => `'${l}'`).join(", ")})`;

/**
 * Per-provider reasoning level→value CRUD. `getStore()` → {forProvider(id), upsert(id,
 * row)}. The resolver reads these rows; a row absent for a (provider, level) falls back to
 * the seeded type default (one constant in `llm/reasoning.js`). Values are editable DATA —
 * no adapter keeps a level table.
 */
export function makeReasoningMapRouter(getStore) {
  return async function reasoningMapRouter(app) {
    const resp = (provider) => model(ReasoningMapResponse, { provider, rows: getStore().forProvider(provider) });
    // Starlette's {provider} is one NON-EMPTY segment, matched after the path is decoded: an
    // empty one, or an encoded slash (`a%2Fb` — two segments there), matches nothing.
    // find-my-way matches both and decodes after. Answer as FastAPI does.
    const providerOf = (req, reply) => {
      const provider = req.params.provider;
      if (provider === "" || provider.includes("/")) {
        reply.code(404).send({ detail: "Not Found" });
        return null;
      }
      if (!provider.trim()) throw new HttpError(400, "provider is required");
      return provider;
    };
    const params = T.Object({ provider: T.String() });

    app.get("/v1/ai/reasoning-map/:provider", { schema: { params } }, async (req, reply) => {
      const provider = providerOf(req, reply);
      if (provider === null) return reply;
      return resp(provider);
    });

    app.put("/v1/ai/reasoning-map/:provider", { schema: { params, body: ReasoningLevelRow } }, async (req, reply) => {
      const provider = providerOf(req, reply);
      if (provider === null) return reply;
      const body = model(ReasoningLevelRow, req.body);
      if (!REASONING_LEVELS.includes(body.level)) throw new HttpError(400, `level must be one of ${LEVELS_REPR}`);
      getStore().upsert(provider, body);
      return resp(provider);
    });
  };
}
