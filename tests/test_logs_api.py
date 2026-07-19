# SPDX-License-Identifier: GPL-3.0-or-later
"""make_logs_router — the ring feeds /tail + /download; the per-day files feed
/days, /day, DELETE /day, DELETE /all; /clear empties the ring (Logs phase)."""

import logging
import re
from datetime import datetime

from fastapi import FastAPI
from fastapi.testclient import TestClient

from llm_runner.platform import install_file_log, install_log_ring, make_logs_router
from llm_runner.platform import logs_api


def _client():
    install_log_ring()
    app = FastAPI()
    app.include_router(make_logs_router("JustWrite"))
    return TestClient(app)


def test_tail_and_download_capture_log_lines():
    c = _client()
    logging.getLogger("test.logs").warning("hello-from-the-ring-42")
    tail = c.get("/v1/logs/tail?lines=50").json()
    assert "hello-from-the-ring-42" in tail["text"]
    assert tail["lines"] >= 1
    dl = c.get("/v1/logs/download")
    assert dl.status_code == 200
    assert "hello-from-the-ring-42" in dl.text
    assert "justwrite-logs-" in dl.headers.get("content-disposition", "")


_ISO_STAMP = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{3}) \[WARNING\] ")


def test_stamps_are_strict_iso_local_with_millis(tmp_path):
    """The stamp is strict ISO-8601 (`T` + `.mmm`) on BOTH sinks — the ring the UI
    tails and the day file on disk. Pinned because the UI localizes this stamp at
    render (logLines.js formatLogStamp) and JS `Date.parse` cannot read logging's
    default `2026-07-19 00:06:22,169` space+comma form: a silent revert to the
    default would leave every log line rendering unformatted."""
    c = _client()
    install_file_log(tmp_path / "logs" / "app.log")
    before = datetime.now()
    logging.getLogger("test.logs").warning("iso-stamp-probe")
    after = datetime.now()

    line = next(
        ln for ln in c.get("/v1/logs/tail?lines=50").json()["text"].splitlines()
        if "iso-stamp-probe" in ln
    )
    m = _ISO_STAMP.match(line)
    assert m, f"not a strict-ISO stamp: {line!r}"
    # LOCAL clock, not UTC: the parsed stamp sits inside the window the call was
    # made in. (On a UTC-configured box the two coincide and this is merely
    # not-false; on the user's Windows box a UTC stamp would miss by hours.)
    stamped = datetime.strptime(m.group(1), "%Y-%m-%dT%H:%M:%S")
    assert before.replace(microsecond=0) <= stamped <= after

    # the FILE carries the same grammar — the UI's day view parses it identically
    file_line = next(
        ln for ln in (tmp_path / "logs" / "app.log").read_text(encoding="utf-8").splitlines()
        if "iso-stamp-probe" in ln
    )
    assert _ISO_STAMP.match(file_line)


def test_clear_empties_the_ring_only(tmp_path):
    c = _client()
    install_file_log(tmp_path / "logs" / "app.log")
    logging.getLogger("test.logs").warning("before-clear-77")
    assert "before-clear-77" in c.get("/v1/logs/tail").json()["text"]
    r = c.post("/v1/logs/clear").json()
    assert r["lines"] == 0
    assert c.get("/v1/logs/tail").json()["text"] == ""
    # the stored file is UNTOUCHED by clear (clear = the on-screen tail only)
    assert "before-clear-77" in (tmp_path / "logs" / "app.log").read_text(encoding="utf-8")


def test_per_day_storage_and_days_listing(tmp_path):
    c = _client()
    path = install_file_log(tmp_path / "logs" / "app.log")
    assert path is not None
    # the handler IS the per-day rotator with the dated-suffix convention the
    # listing relies on — pinned so a stdlib change can't silently break /days
    assert logs_api._file_handler.when.upper() == "MIDNIGHT"
    assert logs_api._file_handler.suffix == "%Y-%m-%d"
    logging.getLogger("test.logs").warning("today-line-11")
    # two PAST days, exactly as TimedRotatingFileHandler names them
    (tmp_path / "logs" / "app.log.2026-07-03").write_text("old3\n", encoding="utf-8")
    (tmp_path / "logs" / "app.log.2026-07-04").write_text("old4\n", encoding="utf-8")
    days = c.get("/v1/logs/days").json()["days"]
    assert [d["day"] for d in days][1:] == ["2026-07-04", "2026-07-03"]  # newest first after live
    assert days[0]["live"] is True and days[1]["live"] is False
    # a stored day's CONTENT comes from its file
    d4 = c.get("/v1/logs/day", params={"date": "2026-07-04"}).json()
    assert d4["text"] == "old4"
    # the live day reads the base FILE (fuller than the 500-line ring)
    live = c.get("/v1/logs/day", params={"date": days[0]["day"]}).json()
    assert "today-line-11" in live["text"]


def test_day_validation_and_missing_404(tmp_path):
    c = _client()
    install_file_log(tmp_path / "logs" / "app.log")
    assert c.get("/v1/logs/day", params={"date": "../etc/passwd"}).status_code == 400
    assert c.get("/v1/logs/day", params={"date": "1999-01-01"}).status_code == 404


def test_delete_past_day_unlinks_and_today_truncates(tmp_path):
    c = _client()
    install_file_log(tmp_path / "logs" / "app.log")
    logging.getLogger("test.logs").warning("live-line-before-delete")
    old = tmp_path / "logs" / "app.log.2026-07-02"
    old.write_text("old2\n", encoding="utf-8")
    # past day → plain unlink
    days = c.delete("/v1/logs/day", params={"date": "2026-07-02"}).json()["days"]
    assert not old.exists()
    assert all(d["day"] != "2026-07-02" for d in days)
    # TODAY → truncate (the handler holds the file open — Windows-safe), and
    # logging KEEPS WORKING through the reopened stream afterwards
    today = next(d["day"] for d in days if d["live"])
    c.delete("/v1/logs/day", params={"date": today})
    assert (tmp_path / "logs" / "app.log").read_text(encoding="utf-8") == ""
    logging.getLogger("test.logs").warning("live-line-after-truncate")
    assert "live-line-after-truncate" in (tmp_path / "logs" / "app.log").read_text(encoding="utf-8")


def test_delete_all_removes_files_and_clears_ring(tmp_path):
    c = _client()
    install_file_log(tmp_path / "logs" / "app.log")
    logging.getLogger("test.logs").warning("doomed-line")
    (tmp_path / "logs" / "app.log.2026-07-01").write_text("old1\n", encoding="utf-8")
    days = c.delete("/v1/logs/all").json()["days"]
    assert not (tmp_path / "logs" / "app.log.2026-07-01").exists()
    assert (tmp_path / "logs" / "app.log").read_text(encoding="utf-8") == ""
    assert c.get("/v1/logs/tail").json()["text"] == ""          # ring cleared too
    assert all(d["live"] or False for d in days) or days == []  # only the (empty) live day may remain
