# SPDX-License-Identifier: GPL-3.0-or-later
"""Mountable FastAPI router for the storage-free LLM endpoints.

These endpoints need NO per-app persistence — they operate purely on the
shared registry + usage ledger (process singletons), so the SAME router is
mounted by every app (JustVoice, JustWrite, future). The storage-coupled
provider CRUD (which reads/writes each app's settings) stays behind a
host-supplied store and lands in a later unit (see the shared-AI-stack plan).

Mount with `app.include_router(llm_runner.llm.api.router)`.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .registry import construct, get_llm_registry
from .schema import LLMProviderConfig
from .tiers import TIERS, classify
from .usage import get_ledger

log = logging.getLogger(__name__)

router = APIRouter(tags=["llm"])


class TierClassifyRequest(BaseModel):
    model: str


class TierClassifyResponse(BaseModel):
    model: str
    tier: str
    system_key: str
    think: bool
    confidence_floor: float


@router.post("/v1/llm-providers/classify-tier", response_model=TierClassifyResponse)
async def classify_model_tier(body: TierClassifyRequest) -> TierClassifyResponse:
    """Auto-classify a model id into a tier. Settings/Lab call this to show
    "this model auto-routes to Reasoned" before the user pins a feature."""
    spec = TIERS[classify(body.model)]
    return TierClassifyResponse(
        model=body.model,
        tier=spec.name,
        system_key=spec.system_key,
        think=spec.think,
        confidence_floor=spec.confidence_floor,
    )


@router.post("/v1/llm-providers/{provider_id}/ping")
async def ping_llm_provider(provider_id: str) -> dict:
    adapter = get_llm_registry().get(provider_id)
    if adapter is None:
        raise HTTPException(status_code=404, detail=f"LLM provider {provider_id} (not registered)")
    try:
        return {"ok": adapter.ping()}
    except Exception as e:  # noqa: BLE001 - surface provider errors as data
        return {"ok": False, "error": str(e)}


@router.get("/v1/llm-providers/{provider_id}/models")
async def list_provider_models(provider_id: str) -> dict:
    adapter = get_llm_registry().get(provider_id)
    if adapter is None:
        raise HTTPException(status_code=404, detail=f"LLM provider {provider_id} (not registered)")
    try:
        return {"models": adapter.models()}
    except Exception as e:  # noqa: BLE001
        log.warning("LLM provider %s models() failed: %s", provider_id, e)
        return {"models": [], "error": str(e)}


class ProbeModelsRequest(BaseModel):
    providerType: str
    baseUrl: str = ""
    apiKey: str | None = None
    defaultModel: str = ""
    timeoutSeconds: int = 30


@router.post("/v1/llm-providers/probe-models")
async def probe_provider_models(body: ProbeModelsRequest) -> dict:
    """List a provider's models from an UNSAVED draft — the Add/Edit form's
    "Fetch models" before the provider is persisted/registered. Builds a
    temporary adapter (never registered) and calls .models()."""
    try:
        adapter = construct(LLMProviderConfig(
            id="__probe__",
            name="probe",
            providerType=body.providerType,
            baseUrl=body.baseUrl,
            apiKey=body.apiKey or None,
            defaultModel=body.defaultModel,
            timeoutSeconds=body.timeoutSeconds,
        ))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    try:
        return {"models": adapter.models()}
    except Exception as e:  # noqa: BLE001 — surface upstream errors as data
        log.warning("probe-models for %s failed: %s", body.providerType, e)
        return {"models": [], "error": str(e)}


@router.get("/v1/ai-usage")
async def ai_usage() -> dict:
    """Token + duration ledger per feature (Settings → AI usage)."""
    return get_ledger().snapshot()


@router.delete("/v1/ai-usage")
async def clear_ai_usage() -> dict:
    get_ledger().clear()
    return {"cleared": True}
