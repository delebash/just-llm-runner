// SPDX-License-Identifier: MIT
// Port of tests/test_model_list_rules.py — part 1, the pure rule ENGINE (classify /
// anchored-regex drops / dated-collapse / invalid-regex resilience / show-all /
// hidden count) on realistic OpenAI- and Gemini-style fixtures; part 3, the STORE (one
// JSON doc in the runner-settings store) with seed / user-edit / reset / seed-refresh, and
// its CRUD router (model_list_rules_api): router_get_put_reset_round_trip; part 2, the
// endpoints (llm/api.js's router + setModelListRulesResolver).
import { describe, expect, test } from "vitest";
import { router, setModelListRulesResolver } from "../src/llm/api.js";
import { applyRules, pyRegex, SEED_VERSION, seedDoc } from "../src/llm/model_list_rules.js";
import { getLlmRegistry } from "../src/llm/registry.js";
import { makeModelListRulesRouter } from "../src/llm/model_list_rules_api.js";
import * as seed from "../src/llm/seed.js";
import * as stores from "../src/llm/stores.js";
import { pyJson } from "../src/platform/pyjson.js";
import { createServer } from "../src/platform/server.js";
import { freshDb } from "./helpers.js";

// ── realistic fixtures (representative ids, NOT a current-flagship allowlist) ──
// Every id exercises a PATTERN class, so the fixture proves the shipped seeds behave —
// with no dependence on any specific live model string.
const OPENAI_RAW = [
  // modern chat survivors — o-series (reasoning) KEPT; gpt-45 proves the anchored
  // `^gpt-4($|[.o-])` does NOT swallow a future flagship the way a bare "gpt-4" prefix would.
  "gpt-5",
  "gpt-5-mini",
  "gpt-45-turbo",
  "o3",
  "o3-mini",
  "o4-mini",
  // legacy chat (dropped)
  "gpt-4",
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4.1",
  "gpt-4-turbo",
  "gpt-3.5-turbo",
  "chatgpt-4o-latest",
  // non-chat families (dropped)
  "gpt-image-1",
  "gpt-realtime",
  "gpt-audio",
  "gpt-live-1",
  "sora-2",
  "dall-e-3",
  "tts-1",
  "tts-1-hd",
  "whisper-1",
  "omni-moderation-latest",
  "text-moderation-stable",
  "computer-use-preview",
  "davinci-002",
  "babbage-002",
  // preview / instant snapshots (dropped)
  "gpt-5-chat-preview",
  "some-model-instant",
  // embeddings (classified into the embed bucket)
  "text-embedding-3-small",
  "text-embedding-3-large",
];
const OPENAI_CHAT = new Set(["gpt-5", "gpt-5-mini", "gpt-45-turbo", "o3", "o3-mini", "o4-mini"]);
const OPENAI_EMBED = new Set(["text-embedding-3-small", "text-embedding-3-large"]);

const GEMINI_RAW = [
  "gemini-3.5-flash",
  "gemini-3.1-pro",
  "gemini-2.5-flash",
  "gemini-3.5-pro-preview", // KEPT — Gemini ships preview-first, no blanket -preview drop
  "gemini-1.0-pro",
  "gemini-1.5-flash",
  "gemini-2.0-flash", // legacy, dropped
  "imagen-3.0",
  "veo-3.1",
  "lyria-2",
  "aqa",
  "learnlm-2", // families, dropped
  "gemini-2.5-flash-tts",
  "gemini-live-2.5",
  "gemini-3-pro-image", // -tts/-live/-image
  "gemini-flash-exp", // -exp
  "gemini-embedding-001",
  "text-embedding-004", // embeddings
];
const GEMINI_CHAT = new Set(["gemini-3.5-flash", "gemini-3.1-pro", "gemini-2.5-flash", "gemini-3.5-pro-preview"]);
const GEMINI_EMBED = new Set(["gemini-embedding-001", "text-embedding-004"]);

const openaiRule = () => seedDoc().rules.openai;
const asSet = (xs) => new Set(xs);

// ══ 1. the pure rule engine ═══════════════════════════════════════════════════

test("classifies_embeddings_out_of_chat", () => {
  const res = applyRules(OPENAI_RAW, openaiRule());
  expect(asSet(res.embeddings)).toEqual(OPENAI_EMBED);
  expect(res.models.some((m) => OPENAI_EMBED.has(m))).toBe(false); // no embed leaks into chat
});

test("drops_legacy_and_non_chat_families_keeps_flagships", () => {
  const res = applyRules(OPENAI_RAW, openaiRule());
  expect(asSet(res.models)).toEqual(OPENAI_CHAT);
  for (const gone of ["gpt-4", "gpt-4o", "gpt-3.5-turbo", "dall-e-3", "tts-1", "whisper-1", "sora-2", "computer-use-preview", "davinci-002"]) {
    expect(res.models).not.toContain(gone);
  }
});

test("anchor_does_not_swallow_a_future_flagship", () => {
  // The whole reason for anchored regexes over bare prefixes: a prefix "gpt-4" would hide
  // "gpt-45"; the anchored `^gpt-4($|[.o-])` spares it while dropping gpt-4/4o.
  const res = applyRules(["gpt-4", "gpt-4o", "gpt-45-turbo", "gpt-5"], openaiRule());
  expect(res.models).toContain("gpt-45-turbo");
  expect(res.models).toContain("gpt-5");
  expect(res.models).not.toContain("gpt-4");
  expect(res.models).not.toContain("gpt-4o");
});

test("o_series_reasoning_models_kept", () => {
  const res = applyRules(["o1", "o3", "o3-mini", "o4-mini", "gpt-4o"], openaiRule());
  expect(asSet(res.models)).toEqual(new Set(["o1", "o3", "o3-mini", "o4-mini"]));
});

test("gemini_keeps_preview_first_models", () => {
  const res = applyRules(GEMINI_RAW, seedDoc().rules.gemini);
  expect(asSet(res.models)).toEqual(GEMINI_CHAT);
  expect(res.models).toContain("gemini-3.5-pro-preview"); // the no-preview-drop judgment call
  expect(asSet(res.embeddings)).toEqual(GEMINI_EMBED);
  for (const gone of ["imagen-3.0", "veo-3.1", "lyria-2", "aqa", "gemini-1.5-flash", "gemini-2.0-flash", "gemini-2.5-flash-tts", "gemini-3-pro-image"]) {
    expect(res.models).not.toContain(gone);
  }
});

test("collapse_dated_alias_present_prefers_alias", () => {
  const rule = { collapseDated: true, embedPatterns: [], dropPatterns: [] };
  const res = applyRules(["gpt-x", "gpt-x-2026-05-01", "gpt-x-2026-07-09"], rule);
  expect(res.models).toEqual(["gpt-x"]); // the bare alias was fetched → wins
  expect(res.hidden_count).toBe(2); // two snapshots folded away
});

test("collapse_dated_alias_absent_uses_newest_snapshot", () => {
  const rule = { collapseDated: true, embedPatterns: [], dropPatterns: [] };
  const res = applyRules(["gpt-y-2026-05-01", "gpt-y-2026-07-09"], rule);
  expect(res.models).toEqual(["gpt-y-2026-07-09"]); // newest snapshot, never the invented alias
});

test("collapse_dated_never_invents_an_unfetched_id", () => {
  const rule = { collapseDated: true, embedPatterns: [], dropPatterns: [] };
  const res = applyRules(["only-2026-01-01"], rule);
  expect(res.models).toEqual(["only-2026-01-01"]); // the fetched id verbatim, not "only"
});

test("invalid_regex_is_skipped_not_raised", () => {
  // A user-typed broken pattern must degrade to under-filter, never 500.
  const rule = { collapseDated: false, embedPatterns: ["("], dropPatterns: ["[", "^dropme$"] };
  const res = applyRules(["keepme", "dropme"], rule);
  expect(res.models).toEqual(["keepme"]); // the valid drop applied, the invalid ones skipped
  expect(res.embeddings).toEqual([]);
});

test("classification_wins_over_drop", () => {
  // An id matching BOTH an embed and a drop pattern lands in the embed bucket (shown),
  // never dropped.
  const rule = { collapseDated: false, embedPatterns: ["embed"], dropPatterns: ["^text-"] };
  const res = applyRules(["text-embedding-3", "text-davinci"], rule);
  expect(res.embeddings).toEqual(["text-embedding-3"]);
  expect(res.models).toEqual([]); // text-davinci dropped
  expect(res.models).not.toContain("text-embedding-3");
});

test("show_all_bypasses_every_rule", () => {
  const res = applyRules(OPENAI_RAW, openaiRule(), { showAll: true });
  expect(res.models).toEqual(OPENAI_RAW);
  expect(res.embeddings).toEqual([]);
  expect(res.hidden_count).toBe(0);
});

test("none_rule_is_passthrough", () => {
  const res = applyRules(["a", "b"], null);
  expect(res.models).toEqual(["a", "b"]);
  expect(res.embeddings).toEqual([]);
  expect(res.hidden_count).toBe(0);
});

test("hidden_count_accounts_for_every_removed_id", () => {
  const res = applyRules(OPENAI_RAW, openaiRule());
  expect(res.hidden_count).toBe(OPENAI_RAW.length - res.models.length - res.embeddings.length);
  expect(res.hidden_count).toBeGreaterThan(0);
});

// ══ 2. the endpoints (shipped seeds applied to the fixtures) ═══════════════════

class StubAdapter {
  constructor(providerId, providerType, models) {
    this.provider_id = providerId;
    this.provider_type = providerType;
    this.default_model = "";
    this._models = models;
  }
  async models() {
    return [...this._models];
  }
  async ping() {
    return true;
  }
}

function client() {
  const app = createServer({ typeBase: "https://example.test/errors/" });
  app.register(router);
  return app;
}

function withSeedsAndAdapter(adapter) {
  const reg = getLlmRegistry();
  reg._adapters = new Map();
  reg.register(adapter);
  setModelListRulesResolver(() => seedDoc().rules);
}

function teardown() {
  setModelListRulesResolver(null);
  getLlmRegistry()._adapters = new Map();
}

test("saved_endpoint_applies_openai_rules", async () => {
  withSeedsAndAdapter(new StubAdapter("oai", "openai", OPENAI_RAW));
  try {
    const body = (await client().inject({ method: "GET", url: "/v1/llm-providers/oai/models" })).json();
    expect(asSet(body.models)).toEqual(OPENAI_CHAT);
    expect(asSet(body.embeddings)).toEqual(OPENAI_EMBED);
    expect(body.hiddenCount).toBe(OPENAI_RAW.length - OPENAI_CHAT.size - OPENAI_EMBED.size);
  } finally {
    teardown();
  }
});

test("saved_endpoint_all_query_bypasses", async () => {
  withSeedsAndAdapter(new StubAdapter("oai", "openai", OPENAI_RAW));
  try {
    const body = (await client().inject({ method: "GET", url: "/v1/llm-providers/oai/models?all=1" })).json();
    expect(body.models).toEqual(OPENAI_RAW);
    expect(body.embeddings).toEqual([]);
    expect(body.hiddenCount).toBe(0);
  } finally {
    teardown();
  }
});

test("saved_endpoint_gemini_rules", async () => {
  withSeedsAndAdapter(new StubAdapter("gem", "gemini", GEMINI_RAW));
  try {
    const body = (await client().inject({ method: "GET", url: "/v1/llm-providers/gem/models" })).json();
    expect(asSet(body.models)).toEqual(GEMINI_CHAT);
    expect(asSet(body.embeddings)).toEqual(GEMINI_EMBED);
  } finally {
    teardown();
  }
});

test("unknown_type_passes_through", async () => {
  // A provider TYPE with no rules row is under-filter-safe: the raw list is returned.
  withSeedsAndAdapter(new StubAdapter("who", "some-new-vendor", ["a", "b", "c"]));
  try {
    const body = (await client().inject({ method: "GET", url: "/v1/llm-providers/who/models" })).json();
    expect(body.models).toEqual(["a", "b", "c"]);
    expect(body.hiddenCount).toBe(0);
  } finally {
    teardown();
  }
});

test("probe_endpoint_applies_rules", async () => {
  // The draft probe builds a temporary adapter; a dead base URL yields [] from the
  // openai-compat adapter, so assert the SHAPE + the rule application.
  setModelListRulesResolver(() => seedDoc().rules);
  try {
    const r = await client().inject({
      method: "POST",
      url: "/v1/llm-providers/probe-models",
      payload: { providerType: "openai-compat", baseUrl: "http://127.0.0.1:9/v1" },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.models).toEqual([]);
    expect(body.embeddings).toEqual([]);
    expect(body.hiddenCount).toBe(0);
  } finally {
    setModelListRulesResolver(null);
  }
});

// ══ 3. the store: one JSON doc in the runner-settings store ═══════════════════

/** A fresh in-memory database as the shared storage (Python's StaticPool engine). */
const freshStore = () => freshDb({ foreignKeys: false });

test("seed_creates_the_doc", () => {
  const h = freshStore();
  expect(h.tx(() => seed.seedModelListRules(h))).toBe(1);
  const doc = stores.getModelListRules();
  expect(doc).toEqual(seedDoc());
  expect(doc.seedVersion).toBe(SEED_VERSION);
  expect("openai" in doc.rules && "gemini" in doc.rules).toBe(true);
});

test("get_defaults_to_seed_when_unseeded", () => {
  freshStore();
  // No row at all → the store still returns a well-formed doc (the resolver never breaks).
  expect(stores.getModelListRules()).toEqual(seedDoc());
});

test("put_persists_and_marks_user_modified", () => {
  const h = freshStore();
  h.tx(() => seed.seedModelListRules(h));
  const custom = {
    seedVersion: SEED_VERSION,
    rules: { openai: { embedPatterns: ["^my-embed"], dropPatterns: [], collapseDated: false } },
  };
  stores.setModelListRules(custom);
  expect(stores.getModelListRules()).toEqual(custom);
  expect(h.get("runner_setting", "model_list_rules").built_in).toBe(false);
});

test("reseed_never_clobbers_a_user_edit", () => {
  const h = freshStore();
  h.tx(() => seed.seedModelListRules(h));
  stores.setModelListRules({
    seedVersion: SEED_VERSION,
    rules: { x: { embedPatterns: [], dropPatterns: ["^drop-me"], collapseDated: false } },
  });
  h.tx(() => seed.seedModelListRules(h)); // a boot reseed
  expect(stores.getModelListRules().rules).toEqual({ x: { embedPatterns: [], dropPatterns: ["^drop-me"], collapseDated: false } });
});

test("seed_refresh_updates_an_unmodified_stale_doc", () => {
  const h = freshStore();
  // A prior seed version, still built_in (the user never PUT it) → a reseed refreshes it.
  h.insert("runner_setting", {
    key: "model_list_rules",
    value: pyJson({ seedVersion: 0, rules: {} }, { sortKeys: true }),
    built_in: true,
  });
  h.tx(() => seed.seedModelListRules(h));
  expect(stores.getModelListRules()).toEqual(seedDoc());
});

test("reset_snaps_back_to_seed_and_rearms_refresh", () => {
  const h = freshStore();
  stores.setModelListRules({
    seedVersion: 99,
    rules: { custom: { embedPatterns: [], dropPatterns: [], collapseDated: true } },
  });
  stores.resetModelListRules();
  expect(stores.getModelListRules()).toEqual(seedDoc());
  expect(h.get("runner_setting", "model_list_rules").built_in).toBe(true);
});

test("router_get_put_reset_round_trip", async () => {
  const h = freshStore();
  h.tx(() => seed.seedModelListRules(h));
  const app = createServer({ typeBase: "https://example.test/errors/" });
  app.register(makeModelListRulesRouter(stores.getModelListRules, stores.setModelListRules, stores.resetModelListRules));

  const got = (await app.inject({ method: "GET", url: "/v1/ai/model-list-rules" })).json();
  expect(got.seedVersion).toBe(SEED_VERSION);
  expect("openai" in got.rules).toBe(true);

  const edited = {
    seedVersion: SEED_VERSION,
    rules: { openai: { embedPatterns: ["^custom-embed"], dropPatterns: ["^drop"], collapseDated: true } },
  };
  const put = (await app.inject({ method: "PUT", url: "/v1/ai/model-list-rules", payload: edited })).json();
  expect(put.rules.openai.embedPatterns).toEqual(["^custom-embed"]);
  expect(stores.getModelListRules().rules.openai.dropPatterns).toEqual(["^drop"]);

  const reset = (await app.inject({ method: "POST", url: "/v1/ai/model-list-rules/reset" })).json();
  expect(reset).toEqual(JSON.parse(JSON.stringify(seedDoc()))); // back to the shipped seed
});

// Not in the Python file: the stored patterns are PYTHON regexes — pyRegex reads them
// as Python's `re` does (each expectation below is what `re.search` answers).
describe("pyRegex reads a pattern as Python's re", () => {
  const search = (p, s) => pyRegex(p).test(s);
  test("Unicode \\d \\w \\b, $ before a final newline, . and \\n", () => {
    expect(search("-\\d{4}$", "x-١٢٣٤")).toBe(true); // Arabic-Indic digits are \d
    expect(search("^\\w+$", "café")).toBe(true);
    expect(search("\\bgpt\\b", "é gpt é")).toBe(true);
    expect(search("\\bgpt", "égpt")).toBe(false); // é is a word char in Python
    expect(search("abc$", "abc\n")).toBe(true); // Python's $ matches before a final \n
    expect(search("a.c", "a\rc")).toBe(true); // Python's . only refuses \n
    expect(search("a.c", "a\nc")).toBe(false);
    expect(search("(?s)a.c", "a\nc")).toBe(true);
    expect(search("(?i)^GPT", "gpt-5")).toBe(true);
  });
  test("Python-only syntax and the braces Python reads as literals", () => {
    expect(search("(?P<fam>gpt)-(?P=fam)", "gpt-gpt")).toBe(true);
    expect(search("a{,2}b$", "aab")).toBe(true); // {,n} = {0,n}
    expect(search("x{}", "x{}")).toBe(true); // not a quantifier → literal
    expect(search("x{y", "x{y")).toBe(true);
    expect(search("\\-preview", "a-preview")).toBe(true); // Python accepts \- outside a class
    expect(search("a(?#note)b", "ab")).toBe(true);
  });
  test("what Python rejects stays rejected", () => {
    for (const bad of ["(", "[", "\\q", "a**", "\\"]) expect(() => pyRegex(bad)).toThrow(SyntaxError);
  });
});
