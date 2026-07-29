# SPDX-License-Identifier: MIT
"""Edit the online-provider model-list ruleset (#8) — GET/PUT + reset on
`/v1/ai/model-list-rules`. The rules are ONE seeded JSON document in the runner-settings
store (host-supplied via the store closures below), keyed by provider TYPE. Same
settings-endpoint shape as engine-config: GET the doc, PUT to replace it, POST /reset to
snap back to the shipped seed. See `model_list_rules.py` for the aging contract."""
from __future__ import annotations

from collections.abc import Callable

from fastapi import APIRouter
from pydantic import BaseModel, Field


class RuleRow(BaseModel):
    # Anchored regexes only (the seed carries the deliberate boundaries); an invalid
    # pattern is skipped at apply time, never a 500 (model_list_rules._compile).
    embedPatterns: list[str] = Field(default_factory=list)
    dropPatterns: list[str] = Field(default_factory=list)
    collapseDated: bool = False


class ModelListRulesDoc(BaseModel):
    seedVersion: int = 0
    rules: dict[str, RuleRow] = Field(default_factory=dict)


def make_model_list_rules_router(
    get_doc: Callable[[], dict],
    set_doc: Callable[[dict], None],
    reset_doc: Callable[[], None],
) -> APIRouter:
    router = APIRouter(tags=["ai"], prefix="/v1/ai")

    @router.get("/model-list-rules", response_model=ModelListRulesDoc)
    async def get_model_list_rules() -> ModelListRulesDoc:
        return ModelListRulesDoc(**get_doc())

    @router.put("/model-list-rules", response_model=ModelListRulesDoc)
    async def put_model_list_rules(body: ModelListRulesDoc) -> ModelListRulesDoc:
        # Round-trip through the validated model so a stored doc is always well-formed
        # (unknown keys dropped, defaults filled) — the store just persists the JSON.
        set_doc(body.model_dump())
        return ModelListRulesDoc(**get_doc())

    @router.post("/model-list-rules/reset", response_model=ModelListRulesDoc)
    async def reset_model_list_rules() -> ModelListRulesDoc:
        reset_doc()
        return ModelListRulesDoc(**get_doc())

    return router
