# SPDX-License-Identifier: MIT
"""The chunk-queue downloader (`stream_download`) against a REAL in-process HTTP server
(offline, deterministic). Covers the contract: chunked (work-stealing) output is
bytes-identical · single-stream fallback when the server has no Range support ·
segments=1 is a plain browser-style GET · the unlink-first guard (a stale dest is NOT
blessed as already-downloaded) · cancel → DownloadCancelled · resume of a cancelled
chunked download from its completed chunks · a chunk that exhausts retries →
RuntimeError · the `download_kwargs` shape + clamps · rate limiting (the 2026-07-24
StyleTune 429): a 429 waits and recovers on every path, the probe never downgrades to
the non-resumable single stream, a persistent limiter fails loudly, headers (the HF
bearer token) ride every request, and chunk COUNT is bounded (HF limits requests/window).

Chunk-path tests pass a SMALL `chunk_size` so the ~2 MB payload genuinely chunks
(the production default is 8 MB, which would make this payload a single chunk)."""

from __future__ import annotations

import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

import pytest

from llm_runner.runner import download as dl
from llm_runner.runner.config import (
    MAX_DOWNLOAD_SEGMENT_COUNT,
    MAX_DOWNLOAD_SEGMENT_RETRIES,
)
from llm_runner.runner.download import (
    DownloadCancelled,
    download_kwargs,
    stream_download,
)

# ~2 MB + an odd tail so segment splits don't land on round boundaries.
PAYLOAD = bytes((i * 31 + (i >> 8)) % 256 for i in range(2 * 1024 * 1024 + 137))


@pytest.fixture(autouse=True)
def _no_proxy(monkeypatch):
    """A dev container may set HTTP(S)_PROXY to an agent proxy; these tests hit 127.0.0.1.
    `requests` honors NO_PROXY natively, so pin localhost out of any proxy. (Production keeps
    the env passthrough: real downloads target HF/GitHub, which SHOULD use the proxy.)"""
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    monkeypatch.setenv("no_proxy", "127.0.0.1,localhost")


class _RangeHandler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # noqa: D102 — silence test-server chatter
        pass

    def _meta_headers(self):
        # Complete metadata (accept-ranges + etag + length) for the downloader's range probe.
        # Stable ETag so a resumed run's validator matches its completed chunks.
        self.send_header("Content-Length", str(len(PAYLOAD)))
        self.send_header("ETag", '"abc"')
        self.send_header("Content-Disposition", 'attachment; filename="file.bin"')
        if self.server.ranges_enabled:
            self.send_header("Accept-Ranges", "bytes")

    def _write(self, data):
        """Write `data` in chunks, honouring the server's throttle; a client that closed early
        (a cancel) just ends the write."""
        step = 65536
        view = memoryview(data)
        for i in range(0, len(view), step):
            chunk = view[i : i + step]
            try:
                self.wfile.write(chunk)
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                return
            with self.server.lock:
                self.server.bytes_served += len(chunk)
            if self.server.chunk_delay:
                time.sleep(self.server.chunk_delay)

    def do_HEAD(self):  # noqa: N802 — http.server API
        self.send_response(200)
        self._meta_headers()
        self.end_headers()

    def do_GET(self):  # noqa: N802 — http.server API
        rng = self.headers.get("Range")
        rate_limited = False
        with self.server.lock:
            self.server.requests.append(rng)
            self.server.auth_headers.append(self.headers.get("Authorization"))
            if self.server.rate_limit_all:
                rate_limited = True
            elif self.server.rate_limit_skip > 0:
                self.server.rate_limit_skip -= 1
            elif self.server.rate_limit_next > 0:
                self.server.rate_limit_next -= 1
                rate_limited = True
        if rate_limited:
            self.send_response(429)
            for k, v in self.server.rate_limit_headers.items():
                self.send_header(k, v)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if rng and self.server.ranges_enabled:
            m = re.match(r"bytes=(\d+)-(\d+)", rng)
            a, b = int(m.group(1)), int(m.group(2))
            body = PAYLOAD[a : b + 1]
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {a}-{b}/{len(PAYLOAD)}")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("ETag", '"abc"')
            self.end_headers()
            # A configured failure: serve HALF the body then drop the connection — the worker
            # retries; when the fault is permanent (always_fail_ends), the whole file fails.
            fail = None
            if b in self.server.fail_once_ends:
                self.server.fail_once_ends.discard(b)
                fail = True
            elif b in self.server.always_fail_ends:
                fail = True
            if fail:
                self._write(body[: max(1, len(body) // 2)])
                try:
                    self.connection.close()
                except OSError:
                    pass
                return
            self._write(body)
        else:
            self.send_response(200)
            self.send_header("Content-Length", str(len(PAYLOAD)))
            self.send_header("ETag", '"abc"')
            self.end_headers()
            self._write(PAYLOAD)


@pytest.fixture
def server():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _RangeHandler)
    srv.ranges_enabled = True
    srv.requests = []
    srv.fail_once_ends = set()
    srv.always_fail_ends = set()
    srv.bytes_served = 0
    srv.chunk_delay = 0.0
    srv.auth_headers = []
    srv.rate_limit_next = 0          # 429 the next N requests (after rate_limit_skip pass through)
    srv.rate_limit_skip = 0          # let this many requests through before rate limiting
    srv.rate_limit_all = False       # 429 EVERY request — the persistent limiter
    srv.rate_limit_headers = {"Retry-After": "1"}
    srv.lock = threading.Lock()
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield srv
    srv.shutdown()


def _url(srv):
    return f"http://127.0.0.1:{srv.server_address[1]}/file.bin"


def _range_gets(srv):
    return [r for r in srv.requests if r]


# ── chunked output ≡ the payload ──────────────────────────────────────────────

CHUNK = 256 * 1024   # small test chunk so the ~2 MB payload genuinely chunks


def test_chunked_matches_payload(server, tmp_path):
    dest = tmp_path / "seg.bin"
    stream_download(_url(server), dest, segments=4, chunk_size=CHUNK, poll_interval=0.02)
    assert dest.read_bytes() == PAYLOAD
    nchunks = (len(PAYLOAD) + CHUNK - 1) // CHUNK
    assert len(_range_gets(server)) == 1 + nchunks             # the probe + one GET per chunk
    # the .part file + the progress json are cleaned up on success.
    assert list(tmp_path.glob("seg.bin.*")) == []


def test_chunked_progress_reaches_total(server, tmp_path):
    seen = []
    stream_download(_url(server), tmp_path / "p.bin", segments=4, chunk_size=CHUNK,
                    poll_interval=0.02, on_progress=lambda d, t: seen.append((d, t)))
    assert seen, "on_progress never fired"
    last = seen[-1]
    assert last[0] == last[1]                                # the final tick reports 100 %
    assert last[1] == len(PAYLOAD)                           # the probe's total is exact


# ── single-stream fallback / segments=1 ────────────────────────────────────────

def test_falls_back_without_range_support(server, tmp_path):
    server.ranges_enabled = False
    stream_download(_url(server), tmp_path / "f.bin", segments=4, poll_interval=0.02)
    assert (tmp_path / "f.bin").read_bytes() == PAYLOAD       # correct bytes via the single stream


def test_segments_one_is_single_stream(server, tmp_path):
    # segments=1 is a plain full-file GET, no Range fan-out (the adapter honours the count it's
    # given; both callers pass multi-segment via download_kwargs).
    stream_download(_url(server), tmp_path / "one.bin", segments=1, poll_interval=0.02)
    assert (tmp_path / "one.bin").read_bytes() == PAYLOAD
    assert _range_gets(server) == []                          # no multi-range fetch


# ── the unlink-first guard (BUG-A): a stale dest is NOT blessed as done ─────────

def test_unlink_first_overwrites_stale_dest(server, tmp_path):
    dest = tmp_path / "stale.bin"
    dest.write_bytes(b"STALE" * 1000)                         # wrong content + wrong size
    stream_download(_url(server), dest, segments=1, poll_interval=0.02)
    assert dest.read_bytes() == PAYLOAD                       # fresh download won, not the stale file


# ── cancel → DownloadCancelled ─────────────────────────────────────────────────

def test_cancel_raises_download_cancelled(server, tmp_path):
    server.chunk_delay = 0.01                                 # slow enough to catch mid-flight
    with pytest.raises(DownloadCancelled):
        stream_download(_url(server), tmp_path / "c.bin", segments=4, poll_interval=0.01,
                        cancel_check=lambda: True)


# ── resume a cancelled multisegment download from its part-files ───────────────

def test_resume_after_cancel(server, tmp_path):
    dest = tmp_path / "r.bin"
    rchunk = 128 * 1024                                       # 17 chunks over 4 workers
    server.chunk_delay = 0.02                                 # stretch the transfer so cancel lands mid-flight
    threshold = len(PAYLOAD) // 2                             # cancel at ~50 % served — several chunks are
    #                                                           certainly COMPLETED (and persisted) by then

    with pytest.raises(DownloadCancelled):
        stream_download(_url(server), dest, segments=4, chunk_size=rchunk, poll_interval=0.01,
                        cancel_check=lambda: server.bytes_served >= threshold)

    assert (tmp_path / "r.bin.json").exists()                # the progress file survives the cancel
    assert not dest.exists()                                 # no final file yet (only r.bin.part)
    assert server.bytes_served > 0

    server.chunk_delay = 0.0
    with server.lock:
        server.bytes_served = 0
        server.requests = []
    # SAME chunk_size — the resume validator matches (etag + chunkSize + total) and the
    # completed chunks are skipped, so the server serves strictly less than the whole file.
    stream_download(_url(server), dest, segments=4, chunk_size=rchunk, poll_interval=0.01)
    assert dest.read_bytes() == PAYLOAD                      # correct final bytes
    assert server.bytes_served < len(PAYLOAD)                # resumed → fewer bytes than a full fetch


# ── a chunk that exhausts its retries → RuntimeError, not Cancelled ────────────

def test_a_genuine_failure_raises_runtimeerror(server, tmp_path):
    # The chunk containing the LAST byte always dies mid-body: that chunk exhausts its retries
    # and fails the download with RuntimeError (never DownloadCancelled — the user-cancel path).
    server.always_fail_ends = {len(PAYLOAD) - 1}
    with pytest.raises(RuntimeError) as exc:
        stream_download(_url(server), tmp_path / "x.bin", segments=4, chunk_size=CHUNK,
                        retries=1, poll_interval=0.02)
    assert not isinstance(exc.value, DownloadCancelled)


# ── rate limiting (429) — the 2026-07-24 StyleTune failure class ───────────────

@pytest.fixture
def fast_rl(monkeypatch):
    """Shrink rate-limit waits so the suite stays fast — `_rate_limit_wait`'s PARSING is
    covered by its own unit test below; these tests cover the control flow around it."""
    monkeypatch.setattr(dl, "_rate_limit_wait", lambda headers, strikes: 0.05)


def test_probe_429_does_not_downgrade_to_single_stream(server, tmp_path, fast_rl):
    # THE StyleTune loss: the old probe swallowed a 429 into (0, "") → single stream (slower,
    # non-resumable). Now the probe waits and re-probes, and the download stays chunked.
    server.rate_limit_next = 1                       # the probe's bytes=0-0 GET gets 429'd
    dest = tmp_path / "rl.bin"
    stream_download(_url(server), dest, segments=4, chunk_size=CHUNK, poll_interval=0.02)
    assert dest.read_bytes() == PAYLOAD
    assert len(_range_gets(server)) > 2              # probe (429 + retry) + per-chunk GETs — chunked

def test_chunk_429_waits_and_completes(server, tmp_path, fast_rl):
    server.rate_limit_skip = 1                       # the probe passes
    server.rate_limit_next = 2                       # two chunk GETs each eat one 429
    dest = tmp_path / "rl2.bin"
    stream_download(_url(server), dest, segments=4, chunk_size=CHUNK, poll_interval=0.02)
    assert dest.read_bytes() == PAYLOAD              # both rate-limited chunks recovered

def test_single_stream_429_recovers(server, tmp_path, fast_rl):
    server.rate_limit_next = 1
    stream_download(_url(server), tmp_path / "s.bin", segments=1, poll_interval=0.02)
    assert (tmp_path / "s.bin").read_bytes() == PAYLOAD

def test_persistent_429_fails_loudly_not_forever(server, tmp_path, fast_rl):
    server.rate_limit_all = True
    with pytest.raises(RuntimeError) as exc:
        stream_download(_url(server), tmp_path / "x.bin", segments=4, chunk_size=CHUNK,
                        retries=1, poll_interval=0.02)
    assert "rate limited" in str(exc.value)          # the strike-out message, incl. HF_TOKEN hint
    assert not isinstance(exc.value, DownloadCancelled)

def test_rate_limit_wait_parses_server_declared_waits():
    # HF's IETF-draft RateLimit header (t= seconds until the window resets) wins…
    assert dl._rate_limit_wait({"RateLimit": '"resolvers";r=0;t=42'}, 1) == 42.0
    # …then a delta-seconds Retry-After…
    assert dl._rate_limit_wait({"Retry-After": "7"}, 1) == 7.0
    # …an HTTP-date Retry-After falls through to the exponential backoff…
    assert dl._rate_limit_wait({"Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT"}, 1) == 15.0
    assert dl._rate_limit_wait({}, 3) == 60.0        # 15 × 2^(3-1)
    # …and everything caps at the 5-minute window.
    assert dl._rate_limit_wait({"RateLimit": '"resolvers";r=0;t=9999'}, 1) == 300.0


# ── headers ride every request (the HF bearer token path) ─────────────────────

def test_headers_ride_every_request(server, tmp_path):
    stream_download(_url(server), tmp_path / "h.bin", segments=4, chunk_size=CHUNK,
                    poll_interval=0.02, headers={"Authorization": "Bearer sekrit"})
    with server.lock:
        auths = set(server.auth_headers)
    assert auths == {"Bearer sekrit"}                # the probe AND every chunk carried it


# ── request-count discipline — chunk count bounded (HF limits REQUESTS/window) ─

def test_chunk_count_is_bounded_by_request_discipline(server, tmp_path):
    # A pathologically small chunk_size would cost hundreds of requests (the 8 MB default
    # cost ~1,775 on a 14 GB GGUF); the scaling floor keeps a file ≤ segments × 4 requests.
    stream_download(_url(server), tmp_path / "b.bin", segments=2, chunk_size=4096,
                    poll_interval=0.02)
    assert (tmp_path / "b.bin").read_bytes() == PAYLOAD
    assert len(_range_gets(server)) <= 1 + 2 * 4     # the probe + at most segments×4 chunk GETs


# ── download_kwargs — the {segments, retries} shape + the clamps (MODEL path) ──

def test_download_kwargs_shape_and_collapse():
    cfg = SimpleNamespace(download_segments_enabled=True, download_segment_count=6,
                          download_segment_retries=2)
    assert download_kwargs(cfg) == {"segments": 6, "retries": 2}   # min_bytes is RETIRED — gone from the shape
    cfg.download_segments_enabled = False
    assert download_kwargs(cfg)["segments"] == 1                   # off → the single stream


def test_download_kwargs_clamps_count_and_retries():
    over = SimpleNamespace(download_segments_enabled=True, download_segment_count=200,
                           download_segment_retries=99)
    kw = download_kwargs(over)
    assert kw["segments"] == MAX_DOWNLOAD_SEGMENT_COUNT             # 200 → the ceiling
    assert kw["retries"] == MAX_DOWNLOAD_SEGMENT_RETRIES
    assert "segment_min_bytes" not in kw                           # the retired knob leaks nowhere
    under = SimpleNamespace(download_segments_enabled=True, download_segment_count=0,
                            download_segment_retries=-5)
    kw2 = download_kwargs(under)
    assert kw2["segments"] == 1 and kw2["retries"] == 0            # floor: single stream, no negative retries
