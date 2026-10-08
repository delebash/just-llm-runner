// SPDX-License-Identifier: MIT
// Feature → provider dispatch (the port of llm/dispatch.py).
//
// Every app feature (Compose, Speaker-attribution, Critique, …) resolves to a
// provider+model through `resolveFeature` and runs via `chat` / `streamChat`. Dispatch
// reads an `LLMConfig` (schema.js), built by config_builder from the shared stores. The
// precedence chain:
//   1. active production config (the action's own, then the feature's)
//   2. preferred local runner (config.prefer_local_features)
//   3. first registered adapter (fallback)
//
// llm/ never imports runner/ (they are decoupled — install.js is the one coupling point):
// the runner reaches dispatch through the injected seams below, set at boot.

import { getLogger } from "../platform/log.js";
import { RuntimeError, strip, truthy } from "../platform/py.js";
import { errText, head, pyReprStr } from "./base.js";
import * as reasoning from "./reasoning.js";
import { getLlmRegistry } from "./registry.js";
import { getLedger, UsageEntry } from "./usage.js";

const log = getLogger("llm_runner.llm.dispatch");

// The provider_type the bundled local runner's adapter row carries (seed.js) — the busy
// guard below applies ONLY to calls that resolve here: a cloud chat must never mark the
// local GPU busy.
const LOCAL_PROVIDER_TYPE = "local-llamacpp";

// ── the host-injected ensure-local hook (QC-43b) ─────────────────────────────
// A run that resolves to the BUILT-IN runner makes its model resident before dispatch, so
// the first local call doesn't die with "Connection refused" while the router/model isn't
// up yet. install.js points it at the runner service's ensureModelReady. null (standalone
// / non-runner host) → the ensure is skipped.
let ensureLocalModel = null;

/** Host wiring at boot: `async (modelId) => void` that makes a local-runner model resident
 * (resolving once loaded). Pass null to unset. */
export function setEnsureLocalModel(fn) {
  ensureLocalModel = fn;
}

/** The configured ensure-local hook, or null when no host wired one. */
export function getEnsureLocalModel() {
  return ensureLocalModel;
}

// ── the host-injected local-router base URL (2026-08-03) ─────────────────────
// The bundled runner's port is ALLOCATED at spawn, not fixed: every family app used to
// spawn its router on :8080 and the second app's requests then reached the FIRST app's
// process (runner/process.findFreePort records the measured incident). That makes the
// `local-llamacpp` provider's stored baseUrl a guess, and this seam the truth: install.js
// points it at the runner service's routerUrl. null (standalone host, adapter tests) → the
// adapter keeps its configured base URL.
let localRunnerBaseUrl = null;

/** Host wiring at boot: `() => string` returning the LIVE router base URL
 * (`http://127.0.0.1:<allocated port>`), or "" when no router is running. Synchronous —
 * the openai-compat adapter asks it on every request. */
export function setLocalRunnerBaseUrl(fn) {
  localRunnerBaseUrl = fn;
}

/** The configured local-router URL resolver, or null when no host wired one. */
export function getLocalRunnerBaseUrl() {
  return localRunnerBaseUrl;
}

// ── the host-injected llm-busy guard (2026-08-09 VRAM wiring, step 4) ────────
// never-evict-busy's llm half: while a LOCAL-runner chat/stream runs, the arbiter must not
// evict llm-kind residents (a TTS admission mid-generation would kill the model under the
// stream). Lives at THIS layer so every consumer inherits the protection with zero app
// wiring. install.js wires it to the arbiter's busy counters. null → no guard.
let localBusyGuard = null;

/**
 * Host wiring at boot: `() => release` — marks the llm kind busy and returns the function
 * that ends it (Python's context-manager factory: enter = the call, exit = `release()`).
 * Pass null to unset.
 */
export function setLocalBusyGuard(fn) {
  localBusyGuard = fn;
}

/** The llm-busy guard for THIS call — active only when the resolved adapter is the bundled
 * local runner; cloud routes get a no-op. Returns the release function. */
function busyGuard(adapter) {
  if (localBusyGuard !== null && (adapter?.provider_type ?? "") === LOCAL_PROVIDER_TYPE) {
    const release = localBusyGuard();
    return typeof release === "function" ? release : () => {};
  }
  return () => {};
}

// ── the no-model-configured guard message (family parity batch 2026-08-05) ───
// The words a pre-setup run fails with. NEUTRAL by default; an app whose setup wizard has
// its own name feeds its own sentence at boot (JV: "LLM engine setup").
export const DEFAULT_NOT_CONFIGURED_MESSAGE =
  "No model is set. Set up a model on the AI page — run Quick Setup to pick one " +
  "for this machine, or choose a model in the catalog (Set as default).";
let notConfiguredMessage = DEFAULT_NOT_CONFIGURED_MESSAGE;

/** Host wiring at boot: the app-voiced no-model-set guidance. null/"" restores the neutral
 * sentence. */
export function setNotConfiguredMessage(text) {
  notConfiguredMessage = strip(text || "") || DEFAULT_NOT_CONFIGURED_MESSAGE;
}

/** A feature was invoked but nothing resolves (no provider, an unregistered override, no
 * model chosen). The API layer maps it to HTTP 501 so the UI shows the actionable "wire an
 * LLM provider" message rather than a generic 500. */
export class LLMNotConfiguredError extends RuntimeError {
  constructor(m) {
    super(m);
    this.name = "LLMNotConfiguredError";
  }
}

const reg = (registry) => registry || getLlmRegistry();

/** The frozen Lab config for a feature, or null. Precedence step 1. */
export function activeProductionConfig(config, feature) {
  const configs = config.production_configs || [];
  return configs.find((c) => c.feature === feature) ?? null;
}

/** An ACTION's own explicit config (its production config), or null to fall back to its
 * feature. Stops at the action's explicit config: the generic fallbacks (prefer-local /
 * first adapter) belong to the feature, so an action with nothing of its own inherits the
 * feature's resolution. */
function resolveActionOverride(config, action, r) {
  const cfg = activeProductionConfig(config, action);
  if (cfg !== null) {
    const adapter = r.get(cfg.providerId);
    if (adapter !== null) return [adapter, cfg.model || adapter.default_model];
  }
  return null;
}

/**
 * Resolve the `[adapter, model]` pair for a feature key.
 *
 * With `action` (a specific action within the feature, e.g. "writerAI.tighten"), the
 * action's OWN explicit config wins; with nothing of its own it falls back to the feature —
 * the cascade is action → feature → prefer-local → first. `action` null is pure
 * feature-level resolution.
 *
 * Throws LLMNotConfiguredError when nothing resolves.
 */
export function resolveFeature(config, feature, registry = null, { action = null } = {}) {
  const r = reg(registry);

  // Action-level override (most specific) — falls through to the feature below.
  if (action && action !== feature) {
    const hit = resolveActionOverride(config, action, r);
    if (hit !== null) return hit;
  }

  const cfg = activeProductionConfig(config, feature);
  if (cfg !== null) {
    const adapter = r.get(cfg.providerId);
    if (adapter !== null) return [adapter, cfg.model || adapter.default_model];
    log.warning(
      `production config ${pyReprStr(cfg.name)} for ${feature} names unregistered provider ${cfg.providerId} — falling through`,
    );
  }

  // Built-in local runner is the smart default for its target features (e.g.
  // attribution) when nothing more specific is configured.
  if (config.prefer_local_features.has(feature)) {
    const local = r.get(config.local_runner_provider_id);
    if (local !== null) return [local, local.default_model];
  }

  // Nothing routed yet — fall back to the first registered LLM if any.
  const adapters = r.all();
  if (!adapters.length) {
    throw new LLMNotConfiguredError(
      `No LLM provider registered. Add one in the AI engines tab, then route '${feature}' in Routing by feature.`,
    );
  }
  const adapter = adapters[0];
  return [adapter, adapter.default_model];
}

/**
 * The full per-call `[adapter, model]` resolution chat/streamChat run: resolveFeature for
 * the feature/action, then the explicit overrides — a preset's provider/model, or a Lab
 * column's — applied over it. A provider override with no model override lands on that
 * provider's default model. Throws LLMNotConfiguredError on an unregistered override
 * provider or when nothing resolves to a model (the catalog-full / selections-empty
 * factory state).
 *
 * This is also what GET /v1/ai/resolved-route reports, so the read-only "runs on"
 * provenance chips display exactly what a run would do.
 */
export function resolveRoute(config, feature, { registry = null, action = null, providerOverride = null, modelOverride = null } = {}) {
  const r = reg(registry);
  let [adapter, model] = resolveFeature(config, feature, r, { action });
  if (providerOverride) {
    const other = r.get(providerOverride);
    if (other === null) throw new LLMNotConfiguredError(`Provider ${pyReprStr(providerOverride)} isn't registered.`);
    adapter = other;
    if (!modelOverride) model = other.default_model;
  }
  if (modelOverride) model = modelOverride;
  if (!strip(model || "")) {
    // Catalog-full / selections-empty factory state (user, 2026-07-06): nothing is chosen
    // by the seed, so a fresh box reaching an AI feature before setup gets guidance, not a
    // raw provider error. The words are app-configurable (setNotConfiguredMessage).
    throw new LLMNotConfiguredError(notConfiguredMessage);
  }
  return [adapter, model];
}

/**
 * The gate removal's one addition (ruled 2026-08-06): when a run that carried the thinking
 * parameter fails AND the provider's own message is about that parameter, re-throw with
 * the provider's words plus ONE sentence naming the fix. No capability guessing — the
 * match is on the provider's OWN prose about the parameter we sent; every other error
 * (auth, timeout, quota) passes through untouched.
 */
function raiseWithThinkHint(e, { thinkWasOn }) {
  if (!thinkWasOn) return;
  const text = errText(e);
  if (!/reasoning|thinking/i.test(text)) return;
  const err = new RuntimeError(
    `${text} — this usually means the model can't think: turn thinking off on this feature's preset, or pick another model.`,
  );
  err.cause = e;
  throw err;
}

/**
 * Map the reasoning ASK (the raw level carried in `reasoning_effort`, injected by
 * prompts' plane-2 extra) into what the RESOLVED provider/model actually emits — the ONE
 * place the resolved model is finally known. Replaces the level with the resolved effort
 * `word` + `reasoning_budget_tokens` (LOCAL: the layered switch value, no clamp;
 * number-speaking cloud: the map tokens); each adapter pops BOTH (base.popReasoning) and
 * emits only the one its backend speaks. A no-op unless reasoning is on for this call.
 */
function applyReasoning(extra, adapter, model, { think }) {
  if (!truthy(extra) || !Object.hasOwn(extra, "reasoning_effort")) return extra;
  const level = extra.reasoning_effort || "";
  const e = { ...extra };
  delete e.reasoning_effort;
  // An EMPTY level with think on is a real state (2026-07-16 preset tier): local ⇒ follow
  // the model's layered budget; cloud ⇒ the resolver returns an empty plan (provider
  // default). Only think-off short-circuits.
  if (!think) return truthy(e) ? e : null;
  const plan = reasoning.resolveReasoning({
    think,
    level,
    providerId: adapter.provider_id,
    providerType: adapter.provider_type,
    modelId: model,
  });
  if (plan.word) e.reasoning_effort = plan.word;
  if (plan.value != null) e.reasoning_budget_tokens = plan.value;
  return truthy(e) ? e : null;
}

const now = () => performance.now() / 1000;

/**
 * One-shot LLM call for a feature key → LLMResponse.
 *
 * `action` (optional) routes to the action's own model when it has one, else the feature
 * default. `think` null means OFF — the preset is the ONE thinking control and the feature
 * router always passes its resolved value. `temperature: null` omits the parameter.
 */
export async function chat({
  config,
  feature,
  messages,
  system = null,
  temperature = 0.7,
  maxTokens = null,
  think = null,
  modelOverride = null,
  providerOverride = null,
  registry = null,
  action = null,
  extra = null,
}) {
  const [adapter, model] = resolveRoute(config, feature, { registry, action, providerOverride, modelOverride });
  const effThink = !!think;
  // NO send-time veto (the gate REMOVAL, ruled 2026-08-06: "no fancy magic"): the request
  // carries thinking exactly as configured. A provider that can't take the parameter
  // answers with its own error; raiseWithThinkHint adds the fix line.
  const ext = applyReasoning(extra, adapter, model, { think: effThink });

  const started = now();
  let resp;
  try {
    const release = busyGuard(adapter);
    try {
      resp = await adapter.chat([...messages], { model, temperature, maxTokens, system, think: effThink, extra: ext });
    } finally {
      release();
    }
  } catch (e) {
    getLedger().record(
      UsageEntry({
        feature,
        model,
        prompt_tokens: 0,
        completion_tokens: 0,
        duration_ms: Math.trunc((now() - started) * 1000),
        ok: false,
        error: head(errText(e), 200),
        provider_id: adapter.provider_id,
      }),
    );
    raiseWithThinkHint(e, { thinkWasOn: effThink });
    throw e;
  }
  getLedger().record(
    UsageEntry({
      feature,
      model: resp.model || model,
      prompt_tokens: resp.prompt_tokens,
      completion_tokens: resp.completion_tokens,
      duration_ms: Math.trunc((now() - started) * 1000),
      ok: true,
      provider_id: adapter.provider_id,
    }),
  );
  return resp;
}

/**
 * The streaming counterpart of `chat`: the same resolution (incl. the action override),
 * yields StreamDelta events (text deltas, then one `done` event) and records usage at the
 * end from the done event's token counts. Nothing runs until the first `next()` — as with
 * Python's generator, a not-configured error surfaces on first iteration.
 */
export async function* streamChat({
  config,
  feature,
  messages,
  system = null,
  temperature = 0.7,
  maxTokens = null,
  think = null,
  modelOverride = null,
  providerOverride = null,
  registry = null,
  action = null,
  extra = null,
}) {
  const [adapter, model] = resolveRoute(config, feature, { registry, action, providerOverride, modelOverride });
  const effThink = !!think;
  // NO send-time veto — the same law as chat() above.
  const ext = applyReasoning(extra, adapter, model, { think: effThink });

  const started = now();
  let pt = 0;
  let ct = 0;
  try {
    // The busy guard spans the WHOLE stream (held across yields; released when the stream
    // ends, fails or its consumer stops early) — a mid-stream eviction is exactly what
    // never-evict-busy exists to prevent.
    const release = busyGuard(adapter);
    try {
      for await (const delta of adapter.streamChat([...messages], {
        model,
        temperature,
        maxTokens,
        system,
        think: effThink,
        extra: ext,
      })) {
        if (delta.done) {
          pt = delta.prompt_tokens;
          ct = delta.completion_tokens;
          // Stamp the RESOLVED model on the done event (adapters leave it empty) so the
          // SSE done frame can report model + cost — the stream carries everything /run's
          // response carries.
          delta.model = model;
        }
        yield delta;
      }
    } finally {
      release();
    }
  } catch (e) {
    getLedger().record(
      UsageEntry({
        feature,
        model,
        prompt_tokens: 0,
        completion_tokens: 0,
        duration_ms: Math.trunc((now() - started) * 1000),
        ok: false,
        error: head(errText(e), 200),
        provider_id: adapter.provider_id,
      }),
    );
    raiseWithThinkHint(e, { thinkWasOn: effThink });
    throw e;
  }
  getLedger().record(
    UsageEntry({
      feature,
      model,
      prompt_tokens: pt,
      completion_tokens: ct,
      duration_ms: Math.trunc((now() - started) * 1000),
      ok: true,
      provider_id: adapter.provider_id,
    }),
  );
}
