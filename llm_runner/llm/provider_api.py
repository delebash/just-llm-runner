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
import re
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
    "xai",
    "mistral",
    # The bundled llama.cpp runner. Not offered as a user-pickable type in the
    # UI (the built-in provider is seeded), but allowed here so that seeded
    # provider round-trips through PATCH instead of 400-ing on save.
    "local-llamacpp",
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
    providerType: str
    baseUrl: str = ""
    defaultModel: str = ""
    embeddingModel: str = ""
    hasApiKey: bool
    registered: bool  # True if the adapter is live in the registry
    timeoutSeconds: int = 60
    local: bool = True  # the stored Local/Online choice — drives UI grouping


class LLMProviderList(BaseModel):
    providers: list[LLMProviderResponse]
    providerTypes: list[str] = PROVIDER_TYPES


class UpsertLLMProviderRequest(BaseModel):
    # Optional on create: when blank, the server derives a slug id from `name`
    # (one name to type, not two). On PATCH the path param identifies the row,
    # so the body id is ignored either way.
    id: str = Field("", max_length=80)
    name: str = Field(..., min_length=1, max_length=120)
    providerType: str
    baseUrl: str = ""
    # `apiKey` is write-only — list responses never echo it. PATCH with an empty
    # string means "leave the existing key in place"; PATCH with null clears it.
    apiKey: str | None = None
    defaultModel: str = ""
    embeddingModel: str = ""
    timeoutSeconds: int = 60
    local: bool = True  # Local (on this machine) vs Online (metered cloud)


class DetectedLocalProvider(BaseModel):
    providerType: str  # "ollama" | "openai-compat" — a canonical PROVIDER_TYPES value
    name: str
    baseUrl: str
    models: list[str]
    alreadyRegistered: bool


class DetectLocalResponse(BaseModel):
    detected: list[DetectedLocalProvider]


def _to_response(cfg: LLMProviderConfig, registered: bool) -> LLMProviderResponse:
    return LLMProviderResponse(
        id=cfg.id,
        name=cfg.name,
        providerType=cfg.providerType,
        baseUrl=cfg.baseUrl,
        defaultModel=cfg.defaultModel,
        embeddingModel=cfg.embeddingModel,
        hasApiKey=bool(cfg.apiKey),
        registered=registered,
        timeoutSeconds=cfg.timeoutSeconds,
        local=cfg.local,
    )


def _slugify(name: str) -> str:
    """A URL-safe provider id from a display name ("My Local LLM" → "my-local-llm"),
    capped at 80 chars to match the request id limit."""
    slug = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")[:80].rstrip("-")
    return slug or "provider"


def _unique_id(store: ProviderStore, base: str) -> str:
    """`base`, or `base-2`, `base-3`, … — the first id not already taken."""
    existing = {p.id for p in store.list()}
    if base not in existing:
        return base
    n = 2
    while f"{base}-{n}" in existing:
        n += 1
    return f"{base}-{n}"


def _check_type(provider_type: str) -> None:
    if provider_type not in PROVIDER_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"unknown providerType {provider_type!r}. Allowed: {', '.join(PROVIDER_TYPES)}",
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
        _check_type(body.providerType)
        store = get_store()
        # Derive the id from the name when the client doesn't supply one.
        provider_id = body.id.strip() or _unique_id(store, _slugify(body.name))
        if store.get(provider_id) is not None:
            raise HTTPException(status_code=400, detail=f"LLM provider id {provider_id!r} already exists")
        cfg = LLMProviderConfig(
            id=provider_id,
            name=body.name,
            providerType=body.providerType,
            baseUrl=body.baseUrl,
            apiKey=body.apiKey or None,
            defaultModel=body.defaultModel,
            embeddingModel=body.embeddingModel,
            timeoutSeconds=body.timeoutSeconds,
            local=body.local,
        )
        store.add(cfg)
        registered = _sync_register(cfg)
        return _to_response(cfg, registered)

    @router.patch("/v1/llm-providers/{provider_id}", response_model=LLMProviderResponse)
    async def update_llm_provider(provider_id: str, body: UpsertLLMProviderRequest) -> LLMProviderResponse:
        _check_type(body.providerType)
        store = get_store()
        existing = store.get(provider_id)
        if existing is None:
            raise HTTPException(status_code=404, detail=f"LLM provider {provider_id}")
        # empty string preserves the prior key (write-only field); None clears it.
        api_key = existing.apiKey if body.apiKey == "" else body.apiKey
        cfg = LLMProviderConfig(
            id=existing.id,  # id is immutable; reassigning would orphan feature pins
            name=body.name,
            providerType=body.providerType,
            baseUrl=body.baseUrl,
            apiKey=api_key,
            defaultModel=body.defaultModel,
            embeddingModel=body.embeddingModel,
            timeoutSeconds=body.timeoutSeconds,
            local=body.local,
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

        registered_urls = {(p.baseUrl or "").rstrip("/") for p in get_store().list()}
        out: list[DetectedLocalProvider] = []
        probes = [
            ("ollama", "Ollama (local)", "http://127.0.0.1:11434", "/api/tags",
             lambda d: [m.get("name", "") for m in d.get("models", [])]),
            ("openai-compat", "LM Studio (local)", "http://127.0.0.1:1234", "/v1/models",
             lambda d: [m.get("id", "") for m in d.get("data", [])]),
        ]
        for ptype, name, base, path, extract in probes:
            try:
                r = httpx.get(base + path, timeout=1.5)
                if r.status_code != 200:
                    continue
                models = [m for m in extract(r.json()) if m]
                out.append(DetectedLocalProvider(
                    providerType=ptype, name=name, baseUrl=base, models=models,
                    alreadyRegistered=base in registered_urls,
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
