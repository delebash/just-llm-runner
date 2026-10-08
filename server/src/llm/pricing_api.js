// SPDX-License-Identifier: MIT
// CRUD for cloud model pricing (the usage-ledger cost source) — the port of
// llm/pricing_api.py. GET/PUT/DELETE on `/v1/ai/pricing`. A model with no row → cost 0
// (local models never have one). Prices change, so they live in the DB, not in code.

import { HttpError } from "../platform/errors.js";
import { opt, T } from "../platform/models.js";

export const PricingRow = T.Object({
  modelId: T.String(),
  inputPerM: opt(T.Number(), 0.0), // USD per 1,000,000 input tokens
  outputPerM: opt(T.Number(), 0.0), // USD per 1,000,000 output tokens
});

export const PricingResponse = T.Object({ rows: T.Array(PricingRow) });

/** `getStore()` → {list(), upsert(row), delete(modelId)} — the host's persistence. */
export function makePricingRouter(getStore) {
  return async function pricingRouter(app) {
    const list = () => ({ rows: getStore().list() });

    app.get("/v1/ai/pricing", async () => list());

    app.put("/v1/ai/pricing", { schema: { body: PricingRow } }, async (req) => {
      if (!req.body.modelId.trim()) throw new HttpError(400, "modelId is required");
      getStore().upsert(req.body);
      return list();
    });

    app.delete(
      "/v1/ai/pricing",
      { schema: { querystring: T.Object({ modelId: T.String() }) } },
      async (req) => {
        if (!req.query.modelId.trim()) throw new HttpError(400, "modelId is required");
        getStore().delete(req.query.modelId);
        return list();
      },
    );
  };
}
