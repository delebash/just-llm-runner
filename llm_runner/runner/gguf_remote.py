# SPDX-License-Identifier: GPL-3.0-or-later
"""Read a model's GGUF metadata from its HuggingFace link, BEFORE downloading
the multi-GB weights (Phase 1, `docs/plans/2026-07-02-gguf-grounded-model-layer.md`).

`fetch_gguf_meta(repo, quant)` resolves the model's `.gguf` shard(s) via the HF
Hub API (reusing `models.select_files`), range-reads just the first few MB of the
metadata shard, and parses it with the SAME parser the local path uses
(`gguf.read_gguf_metadata_from_stream`) — one parser, local + remote, NO new
dependency (plain `requests` + the auth-free HF Hub HTTP API). Returns the parsed
`GgufMeta` plus the real total weight size (summed shard sizes) for the fit
estimate.
"""

from __future__ import annotations

import logging
from io import BytesIO

import requests

from .gguf import GgufMeta, read_gguf_metadata_from_stream
from .models import _HF_BASE, _entry_size, select_files

log = logging.getLogger(__name__)

# The KV header (arch/general/sampling + tokenizer token & merge arrays) sits at
# the FRONT of the file. 24 MB covers a large-vocab model's header comfortably
# (Qwen3.6 ~248k-token vocab + GLM-4.5-Air both parsed within 16 MB, verified
# 2026-07-03); a rare bigger header triggers the one 4x retry below.
_HEADER_BYTES = 24 * 1024 * 1024
_TIMEOUT = 60


def _range_read(url: str, n: int, timeout: int = _TIMEOUT) -> bytes:
    """GET at most the first `n` bytes of `url` via an HTTP Range request.

    Streams and stops after `n` bytes, so even if the CDN ignores the Range
    header we never pull the whole multi-GB file. Follows the HF resolve→CDN
    redirect (requests default)."""
    with requests.get(
        url, headers={"Range": f"bytes=0-{n - 1}"}, timeout=timeout, stream=True
    ) as r:
        r.raise_for_status()
        buf = bytearray()
        for chunk in r.iter_content(chunk_size=1 << 20):
            buf += chunk
            if len(buf) >= n:
                break
    return bytes(buf[:n])


def fetch_gguf_meta(
    repo: str, quant: str, revision: str = "main", header_bytes: int = _HEADER_BYTES
) -> tuple[GgufMeta, int]:
    """Resolve the `.gguf` for `quant` in HF `repo`, range-read its header, and
    return `(GgufMeta, total_weight_bytes)`.

    For a split model the metadata lives in shard `00001`; `total_weight_bytes`
    is the summed size of every matching shard (the real on-disk model size,
    fed to `fit.py`). Raises `FileNotFoundError` (no shard matches `quant`),
    `requests` errors (network), or `ValueError` (not a GGUF)."""
    _commit_sha, entries = select_files(repo, quant, None, revision)
    total = sum(_entry_size(e) for e in entries)
    main = next((e for e in entries if "00001" in e["path"]), entries[0])
    url = f"{_HF_BASE}/{repo}/resolve/{revision}/{main['path']}"

    raw = _range_read(url, header_bytes)
    try:
        meta = read_gguf_metadata_from_stream(BytesIO(raw))
    except ValueError as e:
        if "truncated" not in str(e):
            raise
        log.info("gguf header exceeded %d bytes for %s — retrying 4x", header_bytes, repo)
        raw = _range_read(url, header_bytes * 4)
        meta = read_gguf_metadata_from_stream(BytesIO(raw))
    return meta, total
