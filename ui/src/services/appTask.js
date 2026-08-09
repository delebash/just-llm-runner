// SPDX-License-Identifier: MIT
// THE APP-TASK RUNNERS — the second half of the family AI-call convention
// (decided 2026-08-08; the first half is services/aiFeature.js).
//
// `runAiFeature` covers features whose variables sit in the renderer's hand:
// it posts the shared /v1/ai endpoints and everything downstream is kit-owned.
// But two of the three apps also have SERVER-COMPOSED features — endpoints that
// gather their own context (a character roster, a corrections history, a
// directory of locale files) and post-process their answers (row parsing,
// confidence floors, file writes) — plus non-LLM long work (TTS renders,
// engine installs, batch jobs). Before this file, every such call site
// hand-managed its own task: ~15 lines of start/finish/fail/abort each, and
// every one of them forgot something — usually `finish({usage})`, which is why
// no hand-rolled site ever showed a token even though the servers returned the
// counts on every response.
//
// The contract this file exists to enforce (docs/app-structure.md, the AI-call
// convention): APP CODE NEVER OWNS A TASK LIFECYCLE. It either calls
// `runAiFeature`, or it wraps its work in `withAiTask` below. check-family's
// check 11 holds the line: only allowlisted read-only chrome may import the
// task store directly.

import { useAiTasksStore } from "../stores/aiTasks.js";

/** Map a server usage object to the shape `finish()` expects. Accepts the
 * family's snake_case `RunUsage` (`prompt_tokens`, from server-composed
 * endpoints) AND already-camel usage (`promptTokens`, from /v1/ai responses),
 * so call sites never hand-translate. Returns null when there is nothing —
 * "not reported" must stay distinguishable from a real zero. */
export function toTaskUsage(u) {
  if (!u || typeof u !== "object") return null;
  const promptTokens = u.promptTokens ?? u.prompt_tokens ?? 0;
  const completionTokens = u.completionTokens ?? u.completion_tokens ?? 0;
  if (!promptTokens && !completionTokens) return null;
  return { promptTokens, completionTokens };
}

/**
 * Run `fn` as ONE task on the shared AI queue, with the lifecycle owned here.
 *
 *   const r = await withAiTask(
 *     { feature: "speaker_attribution", label: `Speaker extraction · ${title}`,
 *       stats: [`${words} words in`], onRetry: () => runAnalyze() },
 *     async (task) => {
 *       const r = await api.request(path, { signal: task.signal, ... });
 *       task.setStats([...]);                  // domain numbers, any time
 *       return { result: r, usage: r.usage, model: r.usage?.model };
 *     },
 *   );
 *
 * `fn` receives the task handle (signal / setStats / setProgress / update /
 * onDelta) and keeps FULL domain freedom — blob responses, poll loops, batch
 * fan-outs. It returns either the bare result, or `{ result, usage?, model? }`
 * to surface token counts (usage in snake_case or camelCase — both accepted).
 *
 * Guarantees, so no call site re-implements them wrong:
 *   - exactly one outcome: finish (with usage) / cancel (signal aborted) / fail
 *   - the error is re-thrown UNCHANGED — app endpoints speak the family's
 *     problem-details envelope, whose messages are already the good ones, and
 *     call sites branch on `.status` (a 501 means "no LLM wired"). Provider
 *     humanizing (friendlyAiError) belongs to the /v1/ai lane, where the raw
 *     error really is a provider's.
 *   - an abort surfaces as the store's cancel, never as a red failure
 *
 * Options: `feature` (required), `label`, `stats`, `meta`, `onRetry`,
 * `lingerMs`, `inline` (the surface renders its own AiTaskStrip, so the
 * global stack must not show the run twice), `signal` (an outer AbortSignal,
 * ORed with the task's own — same contract as runAiFeature).
 */
export async function withAiTask(opts, fn) {
  const { signal, ...startOpts } = opts || {};
  const tasks = useAiTasksStore();
  const task = tasks.start(startOpts);
  if (signal) {
    if (signal.aborted) task.cancel();
    else signal.addEventListener?.("abort", () => task.cancel(), { once: true });
  }
  try {
    const out = await fn(task);
    const wrapped = out && typeof out === "object" && "result" in out;
    task.finish({
      usage: toTaskUsage(wrapped ? out.usage : out?.usage),
      model: (wrapped ? out.model : out?.model) || undefined,
    });
    return wrapped ? out.result : out;
  } catch (err) {
    // On abort, cancel() already recorded the outcome — first-outcome-wins
    // makes a late fail a no-op, so classifying here just keeps it honest.
    if (!task.signal.aborted) task.fail(err);
    throw err;
  }
}

/**
 * The JSON convenience over `withAiTask` for the common server-composed shape:
 * POST an app endpoint, take `usage` from the response (§16: every AI response
 * carries it), show tokens. `request` is the app's transport function
 * `(path, { method, headers, body, signal }) => json` — passed in, not
 * imported, so the runner works over any app's client (JV's `api.request`,
 * the kit client's `request`, a test fake).
 *
 *   const r = await runAiEndpoint({
 *     request: (p, o) => api.request(p, o),
 *     path: `/v1/scenes/${id}/analyze`,
 *     body: { text },
 *     task: { feature: "speaker_attribution", label: "Speaker extraction" },
 *   });
 */
export async function runAiEndpoint({ request, path, body, method = "POST", task }) {
  return withAiTask(task, async (t) => {
    const r = await request(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: t.signal,
    });
    return { result: r, usage: r?.usage, model: r?.usage?.model || r?.model };
  });
}
