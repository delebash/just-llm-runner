# SPDX-License-Identifier: GPL-3.0-or-later
"""The pypdl download adapter (`stream_download`) against a REAL in-process HTTP
server (offline, deterministic). Covers the adapter CONTRACT, not pypdl's own
internals: multisegment bytes-identical output · single-stream fallback when the
server has no Range support · the unlink-first guard (a stale dest is NOT blessed
as already-downloaded) · cancel → DownloadCancelled · resume of a cancelled
multisegment download from its part-files · a genuine failure → RuntimeError ·
the `download_kwargs` shape + clamps. The old hand-rolled internals
(`_segment_bounds`/`_preallocate`, the sha return) are gone with the requests
segmenter, so their tests are gone too."""

from __future__ import annotations

import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

import pytest

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
    """The dev container sets HTTPS_PROXY to the agent proxy; these tests hit 127.0.0.1, and an
    explicit aiohttp `proxy=` IGNORES no_proxy — so neutralize proxy resolution here. (Production
    keeps the passthrough: real downloads target HF/GitHub, which SHOULD use the proxy.)"""
    monkeypatch.setattr("llm_runner.runner.download.getproxies", lambda: {})


class _RangeHandler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # noqa: D102 — silence test-server chatter
        pass

    def _meta_headers(self):
        # A COMPLETE metadata HEAD (accept-ranges + etag + content-disposition + length) so
        # pypdl's producer needs no fallback GET — the range GETs it records are the real
        # segment fetches, nothing else. Stable ETag so a resumed run validates its part-files.
        self.send_header("Content-Length", str(len(PAYLOAD)))
        self.send_header("ETag", '"abc"')
        self.send_header("Content-Disposition", 'attachment; filename="file.bin"')
        if self.server.ranges_enabled:
            self.send_header("Accept-Ranges", "bytes")

    def _write(self, data):
        """Write `data` in chunks, counting served bytes and honouring the server's throttle;
        a client that closed early (a cancel) just ends the write."""
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
        with self.server.lock:
            self.server.requests.append(rng)
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
            # A configured failure: serve HALF the body, then drop the connection — the worker
            # must retry (and, when the fault is transient, resume past the bytes it kept).
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
            if self.server.always_fail_plain:
                # The plain (single-stream) fetch also dies mid-body — used to prove the
                # exhausted-ladder path (multiseg degraded to 1 and THAT fails too).
                self._write(PAYLOAD[: len(PAYLOAD) // 2])
                try:
                    self.connection.close()
                except OSError:
                    pass
                return
            self._write(PAYLOAD)


@pytest.fixture
def server():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _RangeHandler)
    srv.ranges_enabled = True
    srv.requests = []
    srv.fail_once_ends = set()
    srv.always_fail_ends = set()
    srv.always_fail_plain = False
    srv.bytes_served = 0
    srv.chunk_delay = 0.0
    srv.lock = threading.Lock()
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield srv
    srv.shutdown()


def _url(srv):
    return f"http://127.0.0.1:{srv.server_address[1]}/file.bin"


def _range_gets(srv):
    return [r for r in srv.requests if r]


# ── multisegment output ≡ the payload ─────────────────────────────────────────

def test_multisegment_matches_payload(server, tmp_path):
    dest = tmp_path / "seg.bin"
    stream_download(_url(server), dest, segments=4, poll_interval=0.02)
    assert dest.read_bytes() == PAYLOAD
    assert len(_range_gets(server)) == 4                       # four parallel ranges
    # part-files + the progress json are cleaned up on success (combine_files removes them).
    assert list(tmp_path.glob("seg.bin.*")) == []


def test_multisegment_progress_reaches_total(server, tmp_path):
    seen = []
    stream_download(_url(server), tmp_path / "p.bin", segments=4, poll_interval=0.02,
                    on_progress=lambda d, t: seen.append((d, t)))
    assert seen, "on_progress never fired"
    last = seen[-1]
    assert last[0] == last[1]                                # the final tick reports 100 %
    # pypdl's reported `size` is the true size ∓1 byte (a producer quirk: its zero-init
    # Size(0,0).value == 1). Cosmetically irrelevant on a multi-GB bar — and acquire_model
    # substitutes the TRUE HF total anyway (it ignores pypdl's `total` arg), so this never
    # reaches the model-download UI.
    assert abs(last[1] - len(PAYLOAD)) <= 1
    assert all(abs(t - len(PAYLOAD)) <= 1 for _d, t in seen)


# ── single-stream fallback when the server has no Range support ────────────────

def test_falls_back_without_range_support(server, tmp_path):
    server.ranges_enabled = False
    stream_download(_url(server), tmp_path / "f.bin", segments=4, poll_interval=0.02)
    assert (tmp_path / "f.bin").read_bytes() == PAYLOAD       # correct bytes via the single stream


def test_segments_one_is_single_stream(server, tmp_path):
    stream_download(_url(server), tmp_path / "one.bin", segments=1, poll_interval=0.02)
    assert (tmp_path / "one.bin").read_bytes() == PAYLOAD
    assert _range_gets(server) == []                          # no multi-range fetch


# ── the unlink-first guard (BUG-A): a stale dest is NOT blessed as done ─────────

def test_unlink_first_overwrites_stale_dest(server, tmp_path):
    # A pre-existing dest must be REPLACED, never silently accepted. stream_download unlinks
    # dest first AND passes task-level overwrite=True (pypdl's dest-exists bless at
    # consumer.py:100 would otherwise accept a corrupt/partial leftover — including one its
    # own failed single-stream try just wrote; part-file resume is progress-file-governed
    # and unaffected, see test_resume_after_cancel).
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
    server.chunk_delay = 0.03                                 # stretch the transfer so cancel lands mid-flight
    threshold = len(PAYLOAD) // 8                             # cancel once ~12 % has been served

    with pytest.raises(DownloadCancelled):
        stream_download(_url(server), dest, segments=4, poll_interval=0.01,
                        cancel_check=lambda: server.bytes_served >= threshold)

    # The cancel left the multisegment progress file on disk (combine_files, which deletes it,
    # only runs on success), and some bytes were served — so the second run has state to resume.
    assert (tmp_path / "r.bin.json").exists()
    assert not dest.exists()                                  # no final file yet
    assert server.bytes_served > 0

    # Second run resumes: the part-files carry over, so the server serves the REMAINDER only.
    server.chunk_delay = 0.0
    with server.lock:
        server.bytes_served = 0
        server.requests = []
    stream_download(_url(server), dest, segments=4, poll_interval=0.01)
    assert dest.read_bytes() == PAYLOAD                       # correct final bytes
    assert server.bytes_served < len(PAYLOAD)                 # resumed → fewer bytes than a full fetch


# ── the DEGRADE LADDER: a blocked multisegment self-heals down to one stream ───

def test_ladder_degrades_to_single_stream_and_completes(server, tmp_path, caplog):
    # The origin kills every range GET whose end is the file end (the LAST segment of any
    # multisegment split) — pypdl exhausts its retries and fails the attempt. The ladder
    # steps 4 → 2 → 1; the plain single stream (no Range header) succeeds. This is the
    # pypdl gap the ladder closes: pypdl itself would hard-fail the file. Asserted on the
    # ADAPTER's contract (bytes + the degrade sequence it logs + the final plain GET) —
    # NOT on pypdl-internal request strings, which vary with a benign cancel/resume race
    # (a gather-cancelled segment resumes at an offset on the rung's retry).
    server.always_fail_ends = {len(PAYLOAD) - 1}
    dest = tmp_path / "d.bin"
    with caplog.at_level("WARNING", logger="llm_runner.runner.download"):
        stream_download(_url(server), dest, segments=4, retries=1, poll_interval=0.02)
    assert dest.read_bytes() == PAYLOAD                        # completed despite the blocks
    assert None in server.requests                             # the final, plain (rangeless) GET
    degrades = [r.message for r in caplog.records if "degraded to" in r.message]
    assert [m.split()[3] for m in degrades] == ["2", "1"]      # the ladder walked 4 → 2 → 1
    # No part-file/progress litter — the honest contract: a Windows lock that outlives
    # even the post-success sweep MAY leave one part-file, but then the adapter LOGGED
    # that exact straggler ("still locked"); anything unlogged is a real cleanup bug.
    assert not (tmp_path / "d.bin.json").exists()              # the progress file always clears
    stuck = [r.message for r in caplog.records if "still locked" in r.message]
    for leftover in tmp_path.glob("d.bin.*"):
        assert any(leftover.name in m for m in stuck), f"unlogged litter: {leftover}"


# ── a genuine failure (the whole ladder exhausted) → RuntimeError, not Cancelled ─

def test_failure_after_retries_raises_runtimeerror(server, tmp_path):
    # EVERY path dies mid-body: the last multisegment range at each rung AND the plain
    # single stream. The ladder degrades 4 → 2 → 1, the single stream fails too, and only
    # then does stream_download raise RuntimeError (never DownloadCancelled — that is
    # reserved for the user-cancel path).
    server.always_fail_ends = {len(PAYLOAD) - 1}
    server.always_fail_plain = True
    with pytest.raises(RuntimeError) as exc:
        stream_download(_url(server), tmp_path / "x.bin", segments=4, retries=1, poll_interval=0.02)
    assert not isinstance(exc.value, DownloadCancelled)
    assert None in server.requests                             # the ladder DID reach the single stream


# ── download_kwargs — the new {segments, retries} shape + the clamps ───────────

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
    assert kw["segments"] == MAX_DOWNLOAD_SEGMENT_COUNT             # 200 → the ceiling, not 200 range requests
    assert kw["retries"] == MAX_DOWNLOAD_SEGMENT_RETRIES
    assert "segment_min_bytes" not in kw                           # the retired knob leaks nowhere
    under = SimpleNamespace(download_segments_enabled=True, download_segment_count=0,
                            download_segment_retries=-5)
    kw2 = download_kwargs(under)
    assert kw2["segments"] == 1 and kw2["retries"] == 0            # floor: at least a single stream, no negative retries
