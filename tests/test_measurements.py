# SPDX-License-Identifier: MIT
"""The persistent measurement history (#142 rows 5+6): the model_measurements
store + the /v1/ai/model-measurements GET/POST/DELETE surface (server-stamped
machineKey + at, per-model + clear-all semantics) and the auto-tune record seam
(every OK trial persists; a history-write failure never harms the sweep)."""

import sqlalchemy as sa
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from llm_runner.llm import db, stores
from llm_runner.llm.model_measurements_api import (
    MeasurementFlag,
    make_model_measurements_router,
)
from llm_runner.runner.autotune import AutoTuner

from test_autotune import BASE, FakeService, _run_to_end


@pytest.fixture
def client():
    eng = sa.create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    db.create_all(eng)
    db.configure_storage(sessionmaker(bind=eng, autoflush=False))
    app = FastAPI()
    # machine_key_fn injected — the SERVER stamps which box measured (one source).
    app.include_router(make_model_measurements_router(
        stores.get_model_measurement_store, lambda: "gpu|8g|8c|32g"))
    return TestClient(app)


def _post(client, model_id, tps, switches=None, **kw):
    return client.post("/v1/ai/model-measurements", json={
        "modelId": model_id, "tokensPerSec": tps,
        "switches": [{"flagName": k, "flagValue": v} for k, v in (switches or {}).items()],
        **kw,
    }).json()


def test_post_records_with_server_stamped_identity_and_clock(client):
    r = _post(client, "m1", 31.5, {"n_cpu_moe": "21", "ctx_len": "32768"},
              label="", vramTotalMb=7200)
    assert r["machineKey"] == "gpu|8g|8c|32g"
    assert len(r["measurements"]) == 1
    m = r["measurements"][0]
    assert (m["modelId"], m["source"], m["tokensPerSec"], m["vramTotalMb"]) == (
        "m1", "tune", 31.5, 7200)
    assert m["machineKey"] == "gpu|8g|8c|32g"   # server-stamped, never client-supplied
    assert m["at"] > 0                          # server clock, epoch ms
    assert {(s["flagName"], s["flagValue"]) for s in m["switches"]} == {
        ("n_cpu_moe", "21"), ("ctx_len", "32768")}


def test_get_is_newest_first_and_model_filtered(client):
    _post(client, "m1", 10.0)
    _post(client, "m2", 20.0)
    _post(client, "m1", 30.0)
    everything = client.get("/v1/ai/model-measurements").json()["measurements"]
    assert [m["tokensPerSec"] for m in everything] == [30.0, 20.0, 10.0]  # newest first
    only_m1 = client.get("/v1/ai/model-measurements", params={"modelId": "m1"}).json()
    assert [m["tokensPerSec"] for m in only_m1["measurements"]] == [30.0, 10.0]


def test_clear_per_model_then_all(client):
    _post(client, "m1", 10.0, {"threads": "8"})
    _post(client, "m2", 20.0)
    # Per-model clear (the Tune modal's Clear-history button) leaves other models.
    r = client.delete("/v1/ai/model-measurements", params={"modelId": "m1"}).json()
    assert r["measurements"] == []
    rest = client.get("/v1/ai/model-measurements").json()["measurements"]
    assert [m["modelId"] for m in rest] == ["m2"]
    # No modelId → the whole ledger; child switch rows die with their parents.
    client.delete("/v1/ai/model-measurements")
    assert client.get("/v1/ai/model-measurements").json()["measurements"] == []
    s = db.session()
    try:
        assert s.query(db.MeasurementSwitch).count() == 0
    finally:
        s.close()


def test_post_requires_model_id(client):
    assert client.post("/v1/ai/model-measurements",
                       json={"modelId": " ", "tokensPerSec": 1}).status_code == 400


def test_store_record_dedupes_and_skips_blank_flag_names(client):
    mid = stores.get_model_measurement_store().record(
        "m1", machine_key="k", source="tune", label="", tokens_per_sec=1.0,
        vram_total_mb=0, at=5,
        rows=[MeasurementFlag(flagName="a", flagValue="1"),
              MeasurementFlag(flagName="a", flagValue="2"),
              MeasurementFlag(flagName="  ", flagValue="x")])
    rows = stores.get_model_measurement_store().list("m1")
    assert rows[0].id == mid
    assert [(f.flagName, f.flagValue) for f in rows[0].switches] == [("a", "1")]


# ── the auto-tune record seam (offline, the FakeService harness) ──────────────

def test_autotune_records_every_ok_trial_with_its_switches():
    recorded = []
    svc = FakeService(tps_by_ncmoe={"21": 30.0, "23": 28.0, "19": 26.0})
    st = _run_to_end(AutoTuner(service_fn=lambda: svc, sleep=lambda s: None),
                     "m", BASE, record_fn=lambda mid, t: recorded.append((mid, t)))
    assert st["status"] == "done"
    ok_trials = [t for t in st["trials"] if t["ok"]]
    assert [t["label"] for _, t in recorded] == [t["label"] for t in ok_trials]
    assert all(mid == "m" for mid, _ in recorded)
    # the recorded trial carries the exact switches that produced the number
    base_rec = next(t for _, t in recorded if t["label"] == "baseline")
    assert base_rec["switches"]["n_cpu_moe"] == "21"


def test_autotune_skips_failed_trials_and_survives_a_broken_recorder():
    # A trial that never reaches running records nothing; a recorder that RAISES
    # must neither kill the sweep nor mark it errored (history is an enrichment).
    calls = []

    def boom(mid, trial):
        calls.append(trial["label"])
        raise RuntimeError("history db is on fire")

    svc = FakeService(tps_by_ncmoe={"21": 30.0, "23": 28.0, "19": 26.0}, fail=("23",))
    st = _run_to_end(AutoTuner(service_fn=lambda: svc, sleep=lambda s: None),
                     "m", BASE, record_fn=boom)
    assert st["status"] == "done" and not st["error"]
    assert "n-cpu-moe 23" not in calls           # the failed trial never recorded
    assert calls                                 # the OK trials still hit the sink


# ── Phase 5 (§6.3/§13.2): footprint columns + keep-K retention ───────────────


def test_record_carries_footprint_and_kind_and_wire_declares_them(client):
    st = stores.get_model_measurement_store()
    st.record("m1", machine_key="box", source="load", label="load footprint (measured)",
              tokens_per_sec=0.0, vram_total_mb=0, at=1000,
              rows=[MeasurementFlag(flagName="ctx_len", flagValue="32768")],
              vram_model_mb=6500, kind="llm")
    row = st.list("m1")[0]
    assert row.vramModelMb == 6500 and row.kind == "llm" and row.source == "load"
    # The HTTP wire must not strip the new fields (the documented Pydantic class).
    wire = client.get("/v1/ai/model-measurements?modelId=m1").json()["measurements"][0]
    assert wire["vramModelMb"] == 6500 and wire["kind"] == "llm"


def test_prune_keeps_latest_k_per_fingerprint(client):
    st = stores.get_model_measurement_store()
    fset = {"ctx_len", "n_gpu_layers"}
    for i in range(5):  # five loads at the SAME fingerprint
        st.record("m1", machine_key="box", source="load", label="",
                  tokens_per_sec=0.0, vram_total_mb=0, at=1000 + i,
                  rows=[MeasurementFlag(flagName="ctx_len", flagValue="32768"),
                        MeasurementFlag(flagName="threads", flagValue=str(i))],  # fit-IRRELEVANT
                  vram_model_mb=6000 + i)
    # A DIFFERENT fingerprint (other ctx) must keep its own K, not be collateral.
    st.record("m1", machine_key="box", source="load", label="",
              tokens_per_sec=0.0, vram_total_mb=0, at=99,
              rows=[MeasurementFlag(flagName="ctx_len", flagValue="4096")],
              vram_model_mb=5000)
    # A speed row is NEVER pruned by the load retention.
    st.record("m1", machine_key="box", source="tune", label="",
              tokens_per_sec=25.0, vram_total_mb=8192, at=50, rows=[])
    deleted = st.prune_load_rows("m1", "box", fset, keep=3)
    assert deleted == 2  # 5 same-fingerprint rows → newest 3 survive
    rows = st.list("m1")
    loads = [r for r in rows if r.source == "load"]
    assert len(loads) == 4  # 3 kept + the other-fingerprint row
    assert {r.vramModelMb for r in loads} == {6004, 6003, 6002, 5000}
    assert any(r.source == "tune" for r in rows)  # speed history untouched


def test_fit_relevant_fingerprint_set_is_seeded(client):
    # §13.3: the fingerprint IS knob_catalog's fit_relevant classification —
    # exactly the ten memory-shaping knobs, read from data, never a code list.
    from llm_runner.llm import seed

    s = db.session()
    try:
        seed.seed_default_knobs(s)
        s.commit()
    finally:
        s.close()
    assert stores.list_fit_relevant_flags() == {
        "ctx_len", "cache_type_k", "cache_type_v", "flash_attn", "n_cpu_moe",
        "n_gpu_layers", "no_kv_offload", "parallel", "batch_size", "ubatch_size"}
