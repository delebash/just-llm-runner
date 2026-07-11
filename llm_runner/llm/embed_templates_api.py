# SPDX-License-Identifier: GPL-3.0-or-later
"""CRUD for per-model embedding task templates (Move 0 of the RAG build).

Embedding models differ in the task instruction they REQUIRE around the raw
text (nomic-embed prefixes both sides, Qwen3-Embedding instructs the query
side only, BGE-M3 needs nothing) — skipping it measurably degrades retrieval.
The templates are model FACTS, so they live in the DB (`model_embed_templates`,
seeded + user-editable here) and are applied server-side by /v1/ai/embeddings
via the resolver seam `install_llm` wires (see api.py). GET/PUT/DELETE on
`/v1/ai/embed-templates`."""
from __future__ import annotations

from collections.abc import Callable
from typing import Protocol

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel


class EmbedTemplateRow(BaseModel):
    modelId: str
    # Template strings with a `{text}` slot; "" = pass-through for that side.
    documentTemplate: str = ""
    queryTemplate: str = ""
    builtIn: bool = False


class EmbedTemplatesResponse(BaseModel):
    rows: list[EmbedTemplateRow]


class EmbedTemplateStore(Protocol):
    """Persistence boundary the host implements over its own storage."""

    def list(self) -> list[EmbedTemplateRow]: ...
    def get(self, model_id: str) -> EmbedTemplateRow | None: ...
    def upsert(self, row: EmbedTemplateRow) -> EmbedTemplateRow: ...
    def delete(self, model_id: str) -> None: ...


def make_embed_templates_router(get_store: Callable[[], EmbedTemplateStore]) -> APIRouter:
    """CRUD for per-model embed templates. A model with no row → both sides
    pass through unchanged (online/BYO models never need one)."""
    router = APIRouter(tags=["ai"], prefix="/v1/ai")

    def _list() -> EmbedTemplatesResponse:
        return EmbedTemplatesResponse(rows=get_store().list())

    @router.get("/embed-templates", response_model=EmbedTemplatesResponse)
    async def list_embed_templates() -> EmbedTemplatesResponse:
        return _list()

    @router.put("/embed-templates", response_model=EmbedTemplatesResponse)
    async def upsert_embed_template(body: EmbedTemplateRow) -> EmbedTemplatesResponse:
        if not body.modelId.strip():
            raise HTTPException(status_code=400, detail="modelId is required")
        get_store().upsert(body)
        return _list()

    @router.delete("/embed-templates", response_model=EmbedTemplatesResponse)
    async def delete_embed_template(modelId: str) -> EmbedTemplatesResponse:
        if not modelId.strip():
            raise HTTPException(status_code=400, detail="modelId is required")
        get_store().delete(modelId)
        return _list()

    return router
