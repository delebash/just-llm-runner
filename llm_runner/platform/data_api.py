# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared data-management router — backup / restore / reset over a host's
SQLite database + asset directories.

Same machinery for every same-stack app (Vue + Tauri + Python + SQLite); only
the host hooks differ — the DB path, the SQLAlchemy metadata (table list), a
reset callback, and any extra asset dirs to bundle. The mechanism is
schema-agnostic, so a new app gets backup/restore/reset for free.

Endpoints (mounted under `prefix`, default `/v1/data`):
- `GET  /backup`  → a ZIP: a clean DB copy (SQLite `VACUUM INTO`, WAL-safe) plus
  each declared asset dir.
- `POST /restore` → replace data from an uploaded backup ZIP by **table-copy**
  (no live-file swap → no cross-platform file-lock issue): for every known
  table, the live rows are deleted and re-inserted from the backup DB
  (column-aware, so an older/newer backup with a drifted column still loads).
  Declared asset dirs are replaced too.
- `POST /reset`   → first-run state via the host's reset callback (delete all
  rows + reseed).
"""

from __future__ import annotations

import io
import shutil
import sqlite3
import tempfile
import zipfile
from pathlib import Path
from typing import Callable

from fastapi import APIRouter, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy import MetaData

_DB_ARCNAME = "db.sqlite"


def make_data_router(
    *,
    get_db_path: Callable[[], Path],
    metadata: "MetaData | list[MetaData] | tuple[MetaData, ...]",
    run_reset: Callable[[], None],
    asset_dirs: Callable[[], dict[str, Path]] | None = None,
    prefix: str = "/v1/data",
    on_replaced: Callable[[], None] | None = None,
) -> APIRouter:
    """Build the shared data backup/restore/reset router over host hooks.

    - `get_db_path()` → the live SQLite file path.
    - `metadata` → the app's SQLAlchemy `MetaData`, OR a list of them when the app
      has more than one base on the same DB (e.g. the domain base + the shared
      `LlmBase`). Tables across all metadatas are covered (no cross-base FKs).
    - `run_reset()` → wipe to first-run state (delete all rows + reseed). The host
      owns it (it knows its session + seed); kept a callback so reset and the
      app's own seeding stay one implementation.
    - `asset_dirs()` → `{arcname: dir}` extra directories to include in a backup
      and replace on restore (e.g. JustWrite `images/`, JustVoice `audio/`).
    - `on_replaced()` → called after a successful RESTORE replaced the data under a
      live app (2026-07-11): the host tears down anything derived from the old data
      (e.g. the LLM runner's resident models + VRAM ledger). Reset covers itself
      inside `run_reset`; restore has no host callback without this.
    """
    router = APIRouter(tags=["data"], prefix=prefix)
    _assets = asset_dirs or (lambda: {})
    _metadatas = list(metadata) if isinstance(metadata, (list, tuple)) else [metadata]

    def _ordered_tables() -> list:
        """Every table across all metadatas, FK-ordered within each (parents first)."""
        tables: list = []
        for m in _metadatas:
            tables.extend(m.sorted_tables)
        return tables

    def _add_dir(zf: zipfile.ZipFile, arcname: str, d: Path) -> None:
        if not d.is_dir():
            return
        for f in d.rglob("*"):
            if f.is_file():
                zf.write(f, f"{arcname}/{f.relative_to(d).as_posix()}")

    @router.get("/backup")
    async def backup() -> StreamingResponse:
        db_path = Path(get_db_path())
        if not db_path.exists():
            raise HTTPException(status_code=404, detail="no database to back up")
        with tempfile.TemporaryDirectory() as tmp:
            clean = Path(tmp) / _DB_ARCNAME
            con = sqlite3.connect(str(db_path))
            con.execute("PRAGMA busy_timeout=5000")
            try:
                # WAL-safe consistent copy without locking the live DB out.
                con.execute("VACUUM INTO ?", (str(clean),))
            finally:
                con.close()
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
                zf.write(clean, _DB_ARCNAME)
                for arcname, d in _assets().items():
                    _add_dir(zf, arcname, Path(d))
            payload = buf.getvalue()
        return StreamingResponse(
            io.BytesIO(payload),
            media_type="application/zip",
            headers={"Content-Disposition": 'attachment; filename="backup.zip"'},
        )

    @router.post("/restore")
    async def restore(file: UploadFile) -> dict:
        raw = await file.read()
        try:
            zf = zipfile.ZipFile(io.BytesIO(raw))
        except zipfile.BadZipFile as e:
            raise HTTPException(status_code=400, detail="not a valid backup zip") from e
        if _DB_ARCNAME not in zf.namelist():
            raise HTTPException(status_code=400, detail=f"backup is missing {_DB_ARCNAME}")
        with tempfile.TemporaryDirectory() as tmp:
            zf.extractall(tmp)
            src_db = Path(tmp) / _DB_ARCNAME
            db_path = Path(get_db_path())
            con = sqlite3.connect(str(db_path))
            con.execute("PRAGMA busy_timeout=5000")
            try:
                con.execute("PRAGMA foreign_keys=OFF")
                con.execute("ATTACH ? AS src", (str(src_db),))
                tables = [t.name for t in _ordered_tables()]
                src_tables = {
                    r[0] for r in con.execute(
                        "SELECT name FROM src.sqlite_master WHERE type='table'"
                    )
                }
                # Clear children → parents, refill parents → children.
                for t in reversed(tables):
                    con.execute(f'DELETE FROM main."{t}"')
                for t in tables:
                    if t not in src_tables:
                        continue
                    main_cols = [r[1] for r in con.execute(f'PRAGMA table_info("{t}")')]
                    src_cols = {r[1] for r in con.execute(f'PRAGMA src.table_info("{t}")')}
                    cols = [c for c in main_cols if c in src_cols]
                    if not cols:
                        continue
                    col_sql = ", ".join(f'"{c}"' for c in cols)
                    con.execute(
                        f'INSERT INTO main."{t}" ({col_sql}) SELECT {col_sql} FROM src."{t}"'
                    )
                con.commit()
                con.execute("DETACH src")
            except Exception as e:  # noqa: BLE001 — surface restore failures as data
                con.rollback()
                raise HTTPException(status_code=400, detail=f"restore failed: {str(e)[:300]}") from e
            finally:
                con.close()
            # Replace each declared asset dir with the backup's copy.
            for arcname, d in _assets().items():
                d = Path(d)
                bdir = Path(tmp) / arcname
                if bdir.is_dir():
                    if d.exists():
                        shutil.rmtree(d)
                    shutil.copytree(bdir, d)
        if on_replaced is not None:
            on_replaced()
        return {"ok": True}

    @router.post("/reset")
    async def reset() -> dict:
        run_reset()
        return {"ok": True}

    return router
