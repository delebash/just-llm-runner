// SPDX-License-Identifier: MIT
// The shared /v1/prefs router — the renderer's preferences document, one wire for every
// same-stack app (the port of llm_runner/platform/prefs_api.py; the family settings/prefs
// split: `/v1/settings` is typed operator/server config, `/v1/prefs` is the renderer's own
// key/value document).
//
// The semantics are JustVoice's donor contract, verbatim:
//   - GET    returns the WHOLE document (`{key: value}`, values are real JSON).
//   - PATCH  is a **wholesale per-key** upsert, NOT a deep merge — a map/list entry is
//            removed by sending the smaller value (a deep merge cannot express a
//            deletion). Returns the merged document.
//   - DELETE clears the document (factory reset), 204.
//
// Storage is a host seam (the makeDataRouter pattern): the router speaks DECODED values;
// the host decides where and how they persist (JustVoice: its `prefs` table; JustWrite:
// its `settings` rows, its clear preserving the D3b folder-path keys; docgen: `pref.*`
// rows in `app_settings`, riding app.db so /v1/data covers them). Hooks may be sync or
// async.

import { Hono } from "hono";
import { RequestValidationError } from "./errors.js";
import { isJsonObject } from "./py.js";
import { readJson } from "./server.js";

/**
 * Build the shared renderer-prefs router over host storage hooks.
 *   - `readAll()`        → the whole document as decoded values.
 *   - `writeMany(patch)` → upsert every given key wholesale.
 *   - `clear()`          → drop the document (the host may exempt keys it must keep).
 */
export function makePrefsRouter({ readAll, writeMany, clear, prefix = "/v1/prefs" }) {
  const app = new Hono();
  app.get(prefix, async (c) => c.json(await readAll()));

  // The body is FastAPI's `patch: dict[str, Any]`: checked here so the 422 reads as
  // pydantic's dict error (measured: dict_type), not a model's.
  app.patch(prefix, async (c) => {
    const patch = await readJson(c);
    if (patch === undefined || patch === null) {
      throw new RequestValidationError([{ loc: ["body"], msg: "Field required", type: "missing" }]);
    }
    if (!isJsonObject(patch)) {
      throw new RequestValidationError([{ loc: ["body"], msg: "Input should be a valid dictionary", type: "dict_type" }]);
    }
    await writeMany(patch);
    return c.json(await readAll());
  });

  app.delete(prefix, async (c) => {
    await clear();
    return c.body(null, 204);
  });
  return app;
}
