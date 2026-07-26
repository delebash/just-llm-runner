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


# ── §7.6 (2026-07-08): baseline drift + provenance source + the /state summary ─

def _client_with_deps(baseline_holder, measurements, class_configs):
    """A router with every §7.6 dep injected. `baseline_holder` is a mutable
    one-key dict {"now": {...}} so a test can move today's defaults AFTER an
    apply — exactly the drift scenario."""
    eng = sa.create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    db.create_all(eng)
    db.configure_storage(sessionmaker(bind=eng, autoflush=False))
    app = FastAPI()
    app.include_router(make_model_tunes_router(
        stores.get_model_tune_store, lambda: "test-key",
        resolve_baseline=lambda _mid: dict(baseline_holder["now"]),
        measurements_fn=lambda _mid: measurements,
        class_key_fn=lambda: "vram8|ram32",
        class_configs_fn=lambda: class_configs,
    ))
    return TestClient(app)


def test_apply_stores_baseline_and_reports_drift():
    from types import SimpleNamespace as NS

    holder = {"now": {"ctx_len": "8192", "mlock": "true"}}
    client = _client_with_deps(holder, [], [])
    r = client.put("/v1/ai/model-tunes", json={"modelId": "m1", "switches": [
        {"flagName": "ctx_len", "flagValue": "32768"}]}).json()
    assert r["driftCount"] == 0  # today's defaults == the baseline stored at apply
    # The defaults MOVE after the apply (a global/class edit): drift is per-key —
    # one changed value + one new key = 2.
    holder["now"] = {"ctx_len": "16384", "mlock": "true", "no_mmap": "true"}
    g = client.get("/v1/ai/model-tunes", params={"modelId": "m1"}).json()
    assert g["driftCount"] == 2
    # Remove → back to no tune, no drift claim.
    d = client.delete("/v1/ai/model-tunes", params={"modelId": "m1"}).json()
    assert d["rows"] == [] and d["driftCount"] is None
    _ = NS  # silence unused import in this test


def test_pre_baseline_tune_reports_unknowable_drift():
    holder = {"now": {"ctx_len": "8192"}}
    client = _client_with_deps(holder, [], [])
    from llm_runner.llm.model_tunes_api import ModelTuneFlag

    # A tune written WITHOUT a baseline (the pre-§7.6 path / a legacy row).
    stores.get_model_tune_store().replace(
        "old", "test-key", [ModelTuneFlag(flagName="threads", flagValue="8")], baseline=None)
    g = client.get("/v1/ai/model-tunes", params={"modelId": "old"}).json()
    assert g["rows"] and g["driftCount"] is None


def test_source_auto_when_rows_equal_an_autotune_trial_else_hand():
    from types import SimpleNamespace as NS

    trial = NS(source="autotune", switches=[NS(flagName="n_cpu_moe", flagValue="21")])
    holder = {"now": {}}
    client = _client_with_deps(holder, [trial], [])
    # Applied == the trial verbatim → auto.
    r = client.put("/v1/ai/model-tunes", json={"modelId": "m1", "switches": [
        {"flagName": "n_cpu_moe", "flagValue": "21"}]}).json()
    assert r["source"] == "auto"
    # A hand tweak after the sweep → hand.
    r2 = client.put("/v1/ai/model-tunes", json={"modelId": "m1", "switches": [
        {"flagName": "n_cpu_moe", "flagValue": "20"}]}).json()
    assert r2["source"] == "hand"


def test_state_summarizes_tuned_and_class_configured_models():
    from types import SimpleNamespace as NS

    trial = NS(source="autotune", switches=[NS(flagName="threads", flagValue="8")])
    class_configs = [
        NS(modelId="gemma", classKey="vram8|ram32", rows=[NS(flagName="ctx_len", flagValue="32768")]),
        NS(modelId="qwen", classKey="vram24|ram64", rows=[NS(flagName="ctx_len", flagValue="65536")]),
    ]
    holder = {"now": {}}
    client = _client_with_deps(holder, [trial], class_configs)
    client.put("/v1/ai/model-tunes", json={"modelId": "m1", "switches": [
        {"flagName": "threads", "flagValue": "8"}]})
    client.put("/v1/ai/model-tunes", json={"modelId": "m2", "switches": [
        {"flagName": "threads", "flagValue": "4"}]})
    st = client.get("/v1/ai/model-tunes/state").json()
    assert st["hwKey"] == "test-key" and st["classKey"] == "vram8|ram32"
    assert st["tuned"] == {"m1": "auto", "m2": "hand"}
    # Only the config matching THIS box's class counts; the vram24 row does not.
    assert st["classConfigured"] == ["gemma"]


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
