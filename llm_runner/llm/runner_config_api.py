# SPDX-License-Identifier: GPL-3.0-or-later
"""Edit the bundled llama.cpp engine config — the per-(platform, gpu) download
URLs, the pinned build, the VRAM safety margin, and the two router residency
knobs (`models_max` = how many models stay co-resident; `sleep_idle_seconds` =
the idle-unload TTL, 0 = never). Config is data (DB-backed, seeded), so if a
release asset ever moves/renames the user can paste the corrected URL from the
llama.cpp releases page with no code change. GET/PUT + reset on
`/v1/ai/engine-config`.

The GET serves the same data as the runner's read-only `/v1/llm-runner/config`
(flattened for the editor); the runner reads its live config from the same DB
rows via `build_runner_config()`."""
from __future__ import annotations

from collections.abc import Callable
from typing import Protocol

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel


class RunnerBinaryRow(BaseModel):
    platform: str
    gpu: str
    source: str = "github"            # "github" | "docker"
    assetUrl: str | None = None
    runtimeUrl: str | None = None     # companion (cudart DLLs) unpacked alongside
    image: str | None = None          # docker source only
    serverExe: str = "llama-server"


class EngineConfig(BaseModel):
    pinnedBuild: str
    safetyMarginMb: int
    modelsMax: int          # router: how many models may stay co-resident (>= 1)
    sleepIdleSeconds: int   # router: idle-unload TTL in seconds (0 = never)
    # A5 (user "do", 2026-07-06): "off" | "notify". Notify = the UI surfaces "update
    # available" and the bump is a deliberate click; NEVER auto-applied — the pin is a
    # VERIFIED pin (flag semantics move between llama.cpp builds).
    updatePolicy: str = "notify"
    binaries: list[RunnerBinaryRow]


class EngineConfigUpdate(BaseModel):
    pinnedBuild: str | None = None
    updatePolicy: str | None = None     # "off" | "notify"
    safetyMarginMb: int | None = None
    modelsMax: int | None = None
    sleepIdleSeconds: int | None = None
    binaries: list[RunnerBinaryRow] | None = None   # each upserted by (platform, gpu)


class RunnerConfigStore(Protocol):
    """Persistence boundary the host implements over runner_binary + runner_setting."""

    def get_config(self) -> EngineConfig: ...
    def upsert_binary(self, row: RunnerBinaryRow) -> None: ...      # by (platform, gpu)
    def set_setting(self, key: str, value: str) -> None: ...        # pinned_build | safety_margin_mb | models_max | sleep_idle_seconds
    def reset_to_defaults(self) -> None: ...


def make_runner_config_router(get_store: Callable[[], RunnerConfigStore]) -> APIRouter:
    router = APIRouter(tags=["ai"], prefix="/v1/ai")

    @router.get("/engine-config", response_model=EngineConfig)
    async def get_engine_config() -> EngineConfig:
        return get_store().get_config()

    @router.put("/engine-config", response_model=EngineConfig)
    async def update_engine_config(body: EngineConfigUpdate) -> EngineConfig:
        store = get_store()
        if body.pinnedBuild is not None:
            pb = body.pinnedBuild.strip()
            if not pb:
                raise HTTPException(status_code=400, detail="pinnedBuild cannot be blank")
            store.set_setting("pinned_build", pb)
        if body.updatePolicy is not None:
            up = body.updatePolicy.strip().lower()
            if up not in ("off", "notify"):
                raise HTTPException(status_code=400, detail="updatePolicy must be 'off' or 'notify'")
            store.set_setting("update_policy", up)
        if body.safetyMarginMb is not None:
            store.set_setting("safety_margin_mb", str(int(body.safetyMarginMb)))
        if body.modelsMax is not None:
            store.set_setting("models_max", str(max(1, int(body.modelsMax))))
        if body.sleepIdleSeconds is not None:
            store.set_setting("sleep_idle_seconds", str(max(0, int(body.sleepIdleSeconds))))
        for row in body.binaries or []:
            if not row.platform.strip() or not row.gpu.strip():
                raise HTTPException(status_code=400, detail="each binary needs platform + gpu")
            store.upsert_binary(row)
        return store.get_config()

    @router.post("/engine-config/reset", response_model=EngineConfig)
    async def reset_engine_config() -> EngineConfig:
        store = get_store()
        store.reset_to_defaults()
        return store.get_config()

    return router
