# SPDX-License-Identifier: GPL-3.0-or-later
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


@pytest.fixture
def configured():
    eng = sa.create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    db.create_all(eng)
    db.configure_storage(sessionmaker(bind=eng, autoflush=False))
    s = db.session()
    seed.seed_default_class_tunes(s)
    s.commit()
    s.close()
    yield


def test_refs_are_distinct_model_class_pairs(configured):
    # Each seeded Gemma config holds SEVERAL flag rows — exactly ONE ref per
    # (model, class) comes out (distinct pairs, not one ref per flag). Four seeded
    # rows now: the flagship on the 8 GB discrete box and the 32 GB integrated-GPU box,
    # StyleTune's single-flag spec_type=none row on 8 GB discrete (2026-07-25 — which
    # also proves a ONE-flag config still yields exactly one ref, same as a seven-flag
    # one), and E4B on the 16 GB integrated-GPU box (2026-07-25, the laptop's own
    # kit measurements — the ref IS the box's model recommendation, §9 ruled shape).
    assert stores.list_class_tune_refs() == [
        {"modelId": "gemma-4-26b-a4b-qat", "classKey": "dgpu-vram8|ram32"},
        {"modelId": "gemma-4-26b-a4b-qat", "classKey": "igpu-mem32"},
        {"modelId": "gemma-4-e4b-qat", "classKey": "igpu-mem16"},
        {"modelId": "gryphe-styletune-v2", "classKey": "dgpu-vram8|ram32"}]


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
    assert len(refs) == 5   # 4 seeded (flagship x2 + StyleTune + E4B/igpu-16) + the manual one


def test_catalog_response_carries_refs_and_my_class(configured):
    from llm_runner.llm.model_catalog_api import CatalogResponse, ClassTuneRef

    resp = CatalogResponse(
        rows=[], myClassKey="dgpu-vram8|ram32",
        classTuneRefs=[ClassTuneRef(**r) for r in stores.list_class_tune_refs()])
    assert resp.myClassKey == "dgpu-vram8|ram32"
    ref = resp.classTuneRefs[0]
    assert (ref.modelId, ref.classKey) == ("gemma-4-26b-a4b-qat", "dgpu-vram8|ram32")


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
