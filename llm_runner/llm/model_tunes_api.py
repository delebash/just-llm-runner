# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared model-tunes router — a user's MEASURED per-(model, machine) engine tune
(Plan B, 2026-07-05). The persistence behind Tune & measure's Apply: a verbatim
snapshot of the tuned switch grid, keyed by (model_id, hw_key), applied LAST by
`switch_resolve` so it wins over the base/type/mtp/class layers.

The SERVER derives `hw_key` (via the injected `hw_key_fn` → the runner's
whole-machine key) — the client never computes machine identity, so the key has
ONE source. PUT replaces the (model, machine) tune's WHOLE row set (the
`switch_presets` PUT precedent); DELETE removes it ("Remove applied config" →
back to the layered defaults). Never seeded; user data only. The host implements
the Protocol over its DB (`stores.ModelTuneStore`).

§7.6 additions (2026-07-08, the B3-remainder lock):
- **Baseline capture**: PUT stores the LAYER-resolved defaults standing at apply
  time (via the injected `resolve_baseline`) beside the tune, so GET can report
  `driftCount` — how many default values changed since the apply. Tunes applied
  before baseline tracking report driftCount=None (no honest claim possible).
- **Provenance source**: GET derives `source` ("auto" | "hand") for an applied
  tune by matching its rows against the measurement history's autotune trials —
  the sweep records every trial's exact switches, so a tune equal to an autotune
  trial IS that sweep's winner applied unedited; anything else was hand-shaped.
  No schema change: the history already carries the facts.
- **GET /model-tunes/state**: the per-machine badge summary for the catalog —
  every tuned model with its source, plus the models that have a hardware-class
  default for THIS box's class (the §7.6 badge family: Auto-tuned / Hand-tuned /
  Class default / untuned-by-absence).
"""

from __future__ import annotations

from typing import Callable, Protocol

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field


class ModelTuneFlag(BaseModel):
    flagName: str
    flagValue: str = ""


class ModelTuneResponse(BaseModel):
    modelId: str
    hwKey: str            # the machine the rows apply to (server-derived)
    rows: list[ModelTuneFlag]
    # §7.6: how the applied config came to be — "auto" (equals an autotune trial's
    # switches) | "hand" | "" (no tune, or no measurement source wired).
    source: str = ""
    # §7.6: values changed in the layer defaults SINCE this tune was applied —
    # None = unknowable (tune predates baseline tracking, or no baseline resolver).
    driftCount: int | None = None


class ModelTunePut(BaseModel):
    modelId: str
    switches: list[ModelTuneFlag] = []


class ModelTunesState(BaseModel):
    """The per-machine tune/provenance summary the model catalog's badges read."""

    hwKey: str
    classKey: str = ""
    tuned: dict[str, str] = Field(default_factory=dict)   # modelId -> "auto" | "hand"
    classDefault: list[str] = Field(default_factory=list)  # modelIds with a class config for THIS class


class ModelTuneStore(Protocol):
    """Persistence boundary the host implements over its own storage."""

    def get(self, model_id: str, hw_key: str) -> list[ModelTuneFlag]: ...
    def replace(self, model_id: str, hw_key: str, rows: list[ModelTuneFlag],
                baseline: dict[str, str] | None = None) -> None: ...
    def delete(self, model_id: str, hw_key: str) -> None: ...
    # §7.6 (optional — the router degrades gracefully when a host store lacks them):
    def get_baseline(self, model_id: str, hw_key: str) -> dict[str, str] | None: ...
    def list_for_machine(self, hw_key: str) -> dict[str, list[ModelTuneFlag]]: ...


def derive_tune_source(rows: list[ModelTuneFlag], measurements: list) -> str:
    """"auto" when the applied rows exactly equal some autotune trial's switches
    (newest measurement first — the sweep persisted every OK trial verbatim, so
    an unedited applied winner matches one), else "hand". ONE definition — both
    the per-model GET and the /state summary ride it."""
    tuned = {r.flagName: r.flagValue for r in rows}
    for m in measurements:
        if getattr(m, "source", "") != "autotune":
            continue
        trial = {f.flagName: f.flagValue for f in getattr(m, "switches", [])}
        if trial == tuned:
            return "auto"
    return "hand"


def make_model_tunes_router(
    get_store: Callable[[], ModelTuneStore],
    hw_key_fn: Callable[[], str],
    *,
    resolve_baseline: Callable[[str], dict[str, str]] | None = None,
    measurements_fn: Callable[[str], list] | None = None,
    class_key_fn: Callable[[], str] | None = None,
    class_configs_fn: Callable[[], list] | None = None,
) -> APIRouter:
    """GET / PUT / DELETE for the current machine's saved tune of one model, plus
    the §7.6 /state badge summary. The optional fns wire drift + provenance:
    `resolve_baseline(model_id)` = the layer resolve WITHOUT the machine tune;
    `measurements_fn(model_id)` = newest-first measurement rows (source + switches);
    `class_key_fn` / `class_configs_fn` = this box's class + the class-tune library."""
    router = APIRouter(tags=["ai"], prefix="/v1/ai")

    def _source_of(model_id: str, rows: list[ModelTuneFlag]) -> str:
        if not rows or measurements_fn is None:
            return ""
        try:
            return derive_tune_source(rows, measurements_fn(model_id) or [])
        except Exception:  # noqa: BLE001 — provenance is an enrichment, never a failure
            return ""

    def _drift_of(model_id: str, hw: str, rows: list[ModelTuneFlag]) -> int | None:
        if not rows or resolve_baseline is None:
            return None
        get_bl = getattr(get_store(), "get_baseline", None)
        if get_bl is None:
            return None
        try:
            stored = get_bl(model_id, hw)
            if stored is None:
                return None  # tune predates baseline tracking — no honest claim
            current = resolve_baseline(model_id) or {}
            keys = set(stored) | set(current)
            return sum(1 for k in keys if stored.get(k) != current.get(k))
        except Exception:  # noqa: BLE001 — drift is an enrichment, never a failure
            return None

    def _response(model_id: str) -> ModelTuneResponse:
        hw = hw_key_fn()
        rows = get_store().get(model_id, hw)
        return ModelTuneResponse(
            modelId=model_id, hwKey=hw, rows=rows,
            source=_source_of(model_id, rows),
            driftCount=_drift_of(model_id, hw, rows),
        )

    @router.get("/model-tunes", response_model=ModelTuneResponse)
    async def get_tune(modelId: str) -> ModelTuneResponse:
        if not modelId.strip():
            raise HTTPException(status_code=400, detail="modelId is required")
        return _response(modelId)

    @router.put("/model-tunes", response_model=ModelTuneResponse)
    async def put_tune(body: ModelTunePut) -> ModelTuneResponse:
        if not body.modelId.strip():
            raise HTTPException(status_code=400, detail="modelId is required")
        baseline = None
        if resolve_baseline is not None:
            try:
                baseline = resolve_baseline(body.modelId) or {}
            except Exception:  # noqa: BLE001 — a baseline failure must not block the apply
                baseline = None
        get_store().replace(body.modelId, hw_key_fn(), body.switches, baseline=baseline)
        return _response(body.modelId)

    @router.delete("/model-tunes", response_model=ModelTuneResponse)
    async def delete_tune(modelId: str) -> ModelTuneResponse:
        if not modelId.strip():
            raise HTTPException(status_code=400, detail="modelId is required")
        get_store().delete(modelId, hw_key_fn())
        return _response(modelId)

    @router.get("/model-tunes/state", response_model=ModelTunesState)
    async def tunes_state() -> ModelTunesState:
        hw = hw_key_fn()
        cls = class_key_fn() if class_key_fn else ""
        tuned: dict[str, str] = {}
        list_fn = getattr(get_store(), "list_for_machine", None)
        if list_fn is not None:
            for mid, rows in (list_fn(hw) or {}).items():
                tuned[mid] = _source_of(mid, rows) or "hand"
        class_default: list[str] = []
        if cls and class_configs_fn is not None:
            try:
                class_default = sorted({
                    c.modelId for c in (class_configs_fn() or [])
                    if getattr(c, "classKey", "") == cls and getattr(c, "rows", None)
                })
            except Exception:  # noqa: BLE001 — the summary is an enrichment
                class_default = []
        return ModelTunesState(hwKey=hw, classKey=cls, tuned=tuned, classDefault=class_default)

    return router
