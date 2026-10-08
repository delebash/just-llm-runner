// SPDX-License-Identifier: MIT
// The model-tunes wire model and its pure helper — from llm/model_tunes_api.py. The
// router (`makeModelTunesRouter`) and the module's other models are ported in wave 2.
//
// A user's MEASURED per-(model, machine) engine tune (Plan B): a verbatim snapshot of the
// tuned switch grid, keyed by (model_id, hw_key), applied LAST by `switch_resolve` so it
// wins over the base/type/mtp/class layers. Never seeded; user data only.

import { opt, T } from "../platform/models.js";

export const ModelTuneFlag = T.Object({
  flagName: T.String(),
  flagValue: opt(T.String(), ""),
});

/**
 * "auto" when the applied rows exactly equal some autotune trial's switches (newest
 * measurement first — the sweep persisted every OK trial verbatim, so an unedited applied
 * winner matches one), else "hand". ONE definition — both the per-model GET and the
 * /state summary ride it. `measurements` are MeasurementRow wire objects.
 */
export function deriveTuneSource(rows, measurements) {
  const tuned = new Map(rows.map((r) => [r.flagName, r.flagValue]));
  for (const m of measurements) {
    if ((m?.source ?? "") !== "autotune") continue;
    const trial = new Map((m.switches ?? []).map((f) => [f.flagName, f.flagValue]));
    if (trial.size === tuned.size && [...trial].every(([k, v]) => tuned.has(k) && tuned.get(k) === v)) return "auto";
  }
  return "hand";
}
