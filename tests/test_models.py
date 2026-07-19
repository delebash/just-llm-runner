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
    def _stream(url, dest, on_progress=None, cancel_check=None, **_segment_kwargs):
        # **_segment_kwargs absorbs the DL-2 segment settings (segments /
        # segment_min_bytes / segment_retries) — irrelevant to these stubs.
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


# ── dspark own-repo drafters + inherited-drafter shard/fp16 guard (2026-07-19) ──

_GB = 1024 * 1024 * 1024

# prism-ml/Ternary-Bonsai-27B-gguf, real filenames verbatim (fetched from HF
# 2026-07-19): a full-precision F16, several Q quants, TWO `-dspark-*` own-repo
# drafters, two mmproj sidecars, a README.
BONSAI_TREE = [
    {"type": "file", "path": "Ternary-Bonsai-27B-F16.gguf", "oid": "a", "lfs": {"oid": "l1", "size": int(53.8 * _GB)}},
    {"type": "file", "path": "Ternary-Bonsai-27B-PQ2_0.gguf", "oid": "b", "lfs": {"oid": "l2", "size": int(8.2 * _GB)}},
    {"type": "file", "path": "Ternary-Bonsai-27B-Q2_0.gguf", "oid": "c", "lfs": {"oid": "l3", "size": int(8.1 * _GB)}},
    {"type": "file", "path": "Ternary-Bonsai-27B-Q2_g64.gguf", "oid": "d", "lfs": {"oid": "l4", "size": int(7.59 * _GB)}},
    {"type": "file", "path": "Ternary-Bonsai-27B-dspark-Q4_1.gguf", "oid": "e", "lfs": {"oid": "l5", "size": int(1.95 * _GB)}},
    {"type": "file", "path": "Ternary-Bonsai-27B-dspark-bf16.gguf", "oid": "f", "lfs": {"oid": "l6", "size": int(2.6 * _GB)}},
    {"type": "file", "path": "Ternary-Bonsai-27B-mmproj-BF16.gguf", "oid": "g", "lfs": {"oid": "l7", "size": int(0.9 * _GB)}},
    {"type": "file", "path": "Ternary-Bonsai-27B-mmproj-Q8_0.gguf", "oid": "h", "lfs": {"oid": "l8", "size": int(0.5 * _GB)}},
    {"type": "file", "path": "README.md", "oid": "i", "size": 20},
]


def test_classify_bonsai_dspark_drafters():
    out = models.classify_gguf_entries(BONSAI_TREE)
    draft_paths = {d["path"] for d in out["drafts"]}
    # BOTH dspark files are detected as drafts (name-keyed, quant OR bf16)…
    assert "Ternary-Bonsai-27B-dspark-Q4_1.gguf" in draft_paths
    assert "Ternary-Bonsai-27B-dspark-bf16.gguf" in draft_paths
    # …and NEITHER leaks into the quant dropdown
    quant_paths = {q["quant"] for q in out["quants"]}
    assert "Q4_1" not in quant_paths
    # mmproj sidecars skipped entirely (never a quant, never a draft)
    assert not any("mmproj" in d["path"].lower() for d in out["drafts"])
    assert not any("mmproj" in q["quant"].lower() for q in out["quants"])
    # a real quant still lands in the dropdown
    assert "Q2_g64" in quant_paths
    # PQ2_0 and Q2_0 are TWO distinct quant rows (word-bounded token) — one file each,
    # NOT merged: an unanchored regex would read "PQ2_0" as the tail "Q2_0".
    by_quant = {q["quant"]: q for q in out["quants"]}
    assert by_quant["PQ2_0"]["files"] == 1 and by_quant["PQ2_0"]["kind"] == "Q"
    assert by_quant["Q2_0"]["files"] == 1 and by_quant["Q2_0"]["kind"] == "Q"


def test_drafter_skips_shards_prefers_quant_single(monkeypatch):
    # BF16 split shards (shard-2 is the smallest FILE) + a larger single Q4_K_M:
    # the shard tail must be rejected, the loadable Q4_K_M returned.
    tree = [
        {"type": "file", "path": "model-BF16-00001-of-00002.gguf", "oid": "a", "lfs": {"oid": "l1", "size": 20 * _GB}},
        {"type": "file", "path": "model-BF16-00002-of-00002.gguf", "oid": "b", "lfs": {"oid": "l2", "size": 1 * _GB}},
        {"type": "file", "path": "model-Q4_K_M.gguf", "oid": "c", "lfs": {"oid": "l3", "size": 5 * _GB}},
    ]
    monkeypatch.setattr(models.requests, "get", _make_get(tree))
    got = models._gguf_drafter_in_repo("owner/repo")
    assert got == {"repo": "owner/repo", "file": "model-Q4_K_M.gguf", "quant": "Q4_K_M"}


def test_drafter_none_when_only_shards_and_mmproj(monkeypatch):
    tree = [
        {"type": "file", "path": "model-BF16-00001-of-00002.gguf", "oid": "a", "lfs": {"oid": "l1", "size": 20 * _GB}},
        {"type": "file", "path": "model-BF16-00002-of-00002.gguf", "oid": "b", "lfs": {"oid": "l2", "size": 20 * _GB}},
        {"type": "file", "path": "mmproj-BF16.gguf", "oid": "c", "lfs": {"oid": "l3", "size": 1 * _GB}},
    ]
    monkeypatch.setattr(models.requests, "get", _make_get(tree))
    assert models._gguf_drafter_in_repo("owner/repo") is None


def test_drafter_picks_dspark_over_f16(monkeypatch):
    # The Bonsai shape: a small dspark-Q4_1 drafter beside a huge full-precision F16.
    # F16 is full precision (excluded); the quantized single-file dspark is the pick.
    tree = [
        {"type": "file", "path": "Ternary-Bonsai-27B-dspark-Q4_1.gguf", "oid": "a", "lfs": {"oid": "l1", "size": int(1.95 * _GB)}},
        {"type": "file", "path": "Ternary-Bonsai-27B-F16.gguf", "oid": "b", "lfs": {"oid": "l2", "size": int(53.8 * _GB)}},
    ]
    monkeypatch.setattr(models.requests, "get", _make_get(tree))
    got = models._gguf_drafter_in_repo("owner/repo")
    assert got == {"repo": "owner/repo", "file": "Ternary-Bonsai-27B-dspark-Q4_1.gguf", "quant": "Q4_1"}


def test_drafter_shard_filter_fires_alone(monkeypatch):
    # Isolates the SHARD filter: a QUANTIZED shard tail (survives the fp16 filter)
    # that is the SMALLEST file, beside a LARGER single quant. Only shard-exclusion
    # can reject the smaller quantized shard → the single-file Q5_K_M must win.
    tree = [
        {"type": "file", "path": "model-Q4_K_M-00001-of-00002.gguf", "oid": "a", "lfs": {"oid": "l1", "size": 1 * _GB}},
        {"type": "file", "path": "model-Q4_K_M-00002-of-00002.gguf", "oid": "b", "lfs": {"oid": "l2", "size": 1 * _GB}},
        {"type": "file", "path": "model-Q5_K_M.gguf", "oid": "c", "lfs": {"oid": "l3", "size": 5 * _GB}},
    ]
    monkeypatch.setattr(models.requests, "get", _make_get(tree))
    got = models._gguf_drafter_in_repo("owner/repo")
    assert got == {"repo": "owner/repo", "file": "model-Q5_K_M.gguf", "quant": "Q5_K_M"}


def test_drafter_fp16_filter_fires_alone(monkeypatch):
    # Isolates the fp16 filter: a NON-shard F16 that is the SMALLEST file, beside a
    # larger single Q4_K_M. The shard filter never touches F16 (no -N-of-N tail), so
    # only fp16-exclusion can reject the smaller F16 → the Q4_K_M must win.
    tree = [
        {"type": "file", "path": "model-F16.gguf", "oid": "a", "lfs": {"oid": "l1", "size": 1 * _GB}},
        {"type": "file", "path": "model-Q4_K_M.gguf", "oid": "b", "lfs": {"oid": "l2", "size": 5 * _GB}},
    ]
    monkeypatch.setattr(models.requests, "get", _make_get(tree))
    got = models._gguf_drafter_in_repo("owner/repo")
    assert got == {"repo": "owner/repo", "file": "model-Q4_K_M.gguf", "quant": "Q4_K_M"}


# ── the draft-pick FLOOR: 4-bit-or-better (2026-07-19) ────────────────────────

def test_q4_or_better_floor():
    # THE one predicate both pickers order by.
    for good in ("Q4_K_M", "Q4_0", "IQ4_XS", "UD-Q4_K_XL", "Q5_K_M", "Q6_K", "Q8_0",
                 "BF16", "F16", "F32"):
        assert models._q4_or_better(good), good
    for bad in ("Q2_K", "Q2_0", "Q3_K_M", "IQ2_XXS", "IQ3_XXS", "", "weird"):
        assert not models._q4_or_better(bad), bad
    # PQ2_0's leading P is a format marker, not a bit-width — it is still 2-bit.
    assert not models._q4_or_better("PQ2_0")


def test_classify_marks_the_draft_pick_floor():
    # Each draft row carries the flag the Add/Edit form's pre-select orders by, so the
    # UI never re-derives (and never disagrees with) the rule.
    out = models.classify_gguf_entries([
        {"type": "file", "path": "MTP/m-Q2_K-MTP.gguf", "oid": "a", "lfs": {"oid": "l1", "size": 1}},
        {"type": "file", "path": "MTP/m-Q4_0-MTP.gguf", "oid": "b", "lfs": {"oid": "l2", "size": 9}},
    ])
    assert {d["path"]: d["q4OrBetter"] for d in out["drafts"]} == {
        "MTP/m-Q2_K-MTP.gguf": False, "MTP/m-Q4_0-MTP.gguf": True}


def test_draft_floor_flag_survives_the_wire_model():
    # THE guard for the 2026-07-19 miss the rules-checker caught: `/model-catalog/list-files`
    # declares `response_model=ListFilesResponse`, and Pydantic's default extra="ignore"
    # SILENTLY DROPS any key the row model doesn't name — so the flag reached the browser
    # as `undefined` and the form's pre-select fell back to smallest-wins-with-no-floor,
    # the exact behaviour the floor exists to replace. Assert it survives the real
    # classify → response-model hop the form receives.
    from llm_runner.llm.model_catalog_api import ListFilesResponse

    data = models.classify_gguf_entries([
        {"type": "file", "path": "MTP/m-Q2_K-MTP.gguf", "oid": "a", "lfs": {"oid": "l1", "size": 1}},
        {"type": "file", "path": "MTP/m-Q4_0-MTP.gguf", "oid": "b", "lfs": {"oid": "l2", "size": 9}},
    ])
    rows = ListFilesResponse(**data).model_dump()["drafts"]
    assert {r["path"]: r["q4OrBetter"] for r in rows} == {
        "MTP/m-Q2_K-MTP.gguf": False, "MTP/m-Q4_0-MTP.gguf": True}


def test_drafter_floor_fires_alone_over_a_smaller_low_bit_quant(monkeypatch):
    # Isolates the FLOOR: a Q2_K that is the smallest file beside a larger Q4_K_M.
    # Neither the shard nor the fp16 filter touches either candidate, so only the
    # 4-bit floor can reject the smaller Q2_K — remove it and this flips red.
    tree = [
        {"type": "file", "path": "model-Q2_K.gguf", "oid": "a", "lfs": {"oid": "l1", "size": 1 * _GB}},
        {"type": "file", "path": "model-Q4_K_M.gguf", "oid": "b", "lfs": {"oid": "l2", "size": 3 * _GB}},
    ]
    monkeypatch.setattr(models.requests, "get", _make_get(tree))
    got = models._gguf_drafter_in_repo("owner/repo")
    assert got == {"repo": "owner/repo", "file": "model-Q4_K_M.gguf", "quant": "Q4_K_M"}


def test_drafter_falls_back_to_smallest_when_nothing_clears_the_floor(monkeypatch):
    # The floor is a PREFERENCE, not a filter: a repo with only sub-4-bit quants still
    # gets a suggestion — the smallest of them.
    tree = [
        {"type": "file", "path": "model-Q3_K_S.gguf", "oid": "a", "lfs": {"oid": "l1", "size": 3 * _GB}},
        {"type": "file", "path": "model-Q2_K.gguf", "oid": "b", "lfs": {"oid": "l2", "size": 1 * _GB}},
    ]
    monkeypatch.setattr(models.requests, "get", _make_get(tree))
    got = models._gguf_drafter_in_repo("owner/repo")
    assert got == {"repo": "owner/repo", "file": "model-Q2_K.gguf", "quant": "Q2_K"}


# ── word-bounded quant matching in select_files + cached_gguf_path (2026-07-19) ──

_PQ_TREE = [
    {"type": "file", "path": "Ternary-Bonsai-27B-PQ2_0.gguf", "oid": "a", "lfs": {"oid": "l1", "size": 4}},
    {"type": "file", "path": "Ternary-Bonsai-27B-Q2_0.gguf", "oid": "b", "lfs": {"oid": "l2", "size": 4}},
]


def test_select_files_pq2_0_and_q2_0_dont_cross_match(monkeypatch):
    # "Q2_0" must select ONLY the plain Q2_0 file — not the PQ2_0 (a different quant);
    # "PQ2_0" must select ONLY its own file. Plain substring merged both into Q2_0.
    monkeypatch.setattr(models.requests, "get", _make_get(_PQ_TREE))
    _, q = models.select_files("owner/repo", "Q2_0")
    assert [f["path"] for f in q] == ["Ternary-Bonsai-27B-Q2_0.gguf"]
    _, pq = models.select_files("owner/repo", "PQ2_0")
    assert [f["path"] for f in pq] == ["Ternary-Bonsai-27B-PQ2_0.gguf"]


def test_select_files_q2_0_excludes_longer_g64_token(monkeypatch):
    # "Q2_0" must not match a "Q2_0_g64"-named file (a longer, distinct token).
    tree = [
        {"type": "file", "path": "model-Q2_0.gguf", "oid": "a", "lfs": {"oid": "l1", "size": 4}},
        {"type": "file", "path": "model-Q2_0_g64.gguf", "oid": "b", "lfs": {"oid": "l2", "size": 4}},
    ]
    monkeypatch.setattr(models.requests, "get", _make_get(tree))
    _, files = models.select_files("owner/repo", "Q2_0")
    assert [f["path"] for f in files] == ["model-Q2_0.gguf"]


def test_cached_gguf_path_word_bounded_quant(tmp_path):
    # The SAME boundary rule holds for the on-disk cache lookup: seed a PQ2_0 and a
    # Q2_0 snapshot file; "Q2_0" resolves only the Q2_0 file, "PQ2_0" only PQ2_0.
    snap = tmp_path / "models--owner--repo" / "snapshots" / "sha"
    snap.mkdir(parents=True)
    (snap / "Ternary-Bonsai-27B-PQ2_0.gguf").write_bytes(b"GGUF")
    (snap / "Ternary-Bonsai-27B-Q2_0.gguf").write_bytes(b"GGUF")
    q = models.cached_gguf_path("owner/repo", "Q2_0", cache_root=tmp_path)
    assert q is not None and q.name == "Ternary-Bonsai-27B-Q2_0.gguf"
    pq = models.cached_gguf_path("owner/repo", "PQ2_0", cache_root=tmp_path)
    assert pq is not None and pq.name == "Ternary-Bonsai-27B-PQ2_0.gguf"
    assert models.is_cached("owner/repo", "Q2_0", cache_root=tmp_path)
