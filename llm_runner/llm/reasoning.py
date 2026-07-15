# SPDX-License-Identifier: GPL-3.0-or-later
"""The ONE reasoning resolver (U2-T3, 2026-07-14). Turns a task's Reasoning "ask"
(think on/off + a Low/Medium/High/XHigh/Max level) into the value each provider actually
emits, reading the editable per-provider `reasoning_map` and — for a LOCAL run — the
tested per-(model, hardware-class) budget cap, else the global default cap. After this
plan NO adapter keeps a level→value table (anthropic.py / gemini.py both drop theirs);
adapters emit what THIS returns. Called by the run path (`dispatch._apply_reasoning`,
after `resolve_route` resolves the real provider/model) AND by GET /v1/ai/resolved-route
(the mirror law) so the "runs on" chip can never drift from what a run does."""
from __future__ import annotations

from dataclasses import dataclass

# Provider types whose LOCAL runs honor a hardware BUDGET (a token number) instead of an
# effort word; the cap applies only to these. Today only the built-in llama.cpp runner.
_LOCAL_TYPES = ("local-llamacpp",)

_CAP_LAST_DITCH = 8192  # matches the reasoning_cap_default seed — used only if the row is gone


@dataclass
class ReasoningPlan:
    think: bool = False           # effective on/off for this call
    level: str = ""               # the ask level (low|medium|high|xhigh|max) or ""
    word: str = ""                # effort word to emit (word-speaking adapters); "" = none
    ask: int | None = None        # the requested budget number from the map (pre-cap)
    cap: int | None = None        # local hardware cap (None = no cap / cloud)
    effective: int | None = None  # the budget number actually emitted (local: min(ask, cap))
    cap_source: str = ""          # "class" | "default" | "" (cloud / none)


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


def _cap_for(model_id: str, class_key: str) -> tuple[int, str]:
    """The LOCAL thinking cap: the tested per-(model, class) `reasoning_budget` tune (the
    SAME ClassTune rows `switch_resolve` reads), else the global `reasoning_cap_default`."""
    from . import db
    s = db.session()
    try:
        if class_key and model_id:
            row = (
                s.query(db.ClassTune)
                .filter(
                    db.ClassTune.model_id == model_id,
                    db.ClassTune.class_key == class_key,
                    db.ClassTune.flag_name == "reasoning_budget",
                )
                .first()
            )
            if row is not None and str(row.flag_value).strip():
                try:
                    return int(row.flag_value), "class"
                except ValueError:
                    pass
        setting = s.query(db.RunnerSetting).filter(db.RunnerSetting.key == "reasoning_cap_default").first()
        if setting is not None and str(setting.value).strip():
            try:
                return int(setting.value), "default"
            except ValueError:
                pass
    finally:
        s.close()
    return _CAP_LAST_DITCH, "default"


def resolve_reasoning(
    *,
    think: bool,
    level: str,
    provider_id: str,
    provider_type: str,
    model_id: str,
    class_key: str | None = None,
) -> ReasoningPlan:
    """Resolve the reasoning ask into what this provider/model emits.

    - think off (or no level) ⇒ everything empty; the adapter still sends its own off
      signal (llama.cpp `enable_thinking=False` + budget 0).
    - LOCAL (budget provider): effective = min(ask, cap); Max / no number ⇒ the cap. The
      cap is the tested class tune or the global default, ALWAYS reported (`cap_source`).
    - Cloud: `word` + `ask` straight from the map, no cap; a number-speaking cloud (gemini,
      legacy Anthropic) emits `ask`, a word-speaking cloud emits `word`.
    """
    plan = ReasoningPlan(think=bool(think), level=level or "")
    if not think or not level:
        return plan
    plan.word, plan.ask = _map_row(provider_id, provider_type, level)
    if provider_type in _LOCAL_TYPES:
        if class_key is None:
            from ..runner.hardware import current_class_key
            class_key = current_class_key()
        plan.cap, plan.cap_source = _cap_for(model_id, class_key)
        # Max / no number ⇒ run at the cap; else the smaller of the ask and the cap.
        plan.effective = plan.cap if plan.ask is None else min(plan.ask, plan.cap)
    else:
        # Cloud: no local cap. Number-speaking clouds emit `ask`; word-speaking clouds
        # emit `word` (effective stays the ask so resolved-route can display a number
        # where one exists — the adapter chooses word vs number by its generation).
        plan.effective = plan.ask
    return plan
