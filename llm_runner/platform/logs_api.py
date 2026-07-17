# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared server-logs router — an in-memory ring (the UI tail) plus PER-DAY log
files (survive a crash/boot-hang, when on-disk logs matter most).

Lifted from JustVoice's `api/admin_api.py` log handlers into the shared backend
kit so every same-stack app gets the same Logs viewer. The host calls
`install_log_ring()` + `install_file_log(path)` at boot and mounts
`make_logs_router(app_name)`.

Storage (the Logs phase, 2026-07-05 — the user's "should store day"): ONE file
per local day via stdlib `TimedRotatingFileHandler(when="midnight")` — the live
day is the base file (e.g. `justwrite.log`), past days are dated siblings
(`justwrite.log.2026-07-04`), `backup_days` retained (default 30).

Endpoints (mounted at the app root):
- `GET    /v1/logs/tail?lines=N`   → the last N ring lines (`{text, lines}`).
- `GET    /v1/logs/download`       → the whole ring as a text attachment.
- `GET    /v1/logs/days`           → the stored days (`[{day, sizeKb, live}]`, newest first).
- `GET    /v1/logs/day?date=&lines=N` → one day's FILE content (tail-capped).
- `POST   /v1/logs/clear`          → empty the RING (the on-screen tail).
- `DELETE /v1/logs/day?date=`      → delete a stored day (TODAY = truncate, see below).
- `DELETE /v1/logs/all`            → delete every stored day + truncate live + clear the ring.

Windows-safety (the primary desktop target): the LIVE file is held open by the
handler, and Windows refuses to unlink an open file — so "delete today" and
"delete all" TRUNCATE the live file under the handler lock (close → truncate →
reopen, `_truncate_live`), and only PAST days are plain unlinks.
"""

from __future__ import annotations

import logging
import re
from datetime import date, datetime, timezone
from logging.handlers import TimedRotatingFileHandler
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

log = logging.getLogger(__name__)

_FMT = logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s")
_DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class _RingHandler(logging.Handler):
    """Bounded in-memory ring on the root logger — the UI's log tail."""

    def __init__(self, capacity: int = 500):
        super().__init__()
        self.capacity = capacity
        self.lines: list[str] = []
        self.setFormatter(_FMT)

    def emit(self, record: logging.LogRecord) -> None:
        try:
            self.lines.append(self.format(record))
            if len(self.lines) > self.capacity:
                del self.lines[: len(self.lines) - self.capacity]
        except Exception:  # noqa: BLE001 — logging must never raise
            pass


_ring = _RingHandler()
_file_handler: TimedRotatingFileHandler | None = None


def install_log_ring() -> None:
    """Attach the ring to the root logger (idempotent). Call from create_app()."""
    root = logging.getLogger()
    if _ring not in root.handlers:
        root.addHandler(_ring)


def install_file_log(log_path: Path, backup_days: int = 30) -> Path | None:
    """PER-DAY file logging at `log_path` (idempotent per path; re-points if a
    different path is given, e.g. tests with several apps per process). The live
    day writes the base file; at local midnight it rotates to `<name>.YYYY-MM-DD`
    and `backup_days` days are retained. Returns the path, or None when the dir
    isn't writable (never fatal — the ring still works)."""
    global _file_handler
    log_path = Path(log_path)
    root = logging.getLogger()
    # The runner's operational telemetry (load/stop asks + their trigger, spawns,
    # evictions, install events) logs at INFO — but the root logger's default level is
    # WARNING and NOTHING in the chain ever raised it, so the on-disk log carried zero
    # INFO lines (2026-07-17: an unload-respawn hunt was undiagnosable for exactly this
    # reason). Raise the llm_runner PACKAGE only — root stays WARNING so third-party
    # INFO noise stays out of the user's log. Volume is safe: the package's INFO sites
    # are one-shot lifecycle events, nothing per-token/per-chunk.
    logging.getLogger("llm_runner").setLevel(logging.INFO)
    if _file_handler is not None:
        if getattr(_file_handler, "baseFilename", None) == str(log_path):
            return log_path
        root.removeHandler(_file_handler)
        _file_handler.close()
        _file_handler = None
    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        handler = TimedRotatingFileHandler(
            log_path, when="midnight", backupCount=backup_days, encoding="utf-8"
        )
    except OSError:
        log.warning("file log unavailable at %s — ring only", log_path)
        return None
    handler.setFormatter(_FMT)
    root.addHandler(handler)
    _file_handler = handler
    return log_path


def _day_files(dir_path: Path, base_name: str) -> list[dict]:
    """PURE listing of a log dir's per-day files → [{day, sizeKb, live, path}],
    newest first. The base file IS the live day (today); past days are the
    `<base>.YYYY-MM-DD` siblings TimedRotatingFileHandler leaves behind."""
    out: list[dict] = []
    live = dir_path / base_name
    if live.exists():
        out.append({"day": date.today().isoformat(), "sizeKb": max(1, live.stat().st_size // 1024) if live.stat().st_size else 0,
                    "live": True, "path": live})
    prefix = base_name + "."
    for p in dir_path.iterdir() if dir_path.is_dir() else []:
        if not p.name.startswith(prefix):
            continue
        day = p.name[len(prefix):]
        if _DAY_RE.match(day):
            out.append({"day": day, "sizeKb": max(1, p.stat().st_size // 1024) if p.stat().st_size else 0,
                        "live": False, "path": p})
    out.sort(key=lambda r: (r["day"], r["live"]), reverse=True)
    return out


def _live_paths() -> tuple[Path, str] | None:
    """(dir, base_name) of the installed file log, or None when ring-only."""
    if _file_handler is None:
        return None
    base = Path(_file_handler.baseFilename)
    return base.parent, base.name


def _truncate_live() -> None:
    """Empty the LIVE day's file WITHOUT unlinking it — Windows holds the open
    handle, so delete-today/delete-all must close → truncate → reopen under the
    handler lock instead of unlinking (an unlink of an open file fails there)."""
    h = _file_handler
    if h is None:
        return
    h.acquire()
    try:
        if h.stream:
            h.stream.close()
            h.stream = None  # type: ignore[assignment]
        Path(h.baseFilename).write_text("", encoding="utf-8")
        h.stream = h._open()
    finally:
        h.release()


class LogTailResponse(BaseModel):
    text: str
    lines: int


class LogDayRow(BaseModel):
    day: str          # YYYY-MM-DD
    sizeKb: int = 0
    live: bool = False  # the base file (today) — deletable only by truncation


class LogDaysResponse(BaseModel):
    days: list[LogDayRow]


def make_logs_router(app_name: str = "app") -> APIRouter:
    """Build the shared /v1/logs router over the ring + the per-day files."""
    router = APIRouter(tags=["logs"])
    slug = app_name.lower().replace(" ", "-") or "app"

    def _days_response() -> LogDaysResponse:
        lp = _live_paths()
        rows = _day_files(lp[0], lp[1]) if lp else []
        return LogDaysResponse(days=[LogDayRow(day=r["day"], sizeKb=r["sizeKb"], live=r["live"]) for r in rows])

    def _day_path(day: str) -> tuple[dict | None, list[dict]]:
        lp = _live_paths()
        rows = _day_files(lp[0], lp[1]) if lp else []
        return next((r for r in rows if r["day"] == day), None), rows

    @router.get("/v1/logs/tail", response_model=LogTailResponse)
    async def logs_tail(lines: int = 80) -> LogTailResponse:
        lines = max(1, min(lines, _ring.capacity))
        tail = _ring.lines[-lines:]
        return LogTailResponse(text="\n".join(tail), lines=len(tail))

    @router.get("/v1/logs/download")
    async def logs_download() -> PlainTextResponse:
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        return PlainTextResponse(
            "\n".join(_ring.lines),
            headers={"Content-Disposition": f'attachment; filename="{slug}-logs-{stamp}.txt"'},
        )

    @router.get("/v1/logs/days", response_model=LogDaysResponse)
    async def logs_days() -> LogDaysResponse:
        return _days_response()

    @router.get("/v1/logs/day", response_model=LogTailResponse)
    async def logs_day(date: str, lines: int = 2000) -> LogTailResponse:  # noqa: A002 — wire name
        if not _DAY_RE.match(date or ""):
            raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD")
        row, _rows = _day_path(date)
        if row is None:
            raise HTTPException(status_code=404, detail=f"no log stored for {date}")
        # Tail-capped read: a day file can be large; the reader wants the recent end.
        content = Path(row["path"]).read_text(encoding="utf-8", errors="replace").splitlines()
        lines = max(1, min(lines, 20_000))
        tail = content[-lines:]
        return LogTailResponse(text="\n".join(tail), lines=len(tail))

    @router.post("/v1/logs/clear", response_model=LogTailResponse)
    async def logs_clear() -> LogTailResponse:
        """Empty the on-screen tail (the RING). Stored day files are untouched —
        deleting those is the /day and /all DELETEs."""
        _ring.lines.clear()
        return LogTailResponse(text="", lines=0)

    @router.delete("/v1/logs/day", response_model=LogDaysResponse)
    async def logs_delete_day(date: str) -> LogDaysResponse:  # noqa: A002 — wire name
        if not _DAY_RE.match(date or ""):
            raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD")
        row, _rows = _day_path(date)
        if row is not None:
            if row["live"]:
                _truncate_live()  # today is held open — truncate, never unlink (Windows)
            else:
                Path(row["path"]).unlink(missing_ok=True)
        return _days_response()

    @router.delete("/v1/logs/all", response_model=LogDaysResponse)
    async def logs_delete_all() -> LogDaysResponse:
        lp = _live_paths()
        if lp:
            for r in _day_files(lp[0], lp[1]):
                if r["live"]:
                    _truncate_live()
                else:
                    Path(r["path"]).unlink(missing_ok=True)
        _ring.lines.clear()
        return _days_response()

    return router
