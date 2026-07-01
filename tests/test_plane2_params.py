# SPDX-License-Identifier: GPL-3.0-or-later
"""Per-action Plane-2 params — #18 structured-output (JSON) + #22 top_p sampling.
They ride in the chat request via `extra` (no model reload): the builder + the
prompt-store round-trip."""

import sqlalchemy as sa
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
import pytest

from llm_runner.llm import db
from llm_runner.llm.prompts import FeaturePromptRow, RunRequest, _plane2_extra


@pytest.fixture(autouse=True)
def _isolated_storage():
    # _plane2_extra reads feature_sampler_params via db.session(); configure a
    # per-test in-memory store so these pass in ISOLATION, not just in-suite.
    engine = sa.create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    db.LlmBase.metadata.create_all(engine)
    db.configure_storage(sessionmaker(bind=engine))
    yield


def _spec(**kw):
    base = dict(key="k", feature="f", system="", user_template="", temperature=0.7, think=False, built_in=False)
    base.update(kw)
    return FeaturePromptRow(**base)


def test_extra_none_when_unset():
    assert _plane2_extra(_spec(), RunRequest(action="k")) is None


def test_json_mode_and_top_p_from_spec():
    e = _plane2_extra(_spec(json_mode=True, top_p=0.9), RunRequest(action="k"))
    assert e == {"response_format": {"type": "json_object"}, "top_p": 0.9}


def test_request_overrides_spec():
    # request jsonMode=False overrides a spec json_mode=True; topP override wins.
    e = _plane2_extra(_spec(json_mode=True, top_p=0.9), RunRequest(action="k", jsonMode=False, topP=0.5))
    assert e == {"top_p": 0.5}


@pytest.fixture
def configured():
    eng = sa.create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    db.create_all(eng)
    db.configure_storage(sessionmaker(bind=eng, autoflush=False))
    yield


def test_prompt_store_roundtrips_json_top_p(configured):
    from llm_runner.llm import stores
    st = stores.get_prompt_store()
    st.upsert(FeaturePromptRow(key="x", feature="x", system="s", user_template="u",
                               temperature=0.5, think=False, built_in=False, json_mode=True, top_p=0.8))
    r = st.get("x")
    assert r.json_mode is True and r.top_p == 0.8


# ── Stop sequences (#73) — the reserved `stop` key rides the samplers array and
# is normalized to a string ARRAY for the engine; anthropic renames it. ──
def test_stop_sequences_split_to_array():
    e = _plane2_extra(_spec(), RunRequest(action="k", samplers=[{"flagName": "stop", "flagValue": "END\nUSER:"}]))
    assert e == {"stop": ["END", "USER:"]}


def test_stop_numeric_value_kept_as_string():
    # A numeric-looking stop must survive _parse_sampler_value's int/float coercion.
    e = _plane2_extra(_spec(), RunRequest(action="k", samplers=[{"flagName": "stop", "flagValue": "42"}]))
    assert e == {"stop": ["42"]}


def test_stop_blank_is_dropped():
    e = _plane2_extra(_spec(), RunRequest(action="k", samplers=[{"flagName": "stop", "flagValue": "  \n  "}]))
    assert e is None


def test_anthropic_renames_stop_to_stop_sequences():
    from llm_runner.llm.anthropic import AnthropicAdapter
    assert AnthropicAdapter._map_extra({"stop": ["END"], "top_p": 0.9}) == {"stop_sequences": ["END"], "top_p": 0.9}
    assert AnthropicAdapter._map_extra(None) is None
    assert AnthropicAdapter._map_extra({"top_p": 0.9}) == {"top_p": 0.9}
