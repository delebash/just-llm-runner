# SPDX-License-Identifier: GPL-3.0-or-later
"""The ONE reasoning resolver (U2-T3, 2026-07-14; house-layering 2026-07-16; the preset
tier added the same day — the user's "feature is the end of the line"). Turns a task's
Reasoning ask (think on/off + an optional Low/Medium/High/XHigh/Max level) into the value
each provider actually emits. The chain, top down: the PRESET'S OWN level, if set (the
map's tokens for local, source "preset") → else FOLLOW the model's layered
`reasoning_budget` switch value (base bundle → hardware-class tune → applied model tune,
most-specific wins, the SAME `switch_resolve` every switch uses). Sent per request as
`reasoning_budget_tokens`, NEVER a launch flag, never clamped, never copied — an empty
level resolves live against the CURRENT model. Sentinels are honest: -1 = unlimited
(legal, never seeded), 0 = suppress. CLOUD levels come from the editable per-provider
`reasoning_map` (word for effort-word adapters, tokens for number adapters). No adapter
keeps a level→value table; adapters emit what THIS returns. Called by the run path
(`dispatch._apply_reasoning`) AND by GET /v1/ai/resolved-route (the mirror law) so the
"runs on" chip can never drift from what a run does."""
from __future__ import annotations

from dataclasses import dataclass

# Provider types whose LOCAL runs read the layered `reasoning_budget` SWITCH value (a token
# number) instead of a cloud effort word. Today only the built-in llama.cpp runner.
_LOCAL_TYPES = ("local-llamacpp",)


@dataclass
class ReasoningPlan:
    think: bool = False           # effective on/off for this call
    level: str = ""               # the ask level; carried for display
    word: str = ""                # effort word to emit (word-speaking adapters); "" = none
    value: int | None = None      # the budget number emitted; None = no number
    source: str = ""              # local: "preset"|"tune"|"class"|"base"|"default"|"invalid" · cloud: "map" · "" = none


def _map_row(provider_id: str, provider_type: str, level: str) -> tuple[str, int | None]:
    """(word, tokens) for (provider, level): the DB `reasoning_map` row, else the seeded
    type default — the ONE fallback source, shared with the seeder (no duplicate table)."""
    from . import stores
    from .reasoning_map_api import seed_rows_for_type
    row = stores.get_reasoning_map_store().map_for(provider_id).get(level)
    if row is not None:
        return row.word or "", row.tokens
    for r in seed_rows_for_type(provider_type):
        if r.level == level:
            return r.word or "", r.tokens
    return "", None


def resolve_reasoning(
    *,
    think: bool,
    level: str,
    provider_id: str,
    provider_type: str,
    model_id: str,
    class_key: str | None = None,
    hw_key: str | None = None,
) -> ReasoningPlan:
    """Resolve the reasoning ask into what this provider/model emits.

    - think off ⇒ empty plan (both local and cloud); the adapter still sends its own off
      signal (llama.cpp `enable_thinking=False` + budget 0). Cloud with think on but NO
      level ⇒ empty plan too (no map row to read).
    - LOCAL, level SET ⇒ the PRESET'S OWN ask (the feature tier — "feature is the end of
      the line", user 2026-07-16): the local map's tokens for that level, source "preset".
      A map row with no tokens (user blanked it) speaks no local number ⇒ falls through
      to follow, and the source line shows what actually resolved — never a silent guess.
    - LOCAL, level EMPTY ⇒ FOLLOW the model: the layered `reasoning_budget` switch value
      (base bundle → hardware-class tune → applied model tune, most-specific wins), read
      by the SAME `switch_resolve` every switch uses — NO min()/clamp. Nothing is copied:
      empty resolves live against the CURRENT model. Sentinels pass through honest: -1
      unlimited, 0 suppress; a non-numeric row ⇒ value None + source "invalid" (thinking
      visibly off). No word for local.
    - Cloud: `word` + `value` straight from the map; a number-speaking cloud (gemini,
      legacy Anthropic) carries the map tokens, a word-speaking cloud carries `word`.
    """
    plan = ReasoningPlan(think=bool(think), level=level or "")
    if not think:
        return plan
    if provider_type in _LOCAL_TYPES:
        if level:
            # The preset's own ask — the feature tier, above every model layer.
            _word, tokens = _map_row(provider_id, provider_type, level)
            if tokens is not None:
                plan.value, plan.source = tokens, "preset"
                return plan
            # level with no local number ⇒ follow (below), honestly labeled by source.
        from . import switch_resolve
        if class_key is None:
            from ..runner.hardware import current_class_key
            class_key = current_class_key()
        if hw_key is None:
            from ..runner.hardware import current_machine_key
            hw_key = current_machine_key()
        merged, origins = switch_resolve.resolve_model_switches_with_origins(model_id, hw_key, class_key)
        raw = (merged.get("reasoning_budget") or "").strip()
        if not raw:
            plan.value, plan.source = 1024, "default"   # last-ditch: no row in any layer (old DB pre-reseed); 1024 = the only tested value; visible via source
        else:
            try:
                plan.value, plan.source = int(raw), origins.get("reasoning_budget", "base")
            except ValueError:
                plan.value, plan.source = None, "invalid"   # adapter emits 0 → thinking visibly off, never a silent guess
        return plan
    # Cloud: no layered budget. The map's tokens (number adapters) + word (effort adapters).
    if not level:
        return plan
    plan.word, tokens = _map_row(provider_id, provider_type, level)
    plan.value = tokens
    plan.source = "map" if tokens is not None else ""
    return plan
