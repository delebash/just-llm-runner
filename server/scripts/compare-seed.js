// SPDX-License-Identifier: MIT
// Seed parity check: the Python kit and this package seed, reseed and edit two fresh
// databases the same way, and every table's DDL and every cell (rowid order, SQLite's
// quote() — type and bytes) must match. Three phases, each compared:
//   1. a fresh seed, with JustWrite's real registered app seed (catalog with physics
//      facts, presets, prompts, class tunes + identity, embed templates, test samples) and
//      a per-machine tune seed;
//   2. edits that trigger every fill-empty / heal / sync / prune path, then a reseed;
//   3. a replay of store writes (every store's write methods, the resets).
//
//   node scripts/node24.js scripts/compare-seed.js        (KIT_PYTHON overrides the Python)
//
// The Python side is scripts/compare-seed.py (needs ../justwrite-app/.venv, or KIT_PYTHON).
// Until wave 2 lands llm/identity.js and llm/switch_resolve.js, a resolve hook stands in
// for those two files only while they are missing.

import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT = resolve(HERE, "..", "..");
const PY =
  process.env.KIT_PYTHON ||
  join(KIT, "..", "justwrite-app", ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");

// Stand-ins for wave-2 files, used only when the real file can't be found.
const STUBS = {
  "identity.js": "export function computedRowNumbers() { return [null, null, null]; }",
  "switch_resolve.js": `export const activeBackend = () => "";
export function tuneRowApplies(rowBackend, active = null) {
  const act = active ?? ""; if (!act) return true; return ((rowBackend || "").trim() || "cuda") === act; }`,
};
const HOOKS = `const STUBS = ${JSON.stringify(STUBS)};
export async function resolve(specifier, context, next) {
  try { return await next(specifier, context); } catch (e) {
    const base = specifier.split("/").pop();
    if (e?.code === "ERR_MODULE_NOT_FOUND" && Object.hasOwn(STUBS, base))
      return { url: "data:text/javascript," + encodeURIComponent(STUBS[base]), shortCircuit: true };
    throw e;
  }
}`;
register(`data:text/javascript,${encodeURIComponent(HOOKS)}`);

const procs = await import("../src/platform/procs.js");
const { openDatabase } = await import("../src/platform/sql.js");
const { pyFloatValue } = await import("../src/platform/pyjson.js");
const db = await import("../src/llm/db.js");
const seed = await import("../src/llm/seed.js");
const stores = await import("../src/llm/stores.js");

async function python(...args) {
  const r = await procs.run([PY, join(HERE, "compare-seed.py"), ...args], {
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  if (r.returncode !== 0 && !args[0].startsWith("compare")) throw new Error(`compare-seed.py ${args[0]} failed:\n${r.stderr}`);
  return r;
}

const dir = mkdtempSync(join(tmpdir(), "compare-seed-"));
await python("dump", join(dir, "app.json"));
const { app, refs } = JSON.parse(readFileSync(join(dir, "app.json"), "utf8"), (_k, v) =>
  v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && "$float" in v ? pyFloatValue(v.$float) : v,
);

const q = (s) => `'${String(s).replaceAll("'", "''")}'`;
const healKey = Object.keys(app.feature_prompt_heals || {}).find((k) => app.feature_prompt_heals[k].length);
const renamed = app.engine_presets.find((p) => p.name_was);
const mutations = [
  "update model_catalog set size_bytes = null, est_vram_mb = null, size_label = '' where rowid % 2 = 0",
  "update model_catalog set block_count = 0, layers_nonexp_bytes = 0 where rowid % 3 = 0",
  "update model_catalog set mtp_draft_file = '', mtp_draft_repo = '', mtp = 0 where rowid % 4 = 1",
  "update hardware_classes set vram_bw_gbps = 0, ram_bw_gbps = 0 where class_key like 'dgpu-vram12%'",
  "update llm_providers set name = 'Built-in server — llama.cpp' where id = 'local-llamacpp'",
  "update knob_catalog set help = 'stale', position = 99, fit_relevant = 0 where flag_name = 'ctx_len'",
  "delete from knob_option where flag_name = 'spec_type' and value = 'ngram-mod'",
  "delete from knob_catalog where flag_name in ('seed', 'min_keep')", // re-inserted: the seeder's flush points
  "insert into knob_catalog (flag_name, kind, default_value, help, plane, applies_to, tier, per_request, backends, fit_relevant, position, built_in) values ('context_shift', 'bool', '', 'old', 1, 'all', 'advanced', 0, '', 0, 50, 1)",
  "insert into knob_option (flag_name, value, label, position, built_in) values ('spec_type', 'bogus', 'bogus', 9, 1)",
  "insert into knob_option (flag_name, value, label, position, built_in) values ('spec_type', 'mine', 'mine', 10, 0)",
  `update runner_setting set value = '{"seedVersion": 0}' where key = 'model_list_rules'`,
  "delete from runner_setting where key in ('band_fast_toks', 'warm_default_on_startup')",
  "update runner_setting set value = '' where key = 'default_preset_id'",
  "insert into runner_binary (platform, gpu, source, server_exe, built_in, position) values ('windows', 'cpu', 'github', 'llama-server.exe', 1, 9)",
  "delete from runner_binary where platform = 'macos'",
  "update feature_prompts set label = '', description = '' where rowid % 2 = 0",
  "delete from reasoning_map where provider_id = 'openai' and level = 'max'",
  "delete from class_tunes where rowid in (select min(rowid) from class_tunes)",
  "delete from class_tunes where model_id = (select model_id from class_tunes order by rowid desc limit 1)",
  "delete from engine_preset_samplers where preset_id = (select id from engine_presets order by rowid desc limit 1)",
  "delete from engine_presets where id = (select id from engine_presets order by rowid desc limit 1)",
  "delete from feature_preset_refs where rowid % 3 = 0",
  "delete from model_embed_templates where rowid = 1",
  "delete from test_samples where rowid = 1",
  "delete from model_samplers where rowid % 2 = 0",
  "delete from model_tunes where rowid = 1",
  "insert into class_tunes (model_id, class_key, flag_name, flag_value, built_in) values ('orphan-model', 'dgpu-vram8|ram32', 'ctx_len', '4096', 1)",
  "insert into class_tunes (model_id, class_key, flag_name, flag_value, built_in) values ('orphan-model', 'dgpu-vram8|ram32', 'mine', '1', 0)",
  ...(healKey ? [`update feature_prompts set system = ${q(app.feature_prompt_heals[healKey][0])} where key = ${q(healKey)}`] : []),
  ...(renamed ? [`update engine_presets set name = ${q(renamed.name_was)} where id = ${q(renamed.id)}`] : []),
];

const load = (at, rows, label = "l") => [
  "measure.record",
  "m1",
  { machineKey: "hw1", source: "load", label, tokensPerSec: 0, vramTotalMb: 0, at, rows, vramModelMb: 5000 + at, kind: "llm", realtimeX: 0, backend: "cuda" },
];
const fpA = [
  { flagName: "ctx_len", flagValue: "4096" },
  { flagName: "threads", flagValue: "8" },
];
const fpB = [{ flagName: "ctx_len", flagValue: "8192" }];
const ops = [
  ["provider.add", { id: "tmp-a", name: "Tmp", providerType: "anthropic", baseUrl: "https://api.anthropic.com", local: false }],
  ["provider.replace", "tmp-a", { id: "tmp-a", name: "Tmp 2", providerType: "gemini", baseUrl: "https://g.example", apiKey: "k-1", timeoutSeconds: 30, local: false }],
  ["provider.replace", "missing", { id: "missing", providerType: "openai" }],
  ["provider.remove", "lmstudio"],
  ["routing.set", { default: { llmId: "openai", model: "gpt-5", embeddingId: "local-llamacpp", embeddingModel: "e" } }],
  ["prompt.upsert", { key: "x.new", feature: "x", system: "S ü", user_template: "U", built_in: false, json_mode: true, json_schema: "{}", label: "L", description: "D", group: "G" }],
  ["prompt.upsert", { key: refs.prompt, feature: "f2", system: "S2", user_template: "U2", built_in: true }],
  ["catalog.upsert", { id: "user-m", name: "User M", hfRepo: "a/b-GGUF", quant: "Q4_K_M", qualityRank: 5, sizeBytes: 123456789, trainedCtx: 8192, license: "MIT" }],
  ["catalog.setType", "user-m", "moe"],
  ["catalog.setType", "user-m", "moe"],
  ["catalog.setDerived", "user-m", { modelType: "moe", mtpBuiltin: true, trainedCtx: 32768, totalParams: "7B", samplers: { temperature: "0.8", top_k: "40", " ": "x" }, architecture: "qwen3", experts: 8, sizeLabel: "8x1B", sizeBytes: 999, estVramMb: 5000, physicsFacts: { block_count: 32, n_kv_heads: 8, expert_byte_share: 0.5 } }],
  ["catalog.setDerived", refs.catalog[1], { modelType: "dense", mtpBuiltin: false, trainedCtx: null }],
  ["catalog.delete", refs.catalog[2]],
  ["catalog.reset"],
  ["switchPreset.upsert", { id: "dense", label: "Dense", appliesTo: "dense", position: 3, switches: [{ flagName: "no_mmap", flagValue: "false" }, { flagName: " ", flagValue: "x" }] }],
  ["switchPreset.upsert", { id: "base", label: "Base 2", appliesTo: "", position: 0, switches: [{ flagName: "flash_attn", flagValue: "off" }] }],
  ["switchPreset.delete", "moe"],
  ["switchPreset.reset"],
  ["enginePreset.save", { id: "p-user", name: "Mine", providerId: "openai", model: "gpt-5", temperature: 0.3, topP: 0.9, maxTokens: 100, reasoningEffort: "low", think: true, samplers: [{ flagName: "min_p", flagValue: "0.05" }, { flagName: "", flagValue: "x" }] }],
  ["enginePreset.save", { id: refs.presets[1], name: "Edited", providerId: "local-llamacpp", model: "m" }],
  ["enginePreset.delete", refs.presets[2]],
  ["ref.set", refs.actions[0], "p-user"],
  ["ref.set", refs.actions[1], ""],
  ["ref.set", "brand.new", "p-user"],
  ["pricing.upsert", { modelId: " My-Model ", inputPerM: 1.5, outputPerM: 2 }],
  ["pricing.upsert", { modelId: "gpt-5", inputPerM: 9, outputPerM: 0 }],
  ["pricing.delete", "GPT-5-MINI"],
  ["reasoning.upsert", "openai", { level: "max", word: "x", tokens: 5 }],
  ["reasoning.upsert", "new-prov", { level: "low" }],
  ["embed.upsert", { modelId: " m-e ", documentTemplate: "d {text}", queryTemplate: "q" }],
  ["embed.upsert", { modelId: refs.embed[0], documentTemplate: "", queryTemplate: "Q: {text}" }],
  ["embed.delete", refs.embed[1] ?? "none"],
  ["runner.upsertBinary", { platform: "linux", gpu: "custom", assetUrl: "https://u", serverExe: " llama-server " }],
  ["runner.upsertBinary", { platform: "windows", gpu: "cuda12", source: "", assetUrl: "", runtimeUrl: "https://r", serverExe: "" }],
  ["runner.setSetting", "models_max", "4"],
  ["runner.setCacheRoot", "  C:/x  "],
  ["runner.reset"],
  ["modelTune.replace", "m1", "hw1", [{ flagName: "ctx_len", flagValue: "8192" }, { flagName: "ctx_len", flagValue: "dup" }, { flagName: " flash_attn ", flagValue: "" }], { flash_attn: "on", " ": "x", n: "" }],
  ["modelTune.replace", "m2", "hw1", [{ flagName: "a", flagValue: "1" }], null],
  ["modelTune.delete", "m2", "hw1"],
  ["classTune.replace", "m1", "dgpu-vram8|ram32", [{ flagName: "n_cpu_moe", flagValue: "4" }, { flagName: "n_cpu_moe", flagValue: "5" }]],
  ["classTune.delete", "orphan-model", "dgpu-vram8|ram32"],
  ["hwClass.save", "dgpu-vram10|ram32", "discrete", 10, 32, " My box ", "", 300.5, null],
  ["hwClass.save", "dgpu-vram11|ram32", "discrete", 11, 32, "Moved", "dgpu-vram10|ram32", null, 40],
  ["hwClass.save", "dgpu-vram8|ram32", "discrete", 8, 32, "Edited in place", "dgpu-vram8|ram32", -5, null],
  ["hwClass.ensure", "igpu-mem8", "integrated", 0, 8],
  ["hwClass.ensure", "dgpu-vram24|ram16", "discrete", 24, 16],
  ["hwClass.delete", "igpu-mem16"],
  ["sample.upsert", "act", "Label", { a: "1", b: "", " ": "z" }, null],
  ["sample.upsert", "act2", "Label 2", { c: "3" }, 2],
  ["sample.upsert", "act3", "L3", {}, 99999],
  ["sample.delete", 3],
  load(1000, fpA),
  load(2000, fpA),
  load(3000, fpB),
  load(4000, fpA, "newest"),
  load(4000, fpB),
  ["measure.prune", "m1", "hw1", 1, "load"],
  ["measure.record", "m2", { machineKey: "hw1", source: "tune", label: "t", tokensPerSec: 3, vramTotalMb: 7000, at: 50, rows: [{ flagName: "x", flagValue: "1" }], backend: "" }],
  ["measure.record", "m3", { machineKey: "", source: "", label: "", tokensPerSec: 41.25, vramTotalMb: 0, at: 60, rows: [], kind: "tts", realtimeX: 2.5, backend: "cpu" }],
  ["measure.clear", "m2"],
  ["defaultPreset.set", "p-user"],
  ["rules.set", { seedVersion: 1, rules: { openai: { collapseDated: true, embedPatterns: ["embed"], dropPatterns: ["^x"] } } }],
  ["seed.resetPreset", refs.presets[0]],
  ["seed.resetRouting"],
  ["seed.llm"],
];
writeFileSync(join(dir, "ops.json"), JSON.stringify({ mutations, ops }));

await python("run", dir, join(dir, "ops.json"));

// ── the JavaScript side ──
const jsPath = join(dir, "js.db");
const open = () => {
  const h = openDatabase(jsPath, { foreignKeys: false }); // Python's sqlite3 leaves them off
  db.createAll(h);
  db.configureStorage(h);
  return h;
};
seed.configureAppSeed({
  featureCatalog: app.feature_catalog,
  featurePrompts: app.feature_prompts,
  enginePresets: app.engine_presets,
  featurePresets: app.feature_presets,
  defaultPresetId: app.default_preset_id,
  modelCatalogExtra: app.model_catalog_extra,
  modelTunesSeed: app.model_tunes_seed,
  hwKeyFn: () => "cmp-hw",
  testSamples: app.test_samples,
  featurePromptHeals: app.feature_prompt_heals,
  classTunesSeed: app.class_tunes_seed,
  classTuneIdentity: app.class_tune_identity,
  embedTemplates: app.embed_templates,
});
let h = open();
seed.seedLlm();
h.close();
copyFileSync(jsPath, join(dir, "js-1.db"));

h = open();
h.tx(() => {
  for (const sql of mutations) h.exec(sql);
});
seed.seedLlm();
h.close();
copyFileSync(jsPath, join(dir, "js-2.db"));

h = open();
const st = stores;
for (const [op, ...a] of ops) {
  switch (op) {
    case "provider.add": st.getProviderStore().add(a[0]); break;
    case "provider.replace": st.getProviderStore().replace(a[0], a[1]); break;
    case "provider.remove": st.getProviderStore().remove(a[0]); break;
    case "routing.set": st.getRoutingStore().setRouting(a[0]); break;
    case "prompt.upsert": st.getPromptStore().upsert(a[0]); break;
    case "catalog.upsert": st.getModelCatalogStore().upsert(a[0]); break;
    case "catalog.setType": st.getModelCatalogStore().setType(...a); break;
    case "catalog.setDerived": st.getModelCatalogStore().setDerived(a[0], a[1]); break;
    case "catalog.delete": st.getModelCatalogStore().delete(a[0]); break;
    case "catalog.reset": st.getModelCatalogStore().resetToFactory(); break;
    case "switchPreset.upsert": st.getSwitchPresetStore().upsert(a[0]); break;
    case "switchPreset.delete": st.getSwitchPresetStore().delete(a[0]); break;
    case "switchPreset.reset": st.getSwitchPresetStore().resetToFactory(); break;
    case "enginePreset.save": st.getEnginePresetStore().save(a[0]); break;
    case "enginePreset.delete": st.getEnginePresetStore().delete(a[0]); break;
    case "ref.set": st.getFeaturePresetRefStore().set(...a); break;
    case "pricing.upsert": st.getPricingStore().upsert(a[0]); break;
    case "pricing.delete": st.getPricingStore().delete(a[0]); break;
    case "reasoning.upsert": st.getReasoningMapStore().upsert(a[0], a[1]); break;
    case "embed.upsert": st.getEmbedTemplateStore().upsert(a[0]); break;
    case "embed.delete": st.getEmbedTemplateStore().delete(a[0]); break;
    case "runner.upsertBinary": st.getRunnerConfigStore().upsertBinary(a[0]); break;
    case "runner.setSetting": st.getRunnerConfigStore().setSetting(...a); break;
    case "runner.setCacheRoot": st.getRunnerConfigStore().setCacheRoot(a[0]); break;
    case "runner.reset": st.getRunnerConfigStore().resetToDefaults(); break;
    case "modelTune.replace": st.getModelTuneStore().replace(...a); break;
    case "modelTune.delete": st.getModelTuneStore().delete(...a); break;
    case "classTune.replace": st.getClassTuneStore().replace(...a); break;
    case "classTune.delete": st.getClassTuneStore().delete(...a); break;
    case "hwClass.save": st.getHardwareClassStore().save(...a); break;
    case "hwClass.ensure": st.getHardwareClassStore().ensure(...a); break;
    case "hwClass.delete": st.getHardwareClassStore().delete(...a); break;
    case "sample.upsert": st.getTestSampleStore().upsert(...a); break;
    case "sample.delete": st.getTestSampleStore().delete(...a); break;
    case "measure.record": st.getModelMeasurementStore().record(a[0], a[1]); break;
    case "measure.prune": st.getModelMeasurementStore().pruneLoadRows(a[0], a[1], st.listFitRelevantFlags(), a[2], a[3]); break;
    case "measure.clear": st.getModelMeasurementStore().clear(a[0]); break;
    case "defaultPreset.set": st.setDefaultPresetId(a[0]); break;
    case "rules.set": st.setModelListRules(a[0]); break;
    case "rules.reset": st.resetModelListRules(); break;
    case "seed.resetRouting": seed.resetRoutingToFactory(); break;
    case "seed.resetPreset": seed.resetPresetToFactory(a[0]); break;
    case "seed.llm": seed.seedLlm(); break;
    default: throw new Error(`unknown op ${op}`);
  }
}
h.close();
copyFileSync(jsPath, join(dir, "js-3.db"));

let failed = false;
for (const [n, what] of [[1, "fresh seed"], [2, "edits + reseed"], [3, "store writes"]]) {
  const r = await python("compare", join(dir, `py-${n}.db`), join(dir, `js-${n}.db`));
  console.log(`phase ${n} (${what}):\n${r.stdout.trimEnd()}`);
  if (r.returncode !== 0) failed = true;
}

// ── phase 4: every store read + module getter, each side on its own phase-3 database ──
h = open();
const reads = {
  "provider.list": st.getProviderStore().list(),
  "provider.get": st.getProviderStore().get("tmp-a"),
  "provider.get.none": st.getProviderStore().get("nope"),
  "routing.get": st.getRoutingStore().getRouting(),
  "prompt.list": st.getPromptStore().list(),
  "prompt.get": st.getPromptStore().get("x.new"),
  "catalog.list": st.getModelCatalogStore().list(),
  "switchPreset.list": st.getSwitchPresetStore().list(),
  "enginePreset.list": st.getEnginePresetStore().list(),
  "ref.list": st.getFeaturePresetRefStore().list(),
  "pricing.list": st.getPricingStore().list(),
  "pricing.asMap": st.getPricingStore().asMap(),
  "reasoning.openai": st.getReasoningMapStore().forProvider("openai"),
  "reasoning.local": st.getReasoningMapStore().mapFor("local-llamacpp"),
  "reasoning.new": st.getReasoningMapStore().forProvider("new-prov"),
  "embed.list": st.getEmbedTemplateStore().list(),
  "embed.get": st.getEmbedTemplateStore().get(" m-e "),
  "runner.getConfig": st.getRunnerConfigStore().getConfig(),
  "runner.cacheRoot": [st.getRunnerConfigStore().getCacheRoot(), st.getRunnerConfigStore().cacheRootChosen()],
  "modelTune.get": st.getModelTuneStore().get("m1", "hw1"),
  "modelTune.baseline": st.getModelTuneStore().getBaseline("m1", "hw1"),
  "modelTune.baseline.none": st.getModelTuneStore().getBaseline("zz", "hw1"),
  "modelTune.forMachine": st.getModelTuneStore().listForMachine("hw1"),
  "classTune.listAll": st.getClassTuneStore().listAll(),
  "hwClass.listAll": st.getHardwareClassStore().listAll(),
  "hwClass.bwFor": [st.getHardwareClassStore().bwFor("dgpu-vram11|ram32"), st.getHardwareClassStore().bwFor("nope")],
  "sample.all": st.getTestSampleStore().listForAction(),
  "sample.act2": st.getTestSampleStore().listForAction("act2"),
  "measure.all": st.getModelMeasurementStore().list(),
  "measure.m1": st.getModelMeasurementStore().list("m1"),
  fitRelevant: [...st.listFitRelevantFlags()].sort(),
  loadRowsKeep: st.loadRowsKeep(),
  defaultPreset: st.getDefaultPresetId(),
  rules: st.getModelListRules(),
  classTuneRefs: st.listClassTuneRefs(),
  classKeyOverride: st.getClassKeyOverride(),
  knobCatalog: st.listKnobCatalog(),
  knobBackends: st.listKnobBackends(),
  buildRunnerConfig: st.buildRunnerConfig(),
};
h.close();
await python("reads", join(dir, "py-3.db"), join(dir, "py-reads.json"));
const pyReads = JSON.parse(readFileSync(join(dir, "py-reads.json"), "utf8"));
// Until identity.js lands, a chat row's floors/estimate (computed from its physics facts)
// can't be computed here: those three fields are left out of the comparison on such rows.
let identityStubbed = false;
try {
  await import("../src/llm/identity.js").then((m) => {
    identityStubbed = m.computedRowNumbers.toString().includes("[null, null, null]");
  });
} catch {
  identityStubbed = true;
}
if (identityStubbed) {
  for (const list of [pyReads["catalog.list"], reads["catalog.list"]]) {
    for (const r of list) {
      if (!r.embedding && r.physicsFacts?.block_count) {
        delete r.minVramMb;
        delete r.minRamMb;
        delete r.estVramMb;
      }
    }
  }
}
writeFileSync(join(dir, "py-reads.json"), JSON.stringify(pyReads));
writeFileSync(join(dir, "js-reads.json"), JSON.stringify(reads));
const rr = await python("compare-reads", join(dir, "py-reads.json"), join(dir, "js-reads.json"));
console.log(`phase 4 (reads${identityStubbed ? "; computed catalog floors skipped — identity.js not ported yet" : ""}):\n${rr.stdout.trimEnd()}`);
if (rr.returncode !== 0) failed = true;
console.log(`databases kept in ${dir}`);
process.exit(failed ? 1 : 0);
