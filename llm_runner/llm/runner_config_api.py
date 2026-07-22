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

from ..runner.config import (
    MAX_DOWNLOAD_CONCURRENT,
    MAX_DOWNLOAD_SEGMENT_COUNT,
    MAX_DOWNLOAD_SEGMENT_RETRIES,
)


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
    # Segmented downloads (DL-2): N parallel byte-ranges per file; files under
    # the min-bytes floor (and everything, when disabled) stay single-stream.
    downloadSegmentsEnabled: bool = True
    downloadSegmentCount: int = 8   # keep in step with config.DEFAULT_DOWNLOAD_SEGMENT_COUNT
    downloadSegmentMinBytes: int = 64 * 1024 * 1024   # RETIRED/inert (the downloader falls back itself); kept for back-compat
    downloadSegmentRetries: int = 3
    downloadMaxConcurrent: int = 4   # CONCURRENT model downloads (2026-07-20)
    # A5 (user "do", 2026-07-06): "off" | "notify". Notify = the UI surfaces "update
    # available" and the bump is a deliberate click; NEVER auto-applied — the pin is a
    # VERIFIED pin (flag semantics move between llama.cpp builds).
    updatePolicy: str = "notify"
    # Task E (user, 2026-07-06/07): the last "gpu-name|vramMb" fingerprint the UI
    # acknowledged — the hardware-change toast fires ONCE per real gpu/vram change
    # ("counts as changed just gpu vram" · "appears dismissinle toast"). "" = never
    # seen; the UI seeds it silently on first sight (a fresh install is not a change).
    ackHwFingerprint: str = ""
    # Acceleration-backend override (2026-07-14): the GPU FAMILY the user pinned as the
    # active engine backend ("cuda" | "vulkan" | "rocm" | "metal"; "" = Auto / hardware
    # order). The runner moves it to the front of its build-preference order.
    preferredGpu: str = ""
    # Hardware-class override (§9, 2026-07-22): the class key the box FILES UNDER for
    # the class-tunes layer + recommendation ("" = auto-detect). "Detection proposes,
    # never dictates" — a wrong sensor costs one setting, not a dead subsystem. Free
    # text, same as the class-tunes library's keys (the user authors classes they
    # don't own hardware for).
    classKeyOverride: str = ""
    # Warm the default local chat model into VRAM on app startup (2026-07-21). The
    # CLIENT gates the actual warm on "built-in is the routing default + model
    # downloaded"; this flag is the user's on/off master. API-surface-only (read
    # from the setting row), like updatePolicy/preferredGpu.
    warmDefaultOnStartup: bool = True
    binaries: list[RunnerBinaryRow]


class EngineConfigUpdate(BaseModel):
    pinnedBuild: str | None = None
    updatePolicy: str | None = None     # "off" | "notify"
    ackHwFingerprint: str | None = None  # the acknowledged gpu|vram fingerprint (Task E)
    preferredGpu: str | None = None      # backend override family ("" = Auto; cuda|vulkan|rocm|metal)
    classKeyOverride: str | None = None  # hardware-class override ("" = auto-detect; free text)
    safetyMarginMb: int | None = None
    modelsMax: int | None = None
    sleepIdleSeconds: int | None = None
    downloadSegmentsEnabled: bool | None = None
    downloadSegmentCount: int | None = None
    downloadSegmentMinBytes: int | None = None
    downloadSegmentRetries: int | None = None
    downloadMaxConcurrent: int | None = None
    warmDefaultOnStartup: bool | None = None   # warm the default local chat model into VRAM on startup
    binaries: list[RunnerBinaryRow] | None = None   # each upserted by (platform, gpu)


class RunnerConfigStore(Protocol):
    """Persistence boundary the host implements over runner_binary + runner_setting."""

    def get_config(self) -> EngineConfig: ...
    def upsert_binary(self, row: RunnerBinaryRow) -> None: ...      # by (platform, gpu)
    def set_setting(self, key: str, value: str) -> None: ...        # pinned_build | safety_margin_mb | models_max | sleep_idle_seconds | preferred_gpu | class_key_override | download_segment* | warm_default_on_startup
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
        if body.ackHwFingerprint is not None:
            store.set_setting("ack_hw_fingerprint", body.ackHwFingerprint.strip())
        if body.preferredGpu is not None:
            pg = body.preferredGpu.strip().lower()
            if pg not in ("", "cuda", "vulkan", "rocm", "metal"):
                raise HTTPException(status_code=400, detail="preferredGpu must be blank (Auto) or one of: cuda, vulkan, rocm, metal")
            store.set_setting("preferred_gpu", pg)
        if body.classKeyOverride is not None:
            # Free text, trimmed — the class-tunes library accepts free-typed keys
            # (class_tunes_api PUT), so the override does too; "" = auto-detect.
            store.set_setting("class_key_override", body.classKeyOverride.strip())
        if body.safetyMarginMb is not None:
            store.set_setting("safety_margin_mb", str(int(body.safetyMarginMb)))
        if body.modelsMax is not None:
            store.set_setting("models_max", str(max(1, int(body.modelsMax))))
        if body.sleepIdleSeconds is not None:
            store.set_setting("sleep_idle_seconds", str(max(0, int(body.sleepIdleSeconds))))
        if body.downloadSegmentsEnabled is not None:
            store.set_setting("download_segments_enabled", "1" if body.downloadSegmentsEnabled else "0")
        if body.downloadSegmentCount is not None:
            # #10 (2026-07-17): clamp to [1, MAX] — a bare "20" spawned 20 parallel Range
            # requests; >~8 only loads the CDN, no speed. saveKnobs re-reads the returned
            # config, so the field snaps back to the clamped value the user sees.
            store.set_setting("download_segment_count", str(max(1, min(MAX_DOWNLOAD_SEGMENT_COUNT, int(body.downloadSegmentCount)))))
        if body.downloadSegmentMinBytes is not None:
            # RETIRED/inert (the downloader falls back to single-stream itself) — still
            # accepted + persisted so an existing UI/DB round-trips without a 422; nothing reads it.
            store.set_setting("download_segment_min_bytes", str(max(0, int(body.downloadSegmentMinBytes))))
        if body.downloadSegmentRetries is not None:
            store.set_setting("download_segment_retries", str(max(0, min(MAX_DOWNLOAD_SEGMENT_RETRIES, int(body.downloadSegmentRetries)))))
        if body.downloadMaxConcurrent is not None:
            # Clamp to [1, MAX] — same ONE-source belt as the segment knobs; the lifecycle gate
            # re-clamps on read too, so a raw DB poke can't spawn more than MAX parallel downloads.
            store.set_setting("download_max_concurrent", str(max(1, min(MAX_DOWNLOAD_CONCURRENT, int(body.downloadMaxConcurrent)))))
        if body.warmDefaultOnStartup is not None:
            store.set_setting("warm_default_on_startup", "1" if body.warmDefaultOnStartup else "0")
        for row in body.binaries or []:
            if not row.platform.strip() or not row.gpu.strip():
                raise HTTPException(status_code=400, detail="each binary needs platform + gpu")
            # The URL must be CONCRETE — a `{…}` placeholder never composes to a real asset and
            # would 404 at install time (the pin drives the URL; the UI re-points it on a pin
            # change). Reject it at the save boundary so a bad row can't reach the DB.
            for label, val in (("assetUrl", row.assetUrl), ("runtimeUrl", row.runtimeUrl)):
                if val and ("{" in val or "}" in val):
                    raise HTTPException(
                        status_code=400,
                        detail=f"{row.platform}/{row.gpu} {label} still has a placeholder: {val}",
                    )
            store.upsert_binary(row)
        return store.get_config()

    @router.post("/engine-config/reset", response_model=EngineConfig)
    async def reset_engine_config() -> EngineConfig:
        store = get_store()
        store.reset_to_defaults()
        return store.get_config()

    return router
