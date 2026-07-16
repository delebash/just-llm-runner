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


def test_knob_tiers_and_expanded_set(wired):
    """The Common/Advanced tier split + the expanded knob set (with cited defaults)."""
    by_name = {k["flagName"]: k for k in stores.list_knob_catalog()}
    # Tier drives the UI checklist split — common shown, advanced behind an expander.
    assert by_name["ctx_len"]["tier"] == "common"
    assert by_name["top_k"]["tier"] == "common"
    assert by_name["repeat_last_n"]["tier"] == "common"
    assert by_name["mlock"]["tier"] == "advanced"
    assert by_name["mirostat_tau"]["tier"] == "advanced"
    # The expanded set landed, with the README-cited defaults.
    assert by_name["repeat_last_n"]["default"] == "64"
    assert by_name["mirostat_tau"]["default"] == "5.0"
    assert by_name["top_n_sigma"]["default"] == "-1.0"
    # The 4 already-plumbed switches are present (Plane-1); cont_batching is a bool.
    assert by_name["ubatch_size"]["plane"] == 1
    assert by_name["cont_batching"]["plane"] == 1 and by_name["cont_batching"]["kind"] == "bool"
    # reasoning_budget is the ONE per-request plane-1 switch (sent as JSON per request, not
    # a launch flag); every other plane-1 switch is a launch flag → perRequest False.
    assert by_name["reasoning_budget"]["plane"] == 1 and by_name["reasoning_budget"]["perRequest"] is True
    assert by_name["cont_batching"]["perRequest"] is False


def test_plane1_carries_no_engine_default_claims(wired):
    """QC-17 + QC-18 (user, 2026-07-09): plane-1 switches carry NO default_value
    (the app stopped storing the engine's own defaults) and NO options (values are
    plain text/number boxes; the HELP names the accepted values). Plane-2 sampler
    prefills are untouched."""
    knobs = stores.list_knob_catalog()
    for k in knobs:
        if k["plane"] == 1:
            assert k["default"] == "", f'{k["flagName"]} still stores a default claim'
            assert k["options"] == [], f'{k["flagName"]} still carries options'
    by_name = {k["flagName"]: k for k in knobs}
    assert "f32, f16, bf16, q8_0, q4_0, q4_1, iq4_nl, q5_0, q5_1" in by_name["cache_type_k"]["help"]
    assert "on, off, auto" in by_name["flash_attn"]["help"]
    # QC-11: context_shift + cache_reuse are OUT of the catalog entirely.
    assert "context_shift" not in by_name and "cache_reuse" not in by_name
    # Plane-2 keeps its prefill defaults (samplers untouched).
    assert by_name["temperature"]["default"] == "0.7"


def test_seed_curates_existing_dbs(wired):
    """Existing DBs converge on boot (the seeder SYNCS built-in rows — the catalog
    is app-owned, GET-only): a QC-11 removed row is deleted, its options go with
    it, and a stale plane-1 default_value/option set is cleared."""
    s = db.session()
    # Recreate the pre-QC-17 era-1 state by hand.
    s.add(db.KnobCatalog(flag_name="context_shift", kind="bool",
                         default_value="true", plane=1, tier="advanced", built_in=True))
    s.flush()
    s.add(db.KnobOption(flag_name="cache_type_k", value="q8_0", label="q8_0",
                        position=0, built_in=True))
    row = s.query(db.KnobCatalog).filter(db.KnobCatalog.flag_name == "cache_type_k").one()
    row.default_value = "q8_0"
    s.commit()
    s.close()

    s = db.session()
    seed.seed_default_knobs(s)
    s.commit()
    s.close()

    by_name = {k["flagName"]: k for k in stores.list_knob_catalog()}
    assert "context_shift" not in by_name
    assert by_name["cache_type_k"]["default"] == "" and by_name["cache_type_k"]["options"] == []


def test_knob_catalog_endpoint(wired):
    app = FastAPI()
    app.include_router(make_knob_catalog_router(stores.list_knob_catalog))
    r = TestClient(app).get("/v1/ai/knob-catalog")
    assert r.status_code == 200
    knobs = r.json()["knobs"]
    ctk = next(k for k in knobs if k["flagName"] == "cache_type_k")
    assert ctk["options"] == [] and "Accepts" in ctk["help"]
