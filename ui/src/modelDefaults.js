// SPDX-License-Identifier: GPL-3.0-or-later
// Shared resolver for a model's layered run DEFAULTS — Plane-1 engine switches
// (base -> type -> per-hardware, from `switch_presets` via `resolve_model_switches`;
// NO auto-mtp layer — MTP is opt-in/measurable, Phase 3) PLUS the model's Plane-2
// recommended SAMPLERS (the file-derived per-model baseline, in OUR catalog namespace
// — Phase 5 seed-and-show). ONE call / ONE source used by BOTH the Tune & measure grid
// (TuneMeasureModal) and the Lab column seed (ConfigColumn), so every surface agrees on
// a model's baseline. Rows are the shared KnobGrid shape `[{ name, value }]`; empty for
// an unknown / cloud model (no catalog row). (Was `switchResolve.js` — renamed when the
// resolver grew to carry samplers too, so the name stops implying "switches only".)
import { request } from "./client.js";

// Full result: the baseline switch rows + the recommended sampler rows + `mtpCapable`
// (the Phase-2 GGUF `mtp` flag → the Speculative-decode opt-in hint) + `computed` —
// the engine's fit-COMPUTED launch values (ngl / n_cpu_moe / ctx) for keys NO layer
// pins on this box (Fix 2, 2026-07-07: shown as provenance, never silently merged
// into the editable rows — saving them would pin today's fit). ONE GET, ONE source,
// no drift between the switch grid and the sampler grid.
export async function resolveModelDefaults(modelId) {
  if (!modelId) return { switches: [], samplers: [], computed: [], mtpCapable: false };
  const r = await request(`/v1/ai/model-catalog/resolved-defaults?modelId=${encodeURIComponent(modelId)}`);
  return {
    switches: (r.switches || []).map((sw) => ({ name: sw.flagName, value: sw.flagValue })),
    samplers: (r.samplers || []).map((sw) => ({ name: sw.flagName, value: sw.flagValue })),
    computed: (r.computed || []).map((sw) => ({ name: sw.flagName, value: sw.flagValue })),
    // Provenance (2026-07-07): flagName -> the layer that last wrote it
    // (base | type | mtp | class | tune) — the Tune grid's per-row origin tags.
    origins: r.origins || {},
    mtpCapable: !!r.mtpCapable,
  };
}
