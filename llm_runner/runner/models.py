# SPDX-License-Identifier: GPL-3.0-or-later
"""P1.3 — GGUF model acquisition from HuggingFace.

Resolves the real GGUF filename(s) for a model by matching its `quant`
against the repo's HF tree (no hardcoded/fabricated filenames), then streams
them into the canonical HF cache layout so llama.cpp finds them via the
standard cache resolver. Self-contained (own download + cache-root
resolution) so it runs in JustWrite's sidecar with no app coupling.

Ported from JustVoice's `installer._hf_snapshot_to` (the huggingface_hub-dep
rip) — same auth-free HF Hub HTTP API, narrowed to specific files by quant.

HF Hub API (no auth for public repos):
    GET /api/models/{repo}/revision/{rev}            -> commit sha
    GET /api/models/{repo}/tree/{rev}?recursive=true -> file listing
    GET /{repo}/resolve/{rev}/{path}                 -> file bytes

Cache layout written (matches huggingface_hub so its resolver finds files):
    <hf_cache>/models--<owner>--<name>/
      refs/<rev>             text: commit_sha
      blobs/<oid>            actual file (one blob per file)
      snapshots/<sha>/<path> symlink -> ../../blobs/<oid> (copy fallback)
The `oid` is the LFS sha256 for weights (most GGUFs) or the git blob oid for
small files; either is what the standard cache probe expects.
"""

from __future__ import annotations

import logging
import os
import shutil
from pathlib import Path
from typing import Callable

import requests

from .download import DownloadCancelled, stream_download

log = logging.getLogger(__name__)

_HF_BASE = "https://huggingface.co"
_API_TIMEOUT = 30


def hf_cache_root() -> Path:
    """HF hub cache root, matching huggingface_hub's resolution order
    (HF_HUB_CACHE -> $HF_HOME/hub -> ~/.cache/huggingface/hub) without
    importing the library."""
    env = os.environ.get("HF_HUB_CACHE")
    if env:
        return Path(env)
    home = os.environ.get("HF_HOME")
    if home:
        return Path(home) / "hub"
    return Path.home() / ".cache" / "huggingface" / "hub"


def _revision_sha(repo: str, revision: str) -> str:
    r = requests.get(f"{_HF_BASE}/api/models/{repo}/revision/{revision}", timeout=_API_TIMEOUT)
    r.raise_for_status()
    return r.json()["sha"]


def _tree(repo: str, revision: str) -> list[dict]:
    r = requests.get(
        f"{_HF_BASE}/api/models/{repo}/tree/{revision}",
        params={"recursive": "true"},
        timeout=_API_TIMEOUT,
    )
    r.raise_for_status()
    return [e for e in r.json() if e.get("type") == "file"]


def _entry_size(entry: dict) -> int:
    """True byte size — LFS files expose it via .lfs.size, others via .size."""
    return int((entry.get("lfs") or {}).get("size") or entry.get("size") or 0)


def _entry_oid(entry: dict) -> str:
    """Blob id — the LFS sha256 (weights) if present, else the git blob oid."""
    return (entry.get("lfs") or {}).get("oid") or entry["oid"]


def select_files(
    repo: str, quant: str, mmproj: str | None = None, revision: str = "main"
) -> tuple[str, list[dict]]:
    """Resolve (commit_sha, [tree entries]) for the GGUF file(s) of `quant`.

    Matches `*.gguf` whose path contains `quant` (case-insensitive) — this
    naturally grabs every shard of a split model (`…-00001-of-00003.gguf`).
    If `mmproj` is set, also include `*.gguf` whose path contains it (the
    multimodal-projector sidecar some MoE GGUFs require even for text). Raises
    FileNotFoundError when nothing matches (bad quant/repo — fail loud, never
    silently download the wrong thing).
    """
    commit_sha = _revision_sha(repo, revision)
    entries = _tree(repo, revision)

    q = quant.lower()
    selected = [
        e for e in entries
        if e["path"].lower().endswith(".gguf") and q in e["path"].lower()
    ]
    if mmproj:
        mp = mmproj.lower()
        for e in entries:
            if (
                e["path"].lower().endswith(".gguf")
                and mp in e["path"].lower()
                and e not in selected
            ):
                selected.append(e)
    if not selected:
        raise FileNotFoundError(f"no .gguf matching quant {quant!r} in {repo}@{revision}")
    return commit_sha, selected


def is_cached(repo: str, quant: str, *, cache_root: Path, mmproj: str | None = None) -> bool:
    """Offline check: is a GGUF for `quant` already in the local cache? A thin wrapper
    over `cached_gguf_path` (ONE source of the snapshot-path + match rule) — no network
    call, cheap enough to run per-model when building the catalog. `mmproj` is accepted
    for symmetry with `acquire_model` but a present main GGUF is what decides "downloaded"."""
    return cached_gguf_path(repo, quant, cache_root=cache_root, mmproj=mmproj) is not None


def cached_gguf_path(
    repo: str, quant: str, *, cache_root: Path, mmproj: str | None = None  # noqa: ARG001
) -> Path | None:
    """The on-disk path of a cached GGUF for `quant`, or None if not cached — the
    path-returning sibling of `is_cached` (SAME match rule, no network call). Lets the
    router `.ini` emitter reference a downloaded model's file WITHOUT re-downloading it.
    Returns the first shard of a split model (loading it pulls the rest). `mmproj` is
    accepted for signature symmetry with `is_cached`/`acquire_model`."""
    snapshots = Path(cache_root) / ("models--" + repo.replace("/", "--")) / "snapshots"
    if not snapshots.is_dir():
        return None
    q = quant.lower()
    cands = sorted(p for p in snapshots.rglob("*.gguf") if q in p.name.lower())
    return cands[0] if cands else None


def acquire_model(
    repo: str,
    quant: str,
    mmproj: str | None = None,
    revision: str = "main",
    cache_root: Path | None = None,
    on_progress: Callable[[int, int | None], None] | None = None,
    cancel_check: Callable[[], bool] | None = None,
) -> Path:
    """Download the GGUF(s) for `quant` into the HF cache; return the snapshot
    dir llama.cpp loads from (`…/snapshots/<sha>/`).

    Writes the canonical HF cache layout (blobs + snapshot symlink/copy +
    refs). Idempotent: a blob already on disk at the right size is skipped.
    `on_progress(cumulative, total)` receives cumulative bytes across ALL
    selected files against the summed grand total (so the caller can show one
    smooth bar); `cancel_check` is polled per file and passed to the stream.
    """
    commit_sha, files = select_files(repo, quant, mmproj, revision)
    grand_total = sum(_entry_size(e) for e in files) or None

    root = cache_root or hf_cache_root()
    repo_dir = root / ("models--" + repo.replace("/", "--"))
    blobs_dir = repo_dir / "blobs"
    snapshot_dir = repo_dir / "snapshots" / commit_sha
    refs_dir = repo_dir / "refs"
    for d in (blobs_dir, snapshot_dir, refs_dir):
        d.mkdir(parents=True, exist_ok=True)

    cumulative = 0
    for entry in files:
        if cancel_check is not None and cancel_check():
            raise DownloadCancelled()
        path = entry["path"]
        oid = _entry_oid(entry)
        size = _entry_size(entry)
        blob = blobs_dir / oid
        snapshot_file = snapshot_dir / path
        snapshot_file.parent.mkdir(parents=True, exist_ok=True)

        if not blob.exists() or blob.stat().st_size != size:
            # Re-stream over any partial of a different size (truncates dest).
            file_url = f"{_HF_BASE}/{repo}/resolve/{revision}/{path}"
            base = cumulative
            log.info("downloading %s (%d bytes) from %s", path, size, repo)
            stream_download(
                file_url, blob,
                on_progress=(
                    (lambda n, _t, _b=base: on_progress(_b + n, grand_total)) if on_progress else None
                ),
                cancel_check=cancel_check,
            )

        # snapshot/<path> -> blob. Relative symlink so the cache dir is
        # movable; copy fallback on Windows without symlink privilege (same
        # as huggingface_hub).
        if not snapshot_file.exists():
            try:
                snapshot_file.symlink_to(os.path.relpath(blob, snapshot_file.parent))
            except (OSError, NotImplementedError):
                shutil.copy2(blob, snapshot_file)

        cumulative += size
        if on_progress:
            on_progress(cumulative, grand_total)

    # Pin refs/<rev> -> commit_sha so the resolver maps the symbolic ref next time.
    (refs_dir / revision).write_text(commit_sha)
    return snapshot_dir
