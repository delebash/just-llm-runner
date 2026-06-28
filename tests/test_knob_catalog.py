# SPDX-License-Identifier: GPL-3.0-or-later
"""knob_catalog — the friendly KnobGrid metadata (C1): seed, the options join,
and the /v1/ai/knob-catalog endpoint."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from llm_runner.llm import db, seed, stores
from llm_runner.llm.knob_catalog_api import make_knob_catalog_router


@pytest.fixture
def wired():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    db.configure_storage(sessionmaker(bind=engine, autocommit=False, autoflush=False))
    db.create_all(engine)
    s = db.session()
    seed.seed_default_knobs(s)
    s.commit()
    s.close()
    return engine


def test_seed_populates_knob_catalog(wired):
    knobs = stores.list_knob_catalog()
    assert len(knobs) == len(seed.DEFAULT_KNOBS)
    by_name = {k["flagName"]: k for k in knobs}
    # A Plane-1 switch + a Plane-2 sampler both landed.
    assert by_name["n_cpu_moe"]["plane"] == 1 and by_name["n_cpu_moe"]["appliesTo"] == "moe"
    assert by_name["temperature"]["plane"] == 2 and by_name["temperature"]["kind"] == "float"
    # Plane order: every plane-1 knob sorts before every plane-2 knob.
    planes = [k["plane"] for k in knobs]
    assert planes == sorted(planes)


def test_enum_options_join(wired):
    by_name = {k["flagName"]: k for k in stores.list_knob_catalog()}
    # flash_attn carries its enum options; a non-enum knob carries none.
    fa = by_name["flash_attn"]
    assert fa["kind"] == "enum"
    assert [o["value"] for o in fa["options"]] == ["on", "off", "auto"]
    assert by_name["ctx_len"]["options"] == []


def test_knob_catalog_endpoint(wired):
    app = FastAPI()
    app.include_router(make_knob_catalog_router(stores.list_knob_catalog))
    r = TestClient(app).get("/v1/ai/knob-catalog")
    assert r.status_code == 200
    knobs = r.json()["knobs"]
    assert any(k["flagName"] == "cache_type_k" and k["options"] for k in knobs)
