// SPDX-License-Identifier: GPL-3.0-or-later
// Shared tune-provenance client (§7.6, 2026-07-08 — the B3-4 badge family).
// ONE source for the /v1/ai/model-tunes/state fetch AND the badge wording, so
// the model catalog's row badges and the Tune modal's header tag can never
// drift apart. Derivation is SERVER-side (model_tunes_api.py): "auto" = the
// applied rows equal an autotune trial's switches; "hand" = anything else;
// PC-class membership = a PC class config exists for this box's class.
import { request } from "./client.js";

// { hwKey, classKey, tuned: { modelId: "auto"|"hand" }, classDefault: [modelId] }
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
export const TUNE_BADGES = {
  auto: { label: "Auto-tuned", intent: "success" },
  hand: { label: "Hand-tuned", intent: "success" },
  class: { label: CLASS_LAYER_LABEL, intent: "secondary" },
  untuned: { label: "Untuned", intent: "secondary" },
};

// One model's badge id under a fetched state — "auto" | "hand" | "class" | "".
// Empty = untuned (the catalog renders NO badge for untuned rows — absence
// reads as untuned; a tag on every row would be noise. The Tune modal header
// DOES render the explicit Untuned state — it's the one-model surface).
export function tuneBadgeOf(state, modelId) {
  if (!state || !modelId) return "";
  const src = state.tuned?.[modelId];
  if (src) return src === "auto" ? "auto" : "hand";
  return state.classDefault?.includes(modelId) ? "class" : "";
}
