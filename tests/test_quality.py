# SPDX-License-Identifier: GPL-3.0-or-later
"""The Fast/Balanced/Best dial — resolve_quality + the /v1/ai/job-quality endpoint.

Runs against the real seeded catalog + recommendations so the size-ladder picks
are checked against the actual Part-3 matrix (not toy data)."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from llm_runner.llm import db, seed, stores
from llm_runner.llm.quality import resolve_quality
from llm_runner.llm.quality_api import make_quality_router
from llm_runner.llm.routing_api import FeatureCatalogEntry
from llm_runner.runner.schema import GpuInfo, HardwareInfo


@pytest.fixture
def wired():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    db.configure_storage(sessionmaker(bind=engine, autocommit=False, autoflush=False))
    db.create_all(engine)
    seed.configure_app_seed(
        feature_catalog=[FeatureCatalogEntry(key="chat", label="Chat", category="Chat")],
        feature_jobs=[{"feature_key": "chat", "job_id": "chat"}],
        feature_prompts={},
    )
    seed.seed_llm()
    return engine


def _resolve(job, quality, *, vram_mb, ram_mb):
    return resolve_quality(
        job, quality, vram_mb=vram_mb, ram_mb=ram_mb,
        catalog=stores.get_model_catalog_store().list(),
        recommendations=stores.get_recommendation_store().list(),
    )


def test_chat_ladder_on_a_capable_box(wired):
    # chat recs: qwen3.5-9b, gemma-4-12b, qwen3.6-27b. 24 GB VRAM fits all.
    big = dict(vram_mb=24000, ram_mb=64000)
    assert _resolve("chat", "fast", **big).model == "qwen3.5-9b-q4_k_m"      # smallest
    assert _resolve("chat", "best", **big).model == "qwen3.6-27b-mtp-q4_k_m"  # largest
    bal = _resolve("chat", "balanced", **big).model
    assert bal == "gemma-4-12b-q4_k_m"  # the median of the size ladder


def test_extraction_balanced_is_mistral_on_16gb(wired):
    # 16 GB VRAM + 32 GB RAM: GLM-Air (64 GB RAM) is filtered out; the ladder is
    # [14B, Mistral-24B, 35B-A3B] → Balanced = Mistral (matches the matrix).
    pick = _resolve("extraction", "balanced", vram_mb=16000, ram_mb=32000)
    assert pick.model == "mistral-small-3.2-24b-q4_k_m"
    assert _resolve("extraction", "fast", vram_mb=16000, ram_mb=32000).model == "qwen3-14b-q4_k_m"


def test_prose_best_is_the_ceiling_on_a_workstation(wired):
    # 24 GB VRAM + 96 GB RAM runs the 235B MoE → Best, 9B → Fast.
    big = dict(vram_mb=24000, ram_mb=96000)
    assert _resolve("prose", "best", **big).model == "qwen3-235b-a22b"
    assert _resolve("prose", "fast", **big).model == "qwen3.5-9b-q4_k_m"


def test_small_box_collapses_all_stops(wired):
    # 8 GB VRAM + 16 GB RAM: for prose only the 9B fits → every stop resolves to it.
    small = dict(vram_mb=8000, ram_mb=16000)
    for q in ("fast", "balanced", "best"):
        assert _resolve("prose", q, **small).model == "qwen3.5-9b-q4_k_m"


def test_think_follows_the_dial_table(wired):
    big = dict(vram_mb=24000, ram_mb=96000)
    assert _resolve("analysis", "best", **big).think is True    # deep reasoning on
    assert _resolve("analysis", "balanced", **big).think is False
    assert _resolve("chat", "best", **big).think is False        # latency-sensitive
    assert _resolve("extraction", "best", **big).think is False  # JSON-sensitive


def test_endpoint_resolves_with_injected_hardware(wired):
    hw = HardwareInfo(os="Linux", platform="linux", cpu_cores=8, ram_mb=32000,
                      gpus=[GpuInfo(vendor="nvidia", name="x", vram_mb=16000)])
    app = FastAPI()
    app.include_router(make_quality_router(
        stores.get_model_catalog_store, stores.get_recommendation_store, detect_fn=lambda: hw,
    ))
    r = TestClient(app).get("/v1/ai/job-quality", params={"job": "extraction", "quality": "balanced"})
    assert r.status_code == 200
    body = r.json()
    assert body["model"] == "mistral-small-3.2-24b-q4_k_m"
    assert body["providerId"] == "local-llamacpp"  # the dial picks a local runner model
    assert "candidates" in body and body["candidates"]
