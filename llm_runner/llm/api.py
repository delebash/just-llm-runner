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


def _builtin_provider_health() -> dict:
    """The BUILT-IN provider's honest health (#139, the user's "✗ reachable, but no
    models listed" screenshot, 2026-07-07): the generic OpenAI-style probe asks the
    LAZY router for /v1/models before anything ever loads, so a perfectly configured
    box reads as broken. The built-in's real health = engine installed + a catalog
    to load from; models load on first use BY DESIGN. Composed HERE (one source) so
    the form's Test connection AND the list row's ping can never disagree. Lazy
    imports — this router is charter-storage-free, but every install_llm app wires
    storage + the runner before serving; the built-in branch is the recorded
    exception (it IS the storage-backed provider)."""
    from ..runner.lifecycle import get_service
    from . import stores

    st = get_service().engine_status()
    rows = stores.get_model_catalog_store().list()
    installed = bool(st.get("installed"))
    bits = []
    if installed:
        build = st.get("build") or ""
        gpu = st.get("gpu") or ""
        bits.append("engine installed" + (f" · {build}" if build else "") + (f" · {gpu}" if gpu else ""))
    else:
        bits.append("engine not installed — install it on the Built-in provider row")
    bits.append(f"{len(rows)} model{'s' if len(rows) != 1 else ''} in the catalog")
    bits.append("models load on first use")
    return {
        "ok": installed and bool(rows), "builtin": True,
        "detail": " · ".join(bits),
        "models": [r.id for r in rows],
    }


@router.post("/v1/llm-providers/{provider_id}/ping")
async def ping_llm_provider(provider_id: str) -> dict:
    # The built-in engine's health is composed, never probed over its lazy router
    # (#139) — the id is the seeded constant.
    if provider_id == "local-llamacpp":
        try:
            h = _builtin_provider_health()
            return {"ok": h["ok"], "detail": h["detail"], "builtin": True}
        except Exception as e:  # noqa: BLE001 — surface as data, like every ping
            return {"ok": False, "error": str(e)}
    adapter = get_llm_registry().get(provider_id)
    if adapter is None:
        raise HTTPException(status_code=404, detail=f"LLM provider {provider_id} (not registered)")
    try:
        return {"ok": adapter.ping()}
    except Exception as e:  # noqa: BLE001 - surface provider errors as data
        return {"ok": False, "error": str(e)}


@router.get("/v1/llm-providers/{provider_id}/models")
async def list_provider_models(provider_id: str) -> dict:
    # The BUILT-IN engine's models are the CATALOG (every downloaded model), NOT the lazy
    # router's resident set (#305 / same root as #139): the openai-compat adapter would
    # query the live llama-server /v1/models = only the loaded model, so a freshly
    # downloaded model never shows in the picker. Compose from the catalog here — the same
    # source the probe/health uses (they can never disagree).
    if provider_id == "local-llamacpp":
        try:
            h = _builtin_provider_health()
            out = {"models": h["models"]}
            if not h["ok"]:
                out["error"] = h["detail"]
            return out
        except Exception as e:  # noqa: BLE001 — surface as data
            return {"models": [], "error": str(e)}
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
    # The built-in engine never probes its lazy router (#139): its models are the
    # CATALOG, and its health line explains the load-on-first-use design.
    if body.providerType == "local-llamacpp":
        try:
            h = _builtin_provider_health()
            out = {"models": h["models"], "detail": h["detail"]}
            if not h["ok"]:
                out["error"] = h["detail"]
            return out
        except Exception as e:  # noqa: BLE001 — surface as data, like every probe
            return {"models": [], "error": str(e)}
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


class EmbeddingsRequest(BaseModel):
    providerId: str
    model: str = ""
    input: list[str] = []
    # Embed task side (Move 0, RAG build): "document" | "query" | "" (= raw).
    # When the model has a catalog template row for the side, each input is
    # wrapped server-side (nomic prefixes / Qwen3 query instruction).
    taskType: str = ""


# The embed-template resolver seam — this router is storage-free by charter,
# so install_llm injects a resolver over the host's ModelEmbedTemplate store
# (the set_ledger / set_ensure_local_model DI pattern). Unset (headless import,
# tests) → templates simply don't apply.
_embed_template_resolver = None


def set_embed_template_resolver(fn) -> None:
    """fn(model_id) -> object with .documentTemplate/.queryTemplate, or None."""
    global _embed_template_resolver
    _embed_template_resolver = fn


def _apply_embed_template(model_id: str, task_type: str, texts: list[str]) -> list[str]:
    """Wrap each text in the model's task template for the given side. Any of:
    no resolver / no row / empty side / empty taskType → the texts unchanged."""
    if _embed_template_resolver is None or task_type not in ("document", "query") or not model_id:
        return texts
    row = _embed_template_resolver(model_id)
    if row is None:
        return texts
    template = (row.documentTemplate if task_type == "document" else row.queryTemplate) or ""
    if "{text}" not in template:
        return texts
    return [template.replace("{text}", t) for t in texts]


@router.post("/v1/ai/embeddings")
async def ai_embeddings(body: EmbeddingsRequest) -> dict:
    """Embed texts through a registered provider (server-held key) — the shared
    replacement for the old `/v1/llm/{id}/embeddings` proxy. The client passes
    the embedding provider id (its routing default) + model; non-embedding
    providers (Anthropic/Gemini) report a clear 400. `taskType` applies the
    model's catalog embed template (a model with no row passes through)."""
    adapter = get_llm_registry().get(body.providerId)
    if adapter is None:
        raise HTTPException(status_code=404, detail=f"LLM provider {body.providerId} (not registered)")
    embed = getattr(adapter, "embed", None)
    if embed is None:
        raise HTTPException(status_code=400, detail=f"provider {body.providerId} does not support embeddings")
    texts = _apply_embed_template(body.model, body.taskType, body.input)
    try:
        vectors = embed(texts, model=body.model or None)
    except NotImplementedError as e:
        raise HTTPException(status_code=400, detail=f"provider {body.providerId} does not support embeddings") from e
    except Exception as e:  # noqa: BLE001 — surface upstream/transport errors
        raise HTTPException(status_code=502, detail=str(e)[:400]) from e
    return {"embeddings": vectors, "model": body.model or adapter.default_model}


@router.get("/v1/ai-usage")
async def ai_usage() -> dict:
    """Token + duration ledger per feature (Settings → AI usage)."""
    return get_ledger().snapshot()


@router.delete("/v1/ai-usage")
async def clear_ai_usage() -> dict:
    get_ledger().clear()
    return {"cleared": True}
