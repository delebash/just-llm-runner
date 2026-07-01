# SPDX-License-Identifier: GPL-3.0-or-later
"""CRUD for cloud model pricing (the usage-ledger cost source). Replaces the
hardcoded `pricing.py` dict — the DB `model_pricing` table is seeded from
`pricing.DEFAULT_PRICING` and edited here. GET/PUT/DELETE on `/v1/ai/pricing`."""
from __future__ import annotations

from collections.abc import Callable
from typing import Protocol

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel


class PricingRow(BaseModel):
    modelId: str
    inputPerM: float = 0.0    # USD per 1,000,000 input tokens
    outputPerM: float = 0.0   # USD per 1,000,000 output tokens


class PricingResponse(BaseModel):
    rows: list[PricingRow]


class PricingStore(Protocol):
    """Persistence boundary the host implements over its own storage."""

    def list(self) -> list[PricingRow]: ...
    def upsert(self, row: PricingRow) -> PricingRow: ...  # upsert by (lowercased) modelId
    def delete(self, model_id: str) -> None: ...


def make_pricing_router(get_store: Callable[[], PricingStore]) -> APIRouter:
    """CRUD for per-model cloud pricing. A model with no row → cost 0 (local
    models never have one). Prices change, so they live in the DB, not in code."""
    router = APIRouter(tags=["ai"], prefix="/v1/ai")

    def _list() -> PricingResponse:
        return PricingResponse(rows=get_store().list())

    @router.get("/pricing", response_model=PricingResponse)
    async def list_pricing() -> PricingResponse:
        return _list()

    @router.put("/pricing", response_model=PricingResponse)
    async def upsert_pricing(body: PricingRow) -> PricingResponse:
        if not body.modelId.strip():
            raise HTTPException(status_code=400, detail="modelId is required")
        get_store().upsert(body)
        return _list()

    @router.delete("/pricing", response_model=PricingResponse)
    async def delete_pricing(modelId: str) -> PricingResponse:
        if not modelId.strip():
            raise HTTPException(status_code=400, detail="modelId is required")
        get_store().delete(modelId)
        return _list()

    return router
