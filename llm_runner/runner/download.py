# SPDX-License-Identifier: GPL-3.0-or-later
"""File downloads (engine binaries + model GGUFs) via **pypdl** — a maintained,
concurrent, resumable downloader (parallel byte-range segments per file, auto
range-support fallback, per-file resume, retries).

This replaces the former hand-rolled `requests` + thread-pool segmenter
(`_segmented_download`/`_preallocate`/`_probe_range_support`) — the same
multi-connection behaviour, but the download mechanics are now a library's
problem, not ours. pypdl pulls only `aiohttp`/`aiofiles`, so the sidecar stays
ML-free and light.

`stream_download(url, dest, …)` keeps its former single-file signature so both
callers (`models.acquire_model` for GGUF shards, `binary.py` for the engine
archive) are unchanged; MODEL-level concurrency (many models downloading at
once) is orchestrated one layer up in `lifecycle.py`, where each concurrent
model download is its own `stream_download` call on its own thread. pypdl runs
its own asyncio loop on an internal thread, so calling this from a background
worker thread is safe (verified from pypdl source: it installs no signal
handlers, so it never touches the main thread's signal state).

Three pypdl footguns this adapter neutralizes (each verified from the vendored
pypdl 1.5.7 source — consumer.py / downloader.py / utils.py):
  * the TASK-level `overwrite=False` makes pypdl treat an existing FINAL file as
    already-done (consumer.py:100) — including a PARTIAL dest left by a failed
    single-stream try, which the retry would then bless as a corrupt "success".
    We pass `overwrite=True` (part-file RESUME is unaffected — it is governed by
    the `<dest>.json` progress-file/etag match, not this flag) and unlink the
    destination first as a belt.
  * a coroutine that CRASHES never sets `completed`, so the poll loop also
    watches `is_idle` (the loop has drained) or it would spin forever.
  * pypdl's completion `callback` fires only AT THE END — useless for a live
    bar — so progress is read off the instance attrs the monitor thread
    refreshes (`current_size` / `size`), and success is judged by the file on
    disk, not the (end-only) callback.

THE DEGRADE LADDER (2026-07-21, the user's "a great downloader that manages
concurrency"): pypdl does NOT adapt its segment count — when an origin supports
Range but blocks/kills some of the N connections, it retries the dead segments
and then fails the WHOLE file (consumer.py:70 → our RuntimeError); it only ever
falls back to a single stream when Range is unsupported (producer.py:149-151).
So `stream_download` wraps each attempt in a ladder: try N segments → on a
multi-segment failure HALVE and retry (8→4→2→1; 1 = a plain single stream) —
only a fully-exhausted ladder raises. Each step-down clears pypdl's on-disk
segment state first, because `create_segment_table` (utils.py:487) REUSES the
count recorded in `<dest>.json` whenever url+etag match — without the clear the
"lower" attempt would silently re-run at the old count. A user cancel
(`DownloadCancelled`) never degrades — it propagates immediately.

`download_segment_min_bytes` is RETIRED here (pypdl decides single- vs
multi-segment itself from the server's `Accept-Ranges` + size); the DB/config
field is kept accepting-but-inert for back-compat (see config.py + the
engine-config write path).
"""

from __future__ import annotations

import gc
import logging
import time
from pathlib import Path
from typing import Callable
from urllib.request import getproxies

from pypdl import Pypdl

log = logging.getLogger(__name__)


class DownloadCancelled(Exception):
    """Raised when `cancel_check()` returns True mid-download (the partial
    part-files are left on disk so a re-download resumes past them)."""


def download_kwargs(config) -> dict:
    """The pypdl per-download kwargs for a RunnerConfig — ONE place that collapses
    the `enabled` flag into the segment count (off → 1 → single-stream), so both
    consumers (engine binaries + model GGUFs) stay in step. Values are clamped to
    the config ceilings (#10): even a raw DB value or a hand-edited config can't
    route around them — past ~16 parallel Range requests only loads the CDN.

    `download_segment_min_bytes` is intentionally NOT returned: pypdl chooses
    single- vs multi-segment itself (a server without `Accept-Ranges`, or a
    zero-length body, falls back to a single stream), so the old floor is dead.
    The DB field is kept inert for back-compat."""
    # Local import keeps the module load dependency-light.
    from .config import MAX_DOWNLOAD_SEGMENT_COUNT, MAX_DOWNLOAD_SEGMENT_RETRIES

    enabled = bool(getattr(config, "download_segments_enabled", True))
    count = max(1, min(MAX_DOWNLOAD_SEGMENT_COUNT, int(getattr(config, "download_segment_count", 4) or 1)))
    retries = max(0, min(MAX_DOWNLOAD_SEGMENT_RETRIES, int(getattr(config, "download_segment_retries", 3))))
    return {"segments": count if enabled else 1, "retries": retries}


def _clear_segment_state(dest: Path) -> None:
    """Remove pypdl's multisegment on-disk state for `dest` — the `<dest>.json`
    progress file plus the `<dest>.0…N` part-files — so the next, lower-count
    ladder attempt genuinely builds its OWN segment table. Without this,
    `create_segment_table` (pypdl utils.py:487) reuses the count recorded in the
    progress file whenever url+etag match, silently defeating the step-down; and
    part-files from a different count have shifted byte boundaries, so reusing
    them would corrupt the file.

    Best-effort with a short retry: on Windows a just-cancelled worker can still
    hold a part-file open for an instant after the loop teardown (WinError 32).
    A part-file that survives is harmless — deleting `<dest>.json` forces a
    FRESH segment table whose overwrite=True makes pypdl itself remove/overwrite
    stale part-files (downloader.py:53) — so nothing here ever raises."""
    targets = [dest.with_name(dest.name + ".json")]
    targets += [p for p in dest.parent.glob(dest.name + ".*") if p.suffix[1:].isdigit()]
    for p in targets:
        for _ in range(4):
            try:
                p.unlink(missing_ok=True)
                break
            except OSError:
                # A torn-down worker's aiofiles handle may be waiting on GC to
                # finalize (its executor-thread close was orphaned by the loop
                # teardown) — collect() releases the Windows lock deterministically.
                gc.collect()
                time.sleep(0.15)
        else:
            log.warning("segment state %s still locked; the next attempt overwrites it", p)


def stream_download(
    url: str,
    dest: Path,
    on_progress: Callable[[int, int | None], None] | None = None,
    cancel_check: Callable[[], bool] | None = None,
    *,
    segments: int = 1,
    retries: int = 3,
    poll_interval: float = 0.3,
) -> None:
    """Download `url` into `dest` via pypdl, with the DEGRADE LADDER.

    With `segments` > 1 the file is fetched as parallel byte ranges when the
    server honours `Range` (pypdl probes and falls back to a single stream
    otherwise). A partial from a previous cancel is RESUMED, not restarted
    (`overwrite=False`): pypdl re-ranges each segment from the bytes already on
    disk (the `<dest>.0…N` part-files + a `<dest>.json` progress file).
    `on_progress(downloaded, total)` receives cumulative bytes vs. the total
    (`total` may be None until pypdl reads the size); `cancel_check` is polled
    every `poll_interval` s → `dl.stop()` + `DownloadCancelled`.

    Concurrency is SELF-HEALING (the ladder, module docstring): a multi-segment
    attempt that fails — an origin capping connections kills segments that pypdl
    retries and then gives up on — is retried at HALF the segment count, down to
    a plain single stream; only the exhausted ladder raises `RuntimeError`. Each
    step-down clears the failed attempt's segment state (boundaries shift with
    the count, and pypdl would otherwise reuse the recorded count), so the bytes
    of a degraded attempt are re-fetched — correctness over the rare partial. A
    cancel propagates immediately; it never degrades. On a degrade the progress
    bar restarts for the new attempt (cosmetic, rare).

    Returns None (the former sha256 return was unused by both callers; dropping
    it avoids a full re-read pass over multi-GB weights).
    """
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    seg = max(1, int(segments))
    degraded = False
    while True:
        try:
            _attempt(url, dest, on_progress, cancel_check, seg, retries, poll_interval)
            if degraded:
                # A failed rung's Windows file-lock can outlive the step-down clear
                # (its bounded retry logs and moves on); by now the final rung has
                # given it seconds to release — sweep so no part-file litter sits
                # next to the finished file.
                _clear_segment_state(dest)
            return
        except DownloadCancelled:
            raise
        except RuntimeError:
            if seg <= 1:
                raise                      # the ladder is exhausted — a real failure
            seg = max(1, seg // 2)
            log.warning("download degraded to %d segment(s) for %s", seg, url)
            degraded = True
            _clear_segment_state(dest)


def _attempt(
    url: str,
    dest: Path,
    on_progress: Callable[[int, int | None], None] | None,
    cancel_check: Callable[[], bool] | None,
    segments: int,
    retries: int,
    poll_interval: float,
) -> None:
    """ONE pypdl download attempt at a fixed segment count (the ladder above
    owns adaptation). Raises `RuntimeError` on failure, `DownloadCancelled` on a
    user cancel."""

    # BUG-A guard: remove any existing FINAL file BEFORE starting — the caller only
    # reaches here when a (re)download is WANTED (models.acquire_model calls it only
    # when the blob is absent or the wrong size; binary.py always wants a fresh
    # archive), so a leftover dest is never silently blessed. Belt to the
    # `overwrite=True` below, which closes the same hole MID-attempt (see there).
    dest.unlink(missing_ok=True)

    # aiohttp (pypdl's transport) does NOT honour the HTTP(S)_PROXY env vars that the
    # former `requests` path did; restore that by threading the resolved proxy through
    # start()'s **kwargs. Verified from the pypdl source that a task's extra kwargs reach
    # session.head/session.get on every request (producer._fetch_metadata → extract_metadata;
    # consumer._download → downloader.download), so `proxy=` takes effect for both the HEAD
    # probe and the range GETs. (No no_proxy handling — real downloads target HF/GitHub.)
    proxies = getproxies()
    proxy = proxies.get("https") or proxies.get("http")

    # logger=log so pypdl's own logger.exception (LoggingExecutor + consumer/producer
    # except paths) lands in the server logs instead of pypdl's default file handler.
    dl = Pypdl(max_concurrent=1, logger=log)
    proxy_kw = {"proxy": proxy} if proxy else {}
    try:
        dl.start(
            url=str(url),
            file_path=str(dest),
            multisegment=segments > 1,
            segments=max(1, int(segments)),
            retries=int(retries),
            # overwrite=True: the TASK-level flag only controls pypdl's "dest already
            # exists → already done" bless (consumer.py:100) — it does NOT govern
            # part-file resume (that is decided by the `<dest>.json` progress-file /
            # etag match inside create_segment_table, utils.py:480-488; proven by
            # test_resume_after_cancel passing with True). With False, a SINGLE-stream
            # try that died mid-body left a partial dest that the retry then blessed
            # as complete — a corrupt half-file reported as success (found 2026-07-21
            # by the ladder's exhausted-path test; latent for any no-Range server).
            overwrite=True,
            display=False,     # headless sidecar — no terminal bar; the UI polls our status
            block=False,       # we drive our own poll loop for progress + cancel
            **proxy_kw,
        )
        # `is_idle` (the loop has no running tasks) guards a CRASHED coroutine: a
        # MainThreadException sets pypdl's _interrupt + drains the loop WITHOUT flipping
        # `completed`, so a bare `while not dl.completed` would spin forever. Success sets
        # `completed` first (the monitor thread), then the tasks drain to idle — so the
        # normal path exits on `completed`, the crash path on `is_idle`.
        while not dl.completed and not dl.is_idle:
            if cancel_check is not None and cancel_check():
                dl.stop()
                raise DownloadCancelled()
            if on_progress is not None and dl.size:
                on_progress(dl.current_size, dl.size)
            time.sleep(poll_interval)

        # Final tick so a fast download still reports 100 % to the caller's bar.
        if on_progress is not None and dl.size:
            on_progress(dl.size, dl.size)
        # dest existence is GROUND TRUTH: combine_files (multiseg) and the single-segment
        # writer both write `dest` before the coroutine ends, so a present dest with an
        # empty `failed` list is a real success. A crash that never wrote dest — or a task
        # that exhausted its retries (pypdl records the url in `failed`) — raises, carrying
        # the failed-task list so the surfaced error names what actually died.
        if dl.failed or not dest.exists():
            raise RuntimeError(
                f"download failed for {url} after {retries} retries (failed={dl.failed})"
            )
    finally:
        # Tears down pypdl's event loop + progress thread (idempotent with stop()).
        dl.shutdown()
