# SPDX-License-Identifier: MIT
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


# ── generation_config.json fallback — the ORIGINAL model repo (from the GGUF
# header's `base_model.0.repo_url`) publishes the author-recommended samplers when
# the GGUF itself did not bake `general.sampling.*` in (GLM ships none, Qwen does).
# generation_config uses HF key names; we map to the llama.cpp namespace so header
# samplers and fallback samplers land as ONE key set. ───────────────────────────
_GEN_CFG_TO_LLAMA = {"temperature": "temp", "repetition_penalty": "penalty_repeat"}
_GEN_CFG_KEYS = ("temperature", "top_p", "top_k", "min_p", "typical_p", "repetition_penalty")


def _repo_from_url(url: str) -> str:
    """'https://huggingface.co/Qwen/Qwen3.6-27B' or 'Qwen/Qwen3.6-27B' -> 'Qwen/Qwen3.6-27B'."""
    u = (url or "").strip().rstrip("/")
    if u.startswith("http"):
        _, _, tail = u.partition("huggingface.co/")
        u = tail
    segs = [p for p in u.split("/") if p]
    return "/".join(segs[:2]) if len(segs) >= 2 else ""


def fetch_generation_config_samplers(base_repo_url: str, revision: str = "main") -> dict[str, float]:
    """Fetch `generation_config.json` from the origin repo and extract its sampler
    keys, mapped to llama.cpp names — the plan's header -> generation_config -> generic
    precedence for a model's recommended samplers. Best-effort: returns {} on any
    error (missing file, gated/404 repo, bad JSON), never raises into the caller."""
    repo = _repo_from_url(base_repo_url)
    if not repo:
        return {}
    url = f"{_HF_BASE}/{repo}/resolve/{revision}/generation_config.json"
    try:
        r = requests.get(url, timeout=_TIMEOUT)
        r.raise_for_status()
        cfg = r.json()
    except Exception:  # noqa: BLE001 — advisory fallback; never raise into the caller
        return {}
    out: dict[str, float] = {}
    for k in _GEN_CFG_KEYS:
        v = cfg.get(k) if isinstance(cfg, dict) else None
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            out[_GEN_CFG_TO_LLAMA.get(k, k)] = float(v)
    return out
