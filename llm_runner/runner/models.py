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
import re
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


# Quant token in a GGUF filename: Q4_K_M / IQ4_XS / UD-Q4_K_XL / Q4_0 / BF16 / F16…
_QUANT_RE = re.compile(r"(?:UD-)?(?:I?Q\d[A-Za-z0-9_]*|BF16|F16|F32)")


def classify_gguf_entries(entries: list[dict]) -> dict:
    """PURE classification of an HF tree listing for the Add/Edit form (Plan B D9):
    the quant dropdown + MTP-draft detection, one `_tree` call parsed two ways.

    Returns {"quants": [...], "drafts": [...]}:
      * quants — ONE row per quant token, shards SUMMED ({quant, sizeMb, files,
        kind, qat}); `kind` = "Q" | "IQ" | "special" (BF16/F16/…); `qat` = the
        filename/path carries a QAT marker (a TRAINING property with no GGUF
        header key — it lives in the name, e.g. `…-qat-…`; the user's explicit
        label ask). mmproj sidecars and files with NO recognizable quant token
        are skipped (rare; the form's free-type covers them).
      * drafts — draft files (`MTP/` dir or `-MTP.gguf`, the observed MTP
        convention; plus `dspark` in the name, the own-repo drafter convention —
        exhibit prism-ml/Ternary-Bonsai-27B-gguf's `-dspark-Q4_1.gguf`), each its
        own row ({path, quant, sizeMb, qat}) since a draft is picked by exact path
        (its quant rides along).
    """
    quants: dict[str, dict] = {}
    drafts: list[dict] = []
    for e in entries:
        path = e.get("path", "")
        low = path.lower()
        if not low.endswith(".gguf") or "mmproj" in low:
            continue
        size_mb = int(_entry_size(e) / (1024 * 1024)) if _entry_size(e) else 0
        # Search the WHOLE path (not just the basename): split models often carry
        # the quant in a per-quant FOLDER (`UD-Q4_K_XL/model-00001-of-…`), the
        # same convention `select_files`' path-substring match relies on.
        m = _QUANT_RE.search(path)
        quant = m.group(0) if m else ""
        qat = "qat" in low
        is_draft = low.endswith("-mtp.gguf") or "/mtp/" in low or low.startswith("mtp/") or "dspark" in low
        if is_draft:
            drafts.append({"path": path, "quant": quant, "sizeMb": size_mb, "qat": qat})
            continue
        if not quant:
            continue  # no recognizable token → free-type territory, not a dropdown row
        q = quant.upper()
        kind = "IQ" if q.removeprefix("UD-").startswith("IQ") else ("Q" if "Q" in q else "special")
        row = quants.setdefault(quant, {"quant": quant, "sizeMb": 0, "files": 0, "kind": kind, "qat": qat})
        row["sizeMb"] += size_mb
        row["files"] += 1
    return {"quants": sorted(quants.values(), key=lambda r: r["sizeMb"]), "drafts": drafts}


def list_repo_ggufs(repo: str, revision: str = "main") -> dict:
    """ONE `_tree` call → the classified quant/draft listing (the network thin
    wrapper over `classify_gguf_entries`). Raises requests errors on a bad repo."""
    return classify_gguf_entries(_tree(repo, revision))


# ── Tier-C inherited MTP drafter discovery (2026-07-13) ───────────────────────
# A model with NO built-in MTP (`nextn_predict_layers==0`) and NO draft in its OWN
# repo can still run speculative-decode MTP by borrowing the OFFICIAL base-family
# drafter — a small "-assistant"/"-MTP" repo that shares the base's vocab +
# embeddings (verified: gemma4 26B-A4B → `google/gemma-4-26B-A4B-it-assistant`).
# This DISCOVERS one at inspect time: derive candidate drafter repos from the base
# chain, probe HF, and return ONLY a repo that actually resolves and carries a
# .gguf — verified, never guessed. Best-effort: any network/parse failure yields
# None (no suggestion), never an exception into the caller.
_MTP_ARCH_FAMILIES = ("gemma4", "qwen3", "deepseek")   # arch prefixes that support external MTP drafters
_DRAFTER_SUFFIXES = ("-assistant", "-MTP", "-mtp")       # official companion-drafter repo naming
_OFFICIAL_ORGS = ("google/", "qwen/", "deepseek-ai/")    # trust the vendor's own drafter, not a repackage


def _model_card(repo: str, revision: str = "main") -> dict:
    r = requests.get(f"{_HF_BASE}/api/models/{repo}/revision/{revision}", timeout=_API_TIMEOUT)
    r.raise_for_status()
    return r.json()


def _norm_repo(url_or_repo: str) -> str:
    """'https://huggingface.co/google/gemma-4-26B-A4B-it' | 'google/…' -> 'google/…'."""
    u = (url_or_repo or "").strip().rstrip("/")
    if "huggingface.co/" in u:
        u = u.split("huggingface.co/", 1)[1]
    segs = [p for p in u.split("/") if p]
    return "/".join(segs[:2]) if len(segs) >= 2 else ""


def _declared_bases(card: dict) -> list[str]:
    """cardData.base_model (str|list) + base_model:* tags, relation namespace stripped."""
    out: list[str] = []
    bm = (card.get("cardData") or {}).get("base_model")
    if isinstance(bm, str):
        out.append(bm)
    elif isinstance(bm, list):
        out.extend(b for b in bm if isinstance(b, str))
    for t in card.get("tags") or []:
        if t.startswith("base_model:"):
            parts = t.split(":", 2)
            out.append(parts[2] if len(parts) == 3 else parts[1])
    seen: set[str] = set()
    return [b for b in out if b and not (b in seen or seen.add(b))]


def _official_base_candidates(repo: str, base_repo_url: str, revision: str) -> list[str]:
    """Official (vendor-org) base repos to hang a drafter suffix off — walked from the
    GGUF header's base repo + the HF base_model chain (up to 2 hops). Only vendor-org
    repos are kept: the drafter must be the AUTHORITATIVE one, not a repackage."""
    frontier = [r for r in (_norm_repo(base_repo_url), repo) if r]
    officials: list[str] = []
    seen: set[str] = set()
    for _hop in range(2):
        nxt: list[str] = []
        for r in frontier:
            if not r or r in seen:
                continue
            seen.add(r)
            if r.lower().startswith(_OFFICIAL_ORGS):
                officials.append(r)
                continue
            try:
                nxt.extend(_norm_repo(b) for b in _declared_bases(_model_card(r, revision)))
            except requests.RequestException:
                continue
        frontier = nxt
    # De-dup, preserve order.
    out: list[str] = []
    for r in officials:
        if r and r not in out:
            out.append(r)
    return out


def _search_models(query: str, limit: int = 15) -> list[str]:
    r = requests.get(f"{_HF_BASE}/api/models", params={"search": query, "limit": limit},
                     timeout=_API_TIMEOUT)
    r.raise_for_status()
    return [str(m.get("id") or m.get("modelId") or "") for m in r.json()]


_SHARD_RE = re.compile(r"-\d+-of-\d+\.gguf$", re.IGNORECASE)  # split-shard tail


def _gguf_drafter_in_repo(repo: str, revision: str = "main") -> dict | None:
    """The smallest QUANTIZED single-file .gguf in `repo` as a drafter
    `{"repo","file","quant"}`, or None (no usable candidate / repo doesn't resolve).
    Smallest = fastest draft, and a drafter only affects SPEED — the main model
    validates every token — so smallest is the safe pick. Split shards and
    full-precision (BF16/F16/F32) files are excluded: a drafter is purely a speed
    device, and an fp16 shard tail (the smallest FILE, but not a loadable model) is
    exactly the wrong pick."""
    try:
        entries = _tree(repo, revision)
    except requests.RequestException:
        return None
    candidates: list[dict] = []
    for e in entries:
        path = str(e.get("path", ""))
        low = path.lower()
        if not low.endswith(".gguf") or "mmproj" in low:
            continue
        if _SHARD_RE.search(path):
            continue  # split shard — not a standalone loadable drafter
        m = _QUANT_RE.search(path)
        if not m:
            continue  # no recognizable quant token
        q = m.group(0).upper().removeprefix("UD-")
        if not (q.startswith("IQ") or "Q" in q):
            continue  # BF16/F16/F32 → full precision, not a quantized drafter
        candidates.append(e)
    if not candidates:
        return None
    best = min(candidates, key=_entry_size)
    path = str(best.get("path", ""))
    qm = _QUANT_RE.search(path)
    return {"repo": repo, "file": path, "quant": qm.group(0) if qm else ""}


def find_inherited_mtp_drafter(
    repo: str, architecture: str, base_repo_url: str = "", revision: str = "main"
) -> dict | None:
    """Best-effort Tier-C: a borrowable drafter for an MTP-family model whose own repo
    ships none. Walks the base chain to the OFFICIAL family root, finds its companion
    assistant/MTP repo, and returns a usable GGUF drafter `{"repo","file","quant"}` —
    from the assistant repo itself, or (the common case — official assistants ship
    safetensors, llama.cpp needs a GGUF) from a community GGUF quant of it, VERIFIED to
    resolve. None when nothing usable resolves. Never raises — discovery is advisory."""
    arch = (architecture or "").lower()
    if not any(arch.startswith(f) for f in _MTP_ARCH_FAMILIES):
        return None
    try:
        bases = _official_base_candidates(repo, base_repo_url, revision)
    except Exception:  # noqa: BLE001 — discovery is advisory; never break inspect
        return None
    for base in bases:
        # Strip a trailing precision/quant descriptor so a "-it-qat-q4_0-unquantized"
        # base still hangs the drafter off the "-it" root the vendor publishes it under.
        roots = {base}
        low = base.lower()
        for marker in ("-it-qat", "-it-", "-it"):
            if marker in low:
                roots.add(base[: low.index(marker) + len("-it")])
                break
        for root in roots:
            for suf in _DRAFTER_SUFFIXES:
                assistant = root + suf
                # 1) the official assistant repo itself, IF it ships a GGUF (rare).
                got = _gguf_drafter_in_repo(assistant, revision)
                if got:
                    return got
                # 2) else a community GGUF QUANT of that exact assistant — search by its
                # basename + "GGUF", keep only hits that carry the basename AND "gguf",
                # and return the first that actually resolves with a .gguf inside.
                basename = assistant.split("/")[-1]
                try:
                    hits = _search_models(f"{basename}-GGUF")
                except requests.RequestException:
                    hits = []
                for hit in hits:
                    hl = hit.lower()
                    if basename.lower() not in hl or "gguf" not in hl:
                        continue
                    got = _gguf_drafter_in_repo(hit, revision)
                    if got:
                        return got
    return None


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
    segments: int = 1,
    segment_min_bytes: int = 64 * 1024 * 1024,
    segment_retries: int = 3,
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
                segments=segments,
                segment_min_bytes=segment_min_bytes,
                segment_retries=segment_retries,
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
