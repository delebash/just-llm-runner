# SPDX-License-Identifier: GPL-3.0-or-later
"""Self-contained streaming download (binaries + GGUF) with progress + cancel.

Kept dependency-light (requests only) so the package has no coupling to
either app's internals — it must run standalone in JustWrite's sidecar.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Callable

import requests


class DownloadCancelled(Exception):
    """Raised when cancel_check() returns True mid-stream."""


def stream_download(
    url: str,
    dest: Path,
    on_progress: Callable[[int], None] | None = None,
    cancel_check: Callable[[], bool] | None = None,
    chunk_size: int = 1024 * 64,
) -> str:
    """Stream `url` into `dest`, returning the sha256 hex digest.

    Polls `cancel_check` every chunk (cancel within ~64 KB); throttles
    `on_progress` to ~once per MB. The partial file is left on disk for the
    caller to clean up on cancel.
    """
    h = hashlib.sha256()
    downloaded = 0
    progress_at = 0
    dest.parent.mkdir(parents=True, exist_ok=True)
    with requests.get(url, stream=True, timeout=600) as r:
        r.raise_for_status()
        with dest.open("wb") as f:
            for chunk in r.iter_content(chunk_size=chunk_size):
                if cancel_check is not None and cancel_check():
                    raise DownloadCancelled()
                if not chunk:
                    continue
                f.write(chunk)
                h.update(chunk)
                downloaded += len(chunk)
                if downloaded - progress_at >= 1024 * 1024:
                    if on_progress:
                        on_progress(downloaded)
                    progress_at = downloaded
    if on_progress:
        on_progress(downloaded)
    return h.hexdigest()
