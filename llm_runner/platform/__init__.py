# SPDX-License-Identifier: MIT
"""Shared platform (non-AI) server building blocks for same-stack apps.

`llm_runner` is the shared backend kit both apps already depend on; this
subpackage holds the stack-level, app-agnostic server pieces (data
backup/restore/reset, …) behind host-supplied hooks — same router-factory
pattern as `llm_runner.llm.*`. See the consuming app's
docs/plans/2026-06-24-shared-platform-settings.md.

LAZY FOR THE SAME REASON AS `llm/__init__.py` (2026-08-01). Of the router modules here only
`data_api` needs SQLAlchemy — it reflects the host's tables to back up and restore them.
`disk_api`, `logs_api` and `prefs_api` are SQLAlchemy-free (prefs storage is a host hook).
Because this file once imported everything eagerly, a host with no SQLAlchemy could not
reach the log ring or the disk-usage router either: the clean-venv audit recorded
`llm_runner.platform` failing outright with `ModuleNotFoundError: No module named
'sqlalchemy'`, for routers that never needed it.
"""

from __future__ import annotations

import importlib

_EXPORTS = {
    "make_data_router": "data_api",   # the SQLAlchemy one — reflects host tables
    "make_disk_router": "disk_api",
    "make_logs_router": "logs_api",
    # P9 (target-tree, 2026-08-08): the family /v1/prefs door — renderer
    # document semantics once, storage a host hook.
    "make_prefs_router": "prefs_api",
    "install_log_ring": "logs_api",
    "install_file_log": "logs_api",
    # P2 (target-tree, 2026-08-08): the server-infra trio — one policy each,
    # per-app copies died. Apps wire these in app.py; route files import the
    # error HELPERS via their app's one-line alias module (see
    # docs/target-tree.md "Alias registry").
    "BearerAuthMiddleware": "auth",
    "CsrfOriginMiddleware": "csrf",
    "install_error_handlers": "errors",
    "ApiError": "errors",
    # The family data-location policy (user ruling 2026-08-14): every app's
    # paths.py is a thin call into this — never a re-implementation.
    "resolve_data_dir": "data_paths",
    "install_dir": "data_paths",
}

__all__ = sorted(_EXPORTS)


def __getattr__(name: str):
    """PEP 562 — resolve an export to its module on first access, then cache it."""
    module = _EXPORTS.get(name)
    if module is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    value = getattr(importlib.import_module(f".{module}", __name__), name)
    globals()[name] = value
    return value


def __dir__() -> list[str]:
    return sorted(__all__)
