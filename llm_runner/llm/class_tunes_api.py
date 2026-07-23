# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared hardware-class library router — the editable HARDWARE-CLASS library.

TWO levels (2026-07-22 user redesign — "a named hardware class that holds several
model-configs"):

  • a HARDWARE CLASS = a NAMED bucket with editable whole-GB VRAM/RAM fields
    (`HardwareClass`); its `class_key` (`vram<GB>|ram<GB>` / `cpu|ram<GB>`) is the
    identity + join and is DERIVED from VRAM/RAM ("i reverse that vram and ram is
    key"). `name` is a free label ("but name can be anything"), never matched on.
  • a MODEL-CONFIG = one model's measured launch switches under a class
    (`ClassTune`), keyed by (model_id, class_key). `switch_resolve` applies it BELOW
    a machine's own ModelTune and ABOVE the base/type/mtp bundles.

Sibling precedent: `model_tunes_api.py` (the same Protocol-store + router-factory
seam). GET returns the whole library (small); it also carries `classKey` — the
CURRENT box's class (server-derived via `class_key_fn`, one source, override-aware).
The config PUT `ensure()`s its class exists first (the Tune-modal 'Save for hardware
class' path saves a config for the box's class before any class form ran). Config
PUT always writes `built_in=False` (an edited config is the user's now; a fully
DELETED built-in re-seeds next start — the UI offers Edit, not Delete, on built-ins).
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


class HardwareClassRow(BaseModel):
    """A named hardware class — the label + editable fields the form binds to.
    `classKey` is the derived identity; `memType` is discrete|integrated|unified.
    Discrete uses vramGb+ramGb; integrated/unified use ramGb as the one memory pool.
    `name` blank → the UI shows plain-words hardware (2026-07-22)."""

    classKey: str
    memType: str = "discrete"
    vramGb: int = 0
    ramGb: int = 0
    name: str = ""
    builtIn: bool = False


class ClassTunesResponse(BaseModel):
    classKey: str                    # the CURRENT box's class (server-derived, override-aware)
    classes: list[HardwareClassRow] = []  # the named classes (name + VRAM/RAM)
    tunes: list[ClassTuneConfig]     # the model-configs — every model × class


class ClassTunePut(BaseModel):
    modelId: str
    classKey: str = ""            # "" → the current box's class (Save-for-this-class)
    switches: list[ClassTuneFlag] = []


class HardwareClassPut(BaseModel):
    """Add/edit a hardware class. `classKey` is DERIVED server-side from
    memType+vramGb+ramGb. `origClassKey` (edit only) names the class being changed —
    when the key moved (type/VRAM/RAM changed), its model-configs cascade across."""

    name: str = ""
    memType: str = "discrete"
    vramGb: int = 0
    ramGb: int = 0
    origClassKey: str = ""


class ClassTuneStore(Protocol):
    """Persistence boundary for the model-configs (ClassTune)."""

    def list_all(self) -> list[ClassTuneConfig]: ...
    def replace(self, model_id: str, class_key: str, rows: list[ClassTuneFlag]) -> None: ...
    def delete(self, model_id: str, class_key: str) -> None: ...


class HardwareClassStore(Protocol):
    """Persistence boundary for the named-class sidecar (HardwareClass)."""

    def list_all(self) -> list[dict]: ...
    def save(self, class_key: str, mem_type: str, vram_gb: int, ram_gb: int, name: str, orig_key: str = "") -> None: ...
    def ensure(self, class_key: str, mem_type: str, vram_gb: int, ram_gb: int) -> None: ...
    def delete(self, class_key: str) -> None: ...


def make_class_tunes_router(
    get_store: Callable[[], ClassTuneStore],
    class_key_fn: Callable[[], str],
    *,
    hw_class_store: Callable[[], HardwareClassStore] | None = None,
    derive_key_fn: Callable[[str, int, int], str] | None = None,
    parse_key_fn: Callable[[str], tuple[str, int, int]] | None = None,
) -> APIRouter:
    """GET (the whole library) / config PUT+DELETE / class PUT+DELETE. The class-level
    routes + the `classes` list mount only when the hardware-class seam is wired (both
    apps wire it via install_llm; the params stay optional for a bare mount)."""
    router = APIRouter(tags=["ai"], prefix="/v1/ai")

    def _classes() -> list[HardwareClassRow]:
        if not hw_class_store:
            return []
        return [HardwareClassRow(**r) for r in hw_class_store().list_all()]

    def _response() -> ClassTunesResponse:
        return ClassTunesResponse(
            classKey=class_key_fn(), classes=_classes(), tunes=get_store().list_all())

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
        # Ensure the class row exists (the 'Save for hardware class' path may save a
        # config for the box's class before any class form created it).
        if hw_class_store and parse_key_fn:
            mt, v, r = parse_key_fn(class_key)
            hw_class_store().ensure(class_key, mt, v, r)
        get_store().replace(body.modelId.strip(), class_key, body.switches)
        return _response()

    @router.delete("/class-tunes", response_model=ClassTunesResponse)
    async def delete_class_tune(modelId: str, classKey: str) -> ClassTunesResponse:
        if not modelId.strip() or not classKey.strip():
            raise HTTPException(status_code=400, detail="modelId and classKey are required")
        get_store().delete(modelId.strip(), classKey.strip())
        return _response()

    if hw_class_store and derive_key_fn:
        @router.put("/hardware-class", response_model=ClassTunesResponse)
        async def put_hardware_class(body: HardwareClassPut) -> ClassTunesResponse:
            mem_type = (body.memType or "discrete").strip().lower()
            if mem_type not in ("discrete", "integrated", "unified"):
                raise HTTPException(
                    status_code=400,
                    detail="memType must be discrete, integrated, or unified")
            vram = int(body.vramGb or 0)
            ram = int(body.ramGb or 0)  # discrete: system RAM · integrated/unified: the pool
            if ram <= 0:
                raise HTTPException(
                    status_code=400, detail="memory must be a positive whole number of GB")
            if mem_type == "discrete" and vram <= 0:
                raise HTTPException(
                    status_code=400, detail="a discrete GPU class needs its VRAM in GB")
            if mem_type != "discrete":
                vram = 0  # one-pool types carry no separate VRAM
            class_key = derive_key_fn(mem_type, vram, ram)
            try:
                hw_class_store().save(class_key, mem_type, vram, ram,
                                      body.name or "", body.origClassKey or "")
            except ValueError as e:
                raise HTTPException(status_code=409, detail=str(e)) from e
            return _response()

        @router.delete("/hardware-class", response_model=ClassTunesResponse)
        async def delete_hardware_class(classKey: str) -> ClassTunesResponse:
            if not classKey.strip():
                raise HTTPException(status_code=400, detail="classKey is required")
            hw_class_store().delete(classKey.strip())
            return _response()

    return router
