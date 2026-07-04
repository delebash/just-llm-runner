# SPDX-License-Identifier: GPL-3.0-or-later
"""Editable engine config (runner_binary + runner_setting via /v1/ai/engine-config):
get / upsert / set-setting / reset round-trip over an in-memory DB."""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from llm_runner.llm import db, seed, stores
from llm_runner.llm.runner_config_api import RunnerBinaryRow


def _fresh_db():
    engine = sa.create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    db.configure_storage(sessionmaker(bind=engine, autoflush=False))
    db.create_all(engine)
    s = db.session()
    seed.seed_default_runner_binaries(s)
    seed.seed_default_runner_settings(s)
    s.commit()
    s.close()


def test_get_config_reads_seeded_defaults():
    _fresh_db()
    cfg = stores.get_runner_config_store().get_config()
    assert cfg.pinnedBuild == seed.DEFAULT_PINNED_BUILD
    assert cfg.safetyMarginMb == seed.DEFAULT_SAFETY_MARGIN_MB
    assert len(cfg.binaries) == len(seed.DEFAULT_BINARIES)
    cuda = next(b for b in cfg.binaries if b.platform == "windows" and b.gpu == "cuda12")
    assert cuda.assetUrl and "cuda-12.4" in cuda.assetUrl
    assert cuda.runtimeUrl and "cudart" in cuda.runtimeUrl  # the companion is served


def test_upsert_binary_and_settings():
    _fresh_db()
    store = stores.get_runner_config_store()
    store.upsert_binary(RunnerBinaryRow(
        platform="windows", gpu="cuda12",
        assetUrl="https://example.com/fixed.zip", runtimeUrl=None, serverExe="llama-server.exe",
    ))
    store.set_setting("pinned_build", "b9999")
    store.set_setting("safety_margin_mb", "2048")

    cfg = store.get_config()
    cuda = next(b for b in cfg.binaries if b.platform == "windows" and b.gpu == "cuda12")
    assert cuda.assetUrl == "https://example.com/fixed.zip"
    assert cfg.pinnedBuild == "b9999"
    assert cfg.safetyMarginMb == 2048


def test_reset_restores_shipped_and_keeps_custom():
    _fresh_db()
    store = stores.get_runner_config_store()
    # break a shipped row + add a user custom row + change a setting
    store.upsert_binary(RunnerBinaryRow(platform="windows", gpu="cuda12", assetUrl="https://bad/x.zip"))
    store.upsert_binary(RunnerBinaryRow(
        platform="linux", gpu="custom", assetUrl="https://example.com/custom.tar.gz", serverExe="llama-server",
    ))
    store.set_setting("pinned_build", "bXXXX")

    store.reset_to_defaults()

    cfg = store.get_config()
    cuda = next(b for b in cfg.binaries if b.platform == "windows" and b.gpu == "cuda12")
    assert "cuda-12.4" in cuda.assetUrl          # shipped URL restored
    assert cfg.pinnedBuild == seed.DEFAULT_PINNED_BUILD  # setting restored
    assert any(b.gpu == "custom" for b in cfg.binaries)  # custom row preserved


# ── P1e: the router knobs (models_max + sleep_idle_seconds) the service reads ──

def test_build_runner_config_reads_seeded_router_knobs():
    # build_runner_config is the runner service's config_fn; it must surface the two
    # router knobs from the seeded runner_setting rows (with the shipped defaults).
    _fresh_db()
    cfg = stores.build_runner_config()
    assert cfg.models_max == seed.DEFAULT_MODELS_MAX
    assert cfg.sleep_idle_seconds == seed.DEFAULT_SLEEP_IDLE_SECONDS


def test_build_runner_config_reads_edited_router_knobs():
    # DB is the source of truth: an edited models_max / sleep_idle_seconds flows through.
    # sleep_idle_seconds = 0 (disable the TTL) must be PRESERVED, not coerced to a default.
    _fresh_db()
    store = stores.get_runner_config_store()
    store.set_setting("models_max", "4")
    store.set_setting("sleep_idle_seconds", "0")
    cfg = stores.build_runner_config()
    assert cfg.models_max == 4
    assert cfg.sleep_idle_seconds == 0
