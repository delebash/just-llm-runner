# SPDX-License-Identifier: MIT
"""The family's bearer-auth policy (`llm_runner.platform.auth`).

What these pin: no tokens → open; tokens → loopback open unless "require a
token even on localhost"; the lockout escape (health and the server-auth door
answer from the machine itself); and an app's own `loopback_open_paths`
(2026-09-30 — JustVoice's `/v1/shutdown`, so its shell can close the server
with that setting on), which stay gated from anywhere else.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from llm_runner.platform.auth import BearerAuthMiddleware

LOCAL = ("127.0.0.1", 50000)
REMOTE = ("192.0.2.10", 50000)


def _client(tokens, require_for_loopback, where, **kw):
    app = FastAPI()
    for path in ("/v1/health", "/v1/server-auth", "/v1/shutdown", "/v1/things"):
        app.add_api_route(path, lambda: {"ok": True}, methods=["GET", "POST"])
    app.add_middleware(BearerAuthMiddleware, read_auth=lambda: (tokens, require_for_loopback),
                       type_base="https://example.test/errors/", **kw)
    return TestClient(app, client=where)


def test_no_tokens_means_no_auth():
    assert _client([], True, REMOTE).get("/v1/things").status_code == 200


def test_loopback_passes_unless_a_token_is_required_there_too():
    assert _client(["t"], False, LOCAL).get("/v1/things").status_code == 200
    assert _client(["t"], True, LOCAL).get("/v1/things").status_code == 401
    ok = _client(["t"], True, LOCAL).get("/v1/things", headers={"Authorization": "Bearer t"})
    assert ok.status_code == 200
    bad = _client(["t"], True, LOCAL).get("/v1/things", headers={"Authorization": "Bearer x"})
    assert bad.status_code == 403


def test_the_lockout_escape_answers_from_the_machine_only():
    for path in ("/v1/health", "/v1/server-auth"):
        assert _client(["t"], True, LOCAL).get(path).status_code == 200
        assert _client(["t"], True, REMOTE).get(path).status_code == 401


@pytest.mark.parametrize("where, status", [(LOCAL, 200), (REMOTE, 401)])
def test_an_apps_own_open_paths_answer_from_the_machine_only(where, status):
    c = _client(["t"], True, where, loopback_open_paths=("/v1/shutdown",))
    assert c.post("/v1/shutdown").status_code == status
    assert c.get("/v1/things").status_code == 401            # nothing else opened


def test_an_app_that_names_no_paths_is_unchanged():
    assert _client(["t"], True, LOCAL).post("/v1/shutdown").status_code == 401
