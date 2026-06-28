# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared feature-routing router behind a host-supplied storage boundary.

The Routing tabs of the shared AI UI edit three things, all of which feed the
dispatch precedence chain (see `dispatch.resolve_pin`):
  - the global **default** LLM (+ embedding) provider,
  - the per-**job** model map (`jobs`; the unit that replaced quick/accuracy roles),
  - per-feature/action **pins** (an explicit provider+model that overrides the job).

Like `provider_api.py` and `prompts.py`, this is a router factory over a
host-supplied `RoutingStore` (real persistence — both apps in their shared DB
routing tables) plus the host's **feature catalog** (which features exist + their
labels/hints/category — per-app data). The GET merges the catalog with the stored
pins so the UI renders one row per feature with its current route; the PUT persists
the whole routing config. (Named whole-config "routing presets" were dropped per
the 2026-06-28 soundness pass — per-job presets live in `job_presets_api`.)
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Protocol

from fastapi import APIRouter
from pydantic import BaseModel


# ── wire shapes (camelCase) ─────────────────────────────────────────────────
class JobTarget(BaseModel):
    """The provider+model that runs a job (job_id → this). `quality` is the
    Fast/Balanced/Best dial stop the user picked (model is the resolved pick;
    "" quality = an explicit model pin, no dial)."""

    providerId: str = ""
    model: str = ""
    quality: str = ""


class RoutingDefaults(BaseModel):
    llmId: str = ""
    model: str = ""  # the default provider's model (empty → that provider's own default)
    embeddingId: str = ""
    embeddingModel: str = ""  # the embedding provider's model (empty → its own default)


class FeaturePin(BaseModel):
    """An explicit per-feature provider+model override (empty = inherit the
    feature's job)."""

    providerId: str = ""
    model: str = ""


class RoutingConfig(BaseModel):
    """The stored routing shape (PUT body). `jobs` maps job_id → its provider+model
    (what QuickSetup / Routing-by-job set); `pins` are explicit per-feature
    overrides. A feature inherits its job's target unless pinned."""

    default: RoutingDefaults = RoutingDefaults()
    jobs: dict[str, JobTarget] = {}
    pins: dict[str, FeaturePin] = {}


class FeatureRow(BaseModel):
    """One catalog feature merged with its current explicit pin (GET response).
    The feature's job classification comes from the /v1/ai/feature-jobs map."""

    key: str
    label: str
    hint: str = ""
    category: str = ""  # the catalog's nav group (e.g. "Writing", "Analysis")
    providerId: str = ""
    model: str = ""


class RoutingResponse(BaseModel):
    default: RoutingDefaults
    jobs: dict[str, JobTarget] = {}  # job_id → (provider, model)
    features: list[FeatureRow]
    # The raw stored pins, keyed by feature OR action key (e.g. "writerAI.tighten"),
    # for the Feature Workbench.
    pins: dict[str, FeaturePin] = {}


# ── host boundaries ─────────────────────────────────────────────────────────
class RoutingStore(Protocol):
    """Persistence boundary the host implements over its own settings."""

    def get_routing(self) -> RoutingConfig: ...
    def set_routing(self, cfg: RoutingConfig) -> None: ...


@dataclass
class FeatureCatalogEntry:
    """One feature the host exposes for routing — its key, human label, a hint,
    and the nav group it belongs to (category). The feature's job classification
    is separate data (the feature_jobs map)."""

    key: str
    label: str
    hint: str = ""
    category: str = ""


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
                category=e.category,
                providerId=(p := cfg.pins.get(e.key) or FeaturePin()).providerId,
                model=p.model,
            )
            for e in get_catalog()
        ]
        return RoutingResponse(
            default=cfg.default, jobs=cfg.jobs, features=rows, pins=cfg.pins
        )

    @router.get("/routing", response_model=RoutingResponse)
    async def get_routing() -> RoutingResponse:
        return _response()

    @router.put("/routing", response_model=RoutingResponse)
    async def put_routing(body: RoutingConfig) -> RoutingResponse:
        get_store().set_routing(body)
        return _response()

    return router

