# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared model-tunes router — a user's MEASURED per-(model, machine) engine tune
(Plan B, 2026-07-05). The persistence behind Quick tune's Save: a verbatim
snapshot of the tuned switch grid, keyed by (model_id, hw_key), applied LAST by
`switch_resolve` so it wins over the base/type/mtp/hardware layers.

The SERVER derives `hw_key` (via the injected `hw_key_fn` → the runner's
whole-machine key) — the client never computes machine identity, so the key has
ONE source. PUT replaces the (model, machine) tune's WHOLE row set (the
`switch_presets` PUT precedent); DELETE removes it ("Remove saved tune" → back to
the layered defaults). Never seeded; user data only. The host implements the
Protocol over its DB (`stores.ModelTuneStore`).
"""

from __future__ import annotations

from typing import Callable, Protocol

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel


class ModelTuneFlag(BaseModel):
    flagName: str
    flagValue: str = ""


class ModelTuneResponse(BaseModel):
    modelId: str
    hwKey: str            # the machine the rows apply to (server-derived)
    rows: list[ModelTuneFlag]


class ModelTunePut(BaseModel):
    modelId: str
    switches: list[ModelTuneFlag] = []


class ModelTuneStore(Protocol):
    """Persistence boundary the host implements over its own storage."""

    def get(self, model_id: str, hw_key: str) -> list[ModelTuneFlag]: ...
    def replace(self, model_id: str, hw_key: str, rows: list[ModelTuneFlag]) -> None: ...
    def delete(self, model_id: str, hw_key: str) -> None: ...


def make_model_tunes_router(
    get_store: Callable[[], ModelTuneStore], hw_key_fn: Callable[[], str]
) -> APIRouter:
    """GET / PUT / DELETE for the current machine's saved tune of one model."""
    router = APIRouter(tags=["ai"], prefix="/v1/ai")

    def _response(model_id: str) -> ModelTuneResponse:
        hw = hw_key_fn()
        return ModelTuneResponse(modelId=model_id, hwKey=hw, rows=get_store().get(model_id, hw))

    @router.get("/model-tunes", response_model=ModelTuneResponse)
    async def get_tune(modelId: str) -> ModelTuneResponse:
        if not modelId.strip():
            raise HTTPException(status_code=400, detail="modelId is required")
        return _response(modelId)

    @router.put("/model-tunes", response_model=ModelTuneResponse)
    async def put_tune(body: ModelTunePut) -> ModelTuneResponse:
        if not body.modelId.strip():
            raise HTTPException(status_code=400, detail="modelId is required")
        get_store().replace(body.modelId, hw_key_fn(), body.switches)
        return _response(body.modelId)

    @router.delete("/model-tunes", response_model=ModelTuneResponse)
    async def delete_tune(modelId: str) -> ModelTuneResponse:
        if not modelId.strip():
            raise HTTPException(status_code=400, detail="modelId is required")
        get_store().delete(modelId, hw_key_fn())
        return _response(modelId)

    return router
