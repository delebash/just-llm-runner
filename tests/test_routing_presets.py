# SPDX-License-Identifier: GPL-3.0-or-later
"""The shared routing-presets router — CRUD + from-current + apply over the host
RoutingPresetStore and RoutingStore."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from llm_runner.llm import RoutingConfig, RoutingPreset, make_routing_presets_router
from llm_runner.llm.routing_api import JobTarget, RoutingDefaults


class FakePresetStore:
    def __init__(self):
        self._items: dict[str, RoutingPreset] = {}

    def list_presets(self):
        return list(self._items.values())

    def save_preset(self, preset):
        self._items[preset.id] = preset

    def delete_preset(self, preset_id):
        self._items.pop(preset_id, None)


class FakeRoutingStore:
    def __init__(self):
        self.cfg = RoutingConfig()

    def get_routing(self):
        return self.cfg

    def set_routing(self, cfg):
        self.cfg = cfg


def _client(preset_store, routing_store):
    app = FastAPI()
    app.include_router(make_routing_presets_router(lambda: preset_store, lambda: routing_store))
    return TestClient(app)


def test_create_list_delete():
    c = _client(FakePresetStore(), FakeRoutingStore())
    assert c.get("/v1/ai/routing-presets").json() == {"presets": []}
    body = c.post("/v1/ai/routing-presets",
                  json={"name": "Desktop", "routing": {"default": {"llmId": "local-llamacpp"}}}).json()
    assert len(body["presets"]) == 1
    p = body["presets"][0]
    assert p["name"] == "Desktop" and p["routing"]["default"]["llmId"] == "local-llamacpp"
    assert c.request("DELETE", f"/v1/ai/routing-presets/{p['id']}").json() == {"presets": []}


def test_from_current_snapshots_active_routing():
    rs = FakeRoutingStore()
    rs.cfg = RoutingConfig(default=RoutingDefaults(llmId="claude"),
                           jobs={"prose": JobTarget(providerId="local", model="qwen")})
    c = _client(FakePresetStore(), rs)
    p = c.post("/v1/ai/routing-presets/from-current", json={"name": "Now"}).json()["presets"][0]
    assert p["name"] == "Now"
    assert p["routing"]["default"]["llmId"] == "claude"
    assert p["routing"]["jobs"]["prose"]["model"] == "qwen"


def test_update_rename_and_routing():
    c = _client(FakePresetStore(), FakeRoutingStore())
    pid = c.post("/v1/ai/routing-presets", json={"name": "A"}).json()["presets"][0]["id"]
    assert c.put(f"/v1/ai/routing-presets/{pid}", json={"name": "B"}).json()["presets"][0]["name"] == "B"
    body = c.put(f"/v1/ai/routing-presets/{pid}", json={"routing": {"default": {"llmId": "x"}}}).json()
    assert body["presets"][0]["routing"]["default"]["llmId"] == "x"
    assert body["presets"][0]["name"] == "B"  # rename preserved across a routing-only update
    assert c.put("/v1/ai/routing-presets/nope", json={"name": "Z"}).status_code == 404


def test_apply_writes_active_routing():
    rs = FakeRoutingStore()
    c = _client(FakePresetStore(), rs)
    pid = c.post("/v1/ai/routing-presets",
                 json={"name": "P", "routing": {"default": {"llmId": "local-llamacpp"},
                                                "jobs": {"analysis": {"providerId": "anthropic", "model": "sonnet"}}}}
                 ).json()["presets"][0]["id"]
    assert rs.cfg.default.llmId == ""  # not applied yet
    applied = c.post(f"/v1/ai/routing-presets/{pid}/apply").json()
    assert applied["name"] == "P"
    assert rs.cfg.default.llmId == "local-llamacpp"  # active routing now updated
    assert rs.cfg.jobs["analysis"].model == "sonnet"
    assert c.post("/v1/ai/routing-presets/nope/apply").status_code == 404
