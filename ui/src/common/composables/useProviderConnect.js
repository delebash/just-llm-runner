// SPDX-License-Identifier: GPL-3.0-or-later
// Shared provider-connect — the ONE source of the known-provider PRESETS + the connect
// endpoints (detect-local · probe-models · create), consumed by BOTH ProviderForm (add/edit
// a provider) AND QuickSetup (the other-provider step). RULE #7: extract, don't copy — a
// hand-rolled probe/create in each surface would drift (ProviderForm's own probe already
// diverged internally: fetchModels sent `defaultModel`, testConnection didn't). Lives in
// common/composables/ (beside useRouting/useRunnerModels/useCatalogMeta).
import { request } from "../../client.js";

// Known providers, as start-from-a-preset chips: [label, baseUrl, providerType, isLocal].
export const PROVIDER_PRESETS = [
  ["Local engine", "http://localhost:8080/v1", "openai-compat", true],
  ["Ollama", "http://localhost:11434", "ollama", true],
  ["LM Studio", "http://localhost:1234/v1", "openai-compat", true],
  ["OpenAI", "https://api.openai.com/v1", "openai", false],
  ["Anthropic", "https://api.anthropic.com", "anthropic", false],
  ["Gemini", "https://generativelanguage.googleapis.com", "gemini", false],
  ["OpenRouter", "https://openrouter.ai/api/v1", "openai-compat", false],
];

// Probe the well-known LOCAL LLM servers (Ollama :11434, LM Studio :1234) → the "detected →
// Connect" rows. Returns [{providerType, name, baseUrl, models[], alreadyRegistered}]; [] on
// failure (a down probe is just "not detected").
export async function detectLocal() {
  try {
    return (await request("/v1/llm-providers/detect-local")).detected || [];
  } catch {
    return [];
  }
}

// List a (draft) provider's models BEFORE it's saved — the shared draft-probe. Returns
// { models: string[], error?: string }. `apiKey` empty → null (a local provider needs none).
export async function probeModels({ providerType, baseUrl, apiKey, defaultModel } = {}) {
  return request("/v1/llm-providers/probe-models", {
    method: "POST",
    body: {
      providerType,
      baseUrl,
      apiKey: apiKey || null,
      ...(defaultModel ? { defaultModel } : {}),
    },
  });
}

// Create a provider (the id is derived server-side from the name). `body` is the full
// UpsertLLMProviderRequest shape; returns the created provider (LLMProviderResponse).
export async function createProvider(body) {
  return request("/v1/llm-providers", { method: "POST", body });
}

/** The shared provider-connect surface. Every consumer gets the SAME presets + endpoints. */
export function useProviderConnect() {
  return { PROVIDER_PRESETS, detectLocal, probeModels, createProvider };
}
