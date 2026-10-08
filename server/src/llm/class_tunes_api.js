// SPDX-License-Identifier: MIT
// The hardware-class library's wire models the stores use — from llm/class_tunes_api.py.
// The router (`makeClassTunesRouter`) and the module's other models are ported in wave 2.
//
// A MODEL-CONFIG = one model's measured launch switches under a hardware class
// (`ClassTune`), keyed by (model_id, class_key). `switch_resolve` applies it BELOW a
// machine's own ModelTune and ABOVE the base/type/mtp bundles.

import { opt, T } from "../platform/models.js";

export const ClassTuneFlag = T.Object({
  flagName: T.String(),
  flagValue: opt(T.String(), ""),
});

/** One (model, hardware-class) launch config — a row group in the library. */
export const ClassTuneConfig = T.Object({
  modelId: T.String(),
  classKey: T.String(),
  builtIn: opt(T.Boolean(), false),
  rows: T.Array(ClassTuneFlag),
});
