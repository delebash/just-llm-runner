# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared feature-routing router behind a host-supplied storage boundary.

The Features tab of the shared AI UI edits three things, all of which feed the
dispatch precedence chain (see `dispatch.resolve_pin`):
  - the global **default** LLM (+ embedding) provider,
  - the **Quick / Accuracy roles** (provider+model a feature can inherit),
  - per-feature **pins** (an explicit provider+model, or "inherit a role").

Like `provider_api.py` and `prompts.py`, this is a router factory over a
host-supplied `RoutingStore` (real persistence — JustWrite in its `ai` settings
blob, JustVoice in `settings.engines.*`) plus the host's **feature catalog**
(which features exist + their labels/hints/default role — per-app data). The
GET merges the catalog with the stored pins so the UI renders one row per
feature with its current route; the PUT persists the whole routing config.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Protocol

from fastapi import APIRouter
from pydantic import BaseModel


# ── wire shapes (camelCase) ─────────────────────────────────────────────────
class RoleTarget(BaseModel):
    providerId: str = ""
    model: str = ""


class RoutingDefaults(BaseModel):
    llmId: str = ""
    embeddingId: str = ""


class FeaturePin(BaseModel):
    providerId: str = ""
    model: str = ""
    role: str = ""  # "quick" | "accuracy" | "" (empty = explicit provider, or none)


class RoutingConfig(BaseModel):
    """The stored routing shape (PUT body)."""

    default: RoutingDefaults = RoutingDefaults()
    quick: RoleTarget = RoleTarget()
    accuracy: RoleTarget = RoleTarget()
    pins: dict[str, FeaturePin] = {}


class FeatureRow(BaseModel):
    """One catalog feature merged with its current pin (GET response)."""

    key: str
    label: str
    hint: str = ""
    defaultRole: str = ""  # the catalog's fallback role when unpinned
    providerId: str = ""
    model: str = ""
    role: str = ""


class RoutingResponse(BaseModel):
    default: RoutingDefaults
    quick: RoleTarget
    accuracy: RoleTarget
    features: list[FeatureRow]


# ── host boundaries ─────────────────────────────────────────────────────────
class RoutingStore(Protocol):
    """Persistence boundary the host implements over its own settings."""

    def get_routing(self) -> RoutingConfig: ...
    def set_routing(self, cfg: RoutingConfig) -> None: ...


@dataclass
class FeatureCatalogEntry:
    """One feature the host exposes for routing — its key, human label, a hint,
    and the role it falls back to when unpinned (the dispatch default role)."""

    key: str
    label: str
    hint: str = ""
    role: str = ""


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
            FeatureRow(
                key=e.key,
                label=e.label,
                hint=e.hint,
                defaultRole=e.role,
                providerId=(p := cfg.pins.get(e.key) or FeaturePin()).providerId,
                model=p.model,
                role=p.role,
            )
            for e in get_catalog()
        ]
        return RoutingResponse(default=cfg.default, quick=cfg.quick, accuracy=cfg.accuracy, features=rows)

    @router.get("/routing", response_model=RoutingResponse)
    async def get_routing() -> RoutingResponse:
        return _response()

    @router.put("/routing", response_model=RoutingResponse)
    async def put_routing(body: RoutingConfig) -> RoutingResponse:
        get_store().set_routing(body)
        return _response()

    return router
