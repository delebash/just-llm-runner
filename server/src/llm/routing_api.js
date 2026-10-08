// SPDX-License-Identifier: MIT
// The routing wire models the stores and the seed use — from llm/routing_api.py. The
// router (`makeRoutingRouter`) and its response models are ported in wave 2.
//
// The Routing tab edits the global **default** LLM (+ embedding) provider. Per-feature
// routing is owned by the ACTION's engine preset (2026-07-15 — the pin tier was removed).

import { opt, T } from "../platform/models.js";

export const RoutingDefaults = T.Object({
  llmId: opt(T.String(), ""),
  model: opt(T.String(), ""), // the default provider's model (empty → that provider's own default)
  embeddingId: opt(T.String(), ""),
  embeddingModel: opt(T.String(), ""), // the embedding provider's model (empty → its own default)
});

/** The stored routing shape (PUT body): the global default LLM + embedding. */
export const RoutingConfig = T.Object({
  default: opt(RoutingDefaults, { llmId: "", model: "", embeddingId: "", embeddingModel: "" }),
});

/**
 * One entry of the host's feature catalog (Python's `FeatureCatalogEntry` dataclass —
 * host data registered through `configureAppSeed`, never stored).
 */
export function FeatureCatalogEntry({ key, label, hint = "", group = "" }) {
  return { key, label, hint, group };
}
