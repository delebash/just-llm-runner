// SPDX-License-Identifier: MIT
// LLM provider registry (the port of llm/registry.py).
//
// A singleton LLMRegistry holds the live adapter instances keyed by provider id.
// `construct(cfg)` picks the adapter class for the `providerType` discriminator; a host
// wires it at boot via `loadFromConfigs(providers)`.
//
// The adapter modules are imported eagerly here (Python imported each inside `construct`):
// they are small — the heavy vendor SDKs behind the cloud adapters load on first use
// (each adapter's `_ensureClient`), which is what Python's _lazy.py bought.

import { getLogger } from "../platform/log.js";
import { ValueError } from "../platform/py.js";
import { AnthropicAdapter } from "./anthropic.js";
import { pyReprStr } from "./base.js";
import { GeminiAdapter } from "./gemini.js";
import { OllamaAdapter } from "./ollama.js";
import { OpenAICompatAdapter } from "./openai_compat.js";
import { OpenAISDKAdapter } from "./openai_sdk.js";

const log = getLogger("llm_runner.llm.registry");

/** Holds registered LLM provider adapters keyed by provider id (insertion order kept —
 * dispatch's "first registered adapter" fallback reads it). */
export class LLMRegistry {
  constructor() {
    this._adapters = new Map();
  }

  register(adapter) {
    this._adapters.set(adapter.provider_id, adapter);
    log.info(
      `LLM provider registered: id=${adapter.provider_id} type=${adapter.provider_type} default_model=${adapter.default_model}`,
    );
  }

  deregister(providerId) {
    this._adapters.delete(providerId);
  }

  get(providerId) {
    return this._adapters.get(providerId) ?? null;
  }

  all() {
    return [...this._adapters.values()];
  }

  ids() {
    return [...this._adapters.keys()];
  }
}

const REGISTRY = new LLMRegistry();

export function getLlmRegistry() {
  return REGISTRY;
}

/**
 * Pick the adapter class for the providerType discriminator. An unknown type throws
 * ValueError — callers catch and log, so a misconfigured entry doesn't kill boot.
 */
export function construct(cfg) {
  const pt = cfg.providerType.toLowerCase();
  const opts = {
    apiKey: cfg.apiKey || "",
    baseUrl: cfg.baseUrl ?? "",
    defaultModel: cfg.defaultModel ?? "",
    timeoutSeconds: cfg.timeoutSeconds ?? 60,
  };
  if (pt === "anthropic") return new AnthropicAdapter(cfg.id, opts);
  if (pt === "openai-compat" || pt === "local-llamacpp") return new OpenAICompatAdapter(cfg.id, pt, opts);
  // The official openai SDK adapter: openai → the Responses API; the rest →
  // chat-completions at each vendor's base_url.
  if (["openai", "deepseek", "openrouter", "xai", "mistral"].includes(pt)) return new OpenAISDKAdapter(cfg.id, pt, opts);
  if (pt === "ollama") return new OllamaAdapter(cfg.id, opts);
  if (pt === "gemini") return new GeminiAdapter(cfg.id, opts);
  throw new ValueError(`unknown LLM providerType: ${pyReprStr(pt)}`);
}

/**
 * Boot helper: construct and register an adapter for each provider config. A failure is
 * logged, never thrown — one bad provider config shouldn't block the app from starting.
 */
export function loadFromConfigs(configs, registry = null) {
  const reg = registry || getLlmRegistry();
  for (const cfg of configs) {
    try {
      reg.register(construct(cfg));
    } catch (e) {
      log.warning(`LLM provider ${cfg?.id ?? "?"} skipped at boot: ${e instanceof Error ? e.message : e}`);
    }
  }
}
