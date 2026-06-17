// SPDX-License-Identifier: GPL-3.0-or-later
// The boundary between the shared UI and each app. Components NEVER call fetch
// directly — they receive a ProviderBackend (provided via Vue inject) and call
// these methods. JustVoice supplies a REST adapter over /v1/llm-providers*;
// JustWrite supplies a Pinia-store adapter over its OpenAICompatClient. Same
// components, both apps, no forks.

import type {
  DetectedLocalProvider,
  FeaturePin,
  ModelEntry,
  PingResult,
  Provider,
  ProviderDraft,
  TierKey,
  UsageRow,
} from "../types";

export interface ProviderBackend {
  listProviders(): Promise<Provider[]>;
  addProvider(p: ProviderDraft): Promise<Provider>;
  updateProvider(id: string, patch: Partial<ProviderDraft>): Promise<Provider>;
  removeProvider(id: string): Promise<void>;

  ping(id: string): Promise<PingResult>;
  fetchModels(id: string): Promise<ModelEntry[]>;
  detectLocal(): Promise<DetectedLocalProvider[]>;
  classifyTier(modelId: string): Promise<TierKey>;

  usage(): Promise<UsageRow[]>;
  featurePins(): Promise<FeaturePin[]>;
  setFeaturePin(feature: string, pin: { providerId: string; model?: string }): Promise<void>;
}
