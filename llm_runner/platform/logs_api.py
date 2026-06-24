# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared server-logs router — an in-memory ring (the UI tail) plus an optional
rotating file (survives a crash/boot-hang, when on-disk logs matter most).

Lifted from JustVoice's `api/admin_api.py` log handlers into the shared backend
kit so every same-stack app gets the same Logs viewer. The host calls
`install_log_ring()` + `install_file_log(path)` at boot and mounts
`make_logs_router(app_name)`.

Endpoints (mounted at the app root):
- `GET /v1/logs/tail?lines=N` → the last N ring lines (`{text, lines}`).
- `GET /v1/logs/download`     → the whole ring as a text attachment.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from logging.handlers import RotatingFileHandler
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

log = logging.getLogger(__name__)

_FMT = logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s")


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
_file_handler: logging.Handler | None = None


def install_log_ring() -> None:
    """Attach the ring to the root logger (idempotent). Call from create_app()."""
    root = logging.getLogger()
    if _ring not in root.handlers:
        root.addHandler(_ring)


def install_file_log(log_path: Path) -> Path | None:
    """Rotating file handler at `log_path` (idempotent per path; re-points if a
    different path is given, e.g. tests with several apps per process). Returns
    the path, or None when the dir isn't writable (never fatal — the ring still
    works)."""
    global _file_handler
    log_path = Path(log_path)
    root = logging.getLogger()
    if _file_handler is not None:
        if getattr(_file_handler, "baseFilename", None) == str(log_path):
            return log_path
        root.removeHandler(_file_handler)
        _file_handler.close()
        _file_handler = None
    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        handler = RotatingFileHandler(log_path, maxBytes=2_000_000, backupCount=3, encoding="utf-8")
    except OSError:
        log.warning("file log unavailable at %s — ring only", log_path)
        return None
    handler.setFormatter(_FMT)
    root.addHandler(handler)
    _file_handler = handler
    return log_path


class LogTailResponse(BaseModel):
    text: str
    lines: int


def make_logs_router(app_name: str = "app") -> APIRouter:
    """Build the shared /v1/logs router over the in-memory ring."""
    router = APIRouter(tags=["logs"])
    slug = app_name.lower().replace(" ", "-") or "app"

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

    return router
