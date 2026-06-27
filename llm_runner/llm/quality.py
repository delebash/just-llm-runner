# SPDX-License-Identifier: GPL-3.0-or-later
"""The Fast / Balanced / Best quality dial → (model, think).

ONE per-job control that resolves to a concrete model + a reasoning flag, instead
of making a novelist pick a raw model id + a think toggle. The pick is
hardware-adaptive: among the job's curated recommendations that FIT the detected
hardware (coarse_fit), it walks a size ladder —

    Fast     = the smallest fitting model (lowest latency)
    Best     = the largest-capability fitting model (the ceiling that runs)
    Balanced = the median of the fitting ladder (the default sweet spot)

— which reproduces the Part-3 per-job × per-tier matrix without hardcoding a model
per cell (e.g. prose-Balanced → 27B, extraction-Balanced → Mistral-24B,
chat-Best → 27B), and degrades gracefully (only a 9B fits a small box → all three
stops resolve to it).

`think` follows the dial table: ON only for the deep-reasoning job at its Best
stop; OFF otherwise (chat/prose are latency-sensitive, extraction/attribution are
JSON-sensitive). The B3 guardrail additionally forces think OFF under a JSON
schema regardless, so this is the intent, not the last word.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..runner.config import DEFAULT_SAFETY_MARGIN_MB
from ..runner.fit import coarse_fit, parse_params

QUALITY_STOPS = ("fast", "balanced", "best")

# Jobs where the Best stop turns reasoning ON. Everything else stays think-off.
_THINK_ON_BEST = {"analysis"}


@dataclass(frozen=True)
class QualityPick:
    """The dial's resolution. `model` is None when nothing in the job's
    recommendations fits the hardware (the caller falls back to the default LLM).
    `candidates` is the fit-filtered size ladder (smallest → largest)."""

    model: str | None
    think: bool
    candidates: list[str]


def _think_for(job_id: str, quality: str) -> bool:
    return quality == "best" and job_id in _THINK_ON_BEST


def resolve_quality(
    job_id: str,
    quality: str,
    *,
    vram_mb: int,
    ram_mb: int,
    catalog,
    recommendations,
    margin_mb: int = DEFAULT_SAFETY_MARGIN_MB,
) -> QualityPick:
    """Resolve (model, think) for a job at a quality stop, given the hardware,
    the model catalog (CatalogRow list), and the recommendations (RecommendationRow
    list). Pure — no I/O; the caller supplies the stores' data + detected hardware."""
    q = quality if quality in QUALITY_STOPS else "balanced"
    by_id = {c.id: c for c in catalog}
    fitting = []
    for r in recommendations:
        if r.job != job_id:
            continue
        c = by_id.get(r.modelId)
        if c is None:
            continue
        band = coarse_fit(
            total_params=c.totalParams, quant=c.quant, vram_mb=vram_mb, ram_mb=ram_mb,
            margin_mb=margin_mb, min_vram_override=c.minVramMb, min_ram_override=c.minRamMb,
        )
        if band != "no":
            fitting.append(c)

    think = _think_for(job_id, q)
    if not fitting:
        return QualityPick(model=None, think=think, candidates=[])

    ladder = sorted(fitting, key=lambda c: parse_params(c.totalParams) or 0.0)
    if q == "fast":
        pick = ladder[0]
    elif q == "best":
        pick = ladder[-1]
    else:  # balanced → the median of the ladder
        pick = ladder[len(ladder) // 2]
    return QualityPick(model=pick.id, think=think, candidates=[c.id for c in ladder])
