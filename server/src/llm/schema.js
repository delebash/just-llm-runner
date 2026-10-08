// SPDX-License-Identifier: MIT
// Shared LLM config schema — the contract between host apps and the dispatch layer (the
// port of llm_runner/llm/schema.py). camelCase-native: the field name IS the JSON key IS
// the renderer's key — one name per field, no aliases.

import { nullable, opt, T } from "../platform/models.js";

/** A registered LLM provider. `providerType` picks the adapter (see schema.py). */
export const LLMProviderConfig = T.Object({
  id: T.String(),
  name: opt(T.String(), ""),
  providerType: T.String(),
  baseUrl: opt(T.String(), ""),
  apiKey: opt(nullable(T.String()), null),
  defaultModel: opt(T.String(), ""),
  embeddingModel: opt(T.String(), ""),
  timeoutSeconds: opt(T.Integer(), 60),
  // Runs on this machine (no key, no per-token cost) vs a metered cloud account — the
  // explicit Local/Online choice from the form, never inferred from the URL.
  local: opt(T.Boolean(), true),
  extra: opt(T.Record(T.String(), T.String()), {}),
});

/** A feature frozen exactly as tuned in its Lab — model AND prompts (precedence step 1). */
export const ProductionConfig = T.Object({
  feature: T.String(),
  name: T.String(),
  providerId: T.String(),
  model: opt(T.String(), ""),
  temperature: opt(nullable(T.Number()), null),
  systemPrompt: opt(nullable(T.String()), null),
  userPrompt: opt(nullable(T.String()), null),
  promotedAt: opt(nullable(T.String()), null),
  source: opt(T.String(), "lab"),
});

/**
 * The dispatch-time view of an app's LLM configuration (Python's `LLMConfig` dataclass —
 * internal plumbing, never serialized, so it keeps its snake field names).
 */
export function LLMConfig({
  providers = [],
  production_configs = [],
  prefer_local_features = new Set(),
  local_runner_provider_id = "local-llamacpp",
} = {}) {
  return {
    providers,
    production_configs,
    prefer_local_features: prefer_local_features instanceof Set ? prefer_local_features : new Set(prefer_local_features),
    local_runner_provider_id,
  };
}
