// SPDX-License-Identifier: MIT
// Shared knob-catalog client (C1's /v1/ai/knob-catalog) — ONE source for the
// fetch + the Plane-1 switch-catalog map every KnobGrid consumer builds from it
// (TuneMeasureModal and the LuClassTunes global mount both need it; the
// modelDefaults.js precedent: a small shared module instead of fetch copies).
import { request } from "./client.js";

// The raw seeded knob rows [{ flagName, kind, default, tier, plane, help,
// perRequest, options }]; [] on any failure — the catalog is an enrichment, raw
// rows still work.
export async function fetchKnobCatalog() {
  try {
    return (await request("/v1/ai/knob-catalog")).knobs || [];
  } catch {
    return [];
  }
}

// The Plane-1 map KnobGrid's add-row mode takes as `catalog`:
// flagName -> { help, kind, perRequest, options }. QC-18 (user, 2026-07-09) made
// switch values plain text/number boxes everywhere; AMENDED 2026-07-24 (the user's
// go, after a typo'd spec_type value — "nobe" — killed a load with the error
// visible only in the router log): a knob that DECLARES seeded options renders a
// dropdown; every other knob stays a free text/number box, so a NEW llama.cpp
// param still needs no code. `kind` (int|float|…) picks text vs number. No
// friendly `label` — the UI shows the EXACT switch name only (user ruling
// 2026-07-16). `perRequest` (the labeling law, 2026-07-16) carries the knob's
// per_request flag through to KnobGrid's one note site.
export function plane1SwitchCatalog(knobs) {
  return Object.fromEntries(
    (knobs || [])
      .filter((k) => k.plane === 1)
      .map((k) => [k.flagName, {
        help: k.help, kind: k.kind, perRequest: k.perRequest,
        options: (k.options || []).map((o) => ({ value: o.value, label: o.label || o.value })),
      }]),
  );
}
