# SPDX-License-Identifier: MIT
"""The class-config recommendation refs + the class-key override (§9 final ruled
shape, 2026-07-22): the hidden class→model pick table is DELETED — the
recommendation IS the visible class-tunes library. `list_class_tune_refs()`
serves the distinct (model, class) pairs on the catalog response; the
`class_key_override` setting decides which class this box FILES UNDER
("detection proposes, never dictates"). Pure data; no GPU needed."""

import sqlalchemy as sa
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
import pytest

from llm_runner.llm import db, seed, stores


# Since decision ④ (2026-08-05) the shared DEFAULT_CLASS_TUNES is EMPTY — class
# tunes are the APP's registration (install_llm class_tunes_seed; JW carries the
# family's 13 measured rows). The refs MECHANISM is what this file tests, so the
# fixture registers a small app set of its own: a seven-flag config, a second
# class for the same model, a ONE-flag config (proving one ref per (model,
# class), never per flag), and a second model.
_APP_TUNES = [
    {"model_id": "flagship", "class_key": "dgpu-vram8|ram32", "switches": {
        "n_gpu_layers": "99", "n_cpu_moe": "21", "ctx_len": "32768",
        "batch_size": "512", "ubatch_size": "512", "threads": "8",
        "reasoning_budget": "1024"}},
    {"model_id": "flagship", "class_key": "igpu-mem32", "switches": {
        "n_gpu_layers": "99", "ctx_len": "32768", "flash_attn": "off"}},
    {"model_id": "styletune", "class_key": "dgpu-vram8|ram32", "switches": {
        "spec_type": "none"}},
    {"model_id": "small", "class_key": "igpu-mem16", "switches": {
        "n_gpu_layers": "99", "ctx_len": "32768"}},
]


@pytest.fixture
def configured():
    eng = sa.create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    db.create_all(eng)
    db.configure_storage(sessionmaker(bind=eng, autoflush=False))
    seed.configure_app_seed(class_tunes_seed=_APP_TUNES)
    s = db.session()
    seed.seed_default_class_tunes(s)
    s.commit()
    s.close()
    yield
    seed.configure_app_seed(class_tunes_seed=[])  # never leak into sibling tests


def test_refs_are_distinct_model_class_pairs(configured):
    # Each registered config holds one-to-many flag rows — exactly ONE ref per
    # (model, class) comes out (distinct pairs, not one ref per flag; the
    # one-flag styletune row proves it). Order = SQLite DISTINCT's
    # (model_id, class_key) sort.
    assert stores.list_class_tune_refs() == [
        {"modelId": "flagship", "classKey": "dgpu-vram8|ram32"},
        {"modelId": "flagship", "classKey": "igpu-mem32"},
        {"modelId": "small", "classKey": "igpu-mem16"},
        {"modelId": "styletune", "classKey": "dgpu-vram8|ram32"}]


def test_a_manually_authored_class_becomes_a_ref(configured):
    # §9: manual class authoring is first-class — a config saved for hardware the
    # author does NOT own (a discrete 20 GB / 100 GB box) is a recommendation ref.
    s = db.session()
    try:
        for fname, fval in (("n_gpu_layers", "99"), ("ctx_len", "65536")):
            s.add(db.ClassTune(model_id="m-big", class_key="dgpu-vram20|ram100",
                               flag_name=fname, flag_value=fval, built_in=False))
        s.commit()
    finally:
        s.close()
    refs = stores.list_class_tune_refs()
    assert {"modelId": "m-big", "classKey": "dgpu-vram20|ram100"} in refs
    assert len(refs) == 5   # the 4 registered app configs + the manual one


def test_catalog_response_carries_refs_and_my_class(configured):
    from llm_runner.llm.model_catalog_api import CatalogResponse, ClassTuneRef

    resp = CatalogResponse(
        rows=[], myClassKey="dgpu-vram8|ram32",
        classTuneRefs=[ClassTuneRef(**r) for r in stores.list_class_tune_refs()])
    assert resp.myClassKey == "dgpu-vram8|ram32"
    # The wire shape is what's under test — a registered (model, class) pair rides
    # the response (membership, not position — DISTINCT's sort owns the order).
    assert ("flagship", "dgpu-vram8|ram32") in [
        (r.modelId, r.classKey) for r in resp.classTuneRefs]


def test_override_absent_or_blank_means_auto(configured):
    assert stores.get_class_key_override() == ""


def test_override_wins_at_the_choke_point(configured):
    # install._current_class_key is THE one accessor every class-key consumer reads
    # through (resolve layers, class-tunes router, catalog response, tune badges).
    # A set override short-circuits detection entirely — no hardware probe runs.
    from llm_runner.llm.install import _current_class_key

    stores.get_runner_config_store().set_setting("class_key_override", "dgpu-vram20|ram100")
    assert stores.get_class_key_override() == "dgpu-vram20|ram100"
    assert _current_class_key() == "dgpu-vram20|ram100"
