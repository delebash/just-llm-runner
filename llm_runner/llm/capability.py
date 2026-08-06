# SPDX-License-Identifier: MIT
"""Model THINKING capability — the one resolver behind the capability gate
(approved 2026-08-06; the decision text lives in JustVoice's TASKS).

The gate's law: effective thinking = the preset's think (the task's tested
want) AND the model can think. This module answers the second half with
three layers of honesty:

  1. The model catalog row's `thinking` flag — curated/user-owned data,
     editable in the catalog UI. Trusted absolutely when a row exists.
  2. Family name patterns — for ids we have no row for (an Ollama tag, a
     cloud id typed into a provider). Both directions, unambiguous families
     only; `tiers._REASONING_FIRST` is the local-family donor knowledge.
  3. Unknown → None — the gate PERMITS (today's behavior). The gate may only
     ever remove asks we KNOW are dead; it must never make anything worse.

Why the gate exists at all: under think-on the run attaches the provider's
reasoning ask (OpenAI `reasoning_effort`, Anthropic budgets, …); sent to a
non-reasoning cloud model that is an API ERROR, and locally it's a dead key.
A model that always reasons (o1-class) cannot be gated OFF — the checkbox
means "ask for thinking where the model offers the choice".
"""

from __future__ import annotations

import re

from . import db
from .tiers import _REASONING_FIRST

# Families KNOWN to offer thinking (beyond the local reasoning-first list):
# hybrid/thinking chat models and cloud reasoning series. Substring/regex on
# the lowercased id — same matching philosophy as tiers.classify.
_THINKER_PATTERNS = [
    re.compile(r"qwen-?3", re.IGNORECASE),            # the whole Qwen3 family is hybrid (0.6B up)
    re.compile(r"\bo[134](-mini|-pro)?\b", re.IGNORECASE),  # OpenAI o-series
    re.compile(r"gpt-5", re.IGNORECASE),
    re.compile(r"deepseek-reasoner", re.IGNORECASE),
    re.compile(r"claude-3-7", re.IGNORECASE),          # extended thinking begins here
    re.compile(r"claude-(haiku|sonnet|opus|fable)-[4-9]", re.IGNORECASE),
    re.compile(r"gemini-[23]", re.IGNORECASE),         # 2.x/3 are thinking-capable
    re.compile(r"grok-[3-9]", re.IGNORECASE),
    re.compile(r"think", re.IGNORECASE),               # "-thinking"/"think" variants say it themselves
    re.compile(r"\breasoning\b", re.IGNORECASE),
]

# Families KNOWN to offer no thinking control — the dead-ask/API-error class.
# Deliberately tight: only unambiguous, widely-run families. Anything not
# matched either way stays UNKNOWN (permit).
_NON_THINKER_PATTERNS = [
    re.compile(r"gpt-4o", re.IGNORECASE),
    re.compile(r"gpt-4(\.\d+)?(-turbo)?\b", re.IGNORECASE),
    re.compile(r"gpt-3\.5", re.IGNORECASE),
    re.compile(r"claude-3-5", re.IGNORECASE),
    re.compile(r"claude-3-(haiku|sonnet|opus)", re.IGNORECASE),
    re.compile(r"\bllama-?[234]", re.IGNORECASE),
    re.compile(r"\bmistral-?(7b|small|large|nemo)", re.IGNORECASE),  # magistral is a THINKER (checked first)
    re.compile(r"\bphi-?3\b", re.IGNORECASE),
    re.compile(r"gemini-1(\.\d+)?", re.IGNORECASE),
]


def _name_says(model_id: str) -> bool | None:
    s = (model_id or "").lower()
    if not s:
        return None
    # Local reasoning-first families (tiers.py's donor knowledge) + thinkers.
    for frag in _REASONING_FIRST:
        if frag in s:
            return True
    for pat in _THINKER_PATTERNS:
        if pat.search(s):
            return True
    for pat in _NON_THINKER_PATTERNS:
        if pat.search(s):
            return False
    return None


def model_thinks(model_id: str) -> bool | None:
    """Can `model_id` think? True/False when we KNOW (catalog row first —
    trusted, editable — then family name patterns), None when we don't
    (→ the gate permits; behavior unchanged from before the gate)."""
    if not model_id:
        return None
    # DB unavailable (a unit test with no configured storage, a boot-order
    # corner) must NEVER break a chat call — fall through to the name layer.
    try:
        s = db.session()
        try:
            row = s.get(db.ModelCatalog, model_id)
        finally:
            s.close()
    except Exception:  # noqa: BLE001 — any infra failure degrades to the name layer, never breaks a run
        row = None
    if row is not None:
        return bool(row.thinking)
    return _name_says(model_id)
