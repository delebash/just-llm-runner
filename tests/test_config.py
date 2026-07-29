# SPDX-License-Identifier: MIT
"""Runner config (A7 — was runner-manifest.json, now DB + engine defaults).

Covers the standalone `default_config()`, the camelCase /v1/llm-runner/config
endpoint, and the host-side DB builder `build_runner_config()` (seeded
runner_binary + runner_setting → RunnerConfig)."""

from __future__ import annotations

import sqlalchemy as sa
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from llm_runner import default_config, router
from llm_runner.runner import lifecycle


def test_default_config_validates():
    c = default_config()
    assert c.llamacpp.pinned_build and c.llamacpp.pinned_build != "latest"
    assert c.llamacpp.binaries
    for b in c.llamacpp.binaries:
        assert b.asset_url or b.image  # every binary is fetchable
    assert c.safety_margin_mb > 0


def test_config_endpoint_camelcase():
    # Force a clean default-backed service (the singleton may be configured by
    # another test); then the endpoint serves default_config().
    lifecycle.configure_service(config_fn=default_config)
    app = FastAPI()
    app.include_router(router)
    r = TestClient(app).get("/v1/llm-runner/config")
    assert r.status_code == 200
    body = r.json()
    assert "safetyMarginMb" in body and body["safetyMarginMb"] > 0
    assert body["llamacpp"]["pinnedBuild"]
    assert "pinned_build" not in body["llamacpp"]  # snake_case must not leak
    assert body["llamacpp"]["binaries"]


def test_hardware_endpoint():
    app = FastAPI()
    app.include_router(router)
    r = TestClient(app).get("/v1/llm-runner/hardware")
    assert r.status_code == 200
    body = r.json()
    assert body["platform"] in {"windows", "macos", "linux"}
    assert "cpuCores" in body and "runtimes" in body


def test_build_runner_config_from_db():
    # The host path: seed runner_binary + runner_setting, then build a RunnerConfig
    # from the DB (the config_fn install_llm injects).
    from llm_runner.llm import db, seed, stores

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

    cfg = stores.build_runner_config()
    assert cfg.llamacpp.pinned_build == seed.DEFAULT_PINNED_BUILD
    assert cfg.safety_margin_mb == seed.DEFAULT_SAFETY_MARGIN_MB
    assert len(cfg.llamacpp.binaries) == len(seed.DEFAULT_BINARIES)
    gpus = {(b.platform, b.gpu) for b in cfg.llamacpp.binaries}
    assert ("windows", "cuda12") in gpus and ("macos", "metal") in gpus
