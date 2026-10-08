// SPDX-License-Identifier: MIT
// The shared provider-CRUD router behind a host-supplied storage boundary — the port of
// llm/provider_api.py.
//
// Unlike api.js (storage-free endpoints over the shared registry/ledger), the provider list
// is persisted per app. So this is a **router factory**: the host passes a ProviderStore (a
// genuine persistence boundary that does real work, not a forwarding shim) and gets a ready
// `/v1/llm-providers*` router that every app mounts identically. The CRUD logic, validation,
// adapter-registry sync and local-server detection live here ONCE; only persistence differs.

import * as http from "../platform/http.js";
import { HttpError } from "../platform/errors.js";
import { getLogger } from "../platform/log.js";
import { model, nullable, opt, T } from "../platform/models.js";
import { errText, isJsonObject, strip, strRepr, truthy } from "../platform/py.js";
import { construct, getLlmRegistry } from "./registry.js";
import { LLMProviderConfig } from "./schema.js";

const log = getLogger("llm_runner.llm.provider_api");

export const PROVIDER_TYPES = [
  "anthropic",
  "openai",
  "openai-compat",
  "gemini",
  "ollama",
  "deepseek",
  "openrouter",
  "xai",
  "mistral",
  // The bundled llama.cpp runner. Not offered as a user-pickable type in the UI (the
  // built-in provider is seeded), but allowed here so that seeded provider round-trips
  // through PATCH instead of 400-ing on save.
  "local-llamacpp",
];

// The host boundary (Python's ProviderStore Protocol): list() → LLMProviderConfig[],
// get(id) → config | null, add(cfg), replace(id, cfg), remove(id).

export const LLMProviderResponse = T.Object({
  id: T.String(),
  name: T.String(),
  providerType: T.String(),
  baseUrl: opt(T.String(), ""),
  defaultModel: opt(T.String(), ""),
  embeddingModel: opt(T.String(), ""),
  hasApiKey: T.Boolean(),
  registered: T.Boolean(), // true if the adapter is live in the registry
  timeoutSeconds: opt(T.Integer(), 60),
  local: opt(T.Boolean(), true), // the stored Local/Online choice — drives UI grouping
});

export const LLMProviderList = T.Object({
  providers: T.Array(LLMProviderResponse),
  providerTypes: opt(T.Array(T.String()), PROVIDER_TYPES),
});

export const UpsertLLMProviderRequest = T.Object({
  // Optional on create: when blank, the server derives a slug id from `name` (one name to
  // type, not two). On PATCH the path param identifies the row, so the body id is ignored.
  id: opt(T.String({ maxLength: 80 }), ""),
  name: T.String({ minLength: 1, maxLength: 120 }),
  providerType: T.String(),
  baseUrl: opt(T.String(), ""),
  // `apiKey` is write-only — list responses never echo it. PATCH with an empty string means
  // "leave the existing key in place"; PATCH with null clears it.
  apiKey: opt(nullable(T.String()), null),
  defaultModel: opt(T.String(), ""),
  embeddingModel: opt(T.String(), ""),
  timeoutSeconds: opt(T.Integer(), 60),
  local: opt(T.Boolean(), true), // Local (on this machine) vs Online (metered cloud)
});

export const DetectedLocalProvider = T.Object({
  providerType: T.String(), // "ollama" | "openai-compat" — a canonical PROVIDER_TYPES value
  name: T.String(),
  baseUrl: T.String(),
  models: T.Array(T.String()),
  alreadyRegistered: T.Boolean(),
});

export const DetectLocalResponse = T.Object({
  detected: T.Array(DetectedLocalProvider),
});

function toResponse(cfg, registered) {
  return model(LLMProviderResponse, {
    id: cfg.id,
    name: cfg.name,
    providerType: cfg.providerType,
    baseUrl: cfg.baseUrl,
    defaultModel: cfg.defaultModel,
    embeddingModel: cfg.embeddingModel,
    hasApiKey: truthy(cfg.apiKey),
    registered,
    timeoutSeconds: cfg.timeoutSeconds,
    local: cfg.local,
  });
}

/** A URL-safe provider id from a display name ("My Local LLM" → "my-local-llm"), capped at
 * 80 chars to match the request id limit. */
function slugify(name) {
  // The result is ASCII, so slicing by UTF-16 unit is slicing by character, as Python does.
  const slug = strip(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");
  return slug || "provider";
}

/** `base`, or `base-2`, `base-3`, … — the first id not already taken. */
function uniqueId(store, base) {
  const existing = new Set(store.list().map((p) => p.id));
  if (!existing.has(base)) return base;
  let n = 2;
  while (existing.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

function checkType(providerType) {
  if (!PROVIDER_TYPES.includes(providerType)) {
    throw new HttpError(400, `unknown providerType ${strRepr(providerType)}. Allowed: ${PROVIDER_TYPES.join(", ")}`);
  }
}

/** Construct + register the adapter so the change takes effect live. A bad config is
 * persisted but logged-not-fatal (matches the prior JV behavior). */
function syncRegister(cfg) {
  try {
    getLlmRegistry().register(construct(cfg));
    return true;
  } catch (e) {
    log.warning(`LLM provider ${cfg.id} persisted but not registered: ${errText(e)}`);
    return false;
  }
}

/** Python's `d.get(k, dflt)` on parsed JSON: a non-dict raises (AttributeError), as it did. */
function dictGet(d, k, dflt) {
  if (!isJsonObject(d)) throw new TypeError(`'${Array.isArray(d) ? "list" : typeof d}' object has no attribute 'get'`);
  return Object.hasOwn(d, k) ? d[k] : dflt;
}

const PARAMS = T.Object({ provider_id: T.String() });

/**
 * Build the /v1/llm-providers router over a host-supplied ProviderStore.
 *
 * `allowKeyReveal` (default OFF, #12 C6): mounts POST `/v1/llm-providers/{id}/key/reveal`,
 * which returns a saved provider's plaintext key (so the UI can pre-fill a masked field the
 * user can edit). A credential-returning endpoint, so its safety is a per-mounting-app
 * property: the HOST must guard mutating `/v1` requests with an origin check (JW's
 * CsrfOriginMiddleware). JW opts IN; an app with no such guard (JustVoice — conditional
 * CORS + bearer auth only, verified 2026-07-17) keeps the SAFE default, so the route is
 * simply absent there. NEVER log the key.
 */
export function makeProviderRouter(getStore, allowKeyReveal = false) {
  return async function providerRouter(app) {
    app.get("/v1/llm-providers", async () => {
      const registeredIds = new Set(getLlmRegistry().ids());
      return model(LLMProviderList, {
        providers: getStore()
          .list()
          .map((c) => toResponse(c, registeredIds.has(c.id))),
      });
    });

    app.post("/v1/llm-providers", { schema: { body: UpsertLLMProviderRequest } }, async (req, reply) => {
      const body = req.body;
      checkType(body.providerType);
      const store = getStore();
      // Derive the id from the name when the client doesn't supply one.
      const providerId = strip(body.id) || uniqueId(store, slugify(body.name));
      if (store.get(providerId) != null) {
        throw new HttpError(400, `LLM provider id ${strRepr(providerId)} already exists`);
      }
      const cfg = model(LLMProviderConfig, {
        id: providerId,
        name: body.name,
        providerType: body.providerType,
        baseUrl: body.baseUrl,
        apiKey: body.apiKey || null,
        defaultModel: body.defaultModel,
        embeddingModel: body.embeddingModel,
        timeoutSeconds: body.timeoutSeconds,
        local: body.local,
      });
      store.add(cfg);
      const registered = syncRegister(cfg);
      reply.code(201);
      return toResponse(cfg, registered);
    });

    app.patch(
      "/v1/llm-providers/:provider_id",
      { schema: { params: PARAMS, body: UpsertLLMProviderRequest } },
      async (req) => {
        const providerId = req.params.provider_id;
        const body = req.body;
        checkType(body.providerType);
        const store = getStore();
        const existing = store.get(providerId);
        if (existing == null) throw new HttpError(404, `LLM provider ${providerId}`);
        // empty string preserves the prior key (write-only field); null clears it.
        const apiKey = body.apiKey === "" ? existing.apiKey : body.apiKey;
        const cfg = model(LLMProviderConfig, {
          id: existing.id, // id is immutable; reassigning would orphan feature pins
          name: body.name,
          providerType: body.providerType,
          baseUrl: body.baseUrl,
          apiKey,
          defaultModel: body.defaultModel,
          embeddingModel: body.embeddingModel,
          timeoutSeconds: body.timeoutSeconds,
          local: body.local,
        });
        store.replace(providerId, cfg);
        getLlmRegistry().deregister(cfg.id);
        const registered = syncRegister(cfg);
        return toResponse(cfg, registered);
      },
    );

    app.delete("/v1/llm-providers/:provider_id", { schema: { params: PARAMS } }, async (req) => {
      const providerId = req.params.provider_id;
      const store = getStore();
      if (store.get(providerId) == null) throw new HttpError(404, `LLM provider ${providerId}`);
      store.remove(providerId);
      getLlmRegistry().deregister(providerId);
      return { deleted: true };
    });

    // Probe the well-known local LLM servers (Ollama :11434, LM Studio :1234) — powers the
    // first-run "Ollama detected → Connect" row.
    app.get("/v1/llm-providers/detect-local", async () => {
      const registeredUrls = new Set(
        getStore()
          .list()
          .map((p) => (p.baseUrl || "").replace(/\/+$/, "")),
      );
      const out = [];
      const probes = [
        [
          "ollama",
          "Ollama (local)",
          "http://127.0.0.1:11434",
          "/api/tags",
          (d) => dictGet(d, "models", []).map((m) => dictGet(m, "name", "")),
        ],
        [
          "openai-compat",
          "LM Studio (local)",
          "http://127.0.0.1:1234",
          "/v1/models",
          (d) => dictGet(d, "data", []).map((m) => dictGet(m, "id", "")),
        ],
      ];
      for (const [ptype, name, base, path, extract] of probes) {
        try {
          const r = await http.fetch(base + path, { timeoutMs: 1500 });
          if (r.status !== 200) continue;
          const models = extract(await r.json()).filter((m) => truthy(m));
          out.push(
            model(DetectedLocalProvider, {
              providerType: ptype,
              name,
              baseUrl: base,
              models,
              alreadyRegistered: registeredUrls.has(base),
            }),
          );
        } catch {
          // a down probe is just "not detected"
        }
      }
      return model(DetectLocalResponse, { detected: out });
    });

    if (allowKeyReveal) {
      // Return a saved provider's plaintext key so the UI can pre-fill a masked, editable
      // field (#12 C6). POST (not GET — a GET is world-readable). Guarded by the host's
      // origin-check middleware; opt-in only. NEVER logged.
      app.post("/v1/llm-providers/:provider_id/key/reveal", { schema: { params: PARAMS } }, async (req) => {
        const cfg = getStore().get(req.params.provider_id);
        if (cfg == null) throw new HttpError(404, `LLM provider ${req.params.provider_id}`);
        return { apiKey: cfg.apiKey || "" };
      });
    }
  };
}
