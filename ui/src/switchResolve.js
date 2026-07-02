// SPDX-License-Identifier: GPL-3.0-or-later
// Shared resolver for a model's layered engine-switch defaults (base -> type -> mtp,
// from `switch_presets` via `resolve_model_switches` on the server). ONE source used
// by BOTH the Tune & measure grid (LuModelCatalog) and the Lab column seed
// (ConfigColumn) so the two surfaces always agree on what a model's baseline switches
// are. Returns rows in the shared KnobGrid shape `[{ name, value }]`; `[]` for an
// unknown / cloud model (no catalog row -> resolve returns nothing -> no switches).
import { request } from "./client.js";

export async function fetchResolvedSwitches(modelId) {
  if (!modelId) return [];
  const r = await request(`/v1/ai/model-catalog/switches?modelId=${encodeURIComponent(modelId)}`);
  return (r.switches || []).map((sw) => ({ name: sw.flagName, value: sw.flagValue }));
}
