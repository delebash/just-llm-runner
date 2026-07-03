# SPDX-License-Identifier: GPL-3.0-or-later
"""Pure builder for the per-hardware recommendation grid (Phase 4).

The grid is the UNIFIED model surface: ROWS = hardware tiers, COLUMNS = functions
(chat/prose/extract/analysis + `other` + `embed`), each CELL = the recommended
model(s) that FIT that tier for that function, with a `quality` pick (best rank)
and a `faster` pick (a lighter model that also fits). It is a read-time VIEW over
the two existing tables (model_recommendations × model_catalog) joined by live
`coarse_fit` — NO new storage, NO schema change. `coarse_fit` (runner.fit) is the
ONE fit truth; the UI overlays live download/load status by modelId from
/v1/llm-runner/models. Pure data/logic (no I/O) so it unit-tests without a GPU.
"""

from __future__ import annotations

from typing import Callable

from ..runner import fit

# coarse_fit bands the grid counts as "runs on this tier" (cpu = runs on CPU, slower).
_FITS = {"ok", "tight", "cpu"}


def _weight(catalog_row) -> float:
    """Estimated weight (MB) for ordering the `faster` pick. NOTE: uses total_params,
    so a low-active MoE reads as its FULL param weight — a display-only ordering hint,
    not a load estimate (the precise per-tier fit is `coarse_fit`)."""
    if catalog_row is None:
        return float("inf")
    w = fit.weights_mb(getattr(catalog_row, "totalParams", None), getattr(catalog_row, "quant", "") or "")
    return w if w is not None else float("inf")


def build_recommendation_grid(
    *,
    catalog_rows: list,
    recommendations: list,
    task_kinds: list,
    tiers: list[dict],
    function_of: Callable[[str], str],
    function_order: list[str],
    function_labels: dict[str, str],
    margin_mb: int,
) -> dict:
    """Compute the grid as plain dicts (the router wraps them in Pydantic).

    - `catalog_rows`: CatalogRow-likes (id, name, totalParams, quant, minVramMb, minRamMb).
    - `recommendations`: RecommendationRow-likes (modelId, taskKind, rank, why).
    - `task_kinds`: TaskKindRow-likes (id) — the app's task catalog; drives which
      function columns are present (+ `embed` always, `other` only if a task maps there).
    - `tiers`: DEFAULT_HARDWARE_TIERS ({key, label, vram_mb, ram_mb}) — the rows.

    Per tier × function: candidates = recs whose function_of(taskKind) == function AND
    whose catalog model coarse_fits the tier; sort by rank asc; `quality` = top rank,
    `faster` = the lightest OTHER fitting candidate (by weights_mb) when strictly lighter
    than the quality pick, else none.
    """
    by_id = {c.id: c for c in catalog_rows}

    # Columns present = the functions the app's tasks map to, plus `embed` (there is an
    # embed rec), in the canonical order; `other` only surfaces if a task maps to it.
    present = {function_of(getattr(t, "id", "")) for t in task_kinds} | {"embed"}
    functions = [f for f in function_order if f in present]

    def _fit_band(catalog_row, tier: dict) -> str:
        return fit.coarse_fit(
            total_params=getattr(catalog_row, "totalParams", None) or None,
            quant=getattr(catalog_row, "quant", "") or "",
            vram_mb=int(tier["vram_mb"]),
            ram_mb=int(tier["ram_mb"]),
            margin_mb=margin_mb,
            min_vram_override=getattr(catalog_row, "minVramMb", None),
            min_ram_override=getattr(catalog_row, "minRamMb", None),
        )

    def _pick(model_id: str, rank: int, why: str, band: str) -> dict:
        c = by_id.get(model_id)
        return {
            "modelId": model_id,
            "name": (getattr(c, "name", "") or model_id) if c else model_id,
            "params": (getattr(c, "totalParams", "") or "") if c else "",
            "fit": band,
            "rank": rank,
            "why": why,
        }

    cells: list[dict] = []
    for tier in tiers:
        for function in functions:
            # candidates: recs mapped to this function whose model is in the catalog + fits.
            cand: list[tuple] = []
            for r in recommendations:
                if function_of(r.taskKind) != function:
                    continue
                c = by_id.get(r.modelId)
                if c is None:
                    continue  # rec for a model not in the catalog (skip; never fabricate)
                band = _fit_band(c, tier)
                if band in _FITS:
                    cand.append((r.rank, r.modelId, r.why, band))
            cand.sort(key=lambda t: (t[0], t[1]))  # rank asc, then id (stable, deterministic)

            quality = faster = None
            if cand:
                qr, qid, qwhy, qband = cand[0]
                quality = _pick(qid, qr, qwhy, qband)
                # faster = the lightest OTHER fitting candidate, only if meaningfully lighter.
                others = [t for t in cand[1:] if t[1] != qid]
                if others:
                    lightest = min(others, key=lambda t: _weight(by_id.get(t[1])))
                    if _weight(by_id.get(lightest[1])) < _weight(by_id.get(qid)):
                        faster = _pick(lightest[1], lightest[0], lightest[2], lightest[3])
            cells.append({"tier": tier["key"], "function": function, "quality": quality, "faster": faster})

    return {
        "functions": functions,
        "functionLabels": {f: function_labels.get(f, f.title()) for f in functions},
        "tiers": [
            {"key": t["key"], "label": t["label"], "vramMb": int(t["vram_mb"]), "ramMb": int(t["ram_mb"])}
            for t in tiers
        ],
        "cells": cells,
    }
