# SPDX-License-Identifier: MIT
"""make_data_router — backup → mutate → restore round-trips data + assets;
reset wipes to the host's seed. Schema-agnostic over a tiny SQLite app."""

import io
import zipfile

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Column, Integer, MetaData, String, Table, create_engine, text

from llm_runner.platform import make_data_router


def _app(tmp_path):
    db = tmp_path / "app.db"
    engine = create_engine(f"sqlite:///{db}")
    md = MetaData()
    notes = Table("notes", md, Column("id", Integer, primary_key=True), Column("body", String))
    md.create_all(engine)

    def run_reset():
        with engine.begin() as c:
            for t in reversed(md.sorted_tables):
                c.execute(t.delete())
            c.execute(notes.insert().values(id=1, body="seed"))

    assets = tmp_path / "images"
    assets.mkdir()
    app = FastAPI()
    app.include_router(make_data_router(
        get_db_path=lambda: db, metadata=md, run_reset=run_reset,
        asset_dirs=lambda: {"images": assets},
    ))
    return TestClient(app), engine, notes, assets


def test_backup_restore_reset_roundtrip(tmp_path):
    c, engine, notes, assets = _app(tmp_path)
    with engine.begin() as conn:
        conn.execute(notes.insert().values(id=1, body="original"))
        conn.execute(notes.insert().values(id=2, body="second"))
    (assets / "a.txt").write_text("hello")

    # Backup: a zip with the DB + the asset dir.
    r = c.get("/v1/data/backup")
    assert r.status_code == 200
    blob = r.content
    names = zipfile.ZipFile(io.BytesIO(blob)).namelist()
    assert "db.sqlite" in names and "images/a.txt" in names

    # Mutate after the backup.
    with engine.begin() as conn:
        conn.execute(text("DELETE FROM notes"))
        conn.execute(notes.insert().values(id=99, body="changed"))
    (assets / "a.txt").write_text("CHANGED")

    # Restore brings rows AND assets back.
    rr = c.post("/v1/data/restore", files={"file": ("backup.zip", blob, "application/zip")})
    assert rr.status_code == 200
    with engine.connect() as conn:
        rows = {row[0]: row[1] for row in conn.execute(text("SELECT id, body FROM notes"))}
    assert rows == {1: "original", 2: "second"}
    assert (assets / "a.txt").read_text() == "hello"

    # Reset wipes to the host seed.
    assert c.post("/v1/data/reset").status_code == 200
    with engine.connect() as conn:
        rows = {row[0]: row[1] for row in conn.execute(text("SELECT id, body FROM notes"))}
    assert rows == {1: "seed"}


def test_restore_rejects_bad_zip(tmp_path):
    c, *_ = _app(tmp_path)
    r = c.post("/v1/data/restore", files={"file": ("x.zip", b"not a zip", "application/zip")})
    assert r.status_code == 400


def test_backup_exclude_skips_named_asset_dirs_and_restore_leaves_live_copy(tmp_path):
    """?exclude=<arcnames> (the DataManagement per-app options seam — decision ①,
    family parity batch 2026-08-05: JV's include-audio toggle rides it). The named
    asset dirs stay out of the zip; the DB always ships; restoring such a backup
    leaves the live copy of the excluded content untouched."""
    c, engine, notes, assets = _app(tmp_path)
    with engine.begin() as conn:
        conn.execute(notes.insert().values(id=1, body="original"))
    (assets / "a.txt").write_text("keep me")

    r = c.get("/v1/data/backup?exclude=images,unknown-name")
    assert r.status_code == 200
    names = zipfile.ZipFile(io.BytesIO(r.content)).namelist()
    assert "db.sqlite" in names
    assert not any(n.startswith("images/") for n in names)

    # Mutate, then restore the audio-less backup: rows come back, the excluded
    # dir's live content stays exactly as it is (never deleted for being absent).
    with engine.begin() as conn:
        conn.execute(text("DELETE FROM notes"))
    (assets / "a.txt").write_text("still here after restore")
    rr = c.post("/v1/data/restore", files={"file": ("backup.zip", r.content, "application/zip")})
    assert rr.status_code == 200
    with engine.connect() as conn:
        rows = {row[0]: row[1] for row in conn.execute(text("SELECT id, body FROM notes"))}
    assert rows == {1: "original"}
    assert (assets / "a.txt").read_text() == "still here after restore"
