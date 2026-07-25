# SPDX-License-Identifier: GPL-3.0-or-later
"""The NAMED, TYPE-FIRST hardware class (2026-07-22 redesign): a class is identified by
its memory architecture + memory — discrete (VRAM + RAM, the offload split), integrated
(one shared pool), unified (one SoC pool). Covers the format/parse convention (ONE
source), `mem_arch` detection (platform+vendor, no heavy deps), the store
(save/relocate/collision/ensure/cascade-delete), and the extended /v1/ai/class-tunes
router (the `classes` list + the class PUT/DELETE). Pure data; no GPU."""

import sqlalchemy as sa
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from llm_runner.llm import db, stores
from llm_runner.llm.class_tunes_api import make_class_tunes_router
from llm_runner.runner.hardware import (
    banded_class_key, class_key, format_class_key, mem_arch, parse_class_key)


# ── the class_key convention: ONE source, type-first, round-trips ─────────────
def test_format_and_parse_round_trip():
    assert format_class_key("discrete", 8, 32) == "dgpu-vram8|ram32"
    assert format_class_key("integrated", 0, 16) == "igpu-mem16"
    assert format_class_key("unified", 0, 192) == "unified-mem192"
    assert parse_class_key("dgpu-vram8|ram32") == ("discrete", 8, 32)
    assert parse_class_key("igpu-mem16") == ("integrated", 0, 16)
    assert parse_class_key("unified-mem192") == ("unified", 0, 192)
    assert parse_class_key("garbage") == ("integrated", 0, 0)


# ── mem_arch: platform + vendor, no heavy deps ───────────────────────────────
def test_mem_arch_from_platform_and_vendor():
    class _G:
        def __init__(self, vram_mb, name="GPU"): self.vram_mb, self.name = vram_mb, name

    class _H:
        def __init__(self, platform="linux", runtimes=None, gpus=()):
            self.platform, self.runtimes, self.gpus = platform, runtimes or {}, list(gpus)

    assert mem_arch(_H(platform="macos")) == "unified"              # Apple Silicon
    assert mem_arch(_H(runtimes={"cuda": True})) == "discrete"      # NVIDIA
    assert mem_arch(_H(gpus=[_G(16384, "Radeon RX 7800")])) == "discrete"   # >=4 GB dGPU
    assert mem_arch(_H(gpus=[_G(0, "Intel UHD")])) == "integrated"  # iGPU (no dedicated VRAM)
    assert mem_arch(_H()) == "integrated"                           # no GPU → one-pool fallback
    # THE LAPTOP SHAPE (detect-facts 2026-07-23): registry name "Intel(R) Graphics",
    # qwMemorySize ABSENT (vram None) → integrated. And the name-regex kill: an iGPU
    # whose DriverDesc DOES say Arc(TM) (Lunar Lake style) with no dedicated VRAM must
    # classify integrated — a name is marketing, not architecture. A discrete Arc
    # still classifies via its real board VRAM.
    assert mem_arch(_H(gpus=[_G(None, "Intel(R) Graphics")])) == "integrated"
    assert mem_arch(_H(gpus=[_G(None, "Intel(R) Arc(TM) Graphics")])) == "integrated"
    assert mem_arch(_H(gpus=[_G(16384, "Intel(R) Arc(TM) A770 Graphics")])) == "discrete"


def test_snap_ram_gb_standard_ladder():
    from llm_runner.runner.hardware import snap_ram_gb

    # THE FRAGMENTATION CASE (2026-07-23): the Core Ultra laptop reports 31.5 GB
    # (33777467392 bytes) and the desktop 31.9 GB (34280230912 bytes) — raw rounding
    # split two nominal-32 GB machines into mem31 vs ram32. Both snap to 32.
    assert snap_ram_gb(33777467392 // (1024 * 1024)) == 32   # the laptop, exact bytes
    assert snap_ram_gb(34280230912 // (1024 * 1024)) == 32   # the desktop, exact bytes
    assert snap_ram_gb(16384) == 16
    assert snap_ram_gb(15872) == 16       # 15.5 GB (OEM reserve) → 16
    assert snap_ram_gb(65536) == 64
    assert snap_ram_gb(196608) == 192     # Mac Studio pool
    assert snap_ram_gb(0) == 2            # degenerate floor: the lowest rung


def test_class_key_bands_discrete():
    """THE BAND RULING (user, 2026-07-25: "I never thought exact matches should be
    used"): the discrete class key IS the band, so plain exact-match lookup covers
    every real card without fallback machinery — 10/11 GB cards are the 8 band,
    20 → 16, and everything ≥ 24 (a 4090's 24, a 5090's 32) is ONE 24+ band. RAM
    down-snaps the coarse rungs (24 → 16, 48 → 32, 96 → 64). DOWN on both dimensions
    because it can never overstate a box — a config keyed at the band floor fits
    every box above it, never the reverse (the 26B flagship's ~24 GB RAM appetite
    on a 16 GB box is the miss this direction prevents). Sub-band values pass
    through: a 6 GB card is honestly sub-band and matches no band seed."""
    class _G:
        def __init__(self, vram_mb): self.vram_mb, self.name = vram_mb, "GPU"

    class _H:
        def __init__(self, vram_mb, ram_gb):
            self.platform, self.runtimes = "windows", {"cuda": True}
            self.gpus, self.ram_mb = [_G(vram_mb)], ram_gb * 1024

    assert class_key(_H(8192, 32)) == "dgpu-vram8|ram32"    # the 2070S box — unchanged
    assert class_key(_H(8188, 32)) == "dgpu-vram8|ram32"    # jitter round FIRST, then band
    assert class_key(_H(10240, 32)) == "dgpu-vram8|ram32"   # 3080 10 GB → the 8 band
    assert class_key(_H(11264, 32)) == "dgpu-vram8|ram32"   # 2080 Ti 11 GB → the 8 band
    assert class_key(_H(12288, 32)) == "dgpu-vram12|ram32"
    assert class_key(_H(20480, 32)) == "dgpu-vram16|ram32"  # 20 GB → the 16 band
    assert class_key(_H(24576, 32)) == "dgpu-vram24|ram32"  # 4090
    assert class_key(_H(32768, 32)) == "dgpu-vram24|ram32"  # 5090 — the SAME 24+ band
    assert class_key(_H(6144, 32)) == "dgpu-vram6|ram32"    # sub-band passes through
    assert class_key(_H(8192, 16)) == "dgpu-vram8|ram16"
    assert class_key(_H(8192, 24)) == "dgpu-vram8|ram16"    # 24 GB RAM → the 16 rung
    assert class_key(_H(8192, 48)) == "dgpu-vram8|ram32"
    assert class_key(_H(8192, 96)) == "dgpu-vram8|ram64"


def test_banded_class_key_builder():
    """The one banded builder (detection + the panel's create-class derive share it):
    discrete numbers band; one-pool types pass straight through to the raw formatter."""
    assert banded_class_key("discrete", 10, 48) == "dgpu-vram8|ram32"
    assert banded_class_key("discrete", 8, 32) == "dgpu-vram8|ram32"   # band values: identity
    assert banded_class_key("integrated", 0, 16) == "igpu-mem16"       # untouched
    assert banded_class_key("unified", 0, 192) == "unified-mem192"     # untouched


@pytest.fixture
def configured():
    eng = sa.create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    db.create_all(eng)
    db.configure_storage(sessionmaker(bind=eng, autoflush=False))
    yield


# ── the store ────────────────────────────────────────────────────────────────
def test_save_lists_and_edits_name(configured):
    st = stores.get_hardware_class_store()
    st.save("dgpu-vram8|ram32", "discrete", 8, 32, "My PC")
    assert st.list_all() == [{"classKey": "dgpu-vram8|ram32", "memType": "discrete",
                              "vramGb": 8, "ramGb": 32, "name": "My PC", "builtIn": False}]
    st.save("dgpu-vram8|ram32", "discrete", 8, 32, "Renamed", orig_key="dgpu-vram8|ram32")
    assert st.list_all()[0]["name"] == "Renamed"


def test_save_a_unified_class(configured):
    st = stores.get_hardware_class_store()
    st.save("unified-mem192", "unified", 0, 192, "Mac Studio")
    row = st.list_all()[0]
    assert (row["memType"], row["vramGb"], row["ramGb"]) == ("unified", 0, 192)


def test_editing_relocates_and_cascades_configs(configured):
    st = stores.get_hardware_class_store()
    st.save("dgpu-vram8|ram32", "discrete", 8, 32, "Box")
    s = db.session()
    try:
        s.add(db.ClassTune(model_id="m1", class_key="dgpu-vram8|ram32",
                           flag_name="n_cpu_moe", flag_value="21", built_in=False))
        s.commit()
    finally:
        s.close()
    # edit VRAM 8 → 16: the key moves, configs cascade, the old sidecar is gone
    st.save("dgpu-vram16|ram32", "discrete", 16, 32, "Box", orig_key="dgpu-vram8|ram32")
    assert {r["classKey"] for r in st.list_all()} == {"dgpu-vram16|ram32"}
    s = db.session()
    try:
        moved = s.query(db.ClassTune).filter(db.ClassTune.model_id == "m1").one()
        assert moved.class_key == "dgpu-vram16|ram32"
        assert s.query(db.ClassTune).filter(db.ClassTune.class_key == "dgpu-vram8|ram32").count() == 0
    finally:
        s.close()


def test_duplicate_hardware_is_rejected(configured):
    st = stores.get_hardware_class_store()
    st.save("dgpu-vram8|ram32", "discrete", 8, 32, "First")
    with pytest.raises(ValueError):
        st.save("dgpu-vram8|ram32", "discrete", 8, 32, "Second")
    st.save("dgpu-vram16|ram16", "discrete", 16, 16, "Other")
    with pytest.raises(ValueError):
        st.save("dgpu-vram8|ram32", "discrete", 8, 32, "Other", orig_key="dgpu-vram16|ram16")


def test_ensure_creates_blank_named_then_noops(configured):
    st = stores.get_hardware_class_store()
    st.ensure("dgpu-vram8|ram32", "discrete", 8, 32)
    assert st.list_all()[0]["name"] == ""
    st.save("dgpu-vram8|ram32", "discrete", 8, 32, "Named", orig_key="dgpu-vram8|ram32")
    st.ensure("dgpu-vram8|ram32", "discrete", 8, 32)  # must NOT clobber the name
    assert st.list_all()[0]["name"] == "Named"


def test_delete_removes_class_and_its_configs(configured):
    st = stores.get_hardware_class_store()
    st.save("dgpu-vram8|ram32", "discrete", 8, 32, "Box")
    s = db.session()
    try:
        s.add(db.ClassTune(model_id="m1", class_key="dgpu-vram8|ram32",
                           flag_name="threads", flag_value="8", built_in=False))
        s.commit()
    finally:
        s.close()
    st.delete("dgpu-vram8|ram32")
    assert st.list_all() == []
    s = db.session()
    try:
        assert s.query(db.ClassTune).filter(db.ClassTune.class_key == "dgpu-vram8|ram32").count() == 0
    finally:
        s.close()


# ── the router (the wired seam) ──────────────────────────────────────────────
@pytest.fixture
def client(configured):
    app = FastAPI()
    app.include_router(make_class_tunes_router(
        stores.get_class_tune_store, lambda: "dgpu-vram8|ram32",
        hw_class_store=stores.get_hardware_class_store,
        # the BANDED derive, mirroring install.py (2026-07-25): typed numbers land
        # in their band, so a hand-made class always matches what detection emits.
        derive_key_fn=banded_class_key, parse_key_fn=parse_class_key))
    return TestClient(app)


def test_put_discrete_class_derives_key(client):
    r = client.put("/v1/ai/hardware-class", json={
        "name": "My PC", "memType": "discrete", "vramGb": 16, "ramGb": 16}).json()
    cls = next(c for c in r["classes"] if c["classKey"] == "dgpu-vram16|ram16")
    assert (cls["name"], cls["memType"], cls["vramGb"], cls["ramGb"]) == ("My PC", "discrete", 16, 16)


def test_put_discrete_class_bands_typed_numbers(client):
    """A hand-typed micro-class lands in its BAND (the derive is banded_class_key,
    mirroring install.py) — otherwise a user typing their card's true 10 GB would
    mint a class detection can never match. The stored row's numbers are re-read
    FROM the banded key, so row and key can never disagree."""
    r = client.put("/v1/ai/hardware-class", json={
        "name": "3080 rig", "memType": "discrete", "vramGb": 10, "ramGb": 48}).json()
    cls = next(c for c in r["classes"] if c["classKey"] == "dgpu-vram8|ram32")
    assert (cls["vramGb"], cls["ramGb"]) == (8, 32)   # key-derived, not the typed 10/48


def test_put_unified_class_zeroes_vram_and_keys_on_memory(client):
    r = client.put("/v1/ai/hardware-class", json={
        "name": "Mac", "memType": "unified", "vramGb": 999, "ramGb": 192}).json()
    cls = next(c for c in r["classes"] if c["classKey"] == "unified-mem192")
    assert cls["vramGb"] == 0  # one-pool types carry no separate VRAM even if sent


def test_put_discrete_without_vram_is_rejected(client):
    assert client.put("/v1/ai/hardware-class", json={
        "name": "x", "memType": "discrete", "vramGb": 0, "ramGb": 32}).status_code == 400


def test_put_rejects_zero_memory_and_bad_type(client):
    assert client.put("/v1/ai/hardware-class", json={
        "name": "x", "memType": "integrated", "vramGb": 0, "ramGb": 0}).status_code == 400
    assert client.put("/v1/ai/hardware-class", json={
        "name": "x", "memType": "gpu", "vramGb": 0, "ramGb": 16}).status_code == 400


def test_config_put_auto_ensures_its_class(client):
    r = client.put("/v1/ai/class-tunes", json={
        "modelId": "m1", "classKey": "dgpu-vram8|ram32",
        "switches": [{"flagName": "n_cpu_moe", "flagValue": "21"}]}).json()
    cls = next(c for c in r["classes"] if c["classKey"] == "dgpu-vram8|ram32")
    assert cls["memType"] == "discrete"  # parsed from the key by ensure
    assert any(t["modelId"] == "m1" for t in r["tunes"])


def test_delete_hardware_class_via_router(client):
    client.put("/v1/ai/hardware-class", json={
        "name": "z", "memType": "integrated", "vramGb": 0, "ramGb": 16})
    r = client.request("DELETE", "/v1/ai/hardware-class",
                       params={"classKey": "igpu-mem16"}).json()
    assert all(c["classKey"] != "igpu-mem16" for c in r["classes"])
