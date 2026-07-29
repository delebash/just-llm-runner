# SPDX-License-Identifier: MIT
"""switch_presets store — seeded + editable + reset-to-factory (design §6.5)."""

import sqlalchemy as sa
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
import pytest

from llm_runner.llm import db, seed, stores
from llm_runner.llm.switch_presets_api import PresetSwitchRow, SwitchPresetRow


@pytest.fixture
def configured():
    eng = sa.create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    db.create_all(eng)
    db.configure_storage(sessionmaker(bind=eng, autoflush=False))
    s = db.session()
    seed.seed_default_switch_presets(s)
    s.commit()
    s.close()
    yield


def test_list_seeded(configured):
    rows = stores.get_switch_preset_store().list()
    ids = {r.id for r in rows}
    assert {"base", "moe", "mtp"} <= ids  # mtp re-seeded 2026-07-05 (Plan B — gated auto-enable)
    moe = next(r for r in rows if r.id == "moe")
    sw = {s.flagName: s.flagValue for s in moe.switches}
    assert sw == {"no_mmap": "true"}   # only no_mmap is MoE-specific; spec_type default lives in knob_catalog
    assert moe.appliesTo == "moe"
    mtp = next(r for r in rows if r.id == "mtp")
    msw = {s.flagName: s.flagValue for s in mtp.switches}
    # spec_n_max=2 is the user-MEASURED value and ≠ the knob default (3) — a value
    # equal to the knob default must never be seeded here (one-source guardrail).
    assert msw == {"spec_type": "draft-mtp", "spec_n_max": "2"}
    assert mtp.appliesTo == "mtp"


def test_upsert_replaces_switches(configured):
    st = stores.get_switch_preset_store()
    st.upsert(SwitchPresetRow(id="base", label="Base", appliesTo="all",
                              switches=[PresetSwitchRow(flagName="flash_attn", flagValue="off")]))
    base = next(r for r in st.list() if r.id == "base")
    assert {s.flagName: s.flagValue for s in base.switches} == {"flash_attn": "off"}  # whole set replaced


def test_add_delete_user_preset(configured):
    st = stores.get_switch_preset_store()
    st.upsert(SwitchPresetRow(id="turbo", label="Turbo", appliesTo="dense",
                              switches=[PresetSwitchRow(flagName="cache_type_k", flagValue="turbo4")]))
    assert any(r.id == "turbo" for r in st.list())
    st.delete("turbo")
    assert not any(r.id == "turbo" for r in st.list())


def test_reset_restores_factory(configured):
    st = stores.get_switch_preset_store()
    st.upsert(SwitchPresetRow(id="moe", label="x", appliesTo="moe", switches=[]))  # wipe moe
    assert next(r for r in st.list() if r.id == "moe").switches == []
    st.reset_to_factory()
    moe = next(r for r in st.list() if r.id == "moe")
    assert {s.flagName for s in moe.switches} == {"no_mmap"}
