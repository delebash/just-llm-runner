# SPDX-License-Identifier: GPL-3.0-or-later
"""Segmented downloads (DL-2) — the plan's test list, against a REAL in-process
HTTP server (offline, deterministic): boundary math (exact cover, no overlap,
last byte inclusive) · the fallback matrix (no accept-ranges / small file /
disabled → the single-stream path) · per-segment retry RESUME from the bytes
already written · post-assembly sha256 equals the single-stream digest · cancel
stops all workers · the enabled→count collapse (download_kwargs)."""

from __future__ import annotations

import hashlib
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

import pytest

from llm_runner.runner.download import (
    DownloadCancelled,
    _segment_bounds,
    download_kwargs,
    stream_download,
)

PAYLOAD = bytes((i * 31 + (i >> 8)) % 256 for i in range(2 * 1024 * 1024 + 137))
SHA = hashlib.sha256(PAYLOAD).hexdigest()


class _RangeHandler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # noqa: D102 — silence test-server chatter
        pass

    def do_HEAD(self):  # noqa: N802 — http.server API
        self.send_response(200)
        if self.server.ranges_enabled:
            self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(len(PAYLOAD)))
        self.end_headers()

    def do_GET(self):  # noqa: N802 — http.server API
        rng = self.headers.get("Range")
        self.server.requests.append(rng)
        if rng and self.server.ranges_enabled:
            m = re.match(r"bytes=(\d+)-(\d+)", rng)
            a, b = int(m.group(1)), int(m.group(2))
            body = PAYLOAD[a : b + 1]
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {a}-{b}/{len(PAYLOAD)}")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            # A configured mid-range failure: send HALF the body, then drop the
            # connection — the worker must retry and RESUME from what it wrote.
            if b in self.server.fail_once_ends:
                self.server.fail_once_ends.discard(b)
                self.wfile.write(body[: max(1, len(body) // 2)])
                self.wfile.flush()
                self.connection.close()
                return
            if b in self.server.always_fail_ends:
                self.wfile.write(body[: max(1, len(body) // 2)])
                self.wfile.flush()
                self.connection.close()
                return
            self.wfile.write(body)
        else:
            self.send_response(200)
            self.send_header("Content-Length", str(len(PAYLOAD)))
            self.end_headers()
            self.wfile.write(PAYLOAD)


@pytest.fixture
def server():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _RangeHandler)
    srv.ranges_enabled = True
    srv.requests = []
    srv.fail_once_ends = set()
    srv.always_fail_ends = set()
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield srv
    srv.shutdown()


def _url(srv):
    return f"http://127.0.0.1:{srv.server_address[1]}/file.bin"


def _range_gets(srv):
    return [r for r in srv.requests if r]


# ── boundary math ─────────────────────────────────────────────────────────────

def test_segment_bounds_exact_cover():
    for total, n in ((100, 4), (7, 3), (1, 4), (2 * 1024 * 1024 + 137, 4), (10, 10)):
        bounds = _segment_bounds(total, n)
        assert bounds[0][0] == 0
        assert bounds[-1][1] == total - 1                      # last byte inclusive
        for (a, b), (c, _d) in zip(bounds, bounds[1:]):
            assert c == b + 1                                  # no gap, no overlap
        assert sum(b - a + 1 for a, b in bounds) == total      # exact cover


def test_segment_bounds_never_more_segments_than_bytes():
    assert len(_segment_bounds(3, 8)) == 3
    assert _segment_bounds(3, 8) == [(0, 0), (1, 1), (2, 2)]


# ── the sha contract: segmented output ≡ single-stream output ─────────────────

def test_segmented_matches_single_stream_sha(server, tmp_path):
    dest = tmp_path / "seg.bin"
    digest = stream_download(_url(server), dest, segments=4, segment_min_bytes=1024)
    assert digest == SHA
    assert dest.read_bytes() == PAYLOAD
    assert len(_range_gets(server)) == 4                       # four parallel ranges


def test_segmented_progress_reaches_total(server, tmp_path):
    seen = []
    stream_download(_url(server), tmp_path / "p.bin", segments=4, segment_min_bytes=1024,
                    on_progress=lambda d, t: seen.append((d, t)))
    assert seen[-1] == (len(PAYLOAD), len(PAYLOAD))
    assert all(t == len(PAYLOAD) for _d, t in seen)


# ── the fallback matrix: single-stream whenever anything disqualifies ─────────

def test_falls_back_without_range_support(server, tmp_path):
    server.ranges_enabled = False
    digest = stream_download(_url(server), tmp_path / "f.bin", segments=4, segment_min_bytes=1024)
    assert digest == SHA
    assert _range_gets(server) == []                           # plain GET only


def test_small_file_stays_single_stream(server, tmp_path):
    digest = stream_download(_url(server), tmp_path / "s.bin",
                             segments=4, segment_min_bytes=len(PAYLOAD) + 1)
    assert digest == SHA
    assert _range_gets(server) == []


def test_segments_one_never_probes(server, tmp_path):
    digest = stream_download(_url(server), tmp_path / "one.bin", segments=1)
    assert digest == SHA
    assert server.requests == [None]                           # one plain GET, no HEAD ranges


# ── per-segment retry + resume ────────────────────────────────────────────────

def test_segment_retry_resumes_from_written(server, tmp_path):
    bounds = _segment_bounds(len(PAYLOAD), 4)
    fail_end = bounds[2][1]                                    # third segment dies once
    server.fail_once_ends = {fail_end}
    digest = stream_download(_url(server), tmp_path / "r.bin",
                             segments=4, segment_min_bytes=1024, segment_retries=3)
    assert digest == SHA
    # The retry's Range must RESUME past the segment's own start (bytes already
    # written are never re-fetched) and share the same end.
    starts = [(int(m.group(1)), int(m.group(2)))
              for m in (re.match(r"bytes=(\d+)-(\d+)", r) for r in _range_gets(server)) if m]
    retries = [s for s in starts if s[1] == fail_end]
    assert len(retries) == 2
    assert retries[1][0] > bounds[2][0]


def test_retries_exhausted_fails_with_real_error(server, tmp_path):
    bounds = _segment_bounds(len(PAYLOAD), 4)
    server.always_fail_ends = {bounds[1][1]}                   # second segment never completes
    with pytest.raises(Exception) as exc:
        stream_download(_url(server), tmp_path / "x.bin",
                        segments=4, segment_min_bytes=1024, segment_retries=1)
    assert not isinstance(exc.value, DownloadCancelled)
    assert (tmp_path / "x.bin").exists()                       # partial left for the caller


# ── cancel stops every worker ─────────────────────────────────────────────────

def test_cancel_stops_all_workers(server, tmp_path):
    with pytest.raises(DownloadCancelled):
        stream_download(_url(server), tmp_path / "c.bin",
                        segments=4, segment_min_bytes=1024, cancel_check=lambda: True)


# ── the enabled→count collapse (ONE place, both consumers) ────────────────────

def test_download_kwargs_collapse():
    cfg = SimpleNamespace(download_segments_enabled=True, download_segment_count=6,
                          download_segment_min_bytes=123, download_segment_retries=2)
    assert download_kwargs(cfg) == {"segments": 6, "segment_min_bytes": 123, "segment_retries": 2}
    cfg.download_segments_enabled = False
    assert download_kwargs(cfg)["segments"] == 1               # off = the single-stream path
