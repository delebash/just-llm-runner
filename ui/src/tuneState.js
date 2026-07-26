// SPDX-License-Identifier: GPL-3.0-or-later
// Shared tune-provenance client (§7.6, 2026-07-08 — the B3-4 badge family).
// ONE source for the /v1/ai/model-tunes/state fetch AND the badge wording, so
// the model catalog's row badges and the Tune modal's header tag can never
// drift apart. Derivation is SERVER-side (model_tunes_api.py): "auto" = the
// applied rows equal an autotune trial's switches; "hand" = anything else;
// PC-class membership = a PC class config exists for this box's class.
import { request } from "./client.js";

// { hwKey, classKey, tuned: { modelId: "auto"|"hand" }, classConfigured: [modelId] }
// — null on failure (badges are an enrichment; every surface must keep working).
export async function fetchTuneState() {
  try {
    return await request("/v1/ai/model-tunes/state");
  } catch {
    return null;
  }
}

// THE user-facing name of the class layer (2026-07-26 rename). ONE export, because the
// same words are said in TWO independent families: this badge and the resolved-route
// source labels (useResolvedRoute.js RESOLVED_SOURCE_LABELS.class) — which had ALREADY
// drifted ("hardware class default" vs the badge's "Hardware/model class default"),
// which is why the literal now lives in exactly one place.
export const CLASS_LAYER_LABEL = "PC class config";

// The §7.6 badge family — user-decided wording (queue doc §7.6, "d3-4 your rec").
// QC-1 (2026-07-08): tags use the REAL editor name, never invented shorthand. The name
// changed 2026-07-26 ("Hardware/model class default" → "PC class config", the user:
// "we keep getting it wrong" — a chooser surface was speaking a tuner's word and
// "default" was triple-booked on one screen); the QC-1 law itself is UNCHANGED, and
// still holds because the library button/dialog renamed in the same pass.
// All five labels answer ONE question in the same grammar — "how is this tuned?"
// (the user, 2026-07-26: "we used in tune and measure say what the model is tuned
// by, ie tuned by autotune, my hand, by class config … should be consistent").
// Before this, three named a MECHANISM ("Auto-tuned") and one named an ENTITY
// ("PC class config"), which is why the class badge did not read as tuning at all —
// it read as a hardware spec. The class label COMPOSES on CLASS_LAYER_LABEL rather
// than restating it, so the one-source law above still holds and QC-1 is satisfied
// (the tag still contains the real editor name).
export const TUNE_BADGES = {
  auto: { label: "Tuned by auto-tune", intent: "success" },
  hand: { label: "Tuned by hand", intent: "success" },
  class: { label: `Tuned by ${CLASS_LAYER_LABEL}`, intent: "secondary" },
  // Tuned — just not for THIS box's class. The caller appends the count.
  elsewhere: { label: "Not tuned here", intent: "secondary" },
  untuned: { label: "Not tuned", intent: "secondary" },
};

/**
 * One model's badge id: "auto" | "hand" | "class" | "elsewhere" | "untuned",
 * or NULL when the state fetch failed (badges are an enrichment — a surface with
 * no state renders no tag rather than claiming "Not tuned"). Null, not "": the
 * empty string used to MEAN untuned, so reusing it for "unknown" would leave every
 * existing `=== ""` caller quietly wrong instead of loudly broken.
 *
 * 2026-07-26 — the fifth state, and why "" stopped meaning untuned. The catalog
 * used to render NOTHING for an untuned row, on the theory that absence reads as
 * untuned. It does not: it made a model tuned on five OTHER classes look identical
 * to one nobody has ever run (the user: "if i see a bunch of models with nothing
 * indicating what it runs on that is confusing"). Worse, "not in a PC class config"
 * and "in one with no switches" are the SAME state in storage — class_tunes is keyed
 * (model_id, class_key, flag_name) with no parent row (db.py:435-441) — so a blank
 * row could not even be interrogated. Naming all five says what the row actually knows.
 *
 * @param {number} otherClassCount  how many OTHER classes have switches for this
 *   model; callers derive it from the catalog's classTuneRefs (no extra fetch).
 */
export function tuneBadgeIdOf(state, modelId, otherClassCount = 0) {
  if (!state || !modelId) return null;
  const src = state.tuned?.[modelId];
  if (src) return src === "auto" ? "auto" : "hand";
  if (state.classConfigured?.includes(modelId)) return "class";
  return otherClassCount > 0 ? "elsewhere" : "untuned";
}

/** True when nothing is tuned for THIS box — the two "not for you" states.
 *  Use this instead of comparing the id yourself: before 2026-07-26 callers tested
 *  the (then differently-named) resolver against `""`, which now means "state
 *  unavailable" and would answer false for every row. */
export function isUntunedHere(badgeId) {
  return badgeId === "untuned" || badgeId === "elsewhere";
}
