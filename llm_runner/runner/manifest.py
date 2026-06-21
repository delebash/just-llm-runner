# SPDX-License-Identifier: GPL-3.0-or-later
"""Loader for the bundled `runner-manifest.json`."""

from __future__ import annotations

import json
import threading
from pathlib import Path

from .schema import RunnerManifest

_MANIFEST_PATH = Path(__file__).resolve().parent / "runner-manifest.json"

_lock = threading.Lock()
_cached: RunnerManifest | None = None


def manifest_path() -> Path:
    return _MANIFEST_PATH


def load_manifest(refresh: bool = False) -> RunnerManifest:
    """Return the validated manifest. Cached unless refresh=True. A malformed
    manifest raises pydantic ValidationError (fail loud, not silent garbage)."""
    global _cached
    with _lock:
        if _cached is not None and not refresh:
            return _cached
        raw = json.loads(_MANIFEST_PATH.read_text(encoding="utf-8"))
        _cached = RunnerManifest.model_validate(raw)
        return _cached
