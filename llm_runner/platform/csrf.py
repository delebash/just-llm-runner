# SPDX-License-Identifier: MIT
"""CSRF hardening — reject cross-site browser requests to the mutating API.

THE family implementation (P2 of the target tree, 2026-08-08 — the three
per-app copies died the day after they were born; JustWrite's original is the
donor, and its docstring recorded the user's deciding factor: "prefer not
locking anyone out, do the vector directly"). The servers are localhost
sidecars; the real CSRF threat is a page in the user's OTHER browser tab
POSTing to 127.0.0.1:<port>. A MUTATING `/v1` request whose `Origin` marks it
cross-site is rejected UNLESS the origin is the app's own. No token, so it can
never lock a user out; the only failure mode is a missing app origin blocking
the app itself — which each app's smoke catches immediately.

Allowed: no `Origin` (non-browser clients + the Tauri HTTP-plugin path) ·
SAME-ORIGIN, derived per-request from the URL (the server-hosted UI — browsers
DO send Origin on same-origin mutations; JW hit that 2026-07-15) · the shared
Tauri origins + the app's own `app_origins` (its dev server) ·
`extra_origins`/`origin_regex` (an app's CORS allowlist, reused — ONE
allowlist, never a second list) · any non-mutating method.
Rejected: everything else, 403 problem+json.
"""

from __future__ import annotations

import re

from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

# The packaged Tauri webview origins — identical for every app in the family.
# (A webview that routes through the Tauri HTTP plugin sends no Origin at all;
# one that fetches directly — docgen — sends these.)
TAURI_ORIGINS = frozenset({
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
})

_MUTATING = frozenset({"POST", "PUT", "PATCH", "DELETE"})


class CsrfOriginMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, app_origins=(), extra_origins=(), origin_regex: str = "",
                 type_base: str = ""):
        super().__init__(app)
        self._allow = (
            TAURI_ORIGINS
            | frozenset(o for o in (app_origins or ()) if o)
            | frozenset(o for o in (extra_origins or ()) if o)
        )
        self._regex = re.compile(origin_regex) if origin_regex else None
        self._type_base = type_base

    def _same_origin(self, request) -> str:
        """The server's OWN origin for this request (scheme://host[:port]) — a
        page we served ourselves. Read from the URL so it follows whatever
        host/port the server actually runs on."""
        return f"{request.url.scheme}://{request.url.netloc}"

    def _allowed(self, request, origin: str) -> bool:
        if origin in self._allow or origin == self._same_origin(request):
            return True
        return bool(self._regex and self._regex.match(origin))

    async def dispatch(self, request, call_next):
        if request.method in _MUTATING and request.url.path.startswith("/v1"):
            origin = request.headers.get("origin")
            if origin and not self._allowed(request, origin):
                return JSONResponse(
                    status_code=403,
                    content={
                        "type": f"{self._type_base}cross-origin",
                        "title": "Forbidden",
                        "status": 403,
                        "detail": "cross-origin request rejected",
                        "instance": request.url.path,
                    },
                    media_type="application/problem+json",
                )
        return await call_next(request)
