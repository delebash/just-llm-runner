# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared catalog + switches routers behind a host-supplied storage boundary.

The downloadable llama.cpp model catalog moved off `runner-manifest.json` into
the host DB so users can add/edit/curate without re-shipping. This module owns
the wire shapes + Protocols + router factories; each host (JustWrite — table +
store; JustVoice at adoption) implements the Protocols over its own storage.

One Protocol + one router (parallel to routing_api / recommendations_api):
  * ModelCatalogStore  -> /v1/ai/model-catalog        (GET/PUT/DELETE/reset)

`built_in` marks seeded rows; reset = restore factory values for seeded keys,
preserve user-added rows. (There is no per-model spawn-flag table — a model's
switches are its type baseline in `switch_presets` (resolved by
`resolve_model_switches`) plus the per-Task `engine_presets` config tuned in the
Lab; the old `model_switches` / `/v1/ai/model-switches` surfaces were dropped.)
"""

from __future__ import annotations

from typing import Callable, Protocol

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field


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
    type: str = "dense"  # dense | moe — drives which switch preset applies (§6.5)
    trainedCtx: int | None = None  # GGUF `<arch>.context_length`, file-derived (null until read)
    samplers: dict[str, str] = Field(default_factory=dict)  # file-derived recommended samplers (read-only)
    minVramMb: int | None = None
    minRamMb: int | None = None
    tier: str = "mid"   # cpu | low-vram-moe | mid | high | high-ram
    license: str = ""   # SPDX id (Apache-2.0 | MIT | Llama-Community | …); "" = unknown
    useLimited: bool = False  # not free for unrestricted/commercial use → the ⚠ badge (DB-stored)
    position: int = 0
    builtIn: bool = False


class CatalogResponse(BaseModel):
    rows: list[CatalogRow]


class InspectResponse(BaseModel):
    """The file-derived facts the Add-a-model form pre-fills from the GGUF header,
    read PRE-download over the HF link (`POST /model-catalog/inspect`). type/mtp/
    trainedCtx/samplers are the read-only "auto-detected from the file" facts;
    sizeBytes/estVramMb ground the fit estimate in the real file, not a guess."""

    architecture: str = ""
    type: str = "dense"
    mtp: bool = False
    trainedCtx: int | None = None
    experts: int = 0            # expert_count (0 = dense)
    sizeLabel: str = ""         # general.size_label ("27B" dense; "128x9.4B" MoE expert-config)
    totalParams: str = ""       # param count file-derived from size_label — dense only; "" for MoE
    samplers: dict[str, str] = Field(default_factory=dict)  # recommended samplers (read-only fact)
    sizeBytes: int = 0          # real total weight size (summed shards) — the download size
    estVramMb: int | None = None  # est. VRAM to fully offload at 8K ctx (real header + size)


class ResolvedSwitch(BaseModel):
    """One resolved engine switch for a model (read-only): the layered
    base→type→mtp default the runner would launch with, so the model-card KnobGrid
    (#20 Tune & measure) pre-fills from the model's real launch flags."""

    flagName: str
    flagValue: str = ""


class ResolvedSwitchesResponse(BaseModel):
    modelId: str
    switches: list[ResolvedSwitch]


class ModelCatalogStore(Protocol):
    """Persistence boundary the host implements over its own storage."""

    def list(self) -> list[CatalogRow]: ...
    def upsert(self, row: CatalogRow) -> CatalogRow: ...  # upsert by id
    def delete(self, model_id: str) -> None: ...
    def reset_to_factory(self) -> None: ...


def make_catalog_router(
    get_store: Callable[[], ModelCatalogStore],
    *,
    resolve_switches: Callable[[str], dict[str, str]] | None = None,
    inspect_fn: Callable[[str, str, str], dict] | None = None,
) -> APIRouter:
    """CRUD + reset for the per-model llama.cpp catalog. When
    `resolve_switches(model_id) -> {flag_name: value}` is given, also expose
    GET /model-catalog/switches (the model's resolved engine-flag default, so the
    #20 model-card KnobGrid shows the real launch flags before tuning — read-only;
    tuned flags persist per-Task in `engine_presets` via the Lab, not per-model)."""
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

    if resolve_switches is not None:
        @router.get("/model-catalog/switches", response_model=ResolvedSwitchesResponse)
        async def resolved_switches(modelId: str) -> ResolvedSwitchesResponse:
            if not modelId.strip():
                raise HTTPException(status_code=400, detail="modelId is required")
            merged = resolve_switches(modelId) or {}
            return ResolvedSwitchesResponse(
                modelId=modelId,
                switches=[ResolvedSwitch(flagName=k, flagValue=str(v)) for k, v in merged.items()],
            )

    if inspect_fn is not None:
        @router.post("/model-catalog/inspect", response_model=InspectResponse)
        async def inspect_catalog(repo: str, quant: str = "", revision: str = "main") -> InspectResponse:
            """Pre-download: read the GGUF header from the HF link (no weights) so the
            Add-a-model form fills the file-derived fields (type/mtp/trainedCtx/samplers)
            + the real size + a VRAM estimate before committing to a multi-GB download."""
            if not repo.strip():
                raise HTTPException(status_code=400, detail="repo is required")
            try:
                data = inspect_fn(repo.strip(), quant.strip(), (revision or "main").strip())
            except FileNotFoundError as e:
                raise HTTPException(status_code=404, detail=str(e) or "no GGUF for that repo/quant") from e
            except HTTPException:
                raise
            except Exception as e:  # noqa: BLE001 — network/parse failure → 502 with the reason
                raise HTTPException(status_code=502, detail=f"inspect failed: {e}") from e
            return InspectResponse(**data)

    return router
