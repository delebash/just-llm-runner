# SPDX-License-Identifier: MIT
"""Shared feature-routing router behind a host-supplied storage boundary.

The Routing tab of the shared AI UI edits the global **default** LLM (+ embedding)
provider. Per-feature routing is owned by the ACTION's engine preset now (2026-07-15
— the JW-path pin tier was removed; the preset carries provider+model).

Like `provider_api.py` and `prompts.py`, this is a router factory over a
host-supplied `RoutingStore` (real persistence — both apps in their shared DB
routing tables) plus the host's **feature catalog** (which features exist + their
labels/hints/group — per-app data). The GET merges the catalog with the stored
pins so the UI renders one row per feature with its current route; the PUT persists
the whole routing config.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Protocol

from fastapi import APIRouter
from pydantic import BaseModel


# ── wire shapes (camelCase) ─────────────────────────────────────────────────
class RoutingDefaults(BaseModel):
    llmId: str = ""
    model: str = ""  # the default provider's model (empty → that provider's own default)
    embeddingId: str = ""
    embeddingModel: str = ""  # the embedding provider's model (empty → its own default)


class RoutingConfig(BaseModel):
    """The stored routing shape (PUT body): the global default LLM + embedding.
    Per-feature pins were removed 2026-07-15 (the preset is the one source of routing)."""

    default: RoutingDefaults = RoutingDefaults()


class FeatureRow(BaseModel):
    """One catalog feature (GET response) — key/label/hint + its nav group."""

    key: str
    label: str
    hint: str = ""
    group: str = ""  # the catalog's nav grouping (display-only), e.g. "Writing", "Analysis"


class RoutingResponse(BaseModel):
    default: RoutingDefaults
    features: list[FeatureRow]


# ── host boundaries ─────────────────────────────────────────────────────────
class RoutingStore(Protocol):
    """Persistence boundary the host implements over its own settings."""

    def get_routing(self) -> RoutingConfig: ...
    def set_routing(self, cfg: RoutingConfig) -> None: ...


@dataclass
class FeatureCatalogEntry:
    """One feature the host exposes for routing — its key, human label, a hint,
    and the nav group it belongs to (`group`, display-only; NOT a routing key —
    routing is owned by the action's preset)."""

    key: str
    label: str
    hint: str = ""
    group: str = ""


def make_routing_router(
    get_store: Callable[[], RoutingStore],
    get_catalog: Callable[[], list[FeatureCatalogEntry]],
) -> APIRouter:
    """Build the /v1/ai/routing GET+PUT router over a host `RoutingStore` and the
    host's feature catalog."""
    router = APIRouter(tags=["ai"], prefix="/v1/ai")

    def _response() -> RoutingResponse:
        cfg = get_store().get_routing()
        rows = [
            FeatureRow(key=e.key, label=e.label, hint=e.hint, group=e.group)
            for e in get_catalog()
        ]
        return RoutingResponse(default=cfg.default, features=rows)

    @router.get("/routing", response_model=RoutingResponse)
    async def get_routing() -> RoutingResponse:
        return _response()

    @router.put("/routing", response_model=RoutingResponse)
    async def put_routing(body: RoutingConfig) -> RoutingResponse:
        get_store().set_routing(body)
        return _response()

    return router

