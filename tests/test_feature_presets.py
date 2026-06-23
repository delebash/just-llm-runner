# SPDX-License-Identifier: GPL-3.0-or-later
"""The shared feature-presets router — CRUD + use (mark production) over the host
FeaturePresetStore. Presets are per ACTION; set_active clears the action's others."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from llm_runner.llm import FeaturePreset, make_feature_presets_router


class FakeStore:
    """In-memory FeaturePresetStore — mirrors the JW table's set_active semantics
    (clear the same action's other actives)."""

    def __init__(self):
        self._items: dict[str, FeaturePreset] = {}

    def list_presets(self):
        return list(self._items.values())

    def save_preset(self, preset):
        self._items[preset.id] = preset
        return preset

    def delete_preset(self, preset_id):
        self._items.pop(preset_id, None)

    def set_active(self, preset_id):
        row = self._items.get(preset_id)
        if row is None:
            return
        for other in self._items.values():
            if other.action == row.action:
                other.active = False
        row.active = True


def _client(store):
    app = FastAPI()
    app.include_router(make_feature_presets_router(lambda: store))
    return TestClient(app)


def test_create_requires_action_and_name():
    c = _client(FakeStore())
    assert c.post("/v1/ai/feature-presets", json={"name": "x"}).status_code == 400
    assert c.post("/v1/ai/feature-presets", json={"action": "writerAI.tighten"}).status_code == 400


def test_create_list_delete():
    c = _client(FakeStore())
    assert c.get("/v1/ai/feature-presets").json() == {"presets": []}
    body = c.post("/v1/ai/feature-presets",
                  json={"action": "writerAI.tighten", "name": "Big", "providerId": "cloud", "model": "sonnet"}).json()
    assert len(body["presets"]) == 1
    p = body["presets"][0]
    assert p["action"] == "writerAI.tighten" and p["name"] == "Big" and p["model"] == "sonnet"
    assert p["active"] is False
    assert c.request("DELETE", f"/v1/ai/feature-presets/{p['id']}").json() == {"presets": []}


def _id(presets, name):
    # The router returns the full list (insertion order), so find by name rather
    # than assuming the newest is first.
    return next(p["id"] for p in presets if p["name"] == name)


def test_use_marks_active_per_action():
    c = _client(FakeStore())
    a1 = _id(c.post("/v1/ai/feature-presets", json={"action": "writerAI.tighten", "name": "A"}).json()["presets"], "A")
    a2 = _id(c.post("/v1/ai/feature-presets", json={"action": "writerAI.tighten", "name": "B"}).json()["presets"], "B")
    other = _id(c.post("/v1/ai/feature-presets", json={"action": "critique", "name": "C"}).json()["presets"], "C")
    c.post(f"/v1/ai/feature-presets/{a1}/use")
    by_id = {p["id"]: p for p in c.post(f"/v1/ai/feature-presets/{a2}/use").json()["presets"]}
    # a2 active, a1 cleared (same action), critique untouched
    assert by_id[a2]["active"] is True
    assert by_id[a1]["active"] is False
    assert by_id[other]["active"] is False
    assert c.post("/v1/ai/feature-presets/nope/use").status_code == 404


def test_update_preserves_action_and_active():
    c = _client(FakeStore())
    pid = c.post("/v1/ai/feature-presets", json={"action": "chat", "name": "A"}).json()["presets"][0]["id"]
    c.post(f"/v1/ai/feature-presets/{pid}/use")
    body = c.put(f"/v1/ai/feature-presets/{pid}",
                 json={"action": "DIFFERENT", "name": "B", "active": False, "model": "m"}).json()
    p = body["presets"][0]
    assert p["action"] == "chat"  # an update never changes which action a preset configures
    assert p["active"] is True    # active preserved across an edit
    assert p["name"] == "B" and p["model"] == "m"
    assert c.put("/v1/ai/feature-presets/nope", json={"action": "x", "name": "y"}).status_code == 404
