# SPDX-License-Identifier: MIT
"""Choose where the engine + model cache lives — `GET/PUT /v1/ai/engine-cache`.

The problem this solves, measured on the author's box 2026-08-03: two family apps
each kept their own `<data>/ai-cache` and so held the SAME model twice —
`unsloth/gemma-4-26B-A4B-it-qat-GGUF @ UD-Q4_K_XL`, **14,249,047,104 bytes in both**
— plus two full llama.cpp installs. The artifacts are content-addressed (repo +
quant + snapshot; build number), so the second copy buys nothing.

The user ruled the shape: **detect an existing family cache during Quick Setup and
ASK, with an override** for an app that should keep its own. So this endpoint reports
what exists and records a CHOICE — it never moves, copies or deletes a byte. A cache
you already filled stays exactly where it is, and switching back is the same one
click. The choice binds at wiring time (`install_llm`), so it applies on the next
start; swapping the cache under a running engine is not a thing.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..runner import cache_registry


class CacheOption(BaseModel):
    root: str
    exists: bool
    engineBuilds: list[str] = []
    models: list[str] = []
    bytes: int = 0
    product: str = ""      # the app that registered it ("" = the family default spot)
    lastSeen: str = ""


class CacheState(BaseModel):
    root: str              # the cache in use right now
    ownRoot: str           # this app's private cache (`<data>/ai-cache`)
    runtimeRoot: str       # where THIS app's models.ini + spawn logs go
    shared: bool           # is `root` somewhere other than ownRoot?
    stored: str            # the recorded choice ("" = follow ownRoot)
    current: CacheOption
    options: list[CacheOption]   # siblings worth offering — never includes `root`


class CacheChoice(BaseModel):
    root: str = ""         # "" = go back to this app's own cache


def make_cache_router(data_dir=None, product: str = "") -> APIRouter:
    """Build the engine-cache router. `data_dir` is what makes "my own cache" a
    knowable path — the runner service is app-agnostic and cannot answer that."""
    router = APIRouter(tags=["ai"], prefix="/v1/ai")
    own = (Path(data_dir) / "ai-cache") if data_dir else None

    def _state() -> CacheState:
        from ..runner.lifecycle import get_service
        from .stores import get_runner_config_store

        svc = get_service()
        root = svc.cache_root
        try:
            stored = get_runner_config_store().get_cache_root()
        except Exception:  # noqa: BLE001 — a pre-seed DB is not an error here
            stored = ""
        # Exclude the app's OWN root as well as the one in use: this function offers
        # "keep my own" explicitly below, and the registry still carries this app's
        # own row from boot — passing only `root` listed it twice once we shared.
        options = [CacheOption(**o) for o in cache_registry.discover(exclude=(root, own))]
        if own and Path(root) != own:
            # Always offer the way back. It is listed even when empty: "my own cache"
            # is a real choice, not a directory that has to already exist.
            options.insert(0, CacheOption(**cache_registry.summarize(own), product="this app"))
        return CacheState(
            root=str(root), ownRoot=str(own or ""), runtimeRoot=str(svc.runtime_root),
            shared=bool(own and Path(root) != own), stored=stored,
            current=CacheOption(**cache_registry.summarize(root)),
            options=options,
        )

    @router.get("/engine-cache", response_model=CacheState)
    async def get_engine_cache() -> CacheState:
        return _state()

    @router.put("/engine-cache")
    async def set_engine_cache(body: CacheChoice) -> dict:
        """Record the choice and, when the engine is idle, apply it immediately.

        NOTHING is moved — the previous cache keeps its files, which is what makes this
        reversible and what stops a mis-click costing 14 GB. Applying live matters
        because Quick Setup asks this BEFORE the first download: a choice that waited
        for a restart would be contradicted by the download the same wizard starts."""
        from ..runner.lifecycle import get_service
        from .install import resolve_cache_roots
        from .stores import get_runner_config_store

        chosen = (body.root or "").strip()
        if chosen:
            path = Path(chosen)
            if not path.is_absolute():
                raise HTTPException(400, "cache root must be an absolute path")
            try:
                path.mkdir(parents=True, exist_ok=True)
            except OSError as e:
                raise HTTPException(400, f"cannot use {path}: {e}") from e
            if own and path == own:
                chosen = ""   # "my own cache" is stored as the absence of a choice
        get_runner_config_store().set_cache_root(chosen)

        cache, runtime, _shared = resolve_cache_roots(data_dir, stored=chosen)
        applied, detail = False, ""
        if cache:
            try:
                get_service().repoint_cache(cache, runtime)
                applied = True
                # Keep the family registry truthful: it said where this app cached at
                # BOOT, and that is no longer where it caches.
                cache_registry.register(product or (Path(data_dir).name if data_dir else ""),
                                        cache, data_dir)
            except RuntimeError as e:
                detail = str(e)   # busy: the choice stands, it just waits for a restart
        return {"ok": True, "root": str(cache or own or ""), "applied": applied,
                "restartRequired": not applied, "detail": detail}

    return router
