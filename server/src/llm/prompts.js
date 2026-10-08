// SPDX-License-Identifier: MIT
// `FeaturePromptRow` — from llm/prompts.py. The rest of prompts.py (the template renderer,
// the prompts router, the Lab run routes) is ported in wave 2.

/**
 * One action's editable prompt — the dispatch-time + Lab-edit view of a `feature_prompts`
 * row. Prompt TEXT + the JSON CONTRACT (`json_mode`/`json_schema`, kept on the action
 * because the app's parsers are per-action) + nav metadata (`label`/`description`/
 * `group`). EVERY tunable (temperature/top_p/think/reasoning/max_tokens) moved to the
 * engine preset 2026-07-15 — the one source. `label` empty → the UI derives a name.
 *
 * Python's dataclass, internal plumbing (never serialized as-is), so it keeps its snake
 * field names.
 */
export function FeaturePromptRow({
  key,
  feature,
  system,
  user_template,
  built_in,
  json_mode = false, // response_format=json_object (#18) — the action's JSON CONTRACT
  json_schema = "", // optional JSON Schema text — with json_mode on, upgrades to schema-enforced output
  label = "",
  description = "",
  group = "",
}) {
  return { key, feature, system, user_template, built_in, json_mode, json_schema, label, description, group };
}
