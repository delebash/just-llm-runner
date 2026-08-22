# SPDX-License-Identifier: MIT
"""Shared disk-usage router — a READ-ONLY size breakdown of the app's on-disk
footprint so a Settings "reclaim disk" panel can show WHERE the space went and
offer the reclaim actions. This router only MEASURES; the actual deletes are the
runner's reclaim endpoints (models-cache / spawn-logs clear) + the /v1/logs sweep.

Beside `logs_api` in the shared platform kit so every same-stack app (JustWrite,
JustVoice) mounts the identical `GET /v1/disk/usage` over its own portable data
root — the T3 "one source" law. The host calls `make_disk_router(data_dir)` at
boot (the same `data_dir` it passes the runner, whose cache lives at
`<data_dir>/ai-cache`).

The measured buckets:
- `database`     — the SQLite DB file(s) at the root + each one's -wal/-shm siblings.
- `appLogs`      — `<data_dir>/logs` (the per-day server logs; swept via /v1/logs).
- `modelsCache`  — `<cache_root>/hf` (downloaded model GGUFs).
- `engineBuilds` — `<cache_root>/llamacpp` EXCLUDING its `logs/` subdir (the
                   llama.cpp binaries; swept on engine uninstall/update).
- `spawnLogs`    — `<runtime_root>/logs` (per-spawn llama-server logs, otherwise
                   UNBOUNDED — the runner's spawn-logs/clear reclaims them).
- `total`        — the sum of the five buckets (+ any host-declared extras).
- `diskFree` / `diskTotal` — the volume's free/total bytes (`shutil.disk_usage`).
- `cacheShared`  — true when the cache lives outside this app's data root.
- `extras`       — host-declared app-specific buckets (`extra_buckets=`), e.g.
                   JV's speech-cache and render-cache roots; {} when none.

The last three buckets are read from the RUNNING SERVICE, not assumed to be under
`data_dir`: the cache may be shared with a sibling app (2026-08-03), and a panel
that measured `<data_dir>/ai-cache` regardless would report a confident 0 B for
14 GB of models. When nothing is shared these resolve to exactly the old paths.

Robustness: a missing dir counts 0 (never an error); every `stat` is guarded (a
file can vanish mid-walk); symlinks are NOT followed — the HF cache stores real
blobs under `blobs/` and symlinks them from `snapshots/`, so following them would
double-count (and could loop), while skipping them counts each blob exactly once.

That last sentence only held where HF can MAKE symlinks. On Windows it cannot
without Developer Mode or admin, so `snapshots/` gets full byte-for-byte COPIES
and every model occupies twice its size — real bytes, honestly counted. Replace
those copies with hardlinks (same bytes, two names) and the walk counts them
twice while the disk holds them once. `dedup_links=True` closes that: it counts
each inode once. It is opt-in per bucket because it costs an `os.stat` per file
(~3x the walk), which only the models cache is known to need.
"""

from __future__ import annotations

import logging
import os
import shutil
from pathlib import Path

from fastapi import APIRouter
from pydantic import BaseModel

log = logging.getLogger(__name__)


def dir_size(
    path: Path, exclude: set[Path] | None = None, dedup_links: bool = False
) -> int:
    """Total bytes of the regular files under `path`, recursively, via `os.scandir`.

    Symlinks are skipped (never followed), every `stat` is guarded, and a missing
    `path` counts 0 — so a vanishing file, a broken link, or an absent dir never
    raises. `exclude` is a set of child paths to skip whole (used to hold the
    llamacpp `logs/` subdir out of the engine-builds bucket). Shared by the sizes
    endpoint AND the runner's models-cache reclaim (one walk, one source).

    `dedup_links=True` counts each INODE once, so a file reachable under two
    names (a hardlink) adds its bytes once — what the disk actually holds. Off by
    default: it costs an `os.stat` per file, and only the HF models cache is
    known to contain hardlinks (see the module docstring)."""
    return _walk(path, exclude, set() if dedup_links else None)


def _walk(path: Path, exclude: set[Path] | None, seen: set | None) -> int:
    """`dir_size`'s recursion. `seen` is None when not deduping, else the set of
    (st_dev, st_ino) already counted — shared across the whole walk, since the two
    names for one inode are usually in different directories (`blobs/`, `snapshots/`)."""
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
                        total += _walk(child, exclude, seen)
                    elif entry.is_file(follow_symlinks=False):
                        if seen is None:
                            total += entry.stat(follow_symlinks=False).st_size
                            continue
                        # os.stat, NOT entry.stat(): on Windows a DirEntry's stat comes
                        # from the directory listing, which carries no link data —
                        # st_ino and st_nlink are both 0 there. Keying on that would
                        # collapse every file into one entry and report a near-empty
                        # cache. os.stat opens the file and returns the real values.
                        st = os.stat(entry.path)
                        if st.st_nlink > 1 and st.st_ino:
                            key = (st.st_dev, st.st_ino)
                            if key in seen:
                                continue  # same bytes under another name
                            seen.add(key)
                        total += st.st_size
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
    # True when the engine cache is somewhere other than `<data_dir>/ai-cache` — a
    # panel offering "clear the models cache" needs to say WHOSE models those are.
    cacheShared: bool = False
    # Host-declared buckets (`make_disk_router(..., extra_buckets=...)`) — app
    # stores the shared kit doesn't know about (JV's speech-cache / render
    # cache). Counted into `total`; {} for hosts that declare none.
    extras: dict[str, int] = {}


def _engine_roots(data_dir: Path) -> tuple[Path, Path]:
    """(cache_root, runtime_root) from the WIRED runner service, falling back to the
    in-data-dir layout when no host configured one (a platform-only app, the disk
    tests). Asking the service is what keeps this honest once a cache can be shared —
    the sizes must describe the files the engine actually uses.

    `configured_service()`, never `get_service()`: the latter invents a standalone
    service rooted at `~/.cache/just-llm-runner` rather than admitting there is none,
    which would have this panel confidently measure a directory the app never uses."""
    try:
        from ..runner.lifecycle import configured_service

        svc = configured_service()
        if svc is not None:
            return Path(svc.cache_root), Path(svc.runtime_root)
    except Exception:  # noqa: BLE001 — a disk panel must never fail on a wiring gap
        log.warning("could not read the engine cache roots — measuring the data dir",
                    exc_info=True)
    cache = data_dir / "ai-cache"
    return cache, cache / "llamacpp"


def make_disk_router(
    data_dir,
    extra_buckets: "dict[str, Path | str | list[Path | str]] | None" = None,
) -> APIRouter:
    """Build the shared read-only `GET /v1/disk/usage` over the app's `data_dir`
    (the portable root that also holds `ai-cache/`). Same host wiring shape as
    `make_logs_router`.

    `extra_buckets` lets a host declare app-specific stores the shared kit
    doesn't know about ({name: directory | [directories]}; JV passes its
    speech stores — the speech cache PLUS the legacy per-engine model dirs —
    and its render-cache root). A bucket with several directories is summed:
    one honest number per user-facing store, wherever its files ended up
    across layout generations. Each lands in the response's `extras` map
    under its declared name and counts into `total`. Hosts that declare none
    get `extras: {}` and byte-identical behavior to before the parameter
    existed."""
    router = APIRouter(tags=["disk"])
    root = Path(data_dir)
    extra_roots = {
        name: [Path(p) for p in (v if isinstance(v, (list, tuple)) else [v])]
        for name, v in (extra_buckets or {}).items()
    }

    @router.get("/v1/disk/usage", response_model=DiskUsageResponse)
    async def disk_usage() -> DiskUsageResponse:
        ai_cache, runtime = _engine_roots(root)
        llamacpp = ai_cache / "llamacpp"
        spawn_logs_dir = runtime / "logs"

        database = _database_bytes(root)
        app_logs = dir_size(root / "logs")
        # dedup_links: HF gives one blob two names — a symlink where it can, a
        # hardlink or a full copy where it cannot. Only the copy is really two
        # files; count the shared inode once so the panel reports the disk.
        models_cache = dir_size(ai_cache / "hf", dedup_links=True)
        # Everything under llamacpp/ (build dirs + the generated models.ini) EXCEPT
        # the per-spawn logs/, which is its own bucket below.
        engine_builds = dir_size(llamacpp, exclude={spawn_logs_dir})
        spawn_logs = dir_size(spawn_logs_dir)
        extras = {name: sum(dir_size(p) for p in paths)
                  for name, paths in extra_roots.items()}
        total = database + app_logs + models_cache + engine_builds + spawn_logs \
            + sum(extras.values())

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
            cacheShared=(ai_cache != root / "ai-cache"),
            extras=extras,
        )

    return router
