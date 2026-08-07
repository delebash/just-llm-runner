# SPDX-License-Identifier: MIT
"""Model THINKING capability — ROUTING advice, never a send-time veto.

The capability GATE was REMOVED by the user's ruling (2026-08-06, "no fancy
magic" — decision text in JustVoice's TASKS): thinking is sent exactly as
the preset asks, and a provider that can't take the parameter answers with
its own error (dispatch adds one fix-pointer sentence). This resolver's one
remaining consumer is JustVoice's Auto route pick ("if your model can
think, Reasoned runs") — where a wrong reading costs a visible route
choice, never the user's ask. Three layers:

  1. The model catalog row's `thinking` flag — curated/user-owned data,
     editable in the catalog UI. Trusted absolutely when a row exists.
  2. Family name patterns — for ids we have no row for (an Ollama tag, a
     cloud id typed into a provider). Both directions, unambiguous families
     only; `tiers._REASONING_FIRST` is the local-family donor knowledge.
  3. Unknown → None — the caller decides its own safe default (JV's Auto
     treats unknown as "route by size", never as a yes).
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
