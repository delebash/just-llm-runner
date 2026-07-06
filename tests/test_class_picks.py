# SPDX-License-Identifier: GPL-3.0-or-later
"""The class→model map (model-per-hardware plan Phase 3): the seeded expression
point QuickSetup's pick consults before the §10 speed-floor rule. Placeholder
contents deliberately equal §10's pick until the model research (C9) refills
the rows. Pure data; no GPU needed."""

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
    seed.seed_default_class_picks(s)
    s.commit()
    s.close()
    yield


def test_seeded_map_row_and_reader_shape(configured):
    picks = stores.list_class_picks()
    assert picks == [{"minVramMb": 6000, "modelId": "gemma-4-26b-a4b-qat"}]


def test_seed_never_clobbers_a_user_edit(configured):
    s = db.session()
    row = s.query(db.ModelClassPick).one()
    row.model_id = "my-own-pick"
    row.built_in = False
    s.commit()
    added = seed.seed_default_class_picks(s)  # re-seed (boot/reset path)
    s.commit()
    s.close()
    assert added == 0
    assert stores.list_class_picks()[0]["modelId"] == "my-own-pick"


def test_catalog_response_carries_class_picks(configured):
    from llm_runner.llm.model_catalog_api import CatalogResponse, ClassPickRow
    resp = CatalogResponse(rows=[], classPicks=[ClassPickRow(**r) for r in stores.list_class_picks()])
    assert resp.classPicks[0].minVramMb == 6000 and resp.classPicks[0].modelId == "gemma-4-26b-a4b-qat"
