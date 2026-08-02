# SPDX-License-Identifier: MIT
"""`install_llm` — the drop-in entry point, called the way a consuming app calls it.

WHY THIS FILE EXISTS (2026-08-01). The one-call installer is the sentence the whole
shared-package standard rests on, and it had ZERO direct coverage — no test called it.
`test_shared_storage.py` wired storage by hand and its docstring claimed drop-in proof it
never exercised. Meanwhile the entry point mutates five process globals and mounts ~20
routers, i.e. exactly the kind of wiring a refactor breaks without noticing.

Two shapes, both real:
  - THE BARE MINIMAL CALL — `install_llm(app, engine=…, session_factory=…, data_dir=…)`
    with no feature data at all. This is the minimal contract for "any Python app":
    an app with no per-action AI features is a first-class consumer. Nothing in the
    family exercises this shape (JW, JV and the i18n rewrite all pass catalogs), which
    is precisely why only a test will ever protect it.
  - THE WITH-FEATURES CALL + DOUBLE SEED — JustWrite's real boot: install_llm registers
    the app's feature data, then the host calls `seed_llm()` in its own seed pass. Seeding
    is insert-if-missing by design; this asserts a second seed_llm is a no-op (no
    duplicate providers, no duplicate prompts), because JW's boot does exactly that.

HERMETICITY. install_llm mutates process-wide singletons: the storage session factory
(`db.configure_storage`), the app seed registration (`seed._APP`), the usage ledger
(`set_ledger`), the runner service (`lifecycle._service` via `configure_service`), and it
starts the catalog-derive-backfill daemon thread. The fixture snapshots and restores what
later tests read, and `data_dir=tmp_path` keeps the runner's cache root out of the user's
real cache. NOTE: install_llm deliberately does NOT mount `llm_runner.router` — the host
does (install.py's own docstring) — so the app here mounts both, the documented two-line
reality every adopting app must copy.

FILE-BACKED SQLITE, NOT StaticPool — this is a finding, not a preference. The first
version of this file used the suite's usual `sqlite://` + StaticPool (one shared
connection), and the backfill daemon thread's boot-time session interleaved transactions
with seed_llm's session ON THAT ONE CONNECTION — the seed's inserts were silently rolled
back with no error. Observed: 0 of 11 providers on one run, 2 of 11 on the next. A real
host hands install_llm a file-backed DB where every session gets its own connection, so
the test does too. Do not "simplify" this back to StaticPool.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import llm_runner
from llm_runner.llm import seed, stores
from llm_runner.llm.install import install_llm
from llm_runner.llm.routing_api import FeatureCatalogEntry
from llm_runner.llm.seed import seed_llm
from llm_runner.runner import lifecycle


@pytest.fixture
def hermetic(monkeypatch, tmp_path):
    """Snapshot the process singletons install_llm mutates; hand back a fresh FILE-backed
    DB (see the module docstring for why not StaticPool). monkeypatch restores
    `lifecycle._service` and `seed._APP` after the test so the rest of the suite sees
    whatever it saw before."""
    monkeypatch.setattr(lifecycle, "_service", None)
    monkeypatch.setattr(seed, "_APP", dict(seed._APP))
    engine = create_engine(f"sqlite:///{tmp_path / 'app.db'}")
    SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    return engine, SessionLocal


def _mounted_app(engine, session_factory, tmp_path, **kwargs) -> TestClient:
    """The documented two-line adoption: the host mounts the runner router itself,
    install_llm mounts the rest."""
    app = FastAPI()
    app.include_router(llm_runner.router)
    install_llm(app, engine=engine, session_factory=session_factory, data_dir=tmp_path, **kwargs)
    return TestClient(app)


def test_bare_minimal_call_yields_a_working_stack(hermetic, tmp_path):
    """The stranger's app: engine + session factory + data_dir, nothing else."""
    engine, SessionLocal = hermetic
    client = _mounted_app(engine, SessionLocal, tmp_path)
    seed_llm()

    # Providers: seeded rows exist and the endpoint serves them.
    providers = client.get("/v1/llm-providers")
    assert providers.status_code == 200
    assert len(providers.json()["providers"]) > 0, "seed_llm should have seeded providers"

    # Routing: mounted and answering, with the (empty) feature catalog.
    routing = client.get("/v1/ai/routing")
    assert routing.status_code == 200

    # Usage ledger: the DB sink is wired.
    assert client.get("/v1/ai-usage").status_code == 200

    # The runner: catalog is WIRED (install_llm called configure_service) and the
    # seeded catalog rows flow through to the endpoint.
    models = client.get("/v1/llm-runner/models")
    assert models.status_code == 200
    body = models.json()
    assert body["catalogWired"] is True
    assert len(body["models"]) > 0, "the seeded model catalog should reach /models"

    # data_dir honoured: the runner's cache landed under the app's data root,
    # not the user's ~/.cache.
    assert str(lifecycle.get_service().cache_root) == str(tmp_path / "ai-cache")


def test_with_features_and_double_seed_is_a_noop(hermetic, tmp_path):
    """JustWrite's real boot shape: features registered, then the host's own seed pass —
    and a SECOND seed pass changes nothing, because seeding is insert-if-missing."""
    engine, SessionLocal = hermetic
    client = _mounted_app(
        engine, SessionLocal, tmp_path,
        feature_catalog=[FeatureCatalogEntry(key="translate", label="Translate", group="i18n")],
        feature_prompts={
            "translate": {
                "feature": "translate", "system": "S", "user_template": "U", "json_mode": False,
            },
        },
    )
    seed_llm()

    providers_before = len(client.get("/v1/llm-providers").json()["providers"])
    prompts_before = len(stores.get_prompt_store().list())
    catalog_before = len(stores.get_model_catalog_store().list())
    assert providers_before > 0 and prompts_before > 0 and catalog_before > 0

    seed_llm()  # the double seed — JW calls seed_llm after install_llm already part-seeded

    assert len(client.get("/v1/llm-providers").json()["providers"]) == providers_before
    assert len(stores.get_prompt_store().list()) == prompts_before
    assert len(stores.get_model_catalog_store().list()) == catalog_before

    # The registered feature reached the routing surface.
    routing = client.get("/v1/ai/routing")
    assert routing.status_code == 200
    assert any(f["key"] == "translate" for f in routing.json().get("features", []))


def test_bare_call_needs_no_feature_arguments(hermetic, tmp_path):
    """The minimal contract is a SIGNATURE guarantee: feature_catalog and feature_prompts
    have defaults. If someone makes them required again this fails at the call, exactly
    the way the stranger's app would."""
    engine, SessionLocal = hermetic
    app = FastAPI()
    install_llm(app, engine=engine, session_factory=SessionLocal, data_dir=tmp_path)
    # And the empties actually REGISTERED (None would have left prior state in place).
    assert seed.app_feature_catalog() == []
    assert seed.app_feature_prompts() == {}


def test_no_data_dir_warns_about_the_user_cache(hermetic, tmp_path, caplog):
    """Without data_dir the runner caches to ~/.cache — legal, but it must say so:
    silence here is how an uninstalled app strands multi-GB weights."""
    import logging

    engine, SessionLocal = hermetic
    app = FastAPI()
    with caplog.at_level(logging.WARNING, logger="llm_runner.llm.install"):
        install_llm(app, engine=engine, session_factory=SessionLocal)
    assert any("data_dir" in r.message for r in caplog.records)


def test_headless_boot_app_none_wires_everything_but_mounts_nothing(hermetic, tmp_path):
    """app=None — the CLI door's boot (2026-08-02). The first consumer to need this
    re-implemented install_llm's storage half against PRIVATE imports; headless is
    first-class now so that drift class cannot recur. Everything but routes: storage,
    seeds registration, the ledger, the runner-catalog wiring."""
    engine, SessionLocal = hermetic
    install_llm(None, engine=engine, session_factory=SessionLocal, data_dir=tmp_path)
    seed_llm()

    assert len(stores.get_provider_store().list()) > 0, "seeded through the same path"
    assert len(stores.get_model_catalog_store().list()) > 0
    # The runner catalog is WIRED (the CLI's make_send needs the stores AND the runner).
    assert lifecycle.get_service().catalog_wired is True
    assert str(lifecycle.get_service().cache_root) == str(tmp_path / "ai-cache")
