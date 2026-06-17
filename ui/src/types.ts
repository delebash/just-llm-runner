// SPDX-License-Identifier: GPL-3.0-or-later
// The shared camelCase contract for the LLM provider/runner UI. Both apps map
// their native shapes to these at the ProviderBackend adapter boundary
// (JustVoice REST is snake_case; JustWrite is already camelCase). LLM +
// embedding only — TTS lives in JustVoice, never in a provider here.

// Known provider types, but open (string) so a host can add its own.
export type ProviderType =
  | "openai"
  | "openai-compat"
  | "anthropic"
  | "gemini"
  | "ollama"
  | "deepseek"
  | "openrouter"
  | "local-llamacpp"
  | (string & {});

export type TierKey = "quick" | "accuracy" | (string & {});

/** A registered LLM provider, as the UI sees it. `apiKey` is never echoed. */
export interface Provider {
  id: string;
  name: string;
  providerType: ProviderType;
  baseUrl: string;
  defaultModel: string;
  embeddingModel?: string;
  timeoutSeconds?: number;
  builtIn?: boolean;
  hasApiKey?: boolean; // list responses report presence, never the key itself
  registered?: boolean; // adapter is live in the host's registry
  extra?: Record<string, string>;
}

/** Create/update payload. `apiKey` is write-only: "" keeps the existing key,
 *  null clears it, a value sets it. */
export interface ProviderDraft {
  id: string;
  name: string;
  providerType: ProviderType;
  baseUrl?: string;
  apiKey?: string | null;
  defaultModel?: string;
  embeddingModel?: string;
  timeoutSeconds?: number;
}

/** Which provider+model handles a feature (compose / speaker_attribution / …). */
export interface FeaturePin {
  feature: string;
  providerId: string;
  model?: string;
}

/** One row of the token/cost usage ledger. */
export interface UsageRow {
  ts: number;
  feature: string;
  providerId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cost?: number;
}

/** A model id a provider exposes, optionally pre-classified into a tier. */
export interface ModelEntry {
  id: string;
  label?: string;
  tier?: TierKey;
}

/** A local LLM server found by probing well-known ports (Ollama, LM Studio). */
export interface DetectedLocalProvider {
  providerType: ProviderType;
  name: string;
  baseUrl: string;
  models: string[];
  alreadyRegistered: boolean;
}

export interface PingResult {
  ok: boolean;
  message?: string;
  ms?: number;
  modelsCount?: number;
}
