# SPDX-License-Identifier: GPL-3.0-or-later
"""Editable engine config (runner_binary + runner_setting via /v1/ai/engine-config):
get / upsert / set-setting / reset round-trip over an in-memory DB."""

from __future__ import annotations

import sqlalchemy as sa
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from llm_runner.llm import db, seed, stores
from llm_runner.llm.runner_config_api import RunnerBinaryRow, make_runner_config_router


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


# ── 4a: the two router knobs are readable + editable via /v1/ai/engine-config ──

def _engine_config_client():
    # Mount the shared engine-config editor over the (already-seeded) in-memory DB;
    # get_store() resolves to the same global session factory _fresh_db configured.
    app = FastAPI()
    app.include_router(make_runner_config_router(stores.get_runner_config_store))
    return TestClient(app)


def test_get_config_exposes_router_knobs():
    # The EngineConfig wire model (what the 4a resident-view UI reads) surfaces the two
    # knobs from the seeded runner_setting rows.
    _fresh_db()
    cfg = stores.get_runner_config_store().get_config()
    assert cfg.modelsMax == seed.DEFAULT_MODELS_MAX
    assert cfg.sleepIdleSeconds == seed.DEFAULT_SLEEP_IDLE_SECONDS


def test_engine_config_put_persists_router_knobs():
    _fresh_db()
    r = _engine_config_client().put(
        "/v1/ai/engine-config", json={"modelsMax": 3, "sleepIdleSeconds": 120}
    )
    assert r.status_code == 200
    body = r.json()
    assert body["modelsMax"] == 3 and body["sleepIdleSeconds"] == 120
    # …and it reaches the runner's live config (the service reads the same rows).
    cfg = stores.build_runner_config()
    assert cfg.models_max == 3 and cfg.sleep_idle_seconds == 120


def test_engine_config_put_clamps_models_max_and_allows_zero_ttl():
    # models_max < 1 is nonsensical (at least one model must stay resident) → clamp to 1;
    # sleep_idle_seconds = 0 is VALID (disables the idle-unload TTL) → preserved, not coerced.
    _fresh_db()
    body = _engine_config_client().put(
        "/v1/ai/engine-config", json={"modelsMax": 0, "sleepIdleSeconds": 0}
    ).json()
    assert body["modelsMax"] == 1        # clamped up
    assert body["sleepIdleSeconds"] == 0  # zero preserved


def test_engine_config_put_knobs_only_does_not_clobber_binaries_or_build():
    # T3 build-guard: a partial PUT of just the two knobs must leave pinnedBuild +
    # binaries + safetyMarginMb untouched (EngineConfigUpdate is all-optional).
    _fresh_db()
    client = _engine_config_client()
    before = client.get("/v1/ai/engine-config").json()
    client.put("/v1/ai/engine-config", json={"modelsMax": 4})
    after = client.get("/v1/ai/engine-config").json()
    assert after["pinnedBuild"] == before["pinnedBuild"]
    assert len(after["binaries"]) == len(before["binaries"])
    assert after["safetyMarginMb"] == before["safetyMarginMb"]
    assert after["modelsMax"] == 4


def test_engine_config_put_round_trips_class_key_override():
    # §9 (2026-07-22): the hardware-class override — free text ("" = auto-detect),
    # trimmed at the PUT boundary, served back on GET, cleared by reset.
    _fresh_db()
    client = _engine_config_client()
    assert client.get("/v1/ai/engine-config").json()["classKeyOverride"] == ""
    body = client.put(
        "/v1/ai/engine-config", json={"classKeyOverride": "  vram20|ram100  "}
    ).json()
    assert body["classKeyOverride"] == "vram20|ram100"
    assert stores.get_class_key_override() == "vram20|ram100"
    stores.get_runner_config_store().reset_to_defaults()
    assert stores.get_class_key_override() == ""


def test_reset_restores_router_knobs():
    _fresh_db()
    store = stores.get_runner_config_store()
    store.set_setting("models_max", "7")
    store.set_setting("sleep_idle_seconds", "30")
    store.reset_to_defaults()
    cfg = store.get_config()
    assert cfg.modelsMax == seed.DEFAULT_MODELS_MAX
    assert cfg.sleepIdleSeconds == seed.DEFAULT_SLEEP_IDLE_SECONDS
