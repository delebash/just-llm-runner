// SPDX-License-Identifier: MIT
// The ONE reasoning resolver (the port of llm/reasoning.py; U2-T3 2026-07-14, house
// layering + the preset tier 2026-07-16 — the user's "feature is the end of the line").
//
// Turns a task's Reasoning ask (think on/off + an optional Low/Medium/High/XHigh/Max
// level) into the value each provider actually emits. The chain, top down: the PRESET'S
// OWN level, if set (the map's tokens for local, source "preset") → else FOLLOW the
// model's layered `reasoning_budget` switch value (base bundle → hardware-class tune →
// applied model tune, most-specific wins, the SAME switch_resolve every switch uses). Sent
// per request as `reasoning_budget_tokens`, NEVER a launch flag, never clamped, never
// copied — an empty level resolves live against the CURRENT model. Sentinels are honest:
// -1 = unlimited (legal, never seeded), 0 = suppress. CLOUD levels come from the editable
// per-provider `reasoning_map` (word for effort-word adapters, tokens for number
// adapters). No adapter keeps a level→value table; adapters emit what THIS returns.
// Called by the run path (dispatch's applyReasoning) AND by GET /v1/ai/resolved-route
// (the mirror law), so the "runs on" chip can never drift from what a run does.
//
// Synchronous, as in Python: the stores are synchronous and the hardware keys read the
// memo runner/hardware.js fills at boot (`await hardware.ensureDetected()`).

import { pyInt, strip } from "../platform/py.js";
import * as hardware from "../runner/hardware.js";
import * as reasoningMapApi from "./reasoning_map_api.js";
import * as stores from "./stores.js";
import * as switchResolve from "./switch_resolve.js";

// Provider types whose LOCAL runs read the layered `reasoning_budget` SWITCH value (a token
// number) instead of a cloud effort word. Today only the built-in llama.cpp runner.
const LOCAL_TYPES = ["local-llamacpp"];

/** Python's ReasoningPlan dataclass. source — local: "preset"|"tune"|"class"|"base"|
 * "default"|"invalid" · cloud: "map" · "" = none. */
export function ReasoningPlan({ think = false, level = "", word = "", value = null, source = "" } = {}) {
  return { think, level, word, value, source };
}

/** [word, tokens] for (provider, level): the DB `reasoning_map` row, else the seeded type
 * default — the ONE fallback source, shared with the seeder (no duplicate table). */
function mapRow(providerId, providerType, level) {
  const rows = stores.getReasoningMapStore().mapFor(providerId);
  const row = Object.hasOwn(rows, level) ? rows[level] : null;
  if (row != null) return [row.word || "", row.tokens ?? null];
  for (const r of reasoningMapApi.seedRowsForType(providerType)) {
    if (r.level === level) return [r.word || "", r.tokens ?? null];
  }
  return ["", null];
}

/**
 * Resolve the reasoning ask into what this provider/model emits.
 *
 * - think off ⇒ empty plan (local and cloud); the adapter still sends its own off signal
 *   (llama.cpp `enable_thinking=false` + budget 0). Cloud with think on but NO level ⇒
 *   empty plan too (no map row to read).
 * - LOCAL, level SET ⇒ the PRESET'S OWN ask (the feature tier): the local map's tokens for
 *   that level, source "preset". A map row with no tokens (the user blanked it) speaks no
 *   local number ⇒ falls through to follow, and the source shows what actually resolved —
 *   never a silent guess.
 * - LOCAL, level EMPTY ⇒ FOLLOW the model: the layered `reasoning_budget` switch value via
 *   switch_resolve — NO min()/clamp, nothing copied. Sentinels pass through: -1 unlimited,
 *   0 suppress; a non-numeric row ⇒ value null + source "invalid" (thinking visibly off).
 *   No word for local.
 * - Cloud: `word` + `value` straight from the map; a number-speaking cloud (gemini, legacy
 *   Anthropic) carries the map tokens, a word-speaking cloud carries `word`.
 */
export function resolveReasoning({ think, level, providerId, providerType, modelId, classKey = null, hwKey = null }) {
  const plan = ReasoningPlan({ think: !!think, level: level || "" });
  if (!think) return plan;
  if (LOCAL_TYPES.includes(providerType)) {
    if (level) {
      // The preset's own ask — the feature tier, above every model layer.
      const [, tokens] = mapRow(providerId, providerType, level);
      if (tokens != null) {
        plan.value = tokens;
        plan.source = "preset";
        return plan;
      }
      // a level with no local number ⇒ follow (below), honestly labeled by source.
    }
    const ck = classKey ?? hardware.currentClassKey();
    const hk = hwKey ?? hardware.currentMachineKey();
    const [merged, origins] = switchResolve.resolveModelSwitchesWithOrigins(modelId, hk, ck);
    const raw = strip(merged.reasoning_budget || "");
    if (!raw) {
      // last-ditch: no row in any layer (an old DB before a reseed); 1024 = the only
      // tested value; visible via source
      plan.value = 1024;
      plan.source = "default";
    } else {
      try {
        plan.value = pyInt(raw);
        plan.source = Object.hasOwn(origins, "reasoning_budget") ? origins.reasoning_budget : "base";
      } catch {
        // the adapter emits 0 → thinking visibly off, never a silent guess
        plan.value = null;
        plan.source = "invalid";
      }
    }
    return plan;
  }
  // Cloud: no layered budget. The map's tokens (number adapters) + word (effort adapters).
  if (!level) return plan;
  const [word, tokens] = mapRow(providerId, providerType, level);
  plan.word = word;
  plan.value = tokens;
  plan.source = tokens != null ? "map" : "";
  return plan;
}
