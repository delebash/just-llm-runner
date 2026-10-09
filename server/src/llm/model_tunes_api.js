// SPDX-License-Identifier: MIT
// The model-tunes router — a user's MEASURED per-(model, machine) engine tune (Plan B,
// 2026-07-05); the port of llm/model_tunes_api.py. The persistence behind Tune &
// measure's Apply: a verbatim snapshot of the tuned switch grid, keyed by (model_id,
// hw_key), applied LAST by `switch_resolve` so it wins over the base/type/mtp/class layers.
//
// The SERVER derives `hw_key` (via the injected `hwKeyFn` → the runner's whole-machine key)
// — the client never computes machine identity, so the key has ONE source. PUT replaces the
// (model, machine) tune's WHOLE row set; DELETE removes it ("Remove applied config" → back
// to the layered defaults). Never seeded; user data only.
//
// §7.6 additions (2026-07-08):
// - Baseline capture: PUT stores the LAYER-resolved defaults standing at apply time (via the
//   injected `resolveBaseline`) beside the tune, so GET can report `driftCount` — how many
//   default values changed since the apply. Tunes applied before baseline tracking report
//   driftCount=null (no honest claim possible).
// - Provenance source: GET derives `source` ("auto" | "hand") for an applied tune by
//   matching its rows against the measurement history's autotune trials — the sweep records
//   every trial's exact switches, so a tune equal to an autotune trial IS that sweep's
//   winner applied unedited; anything else was hand-shaped.
// - GET /model-tunes/state: the per-machine badge summary for the catalog — every tuned
//   model with its source, plus the models that have a PC class config for THIS box's
//   class. The client turns that into the five-state badge family (2026-07-26).

import { Hono } from "hono";
import { HttpError } from "../platform/errors.js";
import { model, nullable, opt, T } from "../platform/models.js";
import { pySorted, truthy } from "../platform/py.js";
import { input } from "../platform/server.js";

export const ModelTuneFlag = T.Object({
  flagName: T.String(),
  flagValue: opt(T.String(), ""),
});

export const ModelTuneResponse = T.Object({
  modelId: T.String(),
  hwKey: T.String(), // the machine the rows apply to (server-derived)
  rows: T.Array(ModelTuneFlag),
  // §7.6: how the applied config came to be — "auto" (equals an autotune trial's
  // switches) | "hand" | "" (no tune, or no measurement source wired).
  source: opt(T.String(), ""),
  // §7.6: values changed in the layer defaults SINCE this tune was applied — null =
  // unknowable (tune predates baseline tracking, or no baseline resolver).
  driftCount: opt(nullable(T.Integer()), null),
});

export const ModelTunePut = T.Object({
  modelId: T.String(),
  switches: opt(T.Array(ModelTuneFlag), []),
});

/** The per-machine tune/provenance summary the model catalog's badges read. */
export const ModelTunesState = T.Object({
  hwKey: T.String(),
  classKey: opt(T.String(), ""),
  tuned: opt(T.Record(T.String(), T.String()), {}), // modelId → "auto" | "hand"
  // modelIds that HAVE a PC class config for THIS box's class. Renamed from
  // `classDefault` 2026-07-26: this was never a default — it is a config's existence.
  classConfigured: opt(T.Array(T.String()), []),
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

const strip = (s) => String(s ?? "").trim();
const getOr = (d, k) => (Object.hasOwn(d, k) ? d[k] : null); // dict.get(k)

/**
 * GET / PUT / DELETE for the current machine's saved tune of one model, plus the §7.6
 * /state badge summary. `getStore()` → {get, replace, delete, getBaseline?, listForMachine?}
 * (the router degrades gracefully when a store lacks the optional two); `hwKeyFn()` → this
 * machine's key. The options wire drift + provenance: `resolveBaseline(modelId)` = the
 * layer resolve WITHOUT the machine tune; `measurementsFn(modelId)` = newest-first
 * measurement rows (source + switches); `classKeyFn` / `classConfigsFn` = this box's class
 * + the class-tune library.
 */
export function makeModelTunesRouter(
  getStore,
  hwKeyFn,
  { resolveBaseline = null, measurementsFn = null, classKeyFn = null, classConfigsFn = null } = {},
) {
  const app = new Hono();
  const sourceOf = (modelId, rows) => {
    if (!truthy(rows) || measurementsFn == null) return "";
    try {
      return deriveTuneSource(rows, measurementsFn(modelId) || []);
    } catch {
      return ""; // provenance is an enrichment, never a failure
    }
  };

  const driftOf = (modelId, hw, rows) => {
    if (!truthy(rows) || resolveBaseline == null) return null;
    const store = getStore();
    if (typeof store.getBaseline !== "function") return null;
    try {
      const stored = store.getBaseline(modelId, hw);
      if (stored == null) return null; // tune predates baseline tracking — no honest claim
      const current = resolveBaseline(modelId) || {};
      const keys = new Set([...Object.keys(stored), ...Object.keys(current)]);
      let n = 0;
      for (const k of keys) if (getOr(stored, k) !== getOr(current, k)) n += 1;
      return n;
    } catch {
      return null; // drift is an enrichment, never a failure
    }
  };

  const response = (modelId) => {
    const hw = hwKeyFn();
    const rows = getStore().get(modelId, hw);
    return model(ModelTuneResponse, {
      modelId,
      hwKey: hw,
      rows,
      source: sourceOf(modelId, rows),
      driftCount: driftOf(modelId, hw, rows),
    });
  };

  const modelIdQuery = input({ querystring: T.Object({ modelId: T.String() }) });

  app.get("/v1/ai/model-tunes", modelIdQuery, async (c) => {
    const { modelId } = c.req.valid("query");
    if (!strip(modelId)) throw new HttpError(400, "modelId is required");
    return c.json(response(modelId));
  });

  app.put("/v1/ai/model-tunes", input({ body: ModelTunePut }), async (c) => {
    const body = model(ModelTunePut, c.req.valid("json"));
    if (!strip(body.modelId)) throw new HttpError(400, "modelId is required");
    let baseline = null;
    if (resolveBaseline != null) {
      try {
        baseline = resolveBaseline(body.modelId) || {};
      } catch {
        baseline = null; // a baseline failure must not block the apply
      }
    }
    getStore().replace(body.modelId, hwKeyFn(), body.switches, baseline);
    return c.json(response(body.modelId));
  });

  app.delete("/v1/ai/model-tunes", modelIdQuery, async (c) => {
    const { modelId } = c.req.valid("query");
    if (!strip(modelId)) throw new HttpError(400, "modelId is required");
    getStore().delete(modelId, hwKeyFn());
    return c.json(response(modelId));
  });

  app.get("/v1/ai/model-tunes/state", async (c) => {
    const hw = hwKeyFn();
    const cls = classKeyFn ? classKeyFn() : "";
    const tuned = {};
    const store = getStore();
    if (typeof store.listForMachine === "function") {
      for (const [mid, rows] of Object.entries(store.listForMachine(hw) || {})) {
        tuned[mid] = sourceOf(mid, rows) || "hand";
      }
    }
    let classConfigured = [];
    if (cls && classConfigsFn != null) {
      try {
        const ids = new Set();
        for (const cfg of classConfigsFn() || []) {
          if ((cfg.classKey ?? "") === cls && truthy(cfg.rows ?? null)) ids.add(cfg.modelId);
        }
        classConfigured = pySorted(ids);
      } catch {
        classConfigured = []; // the summary is an enrichment
      }
    }
    return c.json(model(ModelTunesState, { hwKey: hw, classKey: cls, tuned, classConfigured }));
  });
  return app;
}
