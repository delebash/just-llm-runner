# SPDX-License-Identifier: GPL-3.0-or-later
"""P1.3 — GGUF model acquisition: quant-based file selection + HF cache write.
Network (HF Hub API + file stream) is mocked, so the test runs anywhere."""

from __future__ import annotations

import pytest

from llm_runner.runner import models

# A synthetic HF tree: two shards of the wanted quant, a different quant, an
# mmproj sidecar, plus non-GGUF repo files that must never be selected.
TREE = [
    {"type": "file", "path": ".gitattributes", "oid": "g1", "size": 10},
    {"type": "file", "path": "README.md", "oid": "g2", "size": 20},
    {"type": "file", "path": "UD-Q4_K_XL/model-00001-of-00002.gguf", "oid": "o1", "lfs": {"oid": "lfs1", "size": 4}},
    {"type": "file", "path": "UD-Q4_K_XL/model-00002-of-00002.gguf", "oid": "o2", "lfs": {"oid": "lfs2", "size": 4}},
    {"type": "file", "path": "UD-Q8_0/model.gguf", "oid": "o3", "lfs": {"oid": "lfs3", "size": 4}},
    {"type": "file", "path": "mmproj-F16.gguf", "oid": "o4", "lfs": {"oid": "lfs4", "size": 4}},
    {"type": "directory", "path": "UD-Q4_K_XL"},
]


class _Resp:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


def _make_get(tree, sha="abc1234"):
    def _get(url, params=None, timeout=None):
        if "/revision/" in url:
            return _Resp({"sha": sha})
        if "/tree/" in url:
            return _Resp(tree)
        raise AssertionError(f"unexpected GET: {url}")

    return _get


def _make_stream(calls):
    def _stream(url, dest, on_progress=None, cancel_check=None):
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(b"GGUF")  # 4 bytes == every entry's declared size
        calls.append(url)
        if on_progress:
            on_progress(4, 4)  # (downloaded, total) — this file is 4 bytes
        return "deadbeef"

    return _stream


def test_select_files_matches_quant_and_shards(monkeypatch):
    monkeypatch.setattr(models.requests, "get", _make_get(TREE))
    sha, files = models.select_files("owner/repo", "UD-Q4_K_XL")
    assert sha == "abc1234"
    assert sorted(f["path"] for f in files) == [
        "UD-Q4_K_XL/model-00001-of-00002.gguf",
        "UD-Q4_K_XL/model-00002-of-00002.gguf",
    ]


def test_select_files_includes_mmproj_when_set(monkeypatch):
    monkeypatch.setattr(models.requests, "get", _make_get(TREE))
    _, files = models.select_files("owner/repo", "UD-Q4_K_XL", mmproj="mmproj")
    paths = sorted(f["path"] for f in files)
    assert "mmproj-F16.gguf" in paths
    assert len(files) == 3  # two shards + mmproj, never the Q8_0 / readme


def test_select_files_no_match_raises(monkeypatch):
    monkeypatch.setattr(models.requests, "get", _make_get(TREE))
    with pytest.raises(FileNotFoundError):
        models.select_files("owner/repo", "DOES-NOT-EXIST")


def test_acquire_model_writes_hf_cache_layout(monkeypatch, tmp_path):
    monkeypatch.setattr(models.requests, "get", _make_get(TREE))
    calls: list[str] = []
    monkeypatch.setattr(models, "stream_download", _make_stream(calls))
    progress: list[tuple[int, int | None]] = []

    snap = models.acquire_model(
        "owner/repo", "UD-Q4_K_XL", cache_root=tmp_path,
        on_progress=lambda d, t: progress.append((d, t)),
    )

    repo_dir = tmp_path / "models--owner--repo"
    assert snap == repo_dir / "snapshots" / "abc1234"
    # snapshot files resolve (symlink → blob) for both shards
    assert (snap / "UD-Q4_K_XL/model-00001-of-00002.gguf").exists()
    assert (snap / "UD-Q4_K_XL/model-00002-of-00002.gguf").exists()
    # blobs are keyed by the LFS oid, not the git oid
    assert (repo_dir / "blobs" / "lfs1").read_bytes() == b"GGUF"
    assert not (repo_dir / "blobs" / "o1").exists()
    # refs/<rev> pins the commit sha
    assert (repo_dir / "refs" / "main").read_text() == "abc1234"
    # exactly the two shards downloaded; final progress = (cumulative, grand total)
    assert len(calls) == 2
    assert progress[-1] == (8, 8)


def test_acquire_model_idempotent(monkeypatch, tmp_path):
    monkeypatch.setattr(models.requests, "get", _make_get(TREE))
    calls: list[str] = []
    monkeypatch.setattr(models, "stream_download", _make_stream(calls))
    models.acquire_model("owner/repo", "UD-Q4_K_XL", cache_root=tmp_path)
    assert len(calls) == 2

    # Second call: blobs already exist at the right size → no re-download.
    def _boom(*a, **k):
        raise AssertionError("should not re-download an already-acquired blob")

    monkeypatch.setattr(models, "stream_download", _boom)
    snap = models.acquire_model("owner/repo", "UD-Q4_K_XL", cache_root=tmp_path)
    assert snap.exists()


# ── classify_gguf_entries — the quant dropdown + MTP-draft detection (Plan B D9) ──

# The user's real gemma-4-26B repo shape, verbatim conventions: a QAT main model
# at a UD- dynamic quant + a SEPARATE draft at its own quant in an MTP/ subfolder.
GEMMA_TREE = [
    {"type": "file", "path": "gemma-4-26B-A4B-it-qat-UD-Q4_K_XL.gguf", "oid": "a", "lfs": {"oid": "l1", "size": 14 * 1024 * 1024 * 1024}},
    {"type": "file", "path": "gemma-4-26B-A4B-it-qat-Q8_0-00001-of-00002.gguf", "oid": "b", "lfs": {"oid": "l2", "size": 12 * 1024 * 1024 * 1024}},
    {"type": "file", "path": "gemma-4-26B-A4B-it-qat-Q8_0-00002-of-00002.gguf", "oid": "c", "lfs": {"oid": "l3", "size": 12 * 1024 * 1024 * 1024}},
    {"type": "file", "path": "gemma-4-26B-A4B-it-qat-IQ4_XS.gguf", "oid": "d", "lfs": {"oid": "l4", "size": 13 * 1024 * 1024 * 1024}},
    {"type": "file", "path": "MTP/gemma-4-26B-A4B-it-Q4_0-MTP.gguf", "oid": "e", "lfs": {"oid": "l5", "size": 700 * 1024 * 1024}},
    {"type": "file", "path": "mmproj-F16.gguf", "oid": "f", "lfs": {"oid": "l6", "size": 500 * 1024 * 1024}},
    {"type": "file", "path": "README.md", "oid": "g", "size": 20},
]


def test_classify_gemma_repo_quants_and_draft():
    out = models.classify_gguf_entries(GEMMA_TREE)
    by_quant = {q["quant"]: q for q in out["quants"]}
    # UD- dynamic quant recognized whole + flagged QAT (from the filename)
    assert by_quant["UD-Q4_K_XL"]["kind"] == "Q" and by_quant["UD-Q4_K_XL"]["qat"] is True
    # shards SUMMED into one row
    assert by_quant["Q8_0"]["files"] == 2
    assert by_quant["Q8_0"]["sizeMb"] == 2 * 12 * 1024
    # IQ family labeled IQ
    assert by_quant["IQ4_XS"]["kind"] == "IQ"
    # the draft is DETECTED (MTP/ dir + -MTP.gguf), carries its own quant, and is
    # NOT in the quants list; mmproj + README are skipped entirely
    assert len(out["drafts"]) == 1
    d = out["drafts"][0]
    assert d["path"] == "MTP/gemma-4-26B-A4B-it-Q4_0-MTP.gguf" and d["quant"] == "Q4_0"
    assert "Q4_0" not in by_quant
    assert not any("mmproj" in q["quant"].lower() for q in out["quants"])
    # sorted by size ascending
    sizes = [q["sizeMb"] for q in out["quants"]]
    assert sizes == sorted(sizes)


def test_classify_plain_repo_no_drafts():
    out = models.classify_gguf_entries(TREE)
    assert out["drafts"] == []
    by_quant = {q["quant"]: q for q in out["quants"]}
    assert by_quant["UD-Q4_K_XL"]["files"] == 2 and by_quant["UD-Q4_K_XL"]["qat"] is False
    assert "UD-Q8_0" in by_quant
