// SPDX-License-Identifier: MIT
// buildLlmConfig — the dispatch-time `LLMConfig`, built from the shared stores (the port of
// llm/config_builder.py). Replaces both apps' per-app config. Reads the providers into the
// dispatch view. `preferLocalFeatures` is the only optional per-app input (the features that
// should default to the local runner, e.g. JustVoice's speaker_attribution).
//
// The feature-pin layer retired 2026-08-08 (decided 2026-07-15): the ACTION's engine preset
// carries provider+model, so the dispatch view is providers + `prefer_local_features` and
// nothing else.

import { LLMConfig } from "./schema.js";
import * as stores from "./stores.js";

export function buildLlmConfig(preferLocalFeatures = null) {
  const providers = [...stores.getProviderStore().list()];
  return LLMConfig({ providers, prefer_local_features: new Set(preferLocalFeatures || []) });
}
