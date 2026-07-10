# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared disk-usage router — a READ-ONLY size breakdown of the app's on-disk
footprint so a Settings "reclaim disk" panel can show WHERE the space went and
offer the reclaim actions. This router only MEASURES; the actual deletes are the
runner's reclaim endpoints (models-cache / spawn-logs clear) + the /v1/logs sweep.

Beside `logs_api` in the shared platform kit so every same-stack app (JustWrite,
JustVoice) mounts the identical `GET /v1/disk/usage` over its own portable data
root — the T3 "one source" law. The host calls `make_disk_router(data_dir)` at
boot (the same `data_dir` it passes the runner, whose cache lives at
`<data_dir>/ai-cache`).

The measured buckets (all under the data root):
- `database`     — the SQLite DB file(s) at the root + each one's -wal/-shm siblings.
- `appLogs`      — `<data_dir>/logs` (the per-day server logs; swept via /v1/logs).
- `modelsCache`  — `<data_dir>/ai-cache/hf` (downloaded model GGUFs).
- `engineBuilds` — `<data_dir>/ai-cache/llamacpp` EXCLUDING its `logs/` subdir (the
                   llama.cpp binaries; swept on engine uninstall/update).
- `spawnLogs`    — `<data_dir>/ai-cache/llamacpp/logs` (per-spawn llama-server logs,
                   otherwise UNBOUNDED — the runner's spawn-logs/clear reclaims them).
- `total`        — the sum of the five buckets.
- `diskFree` / `diskTotal` — the volume's free/total bytes (`shutil.disk_usage`).

Robustness: a missing dir counts 0 (never an error); every `stat` is guarded (a
file can vanish mid-walk); symlinks are NOT followed — the HF cache stores real
blobs under `blobs/` and symlinks them from `snapshots/`, so following them would
double-count (and could loop), while skipping them counts each blob exactly once.
"""

from __future__ import annotations

import logging
import os
import shutil
from pathlib import Path

from fastapi import APIRouter
from pydantic import BaseModel

log = logging.getLogger(__name__)


def dir_size(path: Path, exclude: set[Path] | None = None) -> int:
    """Total bytes of the regular files under `path`, recursively, via `os.scandir`.

    Symlinks are skipped (never followed), every `stat` is guarded, and a missing
    `path` counts 0 — so a vanishing file, a broken link, or an absent dir never
    raises. `exclude` is a set of child paths to skip whole (used to hold the
    llamacpp `logs/` subdir out of the engine-builds bucket). Shared by the sizes
    endpoint AND the runner's models-cache reclaim (one walk, one source)."""
    total = 0
    try:
        with os.scandir(path) as it:
            for entry in it:
                try:
                    if entry.is_symlink():
                        continue  # never follow (HF blobs are symlinked from snapshots/)
                    child = Path(entry.path)
                    if exclude and child in exclude:
                        continue
                    if entry.is_dir(follow_symlinks=False):
                        total += dir_size(child, exclude)
                    elif entry.is_file(follow_symlinks=False):
                        total += entry.stat(follow_symlinks=False).st_size
                except OSError:
                    continue  # the file vanished mid-walk / perms → skip it
    except (OSError, ValueError):
        return total  # missing path / not a dir → 0
    return total


def _database_bytes(data_dir: Path) -> int:
    """The SQLite DB file(s) at the data root plus each one's `-wal`/`-shm` sidecars
    (present while a connection is open / mid-checkpoint)."""
    total = 0
    try:
        dbs = list(data_dir.glob("*.db"))
    except OSError:
        return 0
    for db in dbs:
        for p in (db, Path(f"{db}-wal"), Path(f"{db}-shm")):
            try:
                if p.is_file():
                    total += p.stat().st_size
            except OSError:
                continue
    return total


class DiskUsageResponse(BaseModel):
    database: int = 0
    appLogs: int = 0
    modelsCache: int = 0
    engineBuilds: int = 0
    spawnLogs: int = 0
    total: int = 0
    diskFree: int = 0
    diskTotal: int = 0


def make_disk_router(data_dir) -> APIRouter:
    """Build the shared read-only `GET /v1/disk/usage` over the app's `data_dir`
    (the portable root that also holds `ai-cache/`). Same host wiring shape as
    `make_logs_router`."""
    router = APIRouter(tags=["disk"])
    root = Path(data_dir)

    @router.get("/v1/disk/usage", response_model=DiskUsageResponse)
    async def disk_usage() -> DiskUsageResponse:
        ai_cache = root / "ai-cache"
        llamacpp = ai_cache / "llamacpp"
        spawn_logs_dir = llamacpp / "logs"

        database = _database_bytes(root)
        app_logs = dir_size(root / "logs")
        models_cache = dir_size(ai_cache / "hf")
        # Everything under llamacpp/ (build dirs + the generated models.ini) EXCEPT
        # the per-spawn logs/, which is its own bucket below.
        engine_builds = dir_size(llamacpp, exclude={spawn_logs_dir})
        spawn_logs = dir_size(spawn_logs_dir)
        total = database + app_logs + models_cache + engine_builds + spawn_logs

        free = disk_total = 0
        try:
            usage = shutil.disk_usage(root)
            free, disk_total = usage.free, usage.total
        except OSError:
            log.warning("disk_usage(%s) failed — free/total reported 0", root, exc_info=True)

        return DiskUsageResponse(
            database=database, appLogs=app_logs, modelsCache=models_cache,
            engineBuilds=engine_builds, spawnLogs=spawn_logs, total=total,
            diskFree=free, diskTotal=disk_total,
        )

    return router
