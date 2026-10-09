// SPDX-License-Identifier: MIT
// The persistent MEASUREMENT HISTORY router — the port of llm/model_measurements_api.py
// (#142 rows 5+6, 2026-07-07: 'save all data, nothing temporary' + 'add a clear button to
// clear history'). One append-only ledger of every real decode-speed measurement: the Tune
// modal's "Load & measure" POSTs its result (source 'tune' — the modal is the one actor
// that knows which switches it loaded), and the auto-tune sweep records every successful
// trial server-side via the injected seam in installLlm (source 'autotune').
//
// Sibling precedent: class_tunes_api (store + router factory + server-derived machine
// identity). GET returns newest-first, optionally filtered to one model (the Tune modal's
// per-model drawer); POST stamps `machineKey` and `at` SERVER-side (the client never
// supplies identity or clocks); DELETE is the Clear-history button — per-model with
// `modelId`, the whole ledger without.

import { Hono } from "hono";
import { HttpError } from "../platform/errors.js";
import { model, opt, T } from "../platform/models.js";
import { pyFloatParse, pyInt } from "../platform/py.js";
import { input } from "../platform/server.js";

export const MeasurementFlag = T.Object({
  flagName: T.String(),
  flagValue: opt(T.String(), ""),
});

/** One recorded measurement — the switches that produced the number ride along as
 * relational child rows. */
export const MeasurementRow = T.Object({
  id: T.Integer(),
  modelId: T.String(),
  machineKey: opt(T.String(), ""),
  source: opt(T.String(), "tune"), // tune | autotune | probe (the machine RAM-bw probe row)
  label: opt(T.String(), ""), // e.g. "baseline" / "n-cpu-moe 21" (autotune trials)
  tokensPerSec: opt(T.Number(), 0.0),
  vramTotalMb: opt(T.Integer(), 0),
  at: opt(T.Integer(), 0), // epoch ms, server-stamped
  // The engine family the number was measured on ("" = legacy cuda-era row). Declared so
  // the wire never strips it — the bandwidth ladder's derivation rule needs it
  // (cross-backend numbers are not comparable).
  backend: opt(T.String(), ""),
  // Phase 5 (§6.3): the true-up FOOTPRINT of a source='load' row (0 on speed rows) and
  // the owner kind (§8.16). Declared so the wire never strips them.
  vramModelMb: opt(T.Integer(), 0),
  kind: opt(T.String(), "llm"),
  // A speech model's real-time factor (seconds of audio per second of work); 0 on every
  // other row. Declared so the wire never strips it.
  realtimeX: opt(T.Number(), 0.0),
  switches: opt(T.Array(MeasurementFlag), []),
});

export const MeasurementsResponse = T.Object({
  machineKey: T.String(), // the CURRENT box (server-derived)
  measurements: T.Array(MeasurementRow), // newest first
});

export const MeasurementPost = T.Object({
  modelId: T.String(),
  source: opt(T.String(), "tune"),
  label: opt(T.String(), ""),
  tokensPerSec: opt(T.Number(), 0.0),
  vramTotalMb: opt(T.Integer(), 0),
  switches: opt(T.Array(MeasurementFlag), []),
});

const strip = (s) => String(s ?? "").trim();

/**
 * GET (history, newest first, ?modelId filter) / POST (record one) / DELETE (clear —
 * ?modelId for one model, none for everything). `getStore()` → {record, list, clear};
 * `machineKeyFn()` → this machine's key.
 */
export function makeModelMeasurementsRouter(getStore, machineKeyFn) {
  const app = new Hono();
  const response = (modelId) =>
    model(MeasurementsResponse, { machineKey: machineKeyFn(), measurements: getStore().list(modelId) });

  const optionalModelId = input({ querystring: T.Object({ modelId: opt(T.String(), "") }) });

  app.get("/v1/ai/model-measurements", optionalModelId, async (c) =>
    c.json(response(strip(c.req.valid("query").modelId) || null)),
  );

  app.post("/v1/ai/model-measurements", input({ body: MeasurementPost }), async (c) => {
    const body = model(MeasurementPost, c.req.valid("json"));
    const modelId = strip(body.modelId);
    if (!modelId) throw new HttpError(400, "modelId is required");
    getStore().record(modelId, {
      machineKey: machineKeyFn(),
      source: strip(body.source || "tune") || "tune",
      label: body.label || "",
      tokensPerSec: pyFloatParse(body.tokensPerSec || 0),
      vramTotalMb: pyInt(body.vramTotalMb || 0),
      at: Math.trunc(Date.now()), // int(time.time() * 1000)
      rows: body.switches,
    });
    return c.json(response(modelId));
  });

  app.delete("/v1/ai/model-measurements", optionalModelId, async (c) => {
    const modelId = strip(c.req.valid("query").modelId) || null;
    getStore().clear(modelId);
    return c.json(response(modelId));
  });
  return app;
}
