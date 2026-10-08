// SPDX-License-Identifier: MIT
// CRUD for per-model embedding task templates (Move 0 of the RAG build) — the port of
// llm/embed_templates_api.py. GET/PUT/DELETE on `/v1/ai/embed-templates`.
//
// Embedding models differ in the task instruction they REQUIRE around the raw text
// (nomic-embed prefixes both sides, Qwen3-Embedding instructs the query side only, BGE-M3
// needs nothing) — skipping it measurably degrades retrieval. The templates are model
// FACTS, so they live in the DB (`model_embed_templates`, seeded + user-editable here) and
// are applied server-side by /v1/ai/embeddings via the resolver seam installLlm wires.

import { HttpError } from "../platform/errors.js";
import { model, opt, T } from "../platform/models.js";

export const EmbedTemplateRow = T.Object({
  modelId: T.String(),
  // Template strings with a `{text}` slot; "" = pass-through for that side.
  documentTemplate: opt(T.String(), ""),
  queryTemplate: opt(T.String(), ""),
  builtIn: opt(T.Boolean(), false),
});

export const EmbedTemplatesResponse = T.Object({
  rows: T.Array(EmbedTemplateRow),
});

const strip = (s) => String(s ?? "").trim();

/**
 * CRUD for per-model embed templates. `getStore()` → {list(), get(id), upsert(row),
 * delete(id)}. A model with no row → both sides pass through unchanged (online/BYO models
 * never need one).
 */
export function makeEmbedTemplatesRouter(getStore) {
  return async function embedTemplatesRouter(app) {
    const list = () => model(EmbedTemplatesResponse, { rows: getStore().list() });

    app.get("/v1/ai/embed-templates", async () => list());

    app.put("/v1/ai/embed-templates", { schema: { body: EmbedTemplateRow } }, async (req) => {
      const body = model(EmbedTemplateRow, req.body);
      if (!strip(body.modelId)) throw new HttpError(400, "modelId is required");
      getStore().upsert(body);
      return list();
    });

    app.delete(
      "/v1/ai/embed-templates",
      { schema: { querystring: T.Object({ modelId: T.String() }) } },
      async (req) => {
        const { modelId } = req.query;
        if (!strip(modelId)) throw new HttpError(400, "modelId is required");
        getStore().delete(modelId);
        return list();
      },
    );
  };
}
