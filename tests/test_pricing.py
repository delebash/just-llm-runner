# SPDX-License-Identifier: GPL-3.0-or-later
"""Cloud pricing moved to the DB (#75): price_for reads the live model_pricing
table (seeded from DEFAULT_PRICING), and operator edits take effect — no
hardcoded runtime dict."""
import sqlalchemy as sa
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from llm_runner.llm import db, pricing, seed, stores
from llm_runner.llm.pricing_api import PricingRow


def _fresh_seeded():
    eng = sa.create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    db.LlmBase.metadata.create_all(eng)
    db.configure_storage(sessionmaker(bind=eng, autoflush=False))
    s = db.session()
    seed.seed_default_pricing(s)
    s.commit()
    s.close()


def test_price_for_reads_seeded_db():
    _fresh_seeded()
    assert pricing.price_for("gpt-5") == pricing.DEFAULT_PRICING["gpt-5"]
    # dated suffix → prefix match (as before, but now from the DB)
    assert pricing.price_for("gpt-5-2026-01-01") == pricing.DEFAULT_PRICING["gpt-5"]
    # unknown / local model → None (cost 0)
    assert pricing.price_for("some-local-model") is None


def test_price_for_reflects_edits_and_deletes():
    _fresh_seeded()
    stores.get_pricing_store().upsert(PricingRow(modelId="gpt-5", inputPerM=99.0, outputPerM=88.0))
    assert pricing.price_for("gpt-5") == (99.0, 88.0)      # edit takes effect
    stores.get_pricing_store().delete("gpt-5")
    assert pricing.price_for("gpt-5") is None               # delete → cost 0


def test_pricing_store_lowercases_and_lists():
    _fresh_seeded()
    st = stores.get_pricing_store()
    st.upsert(PricingRow(modelId="MyCloud-X", inputPerM=1.0, outputPerM=2.0))
    row = next(r for r in st.list() if r.modelId == "mycloud-x")
    assert row.inputPerM == 1.0 and row.outputPerM == 2.0
    assert pricing.price_for("MyCloud-X") == (1.0, 2.0)     # case-insensitive
