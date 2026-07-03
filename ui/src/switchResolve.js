// SPDX-License-Identifier: GPL-3.0-or-later
// Shared resolver for a model's layered engine-switch defaults (base -> type ->
// per-hardware, from `switch_presets` via `resolve_model_switches` on the server; NO
// auto-mtp layer — MTP is opt-in/measurable, Phase 3). ONE source used by BOTH the Tune
// & measure grid (LuModelCatalog) and the Lab column seed (ConfigColumn) so the two
// surfaces always agree on a model's baseline switches. Rows are in the shared KnobGrid
// shape `[{ name, value }]`; `[]` for an unknown / cloud model (no catalog row).
import { request } from "./client.js";

// Full result: the baseline switch rows PLUS `mtpCapable` (the Phase-2 GGUF `mtp` flag),
// so the Lab/Tune surfaces can offer Speculative decode as a measurable opt-in for
// MTP-capable models (Phase 3). ONE call, ONE source.
export async function resolveModelSwitches(modelId) {
  if (!modelId) return { switches: [], mtpCapable: false };
  const r = await request(`/v1/ai/model-catalog/switches?modelId=${encodeURIComponent(modelId)}`);
  return {
    switches: (r.switches || []).map((sw) => ({ name: sw.flagName, value: sw.flagValue })),
    mtpCapable: !!r.mtpCapable,
  };
}

// Back-compat: just the switch rows (the Tune grid reads the mtp flag off its catalog row).
export async function fetchResolvedSwitches(modelId) {
  return (await resolveModelSwitches(modelId)).switches;
}
