// SPDX-License-Identifier: GPL-3.0-or-later
// The §10 speed-floor auto-pick — "the most capable model that still streams faster than
// you read" (design 2026-07-03 §10, LOCKED; refined 2026-07-04 §15). PURE logic, NO Vue
// imports, so the kit's has-no-JS-test-runner gap is covered by a Node truth-table
// (scripts/verify-model-pick.mjs). This module is the ONE source of the runnable-set + the
// fit-rank + the pick; QuickSetup imports them (never redefines) so "runnable" can't drift.
// The only auto-picker is QuickSetup; the per-task LuModelPicker is a manual override and
// does not use this.
//
// THE RULE (verbatim §10):
//   candidates = RUNNABLE (fit ∈ {ok,tight,cpu}) AND NOT the embedding model AND NOT
//   use-limited. (use-limited-KEEP is a DELIBERATE augmentation of §10's candidate set,
//   carried from the prior pick — a use-limited license, e.g. Llama-Community, is "never an
//   auto-default" per seed.py:103-104 + the Llama-3.3-70B row; do NOT "correct" it back to
//   §10-literal, which would silently auto-set Llama-3.3-70B as the default on a ≥48 GB box.)
//   FAST-ENOUGH = (type==dense AND fit==ok, fully on GPU) OR (type==moe AND fit ∈ {ok,tight},
//   A3B-style offload usable because only the active path runs per token). The slow
//   dense-partial-offload (type==dense AND fit==tight — a real `tight` where the dense pays
//   full CPU compute on the spilled layers every token) is EXCLUDED.
//   If FAST-ENOUGH is non-empty → pick the lowest quality_rank among it (tie-break: the
//   better fit). FALLBACK (so the pick is never empty when something runs) → if FAST-ENOUGH
//   is empty, pick the lowest quality_rank among ALL runnable (a `tight` dense, or a `cpu`
//   model on a CPU-only box).

// Fit bands a model can run under (from /v1/llm-runner/models; runner/fit.py). The picker's
// single source — QuickSetup imports this for its `fitting` list too.
export const FIT_RUNNABLE = new Set(["ok", "tight", "cpu"]);
// CHAT models require a GPU (user decision 2026-07-06: CPU-only prose is too slow for
// the writing use case — "i dont think we should support it"; embeddings stay CPU-fine,
// "yes on embeding"). The wizard + the Recommended badge pick chat models from THIS set.
export const FIT_GPU = new Set(["ok", "tight"]);
// Tie-break when quality_rank is equal: prefer the better fit (lower = better).
export const FIT_RANK = { ok: 0, tight: 1, cpu: 2, no: 3, unknown: 4 };
// The fit-band display vocabulary — ONE source (was duplicated in useRunnerModels + QuickSetup).
export const FIT_LABEL = { ok: "Fits", tight: "Tight", cpu: "CPU", no: "Won't fit", unknown: "—" };

// §10 "fast enough": a dense model only clears the floor fully on the GPU (fit==ok); a MoE
// clears it at ok OR tight (its expert-offload streams because only ~3B is active per token).
function isFastEnough(model, type) {
  if (type === "moe") return model.fit === "ok" || model.fit === "tight";
  return model.fit === "ok"; // dense: exclude dense+tight (the slow partial-offload trap)
}

/**
 * The §10 speed-floor auto-pick. Returns the chosen model's `id`, or "" if nothing runs.
 *
 * @param {Array}  models  the fit-annotated list from /v1/llm-runner/models: [{id, fit, …}]
 * @param {Object} accessors  each `(model) => value`, bound by the caller to the catalog-join
 *   maps + guards so this stays pure/testable:
 *     - typeOf(m)       → "dense" | "moe"   (from useCatalogMeta.typeById; CatalogRow.type)
 *     - qualityOf(m)    → number            (from useCatalogMeta.qualityById; LOWER = better)
 *     - isEmbed(m)      → boolean           (the embedding model — excluded from LLM picks)
 *     - isUseLimited(m) → boolean           (use-limited license — never an auto-default)
 */
export function pickBestModel(models, { typeOf, qualityOf, isEmbed, isUseLimited }) {
  const runnable = (models || []).filter(
    (m) => FIT_RUNNABLE.has(m.fit) && !isEmbed(m) && !isUseLimited(m),
  );
  if (!runnable.length) return "";
  const fastEnough = runnable.filter((m) => isFastEnough(m, typeOf(m)));
  const pool = fastEnough.length ? fastEnough : runnable; // §10 fallback: best runnable
  return pickLowestQuality(pool, { qualityOf });
}

/**
 * Pick the lowest-quality_rank model (most capable) from a list, tie-breaking to the better
 * fit. SHARED by the §10 LLM pick above AND QuickSetup's embedding pick — both rank their
 * fitting candidates by the curated quality order, so the comparator lives ONCE.
 * @param {Array}  models  the candidate list ([{id, fit, …}])
 * @param {Object} accessors  { qualityOf(m) → number, LOWER = better }
 * @returns {string} the chosen model's id, or "" if the list is empty.
 */
// The class→model map (model-per-hardware plan Phase 3): `picks` = the seeded
// [{minVramMb, modelId}] rows off the catalog response. The row with the LARGEST
// minVramMb <= vramMb whose model EXISTS in the catalog AND FITS this box wins;
// no matching row → "" (the caller falls back to the §10 speed-floor rule below).
// Pure + truth-table-testable (verify-model-pick.mjs); contents are research-
// refreshed seed DATA (ledger C9), never logic.
export function pickByClassMap(picks, vramMb, { exists, fits }) {
  const eligible = (picks || [])
    .filter((p) => Number(p.minVramMb) <= Number(vramMb || 0))
    .sort((a, b) => Number(b.minVramMb) - Number(a.minVramMb));
  for (const p of eligible) {
    if (exists(p.modelId) && fits(p.modelId)) return p.modelId;
  }
  return "";
}

export function pickLowestQuality(models, { qualityOf }) {
  if (!models || !models.length) return "";
  return [...models].sort((a, b) => {
    const qa = qualityOf(a);
    const qb = qualityOf(b);
    if (qa !== qb) return qa - qb; // lower quality_rank = more capable
    return (FIT_RANK[a.fit] ?? 9) - (FIT_RANK[b.fit] ?? 9); // tie-break: better fit
  })[0].id;
}

/**
 * The ONE composed auto-pick rule — QuickSetup's pick AND the catalog's
 * "Recommended for this PC" badge call THIS (one source, no drift; extracted
 * 2026-07-06, providers-surface redesign item 2): the class→model map is
 * consulted FIRST (largest minVramMb <= this box's VRAM whose model exists +
 * fits), no matching row → the §10 speed-floor rule (pickBestModel).
 * @param {Array}  models  catalog rows ([{id, fit, …}])
 * @param {Object} opts    { classPicks, vramMb, byId: {id → row},
 *                           typeOf, qualityOf, isEmbed, isUseLimited }
 * @returns {string} the recommended model's id, or "" when nothing fits.
 */
export function recommendedModelId(models, { classPicks, vramMb, byId, typeOf, qualityOf, isEmbed, isUseLimited, runnable }) {
  const fitSet = runnable || FIT_RUNNABLE;
  const mapped = pickByClassMap(classPicks || [], vramMb || 0, {
    exists: (id) => !!byId[id],
    fits: (id) => fitSet.has(byId[id]?.fit),
  });
  if (mapped) return mapped;
  return pickBestModel(models, { typeOf, qualityOf, isEmbed, isUseLimited });
}
