// SPDX-License-Identifier: MIT
// The shared feature-routing router behind a host-supplied storage boundary — the port of
// llm/routing_api.py.
//
// The Routing tab of the shared AI UI edits the global **default** LLM (+ embedding)
// provider. Per-feature routing is owned by the ACTION's engine preset (2026-07-15 — the
// pin tier was removed; the preset carries provider+model).
//
// Like provider_api and prompts, this is a router factory over a host-supplied RoutingStore
// (real persistence — the shared routing table) plus the host's **feature catalog** (which
// features exist + their labels/hints/group — per-app data). The GET merges the catalog with
// the stored default so the UI renders one row per feature; the PUT persists the whole
// routing config.

import { model, opt, T } from "../platform/models.js";

// ── wire shapes (camelCase) ──────────────────────────────────────────────────
export const RoutingDefaults = T.Object({
  llmId: opt(T.String(), ""),
  model: opt(T.String(), ""), // the default provider's model (empty → that provider's own default)
  embeddingId: opt(T.String(), ""),
  embeddingModel: opt(T.String(), ""), // the embedding provider's model (empty → its own default)
});

/** The stored routing shape (PUT body): the global default LLM + embedding. Per-feature pins
 * were removed 2026-07-15 (the preset is the one source of routing). */
export const RoutingConfig = T.Object({
  default: opt(RoutingDefaults, { llmId: "", model: "", embeddingId: "", embeddingModel: "" }),
});

/** One catalog feature (GET response) — key/label/hint + its nav group. */
export const FeatureRow = T.Object({
  key: T.String(),
  label: T.String(),
  hint: opt(T.String(), ""),
  group: opt(T.String(), ""), // the catalog's nav grouping (display-only), e.g. "Writing", "Analysis"
});

export const RoutingResponse = T.Object({
  default: RoutingDefaults,
  features: T.Array(FeatureRow),
});

// The host boundary (Python's RoutingStore Protocol): getRouting() → RoutingConfig,
// setRouting(cfg).

/**
 * One feature the host exposes for routing (Python's `FeatureCatalogEntry` dataclass — host
 * data registered through `configureAppSeed`, never stored): its key, human label, a hint,
 * and the nav group it belongs to (`group`, display-only; NOT a routing key — routing is
 * owned by the action's preset).
 */
export function FeatureCatalogEntry({ key, label, hint = "", group = "" }) {
  return { key, label, hint, group };
}

/** Build the /v1/ai/routing GET+PUT router over a host RoutingStore and the host's feature
 * catalog (`getCatalog()` → FeatureCatalogEntry[]). */
export function makeRoutingRouter(getStore, getCatalog) {
  return async function routingRouter(app) {
    const response = () => {
      const cfg = getStore().getRouting();
      const rows = getCatalog().map((e) => ({ key: e.key, label: e.label, hint: e.hint, group: e.group }));
      return model(RoutingResponse, { default: cfg.default, features: rows });
    };

    app.get("/v1/ai/routing", async () => response());

    app.put("/v1/ai/routing", { schema: { body: RoutingConfig } }, async (req) => {
      getStore().setRouting(req.body);
      return response();
    });
  };
}
