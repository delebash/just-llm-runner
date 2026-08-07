# SPDX-License-Identifier: MIT
"""Bearer-token authentication middleware — THE family implementation.

One policy for every same-stack app (P2 of the target tree, 2026-08-08; the
three per-app copies died — the 2026-08-05 lockout fix had to be hand-applied
three times, which is the cost this consolidation ends). OFF by default: an
empty token list means no auth (the normal local-loopback case). Policy:
  - no tokens                                    → no auth required
  - tokens + loopback + not require_for_loopback → loopback bypasses auth
  - otherwise                                    → every /v1/* request needs
                                                   `Authorization: Bearer <token>`

The per-app seam is `read_auth` — a callable returning
`(tokens, require_for_loopback)` from wherever that app stores settings
(JW: settings rows · JV: its SettingsStore · docgen: appmeta). It must never
raise for config problems (return `([], False)` instead) so a settings glitch
can't lock the user out.

The lockout escape (family shape, 2026-08-05): from the machine itself,
`/v1/health` and the `/v1/server-auth` door always answer — physical access
could edit the DB anyway. Remote stays gated.
"""

from __future__ import annotations

import ipaddress

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware


def _is_loopback(host: str) -> bool:
    if host in ("127.0.0.1", "::1", "localhost"):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


class BearerAuthMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, read_auth, type_base: str):
        super().__init__(app)
        self._read_auth = read_auth
        self._type_base = type_base

    def _problem(self, status: int, slug: str, title: str, detail: str, path: str) -> JSONResponse:
        return JSONResponse(
            status_code=status,
            content={
                "type": f"{self._type_base}{slug}",
                "title": title,
                "status": status,
                "detail": detail,
                "instance": path,
            },
            media_type="application/problem+json",
        )

    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        # Only gate the API. UI assets, docs, openapi, and the static mount
        # always pass (so the headless browser can load the app + log in).
        if not path.startswith("/v1"):
            return await call_next(request)

        tokens, require_for_loopback = self._read_auth()
        if not tokens:
            return await call_next(request)

        client_host = request.client.host if request.client else ""
        is_loop = _is_loopback(client_host)
        if is_loop and (path == "/v1/health" or path.startswith("/v1/server-auth")):
            return await call_next(request)
        if is_loop and not require_for_loopback:
            return await call_next(request)

        header = request.headers.get("authorization", "")
        if not header.startswith("Bearer "):
            return self._problem(401, "unauthorized", "Unauthorized",
                                 "Authorization header missing or malformed", path)
        token = header[len("Bearer "):].strip()
        if token not in tokens:
            return self._problem(403, "forbidden", "Forbidden",
                                 "Bearer token not accepted", path)
        return await call_next(request)
