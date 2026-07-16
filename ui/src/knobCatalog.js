// SPDX-License-Identifier: GPL-3.0-or-later
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
// flagName -> { help, kind, perRequest }. QC-18 (user, 2026-07-09): switch values
// are plain text/number boxes everywhere — no options-driven dropdowns; the HELP
// carries what a switch does + its accepted values. `kind` (int|float|…) only
// picks text vs number for the value box. No friendly `label` — the UI shows the
// EXACT switch name only (user ruling 2026-07-16). `perRequest` (the labeling law,
// 2026-07-16: "a row in a switches surface must be a real engine switch or SAY it
// isn't") carries the knob's per_request flag through to KnobGrid's one note site,
// so a JSON-per-request knob (reasoning_budget) can't read as a launch flag.
export function plane1SwitchCatalog(knobs) {
  return Object.fromEntries(
    (knobs || [])
      .filter((k) => k.plane === 1)
      .map((k) => [k.flagName, { help: k.help, kind: k.kind, perRequest: k.perRequest }]),
  );
}
