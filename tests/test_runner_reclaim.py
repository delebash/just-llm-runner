# SPDX-License-Identifier: GPL-3.0-or-later
"""The two reclaim endpoints on the runner router:
- POST /v1/llm-runner/spawn-logs/clear removes the per-spawn *.log files (dir kept).
- POST /v1/llm-runner/models-cache/clear wipes the HF cache, but REFUSES while a
  model is resident (safe-by-design: the catalog rows persist, models re-download).

Follows test_runner_models.py: build the real router, monkeypatch api.get_service
to a real RunnerService pointed at a tmp cache_root so the filesystem ops run."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

import llm_runner.runner.api as api
from llm_runner.runner.lifecycle import RunnerService


def _client():
    app = FastAPI()
    app.include_router(api.router)
    return TestClient(app)


def _svc(tmp_path):
    return RunnerService(str(tmp_path))  # cache_root = tmp_path; nothing spawned


def test_spawn_logs_clear_removes_log_files(tmp_path, monkeypatch):
    logs = tmp_path / "llamacpp" / "logs"
    logs.mkdir(parents=True)
    (logs / "runner-a.log").write_bytes(b"x" * 100)
    (logs / "router-b.log").write_bytes(b"y" * 40)
    (logs / "keep.txt").write_text("not a log")  # a non-.log file is left alone
    monkeypatch.setattr(api, "get_service", lambda: _svc(tmp_path))

    body = _client().post("/v1/llm-runner/spawn-logs/clear").json()
    assert body["removed"] == 2
    assert body["bytes"] == 140
    assert not (logs / "runner-a.log").exists()
    assert not (logs / "router-b.log").exists()
    assert logs.is_dir()                     # the dir itself is kept
    assert (logs / "keep.txt").exists()      # only *.log removed


def test_spawn_logs_clear_no_dir_is_zero(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "get_service", lambda: _svc(tmp_path))  # no llamacpp/logs
    body = _client().post("/v1/llm-runner/spawn-logs/clear").json()
    assert body == {"removed": 0, "bytes": 0}


def test_models_cache_clear_refuses_when_resident(tmp_path, monkeypatch):
    blob = tmp_path / "hf" / "models--org--m" / "blobs" / "abc"
    blob.parent.mkdir(parents=True)
    blob.write_bytes(b"z" * 4096)
    svc = _svc(tmp_path)
    # A resident (loaded) model → refuse WITHOUT deleting.
    monkeypatch.setattr(svc, "resident", lambda hw=None: {"models": [{"id": "m", "status": "loaded"}]})
    monkeypatch.setattr(api, "get_service", lambda: svc)

    body = _client().post("/v1/llm-runner/models-cache/clear").json()
    assert body["ok"] is False
    assert body["detail"] == "unload models first"
    assert body["models"] == ["m"]
    assert blob.exists()                     # nothing deleted while resident


def test_models_cache_clear_wipes_when_idle(tmp_path, monkeypatch):
    hf = tmp_path / "hf"
    blob = hf / "models--org--m" / "blobs" / "abc"
    blob.parent.mkdir(parents=True)
    blob.write_bytes(b"z" * 4096)
    svc = _svc(tmp_path)
    # No resident models → wipe and recreate empty.
    monkeypatch.setattr(svc, "resident", lambda hw=None: {"models": []})
    monkeypatch.setattr(api, "get_service", lambda: svc)

    body = _client().post("/v1/llm-runner/models-cache/clear").json()
    assert body["ok"] is True
    assert body["bytes"] == 4096
    assert not blob.exists()                 # weights gone
    assert hf.is_dir() and list(hf.iterdir()) == []  # recreated empty


def test_models_cache_clear_refuses_when_loading(tmp_path, monkeypatch):
    # A model still LOADING (mid-download/spawn) is also in-use → refuse.
    svc = _svc(tmp_path)
    monkeypatch.setattr(svc, "resident", lambda hw=None: {"models": [{"id": "x", "status": "loading"}]})
    monkeypatch.setattr(api, "get_service", lambda: svc)
    body = _client().post("/v1/llm-runner/models-cache/clear").json()
    assert body["ok"] is False and body["detail"] == "unload models first"
