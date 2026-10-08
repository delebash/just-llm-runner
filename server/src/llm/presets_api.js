// SPDX-License-Identifier: MIT
// The engine-preset wire models the stores use — from llm/presets_api.py. The router
// (`makePresetsRouter`) and the assignment models are ported in wave 2.
//
// An ENGINE PRESET = a reusable ask-config (model + per-request params + long-tail
// samplers) built and saved in the Lab. It holds NO launch switches (§7.1): launch config
// belongs to the MODEL × machine tune stack (`switch_resolve`). An ACTION resolves its
// preset via its own ref (FeaturePresetRef) → the global default preset.

import { nullable, opt, T } from "../platform/models.js";

/** One long-tail sampler key-value in a preset. `flagName` rides the per-call `extra`. */
export const PresetFlagRow = T.Object({
  flagName: T.String(),
  flagValue: opt(T.String(), ""),
});

/** A reusable ask-config shared by the actions that point at it. */
export const EnginePresetRow = T.Object({
  id: opt(T.String(), ""),
  name: opt(T.String(), ""),
  providerId: opt(T.String(), ""),
  model: opt(T.String(), ""),
  // Plane-2 per-request params:
  temperature: opt(nullable(T.Number()), null),
  topP: opt(nullable(T.Number()), null),
  maxTokens: opt(T.Integer(), 0), // 0 → no cap
  reasoningEffort: opt(T.String(), ""), // "" | low | medium | high | xhigh | max
  think: opt(T.Boolean(), false), // STORED (U2-T3): thinking on/off, no longer derived from the level
  samplers: opt(T.Array(PresetFlagRow), []), // long-tail Plane-2 samplers
  builtIn: opt(T.Boolean(), false),
  position: opt(T.Integer(), 0),
  // READ-ONLY, filled at list time: the model this preset's FACTORY seed points at (""
  // for user-created presets). Clients use it to tell "differs from factory" — writes
  // ignore it.
  factoryModel: opt(T.String(), ""),
});
