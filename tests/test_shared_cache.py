# SPDX-License-Identifier: MIT
"""One engine + model cache for the whole family, chosen — never assumed (2026-08-03).

Measured on the author's box: JustWrite and just_ai_i18n_docgen each kept their own
`<data>/ai-cache`, so the SAME artifact sat on disk twice — `unsloth/
gemma-4-26B-A4B-it-qat-GGUF @ UD-Q4_K_XL`, snapshot `7b92b5b2…`, 14,249,047,104 bytes
in both — plus two llama.cpp installs. User ruling: detect an existing family cache
during Quick Setup and ASK, with an override for an app that wants its own.

The trap being guarded here is the SECOND half. Sharing the cache naively also shares
`models.ini`, which each app RENDERS FROM ITS OWN CATALOGUE — so app B's emit
overwrites app A's, and A's next router bounce re-reads a preset describing B's
models. The split (`cache_root` shared, `runtime_root` private) is what makes sharing
safe, and it must stay invisible to an app that shares nothing.
"""

import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from llm_runner.llm.cache_api import make_cache_router
from llm_runner.llm.install import resolve_cache_roots
from llm_runner.platform import make_disk_router
from llm_runner.runner import cache_registry, lifecycle
from llm_runner.runner.lifecycle import RunnerService


# ── which roots an app ends up with ──────────────────────────────────────────

def test_own_cache_is_the_default_and_changes_nothing(tmp_path):
    cache, runtime, shared = resolve_cache_roots(tmp_path)
    assert cache == tmp_path / "ai-cache"
    assert shared is False
    # None → the service keeps writing models.ini + logs exactly where it always did,
    # so an existing install needs no migration.
    assert runtime is None


def test_a_stored_choice_shares_the_cache_but_never_the_generated_state(tmp_path):
    sibling = tmp_path / "other-app" / "ai-cache"
    cache, runtime, shared = resolve_cache_roots(tmp_path / "mine", stored=str(sibling))
    assert cache == sibling and shared is True
    # The ini + spawn logs move under THIS app's data dir — the whole point.
    assert runtime == tmp_path / "mine" / "ai-runtime"


def test_an_explicit_argument_beats_the_stored_choice(tmp_path):
    cache, _runtime, shared = resolve_cache_roots(
        tmp_path, cache_root=str(tmp_path / "wired"), stored=str(tmp_path / "stored"))
    assert cache == tmp_path / "wired" and shared is True


def test_choosing_your_own_path_is_not_sharing(tmp_path):
    # Storing the app's own path explicitly must not trip the shared branch.
    cache, runtime, shared = resolve_cache_roots(tmp_path, stored=str(tmp_path / "ai-cache"))
    assert cache == tmp_path / "ai-cache" and shared is False and runtime is None


def test_service_keeps_generated_state_out_of_a_shared_cache(tmp_path):
    """The bite: with models.ini left in the cache, two apps sharing one would each
    overwrite the other's preset file."""
    shared_cache = tmp_path / "shared"
    svc = RunnerService(shared_cache, runtime_root=tmp_path / "mine" / "ai-runtime")
    assert svc.cache_root == shared_cache
    assert svc.runtime_root == tmp_path / "mine" / "ai-runtime"

    seen = {}
    svc._start_router = lambda exe, **kw: (seen.update(kw), SimpleNamespace(
        url="http://127.0.0.1:8080", is_alive=lambda: True, stop=lambda: None))[1]
    svc._find_port = lambda h, p: p
    svc._spawn_router(tmp_path / "llama-server.exe", svc._config_fn())

    assert Path(seen["models_preset"]) == tmp_path / "mine" / "ai-runtime" / "models.ini"
    assert Path(seen["models_dir"]) == shared_cache / "hf"     # weights DO come from the shared one


def test_an_unshared_service_writes_where_it_always_did(tmp_path):
    svc = RunnerService(tmp_path / "ai-cache")
    assert svc.runtime_root == tmp_path / "ai-cache" / "llamacpp"


# ── discovery ────────────────────────────────────────────────────────────────

@pytest.fixture
def family_home(tmp_path, monkeypatch):
    """Point the registry at a throwaway home through the SAME env var a real
    deployment would use — patching `family_home` would skip the write guard these
    tests also need to exercise."""
    home = tmp_path / "family"
    monkeypatch.setenv("JUST_AI_HOME", str(home))
    return home


def test_an_app_registers_itself_so_the_next_one_can_find_it(tmp_path, family_home):
    cache_registry.register("JustWrite", tmp_path / "jw" / "ai-cache", tmp_path / "jw")
    entries = json.loads((family_home / "caches.json").read_text(encoding="utf-8"))["apps"]
    assert [e["product"] for e in entries] == ["JustWrite"]

    # Idempotent by product — a hundred boots leave one row, not a hundred.
    cache_registry.register("JustWrite", tmp_path / "jw" / "ai-cache", tmp_path / "jw")
    entries = json.loads((family_home / "caches.json").read_text(encoding="utf-8"))["apps"]
    assert len(entries) == 1


def test_discovery_reports_a_sibling_with_what_is_in_it(tmp_path, family_home):
    jw = tmp_path / "jw" / "ai-cache"
    (jw / "llamacpp" / "b10107").mkdir(parents=True)
    (jw / "llamacpp" / "b10107" / "llama-server.exe").write_bytes(b"x" * 100)
    (jw / "hf" / "models--unsloth--gemma-4-26B-A4B-it-qat-GGUF").mkdir(parents=True)
    cache_registry.register("JustWrite", jw, tmp_path / "jw")

    found = cache_registry.discover(exclude=tmp_path / "mine" / "ai-cache")
    assert len(found) == 1
    assert found[0]["product"] == "JustWrite"
    assert found[0]["engineBuilds"] == ["b10107"]
    assert found[0]["models"] == ["unsloth/gemma-4-26B-A4B-it-qat-GGUF"]
    assert found[0]["bytes"] == 100


def test_your_own_cache_is_never_offered_to_you(tmp_path, family_home):
    mine = tmp_path / "mine" / "ai-cache"
    mine.mkdir(parents=True)
    cache_registry.register("Mine", mine, tmp_path / "mine")
    assert cache_registry.discover(exclude=mine) == []


def test_a_vanished_cache_is_pruned_not_offered(tmp_path, family_home):
    """An entry is a claim about the disk, not a subscription. An uninstalled app or a
    throwaway run leaves a path that no longer exists, and "share JustWrite's 0 B
    cache" is worse than saying nothing."""
    gone = tmp_path / "gone" / "ai-cache"
    cache_registry.register("Gone", gone, tmp_path / "gone")
    assert cache_registry.discover(exclude=tmp_path / "mine") == []


def test_two_installs_of_one_app_do_not_erase_each_other(tmp_path, family_home):
    """Keying on product alone let whichever booted last delete the other's row —
    which is how a pytest run with a tmp data dir replaced the real JustWrite entry."""
    dev = tmp_path / "dev" / "ai-cache"
    release = tmp_path / "release" / "ai-cache"
    dev.mkdir(parents=True)
    release.mkdir(parents=True)
    cache_registry.register("JustWrite", dev, tmp_path / "dev")
    cache_registry.register("JustWrite", release, tmp_path / "release")

    roots = {Path(e["root"]) for e in cache_registry.discover(exclude=tmp_path / "mine")}
    assert roots == {dev, release}
    # Still idempotent for the SAME install.
    cache_registry.register("JustWrite", dev, tmp_path / "dev")
    assert len(cache_registry.discover(exclude=tmp_path / "mine")) == 2


def test_an_install_that_switches_cache_leaves_no_ghost_row(tmp_path, family_home):
    """Seen live: after one switch and one switch back, the registry listed the app
    against BOTH roots — one of which it no longer used. The install (data dir) is the
    thing that has a cache; the root is only what it currently says about itself."""
    own = tmp_path / "mine" / "ai-cache"
    sibling = tmp_path / "jw" / "ai-cache"
    own.mkdir(parents=True)
    sibling.mkdir(parents=True)
    cache_registry.register("Mine", own, tmp_path / "mine")
    cache_registry.register("Mine", sibling, tmp_path / "mine")   # the user shares

    rows = cache_registry.discover(exclude=tmp_path / "elsewhere")
    assert [Path(r["root"]) for r in rows] == [sibling]


def test_a_suite_that_forgets_the_override_writes_NOTHING(tmp_path, monkeypatch):
    """The bite for the incident itself: without this guard, three repos' pytest runs
    wrote `pytest-of-<user>/…` paths into the author's real machine-wide registry."""
    monkeypatch.delenv("JUST_AI_HOME", raising=False)
    monkeypatch.setattr(cache_registry, "family_home", lambda: tmp_path / "real")
    cache_registry.register("Leaky", tmp_path / "c")
    assert not (tmp_path / "real").exists()


def test_an_explicit_override_still_writes(tmp_path, monkeypatch):
    monkeypatch.setenv("JUST_AI_HOME", str(tmp_path / "elsewhere"))
    cache_registry.register("X", tmp_path / "c")
    assert (tmp_path / "elsewhere" / "caches.json").is_file()


def test_a_corrupt_registry_reads_as_an_empty_one(tmp_path, family_home):
    family_home.mkdir(parents=True)
    (family_home / "caches.json").write_text("{not json", encoding="utf-8")
    assert cache_registry.discover() == []          # never raises into a boot
    cache_registry.register("New", tmp_path / "c")  # and recovers on the next write
    assert [e["product"] for e in
            json.loads((family_home / "caches.json").read_text(encoding="utf-8"))["apps"]] == ["New"]


# ── what the wizard is shown, and what the disk panel measures ───────────────

@pytest.fixture
def wired(tmp_path, monkeypatch):
    """A configured service whose cache is a sibling's — the post-share state."""
    shared = tmp_path / "jw" / "ai-cache"
    (shared / "hf" / "models--org--big").mkdir(parents=True)
    (shared / "hf" / "models--org--big" / "blob").write_bytes(b"x" * 9000)
    (shared / "llamacpp" / "b10107").mkdir(parents=True)
    svc = RunnerService(shared, runtime_root=tmp_path / "mine" / "ai-runtime")
    monkeypatch.setattr(lifecycle, "_service", svc)
    return SimpleNamespace(shared=shared, data_dir=tmp_path / "mine", svc=svc)


def test_the_wizard_is_offered_the_way_back(tmp_path, family_home, wired):
    cache_registry.register("JustWrite", wired.shared, tmp_path / "jw")
    app = FastAPI()
    app.include_router(make_cache_router(wired.data_dir, "Mine"))
    body = TestClient(app).get("/v1/ai/engine-cache").json()

    assert body["shared"] is True
    assert Path(body["root"]) == wired.shared
    assert Path(body["runtimeRoot"]) == wired.data_dir / "ai-runtime"
    assert body["current"]["models"] == ["org/big"]
    # "keep my own" is always an option, even though that directory doesn't exist yet.
    assert [Path(o["root"]) for o in body["options"]] == [wired.data_dir / "ai-cache"]
    # And a cache already in use is never offered as something to switch to.
    assert all(Path(o["root"]) != wired.shared for o in body["options"])


def test_your_own_cache_is_offered_once_even_after_you_start_sharing(tmp_path, family_home,
                                                                     wired):
    """Seen live: the app's own row is still in the registry from boot, so excluding
    only the cache IN USE listed "keep my own" twice."""
    (wired.data_dir / "ai-cache").mkdir(parents=True)
    cache_registry.register("Mine", wired.data_dir / "ai-cache", wired.data_dir)
    cache_registry.register("JustWrite", wired.shared, tmp_path / "jw")
    app = FastAPI()
    app.include_router(make_cache_router(wired.data_dir, "Mine"))
    roots = [Path(o["root"]) for o in TestClient(app).get("/v1/ai/engine-cache").json()["options"]]
    assert roots == [wired.data_dir / "ai-cache"]


def test_switching_applies_live_while_the_engine_is_idle(tmp_path, family_home, wired,
                                                         monkeypatch):
    """A choice recorded but not applied would be contradicted by the very download
    the wizard starts next — so idle means apply now."""
    monkeypatch.setattr("llm_runner.llm.stores.get_runner_config_store",
                        lambda: SimpleNamespace(set_cache_root=lambda v: None))
    app = FastAPI()
    app.include_router(make_cache_router(wired.data_dir, "Mine"))
    body = TestClient(app).put("/v1/ai/engine-cache",
                               json={"root": str(wired.data_dir / "ai-cache")}).json()

    assert body["applied"] is True and body["restartRequired"] is False
    assert wired.svc.cache_root == wired.data_dir / "ai-cache"
    # The ini bookkeeping must reset, or the emitter compares against the OLD root's
    # text and never writes one into the new location.
    assert wired.svc._last_ini_text == ""


def test_switching_under_a_live_engine_waits_for_a_restart(tmp_path, family_home, wired,
                                                           monkeypatch):
    monkeypatch.setattr("llm_runner.llm.stores.get_runner_config_store",
                        lambda: SimpleNamespace(set_cache_root=lambda v: None))
    wired.svc._router = SimpleNamespace(url="http://127.0.0.1:8080",
                                        is_alive=lambda: True, stop=lambda: None)
    app = FastAPI()
    app.include_router(make_cache_router(wired.data_dir, "Mine"))
    body = TestClient(app).put("/v1/ai/engine-cache",
                               json={"root": str(wired.data_dir / "ai-cache")}).json()

    assert body["applied"] is False and body["restartRequired"] is True
    assert "unload" in body["detail"]
    assert wired.svc.cache_root == wired.shared   # unchanged under a running engine


def test_disk_usage_measures_the_cache_actually_in_use(wired):
    """Without this the Storage panel reports a confident 0 B for 9 KB it can see —
    or, on the real box, for 14 GB."""
    app = FastAPI()
    app.include_router(make_disk_router(str(wired.data_dir)))
    body = TestClient(app).get("/v1/disk/usage").json()
    assert body["modelsCache"] == 9000
    assert body["cacheShared"] is True
