# SPDX-License-Identifier: GPL-3.0-or-later
"""GGUF identity auto-detect → model_catalog.type (design S3 / D17). Pure logic +
the catalog write; the GGUF read is injected, so no real GGUF bytes are needed."""

import sqlalchemy as sa
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
import pytest

from llm_runner.llm import db, identity, seed, stores
from llm_runner.runner.gguf import GgufMeta


@pytest.fixture
def configured():
    eng = sa.create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    db.create_all(eng)
    db.configure_storage(sessionmaker(bind=eng, autoflush=False))
    s = db.session()
    seed.seed_default_catalog(s)
    s.commit()
    s.close()
    yield


def _meta(expert_count):
    return GgufMeta(
        architecture="x", block_count=10, embedding_length=1000, expert_count=expert_count
    )


def _row(model_id):
    return next(r for r in stores.get_model_catalog_store().list() if r.id == model_id)


def test_type_from_meta():
    assert identity.model_type_from_meta(_meta(128)) == "moe"
    assert identity.model_type_from_meta(_meta(0)) == "dense"


def test_detect_flips_type_to_moe_and_keeps_built_in(configured):
    mid = "qwen3.5-9b-q4_k_m"  # seeded type=dense, built_in=True
    assert _row(mid).type == "dense"
    assert _row(mid).builtIn is True
    out = identity.detect_and_store_model_type(mid, "x.gguf", read_meta=lambda _p: _meta(128))
    assert out == "moe"
    after = _row(mid)
    assert after.type == "moe"
    assert after.builtIn is True  # set_type preserves built_in (upsert would not)


def test_detect_dense_is_noop_when_already_dense(configured):
    mid = "qwen3.5-9b-q4_k_m"
    out = identity.detect_and_store_model_type(mid, "x.gguf", read_meta=lambda _p: _meta(0))
    assert out == "dense"
    assert _row(mid).type == "dense"
