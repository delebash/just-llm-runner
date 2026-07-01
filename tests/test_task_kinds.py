# SPDX-License-Identifier: GPL-3.0-or-later
"""make_task_kinds_router — serves the canonical nine + the resolved action→taskKind
map (from the host's prompt store through the wired `task_kind_of`)."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from llm_runner.llm.task_kinds_api import TASK_KINDS, make_task_kinds_router


class _Row:
    def __init__(self, key):
        self.key = key


class _MemPromptStore:
    def __init__(self, keys):
        self._keys = keys

    def list(self):
        return [_Row(k) for k in self._keys]


# The same action-keyed resolver install.py wires (map + writerAI.rule.* prefix).
def _task_kind_of(key):
    m = {"writerAI.continue": "prose.generate", "writerAI.tighten": "prose.edit", "chat": "chat.grounded"}
    if key in m:
        return m[key]
    if key.startswith("writerAI.rule."):
        return "prose.edit"
    return ""


def _client(task_kind_of=_task_kind_of):
    store = _MemPromptStore(["writerAI.continue", "writerAI.tighten", "writerAI.rule.filter-words", "chat", "orphan"])
    app = FastAPI()
    app.include_router(make_task_kinds_router(lambda: store, task_kind_of=task_kind_of))
    return TestClient(app)


def test_task_kinds_catalog_and_map():
    body = _client().get("/v1/ai/task-kinds").json()
    # The nine canonical shapes, verbatim + in order.
    assert [t["id"] for t in body["taskKinds"]] == [t["id"] for t in TASK_KINDS]
    assert len(body["taskKinds"]) == 9
    assert all(t["label"] and t["description"] for t in body["taskKinds"])
    # The resolved action→taskKind map: explicit entries + the rule.* prefix rule;
    # an action that resolves to "" (orphan) is omitted.
    m = body["featureTaskKinds"]
    assert m["writerAI.continue"] == "prose.generate"
    assert m["writerAI.tighten"] == "prose.edit"
    assert m["writerAI.rule.filter-words"] == "prose.edit"   # prefix rule
    assert m["chat"] == "chat.grounded"
    assert "orphan" not in m                                  # no taskKind → omitted


def test_task_kinds_no_resolver_degrades_to_empty_map():
    # task_kind_of None (no map wired) → catalog still served, map empty.
    body = _client(task_kind_of=None).get("/v1/ai/task-kinds").json()
    assert len(body["taskKinds"]) == 9
    assert body["featureTaskKinds"] == {}
