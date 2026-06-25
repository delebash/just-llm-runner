# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared catalog + switches routers behind a host-supplied storage boundary.

The downloadable llama.cpp model catalog moved off `runner-manifest.json` into
the host DB so users can add/edit/curate without re-shipping. This module owns
the wire shapes + Protocols + router factories; each host (JustWrite — table +
store; JustVoice at adoption) implements the Protocols over its own storage.

Two Protocols + two routers (parallel to routing_api / recommendations_api):
  * ModelCatalogStore  -> /v1/ai/model-catalog        (GET/PUT/DELETE/reset)
  * ModelSwitchStore   -> /v1/ai/model-switches       (GET/PUT/DELETE/reset)

Switches are normalized into a child table — variable-cardinality per model —
mapped 1:1 to `process.Overrides` fields by `flag_name`. At spawn, the host's
switches load FIRST then the user-supplied Overrides layer ON TOP (user wins
per field). `built_in` marks seeded rows; reset = restore factory values for
seeded keys, preserve user-added rows.
"""

from __future__ import annotations

from typing import Callable, Protocol

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel


# ── Catalog ──────────────────────────────────────────────────────────────────

class CatalogRow(BaseModel):
    """One downloadable llama.cpp model — catalog fields only. Switches live
    in the sibling switches table (one model, many switches). `builtIn` marks
    a seeded row (so the editor can offer 'reset to factory')."""

    id: str
    name: str = ""
    hfRepo: str = ""
    quant: str = ""
    mmproj: str | None = None
    totalParams: str = ""
    activeParams: str = ""
    mtp: bool = False
    minVramMb: int | None = None
    minRamMb: int | None = None
    tier: str = "mid"   # cpu | low-vram-moe | mid | high
    position: int = 0
    builtIn: bool = False


class CatalogResponse(BaseModel):
    rows: list[CatalogRow]


class ModelCatalogStore(Protocol):
    """Persistence boundary the host implements over its own storage."""

    def list(self) -> list[CatalogRow]: ...
    def upsert(self, row: CatalogRow) -> CatalogRow: ...  # upsert by id
    def delete(self, model_id: str) -> None: ...
    def reset_to_factory(self) -> None: ...


def make_catalog_router(get_store: Callable[[], ModelCatalogStore]) -> APIRouter:
    """CRUD + reset for the per-model llama.cpp catalog."""
    router = APIRouter(tags=["ai"], prefix="/v1/ai")

    def _list() -> CatalogResponse:
        return CatalogResponse(rows=get_store().list())

    @router.get("/model-catalog", response_model=CatalogResponse)
    async def list_catalog() -> CatalogResponse:
        return _list()

    @router.put("/model-catalog", response_model=CatalogResponse)
    async def upsert_catalog(body: CatalogRow) -> CatalogResponse:
        if not body.id.strip():
            raise HTTPException(status_code=400, detail="id is required")
        body.builtIn = False  # user edit, even if id matches a built-in
        get_store().upsert(body)
        return _list()

    @router.delete("/model-catalog", response_model=CatalogResponse)
    async def delete_catalog(modelId: str) -> CatalogResponse:
        if not modelId.strip():
            raise HTTPException(status_code=400, detail="modelId is required")
        get_store().delete(modelId)
        return _list()

    @router.post("/model-catalog/reset", response_model=CatalogResponse)
    async def reset_catalog() -> CatalogResponse:
        get_store().reset_to_factory()
        return _list()

    return router


# ── Switches (per-model spawn-flag overrides) ────────────────────────────────

class SwitchRow(BaseModel):
    """One per-model spawn-flag override. PK (modelId, flagName). `flagName`
    maps 1:1 to a `process.Overrides` field (e.g. "spec_type", "no_mmap",
    "n_cpu_moe"); `flagValue` is text the runner parses into the typed field.
    At spawn, switches layer UNDER user-supplied Overrides (user wins)."""

    modelId: str
    flagName: str
    flagValue: str = ""
    builtIn: bool = False


class SwitchesResponse(BaseModel):
    rows: list[SwitchRow]


class ModelSwitchStore(Protocol):
    """Persistence boundary the host implements over its own storage."""

    def list(self) -> list[SwitchRow]: ...
    def upsert(self, row: SwitchRow) -> SwitchRow: ...  # upsert by (modelId, flagName)
    def delete(self, model_id: str, flag_name: str) -> None: ...
    def reset_to_factory(self) -> None: ...


def make_switches_router(get_store: Callable[[], ModelSwitchStore]) -> APIRouter:
    """CRUD + reset for per-model spawn-flag overrides."""
    router = APIRouter(tags=["ai"], prefix="/v1/ai")

    def _list() -> SwitchesResponse:
        return SwitchesResponse(rows=get_store().list())

    @router.get("/model-switches", response_model=SwitchesResponse)
    async def list_switches() -> SwitchesResponse:
        return _list()

    @router.put("/model-switches", response_model=SwitchesResponse)
    async def upsert_switch(body: SwitchRow) -> SwitchesResponse:
        if not body.modelId.strip() or not body.flagName.strip():
            raise HTTPException(status_code=400, detail="modelId and flagName are required")
        body.builtIn = False
        get_store().upsert(body)
        return _list()

    @router.delete("/model-switches", response_model=SwitchesResponse)
    async def delete_switch(modelId: str, flagName: str) -> SwitchesResponse:
        if not modelId.strip() or not flagName.strip():
            raise HTTPException(status_code=400, detail="modelId and flagName are required")
        get_store().delete(modelId, flagName)
        return _list()

    @router.post("/model-switches/reset", response_model=SwitchesResponse)
    async def reset_switches() -> SwitchesResponse:
        get_store().reset_to_factory()
        return _list()

    return router
