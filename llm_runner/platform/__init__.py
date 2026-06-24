# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared platform (non-AI) server building blocks for same-stack apps.

`llm_runner` is the shared backend kit both apps already depend on; this
subpackage holds the stack-level, app-agnostic server pieces (data
backup/restore/reset, …) behind host-supplied hooks — same router-factory
pattern as `llm_runner.llm.*`. See the consuming app's
docs/plans/2026-06-24-shared-platform-settings.md.
"""

from .data_api import make_data_router

__all__ = ["make_data_router"]
