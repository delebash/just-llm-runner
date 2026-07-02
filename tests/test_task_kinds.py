# SPDX-License-Identifier: GPL-3.0-or-later
"""make_task_kinds_router — CRUD over the user-editable tasks + the resolved
action→taskKind map (built from the prompt store through the wired task_kind_of)."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from llm_runner.llm.seed import DEFAULT_TASK_KINDS
from llm_runner.llm.task_kinds_api import TaskKindRow, make_task_kinds_router


class _Row:
    def __init__(self, key):
        self.key = key


class _MemPromptStore:
    def __init__(self, keys):
        self._keys = keys

    def list(self):
        return [_Row(k) for k in self._keys]


class _MemTaskKindStore:
    """In-memory mirror of the real TaskKindStore (built-in delete guard + slug id)."""

    def __init__(self):
        self._rows: dict[str, TaskKindRow] = {}
        for i, t in enumerate(DEFAULT_TASK_KINDS):
            self._rows[t["id"]] = TaskKindRow(id=t["id"], label=t["label"], description=t["description"],
                                              position=i, builtIn=True)

    def list(self):
        return sorted(self._rows.values(), key=lambda r: (r.position, r.id))

    def upsert(self, row):
        tid = (row.id or "").strip()
        if not tid:
            base = (row.label or "task").strip().lower().replace(" ", ".")
            tid = base
            n = 2
            while tid in self._rows:
                tid = f"{base}-{n}"
                n += 1
        cur = self._rows.get(tid)
        self._rows[tid] = TaskKindRow(id=tid, label=row.label, description=row.description or "",
                                      position=(cur.position if cur else len(self._rows)),
                                      builtIn=(cur.builtIn if cur else False))
        return self._rows[tid]

    def delete(self, task_id):
        row = self._rows.get(task_id)
        if row is None:
            return
        if row.builtIn:
            raise ValueError("cannot delete a built-in task")
        del self._rows[task_id]


class _MemFeatureTaskKindStore:
    def __init__(self):
        self._m: dict[str, str] = {}

    def list(self):
        return dict(self._m)

    def set(self, key, task_kind):
        if not task_kind:
            self._m.pop(key, None)
        else:
            self._m[key] = task_kind


# The action-keyed resolver install.py wires: DB row → in-memory seed map → rule.* prefix → "".
def _make_task_kind_of(feat_store):
    seed_map = {"writerAI.continue": "prose.generate", "writerAI.tighten": "prose.edit", "chat": "chat.grounded"}

    def _resolve(key):
        row = feat_store.list().get(key)
        if row:
            return row
        if key in seed_map:
            return seed_map[key]
        if key.startswith("writerAI.rule."):
            return "prose.edit"
        return ""

    return _resolve


def _client(with_resolver=True):
    tasks = _MemTaskKindStore()
    feats = _MemFeatureTaskKindStore()
    prompts = _MemPromptStore(["writerAI.continue", "writerAI.tighten", "writerAI.rule.filter-words", "chat", "orphan"])
    tk_of = _make_task_kind_of(feats) if with_resolver else None
    app = FastAPI()
    app.include_router(make_task_kinds_router(lambda: tasks, lambda: feats, lambda: prompts, task_kind_of=tk_of))
    return TestClient(app), tasks, feats


def test_catalog_and_map():
    c, _, _ = _client()
    body = c.get("/v1/ai/task-kinds").json()
    # The catalog is served from the store, seeded with the nine shared defaults.
    assert [t["id"] for t in body["taskKinds"]] == [t["id"] for t in DEFAULT_TASK_KINDS]
    assert len(body["taskKinds"]) == 9
    assert all(t["label"] and t["description"] for t in body["taskKinds"])
    assert all(t["builtIn"] for t in body["taskKinds"])
    # The map is built via task_kind_of over the prompt store: explicit + the rule.*
    # prefix rule; an action that resolves to "" (orphan) is omitted.
    m = body["featureTaskKinds"]
    assert m["writerAI.continue"] == "prose.generate"
    assert m["writerAI.tighten"] == "prose.edit"
    assert m["writerAI.rule.filter-words"] == "prose.edit"   # prefix rule, not seeded
    assert m["chat"] == "chat.grounded"
    assert "orphan" not in m


def test_no_resolver_degrades_to_empty_map():
    c, _, _ = _client(with_resolver=False)
    body = c.get("/v1/ai/task-kinds").json()
    assert len(body["taskKinds"]) == 9
    assert body["featureTaskKinds"] == {}


def test_create_custom_task():
    c, _, _ = _client()
    body = c.post("/v1/ai/task-kinds", json={"label": "My Task", "description": "custom"}).json()
    created = next((t for t in body["taskKinds"] if t["id"] == "my.task"), None)
    assert created is not None
    assert created["builtIn"] is False
    body = c.delete("/v1/ai/task-kinds/my.task").json()
    assert "my.task" not in [t["id"] for t in body["taskKinds"]]


def test_builtin_delete_blocked():
    c, _, _ = _client()
    r = c.delete("/v1/ai/task-kinds/prose.generate")
    assert r.status_code == 400
    assert "built-in" in r.json()["detail"]


def test_reassign_feature_wins_then_clear_refloats():
    c, _, feats = _client()
    # reassign chat (seed map → chat.grounded) to another task
    body = c.put("/v1/ai/task-kinds/feature", json={"featureKey": "chat", "taskKind": "chat.inVoice"}).json()
    assert body["featureTaskKinds"]["chat"] == "chat.inVoice"
    assert feats.list()["chat"] == "chat.inVoice"
    # clearing drops the override → re-floats to the factory (seed map) value
    body = c.put("/v1/ai/task-kinds/feature", json={"featureKey": "chat", "taskKind": ""}).json()
    assert body["featureTaskKinds"]["chat"] == "chat.grounded"
    assert "chat" not in feats.list()
