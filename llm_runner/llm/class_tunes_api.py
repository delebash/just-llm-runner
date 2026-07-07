# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared class-tunes router — the editable HARDWARE-CLASS tune library (ROUND 8
Task C, 2026-07-07). A class tune is a measured launch config keyed by
(model_id, class_key = `vram<GB>|ram<GB>`), portable to every box of that class;
`switch_resolve` applies it BELOW a machine's own ModelTune and ABOVE the
base/type/mtp bundles. Rows are seeded (`seed.DEFAULT_CLASS_TUNES`) AND
user-editable here — unlike model-tunes, which are never seeded.

Sibling precedent: `model_tunes_api.py` (the same Protocol-store + router-factory
seam). Differences are the LIBRARY semantics: GET returns EVERY config (the
editable table needs the whole set, and it is small), plus `classKey` — the
CURRENT box's class (server-derived via the injected `class_key_fn`, one source,
mirroring `hw_key_fn`) so the UI can badge "this PC" and default a save to it.
PUT replaces the (model, class) row set wholesale (the verbatim-snapshot
semantics); `classKey` may be omitted — it defaults to the box's own class,
which is the Tune modal's "Save for hardware class" path. PUT always writes
`built_in=False` rows: an edited config is the user's now (the boot seeder
inserts a built-in config only when its (model, class) has NO rows, so a user
edit is never clobbered — but a fully DELETED built-in config re-seeds on the
next start; the UI therefore offers Edit, not Delete, on built-ins).
"""

from __future__ import annotations

from typing import Callable, Protocol

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel


class ClassTuneFlag(BaseModel):
    flagName: str
    flagValue: str = ""


class ClassTuneConfig(BaseModel):
    """One (model, hardware-class) launch config — a row group in the library."""

    modelId: str
    classKey: str
    builtIn: bool = False
    rows: list[ClassTuneFlag]


class ClassTunesResponse(BaseModel):
    classKey: str                 # the CURRENT box's class (server-derived)
    tunes: list[ClassTuneConfig]  # the whole library, every model × class


class ClassTunePut(BaseModel):
    modelId: str
    classKey: str = ""            # "" → the current box's class (Save-for-this-class)
    switches: list[ClassTuneFlag] = []


class ClassTuneStore(Protocol):
    """Persistence boundary the host implements over its own storage."""

    def list_all(self) -> list[ClassTuneConfig]: ...
    def replace(self, model_id: str, class_key: str, rows: list[ClassTuneFlag]) -> None: ...
    def delete(self, model_id: str, class_key: str) -> None: ...


def make_class_tunes_router(
    get_store: Callable[[], ClassTuneStore], class_key_fn: Callable[[], str]
) -> APIRouter:
    """GET (the whole library) / PUT (replace one config) / DELETE (remove one)."""
    router = APIRouter(tags=["ai"], prefix="/v1/ai")

    def _response() -> ClassTunesResponse:
        return ClassTunesResponse(classKey=class_key_fn(), tunes=get_store().list_all())

    @router.get("/class-tunes", response_model=ClassTunesResponse)
    async def list_class_tunes() -> ClassTunesResponse:
        return _response()

    @router.put("/class-tunes", response_model=ClassTunesResponse)
    async def put_class_tune(body: ClassTunePut) -> ClassTunesResponse:
        if not body.modelId.strip():
            raise HTTPException(status_code=400, detail="modelId is required")
        class_key = body.classKey.strip() or class_key_fn()
        if not any((f.flagName or "").strip() for f in body.switches):
            raise HTTPException(status_code=400, detail="at least one switch is required")
        get_store().replace(body.modelId.strip(), class_key, body.switches)
        return _response()

    @router.delete("/class-tunes", response_model=ClassTunesResponse)
    async def delete_class_tune(modelId: str, classKey: str) -> ClassTunesResponse:
        if not modelId.strip() or not classKey.strip():
            raise HTTPException(status_code=400, detail="modelId and classKey are required")
        get_store().delete(modelId.strip(), classKey.strip())
        return _response()

    return router
