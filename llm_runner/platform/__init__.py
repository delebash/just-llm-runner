# SPDX-License-Identifier: MIT
"""Shared platform (non-AI) server building blocks for same-stack apps.

`llm_runner` is the shared backend kit both apps already depend on; this
subpackage holds the stack-level, app-agnostic server pieces (data
backup/restore/reset, …) behind host-supplied hooks — same router-factory
pattern as `llm_runner.llm.*`. See the consuming app's
docs/plans/2026-06-24-shared-platform-settings.md.
"""

from .data_api import make_data_router
from .disk_api import make_disk_router
from .logs_api import install_file_log, install_log_ring, make_logs_router

__all__ = [
    "make_data_router",
    "make_disk_router",
    "make_logs_router",
    "install_log_ring",
    "install_file_log",
]
