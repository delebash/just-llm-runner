// SPDX-License-Identifier: GPL-3.0-or-later
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
// Returns { content, model }. `content` is the raw model output (callers parse
// JSON themselves, exactly as before).

import { request, requestStream } from "../client.js";
import { useAiTasksStore } from "../stores/aiTasks.js";
import { friendlyAiError } from "./aiErrors.js";

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
// The remaining named params are the Lab's in-editor candidate overrides —
// the SAME set its stream sibling below forwards (temperature/system/
// userTemplate/think/maxTokens) plus the one-shot-only ask-params (topP/
// jsonMode/reasoningEffort/samplers). All optional; forwarded only when set.
export async function runAiFeature({
  action, feature, variables = {}, provider, providerId, model,
  temperature, topP, maxTokens, jsonMode, reasoningEffort, think,
  system, userTemplate, samplers, signal, meta, task,
} = {}) {
  let handle = null;
  let effectiveSignal = signal;
  if (task) {
    const tasks = useAiTasksStore();
    const opts = (typeof task === "object" && task) || {};
    handle = tasks.start({ feature: feature || action, label: opts.label || action, meta: opts.meta || meta || {} });
    effectiveSignal = handle.signal;
    if (signal) {
      if (signal.aborted) handle.cancel();
      else signal.addEventListener?.("abort", () => handle.cancel(), { once: true });
    }
  }

  const body = { action, variables };
  if (provider?.id || providerId) body.providerId = provider?.id || providerId;
  if (model) body.model = model;
  if (typeof temperature === "number") body.temperature = temperature;
  if (typeof topP === "number") body.topP = topP;
  if (maxTokens) body.maxTokens = maxTokens;
  if (typeof jsonMode === "boolean") body.jsonMode = jsonMode;
  if (reasoningEffort) body.reasoningEffort = reasoningEffort;
  if (typeof think === "boolean") body.think = think;
  if (system != null) body.system = system;
  if (userTemplate != null) body.userTemplate = userTemplate;
  if (Array.isArray(samplers) && samplers.length) body.samplers = samplers;

  try {
    const json = await request("/v1/ai/run", { method: "POST", body, signal: effectiveSignal });
    if (handle) handle.finish({ model: json.model });
    // Usage/cost pass through for callers that display them (the Lab's tok/s +
    // cost readout); pre-existing callers keep destructuring { content, model }.
    return {
      content: json.content || "", model: json.model || "",
      promptTokens: json.promptTokens || 0, completionTokens: json.completionTokens || 0,
      cost: json.cost || 0,
    };
  } catch (err) {
    const wrapped = friendlyAiError(err, provider || null);
    if (handle) handle.fail(wrapped);
    throw wrapped;
  }
}

// Streaming counterpart — POSTs /v1/ai/stream through the kit client's SSE
// reader (requestStream: `{delta}` per chunk, a final `{done, promptTokens,
// completionTokens}`, then `[DONE]`). For the interactive features (writer /
// chat / rag) that show live tokens. Same task-panel + error wrapping; the
// SERVER records usage (host-sink) so this doesn't. Returns { content, usage }
// — `usage` is null when the stream ended without a done frame (callers
// surface it to the UI and distinguish "not reported" from zero).
// `onDelta(delta, content)` fires per chunk with the accumulated content.
export async function runAiFeatureStream({ action, feature, variables = {}, history, provider, model, temperature, system, userTemplate, think, maxTokens, signal, onDelta, meta, task } = {}) {
  let handle = null;
  let effectiveSignal = signal;
  if (task) {
    const tasks = useAiTasksStore();
    const opts = (typeof task === "object" && task) || {};
    handle = tasks.start({ feature: feature || action, label: opts.label || action, meta: opts.meta || meta || {} });
    effectiveSignal = handle.signal;
    if (signal) {
      if (signal.aborted) handle.cancel();
      else signal.addEventListener?.("abort", () => handle.cancel(), { once: true });
    }
  }

  const body = { action, variables };
  if (provider?.id) body.providerId = provider.id;
  if (model) body.model = model;
  if (typeof temperature === "number") body.temperature = temperature;
  if (Array.isArray(history) && history.length) body.history = history;
  // In-editor candidate overrides (the Lab test panel streams the draft prompt,
  // not just the live one) — forwarded to /v1/ai/stream's RunRequest.
  if (system != null) body.system = system;
  if (userTemplate != null) body.userTemplate = userTemplate;
  if (typeof think === "boolean") body.think = think;
  if (maxTokens) body.maxTokens = maxTokens;

  let content = "";
  try {
    const usage = await requestStream("/v1/ai/stream", body, (delta) => {
      content += delta;
      if (handle) handle.onDelta(delta, content);
      if (onDelta) onDelta(delta, content);
    }, { signal: effectiveSignal });
    if (handle) handle.finish({ usage, model });
    return { content, model: model || "", usage };
  } catch (err) {
    const wrapped = friendlyAiError(err, provider || null);
    if (handle) handle.fail(wrapped);
    throw wrapped;
  }
}
