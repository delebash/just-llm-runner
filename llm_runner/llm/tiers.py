# SPDX-License-Identifier: MIT
"""LLM tier classification — Guided / Direct / Reasoned.

Ported from JustWrite's modelMeta.js with the same heuristic-match-on-
model-id approach. Lifted verbatim from JustVoice
`server/justvoice/engines/llm/tiers.py` into the shared `llm_runner`
package (2026-06-21 AI-stack convergence).

THIS is the canonical tier table (the server dispatch classifies with it).
JustWrite's renderer keeps a synchronous DOCUMENTED MIRROR for boot-time UI
badges (`src/renderer/src/services/modelMeta.js` — recorded by the 2026-07-06
shared-stack audit): change the heuristic HERE first, then mirror it there.

Each tier carries:
  - system_key: which prompt body the extraction backend should send.
  - think: whether to enable Ollama's reasoning blocks (only meaningful
    on Ollama; ignored elsewhere).
  - confidence_floor: below-threshold LLM picks demoted to "unknown"
    (audio-attribution safety net).

Auto-classify heuristic-matches model ids:
  - Reasoning-first families (DeepSeek-R1, Qwen3.5, Phi-4-Reasoning,
    GLM-Z) → Reasoned forced.
  - Qwen3 14B+ → Reasoned (Qwen3 is hybrid; bigger models tier up).
  - ≥12B non-reasoning (Mistral-Small 22B+, Phi-4 14B non-reasoning,
    Llama 3.x 70B, Gemma3 12B+) → Direct.
  - Sub-12B explicitly listed → Guided.
  - Fallback → Guided (safe default — extra worked examples never hurt).

Per-model user overrides via FeaturePinConfig.tier wins over the
auto-classification.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

Tier = Literal["guided", "direct", "reasoned"]


@dataclass(frozen=True)
class TierSpec:
    name: Tier
    system_key: str        # "guided" | "direct" — both reasoned + direct use "direct" body
    think: bool            # enable Ollama reasoning blocks
    confidence_floor: float  # demote below-floor LLM picks to "unknown"


TIERS: dict[Tier, TierSpec] = {
    "guided":   TierSpec(name="guided",   system_key="guided", think=False, confidence_floor=0.7),
    "direct":   TierSpec(name="direct",   system_key="direct", think=False, confidence_floor=0.5),
    "reasoned": TierSpec(name="reasoned", system_key="direct", think=True,  confidence_floor=0.5),
}


# ── Auto-classify by model id ────────────────────────────────────────


# Reasoning-first families — always Reasoned regardless of size.
# These models are trained to emit a <think>…</think> reasoning block,
# so directing them through the "direct" prompt body + think=True
# produces the highest-quality attribution per the JustWrite audit.
_REASONING_FIRST = [
    "deepseek-r1",
    "qwen3.5",
    "qwen3-thinking",
    "phi-4-reasoning",
    "phi4-reasoning",
    "glm-z",
    "magistral",
]

# ≥12B non-reasoning models that handle the strict-rule prompt without
# worked examples. Larger general-purpose models slot here.
_DIRECT_TIER_PATTERNS = [
    re.compile(r"\bmistral-?small\b.*\b(22b|24b|large)\b", re.IGNORECASE),
    re.compile(r"\bmistral-?large\b", re.IGNORECASE),
    re.compile(r"\bphi-?4\b", re.IGNORECASE),
    re.compile(r"\bllama-?3(\.[1-9])?-?70b\b", re.IGNORECASE),
    re.compile(r"\bllama-?3\.\d+-?[1-9]\d\dB\b", re.IGNORECASE),  # 100B+ Llama
    re.compile(r"\bgemma-?3?\s*[1-9]\d+b\b", re.IGNORECASE),       # Gemma 12B+
    re.compile(r"\bgemma-3-(12|27)b\b", re.IGNORECASE),
    re.compile(r"\bclaude-3-?5-sonnet\b", re.IGNORECASE),
    re.compile(r"\bclaude-3-?7-sonnet\b", re.IGNORECASE),
    re.compile(r"\bclaude-(haiku|sonnet|opus|fable)-[4-9]\b", re.IGNORECASE),
    re.compile(r"\bgpt-4o(-mini)?\b", re.IGNORECASE),
    re.compile(r"\bgpt-4\b", re.IGNORECASE),
    re.compile(r"\bgemini-(2\.\d+|3)-(pro|flash)\b", re.IGNORECASE),
]

# Sub-12B models that benefit from worked examples — keep at Guided so
# attribution accuracy holds up.
_GUIDED_TIER_PATTERNS = [
    re.compile(r"\bqwen3?-?[1-9](\.\d+)?b\b", re.IGNORECASE),     # Qwen3 1-9B
    re.compile(r"\bphi-?3\b", re.IGNORECASE),
    re.compile(r"\bllama-?3(\.\d+)?-?[1-8]b\b", re.IGNORECASE),
    re.compile(r"\bgemma-?3?-?[2-9]b\b", re.IGNORECASE),
    re.compile(r"\bmistral-?7b\b", re.IGNORECASE),
    re.compile(r"\bclaude-3-haiku\b", re.IGNORECASE),
]


def classify(model_id: str) -> Tier:
    """Heuristic-match a model id to a tier.

    Order matters: reasoning-first wins absolutely; then 14B+ Qwen3
    (hybrid family, larger models tier up); then Direct patterns; then
    Guided patterns; fallback Guided.
    """
    if not model_id:
        return "guided"
    s = model_id.lower()

    # Reasoning-first families → forced Reasoned.
    for pat in _REASONING_FIRST:
        if pat in s:
            return "reasoned"

    # Qwen3 ≥14B is hybrid — tier up to Reasoned for best accuracy.
    # Id separators vary by host: "qwen3-14b" (HF), "qwen3:14b" (Ollama),
    # "qwen3_14b"; sizes can be fractional ("qwen3:0.6b").
    qwen3_size = re.search(r"qwen3?[-:_]?(\d+(?:\.\d+)?)b\b", s)
    if qwen3_size:
        try:
            if float(qwen3_size.group(1)) >= 14:
                return "reasoned"
        except (TypeError, ValueError):
            pass

    for pat in _DIRECT_TIER_PATTERNS:
        if pat.search(s):
            return "direct"

    for pat in _GUIDED_TIER_PATTERNS:
        if pat.search(s):
            return "guided"

    # Fallback — safe default.
    return "guided"


def spec_for(model_id: str, tier_override: Tier | None = None) -> TierSpec:
    """Resolve the TierSpec for a model id.

    `tier_override` (from FeaturePinConfig.tier or a Speaker-Lab column
    setting) wins over auto-classify. Returns the Guided spec as a safe
    fallback if the override is unrecognized.
    """
    tier: Tier = (
        tier_override
        if tier_override in TIERS
        else classify(model_id)
    )
    return TIERS[tier]
