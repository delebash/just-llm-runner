# SPDX-License-Identifier: GPL-3.0-or-later
"""RecommendationStore + ModelCatalogStore round-trips on an in-memory SQLite.

These two stores back the QuickSetup recommendations editor and the model
catalog/switches editor but had ZERO backend coverage (flagged in the JW
status-index). They cover the behaviours the UI depends on: seed → list order,
upsert new/update (and the built_in flip on user edit), delete, reset-to-factory
that RESTORES built-ins while KEEPING user rows, and ModelCatalogStore.set_type
(the GGUF identity auto-detect path that — unlike upsert — must PRESERVE built_in).
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from llm_runner.llm import db, seed, stores, switch_resolve
from llm_runner.llm.model_catalog_api import CatalogRow, make_catalog_router
from llm_runner.llm.recommendations_api import RecommendationRow
from llm_runner.llm.routing_api import FeatureCatalogEntry


@pytest.fixture
def wired():
    # StaticPool + one shared connection so every store session sees one DB.
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    db.configure_storage(SessionLocal)
    db.create_all(engine)
    seed.configure_app_seed(
        feature_catalog=[FeatureCatalogEntry(key="chat", label="Chat", group="Chat")],
        feature_prompts={},
    )
    seed.seed_llm()
    return SessionLocal


# ── RecommendationStore ───────────────────────────────────────────────────────

def test_seed_populates_recommendations_ordered(wired):
    rows = stores.get_recommendation_store().list()
    assert len(rows) == len(seed.DEFAULT_RECOMMENDATIONS)
    assert all(r.builtIn for r in rows)  # every seeded row is built-in
    # Ordered by (task_kind, rank, model_id): "chat.grounded" sorts first alphabetically.
    assert rows[0].taskKind == "chat.grounded" and rows[0].rank == 10
    assert rows[0].modelId == "qwen3.5-9b-q4_k_m"


def test_recommendation_upsert_new_then_update(wired):
    store = stores.get_recommendation_store()
    out = store.upsert(RecommendationRow(modelId="my-gguf", taskKind="chat.grounded", rank=3, why="mine"))
    assert out.builtIn is False  # user-added → not built-in
    got = {(r.modelId, r.taskKind): r for r in store.list()}
    assert got[("my-gguf", "chat.grounded")].rank == 3
    # Upsert the same (model, taskKind) updates in place — no duplicate row.
    store.upsert(RecommendationRow(modelId="my-gguf", taskKind="chat.grounded", rank=7, why="changed"))
    rows = [r for r in store.list() if r.modelId == "my-gguf" and r.taskKind == "chat.grounded"]
    assert len(rows) == 1 and rows[0].rank == 7 and rows[0].why == "changed"


def test_recommendation_upsert_over_builtin_marks_user_edited(wired):
    store = stores.get_recommendation_store()
    seed_row = store.list()[0]  # a built-in
    assert seed_row.builtIn is True
    store.upsert(RecommendationRow(modelId=seed_row.modelId, taskKind=seed_row.taskKind, rank=999, why="x"))
    edited = next(r for r in store.list() if r.modelId == seed_row.modelId and r.taskKind == seed_row.taskKind)
    assert edited.builtIn is False and edited.rank == 999  # editing a built-in flips the flag


def test_recommendation_delete(wired):
    store = stores.get_recommendation_store()
    target = store.list()[0]
    store.delete(target.modelId, target.taskKind)
    assert not any(r.modelId == target.modelId and r.taskKind == target.taskKind for r in store.list())


def test_recommendation_reset_restores_builtins_keeps_user(wired):
    store = stores.get_recommendation_store()
    edited = store.list()[0]                 # built-in we'll edit
    deleted = store.list()[1]                # built-in we'll delete
    # 1) add a user row, 2) edit a built-in, 3) delete a built-in.
    store.upsert(RecommendationRow(modelId="user-model", taskKind="chat.grounded", rank=1, why="mine"))
    store.upsert(RecommendationRow(modelId=edited.modelId, taskKind=edited.taskKind, rank=999, why="edited"))
    store.delete(deleted.modelId, deleted.taskKind)

    store.reset_to_factory()

    after = {(r.modelId, r.taskKind): r for r in store.list()}
    # Built-ins restored to seed values + re-flagged built_in.
    assert after[(edited.modelId, edited.taskKind)].rank == edited.rank
    assert after[(edited.modelId, edited.taskKind)].builtIn is True
    assert (deleted.modelId, deleted.taskKind) in after
    # The user-added row survives the reset.
    assert ("user-model", "chat.grounded") in after and after[("user-model", "chat.grounded")].builtIn is False


# ── ModelCatalogStore ─────────────────────────────────────────────────────────

def test_seed_populates_catalog(wired):
    rows = stores.get_model_catalog_store().list()
    assert len(rows) == len(seed.DEFAULT_CATALOG)
    assert all(r.builtIn for r in rows)
    by_id = {r.id: r for r in rows}
    # Family diversity + the full hardware range landed (A2).
    for mid in ("qwen3.5-9b-q4_k_m", "gemma-4-12b-q4_k_m", "mistral-small-3.2-24b-q4_k_m",
                "glm-4.5-air", "llama-4-scout", "qwen3-235b-a22b", "nomic-embed-text"):
        assert mid in by_id, mid
    # The redundant quants were dropped.
    assert "qwen3.5-9b-q4_k_s" not in by_id
    assert "qwen3-14b-q3_k_m" not in by_id
    # The license column round-trips, verbatim from the seed (A2 + the license gate).
    assert by_id["gemma-4-12b-q4_k_m"].license == "Apache-2.0"
    assert by_id["glm-4.5-air"].license == "MIT"
    assert by_id["llama-4-scout"].license == "Llama-Community"  # use-limited → flag, never default
    # The high-ram tier + the 35B-A3B RAM floor bump (24 GB → 32 GB).
    assert by_id["glm-4.5-air"].tier == "high-ram"
    assert by_id["qwen3.6-35b-a3b-mtp"].minRamMb == 32000


def test_catalog_upsert_new_then_update(wired):
    store = stores.get_model_catalog_store()
    out = store.upsert(CatalogRow(id="my-model", name="My Model", type="moe", tier="high"))
    assert out.builtIn is False and out.type == "moe"
    store.upsert(CatalogRow(id="my-model", name="Renamed", type="dense"))
    rows = [r for r in store.list() if r.id == "my-model"]
    assert len(rows) == 1 and rows[0].name == "Renamed" and rows[0].type == "dense"


def test_catalog_delete(wired):
    store = stores.get_model_catalog_store()
    store.upsert(CatalogRow(id="tmp", name="Temp"))
    store.delete("tmp")
    assert not any(r.id == "tmp" for r in store.list())


def test_catalog_set_type_changes_and_preserves_builtin(wired):
    store = stores.get_model_catalog_store()
    row = store.list()[0]  # a built-in
    assert row.builtIn is True
    other = "moe" if row.type != "moe" else "dense"
    # set_type changes only `type` and (unlike upsert) keeps built_in intact.
    assert store.set_type(row.id, other) is True
    updated = next(r for r in store.list() if r.id == row.id)
    assert updated.type == other and updated.builtIn is True
    # Same value → no-op (returns False); unknown id → False.
    assert store.set_type(row.id, other) is False
    assert store.set_type("no-such-model", "moe") is False


def test_catalog_reset_to_factory(wired):
    store = stores.get_model_catalog_store()
    victim = store.list()[0]
    store.delete(victim.id)
    store.upsert(CatalogRow(id="extra", name="Extra"))
    store.reset_to_factory()
    ids = {r.id for r in store.list()}
    assert victim.id in ids        # built-in restored
    assert "extra" in ids          # user-added catalog row preserved


# ── resolved-switches GET (the #20 model-card grid pre-fill) ──────────────────

def test_resolved_switches_endpoint(wired):
    app = FastAPI()
    app.include_router(make_catalog_router(
        stores.get_model_catalog_store, resolve_switches=switch_resolve.resolve_model_switches,
    ))
    client = TestClient(app)

    # A seeded dense model resolves to its layered base switch defaults — the
    # model-card "Tune & measure" grid pre-fills from this read-only view.
    r = client.get("/v1/ai/model-catalog/switches", params={"modelId": "gemma-4-12b-q4_k_m"})
    assert r.status_code == 200
    body = r.json()
    assert body["modelId"] == "gemma-4-12b-q4_k_m"
    names = {s["flagName"] for s in body["switches"]}
    assert {"flash_attn", "cache_type_k", "cache_type_v", "mlock"} <= names  # the base preset
    # Empty modelId → 400 (not a silent empty resolve).
    assert client.get("/v1/ai/model-catalog/switches", params={"modelId": ""}).status_code == 400
