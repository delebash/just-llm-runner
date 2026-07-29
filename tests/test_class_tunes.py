# SPDX-License-Identifier: MIT
"""The hardware-class tune library (ROUND 8 Task C): the /v1/ai/class-tunes CRUD
(server-derived current class via the injected class_key_fn; PUT replaces the
(model, class) set wholesale and marks it user-owned) and the seeder's
merge-by-(model, class) guarantee — a user-edited config is never clobbered."""

import sqlalchemy as sa
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from llm_runner.llm import db, stores
from llm_runner.llm.class_tunes_api import make_class_tunes_router
from llm_runner.llm.seed import seed_default_class_tunes


@pytest.fixture
def client():
    eng = sa.create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    db.create_all(eng)
    db.configure_storage(sessionmaker(bind=eng, autoflush=False))
    app = FastAPI()
    # class_key_fn injected — the SERVER derives the box's class (one source).
    app.include_router(make_class_tunes_router(stores.get_class_tune_store, lambda: "dgpu-vram8|ram32"))
    return TestClient(app)


def _put(client, model_id, switches, class_key=""):
    return client.put("/v1/ai/class-tunes", json={
        "modelId": model_id, "classKey": class_key,
        "switches": [{"flagName": k, "flagValue": v} for k, v in switches.items()],
    }).json()


def test_put_defaults_to_the_current_class_and_round_trips(client):
    # Omitted classKey → the box's own class (the Tune modal's "Save for hardware
    # class" path). The response is the whole library + the current class.
    r = _put(client, "m1", {"n_cpu_moe": "21", "ctx_len": "32768"})
    assert r["classKey"] == "dgpu-vram8|ram32"
    assert len(r["tunes"]) == 1
    t = r["tunes"][0]
    assert (t["modelId"], t["classKey"], t["builtIn"]) == ("m1", "dgpu-vram8|ram32", False)
    assert {(x["flagName"], x["flagValue"]) for x in t["rows"]} == {
        ("n_cpu_moe", "21"), ("ctx_len", "32768")}


def test_put_explicit_class_and_wholesale_replace(client):
    # An explicit classKey targets ANY class (add a row for a box you don't own /
    # import another user's config); PUT replaces the whole set — verbatim snapshot.
    _put(client, "m1", {"threads": "8", "batch_size": "512"}, class_key="vram16|ram64")
    r = _put(client, "m1", {"threads": "6"}, class_key="vram16|ram64")
    t = next(x for x in r["tunes"] if x["classKey"] == "vram16|ram64")
    assert [(x["flagName"], x["flagValue"]) for x in t["rows"]] == [("threads", "6")]


def test_delete_removes_one_config_only(client):
    _put(client, "m1", {"threads": "8"})
    _put(client, "m1", {"threads": "4"}, class_key="cpu|ram16")
    r = client.delete("/v1/ai/class-tunes",
                      params={"modelId": "m1", "classKey": "cpu|ram16"}).json()
    assert [(t["modelId"], t["classKey"]) for t in r["tunes"]] == [("m1", "dgpu-vram8|ram32")]


def test_validation_400s(client):
    assert client.put("/v1/ai/class-tunes", json={"modelId": " ", "switches": [
        {"flagName": "threads", "flagValue": "8"}]}).status_code == 400
    # a config with no usable switch rows is a mistake, not an empty save
    assert client.put("/v1/ai/class-tunes", json={"modelId": "m1", "switches": []}).status_code == 400
    assert client.delete("/v1/ai/class-tunes", params={"modelId": "m1", "classKey": " "}).status_code == 400


def test_builtin_flag_reads_seeded_rows_and_edit_takes_ownership(client):
    # Plant a seeded (built-in) config directly, the way seed_default_class_tunes
    # writes it; the library reports builtIn until a PUT replaces it as user rows.
    s = db.session()
    try:
        s.add(db.ClassTune(model_id="m9", class_key="dgpu-vram8|ram32",
                           flag_name="n_cpu_moe", flag_value="21", built_in=True))
        s.commit()
    finally:
        s.close()
    t = client.get("/v1/ai/class-tunes").json()["tunes"][0]
    assert t["builtIn"] is True
    t = _put(client, "m9", {"n_cpu_moe": "19"})["tunes"][0]
    assert t["builtIn"] is False


def test_seeder_never_clobbers_an_edited_config(client):
    # The boot seeder inserts a built-in config only when its (model, class) has NO
    # rows — an edit through the API survives every later seed pass. (Deleting a
    # built-in config re-seeds it on the next pass — the documented flip side.)
    _put(client, "gemma-4-26b-a4b-qat", {"n_cpu_moe": "19"})  # the seeded row's keys, edited
    s = db.session()
    try:
        seed_default_class_tunes(s)
        s.commit()
        rows = s.query(db.ClassTune).filter(
            db.ClassTune.model_id == "gemma-4-26b-a4b-qat",
            db.ClassTune.class_key == "dgpu-vram8|ram32",
        ).all()
        assert {(r.flag_name, r.flag_value) for r in rows} == {("n_cpu_moe", "19")}
        assert all(r.built_in is False for r in rows)
    finally:
        s.close()
