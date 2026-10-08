// SPDX-License-Identifier: MIT
// The mountable router for the storage-free LLM endpoints — the port of llm/api.py.
//
// These endpoints need NO per-app persistence — they operate on the shared registry + usage
// ledger (process singletons), so the SAME router is mounted by every app. The
// storage-coupled provider CRUD lives behind a host-supplied store (provider_api.js).
//
// Mount with `app.register(api.router)`. The two seams below are set by installLlm.

import path from "node:path";
import { HttpError } from "../platform/errors.js";
import { getLogger } from "../platform/log.js";
import { model, nullable, opt, T } from "../platform/models.js";
import { cpSlice, errText, isJsonObject, truthy, ValueError } from "../platform/py.js";
import { applyRules } from "./model_list_rules.js";
import { construct, getLlmRegistry } from "./registry.js";
import { LLMProviderConfig } from "./schema.js";
import { getLedger } from "./usage.js";

const log = getLogger("llm_runner.llm.api");

// The model-list-rules seam (#8) — this router is storage-free by charter, so installLlm
// injects a resolver over the host's runner-settings-backed rules doc (the setLedger /
// setEmbedTemplateResolver DI pattern). Unset (headless import, most tests) → no filtering:
// every provider's raw list passes through (the under-filter-safe default).
let modelListRulesResolver = null;

/** `fn()` → {providerType: ruleDict}. null → passthrough (no filtering). */
export function setModelListRulesResolver(fn) {
  modelListRulesResolver = fn;
}

/** The rule dict for a provider TYPE (or null = passthrough). A rules-store failure NEVER
 * 500s the picker — it degrades to passthrough (under-filter beats crash). */
function rulesFor(providerType) {
  if (modelListRulesResolver === null) return null;
  try {
    const raw = modelListRulesResolver();
    const rules = truthy(raw) ? raw : {};
    if (!isJsonObject(rules)) throw new TypeError("the model-list rules are not a dict");
    return Object.hasOwn(rules, providerType) ? rules[providerType] : null;
  } catch (e) {
    log.warning("model-list-rules resolver failed", e); // surface as "no rules", not a 500
    return null;
  }
}

/** Apply the type's rules to a raw id list → the back-compatible wire shape
 * {models, embeddings, hiddenCount}. `?all=1` bypasses every rule. */
function filteredModels(raw, providerType, { showAll }) {
  const res = applyRules(raw, rulesFor(providerType), { showAll });
  return { models: res.models, embeddings: res.embeddings, hiddenCount: res.hidden_count };
}

/**
 * The BUILT-IN provider's honest health (#139): the generic OpenAI-style probe asks the LAZY
 * router for /v1/models before anything ever loads, so a perfectly configured box reads as
 * broken. The built-in's real health = engine installed + a catalog to load from; models
 * load on first use BY DESIGN. Composed HERE (one source) so the form's Test connection AND
 * the list row's ping can never disagree. The imports are lazy, as in Python — this router
 * is charter-storage-free; the built-in branch is the recorded exception (it IS the
 * storage-backed provider).
 */
async function builtinProviderHealth() {
  const lifecycle = await import("../runner/lifecycle.js");
  const runnerModels = await import("../runner/models.js");
  const stores = await import("./stores.js");

  const service = await lifecycle.getService();
  const st = await service.engineStatus();
  const rows = stores.getModelCatalogStore().list();
  // DOWNLOADED ONLY (user ruling, 2026-07-16): `models` answers "what can this provider run
  // RIGHT NOW", so it lists what is ON DISK — not every catalog row. The catalog is the
  // place you download FROM; a picker offering a reference it hasn't fetched is offering
  // something that cannot run. Same disk truth the catalog's own Downloaded badge uses.
  // NOTE the field names: this store yields the WIRE CatalogRow (camelCase `hfRepo`).
  const hfCache = path.join(String(service.cacheRoot), "hf");
  const downloaded = rows.filter((r) => runnerModels.isCached(r.hfRepo, r.quant, { cacheRoot: hfCache, mmproj: r.mmproj }));
  const installed = truthy(st.installed);
  const bits = [];
  if (installed) {
    const build = st.build || "";
    const gpu = st.gpu || "";
    bits.push(`engine installed${build ? ` · ${build}` : ""}${gpu ? ` · ${gpu}` : ""}`);
  } else {
    bits.push("engine not installed — install it on the Built-in provider row");
  }
  // Say BOTH numbers: "2 of 9 downloaded" is the honest line when a picker looks empty or
  // short — it names the fix (download one) instead of reading as a broken provider.
  bits.push(`${downloaded.length} of ${rows.length} model${rows.length !== 1 ? "s" : ""} downloaded`);
  bits.push("models load on first use");
  return {
    // A catalog full of un-downloaded rows is NOT ok for this provider: nothing can run
    // until something is on disk, and `ok` drives the form's Test connection.
    ok: installed && downloaded.length > 0,
    builtin: true,
    detail: bits.join(" · "),
    models: downloaded.map((r) => r.id),
  };
}

export const ProbeModelsRequest = T.Object({
  providerType: T.String(),
  baseUrl: opt(T.String(), ""),
  apiKey: opt(nullable(T.String()), null),
  defaultModel: opt(T.String(), ""),
  timeoutSeconds: opt(T.Integer(), 30),
  all: opt(T.Boolean(), false), // bypass the model-list rules (the form's "show all" on a draft)
});

export const EmbeddingsRequest = T.Object({
  providerId: T.String(),
  model: opt(T.String(), ""),
  input: opt(T.Array(T.String()), []),
  // Embed task side (Move 0, RAG build): "document" | "query" | "" (= raw). When the model
  // has a catalog template row for the side, each input is wrapped server-side (nomic
  // prefixes / Qwen3 query instruction).
  taskType: opt(T.String(), ""),
});

// The embed-template resolver seam — this router is storage-free by charter, so installLlm
// injects a resolver over the host's ModelEmbedTemplate store. Unset (headless import,
// tests) → templates simply don't apply.
let embedTemplateResolver = null;

/** `fn(modelId)` → an object with documentTemplate/queryTemplate, or null. */
export function setEmbedTemplateResolver(fn) {
  embedTemplateResolver = fn;
}

/** Wrap each text in the model's task template for the given side. Any of: no resolver / no
 * row / empty side / empty taskType → the texts unchanged. */
function applyEmbedTemplate(modelId, taskType, texts) {
  if (embedTemplateResolver === null || !["document", "query"].includes(taskType) || !modelId) return texts;
  const row = embedTemplateResolver(modelId);
  if (row == null) return texts;
  const template = (taskType === "document" ? row.documentTemplate : row.queryTemplate) || "";
  if (!template.includes("{text}")) return texts;
  // str.replace: every occurrence, and the text taken literally (a function replacement, so
  // a "$&" in the input is never read as a pattern).
  return texts.map((t) => template.replaceAll("{text}", () => t));
}

const PARAMS = T.Object({ provider_id: T.String() });

/** The storage-free router (Python's module-level `router`). */
export async function router(app) {
  app.post("/v1/llm-providers/:provider_id/ping", { schema: { params: PARAMS } }, async (req) => {
    const providerId = req.params.provider_id;
    // The built-in engine's health is composed, never probed over its lazy router (#139) —
    // the id is the seeded constant.
    if (providerId === "local-llamacpp") {
      try {
        const h = await builtinProviderHealth();
        return { ok: h.ok, detail: h.detail, builtin: true };
      } catch (e) {
        return { ok: false, error: errText(e) }; // surface as data, like every ping
      }
    }
    const adapter = getLlmRegistry().get(providerId);
    if (adapter === null) throw new HttpError(404, `LLM provider ${providerId} (not registered)`);
    try {
      return { ok: await adapter.ping() };
    } catch (e) {
      return { ok: false, error: errText(e) }; // surface provider errors as data
    }
  });

  app.get(
    "/v1/llm-providers/:provider_id/models",
    { schema: { params: PARAMS, querystring: T.Object({ all: opt(T.Integer(), 0) }) } },
    async (req) => {
      const providerId = req.params.provider_id;
      // The BUILT-IN engine's models are the CATALOG (every downloaded model), NOT the lazy
      // router's resident set (#305 / same root as #139): the openai-compat adapter would
      // query the live llama-server /v1/models = only the loaded model, so a freshly
      // downloaded model never shows in the picker. LOCAL type → bypasses the online
      // model-list rules entirely (never hide a downloaded model); the uniform shape keeps
      // the client's reader (`r.embeddings`/`r.hiddenCount`) happy.
      if (providerId === "local-llamacpp") {
        try {
          const h = await builtinProviderHealth();
          const out = { models: h.models, embeddings: [], hiddenCount: 0 };
          if (!h.ok) out.error = h.detail;
          return out;
        } catch (e) {
          return { models: [], embeddings: [], hiddenCount: 0, error: errText(e) };
        }
      }
      const adapter = getLlmRegistry().get(providerId);
      if (adapter === null) throw new HttpError(404, `LLM provider ${providerId} (not registered)`);
      let raw;
      try {
        raw = await adapter.models();
      } catch (e) {
        log.warning(`LLM provider ${providerId} models() failed: ${errText(e)}`);
        return { models: [], embeddings: [], hiddenCount: 0, error: errText(e) };
      }
      // Apply the model-list rules for this provider's TYPE (#8). A type with no rules row
      // passes through unchanged (under-filter-safe); `?all=1` shows everything.
      return filteredModels(raw, adapter.provider_type, { showAll: !!req.query.all });
    },
  );

  // List a provider's models from an UNSAVED draft — the Add/Edit form's "Fetch models"
  // before the provider is persisted/registered. Builds a temporary adapter (never
  // registered) and calls .models().
  app.post("/v1/llm-providers/probe-models", { schema: { body: ProbeModelsRequest } }, async (req) => {
    const body = req.body;
    // The built-in engine never probes its lazy router (#139): its models are the CATALOG,
    // and its health line explains the load-on-first-use design.
    if (body.providerType === "local-llamacpp") {
      try {
        const h = await builtinProviderHealth();
        const out = { models: h.models, detail: h.detail };
        if (!h.ok) out.error = h.detail;
        return out;
      } catch (e) {
        return { models: [], error: errText(e) }; // surface as data, like every probe
      }
    }
    let adapter;
    try {
      adapter = construct(
        model(LLMProviderConfig, {
          id: "__probe__",
          name: "probe",
          providerType: body.providerType,
          baseUrl: body.baseUrl,
          apiKey: body.apiKey || null,
          defaultModel: body.defaultModel,
          timeoutSeconds: body.timeoutSeconds,
        }),
      );
    } catch (e) {
      if (e instanceof ValueError) throw new HttpError(400, errText(e));
      throw e;
    }
    let raw;
    try {
      raw = await adapter.models();
    } catch (e) {
      log.warning(`probe-models for ${body.providerType} failed: ${errText(e)}`);
      return { models: [], embeddings: [], hiddenCount: 0, error: errText(e) };
    }
    // Same model-list rules as the saved-provider endpoint (#8), keyed by the draft's
    // declared TYPE; `all=true` bypasses them for the form's "show all".
    return filteredModels(raw, body.providerType, { showAll: body.all });
  });

  // Embed texts through a registered provider (server-held key) — the shared replacement for
  // the old `/v1/llm/{id}/embeddings` proxy. The client passes the embedding provider id (its
  // routing default) + model; a non-embedding provider (Anthropic) reports a clear 400.
  // `taskType` applies the model's catalog embed template (a model with no row passes
  // through) AND is passed to the adapter's `embed(taskType)` — Gemini maps it to its
  // RETRIEVAL_* task_type; adapters with no task concept ignore it (#15 C5).
  app.post("/v1/ai/embeddings", { schema: { body: EmbeddingsRequest } }, async (req) => {
    const body = req.body;
    const adapter = getLlmRegistry().get(body.providerId);
    if (adapter === null) throw new HttpError(404, `LLM provider ${body.providerId} (not registered)`);
    if (typeof adapter.embed !== "function") {
      throw new HttpError(400, `provider ${body.providerId} does not support embeddings`);
    }
    const texts = applyEmbedTemplate(body.model, body.taskType, body.input);
    let vectors;
    try {
      vectors = await adapter.embed(texts, { model: body.model || null, taskType: body.taskType });
    } catch (e) {
      // Python's NotImplementedError (platform/py.js carries the JS class of that name).
      if (e?.name === "NotImplementedError") {
        throw new HttpError(400, `provider ${body.providerId} does not support embeddings`);
      }
      throw new HttpError(502, cpSlice(errText(e), 0, 400)); // surface upstream/transport errors
    }
    return { embeddings: vectors, model: body.model || adapter.default_model };
  });

  // Token + duration ledger per feature (Settings → AI usage).
  app.get("/v1/ai-usage", async () => getLedger().snapshot());

  app.delete("/v1/ai-usage", async () => {
    getLedger().clear();
    return { cleared: true };
  });
}
