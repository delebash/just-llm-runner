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

import { request } from "../client.js";

const rows = ref([]); // raw /v1/ai/model-catalog rows
const classPicksRef = ref([]); // the class→model map rows riding the same response (Phase 3)

export const catalogRows = rows;
export const qualityById = computed(() =>
  Object.fromEntries(rows.value.map((r) => [r.id, r.qualityRank ?? 100])),
);
// dense | moe — the fit-shaped /v1/llm-runner/models view does NOT carry `type`, but the
// §10 speed-floor pick needs it (a usable MoE and a slow dense both read `tight`, so the
// band alone can't tell them apart). CatalogRow.type defaults "dense" (model_catalog_api.py:42).
export const typeById = computed(() =>
  Object.fromEntries(rows.value.map((r) => [r.id, r.type || "dense"])),
);
// Is this an EMBEDDING model (RAG index), not a chat LLM? The explicit editable catalog flag
// (CatalogRow.embedding, model_catalog_api.py:50 "replaces the /embed/i guess") — REQUIRED
// because bge-m3 has no "embed" in its id/name, so the name regex alone would leak it into
// the §10 LLM candidate pool and let Quick Setup pick an embed as the chat default.
export const embeddingById = computed(() =>
  Object.fromEntries(rows.value.map((r) => [r.id, !!r.embedding])),
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
export const poolingById = computed(() =>
  Object.fromEntries(rows.value.map((r) => [r.id, r.pooling || ""])),
);
// MTP-CAPABLE (Plan B): built-in MTP (the header-derived `mtp` flag) OR a configured
// external draft file (Gemma-style `mtpDraftFile`) — the same OR-gate the resolver's
// auto-mtp layer uses, so the grid's MTP tag shows exactly what auto-enables.
export const mtpById = computed(() =>
  Object.fromEntries(rows.value.map((r) => [r.id, !!(r.mtp || r.mtpDraftFile)])),
);
// The HF repo per model — the "Model card ↗" link (user, 2026-07-07: open the full
// details in the browser) builds https://huggingface.co/<repo> from it.
export const hfRepoById = computed(() =>
  Object.fromEntries(rows.value.map((r) => [r.id, r.hfRepo || ""])),
);

/** (Re)fetch the catalog rows into the shared state. Enrichment — on failure the maps
 *  fall back to empty (the fit-shaped list / the pick still work without the badges). */
export async function refresh() {
  try {
    const d = await request("/v1/ai/model-catalog");
    rows.value = d.rows || [];
    classPicksRef.value = d.classPicks || []; // the class→model map (Phase 3)
  } catch {
    rows.value = [];
    classPicksRef.value = [];
  }
}

/** Shared model-catalog meta. Every consumer gets the SAME refs; call refresh() on open
 *  or after a catalog edit to (re)populate the one shared source. */
export function useCatalogMeta() {
  return { catalogRows, classPicks: classPicksRef, qualityById, typeById, embeddingById, licenseById, useLimitedById, descriptionById, poolingById, mtpById, hfRepoById, refresh };
}
