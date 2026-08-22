# SPDX-License-Identifier: MIT
"""make_disk_router — GET /v1/disk/usage sums the DB (+ its WAL/SHM sidecars),
app logs, and the ai-cache buckets under the data dir, holds the spawn-logs subdir
OUT of engineBuilds, reports free/total space, and treats missing dirs as 0."""

import os

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from llm_runner.platform import make_disk_router
from llm_runner.runner import lifecycle


@pytest.fixture(autouse=True)
def _no_wired_service(monkeypatch):
    """No runner service, so these measure the in-data-dir layout.

    Since 2026-08-03 the engine buckets are read off the WIRED service, because the
    cache may be shared with a sibling app and a panel that assumed `<data_dir>/
    ai-cache` would report 0 B for 14 GB of models. That makes this suite sensitive to
    the process-wide singleton: `test_config.py` calls `configure_service()` with no
    cache root, and a leaked one pointed these sums at `~/.cache/just-llm-runner`
    (green alone, red in a full run). One app per process in production; per test here.
    `test_shared_cache.py` covers the wired case deliberately."""
    monkeypatch.setattr(lifecycle, "_service", None)


def _client(data_dir):
    app = FastAPI()
    app.include_router(make_disk_router(str(data_dir)))
    return TestClient(app)


def _write(path, n):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x" * n)


def test_usage_sums_each_bucket(tmp_path):
    # DB + its WAL/SHM sidecars at the root.
    _write(tmp_path / "justwrite.db", 1000)
    _write(tmp_path / "justwrite.db-wal", 200)
    _write(tmp_path / "justwrite.db-shm", 50)
    # app logs (per-day server logs).
    _write(tmp_path / "logs" / "justwrite.log", 300)
    _write(tmp_path / "logs" / "justwrite.log.2026-07-01", 150)
    # models cache (hf) — nested like the real HF layout.
    _write(tmp_path / "ai-cache" / "hf" / "models--org--m" / "blobs" / "abc", 5000)
    # engine builds (llamacpp): a build dir + the generated models.ini sibling.
    _write(tmp_path / "ai-cache" / "llamacpp" / "b9999" / "llama-server", 4000)
    _write(tmp_path / "ai-cache" / "llamacpp" / "models.ini", 100)
    # spawn logs — a SEPARATE bucket, excluded from engineBuilds.
    _write(tmp_path / "ai-cache" / "llamacpp" / "logs" / "runner-x.log", 700)

    body = _client(tmp_path).get("/v1/disk/usage").json()
    assert body["database"] == 1250            # 1000 + 200 + 50
    assert body["appLogs"] == 450              # 300 + 150
    assert body["modelsCache"] == 5000
    assert body["engineBuilds"] == 4100        # 4000 + 100, NOT the 700 spawn log
    assert body["spawnLogs"] == 700
    assert body["total"] == 1250 + 450 + 5000 + 4100 + 700
    assert body["diskTotal"] > 0 and body["diskFree"] > 0


def test_missing_dirs_are_zero_not_error(tmp_path):
    # A bare data dir (nothing created) → every bucket 0, still 200 + real free/total.
    body = _client(tmp_path).get("/v1/disk/usage").json()
    assert body["database"] == 0
    assert body["appLogs"] == 0
    assert body["modelsCache"] == 0
    assert body["engineBuilds"] == 0
    assert body["spawnLogs"] == 0
    assert body["total"] == 0
    assert body["diskTotal"] > 0


def test_symlinks_are_not_followed(tmp_path):
    # HF stores real blobs and symlinks them from snapshots/ — the walk must count
    # the blob ONCE and skip the link (no double count, no walk loop).
    import pytest

    blob = tmp_path / "ai-cache" / "hf" / "blobs" / "sha"
    _write(blob, 2048)
    snap = tmp_path / "ai-cache" / "hf" / "snapshots" / "rev"
    snap.mkdir(parents=True)
    try:
        (snap / "model.gguf").symlink_to(blob)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks unsupported on this platform")
    body = _client(tmp_path).get("/v1/disk/usage").json()
    assert body["modelsCache"] == 2048  # blob counted once; the symlink skipped


def test_extra_buckets_measured_named_and_counted(tmp_path):
    """Host-declared buckets (JV's speech/render caches): measured with the
    same guarded walk, served under their declared names in `extras`, counted
    into total. A missing extra dir is 0, and a host that declares none gets
    `extras: {}` (the pre-parameter shape, byte-identical)."""
    _write(tmp_path / "speech-cache" / "kokoro" / "v1" / "model.onnx", 900)
    _write(tmp_path / "cache" / "ab" / "render.wav", 600)
    _write(tmp_path / "logs" / "app.log", 100)

    app = FastAPI()
    app.include_router(make_disk_router(str(tmp_path), extra_buckets={
        "speechCache": tmp_path / "speech-cache",
        "renderCache": tmp_path / "cache",
        "neverCreated": tmp_path / "nope",
    }))
    body = TestClient(app).get("/v1/disk/usage").json()
    assert body["extras"] == {"speechCache": 900, "renderCache": 600, "neverCreated": 0}
    assert body["total"] == 100 + 900 + 600

    plain = _client(tmp_path).get("/v1/disk/usage").json()
    assert plain["extras"] == {}
    assert plain["total"] == 100


def test_extra_bucket_with_several_roots_sums_them(tmp_path):
    """A user-facing store whose files span layout generations (JV's speech
    models: the speech cache + legacy per-engine dirs) declares a LIST of
    roots and gets one summed number."""
    _write(tmp_path / "speech-cache" / "eng" / "v1" / "m.bin", 500)
    _write(tmp_path / "legacy" / "eng" / "models" / "old.onnx", 300)

    app = FastAPI()
    app.include_router(make_disk_router(str(tmp_path), extra_buckets={
        "speechCache": [tmp_path / "speech-cache", tmp_path / "legacy" / "eng" / "models"],
    }))
    body = TestClient(app).get("/v1/disk/usage").json()
    assert body["extras"] == {"speechCache": 800}
    assert body["total"] == 800


def test_hardlinked_blob_counted_once(tmp_path):
    """Where HF cannot symlink it hardlinks or copies, so one blob answers to two
    names. The disk holds those bytes once and the panel must say so — otherwise a
    22 GB cache reports 45 GB, and `models-cache/clear` claims to free twice what
    it frees."""
    blob = tmp_path / "ai-cache" / "hf" / "blobs" / "sha"
    _write(blob, 4096)
    snap = tmp_path / "ai-cache" / "hf" / "snapshots" / "rev"
    snap.mkdir(parents=True)
    try:
        os.link(blob, snap / "model.gguf")
    except (OSError, NotImplementedError, AttributeError):
        pytest.skip("hardlinks unsupported on this platform")

    body = _client(tmp_path).get("/v1/disk/usage").json()
    assert body["modelsCache"] == 4096  # one inode, two names, counted once


def test_dedup_does_not_merge_distinct_files_of_equal_size(tmp_path):
    """The guard on the dedup itself. On Windows a DirEntry's stat carries no link
    data — st_ino and st_nlink both read 0 — so keying on it would fold every file
    into a single entry and under-report a full cache as one file. Two unrelated
    same-sized blobs must still sum."""
    _write(tmp_path / "ai-cache" / "hf" / "blobs" / "sha-a", 4096)
    _write(tmp_path / "ai-cache" / "hf" / "blobs" / "sha-b", 4096)

    body = _client(tmp_path).get("/v1/disk/usage").json()
    assert body["modelsCache"] == 8192
