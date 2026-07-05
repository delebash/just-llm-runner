# SPDX-License-Identifier: GPL-3.0-or-later
"""The per-(model, machine) tune surface (Plan B): the /v1/ai/model-tunes CRUD
(server-derived hw_key; PUT replaces the whole set — verbatim-snapshot D5) and
the whole-machine `machine_key` (gpu|vram|cores|ramGB — D2)."""

import sqlalchemy as sa
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from llm_runner.llm import db, stores
from llm_runner.llm.model_tunes_api import make_model_tunes_router
from llm_runner.runner.hardware import machine_key
from llm_runner.runner.schema import GpuInfo, HardwareInfo


@pytest.fixture
def client():
    eng = sa.create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    db.create_all(eng)
    db.configure_storage(sessionmaker(bind=eng, autoflush=False))
    app = FastAPI()
    # hw_key_fn injected — the SERVER derives the machine key (one source).
    app.include_router(make_model_tunes_router(stores.get_model_tune_store, lambda: "test-key"))
    return TestClient(app)


def test_put_get_delete_round_trip(client):
    body = {"modelId": "m1", "switches": [
        {"flagName": "n_cpu_moe", "flagValue": "37"},
        {"flagName": "spec_type", "flagValue": "draft-mtp"},
        {"flagName": "", "flagValue": "dropped"},          # empty name → dropped
    ]}
    r = client.put("/v1/ai/model-tunes", json=body).json()
    assert r["modelId"] == "m1" and r["hwKey"] == "test-key"
    assert {(x["flagName"], x["flagValue"]) for x in r["rows"]} == {
        ("n_cpu_moe", "37"), ("spec_type", "draft-mtp")}
    # GET returns the same set
    g = client.get("/v1/ai/model-tunes", params={"modelId": "m1"}).json()
    assert len(g["rows"]) == 2 and g["hwKey"] == "test-key"
    # DELETE → empty ("Remove saved tune")
    d = client.delete("/v1/ai/model-tunes", params={"modelId": "m1"}).json()
    assert d["rows"] == []


def test_put_replaces_the_whole_set(client):
    client.put("/v1/ai/model-tunes", json={"modelId": "m1", "switches": [
        {"flagName": "threads", "flagValue": "8"}, {"flagName": "batch_size", "flagValue": "64"}]})
    r = client.put("/v1/ai/model-tunes", json={"modelId": "m1", "switches": [
        {"flagName": "threads", "flagValue": "6"}]}).json()
    # verbatim snapshot: the old batch_size row is GONE, not merged (D5)
    assert [(x["flagName"], x["flagValue"]) for x in r["rows"]] == [("threads", "6")]


def test_tunes_are_isolated_per_model(client):
    client.put("/v1/ai/model-tunes", json={"modelId": "m1", "switches": [
        {"flagName": "threads", "flagValue": "8"}]})
    assert client.get("/v1/ai/model-tunes", params={"modelId": "m2"}).json()["rows"] == []


def test_missing_model_id_400(client):
    assert client.get("/v1/ai/model-tunes", params={"modelId": " "}).status_code == 400
    assert client.put("/v1/ai/model-tunes", json={"modelId": "", "switches": []}).status_code == 400


# ── machine_key (D2 — whole machine, not GPU-only) ───────────────────────────

def test_machine_key_gpu_shape():
    hw = HardwareInfo(os="Windows", platform="windows", cpu_cores=8, ram_mb=32768,
                      gpus=[GpuInfo(vendor="NVIDIA", name="NVIDIA GeForce RTX 2070 SUPER",
                                    vram_mb=8192, driver="551.61")])
    assert machine_key(hw) == "NVIDIA GeForce RTX 2070 SUPER|8192|8c|32g"


def test_machine_key_cpu_only_and_ram_rounding():
    hw = HardwareInfo(os="Linux", platform="linux", cpu_cores=6, ram_mb=32700, gpus=[])
    assert machine_key(hw) == "cpu|6c|31g"   # whole-GB floor absorbs MB jitter


def test_machine_key_differs_on_cpu_ram_not_just_gpu():
    # Two boxes with the SAME GPU but different CPU/RAM must not collide —
    # threads/batch are CPU/RAM-bound (the Google-corroborated D2 point).
    gpu = GpuInfo(vendor="NVIDIA", name="RTX 4090", vram_mb=24576)
    a = HardwareInfo(os="l", platform="linux", cpu_cores=8, ram_mb=32768, gpus=[gpu])
    b = HardwareInfo(os="l", platform="linux", cpu_cores=16, ram_mb=65536, gpus=[gpu])
    assert machine_key(a) != machine_key(b)


def test_machine_key_picks_largest_gpu():
    hw = HardwareInfo(os="l", platform="linux", cpu_cores=8, ram_mb=65536, gpus=[
        GpuInfo(vendor="NVIDIA", name="RTX 3060", vram_mb=12288),
        GpuInfo(vendor="NVIDIA", name="RTX 4090", vram_mb=24576)])
    assert machine_key(hw).startswith("RTX 4090|24576|")
