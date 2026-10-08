// SPDX-License-Identifier: MIT
// Knob-catalog endpoint — friendly metadata for the shared KnobGrid (C1); the port of
// llm/knob_catalog_api.py.
//
// Turns a raw switch/sampler key into a typed input: the KnobGrid takes a `catalog` (name →
// {help, kind}); this serves the seeded metadata so both the Plane-1 switch editors and the
// per-action sampler editor (Plane 2) render friendly inputs. Data-only — no code per param;
// an unknown key still works as a raw row (the KnobGrid escape). GET-only: the catalog is
// app-owned seed data.
//
// The store's rows also carry `backends`; KnobMeta does not declare it, so the wire drops it
// — exactly as the Python response model does.

import { model, opt, T } from "../platform/models.js";

export const KnobOption = T.Object({
  value: T.String(),
  label: opt(T.String(), ""),
});

export const KnobMeta = T.Object({
  flagName: T.String(),
  kind: opt(T.String(), "string"), // bool | int | float | enum | string
  default: opt(T.String(), ""),
  help: opt(T.String(), ""),
  plane: opt(T.Integer(), 1), // 1 = load switch, 2 = sampler
  appliesTo: opt(T.String(), "all"), // all | moe | dense
  tier: opt(T.String(), "common"), // common | advanced (UI checklist split)
  perRequest: opt(T.Boolean(), false), // plane-1 switch sent per REQUEST, not a launch flag (reasoning_budget)
  options: opt(T.Array(KnobOption), []),
});

export const KnobCatalogResponse = T.Object({
  knobs: T.Array(KnobMeta),
});

/** GET /v1/ai/knob-catalog. `getKnobs()` returns the joined catalog rows
 * (stores.listKnobCatalog). */
export function makeKnobCatalogRouter(getKnobs) {
  return async function knobCatalogRouter(app) {
    app.get("/v1/ai/knob-catalog", async () =>
      model(KnobCatalogResponse, { knobs: getKnobs().map((k) => model(KnobMeta, k)) }),
    );
  };
}
