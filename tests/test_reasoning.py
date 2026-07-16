# SPDX-License-Identifier: GPL-3.0-or-later
"""The ONE reasoning resolver (house-layering 2026-07-16 + the preset tier, same day):
the ask (think + optional level) → what each provider/model emits. LOCAL, level SET →
the preset's own ask (the local map's tokens, source "preset" — "feature is the end of
the line"); level EMPTY → FOLLOW the model's layered `reasoning_budget` switch value
(base bundle → class tune → applied model tune, most-specific wins) via the SAME
`switch_resolve` every switch uses — NO clamp, honest sentinels (-1 unlimited, 0 suppress,
non-numeric → invalid), nothing copied. CLOUD levels come from the per-provider
reasoning_map."""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import llm_runner.llm.db as db
import llm_runner.llm.seed as seed
from llm_runner.llm.reasoning import resolve_reasoning
from llm_runner.llm.reasoning_map_api import ReasoningLevelRow, seed_rows_for_type
from llm_runner.llm.stores import ReasoningMapStore

CK = "vram8|ram32"   # the fixture's hardware class
HK = "test-machine"  # the fixture's per-machine hw_key


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
    seed.seed_default_switch_presets(s)   # base bundle carries reasoning_budget=1024 (the GLOBAL tier)
    s.commit()
    yield s
    s.close()


def _R(**kw):
    kw.setdefault("class_key", CK)
    kw.setdefault("hw_key", "")   # no per-machine tune unless a test asks for one
    kw.setdefault("level", "")    # local: display vocabulary only; cloud tests pass a level
    return resolve_reasoning(**kw)


def _local(model_id, **kw):
    kw.setdefault("think", True)
    return _R(provider_id="local-llamacpp", provider_type="local-llamacpp",
              model_id=model_id, **kw)


def _class_tune(s, model_id, value):
    s.add(db.ClassTune(model_id=model_id, class_key=CK, flag_name="reasoning_budget", flag_value=value))
    s.commit()


def _model_tune(s, model_id, value):
    s.add(db.ModelTune(model_id=model_id, hw_key=HK, flag_name="reasoning_budget", flag_value=value))
    s.commit()


# ── LOCAL: the layered switch value IS the emitted budget (no clamp) ──────────
def test_class_row_wins_over_base(seeded):
    _class_tune(seeded, "gemma", "1024")
    p = _local("gemma")
    assert (p.value, p.source) == (1024, "class")


def test_model_tune_beats_class(seeded):
    _class_tune(seeded, "gemma", "1024")
    _model_tune(seeded, "gemma", "2048")
    p = _local("gemma", hw_key=HK)   # the per-machine tune is more specific → wins
    assert (p.value, p.source) == (2048, "tune")


def test_base_bundle_supplies_the_global_tier(seeded):
    p = _local("no-tune-model")   # no class/tune rows → the seeded base bundle's 1024
    assert (p.value, p.source) == (1024, "base")


def test_nothing_anywhere_defaults(seeded):
    # An old DB pre-reseed: the base bundle carries no reasoning_budget row → last-ditch.
    seeded.query(db.PresetSwitch).filter(
        db.PresetSwitch.preset_id == "base",
        db.PresetSwitch.flag_name == "reasoning_budget",
    ).delete()
    seeded.commit()
    p = _local("no-tune-model")
    assert (p.value, p.source) == (1024, "default")


def test_sentinel_minus_one_passes_through(seeded):
    _class_tune(seeded, "gemma", "-1")   # sanctioned unlimited — no reinterpretation
    p = _local("gemma")
    assert (p.value, p.source) == (-1, "class")


def test_sentinel_zero_suppresses(seeded):
    _class_tune(seeded, "gemma", "0")
    p = _local("gemma")
    assert (p.value, p.source) == (0, "class")


def test_non_numeric_row_is_invalid(seeded):
    _class_tune(seeded, "gemma", "garbage")
    p = _local("gemma")
    assert (p.value, p.source) == (None, "invalid")   # adapter emits 0 → thinking visibly off


def test_think_off_is_empty(seeded):
    p = _local("gemma", think=False)
    assert p.think is False and p.word == "" and p.value is None and p.source == ""


# ── LOCAL, the PRESET tier: a set level is the feature's own ask ──────────────
def test_preset_level_beats_every_layer(seeded):
    _class_tune(seeded, "gemma", "1024")
    _model_tune(seeded, "gemma", "2048")
    p = _local("gemma", level="high", hw_key=HK)   # feature is the end of the line
    assert (p.value, p.source) == (8192, "preset")  # the local map's high, not any layer


def test_preset_level_is_model_independent(seeded):
    # No layers set for this model at all — the preset's own ask still stands.
    p = _local("brand-new-model", level="low")
    assert (p.value, p.source) == (1024, "preset")


def test_empty_level_follows_the_model(seeded):
    _class_tune(seeded, "gemma", "1024")
    p = _local("gemma", level="")
    assert (p.value, p.source) == (1024, "class")   # nothing copied — resolved live


def test_preset_level_with_blank_map_tokens_falls_to_follow(seeded):
    # A user blanks the local map row's tokens: the level speaks no local number →
    # follow the layers, honestly labeled by source (never a silent guess).
    ReasoningMapStore().upsert("local-llamacpp", ReasoningLevelRow(level="medium", word="", tokens=None))
    _class_tune(seeded, "gemma", "1024")
    p = _local("gemma", level="medium")
    assert (p.value, p.source) == (1024, "class")


# ── CLOUD: word vs number by generation, straight from the map ────────────────
def test_cloud_word_path(seeded):
    p = _R(think=True, level="high", provider_id="openai", provider_type="openai", model_id="gpt")
    assert p.word == "high" and p.value is None and p.source == ""


def test_cloud_number_path(seeded):
    ReasoningMapStore().seed_missing("gem", seed_rows_for_type("gemini"))
    p = _R(think=True, level="high", provider_id="gem", provider_type="gemini", model_id="g")
    assert p.word == "" and p.value == 24576 and p.source == "map"


def test_edited_map_row_wins_over_seed(seeded):
    ReasoningMapStore().upsert("openai", ReasoningLevelRow(level="high", word="max-effort"))
    p = _R(think=True, level="high", provider_id="openai", provider_type="openai", model_id="gpt")
    assert p.word == "max-effort"


# ── the autoflush-OFF host trap (found on the user's box 2026-07-16) ──────────
def test_map_seeds_on_an_autoflush_off_session():
    """JW's server session is autoflush=False (database.py sessionmaker). The map
    seeder queries providers the PREVIOUS seeder just s.add()ed in the same session —
    without an explicit flush that query sees an empty table and seeds NOTHING,
    silently (fresh boots + in-process resets shipped with an empty reasoning map;
    the UI showed no levels while runs kept working via the type-seed fallback).
    This test runs the two seeders exactly the way the host does and FAILS if the
    flush is ever removed."""
    eng = create_engine("sqlite:///:memory:")
    db.LlmBase.metadata.create_all(eng)
    SM = sessionmaker(bind=eng, autoflush=False)  # the HOST's configuration
    db.configure_storage(SM)
    s = SM()
    try:
        seed.seed_default_providers(s)
        assert seed.seed_default_reasoning_map(s) > 0  # 0 = the shipped bug
        s.commit()
        rows = s.query(db.ReasoningMap).filter(db.ReasoningMap.provider_id == "local-llamacpp").all()
        assert {r.level for r in rows} == {"low", "medium", "high", "xhigh", "max"}
    finally:
        s.close()


# ── the seed policy: local max finite (32768), gemini max dynamic (-1) ────────
def test_seed_max_tokens_local_finite_gemini_dynamic():
    local_max = {r.level: r for r in seed_rows_for_type("local-llamacpp")}["max"]
    gemini_max = {r.level: r for r in seed_rows_for_type("gemini")}["max"]
    assert local_max.tokens == 32768   # finite by policy (Gemma loop verified on-box)
    assert gemini_max.tokens == -1     # documented dynamic/unlimited
