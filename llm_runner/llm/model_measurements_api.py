# SPDX-License-Identifier: MIT
"""Shared model-measurements router — the persistent MEASUREMENT HISTORY
(#142 rows 5+6, 2026-07-07: 'save all data, nothing temporary' + 'add a clear
button to clear history'). One append-only ledger of every real decode-speed
measurement: the Tune modal's "Load & measure" POSTs its result (source='tune' —
the modal is the one actor that knows which switches it loaded, the same
client-writes precedent as Save tune), and the auto-tune sweep records every
successful trial server-side via the injected seam in `install_llm`
(source='autotune' — the save_tune DI precedent).

Sibling precedent: `class_tunes_api.py` (Protocol store + router factory +
server-derived machine identity). GET returns newest-first, optionally filtered
to one model (the Tune modal's per-model drawer); POST stamps `machineKey` and
`at` SERVER-side (the client never supplies identity or clocks); DELETE is the
Clear-history button — per-model with `modelId`, the whole ledger without.
"""

from __future__ import annotations

import time
from typing import Callable, Protocol

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel


class MeasurementFlag(BaseModel):
    flagName: str
    flagValue: str = ""


class MeasurementRow(BaseModel):
    """One recorded measurement — the switches that produced the number ride
    along as relational child rows."""

    id: int
    modelId: str
    machineKey: str = ""
    source: str = "tune"      # tune | autotune
    label: str = ""           # e.g. "baseline" / "n-cpu-moe 21" (autotune trials)
    tokensPerSec: float = 0.0
    vramTotalMb: int = 0
    at: int = 0               # epoch ms, server-stamped
    switches: list[MeasurementFlag] = []


class MeasurementsResponse(BaseModel):
    machineKey: str                       # the CURRENT box (server-derived)
    measurements: list[MeasurementRow]    # newest first


class MeasurementPost(BaseModel):
    modelId: str
    source: str = "tune"
    label: str = ""
    tokensPerSec: float = 0.0
    vramTotalMb: int = 0
    switches: list[MeasurementFlag] = []


class ModelMeasurementStore(Protocol):
    """Persistence boundary the host implements over its own storage."""

    def record(self, model_id: str, *, machine_key: str, source: str, label: str,
               tokens_per_sec: float, vram_total_mb: int, at: int,
               rows: list[MeasurementFlag]) -> int: ...
    def list(self, model_id: str | None = None) -> list[MeasurementRow]: ...
    def clear(self, model_id: str | None = None) -> int: ...


def make_model_measurements_router(
    get_store: Callable[[], ModelMeasurementStore], machine_key_fn: Callable[[], str]
) -> APIRouter:
    """GET (history, newest first, ?modelId filter) / POST (record one) /
    DELETE (clear — ?modelId for one model, none for everything)."""
    router = APIRouter(tags=["ai"], prefix="/v1/ai")

    def _response(model_id: str | None) -> MeasurementsResponse:
        return MeasurementsResponse(
            machineKey=machine_key_fn(), measurements=get_store().list(model_id)
        )

    @router.get("/model-measurements", response_model=MeasurementsResponse)
    async def list_measurements(modelId: str = "") -> MeasurementsResponse:
        return _response(modelId.strip() or None)

    @router.post("/model-measurements", response_model=MeasurementsResponse)
    async def record_measurement(body: MeasurementPost) -> MeasurementsResponse:
        model_id = body.modelId.strip()
        if not model_id:
            raise HTTPException(status_code=400, detail="modelId is required")
        get_store().record(
            model_id,
            machine_key=machine_key_fn(),
            source=(body.source or "tune").strip() or "tune",
            label=body.label or "",
            tokens_per_sec=float(body.tokensPerSec or 0),
            vram_total_mb=int(body.vramTotalMb or 0),
            at=int(time.time() * 1000),
            rows=body.switches,
        )
        return _response(model_id)

    @router.delete("/model-measurements", response_model=MeasurementsResponse)
    async def clear_measurements(modelId: str = "") -> MeasurementsResponse:
        model_id = modelId.strip() or None
        get_store().clear(model_id)
        return _response(model_id)

    return router
