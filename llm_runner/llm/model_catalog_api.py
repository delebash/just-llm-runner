# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared catalog + switches routers behind a host-supplied storage boundary.

The downloadable llama.cpp model catalog moved off `runner-manifest.json` into
the host DB so users can add/edit/curate without re-shipping. This module owns
the wire shapes + Protocols + router factories; each host (JustWrite — table +
store; JustVoice at adoption) implements the Protocols over its own storage.

One Protocol + one router (parallel to routing_api):
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
    # Gemma-style SEPARATE MTP draft file — facts about the model, feeds --model-draft
    # at load (Plan B, D7). "" everywhere = no external draft (Qwen builds MTP in).
    mtpDraftRepo: str = ""   # "" = the draft lives in the SAME repo as hfRepo
    mtpDraftFile: str = ""   # exact path within the repo (e.g. "MTP/…-Q4_0-MTP.gguf")
    mtpDraftQuant: str = ""  # display/selection metadata; the file path is authoritative
    trainedCtx: int | None = None  # GGUF `<arch>.context_length`, file-derived (null until read)
    samplers: dict[str, str] = Field(default_factory=dict)  # file-derived recommended samplers (read-only)
    minVramMb: int | None = None
    minRamMb: int | None = None
    tier: str = "mid"   # cpu | low-vram-moe | mid | high | high-ram
    license: str = ""   # SPDX id (Apache-2.0 | MIT | Llama-Community | …); "" = unknown
    useLimited: bool = False  # not free for unrestricted/commercial use → the ⚠ badge (DB-stored)
    embedding: bool = False   # is an embedding model (RAG index), not a chat LLM — explicit editable flag (replaces the /embed/i guess)
    pooling: str = ""   # embedding pooling: "" | mean | cls | last | rank (intrinsic per-model; read-only in the model form) (#119)
    qualityRank: int = 100    # curated overall-quality order (LOWER = better); QuickSetup picks best-that-fits. 100 = unranked.
    description: str = ""      # plain-language "what this model is" (editable curation)
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


class RepoQuantRow(BaseModel):
    """One quant available in an HF repo (shards summed) — the quant DROPDOWN row.
    `kind` labels the family (Q | IQ | special); `qat` flags quantization-aware-
    trained weights, detected from the file PATH (filename or folder — QAT is a
    training property with no GGUF header key; the user's explicit label ask)."""

    quant: str
    sizeMb: int = 0
    files: int = 1
    kind: str = ""
    qat: bool = False


class RepoDraftRow(BaseModel):
    """One detected MTP draft file in the repo (`MTP/` dir / `-MTP.gguf`) — picked
    by exact path; its quant + size ride along for the label."""

    path: str
    quant: str = ""
    sizeMb: int = 0
    qat: bool = False


class ListFilesResponse(BaseModel):
    quants: list[RepoQuantRow]
    drafts: list[RepoDraftRow]


class ResolvedFlag(BaseModel):
    """One resolved model default (a Plane-1 engine switch OR a Plane-2 recommended
    sampler), read-only: `flagName`/`flagValue` in OUR catalog namespace, so the Lab +
    the model-card KnobGrid (#20 Tune & measure) seed from the model's real launch
    flags + sampler baseline."""

    flagName: str
    flagValue: str = ""


class ResolvedModelDefaultsResponse(BaseModel):
    """A model's resolved run defaults — Plane-1 engine `switches` (layered base→type)
    + Plane-2 recommended `samplers` (the file-derived per-model baseline, in the
    catalog namespace) + `mtpCapable`. ONE call feeds BOTH the Lab's switch grid AND
    sampler grid seed (ConfigColumn) and Tune & measure — one source, one fetch."""

    modelId: str
    switches: list[ResolvedFlag]
    # the model's file-derived recommended samplers (Phase-2 `model_samplers`), seeded
    # into the Lab's Plane-2 sampler grid so what you see is what runs (seen = run).
    samplers: list[ResolvedFlag] = Field(default_factory=list)
    # the model's GGUF ships MTP draft layers (the Phase-2 `mtp` flag) → the UI surfaces
    # Speculative decode (spec_type) as a measurable opt-in (Phase 3), default off.
    mtpCapable: bool = False


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
    list_files_fn: Callable[[str, str], dict] | None = None,
) -> APIRouter:
    """CRUD + reset for the per-model llama.cpp catalog. When
    `resolve_switches(model_id) -> {flag_name: value}` is given, also expose
    GET /model-catalog/resolved-defaults — the model's resolved Plane-1 switch defaults
    PLUS its Plane-2 recommended samplers (read from the catalog row), so the Lab + the
    #20 model-card KnobGrid seed the real launch flags + sampler baseline before tuning —
    read-only; tuned values persist per-Task in `engine_presets` via the Lab, not per-model."""
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
        @router.get("/model-catalog/resolved-defaults", response_model=ResolvedModelDefaultsResponse)
        async def resolved_defaults(modelId: str) -> ResolvedModelDefaultsResponse:
            if not modelId.strip():
                raise HTTPException(status_code=400, detail="modelId is required")
            merged = resolve_switches(modelId) or {}
            # ONE store read serves BOTH the mtp flag and the model's recommended samplers.
            row = next((r for r in get_store().list() if r.id == modelId), None)
            samplers = (row.samplers if row else None) or {}
            return ResolvedModelDefaultsResponse(
                # mtpCapable = the SAME OR-gate as the resolver's auto-mtp layer
                # (built-in header mtp OR a configured external draft) — so the
                # Tune modal's hint fires for draft-style Gemma models too, in
                # lockstep with the grid Type tag (final-checker fold, 2026-07-05).
                modelId=modelId, mtpCapable=bool(row and (row.mtp or row.mtpDraftFile)),
                switches=[ResolvedFlag(flagName=k, flagValue=str(v)) for k, v in merged.items()],
                samplers=[ResolvedFlag(flagName=k, flagValue=str(v)) for k, v in samplers.items()],
            )

    if list_files_fn is not None:
        @router.post("/model-catalog/list-files", response_model=ListFilesResponse)
        async def list_files(repo: str, revision: str = "main") -> ListFilesResponse:
            """ONE HF tree call → the repo's quant dropdown rows (shards summed,
            Q/IQ/QAT labels) + detected MTP draft files (Plan B D9). Powers the
            Add/Edit form's quant + draft pickers."""
            if not repo.strip():
                raise HTTPException(status_code=400, detail="repo is required")
            try:
                data = list_files_fn(repo.strip(), (revision or "main").strip())
            except Exception as e:  # noqa: BLE001 — network/bad-repo → a clean 502
                raise HTTPException(status_code=502, detail=f"couldn't list {repo}: {e}") from e
            return ListFilesResponse(**data)

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
