// SPDX-License-Identifier: GPL-3.0-or-later
// Token-count + prompt-assembly helpers for the Lab's prompt preview (b1/E2).
//
// estimateTokens is an instant, provider-agnostic HEURISTIC (~chars/3.5, rounded
// up) — a conservative "will this fit?" gut-check, NOT an exact count. The exact
// count comes from the loaded model's own tokenizer via the runner's /tokenize
// endpoint (POST /v1/llm-runner/tokenize); the UI uses the heuristic live and
// upgrades to exact when a local model is running.
//
// assemblePrompt mirrors the server's `render()` {{var}} substitution so the
// preview shows what ACTUALLY gets sent (system + the filled user template).

const CHARS_PER_TOKEN = 3.5;

export function estimateTokens(text) {
  const n = (text || "").length;
  return n ? Math.ceil(n / CHARS_PER_TOKEN) : 0;
}

export function assemblePrompt(system, userTemplate, vars) {
  const sub = (t) => String(t || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars?.[k] ?? ""));
  const sys = sub(system);
  const usr = sub(userTemplate);
  return (sys ? `${sys}\n\n` : "") + usr;
}
