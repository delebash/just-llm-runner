# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared provider-CRUD router behind a host-supplied storage boundary.

Unlike `api.py` (storage-free endpoints over the shared registry/ledger), the
provider list is persisted per app — JustVoice in `settings.engines.llm`,
JustWrite in its `LlmProvider` table. So this is a **router factory**: the host
passes a `ProviderStore` (a genuine persistence boundary that does real work —
RULE #8, not a forwarding shim) and gets a ready `/v1/llm-providers*` router that
both apps mount identically. The CRUD logic, validation, adapter-registry sync,
and local-server detection live here ONCE; only persistence differs per app.
"""

from __future__ import annotations

import logging
from typing import Callable, Protocol

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .registry import construct, get_llm_registry
from .schema import LLMProviderConfig

log = logging.getLogger(__name__)

PROVIDER_TYPES = [
    "anthropic",
    "openai",
    "openai-compat",
    "gemini",
    "ollama",
    "deepseek",
    "openrouter",
]


class ProviderStore(Protocol):
    """Persistence boundary the host implements over its own storage."""

    def list(self) -> list[LLMProviderConfig]: ...
    def get(self, provider_id: str) -> LLMProviderConfig | None: ...
    def add(self, cfg: LLMProviderConfig) -> None: ...
    def replace(self, provider_id: str, cfg: LLMProviderConfig) -> None: ...
    def remove(self, provider_id: str) -> None: ...


class LLMProviderResponse(BaseModel):
    id: str
    name: str
    provider_type: str
    base_url: str = ""
    default_model: str = ""
    embedding_model: str = ""
    has_api_key: bool
    registered: bool  # True if the adapter is live in the registry
    timeout_seconds: int = 60


class LLMProviderList(BaseModel):
    providers: list[LLMProviderResponse]
    provider_types: list[str] = PROVIDER_TYPES


class UpsertLLMProviderRequest(BaseModel):
    id: str = Field(..., min_length=1, max_length=80)
    name: str = Field(..., min_length=1, max_length=120)
    provider_type: str
    base_url: str = ""
    # `api_key` is write-only — list responses never echo it. PATCH with an empty
    # string means "leave the existing key in place"; PATCH with null clears it.
    api_key: str | None = None
    default_model: str = ""
    embedding_model: str = ""
    timeout_seconds: int = 60


class DetectedLocalProvider(BaseModel):
    provider_type: str  # "ollama" | "openai_compat"
    name: str
    base_url: str
    models: list[str]
    already_registered: bool


class DetectLocalResponse(BaseModel):
    detected: list[DetectedLocalProvider]


def _to_response(cfg: LLMProviderConfig, registered: bool) -> LLMProviderResponse:
    return LLMProviderResponse(
        id=cfg.id,
        name=cfg.name,
        provider_type=cfg.provider_type,
        base_url=cfg.base_url,
        default_model=cfg.default_model,
        embedding_model=cfg.embedding_model,
        has_api_key=bool(cfg.api_key),
        registered=registered,
        timeout_seconds=cfg.timeout_seconds,
    )


def _check_type(provider_type: str) -> None:
    if provider_type not in PROVIDER_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"unknown provider_type {provider_type!r}. Allowed: {', '.join(PROVIDER_TYPES)}",
        )


def make_provider_router(get_store: Callable[[], ProviderStore]) -> APIRouter:
    """Build the /v1/llm-providers router over a host-supplied `ProviderStore`."""
    router = APIRouter(tags=["llm"])

    @router.get("/v1/llm-providers", response_model=LLMProviderList)
    async def list_llm_providers() -> LLMProviderList:
        registered_ids = set(get_llm_registry().ids())
        return LLMProviderList(
            providers=[_to_response(c, c.id in registered_ids) for c in get_store().list()]
        )

    @router.post("/v1/llm-providers", response_model=LLMProviderResponse, status_code=201)
    async def create_llm_provider(body: UpsertLLMProviderRequest) -> LLMProviderResponse:
        _check_type(body.provider_type)
        store = get_store()
        if store.get(body.id) is not None:
            raise HTTPException(status_code=400, detail=f"LLM provider id {body.id!r} already exists")
        cfg = LLMProviderConfig(
            id=body.id,
            name=body.name,
            provider_type=body.provider_type,
            base_url=body.base_url,
            api_key=body.api_key or None,
            default_model=body.default_model,
            embedding_model=body.embedding_model,
            timeout_seconds=body.timeout_seconds,
        )
        store.add(cfg)
        registered = _sync_register(cfg)
        return _to_response(cfg, registered)

    @router.patch("/v1/llm-providers/{provider_id}", response_model=LLMProviderResponse)
    async def update_llm_provider(provider_id: str, body: UpsertLLMProviderRequest) -> LLMProviderResponse:
        _check_type(body.provider_type)
        store = get_store()
        existing = store.get(provider_id)
        if existing is None:
            raise HTTPException(status_code=404, detail=f"LLM provider {provider_id}")
        # empty string preserves the prior key (write-only field); None clears it.
        api_key = existing.api_key if body.api_key == "" else body.api_key
        cfg = LLMProviderConfig(
            id=existing.id,  # id is immutable; reassigning would orphan feature pins
            name=body.name,
            provider_type=body.provider_type,
            base_url=body.base_url,
            api_key=api_key,
            default_model=body.default_model,
            embedding_model=body.embedding_model,
            timeout_seconds=body.timeout_seconds,
        )
        store.replace(provider_id, cfg)
        get_llm_registry().deregister(cfg.id)
        registered = _sync_register(cfg)
        return _to_response(cfg, registered)

    @router.delete("/v1/llm-providers/{provider_id}")
    async def delete_llm_provider(provider_id: str) -> dict:
        store = get_store()
        if store.get(provider_id) is None:
            raise HTTPException(status_code=404, detail=f"LLM provider {provider_id}")
        store.remove(provider_id)
        get_llm_registry().deregister(provider_id)
        return {"deleted": True}

    @router.get("/v1/llm-providers/detect-local", response_model=DetectLocalResponse)
    async def detect_local_llm_providers() -> DetectLocalResponse:
        """Probe the well-known local LLM servers (Ollama :11434, LM Studio
        :1234) — powers the first-run "Ollama detected → Connect" row."""
        import httpx

        registered_urls = {(p.base_url or "").rstrip("/") for p in get_store().list()}
        out: list[DetectedLocalProvider] = []
        probes = [
            ("ollama", "Ollama (local)", "http://127.0.0.1:11434", "/api/tags",
             lambda d: [m.get("name", "") for m in d.get("models", [])]),
            ("openai_compat", "LM Studio (local)", "http://127.0.0.1:1234", "/v1/models",
             lambda d: [m.get("id", "") for m in d.get("data", [])]),
        ]
        for ptype, name, base, path, extract in probes:
            try:
                r = httpx.get(base + path, timeout=1.5)
                if r.status_code != 200:
                    continue
                models = [m for m in extract(r.json()) if m]
                out.append(DetectedLocalProvider(
                    provider_type=ptype, name=name, base_url=base, models=models,
                    already_registered=base in registered_urls,
                ))
            except Exception:  # noqa: BLE001 - a down probe is just "not detected"
                continue
        return DetectLocalResponse(detected=out)

    return router


def _sync_register(cfg: LLMProviderConfig) -> bool:
    """Construct + register the adapter so the change takes effect live. A bad
    config is persisted but logged-not-fatal (matches the prior JV behavior)."""
    try:
        get_llm_registry().register(construct(cfg))
        return True
    except Exception as e:  # noqa: BLE001
        log.warning("LLM provider %s persisted but not registered: %s", cfg.id, e)
        return False
