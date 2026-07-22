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
 * The class-CONFIG pick (§9 final ruled shape, 2026-07-22 — replaces the deleted
 * hidden class→model pick table): the recommendation IS the visible class-tunes
 * library. Candidates = models that HAVE a config for THIS box's class (the
 * `classTuneRefs` pairs off the catalog response — the SAME rows the user sees,
 * copies, and shares in the class panel), passed through the §10 candidate guards
 * (runnable fit · not the embedding model · not use-limited — "never an
 * auto-default", the seeded license law); ranked by the ONE shared comparator
 * (`pickLowestQuality`). No config for this class → "" (the caller falls back to
 * the §10 speed-floor rule). Pure + truth-table-testable (verify-model-pick.mjs).
 * @param {Array}  refs    [{modelId, classKey}] — the (model, class) config pairs
 * @param {string} myClassKey  this box's class key (override-aware, server-derived)
 * @param {Array}  models  fit-annotated rows ([{id, fit, …}])
 * @param {Object} accessors  { fitSet, qualityOf, isEmbed, isUseLimited }
 */
export function pickByClassConfig(refs, myClassKey, models, { fitSet, qualityOf, isEmbed, isUseLimited }) {
  if (!myClassKey) return "";
  const ids = new Set(
    (refs || []).filter((r) => r.classKey === myClassKey).map((r) => r.modelId),
  );
  if (!ids.size) return "";
  const candidates = (models || []).filter(
    (m) => ids.has(m.id) && (fitSet || FIT_RUNNABLE).has(m.fit) && !isEmbed(m) && !isUseLimited(m),
  );
  return pickLowestQuality(candidates, { qualityOf });
}

/**
 * The EMBEDDING auto-pick (#274 — the user's confirmed rule, 2026-07-11: "that was how
 * it was already supposed to be"): the most capable embedding that fits what's LEFT of
 * the card after the chat pick. The embed CO-RESIDES with the chat model, so fitting the
 * raw card is not fitting the box — the #274 bug was exactly that: on an 8 GB card the
 * 8B embed "fit" 8192 alone, outranked the small embeds, and would starve the chat model.
 * CPU-band embeds (tier "cpu" — the ROUND-4 law: tiny models, deliberately CPU on the
 * user's own box) ALWAYS qualify regardless of leftover, so every box has a default.
 *
 *   candidates = embedding AND runnable on the raw card (the dropdown's own set)
 *   eligible   = tier "cpu" OR minVram <= leftoverMb
 *   pick       = lowest quality_rank among eligible (the shared comparator above)
 *   none eligible → the least-minVram candidate (never empty when something runs)
 *
 * QuickSetup's bestEmbedId AND the catalog's recommendedEmbedId both call THIS — one
 * source, no drift (the recommendedModelId precedent). The manual dropdowns still list
 * every runnable embed: picking a bigger one stays a deliberate user choice.
 *
 * @param {Array}  models  fit-annotated rows ([{id, fit, …}])
 * @param {Object} accessors  { leftoverMb  → card VRAM minus the chat pick's floor (MB),
 *   qualityOf(m) → number (LOWER = better), isEmbed(m) → boolean,
 *   minVramOf(m) → number (the curated VRAM floor, MB), tierOf(m) → string }
 * @returns {string} the chosen embed's id, or "" when no embed runs at all.
 */
export function pickBestEmbedId(models, { leftoverMb, qualityOf, isEmbed, minVramOf, tierOf }) {
  const candidates = (models || []).filter((m) => isEmbed(m) && FIT_RUNNABLE.has(m.fit));
  if (!candidates.length) return "";
  const left = Number(leftoverMb) > 0 ? Number(leftoverMb) : 0;
  const eligible = candidates.filter((m) => tierOf(m) === "cpu" || (minVramOf(m) || 0) <= left);
  if (eligible.length) return pickLowestQuality(eligible, { qualityOf });
  // No CPU-band row and nothing clears the leftover: the closest-to-fitting candidate
  // (least minVram, quality as the tie-break) — never empty when something runs.
  return [...candidates].sort(
    (a, b) => ((minVramOf(a) || 0) - (minVramOf(b) || 0)) || (qualityOf(a) - qualityOf(b)),
  )[0].id;
}

/**
 * The ONE composed auto-pick rule — QuickSetup's pick AND the catalog's
 * "Recommended for this PC" badge call THIS (one source, no drift; extracted
 * 2026-07-06, providers-surface redesign item 2; re-based 2026-07-22 onto the
 * §9 final ruled shape): a model with a class CONFIG for this box's class is
 * consulted FIRST (`pickByClassConfig` — the visible library IS the
 * recommendation), none → the §10 speed-floor rule (pickBestModel).
 * @param {Array}  models  catalog rows ([{id, fit, …}])
 * @param {Object} opts    { classTuneRefs, myClassKey,
 *                           typeOf, qualityOf, isEmbed, isUseLimited, runnable }
 * @returns {string} the recommended model's id, or "" when nothing fits.
 */
export function recommendedModelId(models, { classTuneRefs, myClassKey, typeOf, qualityOf, isEmbed, isUseLimited, runnable }) {
  const mine = pickByClassConfig(classTuneRefs || [], myClassKey || "", models, {
    fitSet: runnable || FIT_RUNNABLE, qualityOf, isEmbed, isUseLimited,
  });
  if (mine) return mine;
  return pickBestModel(models, { typeOf, qualityOf, isEmbed, isUseLimited });
}
