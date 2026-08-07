// SPDX-License-Identifier: MIT
// Client wrapper for SERVER-SIDE AI features. Feature calls POST to the shared
// /v1/ai/run + /v1/ai/stream endpoints both apps mount, where the server
// renders the action's prompt template and dispatches through the shared
// llm_runner dispatch (resolving the provider from the user's pins / default,
// and recording usage via the host-sink). So this helper holds NO
// provider/model resolution — only the cross-cutting pieces a caller shouldn't
// re-implement: global task-panel registration (elapsed / cancel via
// stores/aiTasks.js) and readable error wrapping (aiErrors.js). Transport is
// the kit client (request/requestStream against the configureLlmUi base).
//
// §7.4 (B6-1): streaming is ON everywhere — runAiFeature keeps its one-shot
// call-site contract ({ content, model, promptTokens, completionTokens, cost })
// but runs the STREAM transport under the hood, so every feature (JSON tasks
// too) gets live progress in the task strip; deltas drive progress ONLY —
// callers still parse the final content. AUTOMATIC fallback, no knob: retry
// ONCE via /v1/ai/run only on a transport-level failure with ZERO frames
// received (pre-stream HTTP error / network TypeError) — never on an in-stream
// {error} frame (a provider error identical on both paths) and never on abort.

import { request, requestStream } from "../client.js";
import { useAiTasksStore } from "../stores/aiTasks.js";
import { friendlyAiError } from "./aiErrors.js";

// Task-panel registration shared by both wrappers: `task` = true | { label,
// meta } registers in the global AI task panel; a caller-supplied `signal` is
// ORed with the task's own controller.
//
// Exported 2026-08-07 for ConfigColumn's ADAPTER path, which needs the identical
// registration but not the /v1/ai transport — see runViaAdapter. Kit-internal only:
// index.js names `runAiFeature`/`runAiFeatureStream` from this module explicitly, so
// this does not widen the package's public API. The adapter path must never grow its
// own copy of the signal-ORing below.
export function startTaskHandle({ task, feature, action, meta, signal }) {
  if (!task) return { handle: null, effectiveSignal: signal };
  const tasks = useAiTasksStore();
  const opts = (typeof task === "object" && task) || {};
  const handle = tasks.start({
    feature: feature || action,
    label: opts.label || action,
    meta: opts.meta || meta || {},
  });
  if (signal) {
    if (signal.aborted) handle.cancel();
    else signal.addEventListener?.("abort", () => handle.cancel(), { once: true });
  }
  return { handle, effectiveSignal: handle.signal };
}

// The ONE RunRequest body builder both wrappers share (§7.4 ended their
// divergence — the stream path takes the full ask-param set server-side, so
// the client forwards it identically). All optional; sent only when set.
function buildRunBody({
  action, variables, provider, providerId, model, temperature, topP,
  maxTokens, jsonMode, reasoningEffort, think, system, userTemplate,
  samplers, history,
}) {
  const body = { action, variables };
  if (provider?.id || providerId) body.providerId = provider?.id || providerId;
  if (model) body.model = model;
  if (typeof temperature === "number") body.temperature = temperature;
  if (typeof topP === "number") body.topP = topP;
  if (maxTokens) body.maxTokens = maxTokens;
  if (typeof jsonMode === "boolean") body.jsonMode = jsonMode;
  // != null, not truthy: "" is a REAL override (2026-07-16 preset tier — an explicit
  // empty level means "follow the model / provider default", overriding the preset's
  // stored level; dropping it would silently fall back to that stored level).
  if (reasoningEffort != null) body.reasoningEffort = reasoningEffort;
  if (typeof think === "boolean") body.think = think;
  if (system != null) body.system = system;
  if (userTemplate != null) body.userTemplate = userTemplate;
  if (Array.isArray(samplers) && samplers.length) body.samplers = samplers;
  if (Array.isArray(history) && history.length) body.history = history;
  return body;
}

// True when a stream failure is a genuine transport failure the /run fallback
// can help with: nothing arrived (zero frames), it wasn't an in-stream {error}
// frame (tagged by requestStream), and the caller didn't abort.
function shouldFallBack(err, framesSeen, signal) {
  if (framesSeen > 0) return false;
  if (err?.streamErrorFrame) return false;
  if (err?.name === "AbortError" || signal?.aborted) return false;
  return true;
}

// `action`   — catalog id on the server (e.g. "critique", "critiqueStructure").
// `feature`  — routing key for the task panel label/grouping (defaults to action).
// `variables`— filled into the action's server-side user_template ({{var}}).
// `provider` — optional provider OBJECT override (the Lab compares providers);
//              only its id is sent — the server resolves + injects the key.
// `providerId` — the same override as a plain id string (Lab columns hold ids,
//              not objects); `provider` wins when both are given.
// `model`    — optional model id override.
// `signal`   — optional caller AbortSignal (ORed with the task's own).
// `task`     — true | { label, meta } to register in the global AI task panel.
// The remaining named params are the Lab's in-editor candidate overrides +
// ask-params (temperature/system/userTemplate/think/maxTokens/topP/jsonMode/
// reasoningEffort/samplers) — the SAME set the stream sibling forwards.
// Returns { content, model, promptTokens, completionTokens, cost } — `content`
// is the raw model output (callers parse JSON themselves, exactly as before).
export async function runAiFeature({
  action, feature, variables = {}, provider, providerId, model,
  temperature, topP, maxTokens, jsonMode, reasoningEffort, think,
  system, userTemplate, samplers, signal, meta, task,
} = {}) {
  const { handle, effectiveSignal } = startTaskHandle({ task, feature, action, meta, signal });
  const body = buildRunBody({
    action, variables, provider, providerId, model, temperature, topP,
    maxTokens, jsonMode, reasoningEffort, think, system, userTemplate, samplers,
  });

  let content = "";
  let framesSeen = 0;
  try {
    let usage = null;
    try {
      usage = await requestStream("/v1/ai/stream", body, (delta) => {
        framesSeen += 1;
        content += delta;
        if (handle) handle.onDelta(delta, content);
      }, {
        signal: effectiveSignal,
        // Prompt-eval progress (builtin engine only — §7.4 B6-2): a real
        // "reading prompt N%" in the strip instead of a dead TTFT bar.
        onProgress: (p) => {
          framesSeen += 1;
          if (handle) handle.setPrefill(p);
        },
      });
    } catch (err) {
      if (!shouldFallBack(err, framesSeen, effectiveSignal)) throw err;
      // §7.4 automatic fallback: the stream transport failed before ANYTHING
      // arrived — retry once as a one-shot /run (same body, same server path).
      const json = await request("/v1/ai/run", { method: "POST", body, signal: effectiveSignal });
      content = json.content || "";
      usage = {
        promptTokens: json.promptTokens || 0,
        completionTokens: json.completionTokens || 0,
        model: json.model || "",
        cost: json.cost || 0,
      };
    }
    if (handle) handle.finish({ usage, model: usage?.model || model });
    // Usage/cost pass through for callers that display them (the Lab's tok/s +
    // cost readout); pre-existing callers keep destructuring { content, model }.
    return {
      content,
      model: usage?.model || "",
      promptTokens: usage?.promptTokens || 0,
      completionTokens: usage?.completionTokens || 0,
      cost: usage?.cost || 0,
    };
  } catch (err) {
    const wrapped = friendlyAiError(err, provider || null);
    if (handle) handle.fail(wrapped);
    throw wrapped;
  }
}

// Streaming counterpart for callers that consume LIVE tokens (writer / chat /
// rag) — POSTs /v1/ai/stream through the kit client's SSE reader (`{delta}`
// per chunk, optional `{progress}` prompt-eval frames, a final `{done,
// promptTokens, completionTokens, model, cost}`, then `[DONE]`). Same
// task-panel + error wrapping + ask-param body as runAiFeature (§7.4 — the two
// wrappers no longer diverge); the SERVER records usage (host-sink) so this
// doesn't. NO /run fallback here: these callers render deltas as they arrive,
// so a silent one-shot retry would change what the user sees mid-surface.
// Returns { content, model, usage } — `usage` is null when the stream ended
// without a done frame (callers surface it to the UI and distinguish "not
// reported" from zero). `onDelta(delta, content)` fires per chunk with the
// accumulated content.
export async function runAiFeatureStream({
  action, feature, variables = {}, history, provider, providerId, model,
  temperature, topP, maxTokens, jsonMode, reasoningEffort, think,
  system, userTemplate, samplers, signal, onDelta, meta, task,
} = {}) {
  const { handle, effectiveSignal } = startTaskHandle({ task, feature, action, meta, signal });
  const body = buildRunBody({
    action, variables, provider, providerId, model, temperature, topP,
    maxTokens, jsonMode, reasoningEffort, think, system, userTemplate,
    samplers, history,
  });

  let content = "";
  try {
    const usage = await requestStream("/v1/ai/stream", body, (delta) => {
      content += delta;
      if (handle) handle.onDelta(delta, content);
      if (onDelta) onDelta(delta, content);
    }, {
      signal: effectiveSignal,
      onProgress: (p) => { if (handle) handle.setPrefill(p); },
    });
    if (handle) handle.finish({ usage, model: usage?.model || model });
    return { content, model: usage?.model || model || "", usage };
  } catch (err) {
    const wrapped = friendlyAiError(err, provider || null);
    if (handle) handle.fail(wrapped);
    throw wrapped;
  }
}
