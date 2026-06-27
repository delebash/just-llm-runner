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

import uuid
from dataclasses import dataclass
from typing import Callable, Protocol

from fastapi import APIRouter, HTTPException
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


# ── routing presets ("hardware presets" — named routing snapshots) ───────────
# A preset is a saved, named copy of a whole RoutingConfig. Used to switch the
# entire AI config in one click (e.g. desktop vs laptop, offline vs cloud). The
# primary path is still Quick Setup / the Features tab; presets are the
# save-and-switch layer on top (shared-AI-stack plan, Decision 18).


class RoutingPreset(BaseModel):
    id: str = ""
    name: str = ""
    routing: RoutingConfig = RoutingConfig()


class RoutingPresetStore(Protocol):
    """Persistence boundary for named routing presets (host settings)."""

    def list_presets(self) -> list[RoutingPreset]: ...
    def save_preset(self, preset: RoutingPreset) -> None: ...  # upsert by id
    def delete_preset(self, preset_id: str) -> None: ...


class _PresetCreate(BaseModel):
    name: str = ""
    routing: RoutingConfig = RoutingConfig()


class _PresetUpdate(BaseModel):
    name: str | None = None
    routing: RoutingConfig | None = None


class PresetsResponse(BaseModel):
    presets: list[RoutingPreset]


def make_routing_presets_router(
    get_store: Callable[[], RoutingPresetStore],
    get_routing_store: Callable[[], RoutingStore],
) -> APIRouter:
    """CRUD + apply for named routing presets. `apply` writes the preset's
    routing into the active `RoutingStore` (atomic + headless-friendly);
    `from-current` snapshots the active routing into a new named preset."""
    router = APIRouter(tags=["ai"], prefix="/v1/ai")

    def _list() -> PresetsResponse:
        return PresetsResponse(presets=get_store().list_presets())

    def _find(preset_id: str) -> RoutingPreset:
        for p in get_store().list_presets():
            if p.id == preset_id:
                return p
        raise HTTPException(status_code=404, detail=f"routing preset {preset_id!r} not found")

    @router.get("/routing-presets", response_model=PresetsResponse)
    async def list_presets() -> PresetsResponse:
        return _list()

    @router.post("/routing-presets", response_model=PresetsResponse)
    async def create_preset(body: _PresetCreate) -> PresetsResponse:
        get_store().save_preset(RoutingPreset(id=uuid.uuid4().hex[:12], name=body.name, routing=body.routing))
        return _list()

    @router.post("/routing-presets/from-current", response_model=PresetsResponse)
    async def create_from_current(body: _PresetCreate) -> PresetsResponse:
        cfg = get_routing_store().get_routing()
        get_store().save_preset(RoutingPreset(id=uuid.uuid4().hex[:12], name=body.name, routing=cfg))
        return _list()

    @router.put("/routing-presets/{preset_id}", response_model=PresetsResponse)
    async def update_preset(preset_id: str, body: _PresetUpdate) -> PresetsResponse:
        preset = _find(preset_id)
        if body.name is not None:
            preset.name = body.name
        if body.routing is not None:
            preset.routing = body.routing
        get_store().save_preset(preset)
        return _list()

    @router.delete("/routing-presets/{preset_id}", response_model=PresetsResponse)
    async def delete_preset(preset_id: str) -> PresetsResponse:
        get_store().delete_preset(preset_id)
        return _list()

    @router.post("/routing-presets/{preset_id}/apply", response_model=RoutingPreset)
    async def apply_preset(preset_id: str) -> RoutingPreset:
        preset = _find(preset_id)
        get_routing_store().set_routing(preset.routing)
        return preset

    return router
