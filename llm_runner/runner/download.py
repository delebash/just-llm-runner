# SPDX-License-Identifier: MIT
"""File downloads (engine binaries + model GGUFs) — the industry-standard CHUNK-QUEUE design.

HOW PROFESSIONAL DOWNLOADERS WORK (IDM "dynamic segmentation", aria2, Steam, hf_transfer):
the file is split into many FIXED-SIZE CHUNKS on a work queue, and N connections PULL chunks
as they finish. No connection is pinned to a fixed 1/N slice, so a slow connection only
delays the ONE chunk it holds while the fast connections keep pulling — aggregate speed is
the SUM of the connections, never hostage to the slowest. Our previous library (pypdl) used
STATIC segmentation (each connection owns a fixed 1/N of the file): one slow connection
dragged the whole download, which is exactly the engine-download crawl the user kept hitting
(GitHub's CDN hands out fast and slow connections unpredictably; measured on their box:
static 8-segment runs at 1–4 MB/s while a single connection ran 20–26 MB/s).

Concurrency at BOTH levels:
  * per FILE — `segments` worker connections pulling chunks off the queue (default 8, from
    the config via `download_kwargs`).
  * across FILES — each model download runs on its own thread with its own
    `stream_download` call (lifecycle.py, up to `download_max_concurrent` at once).

Also standard: per-chunk RETRIES on a fresh connection (a stalled connection hits the read
timeout, errors, and its chunk re-queues — stall recovery comes free), RESUME from completed
chunks (`<dest>.json` records them, etag-validated; the partial rides in `<dest>.part`),
cancel via `cancel_check` (partials kept for resume), a single-stream fallback when the
server has no Range support (or the file fits in one chunk), and `segments=1` = a plain
browser-style GET. Transport: `requests` (already a runner dependency; it honors the
HTTP(S)_PROXY / NO_PROXY env vars natively).
"""

from __future__ import annotations

import json
import logging
import os
import queue
import re
import threading
import time
from pathlib import Path
from typing import Callable

import requests

log = logging.getLogger(__name__)

DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024   # floor — see the request-count scaling in stream_download
_READ_STEP = 256 * 1024                # stream read/progress step within a chunk
_CONNECT_TIMEOUT = 15.0
_READ_TIMEOUT = 60.0                   # a dead connection errors here → the chunk retries fresh

# REQUEST-COUNT DISCIPLINE (2026-07-24, the StyleTune 429). Every chunk is one HTTP request,
# and HuggingFace rate-limits by REQUEST COUNT per 5-minute window (anonymous: 3,000 resolver
# hits/IP — https://huggingface.co/docs/hub/rate-limits). At a fixed 8 MB chunk a 14 GB GGUF
# cost ~1,775 requests; two concurrent models busted the window on their own. So the chunk
# size now SCALES with the file: a download never spends more than `segments × 4` requests
# (~32 at the default 8), keeping work-stealing granularity (4 chunks per connection) while
# behaving like aria2/IDM's few-long-streams model instead of a request storm.
_CHUNKS_PER_WORKER = 4

# Rate-limit semantics (same doc): a 429 carries the IETF draft-ietf-httpapi-ratelimit-headers
# `RateLimit` header (`"resolvers";r=0;t=<seconds until the window resets>`) — the correct
# client waits exactly `t`, which is what huggingface_hub 1.2+ does and what we mirror here.
# `Retry-After` is honored as the second source; a bare 429/503 backs off exponentially.
# Rate-limit waits are NOT transport failures: they never consume a chunk's `retries` budget
# and instead share a per-download strike cap so a persistent limiter fails loudly, late.
_RATE_LIMIT_STATUSES = (429, 503)
_RATE_LIMIT_MAX_WAIT = 300.0           # ceiling per wait — the HF window is 5 minutes
_RATE_LIMIT_STRIKES = 6                # shared per download; then RuntimeError, loudly


class DownloadCancelled(Exception):
    """Raised when `cancel_check()` returns True mid-download (the chunked partial stays on
    disk so a re-download resumes past the completed chunks)."""


class _RateLimitExceeded(RuntimeError):
    """A download that kept hitting 429/503 past the shared strike cap — surfaced as the
    loud terminal failure, distinct from transport retry exhaustion."""


def _rate_limit_wait(headers, strikes: int) -> float:
    """Seconds to wait for a 429/503: the `RateLimit` header's `t=` (HF's IETF-draft field,
    seconds until the window resets) → `Retry-After` (delta-seconds) → exponential fallback.
    Always at least 1 s, capped at the 5-minute window."""
    m = re.search(r"[;\s]t=(\d+(?:\.\d+)?)", headers.get("RateLimit", "") or "")
    if m:
        return min(_RATE_LIMIT_MAX_WAIT, max(1.0, float(m.group(1))))
    ra = (headers.get("Retry-After", "") or "").strip()
    try:
        return min(_RATE_LIMIT_MAX_WAIT, max(1.0, float(ra)))
    except ValueError:
        pass                                   # an HTTP-date Retry-After falls to the backoff
    return min(_RATE_LIMIT_MAX_WAIT, 15.0 * (2.0 ** max(0, strikes - 1)))


class _RateGate:
    """ONE gate per download: the first worker that sees a 429 sets the deadline and EVERY
    connection (probe, single-stream, all chunk workers) parks until it passes — per-worker
    sleeps would let the other connections keep hammering and extend the window."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._until = 0.0
        self.strikes = 0

    def strike(self, headers) -> None:
        """Record one rate-limit hit; raises `_RateLimitExceeded` past the shared cap."""
        with self._lock:
            self.strikes += 1
            if self.strikes > _RATE_LIMIT_STRIKES:
                raise _RateLimitExceeded(
                    f"rate limited {self.strikes} times (HTTP 429/503) — server window not "
                    f"clearing; set HF_TOKEN (raises the per-IP limit) or retry later")
            wait = _rate_limit_wait(headers, self.strikes)
            self._until = max(self._until, time.monotonic() + wait)
            log.warning("rate limited (strike %d/%d) — waiting %.0f s",
                        self.strikes, _RATE_LIMIT_STRIKES, wait)

    def wait(self, cancel_check: Callable[[], bool] | None) -> None:
        """Park until the deadline passes; cancel stays instant (0.25 s poll)."""
        while True:
            with self._lock:
                remaining = self._until - time.monotonic()
            if remaining <= 0:
                return
            if cancel_check is not None and cancel_check():
                raise DownloadCancelled()
            time.sleep(min(0.25, remaining))


def download_kwargs(config) -> dict:
    """Per-download kwargs from a RunnerConfig — ONE place that collapses the `enabled` flag
    into the connection count (off → 1 → a plain single stream), clamped to the config
    ceilings (#10). Used by BOTH the engine archive and the model GGUFs.

    `download_segment_min_bytes` is RETIRED (the downloader falls back to a single stream by
    itself when Range is unsupported or the file fits in one chunk); the DB field stays inert
    for back-compat."""
    from .config import MAX_DOWNLOAD_SEGMENT_COUNT, MAX_DOWNLOAD_SEGMENT_RETRIES

    enabled = bool(getattr(config, "download_segments_enabled", True))
    count = max(1, min(MAX_DOWNLOAD_SEGMENT_COUNT, int(getattr(config, "download_segment_count", 8) or 1)))
    retries = max(0, min(MAX_DOWNLOAD_SEGMENT_RETRIES, int(getattr(config, "download_segment_retries", 3))))
    return {"segments": count if enabled else 1, "retries": retries}


def _make_session(pool: int) -> requests.Session:
    s = requests.Session()
    adapter = requests.adapters.HTTPAdapter(pool_connections=4, pool_maxsize=max(4, pool + 2))
    s.mount("http://", adapter)
    s.mount("https://", adapter)
    return s


def _probe(session: requests.Session, url: str, gate: _RateGate,
           cancel_check: Callable[[], bool] | None) -> tuple[int, str]:
    """Range-probe: (total size, etag) when the server honors byte ranges, else (0, "").
    A 1-byte ranged GET (not HEAD — some CDNs answer HEAD without range headers).

    A 429/503 here WAITS on the gate and re-probes (up to the shared strike cap) instead of
    falling through — the old silent (0, "") on a rate limit downgraded the download to the
    single stream, which is slower AND cannot resume: exactly the 2026-07-24 StyleTune loss."""
    while True:
        try:
            with session.get(url, headers={"Range": "bytes=0-0"}, stream=True,
                             timeout=(_CONNECT_TIMEOUT, _READ_TIMEOUT), allow_redirects=True) as r:
                if r.status_code in _RATE_LIMIT_STATUSES:
                    gate.strike(r.headers)     # raises _RateLimitExceeded past the cap
                    gate.wait(cancel_check)
                    continue
                if r.status_code == 206:
                    cr = r.headers.get("Content-Range", "")
                    try:
                        total = int(cr.rsplit("/", 1)[-1])
                    except ValueError:
                        total = 0
                    if total > 0:
                        return total, r.headers.get("ETag", "")
        except requests.RequestException:
            pass   # the download attempt itself will surface a real network problem
        return 0, ""


def _single_stream(
    session, url: str, dest: Path,
    on_progress, cancel_check, retries: int, gate: _RateGate,
) -> None:
    """A plain browser-style GET — `segments=1`, no Range support, or a one-chunk file.
    A 429/503 waits on the shared gate (never consuming a transport retry); genuine
    transport errors keep the short-backoff retry budget they always had."""
    part = dest.with_name(dest.name + ".part")
    last: Exception | None = None
    attempt = 0
    while attempt <= retries:
        try:
            done = 0
            with session.get(url, stream=True, timeout=(_CONNECT_TIMEOUT, _READ_TIMEOUT)) as r:
                if r.status_code in _RATE_LIMIT_STATUSES:
                    gate.strike(r.headers)     # raises _RateLimitExceeded past the cap
                    gate.wait(cancel_check)
                    continue                   # not a transport failure — attempt unchanged
                r.raise_for_status()
                total = int(r.headers.get("Content-Length") or 0) or None
                with open(part, "wb") as f:
                    for piece in r.iter_content(_READ_STEP):
                        if cancel_check is not None and cancel_check():
                            raise DownloadCancelled()
                        f.write(piece)
                        done += len(piece)
                        if on_progress is not None:
                            on_progress(done, total)
            os.replace(part, dest)
            if on_progress is not None:
                on_progress(done, total if total else done)
            return
        except DownloadCancelled:
            part.unlink(missing_ok=True)   # no chunk map here → a partial single stream can't resume
            raise
        except _RateLimitExceeded:
            raise                          # the loud strike-out — never swallowed by the retry loop
        except Exception as e:  # noqa: BLE001 — every transport error retries, then surfaces below
            last = e
            attempt += 1
            time.sleep(min(2.0, 0.5 * attempt))
    raise RuntimeError(f"download failed for {url} after {retries} retries: {last}")


def _load_done_chunks(pfile: Path, etag: str, chunk_size: int, total: int) -> set[int]:
    """The completed-chunk set from a previous run — honored only when the validator matches
    (same etag/chunking/size), else the resume starts clean."""
    try:
        d = json.loads(pfile.read_text())
        if etag and d.get("etag") == etag and d.get("chunkSize") == chunk_size and d.get("total") == total:
            return {int(i) for i in d.get("done", [])}
    except (OSError, ValueError):
        pass
    return set()


def _chunked(
    session, url: str, dest: Path,
    on_progress, cancel_check,
    workers: int, retries: int, chunk_size: int, total: int, etag: str,
    poll_interval: float, gate: _RateGate,
) -> None:
    """The chunk-queue download: N worker connections pull chunk indexes off a shared queue
    and write each chunk at its offset into the preallocated `<dest>.part`."""
    part = dest.with_name(dest.name + ".part")
    pfile = dest.with_name(dest.name + ".json")
    nchunks = (total + chunk_size - 1) // chunk_size

    done = _load_done_chunks(pfile, etag, chunk_size, total)
    if not part.exists() or part.stat().st_size != total:
        done = set()
        with open(part, "wb") as f:
            f.truncate(total)          # sparse preallocate — chunks land at their offsets

    lock = threading.Lock()
    state = {"bytes": sum(min(chunk_size, total - i * chunk_size) for i in done), "err": None}
    cancel_evt = threading.Event()
    fail_evt = threading.Event()
    todo: queue.Queue[int] = queue.Queue()
    for i in range(nchunks):
        if i not in done:
            todo.put(i)

    def persist() -> None:
        # Atomic (tmp + replace) so a kill mid-write can't leave a torn resume file.
        tmp = pfile.with_name(pfile.name + ".tmp")
        tmp.write_text(json.dumps({"etag": etag, "chunkSize": chunk_size, "total": total,
                                   "done": sorted(done)}))
        os.replace(tmp, pfile)

    with lock:
        persist()   # record the validator up front — a cancel before any chunk still resumes cleanly

    def fetch_chunk(i: int) -> bool:
        start = i * chunk_size
        end = min(total, start + chunk_size) - 1
        want = end - start + 1
        last: Exception | None = None
        attempt = 0
        while attempt <= retries:
            if cancel_evt.is_set() or fail_evt.is_set():
                return False
            got = 0
            try:
                with session.get(url, headers={"Range": f"bytes={start}-{end}"}, stream=True,
                                 timeout=(_CONNECT_TIMEOUT, _READ_TIMEOUT)) as r:
                    if r.status_code in _RATE_LIMIT_STATUSES:
                        gate.strike(r.headers)         # raises _RateLimitExceeded past the cap
                        gate.wait(lambda: cancel_evt.is_set())
                        continue                       # not a transport failure — attempt unchanged
                    if r.status_code != 206:
                        raise OSError(f"expected 206 for chunk {i}, got {r.status_code}")
                    with open(part, "r+b") as f:   # own handle per chunk; offsets never overlap
                        f.seek(start)
                        for piece in r.iter_content(_READ_STEP):
                            if cancel_evt.is_set():
                                return False
                            f.write(piece)
                            got += len(piece)
                            with lock:
                                state["bytes"] += len(piece)
                if got != want:
                    raise OSError(f"chunk {i}: short read {got}/{want}")
                return True
            except DownloadCancelled:              # gate.wait saw cancel_evt — a cancel, not an error
                return False
            except _RateLimitExceeded as e:        # the shared strike-out fails the download loudly
                last = e
                break
            except Exception as e:  # noqa: BLE001 — any transport error re-queues this chunk
                with lock:
                    state["bytes"] -= got   # the partial chunk re-downloads — keep the counter honest
                last = e
                attempt += 1
                time.sleep(min(2.0, 0.5 * attempt))
        with lock:
            state["err"] = last
        fail_evt.set()
        return False

    def worker() -> None:
        while not cancel_evt.is_set() and not fail_evt.is_set():
            try:
                i = todo.get_nowait()
            except queue.Empty:
                return
            if fetch_chunk(i):
                with lock:
                    done.add(i)
                    persist()

    threads = [threading.Thread(target=worker, daemon=True) for _ in range(min(workers, nchunks))]
    for t in threads:
        t.start()
    while any(t.is_alive() for t in threads):
        if cancel_check is not None and cancel_check():
            cancel_evt.set()
        if on_progress is not None:
            with lock:
                b = state["bytes"]
            on_progress(b, total)
        time.sleep(poll_interval)
    for t in threads:
        t.join()

    if cancel_evt.is_set():
        raise DownloadCancelled()      # part + json stay → the next run resumes past `done`
    if fail_evt.is_set() or len(done) != nchunks:
        raise RuntimeError(f"download failed for {url} after {retries} retries: {state['err']}")
    os.replace(part, dest)
    pfile.unlink(missing_ok=True)
    if on_progress is not None:
        on_progress(total, total)


def stream_download(
    url: str,
    dest: Path,
    on_progress: Callable[[int, int | None], None] | None = None,
    cancel_check: Callable[[], bool] | None = None,
    *,
    segments: int = 8,
    retries: int = 3,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
    poll_interval: float = 0.3,
    headers: dict | None = None,
) -> None:
    """Download `url` into `dest`. `segments` worker connections pull `chunk_size` chunks off
    a queue (the professional-downloader design — module docstring); `segments=1`, a server
    without Range support, or a one-chunk file runs a plain browser-style GET.
    `on_progress(downloaded, total)` gets cumulative bytes (`total` None when unknown);
    `cancel_check` polled every `poll_interval` s → `DownloadCancelled` (chunked partials are
    kept for resume). Per-chunk failures retry on fresh connections; a chunk that exhausts
    `retries` fails the download with `RuntimeError`. A 429/503 parks EVERY connection on one
    shared gate for the server-declared wait (`RateLimit` t= / `Retry-After`) without spending
    transport retries — see the module-top rate-limit notes. `headers` ride every request
    (the HF bearer token enters here).

    `chunk_size` is a FLOOR: it scales up so the whole file costs at most
    `segments × _CHUNKS_PER_WORKER` requests — request COUNT is what HF rate-limits.
    (A resume across this change restarts clean: the resume validator records chunkSize.)"""
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    # The caller only reaches here when a (re)download is WANTED — never bless a leftover dest.
    dest.unlink(missing_ok=True)

    gate = _RateGate()
    session = _make_session(pool=max(1, int(segments)))
    if headers:
        session.headers.update(headers)
    try:
        if int(segments) <= 1:
            _single_stream(session, url, dest, on_progress, cancel_check, int(retries), gate)
            return
        total, etag = _probe(session, url, gate, cancel_check)
        if total:
            max_requests = max(1, int(segments)) * _CHUNKS_PER_WORKER
            floor = (total + max_requests - 1) // max_requests
            if floor > int(chunk_size):
                chunk_size = floor
        nchunks = (total + chunk_size - 1) // chunk_size if total else 0
        if nchunks <= 1:   # no Range support, unknown size, or the file fits in one chunk
            _single_stream(session, url, dest, on_progress, cancel_check, int(retries), gate)
            return
        _chunked(session, url, dest, on_progress, cancel_check,
                 int(segments), int(retries), int(chunk_size), total, etag, poll_interval, gate)
    finally:
        session.close()
