// SPDX-License-Identifier: MIT
// The embedding task templates' wire model — from llm/embed_templates_api.py. The router
// (`makeEmbedTemplatesRouter`) is ported in wave 2.
//
// Embedding models differ in the task instruction they REQUIRE around the raw text
// (nomic-embed prefixes both sides, Qwen3-Embedding instructs the query side only, BGE-M3
// needs nothing) — skipping it measurably degrades retrieval. The templates are model
// FACTS, so they live in the DB (`model_embed_templates`, seeded + user-editable).

import { opt, T } from "../platform/models.js";

export const EmbedTemplateRow = T.Object({
  modelId: T.String(),
  // Template strings with a `{text}` slot; "" = pass-through for that side.
  documentTemplate: opt(T.String(), ""),
  queryTemplate: opt(T.String(), ""),
  builtIn: opt(T.Boolean(), false),
});
