// SPDX-License-Identifier: MIT
// Edit the online-provider model-list ruleset (#8) — GET/PUT + reset on
// `/v1/ai/model-list-rules`; the port of llm/model_list_rules_api.py. The rules are ONE
// seeded JSON document in the runner-settings store (host-supplied via the store functions
// below), keyed by provider TYPE. Same settings-endpoint shape as engine-config: GET the
// doc, PUT to replace it, POST /reset to snap back to the shipped seed. See
// `model_list_rules.js` for the aging contract.

import { Hono } from "hono";
import { model, opt, T } from "../platform/models.js";
import { input } from "../platform/server.js";

export const RuleRow = T.Object({
  // Anchored regexes only (the seed carries the deliberate boundaries); an invalid pattern
  // is skipped at apply time, never a 500 (model_list_rules' compile).
  embedPatterns: opt(T.Array(T.String()), []),
  dropPatterns: opt(T.Array(T.String()), []),
  collapseDated: opt(T.Boolean(), false),
});

export const ModelListRulesDoc = T.Object({
  seedVersion: opt(T.Integer(), 0),
  rules: opt(T.Record(T.String(), RuleRow), {}),
});

/** `getDoc()` → the stored doc, `setDoc(doc)` persists a user edit, `resetDoc()` snaps back
 * to the seed (stores.getModelListRules / setModelListRules / resetModelListRules). */
export function makeModelListRulesRouter(getDoc, setDoc, resetDoc) {
  const app = new Hono();
  app.get("/v1/ai/model-list-rules", async (c) => c.json(model(ModelListRulesDoc, getDoc())));

  app.put("/v1/ai/model-list-rules", input({ body: ModelListRulesDoc }), async (c) => {
    // Round-trip through the validated model so a stored doc is always well-formed
    // (unknown keys dropped, defaults filled) — the store just persists the JSON.
    setDoc(model(ModelListRulesDoc, c.req.valid("json")));
    return c.json(model(ModelListRulesDoc, getDoc()));
  });

  app.post("/v1/ai/model-list-rules/reset", async (c) => {
    resetDoc();
    return c.json(model(ModelListRulesDoc, getDoc()));
  });
  return app;
}
