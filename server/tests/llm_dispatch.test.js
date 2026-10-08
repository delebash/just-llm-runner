// SPDX-License-Identifier: MIT
// Port of tests/test_llm_dispatch.py — dispatch precedence + the honest thinking law for
// the shared LLM layer.
//
// No network: a FakeAdapter stands in for a provider. Verifies the production-config →
// prefer-local → first chain (presets carry provider+model), and that thinking is sent
// EXACTLY as configured (no veto, no tier-derived fallback).
//
// think_is_sent_even_to_a_known_nonthinker resolves a cloud reasoning level, which reads
// the reasoning map from the shared database. In Python it passes only when an EARLIER
// test file left storage configured (run alone it fails: "LLM storage not configured");
// here it gets that state explicitly — a fresh, empty database (the map falls back to the
// type's seed rows).
import { expect, test } from "vitest";
import { LLMMessage, LLMResponse, StreamDelta } from "../src/llm/base.js";
import { chat, LLMNotConfiguredError, resolveFeature, streamChat } from "../src/llm/dispatch.js";
import { OpenAICompatAdapter } from "../src/llm/openai_compat.js";
import { OpenAISDKAdapter } from "../src/llm/openai_sdk.js";
import { construct, LLMRegistry } from "../src/llm/registry.js";
import { LLMConfig, LLMProviderConfig, ProductionConfig } from "../src/llm/schema.js";
import { getLedger } from "../src/llm/usage.js";
import { model } from "../src/platform/models.js";
import { RuntimeError, ValueError } from "../src/platform/py.js";
import { freshDb } from "./helpers.js";

/** Satisfies the adapter contract without touching the network. */
class FakeAdapter {
  constructor(providerId, defaultModel = "m-default", failWith = null) {
    this.provider_id = providerId;
    this.provider_type = "openai-compat";
    this.default_model = defaultModel;
    this.failWith = failWith;
    this.calls = [];
  }

  async chat(messages, { model = null, think = false, extra = null } = {}) {
    this.calls.push({ model, think, extra });
    if (this.failWith) throw new ValueError(this.failWith);
    return LLMResponse({ text: "ok", model: model || this.default_model, prompt_tokens: 3, completion_tokens: 5 });
  }

  async *streamChat(messages, { model = null, think = false, extra = null } = {}) {
    this.calls.push({ model, think, extra, stream: true });
    if (this.failWith) throw new ValueError(this.failWith);
    yield StreamDelta({ text: "ok-" });
    yield StreamDelta({ text: "stream" });
    yield StreamDelta({ done: true, prompt_tokens: 7, completion_tokens: 11 });
  }

  async models() {
    return [this.default_model];
  }

  async ping() {
    return true;
  }
}

function makeReg(...adapters) {
  const reg = new LLMRegistry();
  for (const a of adapters) reg.register(a);
  return reg;
}

const prod = (v) => model(ProductionConfig, v);
const collect = async (it) => {
  const out = [];
  for await (const x of it) out.push(x);
  return out;
};

// ── Precedence chain ─────────────────────────────────────────────────

test("production_config_wins", () => {
  // The active production config beats every generic fallback — here prefer-local would
  // otherwise route critique to the local runner.
  const reg = makeReg(new FakeAdapter("cloud"), new FakeAdapter("local-llamacpp"));
  const cfg = LLMConfig({
    production_configs: [prod({ feature: "critique", name: "strict", providerId: "cloud", model: "claude-sonnet-4-6" })],
    prefer_local_features: new Set(["critique"]),
  });
  const [adapter, mdl] = resolveFeature(cfg, "critique", reg);
  expect(adapter.provider_id).toBe("cloud");
  expect(mdl).toBe("claude-sonnet-4-6");
});

test("prefer_local_runner", () => {
  const reg = makeReg(new FakeAdapter("other"), new FakeAdapter("local-llamacpp", "qwen3-4b"));
  const cfg = LLMConfig({ prefer_local_features: new Set(["speaker_attribution"]) });
  const [adapter, mdl] = resolveFeature(cfg, "speaker_attribution", reg);
  expect(adapter.provider_id).toBe("local-llamacpp");
  expect(mdl).toBe("qwen3-4b");
});

test("first_adapter_fallback", () => {
  const reg = makeReg(new FakeAdapter("only", "m"));
  const [adapter] = resolveFeature(LLMConfig(), "anything", reg);
  expect(adapter.provider_id).toBe("only");
});

test("no_provider_raises", () => {
  expect(() => resolveFeature(LLMConfig(), "x", new LLMRegistry())).toThrow(LLMNotConfiguredError);
});

// ── Action-level override (per-action routing, falls back to the feature) ──

test("action_config_beats_feature_config", () => {
  const reg = makeReg(new FakeAdapter("feat", "feat-model"), new FakeAdapter("act", "act-model"));
  const cfg = LLMConfig({
    production_configs: [
      prod({ feature: "writerAI", name: "f", providerId: "feat", model: "feat-model" }),
      prod({ feature: "writerAI.tighten", name: "a", providerId: "act", model: "act-model" }),
    ],
  });
  const [adapter, mdl] = resolveFeature(cfg, "writerAI", reg, { action: "writerAI.tighten" });
  expect(adapter.provider_id).toBe("act");
  expect(mdl).toBe("act-model");
});

test("action_without_config_falls_back_to_feature", () => {
  const reg = makeReg(new FakeAdapter("feat", "feat-model"));
  const cfg = LLMConfig({ production_configs: [prod({ feature: "writerAI", name: "f", providerId: "feat", model: "feat-model" })] });
  // the action has nothing of its own → inherits the feature default
  const [adapter, mdl] = resolveFeature(cfg, "writerAI", reg, { action: "writerAI.rewrite" });
  expect(adapter.provider_id).toBe("feat");
  expect(mdl).toBe("feat-model");
});

test("action_none_is_legacy_feature_resolution", () => {
  // action null (every legacy caller) is unchanged, and action === feature is a harmless
  // no-op that falls through to the feature.
  const reg = makeReg(new FakeAdapter("feat", "feat-model"));
  const cfg = LLMConfig({ production_configs: [prod({ feature: "writerAI", name: "f", providerId: "feat" })] });
  const legacy = resolveFeature(cfg, "writerAI", reg);
  const same = resolveFeature(cfg, "writerAI", reg, { action: "writerAI" });
  expect(legacy[0].provider_id).toBe("feat");
  expect(same[0].provider_id).toBe("feat");
});

// ── chat() think omitted = OFF (the one-control law) + records usage ──

test("chat_think_omitted_is_off_and_records_usage", async () => {
  getLedger().clear();
  const fake = new FakeAdapter("local", "def");
  const reg = makeReg(fake);
  const cfg = LLMConfig({ production_configs: [prod({ feature: "x", name: "t", providerId: "local", model: "qwen3:14b" })] });
  const resp = await chat({ config: cfg, feature: "x", messages: [LLMMessage("user", "hi")], registry: reg });
  expect(resp.text).toBe("ok");
  // No explicit think = OFF — the preset is the one thinking control.
  expect(fake.calls[0].think).toBe(false);
  const snap = getLedger().snapshot();
  expect(snap.total_calls).toBe(1);
  expect(snap.by_feature.x.calls).toBe(1);
});

test("stream_chat_yields_deltas_and_records_usage", async () => {
  getLedger().clear();
  const fake = new FakeAdapter("local", "def");
  const reg = makeReg(fake);
  const cfg = LLMConfig({ production_configs: [prod({ feature: "x", name: "t", providerId: "local", model: "qwen3:14b" })] });
  const deltas = await collect(streamChat({ config: cfg, feature: "x", messages: [LLMMessage("user", "hi")], registry: reg }));
  expect(
    deltas
      .filter((d) => !d.done)
      .map((d) => d.text)
      .join(""),
  ).toBe("ok-stream");
  expect(fake.calls[0].think).toBe(false); // same law on the stream path
  const done = deltas.filter((d) => d.done);
  expect(done.length).toBeGreaterThan(0);
  expect(done[0].prompt_tokens).toBe(7);
  expect(done[0].completion_tokens).toBe(11);
  const snap = getLedger().snapshot();
  expect(snap.by_feature.x.calls).toBe(1);
  expect(snap.by_feature.x.prompt_tokens).toBe(7);
  expect(snap.by_feature.x.completion_tokens).toBe(11);
});

// ── Thinking is sent EXACTLY as configured — no veto (the gate removal 2026-08-06) ──

const prodCfg = (mdl) => LLMConfig({ production_configs: [prod({ feature: "f", name: "t", providerId: "cloud", model: mdl })] });

test("think_is_sent_even_to_a_known_nonthinker", async () => {
  freshDb(); // the state Python's suite leaves behind (see the header)
  const a = new FakeAdapter("cloud");
  const resp = await chat({
    config: prodCfg("gpt-4o"),
    feature: "f",
    registry: makeReg(a),
    messages: [LLMMessage("user", "hi")],
    think: true,
    extra: { reasoning_effort: "high" },
  });
  expect(resp.text).toBe("ok");
  const call = a.calls.at(-1);
  expect(call.think).toBe(true);
  // The reasoning ask rides the wire (resolved to the provider's dialect).
  expect((call.extra || {}).reasoning_effort).toBeTruthy();
});

test("think_off_stays_off", async () => {
  const a = new FakeAdapter("cloud");
  await chat({ config: prodCfg("gpt-4o"), feature: "f", registry: makeReg(a), messages: [LLMMessage("user", "hi")], think: false });
  expect(a.calls.at(-1).think).toBe(false);
});

test("stream_path_sends_as_configured", async () => {
  const a = new FakeAdapter("cloud");
  await collect(streamChat({ config: prodCfg("gpt-4o"), feature: "f", registry: makeReg(a), messages: [LLMMessage("user", "hi")], think: true }));
  expect(a.calls.at(-1).think).toBe(true);
});

test("reasoning_rejection_carries_the_fix_pointer", async () => {
  const a = new FakeAdapter("cloud", "m-default", "Unsupported parameter: 'reasoning_effort' is not supported with this model.");
  const p = chat({ config: prodCfg("gpt-4o"), feature: "f", registry: makeReg(a), messages: [LLMMessage("user", "hi")], think: true });
  await expect(p).rejects.toBeInstanceOf(RuntimeError);
  const msg = await p.catch((e) => e.message);
  expect(msg).toContain("reasoning_effort"); // the provider's own words
  expect(msg).toContain("turn thinking off on this feature's preset"); // the one fix line
});

test("unrelated_errors_pass_through_untouched", async () => {
  // Auth/timeout/quota errors never get the thinking hint — the hint rides only when the
  // provider's message is about the parameter we sent.
  const a = new FakeAdapter("cloud", "m-default", "401 Unauthorized: bad api key");
  const p = chat({ config: prodCfg("gpt-4o"), feature: "f", registry: makeReg(a), messages: [LLMMessage("user", "hi")], think: true });
  await expect(p).rejects.toBeInstanceOf(ValueError);
  expect(await p.catch((e) => e.message)).not.toContain("turn thinking off");
});

test("think_off_errors_never_get_the_hint", async () => {
  const a = new FakeAdapter("cloud", "m-default", "model produced no reasoning output");
  const p = chat({ config: prodCfg("gpt-4o"), feature: "f", registry: makeReg(a), messages: [LLMMessage("user", "hi")], think: false });
  await expect(p).rejects.toBeInstanceOf(ValueError);
  expect(await p.catch((e) => e.message)).not.toContain("turn thinking off");
});

// ── the registry: the openai SDK adapter serves all five cloud types ──

test("registry_constructs_openai_sdk_for_all_five_types", () => {
  for (const pt of ["openai", "deepseek", "openrouter", "xai", "mistral"]) {
    const a = construct(model(LLMProviderConfig, { id: pt, name: pt, providerType: pt }));
    expect(a).toBeInstanceOf(OpenAISDKAdapter);
    expect(a.provider_type).toBe(pt);
  }
});

test("registry_compat_openai_without_base_url_raises", () => {
  // compat has no "openai" defaults entry, so a bare "openai" compat resolves no base URL —
  // its construction throws (openai rides openai_sdk instead).
  expect(() => new OpenAICompatAdapter("p", "openai", { apiKey: "x" })).toThrow(ValueError);
});
