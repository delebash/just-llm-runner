# SPDX-License-Identifier: GPL-3.0-or-later
"""The ONE reasoning resolver (U2, 2026-07-14): the ask (think + level) → what each
provider/model emits, with the LOCAL hardware clamp; plus the per-provider reasoning_map
seed/CRUD."""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import llm_runner.llm.db as db
import llm_runner.llm.seed as seed
from llm_runner.llm.reasoning import resolve_reasoning
from llm_runner.llm.reasoning_map_api import ReasoningLevelRow, seed_rows_for_type
from llm_runner.llm.stores import ReasoningMapStore

CK = "vram8|ram32"


@pytest.fixture
def seeded():
    eng = create_engine("sqlite:///:memory:")
    db.LlmBase.metadata.create_all(eng)
    SM = sessionmaker(bind=eng)
    db.configure_storage(SM)
    s = SM()
    seed.seed_default_providers(s)
    seed.seed_default_reasoning_map(s)
    seed.seed_default_runner_settings(s)
    s.commit()
    yield s
    s.close()


def _R(**kw):
    kw.setdefault("class_key", CK)
    return resolve_reasoning(**kw)


def _local_tune(s, model_id, value):
    s.add(db.ClassTune(model_id=model_id, class_key=CK, flag_name="reasoning_budget", flag_value=value))
    s.commit()


# ── the LOCAL clamp (the crux: level × hardware cap = min) ────────────────────
def test_local_clamp_min_wins(seeded):
    _local_tune(seeded, "gemma", "1024")   # the user's tested 2070S cap
    p = _R(think=True, level="high", provider_id="local-llamacpp", provider_type="local-llamacpp", model_id="gemma")
    assert (p.ask, p.cap, p.effective, p.cap_source) == (8192, 1024, 1024, "class")


def test_local_default_cap_when_no_class_tune(seeded):
    p = _R(think=True, level="high", provider_id="local-llamacpp", provider_type="local-llamacpp", model_id="none")
    assert (p.cap, p.effective, p.cap_source) == (8192, 8192, "default")


def test_local_max_runs_at_cap(seeded):
    _local_tune(seeded, "gemma", "1024")
    p = _R(think=True, level="max", provider_id="local-llamacpp", provider_type="local-llamacpp", model_id="gemma")
    assert p.ask is None and p.effective == 1024   # Max / no number ⇒ the cap


def test_local_below_cap_keeps_ask(seeded):
    _local_tune(seeded, "gemma", "16384")
    p = _R(think=True, level="high", provider_id="local-llamacpp", provider_type="local-llamacpp", model_id="gemma")
    assert p.effective == 8192   # ask (8192) < cap (16384) ⇒ ask


def test_think_off_is_empty(seeded):
    p = _R(think=False, level="high", provider_id="local-llamacpp", provider_type="local-llamacpp", model_id="gemma")
    assert p.think is False and p.word == "" and p.effective is None


# ── cloud: no cap; word vs number by generation ──────────────────────────────
def test_cloud_word_path_no_cap(seeded):
    p = _R(think=True, level="high", provider_id="openai", provider_type="openai", model_id="gpt")
    assert p.word == "high" and p.cap is None and p.effective is None


def test_cloud_number_path_no_cap(seeded):
    ReasoningMapStore().seed_missing("gem", seed_rows_for_type("gemini"))
    p = _R(think=True, level="high", provider_id="gem", provider_type="gemini", model_id="g")
    assert p.word == "" and p.ask == 24576 and p.cap is None and p.effective == 24576


# ── the map is editable DATA; a missing row falls to the type seed ───────────
def test_edited_map_row_wins_over_seed(seeded):
    ReasoningMapStore().upsert("openai", ReasoningLevelRow(level="high", word="max-effort"))
    p = _R(think=True, level="high", provider_id="openai", provider_type="openai", model_id="gpt")
    assert p.word == "max-effort"


def test_missing_map_row_falls_back_to_type_seed(seeded):
    p = _R(think=True, level="medium", provider_id="brand-new", provider_type="anthropic", model_id="c")
    assert p.word == "medium" and p.ask == 4096   # anthropic type seed (word AND number)


def test_map_crud_fill_if_missing_never_clobbers(seeded):
    st = ReasoningMapStore()
    before = st.map_for("openai")["high"].word
    st.seed_missing("openai", [ReasoningLevelRow(level="high", word="X")])   # exists → no clobber
    assert st.map_for("openai")["high"].word == before
