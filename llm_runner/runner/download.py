# SPDX-License-Identifier: GPL-3.0-or-later
"""Self-contained streaming download (binaries + GGUF) with progress + cancel.

Kept dependency-light (requests only) so the package has no coupling to
either app's internals — it must run standalone in JustWrite's sidecar.

Segmented mode (DL-2, plan 2026-07-08): ONE file split into N byte ranges
downloaded in parallel — one slow CDN edge stops capping the whole download
(hf_transfer-class behavior; the HF CDN honors Range, probed live in the
plan). Segments write into the SAME preallocated file at their offsets — no
part-files to join, no double disk usage. The single-stream path is
untouched underneath and remains the fallback whenever the server or the
file doesn't qualify, so turning segments off IS the rollback.
"""

from __future__ import annotations

import hashlib
import logging
import sys
import threading
from pathlib import Path
from typing import Callable

import requests

log = logging.getLogger(__name__)


class DownloadCancelled(Exception):
    """Raised when cancel_check() returns True mid-stream."""


def _preallocate(dest: Path, total: int) -> None:
    """Size `dest` to `total` bytes for the parallel segment writers WITHOUT zero-filling.
    POSIX `ftruncate` is already sparse/instant. On Windows, Python's `truncate()` zero-FILLS
    (via `_chsize_s`) — physically writing the whole file BEFORE the first byte downloads
    (measured ~8-20 s for 6 GB, so ~20-50 s for a 15 GB model, shown as a stalled 'model
    weights' at 0 %). So there mark the file sparse (FSCTL_SET_SPARSE) and set its length with
    SetEndOfFile (metadata only); segment writes then land in sparse regions cheaply. Falls
    back to `truncate` on any failure — a correct file always beats a fast one."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    if sys.platform == "win32":
        try:
            import ctypes
            import msvcrt
            from ctypes import wintypes

            k32 = ctypes.windll.kernel32
            k32.SetFilePointerEx.argtypes = [wintypes.HANDLE, ctypes.c_longlong,
                                             ctypes.c_void_p, wintypes.DWORD]
            k32.SetFilePointerEx.restype = wintypes.BOOL
            k32.SetEndOfFile.argtypes = [wintypes.HANDLE]
            k32.SetEndOfFile.restype = wintypes.BOOL
            with dest.open("wb") as f:
                h = wintypes.HANDLE(msvcrt.get_osfhandle(f.fileno()))
                # FSCTL_SET_SPARSE (0x000900C4) — a following SetEndOfFile then costs no
                # zero-fill; the byte ranges the workers never touch stay unallocated.
                k32.DeviceIoControl(h, wintypes.DWORD(0x000900C4), None, 0, None, 0,
                                    ctypes.byref(wintypes.DWORD(0)), None)
                if not (k32.SetFilePointerEx(h, total, None, 0)  # 0 = FILE_BEGIN
                        and k32.SetEndOfFile(h)):
                    raise OSError("SetEndOfFile failed")
            return
        except Exception:  # noqa: BLE001 — fall back to a correct (if slower) truncate
            log.warning("sparse preallocation failed for %s; using truncate", dest, exc_info=True)
    with dest.open("wb") as f:
        f.truncate(total)


def download_kwargs(config) -> dict:
    """The stream_download segment kwargs for a RunnerConfig — ONE place that
    collapses `enabled` into the segment count (off → 1 → the single-stream
    path), so both consumers (engine binaries + model GGUFs) stay in step."""
    enabled = bool(getattr(config, "download_segments_enabled", True))
    count = int(getattr(config, "download_segment_count", 4) or 1)
    return {
        "segments": count if enabled else 1,
        "segment_min_bytes": int(getattr(config, "download_segment_min_bytes", 64 * 1024 * 1024)),
        "segment_retries": int(getattr(config, "download_segment_retries", 3)),
    }


def _segment_bounds(total: int, segments: int) -> list[tuple[int, int]]:
    """Equal N-way split of `total` bytes as inclusive (start, end) ranges —
    exact cover, no overlap, last byte included. Fewer segments than asked
    when the file is smaller than the segment count."""
    n = max(1, min(int(segments), max(1, total)))
    base, rem = divmod(total, n)
    bounds: list[tuple[int, int]] = []
    start = 0
    for i in range(n):
        length = base + (1 if i < rem else 0)
        bounds.append((start, start + length - 1))
        start += length
    return bounds


def _probe_range_support(url: str) -> tuple[bool, int | None]:
    """(server honors byte ranges, Content-Length) via a HEAD. Any failure or
    a missing/ambiguous answer reads as unsupported — the caller falls back to
    the single-stream path (the plan's fall-back-safely rule)."""
    try:
        r = requests.head(url, allow_redirects=True, timeout=60)
        r.raise_for_status()
        accept = (r.headers.get("Accept-Ranges") or "").lower()
        total = int(r.headers["Content-Length"])
        return accept == "bytes" and total > 0, total
    except Exception:  # noqa: BLE001 — any probe failure = single-stream, never an error
        return False, None


def stream_download(
    url: str,
    dest: Path,
    on_progress: Callable[[int, int | None], None] | None = None,
    cancel_check: Callable[[], bool] | None = None,
    chunk_size: int = 1024 * 64,
    *,
    segments: int = 1,
    segment_min_bytes: int = 64 * 1024 * 1024,
    segment_retries: int = 3,
) -> str:
    """Stream `url` into `dest`, returning the sha256 hex digest.

    `on_progress(downloaded, total)` receives cumulative bytes written and the
    total from the `Content-Length` header (`None` if the server omits it, e.g.
    a chunked response). Polls `cancel_check` every chunk (cancel within
    ~64 KB); throttles `on_progress` to ~once per MB. The partial file is left
    on disk for the caller to clean up on cancel.

    With `segments` > 1 the file is fetched as parallel byte ranges when the
    server honors `Range` AND reports a Content-Length AND the file is at
    least `segment_min_bytes` — otherwise the single-stream path below runs
    unchanged. Each segment retries ITS range up to `segment_retries` times,
    resuming from the bytes it already wrote; the sha256 is computed in one
    sequential pass after assembly (same return contract either way).
    """
    if segments > 1:
        supported, total = _probe_range_support(url)
        if supported and total is not None and total >= segment_min_bytes:
            return _segmented_download(
                url, dest, total,
                on_progress=on_progress, cancel_check=cancel_check,
                chunk_size=chunk_size, segments=segments, segment_retries=segment_retries,
            )

    h = hashlib.sha256()
    downloaded = 0
    progress_at = 0
    dest.parent.mkdir(parents=True, exist_ok=True)
    with requests.get(url, stream=True, timeout=600) as r:
        r.raise_for_status()
        try:
            total = int(r.headers["Content-Length"])
        except (KeyError, ValueError, TypeError):
            total = None
        with dest.open("wb") as f:
            for chunk in r.iter_content(chunk_size=chunk_size):
                if cancel_check is not None and cancel_check():
                    raise DownloadCancelled()
                if not chunk:
                    continue
                f.write(chunk)
                h.update(chunk)
                downloaded += len(chunk)
                if downloaded - progress_at >= 1024 * 1024:
                    if on_progress:
                        on_progress(downloaded, total)
                    progress_at = downloaded
    if on_progress:
        on_progress(downloaded, total)
    return h.hexdigest()


def _segmented_download(
    url: str,
    dest: Path,
    total: int,
    *,
    on_progress: Callable[[int, int | None], None] | None,
    cancel_check: Callable[[], bool] | None,
    chunk_size: int,
    segments: int,
    segment_retries: int,
) -> str:
    """Parallel byte-range fetch into the preallocated `dest`. Workers write at
    their own offsets through their own file handles (no shared-handle locking);
    progress aggregates the per-segment counters into the SAME on_progress seam
    at the same ~1/MB throttle; the first cancel (or failure past its retries)
    stops every worker. sha256 runs after assembly in one sequential read."""
    bounds = _segment_bounds(total, segments)
    _preallocate(dest, total)  # size the file for the offset writers WITHOUT a zero-fill stall

    written = [0] * len(bounds)          # per-segment byte counters
    stop = threading.Event()             # first cancel/failure stops all workers
    cancelled = threading.Event()
    failures: list[BaseException] = []
    lock = threading.Lock()
    progress_at = [0]

    def _report() -> None:
        if on_progress is None:
            return
        done = sum(written)
        if done - progress_at[0] >= 1024 * 1024:
            progress_at[0] = done
            on_progress(done, total)

    def _worker(idx: int, start: int, end: int) -> None:
        attempts = 0
        while not stop.is_set():
            try:
                offset = start + written[idx]
                if offset > end:
                    return  # this range is complete
                headers = {"Range": f"bytes={offset}-{end}"}
                with requests.get(url, stream=True, timeout=600, headers=headers) as r:
                    r.raise_for_status()
                    if r.status_code != 206:
                        # The probe said ranges work but this response ignored the
                        # Range header — writing a 200 body at an offset would
                        # corrupt the file, so raise BEFORE any write. Retried like
                        # any segment error (a flaky proxy can absorb a retry); a
                        # server that keeps answering 200 exhausts the retries and
                        # surfaces this message as the real error.
                        raise RuntimeError(f"server ignored Range (HTTP {r.status_code})")
                    with dest.open("r+b") as f:
                        f.seek(offset)
                        for chunk in r.iter_content(chunk_size=chunk_size):
                            if cancel_check is not None and cancel_check():
                                cancelled.set()
                                stop.set()
                                return
                            if stop.is_set():
                                return
                            if not chunk:
                                continue
                            f.write(chunk)
                            with lock:
                                written[idx] += len(chunk)
                                _report()
                if written[idx] == end - start + 1:
                    return  # segment complete
                raise OSError(f"segment {idx} ended short at {written[idx]} of {end - start + 1} bytes")
            except Exception as exc:  # noqa: BLE001 — retried per segment, then surfaced
                attempts += 1
                if attempts > segment_retries:
                    with lock:
                        failures.append(exc)
                    stop.set()
                    return
                # retry resumes from written[idx] — the Range header above re-derives

    threads = [
        threading.Thread(target=_worker, args=(i, a, b), daemon=True)
        for i, (a, b) in enumerate(bounds)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    if cancelled.is_set():
        raise DownloadCancelled()
    if failures:
        raise failures[0]

    if on_progress:
        on_progress(total, total)

    h = hashlib.sha256()
    with dest.open("rb") as f:
        while True:
            block = f.read(1024 * 1024)
            if not block:
                break
            h.update(block)
    return h.hexdigest()
