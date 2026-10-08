// SPDX-License-Identifier: MIT
// The concrete LLM stores — ONE shared implementation of every store over the shared
// database (`db.session()`); the port of llm/stores.py. An app installs the shared LLM
// stack and gets these — it does not implement storage.
//
// Each method is one short synchronous call (a multi-statement change runs in one
// `tx`, as the Python store committed once per call). Rows go out in the wire shape —
// camelCase, exactly the fields the Python store's pydantic model carried.

import * as db from "./db.js";

// ── cloud pricing (the usage-ledger cost source) ─────────────────────────────
const pricingToWire = (r) => ({ modelId: r.model_id, inputPerM: r.input_per_m, outputPerM: r.output_per_m });

export class PricingStore {
  list() {
    return db
      .session()
      .all("select * from model_pricing order by model_id", [], "model_pricing")
      .map(pricingToWire);
  }

  /** {modelId(lowercased): [inputPerM, outputPerM]} */
  asMap() {
    const out = {};
    for (const r of db.session().all("select * from model_pricing", [], "model_pricing")) {
      out[r.model_id.toLowerCase()] = [r.input_per_m, r.output_per_m];
    }
    return out;
  }

  upsert(row) {
    const h = db.session();
    const mid = (row.modelId || "").trim().toLowerCase();
    const vals = { input_per_m: Number(row.inputPerM || 0.0), output_per_m: Number(row.outputPerM || 0.0) };
    return h.tx(() => {
      if (h.get("model_pricing", mid)) h.update("model_pricing", vals, { model_id: mid });
      else h.insert("model_pricing", { model_id: mid, ...vals });
      return pricingToWire(h.get("model_pricing", mid));
    });
  }

  delete(modelId) {
    db.session().delete("model_pricing", { model_id: (modelId || "").trim().toLowerCase() });
  }
}

const pricing = new PricingStore();
export const getPricingStore = () => pricing;
