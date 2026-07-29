# SPDX-License-Identifier: MIT
"""Shared test doubles for the official-SDK adapters (#15 C2/C3/C4). ONE kwargs-capture
base + ONE fixture loader, so each per-SDK fake (gemini / openai / anthropic) is a thin
subclass rather than a third inline pattern (C2.4 reuse consolidation)."""

from __future__ import annotations

import json
import os

_FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")


def load_fixture(name: str):
    """Load a committed live-proof capture, e.g.
    ``load_fixture("gemini-sdk/chat-create.json")`` — the real 2026-07-17 API shapes."""
    with open(os.path.join(_FIXTURES, *name.split("/")), encoding="utf-8") as f:
        return json.load(f)


class KwargsCapture:
    """A fake SDK surface that records the kwargs of its last call into ``self.last``.
    Subclass and give it the SDK-shaped method(s), each stashing kwargs via ``_capture``."""

    def __init__(self) -> None:
        self.last: dict = {}

    def _capture(self, **kwargs):
        self.last = kwargs
        return kwargs
