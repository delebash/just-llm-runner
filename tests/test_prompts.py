# SPDX-License-Identifier: GPL-3.0-or-later
"""The shared prompt subsystem — render, the editor router, and the
feature-execution router (all over an in-memory PromptStore)."""

from __future__ import annotations

import pytest
import sqlalchemy as sa
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from llm_runner.llm import db
from llm_runner.llm import (
    FeaturePromptRow,
    LLMConfig,
    LLMResponse,
    StreamDelta,
    get_llm_registry,
    make_feature_router,
    make_prompt_router,
    render,
)
from llm_runner.llm.dispatch import set_ensure_local_model


@pytest.fixture(autouse=True)
def _isolated_storage():
    # The /run path resolves the preset via db.session() (resolve_feature_preset);
    # without a configured store these tests fail in ISOLATION. Per-test in-memory DB.
    engine = sa.create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    db.LlmBase.metadata.create_all(engine)
    db.configure_storage(sessionmaker(bind=engine))
    yield


@pytest.fixture(autouse=True)
def _reset_ensure_hook():
    # QC-43b: the dispatch ensure-local hook is a process global — keep it OFF by
    # default (existing tests are unaffected) and clean it up after a test sets it.
    set_ensure_local_model(None)
    yield
    set_ensure_local_model(None)


# ── a host store + seed defaults, in memory ─────────────────────────────────
DEFAULTS = {
    "greet": {
        "feature": "greet",
        "system": "You are {{role}}.",
        "user_template": "Hi {{name}}",
    },
    "farewell": {
        "feature": "greet",  # two actions can share one routing feature
        "system": "You are {{role}}.",
        "user_template": "Bye {{name}}",
    },
}


class MemPromptStore:
    """In-memory PromptStore for tests; seeded from DEFAULTS."""

    def __init__(self):
        self._rows: dict[str, FeaturePromptRow] = {}
        for key, spec in DEFAULTS.items():
            self._rows[key] = FeaturePromptRow(
                key=key, feature=spec["feature"], system=spec["system"],
                user_template=spec["user_template"], built_in=True,
            )

    def get(self, key):
        return self._rows.get(key)

    def list(self):
        return [self._rows[k] for k in sorted(self._rows)]

    def upsert(self, row):
        # mirror the real store: built_in is preserved on update, set on insert
        existing = self._rows.get(row.key)
        if existing is not None:
            row.built_in = existing.built_in
        self._rows[row.key] = row


class CaptureAdapter:
    """Records the system + user content it's handed so tests can assert the
    rendered prompt reached the model."""

    def __init__(self):
        self.provider_id = "fake"
        self.provider_type = "openai-compat"
        self.default_model = "m"
        self.last = {}

    def chat(self, messages, *, model=None, temperature=0.7, max_tokens=None,
             system=None, think=False, extra=None):
        self.last = {"system": system, "user": messages[-1].content, "think": think,
                     "extra": extra, "temperature": temperature}
        return LLMResponse(text="answer", model=model or self.default_model,
                           prompt_tokens=3, completion_tokens=7)

    def stream_chat(self, messages, *, model=None, temperature=0.7, max_tokens=None,
                    system=None, think=False, extra=None):
        self.last = {"system": system, "user": messages[-1].content, "stream": True}
        # Prompt-eval progress before the first token (§7.4 B6-2 — the builtin
        # engine's prompt_progress frames arrive as progress-only deltas).
        yield StreamDelta(progress=0.5)
        yield StreamDelta(text="ans")
        yield StreamDelta(text="wer")
        yield StreamDelta(done=True, prompt_tokens=2, completion_tokens=4)

    def models(self):
        return [self.default_model]

    def ping(self):
        return True


def _editor_client(store):
    app = FastAPI()
    app.include_router(make_prompt_router(lambda: store, DEFAULTS))
    return TestClient(app, raise_server_exceptions=False)


def _feature_client(store, *, register=True):
    """Mount the execution router; optionally register a CaptureAdapter into the
    global registry the dispatch reads (the router calls dispatch without an
    explicit registry)."""
    get_llm_registry()._adapters = {}
    adapter = CaptureAdapter()
    if register:
        get_llm_registry().register(adapter)
    app = FastAPI()
    app.include_router(make_feature_router(lambda: store, lambda: LLMConfig()))
    return TestClient(app, raise_server_exceptions=False), adapter


def _local_route_client(provider_id):
    """A feature-execution client whose sole registered adapter has `provider_id` (so
    resolve_route's first-adapter fallback resolves to it) — lets a test route to the
    local runner id (== LLMConfig().local_runner_provider_id) or a cloud id at will."""
    get_llm_registry()._adapters = {}
    adapter = CaptureAdapter()
    adapter.provider_id = provider_id
    get_llm_registry().register(adapter)
    app = FastAPI()
    app.include_router(make_feature_router(lambda: MemPromptStore(), lambda: LLMConfig()))
    return TestClient(app, raise_server_exceptions=False), adapter


# ── render ──────────────────────────────────────────────────────────────────
def test_render_substitutes_and_blanks_missing():
    assert render("Hi {{name}}, you are {{role}}", {"name": "Sam", "role": "bot"}) == "Hi Sam, you are bot"
    assert render("{{ name }} spaced", {"name": "X"}) == "X spaced"
    assert render("missing {{nope}} here", {}) == "missing  here"


# ── editor router ─────────────────────────────────────────────────────────────
def test_list_get_and_404():
    c = _editor_client(MemPromptStore())
    lst = c.get("/v1/ai/prompts").json()["prompts"]
    assert {p["key"] for p in lst} == {"greet", "farewell"}
    one = c.get("/v1/ai/prompts/greet").json()
    assert one["userTemplate"] == "Hi {{name}}" and one["builtIn"] is True
    assert c.get("/v1/ai/prompts/nope").status_code == 404


def test_edit_then_reset_roundtrip():
    store = MemPromptStore()
    c = _editor_client(store)
    # edit — a built-in key stays builtIn (so it can be reset)
    r = c.put("/v1/ai/prompts/greet", json={
        "system": "EDITED {{role}}", "userTemplate": "Yo {{name}}",
    })
    assert r.status_code == 200 and r.json()["builtIn"] is True
    assert store.get("greet").system == "EDITED {{role}}"
    # reset — back to the seeded default text
    r = c.post("/v1/ai/prompts/greet/reset").json()
    assert r["system"] == "You are {{role}}." and r["userTemplate"] == "Hi {{name}}"
    # reset of a non-seeded key → 400
    assert c.post("/v1/ai/prompts/custom/reset").status_code == 400


def test_create_user_prompt_not_builtin():
    store = MemPromptStore()
    c = _editor_client(store)
    r = c.put("/v1/ai/prompts/custom", json={"feature": "custom", "system": "s", "userTemplate": "u"}).json()
    assert r["builtIn"] is False and r["feature"] == "custom"


# ── feature-execution router ─────────────────────────────────────────────────
def test_run_renders_prompt_and_returns_content():
    c, adapter = _feature_client(MemPromptStore())
    r = c.post("/v1/ai/run", json={"action": "farewell", "variables": {"name": "Sam", "role": "bot"}})
    assert r.status_code == 200
    # content + model + token usage (so a Lab can rank columns by decode tok/s)
    assert r.json() == {"content": "answer", "model": "m", "promptTokens": 3, "completionTokens": 7, "cost": 0.0}
    # the DB template was rendered with the caller's variables before dispatch
    assert adapter.last["user"] == "Bye Sam"
    assert adapter.last["system"] == "You are bot."


def test_run_applies_adhoc_samplers():
    # #21 Lab column: ad-hoc samplers in the request reach the dispatch `extra`
    # (this call only), text values coerced to JSON types.
    c, adapter = _feature_client(MemPromptStore())
    r = c.post("/v1/ai/run", json={
        "action": "greet", "variables": {"name": "x", "role": "y"},
        "samplers": [{"flagName": "top_k", "flagValue": "40"}, {"flagName": "min_p", "flagValue": "0.05"}],
    })
    assert r.status_code == 200
    assert adapter.last["extra"]["top_k"] == 40       # int-coerced
    assert adapter.last["extra"]["min_p"] == 0.05     # float-coerced


def test_run_threads_reasoning_effort_into_extra():
    # a1/E2: with reasoning on, the level rides in extra under the reserved key
    # (each real adapter pops + maps it); json_mode forces reasoning off (B3), so
    # the level is NOT added then.
    c, adapter = _feature_client(MemPromptStore())
    c.post("/v1/ai/run", json={
        "action": "greet", "variables": {"name": "x", "role": "y"},
        "think": True, "reasoningEffort": "high",
    })
    assert adapter.last["extra"]["reasoning_effort"] == "high"
    # json_mode on → reasoning gated off → no level threaded.
    c.post("/v1/ai/run", json={
        "action": "greet", "variables": {"name": "x", "role": "y"},
        "think": True, "reasoningEffort": "high", "jsonMode": True,
    })
    assert "reasoning_effort" not in (adapter.last["extra"] or {})


def test_run_unknown_action_404():
    c, _ = _feature_client(MemPromptStore())
    assert c.post("/v1/ai/run", json={"action": "nope"}).status_code == 404


def test_run_no_provider_501():
    c, _ = _feature_client(MemPromptStore(), register=False)
    assert c.post("/v1/ai/run", json={"action": "greet", "variables": {"name": "x"}}).status_code == 501


def test_edit_changes_what_run_sends():
    store = MemPromptStore()
    editor = _editor_client(store)
    editor.put("/v1/ai/prompts/greet", json={
        "system": "NEW {{role}}", "userTemplate": "CHANGED {{name}}",
    })
    c, adapter = _feature_client(store)
    c.post("/v1/ai/run", json={"action": "greet", "variables": {"name": "Sam", "role": "bot"}})
    assert adapter.last["user"] == "CHANGED Sam"
    assert adapter.last["system"] == "NEW bot"


def test_stream_emits_sse_frames():
    c, adapter = _feature_client(MemPromptStore())
    with c.stream("POST", "/v1/ai/stream", json={"action": "greet", "variables": {"name": "Sam"}}) as r:
        body = "".join(chunk for chunk in r.iter_text())
    assert '"delta": "ans"' in body and '"delta": "wer"' in body
    assert '"done": true' in body and '"completionTokens": 4' in body
    # §7.4 B6-2: a progress delta becomes its own {"progress": p} frame,
    # never a text delta.
    assert '"progress": 0.5' in body
    # §7.4 B6-1: the done frame carries everything /run's response carries —
    # the dispatch stamps the RESOLVED model; cost is server-priced from it
    # (no price entry for "m" → 0.0, same as /run).
    assert '"model": "m"' in body and '"cost": 0.0' in body
    assert body.strip().endswith("data: [DONE]")
    assert adapter.last["user"] == "Hi Sam"


def test_effective_think_guardrail_off_under_json():
    """B3: think comes from the PRESET; a reasoning block corrupts strict JSON, so it's
    forced off whenever json_mode is on (the action's contract or a request override)."""
    from llm_runner.llm.presets_api import EnginePresetRow
    from llm_runner.llm.prompts import RunRequest, _effective_think

    def spec(json_mode):
        return FeaturePromptRow(key="f", feature="f", system="", user_template="",
                                built_in=True, json_mode=json_mode)

    def preset(think):
        return EnginePresetRow(name="p", think=think)

    def req(think=None, jsonMode=None):
        return RunRequest(action="f", think=think, jsonMode=jsonMode)

    assert _effective_think(spec(False), req(), preset(True)) is True          # think on, no json
    assert _effective_think(spec(True), req(), preset(True)) is False          # contract json_mode → off
    assert _effective_think(spec(False), req(jsonMode=True), preset(True)) is False   # request json → off
    assert _effective_think(spec(True), req(think=True), preset(False)) is False      # guardrail beats override
    assert _effective_think(spec(False), req(), preset(False)) is False        # think off → off


def test_run_uses_resolved_preset():
    """The one-source model: with a preset assigned to the action (its ref), /run
    dispatches the PRESET's model + params (temperature/top_p/reasoning/think), not the
    prompt's — proving params-from-preset-only. No ref / no default → the no-preset route."""
    from llm_runner.llm import stores
    from llm_runner.llm.presets_api import EnginePresetRow

    p = stores.get_engine_preset_store().save(EnginePresetRow(
        name="W", model="preset-model", temperature=0.2, topP=0.9, reasoningEffort="high", think=True,
    ))
    stores.get_feature_preset_ref_store().set("greet", p.id)

    get_llm_registry()._adapters = {}
    adapter = CaptureAdapter()
    get_llm_registry().register(adapter)
    app = FastAPI()
    app.include_router(make_feature_router(lambda: MemPromptStore(), lambda: LLMConfig()))
    c = TestClient(app, raise_server_exceptions=False)

    r = c.post("/v1/ai/run", json={"action": "greet", "variables": {"name": "x", "role": "y"}})
    assert r.status_code == 200
    assert r.json()["model"] == "preset-model"               # the preset's model overrode the route
    assert adapter.last["temperature"] == 0.2                # the preset's temperature
    assert adapter.last["extra"]["top_p"] == 0.9             # the preset's top_p flowed through
    assert adapter.last["extra"]["reasoning_effort"] == "high"
    assert adapter.last["think"] is True                     # reasoning on (no json) from the preset


def test_run_no_preset_omits_temperature_and_reasoning():
    """The no-preset rule (checker's live gate): an action with no ref AND no default
    dispatches on the provider-default route — temperature is NOT sent (None, so the
    adapter omits it — never a fabricated value), reasoning off, no tunables."""
    c, adapter = _feature_client(MemPromptStore())   # no preset ref, no default seeded
    r = c.post("/v1/ai/run", json={"action": "greet", "variables": {"name": "x", "role": "y"}})
    assert r.status_code == 200
    assert adapter.last["temperature"] is None       # omitted (no preset → provider default)
    assert adapter.last["think"] is False            # reasoning off
    assert adapter.last["extra"] is None             # no tunables sent


def test_run_body_temperature_override_still_wins():
    """A request temperature (writerAI 3-variation) is an ephemeral override even with
    no preset — it reaches the adapter."""
    c, adapter = _feature_client(MemPromptStore())
    c.post("/v1/ai/run", json={"action": "greet", "variables": {"name": "x", "role": "y"}, "temperature": 0.55})
    assert adapter.last["temperature"] == 0.55


def test_resolved_route_reports_the_preset():
    """B5-1 (§7.2): the read-only "runs on" chip's endpoint reports the SAME
    resolution a run uses — here the task preset's model, with the provider
    falling to the dispatch default exactly as /run's provider_override does
    when the preset names no provider."""
    from llm_runner.llm import stores
    from llm_runner.llm.presets_api import EnginePresetRow

    p = stores.get_engine_preset_store().save(EnginePresetRow(name="Writer preset", model="preset-model"))
    stores.get_feature_preset_ref_store().set("greet", p.id)
    get_llm_registry()._adapters = {}
    get_llm_registry().register(CaptureAdapter())
    app = FastAPI()
    app.include_router(make_feature_router(lambda: MemPromptStore(), lambda: LLMConfig()))
    c = TestClient(app, raise_server_exceptions=False)

    r = c.get("/v1/ai/resolved-route", params={"feature": "greet", "action": "greet"})
    assert r.status_code == 200
    body = r.json()
    assert body["configured"] is True
    assert body["model"] == "preset-model"
    assert body["providerId"] == "fake"
    assert body["presetId"] == p.id
    assert body["presetName"] == "Writer preset"
    assert body["presetSource"] == "assigned"
    assert "taskKind" not in body

    # Parity with the run path: /run dispatches the same model the chip shows.
    run = c.post("/v1/ai/run", json={"action": "greet", "variables": {"name": "x", "role": "y"}})
    assert run.status_code == 200
    assert run.json()["model"] == body["model"]


def test_resolved_route_without_preset_falls_to_dispatch():
    """No task_kind_of / no preset → the legacy dispatch resolution (pin →
    default), same as a run. presetId stays empty so the chip can say the
    route comes from the default, not a task preset."""
    c, adapter = _feature_client(MemPromptStore())
    r = c.get("/v1/ai/resolved-route", params={"feature": "greet"})
    assert r.status_code == 200
    body = r.json()
    assert body["configured"] is True
    assert body["providerId"] == adapter.provider_id
    assert body["model"] == adapter.default_model
    assert body["presetId"] == ""


def test_resolved_route_override_params_win():
    """The resolved-route override query params (providerId/model) mirror RunRequest —
    a Lab column asks for ITS pinned route, overriding the preset's. The reported route
    is that override (its reasoning budget would be read from it)."""
    c, adapter = _feature_client(MemPromptStore())
    r = c.get("/v1/ai/resolved-route", params={"feature": "greet", "model": "override-model"})
    assert r.status_code == 200
    body = r.json()
    assert body["model"] == "override-model"          # the override model, not the default
    assert body["providerId"] == adapter.provider_id
    assert body["value"] is None                      # no preset / think off → no budget resolved


def test_resolved_route_unconfigured_is_honest():
    """Nothing registered → configured False + the actionable detail, never a
    500 — the chip renders the factory state instead of erroring."""
    c, _adapter = _feature_client(MemPromptStore(), register=False)
    r = c.get("/v1/ai/resolved-route", params={"feature": "greet"})
    assert r.status_code == 200
    body = r.json()
    assert body["configured"] is False
    assert body["detail"]
    assert body["providerId"] == "" and body["model"] == ""


def _preset_sampler_app(samplers):
    """A /run app whose feature resolves to a preset carrying `samplers`."""
    from llm_runner.llm import stores
    from llm_runner.llm.presets_api import EnginePresetRow

    p = stores.get_engine_preset_store().save(EnginePresetRow(name="S", model="m", samplers=samplers))
    stores.get_feature_preset_ref_store().set("greet", p.id)
    get_llm_registry()._adapters = {}
    adapter = CaptureAdapter()
    get_llm_registry().register(adapter)
    app = FastAPI()
    app.include_router(make_feature_router(lambda: MemPromptStore(), lambda: LLMConfig()))
    return TestClient(app, raise_server_exceptions=False), adapter


def test_run_applies_preset_samplers_and_order():
    """The resolved preset's long-tail samplers reach the chat body (extra), and the
    reserved `samplers` ORDER value is split from a comma list into an array."""
    from llm_runner.llm.presets_api import PresetFlagRow

    c, adapter = _preset_sampler_app([
        PresetFlagRow(flagName="top_k", flagValue="40"),
        PresetFlagRow(flagName="min_p", flagValue="0.05"),
        PresetFlagRow(flagName="samplers", flagValue="dry,top_k,min_p,temperature"),
    ])
    r = c.post("/v1/ai/run", json={"action": "greet", "variables": {"name": "x", "role": "y"}})
    assert r.status_code == 200
    extra = adapter.last["extra"]
    assert extra["top_k"] == 40 and extra["min_p"] == 0.05          # preset samplers dispatched
    assert extra["samplers"] == ["dry", "top_k", "min_p", "temperature"]  # ORDER split to a list


def test_run_body_samplers_override_preset():
    """Per-call body.samplers win over the preset's samplers (precedence)."""
    from llm_runner.llm.presets_api import PresetFlagRow

    c, adapter = _preset_sampler_app([PresetFlagRow(flagName="top_k", flagValue="40")])
    r = c.post("/v1/ai/run", json={
        "action": "greet", "variables": {"name": "x", "role": "y"},
        "samplers": [{"flagName": "top_k", "flagValue": "5"}],
    })
    assert r.status_code == 200
    assert adapter.last["extra"]["top_k"] == 5                       # body overrode the preset's 40


# ── QC-43b: server-side ensure-local before a dispatch routed to the built-in runner ──
def test_run_ensures_local_model_when_route_is_local():
    """A /run that resolves to the built-in runner provider ensures the RESOLVED model
    is resident before dispatch — the stubbed hook is called with that model id."""
    ensured = []
    set_ensure_local_model(lambda mid: ensured.append(mid))
    c, adapter = _local_route_client("local-llamacpp")   # == LLMConfig().local_runner_provider_id
    r = c.post("/v1/ai/run", json={"action": "greet", "variables": {"name": "x", "role": "y"}})
    assert r.status_code == 200
    assert ensured == [adapter.default_model]            # ensured the model the route resolved to


def test_run_does_not_ensure_for_non_local_provider():
    """A cloud/remote route must NOT trigger the local ensure hook (only the built-in
    runner provider needs a lazy resident-load)."""
    ensured = []
    set_ensure_local_model(lambda mid: ensured.append(mid))
    c, _adapter = _local_route_client("cloud")           # != the local runner id
    r = c.post("/v1/ai/run", json={"action": "greet", "variables": {"name": "x", "role": "y"}})
    assert r.status_code == 200
    assert ensured == []                                 # skipped for a non-local provider


def test_run_ensure_failure_surfaces_as_http_error():
    """An ensure that raises (the model failed to load) surfaces through the run path's
    existing exception handling as an HTTP error — not a crash."""
    def boom(mid):
        raise RuntimeError(f'The local model "{mid}" failed to load: boom')

    set_ensure_local_model(boom)
    c, _adapter = _local_route_client("local-llamacpp")
    r = c.post("/v1/ai/run", json={"action": "greet", "variables": {"name": "x", "role": "y"}})
    assert r.status_code == 500                           # handled as an HTTP error, not a crash


def test_stream_ensure_failure_surfaces_as_error_frame():
    """An ensure failure on the STREAM path becomes the stream's own SSE error frame
    (there is no HTTP status to fail with once streaming) — never a 500."""
    def boom(mid):
        raise RuntimeError("model load timed out")

    set_ensure_local_model(boom)
    c, _adapter = _local_route_client("local-llamacpp")
    with c.stream("POST", "/v1/ai/stream", json={"action": "greet", "variables": {"name": "Sam"}}) as r:
        assert r.status_code == 200                       # the stream response itself is 200
        body = "".join(chunk for chunk in r.iter_text())
    assert '"error": "model load timed out"' in body     # ensure error → SSE error frame
    assert body.strip().endswith("data: [DONE]")
