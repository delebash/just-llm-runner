# SPDX-License-Identifier: MIT
"""The RFC 7807 problem envelope (llm_runner.platform.errors): an ApiError's `extra`
members ride in the problem body — so a client can act on WHICH refusal it got (JustVoice's
Pocket TTS terms prompt, 2026-10-02) — and never override the standard members."""

from fastapi import FastAPI
from fastapi.testclient import TestClient

from llm_runner.platform.errors import ApiError, bad_request, install_error_handlers


def _client(exc):
    app = FastAPI()
    install_error_handlers(app, type_base="https://example.test/errors/")

    @app.get("/boom")
    async def boom():
        raise exc

    return TestClient(app, raise_server_exceptions=False)


def test_extra_members_ride_in_the_problem_body():
    r = _client(ApiError(403, "terms-required", "Terms not accepted", "accept them first",
                         extra={"engine": "pocket"})).get("/boom")
    assert r.status_code == 403
    body = r.json()
    assert body["type"] == "https://example.test/errors/terms-required"
    assert body["detail"] == "accept them first" and body["engine"] == "pocket"


def test_extra_never_overrides_a_standard_member():
    r = _client(ApiError(403, "terms-required", "Terms not accepted", "real detail",
                         extra={"detail": "spoofed", "status": 200})).get("/boom")
    assert r.json()["detail"] == "real detail" and r.json()["status"] == 403


def test_a_plain_error_has_no_extras():
    body = _client(bad_request("nope")).get("/boom").json()
    assert set(body) == {"type", "title", "status", "detail", "instance"}
