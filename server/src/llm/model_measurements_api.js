// SPDX-License-Identifier: MIT
// The measurement history's wire models — from llm/model_measurements_api.py. The router
// (`makeModelMeasurementsRouter`) and the module's other models are ported in wave 2.
//
// One append-only ledger of every real decode-speed measurement: the Tune modal's "Load &
// measure" (source "tune") and every successful auto-tune trial (source "autotune").

import { opt, T } from "../platform/models.js";

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
  // the owner kind (§8.16).
  vramModelMb: opt(T.Integer(), 0),
  kind: opt(T.String(), "llm"),
  // A speech model's real-time factor (seconds of audio per second of work); 0 on every
  // other row.
  realtimeX: opt(T.Number(), 0.0),
  switches: opt(T.Array(MeasurementFlag), []),
});
