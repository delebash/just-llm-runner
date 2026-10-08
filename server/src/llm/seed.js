// SPDX-License-Identifier: MIT
// The shared LLM seed — the port of llm/seed.py. Seeds take the database handle (the
// Python `s` session) and the caller runs them inside one `tx` (Python's commit).

import { DEFAULT_PRICING } from "./pricing.js";

/** Seed the cloud pricing table from DEFAULT_PRICING (merge-by-id — never clobber edits). */
export function seedDefaultPricing(h) {
  const existing = new Set(h.all("select model_id from model_pricing").map((r) => r.model_id));
  let added = 0;
  for (const [mid, [inp, out]] of Object.entries(DEFAULT_PRICING)) {
    if (existing.has(mid)) continue;
    h.insert("model_pricing", { model_id: mid, input_per_m: Number(inp), output_per_m: Number(out) });
    added += 1;
  }
  return added;
}
