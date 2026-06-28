# SPDX-License-Identifier: GPL-3.0-or-later
"""JobPresetStore — CRUD + the `promote` that writes the live job_route +
job_route_switches (D3; the per-job replacement for routing-presets)."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from llm_runner.llm import db, stores
from llm_runner.llm.job_presets_api import JobPreset, JobPresetSwitchRow, make_job_presets_router


@pytest.fixture
def wired():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    db.configure_storage(sessionmaker(bind=engine, autocommit=False, autoflush=False))
    db.create_all(engine)
    return engine


def _mk(job="prose", name="Fast draft", model="qwen3.5-9b-q4_k_m", switches=None):
    return JobPreset(
        jobId=job, name=name, providerId="local-llamacpp", model=model,
        switches=switches or [JobPresetSwitchRow(flagName="ctx_len", flagValue="8192")],
    )


def test_save_list_roundtrip(wired):
    store = stores.get_job_preset_store()
    out = store.save_preset(_mk())
    assert out.id and out.builtIn is False and out.jobId == "prose"
    rows = store.list_presets()
    assert len(rows) == 1
    assert rows[0].model == "qwen3.5-9b-q4_k_m"
    assert [(s.flagName, s.flagValue) for s in rows[0].switches] == [("ctx_len", "8192")]


def test_save_replaces_switches(wired):
    store = stores.get_job_preset_store()
    p = store.save_preset(_mk(switches=[JobPresetSwitchRow(flagName="ctx_len", flagValue="4096")]))
    p.switches = [JobPresetSwitchRow(flagName="flash_attn", flagValue="on")]
    store.save_preset(p)
    got = next(r for r in store.list_presets() if r.id == p.id)
    assert [(s.flagName, s.flagValue) for s in got.switches] == [("flash_attn", "on")]


def test_delete(wired):
    store = stores.get_job_preset_store()
    p = store.save_preset(_mk())
    store.delete_preset(p.id)
    assert store.list_presets() == []


def test_promote_writes_live_job_route_and_switches(wired):
    store = stores.get_job_preset_store()
    p = store.save_preset(_mk(
        job="analysis", model="qwen3.6-27b-mtp-q4_k_m",
        switches=[JobPresetSwitchRow(flagName="ctx_len", flagValue="32768"),
                  JobPresetSwitchRow(flagName="flash_attn", flagValue="on")],
    ))
    store.promote(p.id)

    # The live routing config now routes `analysis` to the preset's model...
    routing = stores.get_routing_store().get_routing()
    target = routing.jobs["analysis"]
    assert target.providerId == "local-llamacpp"
    assert target.model == "qwen3.6-27b-mtp-q4_k_m"
    assert target.quality == ""  # an explicit promoted model, not a dial pick
    # ...and the job's switches are the preset's.
    sw = stores.get_job_route_switch_store().list("active", "analysis")
    assert {(r.flagName, r.flagValue) for r in sw} == {("ctx_len", "32768"), ("flash_attn", "on")}


def test_endpoint_crud_and_promote(wired):
    app = FastAPI()
    app.include_router(make_job_presets_router(stores.get_job_preset_store))
    c = TestClient(app)
    assert c.get("/v1/ai/job-presets").json() == {"presets": []}
    created = c.post("/v1/ai/job-presets", json={"jobId": "chat", "name": "Snappy", "providerId": "local-llamacpp", "model": "qwen3.5-9b-q4_k_m"}).json()
    pid = created["presets"][0]["id"]
    assert c.post(f"/v1/ai/job-presets/{pid}/promote").status_code == 200
    assert stores.get_routing_store().get_routing().jobs["chat"].model == "qwen3.5-9b-q4_k_m"
    assert c.request("DELETE", f"/v1/ai/job-presets/{pid}").json() == {"presets": []}
