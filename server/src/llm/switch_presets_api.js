// SPDX-License-Identifier: MIT
// The switch-presets wire models — from llm/switch_presets_api.py. The router
// (`makeSwitchPresetsRouter`) is ported in wave 2.
//
// The capability/type switch bundles (`base`/`moe`/`mtp`) the resolver layers. A preset is
// a row (id / label / appliesTo) plus its flag rows (`preset_switches`); the PUT replaces a
// preset's WHOLE flag set. `appliesTo`: `all` · `moe`/`dense` (matches
// `model_catalog.type`) · `mtp` (the GATED auto-enable layer).

import { opt, T } from "../platform/models.js";

export const PresetSwitchRow = T.Object({
  flagName: T.String(),
  flagValue: opt(T.String(), ""),
});

export const SwitchPresetRow = T.Object({
  id: T.String(),
  label: opt(T.String(), ""),
  appliesTo: opt(T.String(), "all"), // all | moe | dense
  position: opt(T.Integer(), 0),
  builtIn: opt(T.Boolean(), false),
  switches: opt(T.Array(PresetSwitchRow), []),
});
