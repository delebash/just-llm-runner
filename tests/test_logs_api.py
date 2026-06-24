# SPDX-License-Identifier: GPL-3.0-or-later
"""make_logs_router — the in-memory ring feeds /v1/logs/tail + /download."""

import logging

from fastapi import FastAPI
from fastapi.testclient import TestClient

from llm_runner.platform import install_log_ring, make_logs_router


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
