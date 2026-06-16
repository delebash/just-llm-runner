# SPDX-License-Identifier: GPL-3.0-or-later
"""Manifest schema + loader + camelCase contract + mountable router."""

from __future__ import annotations

import json

from fastapi import FastAPI
from fastapi.testclient import TestClient

from llm_runner import load_manifest, router
from llm_runner.manifest import manifest_path


def _client():
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def test_manifest_loads_and_validates():
    m = load_manifest(refresh=True)
    assert m.schema_version == 1
    assert m.llamacpp.pinned_build and m.llamacpp.pinned_build != "latest"
    assert m.llamacpp.binaries
    for b in m.llamacpp.binaries:
        assert b.asset_url or b.image


def test_models_are_hf_repos_with_quant():
    m = load_manifest(refresh=True)
    assert m.models
    for e in m.models:
        assert "/" in e.hf_repo and e.quant
        assert e.tier in {"cpu", "low-vram-moe", "mid", "high"}


def test_json_keys_are_camelcase():
    raw = json.loads(manifest_path().read_text(encoding="utf-8"))
    assert "schemaVersion" in raw and "flagPresets" in raw and "vramFit" in raw
    assert "pinnedBuild" in raw["llamacpp"]
    assert "schema_version" not in raw and "pinned_build" not in raw["llamacpp"]


def test_manifest_endpoint_camelcase():
    r = _client().get("/v1/llm-runner/manifest")
    assert r.status_code == 200
    body = r.json()
    assert body["schemaVersion"] == 1
    assert "--spec-type" in body["flagPresets"]["mtp"]
    assert "-ngl" in body["flagPresets"]["base"]
    assert "schema_version" not in body


def test_hardware_endpoint():
    r = _client().get("/v1/llm-runner/hardware")
    assert r.status_code == 200
    body = r.json()
    assert body["platform"] in {"windows", "macos", "linux"}
    assert "cpuCores" in body and "runtimes" in body
