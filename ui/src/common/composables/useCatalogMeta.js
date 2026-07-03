// SPDX-License-Identifier: GPL-3.0-or-later
// Shared model-catalog META — ONE source of the /v1/ai/model-catalog rows + the by-id
// lookups (quality rank / license / use-limited / description) that the fit-shaped
// /v1/llm-runner/models view does NOT carry. Consumed by the model-catalog list (badges)
// AND QuickSetup (the fit-best pick) so the two surfaces read the SAME curated fields and
// never drift — the useRunnerModels precedent (a module singleton for exactly two
// consumers), minus the poller: catalog meta changes only on an explicit edit, so
// refresh() is called by the editor after a save/delete/reset and by any consumer that
// needs current data (QuickSetup on open).
import { computed, ref } from "vue";

import { request } from "../../client.js";

const rows = ref([]); // raw /v1/ai/model-catalog rows

export const catalogRows = rows;
export const qualityById = computed(() =>
  Object.fromEntries(rows.value.map((r) => [r.id, r.qualityRank ?? 100])),
);
export const licenseById = computed(() =>
  Object.fromEntries(rows.value.map((r) => [r.id, r.license || ""])),
);
export const useLimitedById = computed(() =>
  Object.fromEntries(rows.value.map((r) => [r.id, !!r.useLimited])),
);
export const descriptionById = computed(() =>
  Object.fromEntries(rows.value.map((r) => [r.id, r.description || ""])),
);

/** (Re)fetch the catalog rows into the shared state. Enrichment — on failure the maps
 *  fall back to empty (the fit-shaped list / the pick still work without the badges). */
export async function refresh() {
  try {
    rows.value = (await request("/v1/ai/model-catalog")).rows || [];
  } catch {
    rows.value = [];
  }
}

/** Shared model-catalog meta. Every consumer gets the SAME refs; call refresh() on open
 *  or after a catalog edit to (re)populate the one shared source. */
export function useCatalogMeta() {
  return { catalogRows, qualityById, licenseById, useLimitedById, descriptionById, refresh };
}
