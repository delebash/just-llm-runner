# SPDX-License-Identifier: MIT
"""RFC 7807 problem-details error envelope — THE family implementation.

One implementation for every same-stack app (P2 of the target tree,
2026-08-08). JustWrite's errors.py was the donor — it carried the two
improvements the siblings never got: `_log_error` (every handled error
reaches the log, level scaled to status — a rejected write used to leave
ZERO server trace, 2026-07-17) and the 422 validation handler (FastAPI's
default returns those unlogged).

Each app keeps a one-line alias module (`<app>/errors.py`) re-exporting
this one, so its route files' `from ..errors import not_found` imports
keep working against the single implementation — an alias, not a copy:
there is no logic in the app file to drift. The only per-app datum is the
problem-type URL base, closed over by `install_error_handlers`.
"""

from __future__ import annotations

import logging

from fastapi import HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

log = logging.getLogger(__name__)


def _log_error(request: Request, status: int, detail: object) -> None:
    """Every handled error reaches the log — the level scaled to the status so a
    routine 404 doesn't shout and a 500 isn't buried. 4xx = WARNING (client's
    fault, still worth seeing), 5xx = ERROR."""
    lvl = logging.ERROR if status >= 500 else logging.WARNING
    log.log(lvl, "%s %s -> %d: %s", request.method, request.url.path, status, str(detail)[:500])


class ApiError(HTTPException):
    """HTTPException variant that carries the slug + title for the RFC 7807 type uri."""

    def __init__(self, status_code: int, slug: str, title: str, detail: str):
        super().__init__(status_code=status_code, detail=detail)
        self.slug = slug
        self.title = title


def bad_request(detail: str) -> ApiError:
    return ApiError(400, "bad-request", "Bad Request", detail)


def unauthorized(detail: str = "Authentication required") -> ApiError:
    return ApiError(401, "unauthorized", "Unauthorized", detail)


def forbidden(detail: str = "Token not accepted") -> ApiError:
    return ApiError(403, "forbidden", "Forbidden", detail)


def not_found(detail: str) -> ApiError:
    return ApiError(404, "not-found", "Not Found", detail)


def conflict(detail: str) -> ApiError:
    return ApiError(409, "conflict", "Conflict", detail)


def not_implemented(detail: str) -> ApiError:
    return ApiError(501, "not-implemented", "Not Implemented", detail)


def service_unavailable(detail: str) -> ApiError:
    return ApiError(503, "service-unavailable", "Service Unavailable", detail)


def internal(detail: str = "An internal error occurred. See server logs for details.") -> ApiError:
    return ApiError(500, "internal", "Internal Server Error", detail)


def _jsonable_errors(errors: list) -> list:
    """RequestValidationError.errors() can carry a non-JSON `ctx` (e.g. a raw
    exception) — keep only the JSON-safe fields so JSONResponse never 500s while
    reporting a 422."""
    out = []
    for e in errors or []:
        out.append({
            "loc": [str(p) for p in (e.get("loc") or [])],
            "msg": str(e.get("msg") or ""),
            "type": str(e.get("type") or ""),
        })
    return out


_HTTP_SLUGS = {
    404: ("not-found", "Not Found"),
    400: ("bad-request", "Bad Request"),
    401: ("unauthorized", "Unauthorized"),
    403: ("forbidden", "Forbidden"),
    422: ("validation-error", "Validation Error"),
}


def install_error_handlers(app, *, type_base: str) -> None:
    """Register the three problem+json handlers on `app`.

    `type_base` is the app's problem-type URL prefix
    (e.g. "https://justwrite.dev/errors/") — the ONLY per-app datum.
    """

    async def api_exception_handler(request: Request, exc: ApiError):
        _log_error(request, exc.status_code, exc.detail)
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "type": f"{type_base}{exc.slug}",
                "title": exc.title,
                "status": exc.status_code,
                "detail": exc.detail,
                "instance": request.url.path,
            },
            media_type="application/problem+json",
        )

    async def http_exception_handler(request: Request, exc: HTTPException):
        # Plain HTTPException (without our slug) — synthesize a reasonable one.
        slug, title = _HTTP_SLUGS.get(exc.status_code, ("error", "Error"))
        _log_error(request, exc.status_code, exc.detail)
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "type": f"{type_base}{slug}",
                "title": title,
                "status": exc.status_code,
                "detail": str(exc.detail),
                "instance": request.url.path,
            },
            media_type="application/problem+json",
        )

    async def validation_exception_handler(request: Request, exc: RequestValidationError):
        """422 request-validation failures. FastAPI's DEFAULT handler returns
        these WITHOUT logging — the exact silent-failure that made a rejected
        write untraceable (2026-07-17). Logged like any 4xx, same problem+json
        shape, JSON-safe `errors` detail."""
        errors = exc.errors()
        _log_error(request, 422, errors)
        return JSONResponse(
            status_code=422,
            content={
                "type": f"{type_base}validation-error",
                "title": "Validation Error",
                "status": 422,
                "detail": "Request body failed validation.",
                "errors": _jsonable_errors(errors),
                "instance": request.url.path,
            },
            media_type="application/problem+json",
        )

    app.add_exception_handler(ApiError, api_exception_handler)
    app.add_exception_handler(HTTPException, http_exception_handler)
    app.add_exception_handler(RequestValidationError, validation_exception_handler)
