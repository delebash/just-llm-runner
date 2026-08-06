# SPDX-License-Identifier: MIT
"""Nav-metadata backfill on prompt reseed (parity batch 2026-08-06).

A seed revision may ADD label/description to a row that predates them (the
approved copy landing on live DBs). The backfill fills ONLY rows whose stored
label+description are both empty — a row anyone named keeps its name, and
non-built-in rows are never touched.
"""

from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from llm_runner.llm import db, seed


def _fresh_db():
    eng = create_engine("sqlite://")
    db.LlmBase.metadata.create_all(eng)
    db.configure_storage(sessionmaker(bind=eng, autoflush=False))


def _seed_with(prompts: dict) -> None:
    seed.configure_app_seed(feature_prompts=prompts)
    s = db.session()
    try:
        seed.seed_default_feature_prompts(s)
        s.commit()
    finally:
        s.close()


def _row(key: str):
    s = db.session()
    try:
        return s.get(db.FeaturePrompt, key)
    finally:
        s.close()


def test_backfill_fills_empty_nav_metadata_only():
    _fresh_db()
    try:
        # v1 of the seed: no labels yet — rows land with empty nav metadata.
        _seed_with({
            "attr.guided": {"feature": "attr", "system": "S1", "user_template": "U"},
            "attr.named": {"feature": "attr", "system": "S2", "user_template": "U"},
        })
        assert _row("attr.guided").label == ""

        # The user names one row via the editor (label survives everything).
        s = db.session()
        try:
            row = s.get(db.FeaturePrompt, "attr.named")
            row.label = "My name"
            s.commit()
        finally:
            s.close()

        # v2 of the seed carries the approved copy — reseed (same DB).
        _seed_with({
            "attr.guided": {
                "feature": "attr", "system": "S1", "user_template": "U",
                "label": "Reading instructions", "description": "What the AI is told.",
            },
            "attr.named": {
                "feature": "attr", "system": "S2", "user_template": "U",
                "label": "Seed name", "description": "Seed words.",
            },
        })
        filled = _row("attr.guided")
        assert filled.label == "Reading instructions"
        assert filled.description == "What the AI is told."
        # The named row keeps the user's name — backfill is empty-only.
        named = _row("attr.named")
        assert named.label == "My name"
        assert named.description == ""
    finally:
        seed.configure_app_seed(feature_prompts={})


def test_backfill_skips_non_builtin_rows():
    _fresh_db()
    try:
        _seed_with({})
        s = db.session()
        try:
            s.add(db.FeaturePrompt(
                key="user.own", feature="own", system="S", user_template="U",
                built_in=False, label="", description="",
            ))
            s.commit()
        finally:
            s.close()

        _seed_with({
            "user.own": {
                "feature": "own", "system": "S", "user_template": "U",
                "label": "Seed label", "description": "Seed words.",
            },
        })
        assert _row("user.own").label == ""
    finally:
        seed.configure_app_seed(feature_prompts={})
