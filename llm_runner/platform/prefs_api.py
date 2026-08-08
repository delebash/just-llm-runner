# SPDX-License-Identifier: MIT
"""Shared /v1/prefs router — the renderer's preferences document, one wire for
every same-stack app (the family settings/prefs split: `/v1/settings` is typed
operator/server config, `/v1/prefs` is the renderer's own key/value document).

The semantics are JustVoice's donor contract, verbatim:
- GET    returns the WHOLE document (`{key: value}`, values are real JSON).
- PATCH  is a **wholesale per-key** upsert, NOT a deep merge — a map/list entry
  is removed by sending the smaller value (a deep merge cannot express a
  deletion). Returns the merged document.
- DELETE clears the document (factory reset), 204.

Storage is a host seam (the `make_data_router` pattern): the router speaks
DECODED values; the host decides where and how they persist —
- JustVoice: its `prefs` table (per-row JSON in the app DB),
- JustWrite: its `settings` rows (the renderer document it already serves,
  mapped onto the family door; its clear preserves the D3b folder-path keys),
- docgen: `pref.*` rows in its `app_settings` table (riding `app.db`, so the
  shared /v1/data backup/restore/reset covers them).

Hooks are plain sync callables (each host opens its own session/file inside),
so this module needs nothing beyond FastAPI — safe for the lazy platform
`__init__` on SQLAlchemy-free hosts.
"""

from __future__ import annotations

from typing import Any, Callable

from fastapi import APIRouter, Response


def make_prefs_router(
    *,
    read_all: Callable[[], dict[str, Any]],
    write_many: Callable[[dict[str, Any]], None],
    clear: Callable[[], None],
    prefix: str = "/v1/prefs",
) -> APIRouter:
    """Build the shared renderer-prefs router over host storage hooks.

    - `read_all()`   → the whole document as decoded values.
    - `write_many(patch)` → upsert every given key wholesale.
    - `clear()`      → drop the document (the host may exempt keys it must keep,
      e.g. JustWrite's folder-path config).
    """
    router = APIRouter(tags=["prefs"])

    @router.get(prefix, summary="The full renderer-prefs document")
    async def get_prefs() -> dict:
        return read_all()

    @router.patch(prefix, summary="Upsert the given prefs (wholesale per key); returns the merged document")
    async def patch_prefs(patch: dict[str, Any]) -> dict:
        write_many(patch)
        return read_all()

    @router.delete(prefix, status_code=204, summary="Clear all renderer prefs (factory reset)")
    async def clear_prefs() -> Response:
        clear()
        return Response(status_code=204)

    return router
