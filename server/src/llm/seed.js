// SPDX-License-Identifier: MIT
// Shared LLM seed data + seeders + the per-app registration hook — the port of
// llm/seed.py. Seeds take the database handle (the Python `s` session) and the caller
// runs them inside one `tx` (Python's commit).
//
// SHARED seed data (identical for every app, shipped here): default providers, the type
// switch presets, the knob catalog, the hardware classes, the runner settings and the
// live routing row. PER-APP seed data is registered by the host via `configureAppSeed`:
// its feature catalog, feature prompts, presets, catalog rows, tunes, samples. `seedLlm`
// runs every seeder; stores' `resetToFactory` re-run individual seeders. All seeders
// merge-by-key and never clobber user edits.
//
// The literals below are byte-identical to seed.py's (generated from it, then commented);
// scripts/compare-seed.js seeds a database with each and compares every cell.
//
// Floats in HOST seed data: Python writes `str(1.0)` as "1.0" where JavaScript can't tell
// 1.0 from 1. A host value that Python held as a float AND that is stored through `str()`
// (sampler values, tune switch values) must be a PyFloat (`pyFloatValue(1.0)`) — every
// seeder here unwraps it for numeric columns and writes Python's text for text columns.
//
// Patched by tests (Python monkeypatched these module variables): `cfg.DEFAULT_CATALOG`,
// `cfg.STALE_SEED_VALUES` and `cfg._APP` — assign and restore them on `cfg` (rule 18).

import { pyFloat, pyIntOf, pyJson, pyStrScalar, unwrap } from "../platform/pyjson.js";
import { getLogger } from "../platform/log.js";
import { pyFloatParse, pyOr, pySorted, strip, truthy, ValueError } from "../platform/py.js";
import * as rconfig from "../runner/config.js";
import * as db from "./db.js";
import * as modelListRules from "./model_list_rules.js";
import { DEFAULT_PRICING } from "./pricing.js";
import { seedRowsForType } from "./reasoning_map_api.js";
import * as stores from "./stores.js";
import { pyEq } from "./stores.js";

const log = getLogger("llm_runner.llm.seed");

/** Python's repr() of a str (the `%r` in log lines and error messages). Candidate for platform/. */
export function pyReprStr(s) {
  s = String(s);
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = q;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === q) out += `\\${q}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20 || c === 0x7f) out += `\\x${c.toString(16).padStart(2, "0")}`;
    else out += ch;
  }
  return out + q;
}

// `p.get(k)` on a seed dict: absent → null (Python's None).
const get = (o, k) => (o != null && Object.hasOwn(o, k) ? o[k] : null);
/** `str(o.get(k) or d)` */
const strOr = (o, k, d) => pyStrScalar(pyOr(get(o, k), d));
/** `int(o.get(k) or d)` */
const intOr = (o, k, d) => pyIntOf(pyOr(get(o, k), d));
/** `float(o.get(k) or d)` */
const floatOr = (o, k, d) => pyFloatParse(pyOr(get(o, k), d));
/** `bool(o.get(k) or False)` */
const boolOf = (o, k) => truthy(get(o, k));
/** A value headed for a numeric column, as given (`o.get(k)`): PyFloat unwrapped. */
const numOrNull = (o, k) => unwrap(get(o, k));

// ── per-app registration (the ONLY per-app inputs) ───────────────────────────
export const cfg = {
  _APP: { feature_catalog: [], feature_prompts: {}, engine_presets: [], feature_presets: {}, default_preset_id: "" },
  // The downloadable model catalog ships EMPTY (family parity batch 2026-08-05, decision
  // ④): a curated model ladder is an APP's data — every app seeds its whole catalog via
  // installLlm({modelCatalogExtra}); the shared package carries mechanism only.
  DEFAULT_CATALOG: [],
  // Known-stale seeded values, healed at boot (QC-43a): a seeded FACT that later proved
  // wrong can never self-heal through fill-empty (the wrong value isn't empty), so each
  // corrected fact records the exact old value(s) it once seeded and the catalog seeder
  // swaps them for the CURRENT seed value — only when the row still carries an exact stale
  // value, so a user- or inspect-written value is never touched. A Map of
  // [rowId, field] → [old values]. Empty since decision ④ (2026-08-05); the MECHANISM stays.
  STALE_SEED_VALUES: new Map(),
};

/**
 * The host registers its feature DATA once at boot (installLlm does this). Every key is
 * optional; one left out keeps what was registered before. `featureCatalog`
 * (FeatureCatalogEntry list), `featurePrompts` ({key: spec}), the PRESET seed —
 * `enginePresets` (the built-in preset library), `featurePresets` (the per-ACTION
 * action→preset_id refs — the one source of what an action runs), `defaultPresetId` (the
 * catch-all for an unassigned action) — and the per-app extras below.
 */
export function configureAppSeed({
  featureCatalog = null,
  featurePrompts = null,
  enginePresets = null,
  featurePresets = null,
  defaultPresetId = null,
  modelCatalogExtra = null,
  modelTunesSeed = null,
  hwKeyFn = null,
  testSamples = null,
  featurePromptHeals = null,
  classTunesSeed = null,
  classTuneIdentity = null,
  embedTemplates = null,
} = {}) {
  const app = cfg._APP;
  if (featureCatalog != null) app.feature_catalog = [...featureCatalog];
  if (featurePrompts != null) app.feature_prompts = { ...featurePrompts };
  if (enginePresets != null) app.engine_presets = [...enginePresets];
  if (featurePresets != null) app.feature_presets = { ...featurePresets };
  if (defaultPresetId != null) app.default_preset_id = String(defaultPresetId);
  // Per-app extra catalog rows + the box tune seed are REGISTERED (not one-shot seeded)
  // so `seedLlm` carries them on BOTH paths — boot AND the data-reset endpoint (found
  // 2026-07-06: install-time-only seeding meant a data reset silently LOST them).
  if (modelCatalogExtra != null) app.model_catalog_extra = [...modelCatalogExtra];
  if (modelTunesSeed != null) app.model_tunes_seed = [...modelTunesSeed];
  if (hwKeyFn != null) app.hw_key_fn = hwKeyFn;
  // §7.3 Lab test samples — synthesized rows for the Lab's Sample button.
  if (testSamples != null) app.test_samples = [...testSamples];
  // Prompt stale-heals: prompt seeding is insert-if-missing, so a seed-text REVISION can
  // never reach an existing DB by itself. The host registers {key: [old exact system
  // texts]}; the heal loop refreshes a row from the current spec ONLY when its system text
  // byte-equals a listed old value, so a user-edited prompt is never touched.
  if (featurePromptHeals != null) {
    app.feature_prompt_heals = Object.fromEntries(Object.entries(featurePromptHeals).map(([k, v]) => [k, [...v]]));
  }
  // Per-app class-tune seed + identity + embed templates (decision ④): a class tune is a
  // MEASUREMENT of an app's model on a PC class, and an embed template is a model fact
  // about an app's catalog row — both are the app's data.
  //   classTunesSeed: [{model_id, class_key, switches: {flag: value}}]
  //   classTuneIdentity: {model_id: {hf_repo, quant}} — what each tuned id was measured
  //     on, so linkClassTunesToCatalog can bind the tune to a differently-named row over
  //     the same GGUF.
  //   embedTemplates: [{id, document, query}]
  if (classTunesSeed != null) app.class_tunes_seed = [...classTunesSeed];
  if (classTuneIdentity != null) {
    app.class_tune_identity = Object.fromEntries(Object.entries(classTuneIdentity).map(([k, v]) => [k, { ...v }]));
  }
  if (embedTemplates != null) app.embed_templates = [...embedTemplates];
}

/** The host's feature catalog (FeatureCatalogEntry list) — getCatalog for the routing router. */
export const appFeatureCatalog = () => cfg._APP.feature_catalog;
export const appFeaturePrompts = () => cfg._APP.feature_prompts;
/** The host's built-in engine presets (list of seed objects) — the factory preset library. */
export const appEnginePresets = () => cfg._APP.engine_presets;
/** The host's per-ACTION preset refs (action → preset_id) — seeded into `feature_preset_refs`. */
export const appFeaturePresets = () => cfg._APP.feature_presets;
/** The host's global default preset id — seeded fill-if-empty into `default_preset_id`. */
export const appDefaultPresetId = () => cfg._APP.default_preset_id;

// ── SHARED seed data ─────────────────────────────────────────────────────────
// NO seeded default_model on any provider (user, 2026-07-06: "we pull model from provider
// once connected"). The rows are connect-ready endpoints only; the user fetches the
// provider's LIVE model list and picks after connecting.
export const DEFAULT_PROVIDERS = [
  // Local thinking runs take minutes per call on consumer hardware; 60 s cut them off.
  { id: "local-llamacpp", name: "Built-in provider — llama.cpp", provider_type: "local-llamacpp", base_url: "http://127.0.0.1:8080/v1", local: true, timeout_seconds: 900 },
  { id: "openai-compat-local", name: "Ollama (local)", provider_type: "ollama", base_url: "http://localhost:11434", local: true },
  // LM Studio and Unsloth Studio speak OpenAI-compatible, so the generic `openai-compat`
  // adapter is right — a dedicated type would buy a label and cost ~8 parallel type
  // lists. Seeded so they are PRESENT out of the box like Ollama. Unsloth's base URL is
  // from its own curl example (its docs also say "typically 8000 or 8888" — a user serving
  // on 8000 edits the row). Unsloth is deliberately NOT in detect-local: its API needs a
  // Bearer key on every request, so an unauthenticated probe could only ever 401.
  { id: "lmstudio", name: "LM Studio (local)", provider_type: "openai-compat", base_url: "http://localhost:1234/v1", local: true },
  { id: "unsloth", name: "Unsloth Studio (local)", provider_type: "openai-compat", base_url: "http://localhost:8888/v1", local: true },
  { id: "openai", name: "OpenAI", provider_type: "openai", base_url: "https://api.openai.com/v1", local: false },
  { id: "claude", name: "Claude (Anthropic)", provider_type: "anthropic", base_url: "https://api.anthropic.com", local: false },
  { id: "gemini", name: "Gemini (Google)", provider_type: "gemini", base_url: "https://generativelanguage.googleapis.com", local: false },
  { id: "deepseek", name: "DeepSeek", provider_type: "deepseek", base_url: "https://api.deepseek.com/v1", local: false },
  { id: "openrouter", name: "OpenRouter (aggregator)", provider_type: "openrouter", base_url: "https://openrouter.ai/api/v1", local: false },
  { id: "xai", name: "xAI (Grok)", provider_type: "xai", base_url: "https://api.x.ai/v1", local: false },
  { id: "mistral", name: "Mistral", provider_type: "mistral", base_url: "https://api.mistral.ai/v1", local: false },
];

// ── Embedding task templates ─────────────────────────────────────────────────
// The task instruction an embed model REQUIRES around its input is a fact about a CATALOG
// ROW — and catalog rows are app data now (decision ④), so the shared seed carries none.
export const DEFAULT_EMBED_TEMPLATES = [];

// Capability/type switch presets — the switch BASE layer (design §6.5 + Plan B).
// `applies_to`: `all` (every model) | `moe`/`dense` (matches `model_catalog.type`) | `mtp`
// (GATED auto-enable — only a model with built-in MTP or a configured external draft
// file; auto-on, visible, and uncheckable — an opt-out persists in `model_tunes` and
// wins). Resolved + layered by `switch_resolve.resolveModelSwitches`. (`-ngl` is NOT here
// — it's a computed fit knob, not a constant.)
export const DEFAULT_SWITCH_PRESETS = [
  // reasoning_budget is the visible GLOBAL tier of the per-request thinking budget, read
  // via switch_resolve at request time and layered like any switch (base → hardware class
  // → applied model tune) — NOT a launch flag. 1024 = the tested value.
  // context_shift + cache_reuse are NOT here (user, 2026-07-07, on-box tested): Gemma 4's
  // iSWA context supports neither (llama.cpp auto-disables both with a warning), and
  // context_shift measured as a net loss. (They left knob_catalog entirely — QC-11.)
  { id: "base", label: "Base (every model)", applies_to: "all", position: 0, switches: { flash_attn: "on", cache_type_k: "q8_0", cache_type_v: "q8_0", mlock: "true", reasoning_budget: "1024" } },
  // ONLY no_mmap is genuinely MoE-specific; the spec_type default (none) lives ONCE in
  // knob_catalog — no duplicate here.
  { id: "moe", label: "MoE (mixture-of-experts)", applies_to: "moe", position: 1, switches: { no_mmap: "true" } },
  // spec_n_max=2 is the USER-MEASURED sweet spot (2026-07-05, gemma-4-26B) and DIFFERS
  // from the knob default (3) — a value equal to the knob default must NOT be seeded here.
  { id: "mtp", label: "MTP (multi-token prediction)", applies_to: "mtp", position: 2, switches: { spec_type: "draft-mtp", spec_n_max: "2" } },
];

// The seeded NAMED hardware classes (2026-07-22 redesign) — the sidecar giving each class
// its label + editable VRAM/RAM. name="" → the UI shows the plain-words "8 GB VRAM · 32 GB
// RAM". The dGPU rows are BANDS (exact match covers 10/11 GB cards under vram12's floor
// sibling vram8, a 20 GB card under vram16, a 4090/5090 alike under vram24); one row per
// (band × real RAM rung) — "two identical rows beat a matching engine". The 16 GB
// integrated class carries no class TUNE yet: no measurement exists on that box (the seed
// ships facts and rules, the machine supplies measurements).
export const DEFAULT_HARDWARE_CLASSES = [
  { class_key: "dgpu-vram8|ram32", mem_type: "discrete", vram_gb: 8, ram_gb: 32, name: "" },
  { class_key: "igpu-mem32", mem_type: "integrated", vram_gb: 0, ram_gb: 32, name: "" },
  { class_key: "igpu-mem16", mem_type: "integrated", vram_gb: 0, ram_gb: 16, name: "" },
  { class_key: "dgpu-vram8|ram16", mem_type: "discrete", vram_gb: 8, ram_gb: 16, name: "" },
  { class_key: "dgpu-vram12|ram16", mem_type: "discrete", vram_gb: 12, ram_gb: 16, name: "" },
  { class_key: "dgpu-vram12|ram32", mem_type: "discrete", vram_gb: 12, ram_gb: 32, name: "" },
  { class_key: "dgpu-vram12|ram64", mem_type: "discrete", vram_gb: 12, ram_gb: 64, name: "" },
  { class_key: "dgpu-vram16|ram16", mem_type: "discrete", vram_gb: 16, ram_gb: 16, name: "" },
  { class_key: "dgpu-vram16|ram32", mem_type: "discrete", vram_gb: 16, ram_gb: 32, name: "" },
  { class_key: "dgpu-vram16|ram64", mem_type: "discrete", vram_gb: 16, ram_gb: 64, name: "" },
  { class_key: "dgpu-vram24|ram32", mem_type: "discrete", vram_gb: 24, ram_gb: 32, name: "" },
  { class_key: "dgpu-vram24|ram64", mem_type: "discrete", vram_gb: 24, ram_gb: 64, name: "" },
];

// Class-typical RAW pool bandwidths, GB/s (fit-redesign Phase 3, §5.5 ladder source 3) —
// the LAST-resort fallback, GUI-editable in the class editor, superseded by any
// measurement or device-reported number. Each dGPU band seeds its SLOWEST common card
// (err-slow §8.17):
//   8  → 224  (RTX 3050 8 GB: 128-bit GDDR6 @ 14 Gbps)
//   12 → 360  (RTX 3060 12 GB: 192-bit GDDR6 @ 15 Gbps)
//   16 → 288  (RTX 4060 Ti 16 GB: 128-bit GDDR6 @ 18 Gbps)
//   24 → 672  (TITAN RTX: 384-bit GDDR6 @ 14 Gbps — a 3090 is 936, a 4090 1008)
const DGPU_BAND_BW_GBPS = new Map([
  [8, 224.0],
  [12, 360.0],
  [16, 288.0],
  [24, 672.0],
]);
// System-RAM floor for every class: JEDEC DDR4-3200 dual-channel = 51.2 GB/s (a
// standard, not an opinion — §5.5); the RAM copy probe supersedes it on first run.
const CLASS_RAM_BW_GBPS = 51.2;

/** [vram_bw_gbps, ram_bw_gbps] seed for a class row — one-pool classes carry the pool in
 * ram_bw_gbps only. (Python's private `_class_bw_seed`; stores reach it.) */
export function _classBwSeed(memType, vramGb) {
  if (memType === "discrete") return [DGPU_BAND_BW_GBPS.get(pyIntOf(vramGb)) ?? 0.0, CLASS_RAM_BW_GBPS];
  return [0.0, CLASS_RAM_BW_GBPS];
}

/**
 * Seed the built-in hardware-class rows (merge-by-key: a user-edited class is never
 * clobbered). Called BEFORE seedDefaultClassTunes so a seeded config's class exists. An
 * EXISTING row still at bandwidth 0/0 (a pre-Phase-3 DB) gets the seed bandwidths filled
 * — fill-empty only, a user-entered number is never touched.
 */
export function seedDefaultHardwareClasses(h) {
  const existing = new Map(h.all("select * from hardware_classes", [], "hardware_classes").map((r) => [r.class_key, r]));
  let added = 0;
  for (const row of DEFAULT_HARDWARE_CLASSES) {
    const [vramBw, ramBw] = _classBwSeed(row.mem_type, pyIntOf(row.vram_gb));
    const cur = existing.get(row.class_key);
    if (cur) {
      if (!cur.vram_bw_gbps && !cur.ram_bw_gbps) {
        h.update("hardware_classes", { vram_bw_gbps: vramBw, ram_bw_gbps: ramBw }, { class_key: row.class_key });
      }
      continue;
    }
    h.insert("hardware_classes", {
      class_key: row.class_key,
      mem_type: row.mem_type,
      vram_gb: pyIntOf(row.vram_gb),
      ram_gb: pyIntOf(row.ram_gb),
      name: get(row, "name") ?? "",
      built_in: true,
      vram_bw_gbps: vramBw,
      ram_bw_gbps: ramBw,
    });
    added += 1;
  }
  return added;
}

// The seeded hardware-CLASS tune library ships EMPTY (decision ④): a class tune is a
// MEASUREMENT of an app's model on a PC class — the app's data. An app registers its
// measured rows via installLlm({classTunesSeed}).
export const DEFAULT_CLASS_TUNES = [];

// WHAT A TUNE WAS MEASURED ON — {model_id: {hf_repo, quant}} — lets
// linkClassTunesToCatalog bind a tune to a differently-named catalog row over the SAME
// GGUF (measured 2026-08-03: without the identity bridge the measured 8 GB/32 GB config
// silently never applied in the i18n app). Per-app data, registered via
// installLlm({classTuneIdentity}); this shared default stays empty.
export const DEFAULT_CLASS_TUNE_IDENTITY = {};

const identityKey = (hfRepo, quant) => `${strip(hfRepo || "").toLowerCase()}\u0000${strip(quant || "").toLowerCase()}`;

const identityMap = () => ({ ...DEFAULT_CLASS_TUNE_IDENTITY, ...(cfg._APP.class_tune_identity || {}) });

const tunedModelIds = (h) => pySorted(h.all("select distinct model_id from class_tunes").map((r) => r.model_id));

/**
 * Make measured tunes reachable from whatever id THIS app's catalog uses. Runs LAST in
 * seedLlm — after the default catalog AND the host's extra rows — and copies the rows of
 * any tune whose `model_id` has no catalog row onto the catalog row with the same identity
 * (hf_repo + quant). Insert-if-missing, so a tune already present for that (model, class)
 * is never touched and a host that names the model the same way is a no-op. A tune that
 * matches NOTHING is logged: dead weight should say so rather than sit there looking like
 * coverage.
 */
export function linkClassTunesToCatalog(h) {
  const catalog = new Map(h.all("select * from model_catalog", [], "model_catalog").map((r) => [r.id, r]));
  const byIdentity = new Map();
  for (const r of catalog.values()) {
    const k = identityKey(r.hf_repo, r.quant);
    if (!byIdentity.has(k)) byIdentity.set(k, r.id);
  }
  let linked = 0;
  for (const mid of tunedModelIds(h)) {
    if (catalog.has(mid)) continue; // the host names it the same way — nothing to do
    const idMap = identityMap();
    const ident = Object.hasOwn(idMap, mid) ? idMap[mid] : null;
    const target = ident ? byIdentity.get(identityKey(get(ident, "hf_repo"), get(ident, "quant"))) : null;
    if (!target) {
      log.warning(
        `class tunes for ${pyReprStr(mid)} match no model in this catalog — they cannot apply. ` +
          "Add a catalog row for it, or register its hf_repo+quant via " +
          "install_llm(class_tune_identity=…) so it can bind by identity.",
      );
      continue;
    }
    const rows = h.all("select * from class_tunes where model_id = ?", [mid], "class_tunes");
    let copied = 0;
    for (const ckey of pySorted([...new Set(rows.map((r) => r.class_key))])) {
      if (h.one("select 1 from class_tunes where model_id = ? and class_key = ? limit 1", [target, ckey])) continue;
      for (const r of rows.filter((x) => x.class_key === ckey)) {
        h.insert("class_tunes", {
          model_id: target,
          class_key: ckey,
          flag_name: r.flag_name,
          flag_value: r.flag_value,
          built_in: true,
        });
      }
      copied += 1;
    }
    if (copied) {
      log.info(`linked ${copied} measured class-tune row(s) ${pyReprStr(mid)} → ${pyReprStr(target)} (same hf_repo + quant)`);
    }
    linked += copied;
  }
  return linked;
}

/**
 * Seed the built-in class-tune rows — the (empty) shared set plus the APP's registered
 * `class_tunes_seed`. Merge-by-(model, class): a user-edited or Lab-measured row for the
 * same (model, class) is never clobbered — only a class with NO rows yet inserts.
 */
export function seedDefaultClassTunes(h) {
  let added = 0;
  for (const row of [...DEFAULT_CLASS_TUNES, ...(cfg._APP.class_tunes_seed || [])]) {
    const mid = row.model_id;
    const ckey = row.class_key;
    if (h.one("select 1 from class_tunes where model_id = ? and class_key = ? limit 1", [mid, ckey])) continue;
    for (const [fname, fval] of Object.entries(row.switches)) {
      h.insert("class_tunes", { model_id: mid, class_key: ckey, flag_name: fname, flag_value: pyStrScalar(fval), built_in: true });
    }
    added += 1;
  }
  return added;
}

/**
 * Delete SEEDED (built_in) class-tune rows that can bind to nothing in THIS app's catalog
 * — neither by id nor by registered identity. Runs after linkClassTunesToCatalog, so
 * anything bindable has already been linked. Why: the shared seed used to push all 13
 * measured rows into EVERY adopter's DB, and seeders never prune — after decision ④ moved
 * the tunes into JustWrite's seed, the other apps' DBs would warn about dead rows forever.
 * Safe because a user's own config is never built_in (the class-tunes PUT always writes
 * built_in=false), so only seed residue matches.
 */
export function retireOrphanBuiltinClassTunes(h) {
  const catalogIds = new Set(h.all("select id from model_catalog").map((r) => r.id));
  const ident = identityMap();
  let removed = 0;
  for (const mid of tunedModelIds(h)) {
    if (catalogIds.has(mid) || Object.hasOwn(ident, mid)) continue;
    const n = h.run("delete from class_tunes where model_id = ? and built_in is 1", [mid]).changes;
    if (n) {
      log.info(`retired ${n} orphaned seeded class-tune row(s) for ${pyReprStr(mid)} (no catalog row, no identity — decision ④ cleanup)`);
      removed += n;
    }
  }
  return removed;
}

// Runner config (was runner-manifest.json). The binary list + scalars come from the runner
// package (ONE source of truth; the standalone runner also reads them via
// runner/config.js defaultConfig) and are seeded built_in. Floats are written as Python's
// str() writes them ("20.0", "0.1").
const c = rconfig;
export const DEFAULT_RUNNER_SETTINGS = [
  { key: "pinned_build", value: c.DEFAULT_PINNED_BUILD },
  { key: "safety_margin_mb", value: String(c.DEFAULT_SAFETY_MARGIN_MB) },
  // Computed-ctx cap for untuned launches (fit-redesign §8.1).
  { key: "ctx_cap_tokens", value: String(c.DEFAULT_CTX_CAP_TOKENS) },
  // Fit-redesign Phase 2 floor rules (§8.21/§13.13):
  { key: "floor_ctx_tokens", value: String(c.DEFAULT_FLOOR_CTX_TOKENS) },
  { key: "ram_headroom_mb", value: String(c.DEFAULT_RAM_HEADROOM_MB) },
  // Fit-redesign Phase 3 — speed-band thresholds (§8.14, tok/s minimums) + the two
  // bandwidth efficiency families (§13.8; host seeded LOW per err-slow).
  { key: "band_fast_toks", value: pyFloat(c.DEFAULT_BAND_FAST_TOKS) },
  { key: "band_fine_toks", value: pyFloat(c.DEFAULT_BAND_FINE_TOKS) },
  { key: "band_slow_toks", value: pyFloat(c.DEFAULT_BAND_SLOW_TOKS) },
  // Speed-truth plan §5: a PREDICTION this close to a threshold shows its number, not a
  // coin-flip word.
  { key: "band_deadzone_frac", value: pyFloat(c.DEFAULT_BAND_DEADZONE_FRAC) },
  // Speed-truth plan §7: the fallback pick's speed-floor grace.
  { key: "speed_floor_grace", value: pyFloat(c.DEFAULT_SPEED_FLOOR_GRACE) },
  // Speed-truth plan §6: the one-minute speed check's test model — our own GitHub
  // release, sha-pinned, its byte facts constants of that file.
  { key: "calib_model_url", value: c.DEFAULT_CALIB_MODEL_URL },
  { key: "calib_model_sha256", value: c.DEFAULT_CALIB_MODEL_SHA256 },
  { key: "calib_model_size_bytes", value: String(c.DEFAULT_CALIB_MODEL_SIZE_BYTES) },
  { key: "calib_active_expert_mb", value: pyFloat(c.DEFAULT_CALIB_ACTIVE_EXPERT_MB) },
  { key: "calib_nonexpert_mb", value: pyFloat(c.DEFAULT_CALIB_NONEXPERT_MB) },
  { key: "bw_eff_device", value: pyFloat(c.DEFAULT_BW_EFF_DEVICE) },
  { key: "bw_eff_host", value: pyFloat(c.DEFAULT_BW_EFF_HOST) },
  // The RAM probe's OWN factor (§5.5 probe calibration — single-thread copy underruns
  // streaming; the generic host factor lied).
  { key: "bw_eff_host_probe", value: pyFloat(c.DEFAULT_BW_EFF_HOST_PROBE) },
  // Fit-redesign Phase 5 (§13.2): retention K for persisted load footprints.
  { key: "load_rows_keep", value: String(c.DEFAULT_LOAD_ROWS_KEEP) },
  // Router mode (P1e): DB-editable co-resident cap + idle-unload TTL.
  { key: "models_max", value: String(c.DEFAULT_MODELS_MAX) },
  { key: "sleep_idle_seconds", value: String(c.DEFAULT_SLEEP_IDLE_SECONDS) },
  // Segmented downloads (DL-2).
  { key: "download_segments_enabled", value: c.DEFAULT_DOWNLOAD_SEGMENTS_ENABLED ? "1" : "0" },
  { key: "download_segment_count", value: String(c.DEFAULT_DOWNLOAD_SEGMENT_COUNT) },
  // download_segment_min_bytes is RETIRED (the downloader falls back to single-stream
  // itself) but the row is kept — an existing DB keeps its value; inert.
  { key: "download_segment_min_bytes", value: String(c.DEFAULT_DOWNLOAD_SEGMENT_MIN_BYTES) },
  { key: "download_segment_retries", value: String(c.DEFAULT_DOWNLOAD_SEGMENT_RETRIES) },
  // CONCURRENT model downloads (2026-07-20): parallel per-model download cap.
  { key: "download_max_concurrent", value: String(c.DEFAULT_DOWNLOAD_MAX_CONCURRENT) },
  // Warm the default local chat model into VRAM on app startup. Default ON — but the
  // CLIENT only warms when the routing default IS the built-in provider with a downloaded
  // model (so a cloud-default user never triggers a load).
  { key: "warm_default_on_startup", value: "1" },
  // (reasoning_cap_default REMOVED 2026-07-16: the reasoning budget is a normal layered
  // `reasoning_budget` SWITCH row resolved by switch_resolve. Existing DBs keep an orphan
  // runner_setting row; the resolver no longer reads it.)
];

// Knob catalog — metadata that turns a raw switch/sampler key into a friendly KnobGrid
// input. Plane 1 = load-time engine switch (maps to a process Overrides field); Plane 2 =
// per-request sampler (maps to the dispatch `extra`). `options` (inline) become enum rows
// in knob_option. QC-17 + QC-18 (user, 2026-07-09): plane-1 rows carry NO default_value
// (an unset switch simply isn't sent, the engine does its own thing) and NO options
// (switch values are plain text/number boxes; the HELP names the accepted values —
// verified against llama.cpp tools/server/README.md, 2026-07-09). Plane-2 sampler rows
// keep default_value (OUR enable-prefills). `tier` = common|advanced drives the sampler
// checklist split. Order within each plane is common-first (the seeder sets position=i).
export const DEFAULT_KNOBS = [
  // ── Plane 1 — load switches: COMMON (fit & memory) ──
  { flag_name: "ctx_len", fit_relevant: true, kind: "int", plane: 1, tier: "common",
    help: "Maximum tokens the model can read + write at once. Bigger = more memory (the KV cache grows with it). Set it to fit your longest task; unset, the engine reads the model's own limit." },
  { flag_name: "flash_attn", fit_relevant: true, kind: "string", plane: 1, tier: "common",
    help: "Faster attention using less memory. Values: on, off, auto." },
  { flag_name: "cache_type_k", fit_relevant: true, kind: "string", plane: 1, tier: "common",
    help: "Compress the K side of the KV cache to save VRAM. q8_0 is near-lossless; q4_0 saves more but can cost quality. Accepts f32, f16, bf16, q8_0, q4_0, q4_1, iq4_nl, q5_0, q5_1." },
  { flag_name: "cache_type_v", fit_relevant: true, kind: "string", plane: 1, tier: "common",
    help: "Compress the V side of the KV cache to save VRAM. q8_0 is near-lossless. Accepts f32, f16, bf16, q8_0, q4_0, q4_1, iq4_nl, q5_0, q5_1." },
  { flag_name: "n_cpu_moe", fit_relevant: true, backends: "cuda,rocm,vulkan,metal", kind: "int", plane: 1, applies_to: "moe", tier: "common",
    help: "Expert layers to run on CPU — frees VRAM (MoE only). Auto-fit sets it; pin the fast value here." },
  // ── Plane 1 — load switches: ADVANCED ──
  // n_gpu_layers (2026-07-07, user bug report): always a valid Overrides field, but with
  // no catalog row the class-tune seed's n_gpu_layers=99 (the MoE pattern: all layers on
  // GPU, offload via n_cpu_moe) badged "unrecognized". The row makes it a first-class,
  // labelled switch.
  { flag_name: "n_gpu_layers", fit_relevant: true, backends: "cuda,rocm,vulkan,metal", kind: "int", plane: 1, tier: "advanced",
    help: "How many model layers run on the GPU (the rest run on CPU). Auto-fit sets it when unset; MoE tunes pin every layer on GPU (99) and free VRAM with CPU MoE layers instead." },
  { flag_name: "mlock", kind: "bool", plane: 1, tier: "advanced",
    help: "Keep the model locked in RAM so the OS can't swap it out (steadier speed). Turn off if RAM is tight. Values: true or false." },
  { flag_name: "no_mmap", backends: "cuda,rocm,vulkan,metal", kind: "bool", plane: 1, applies_to: "moe", tier: "advanced",
    help: "Read the whole model into RAM instead of memory-mapping it. Needed for MoE CPU-offload; otherwise leave off. Values: true or false." },
  { flag_name: "no_kv_offload", fit_relevant: true, backends: "cuda,rocm,vulkan,metal", kind: "bool", plane: 1, tier: "advanced",
    help: "Keep the KV cache in system RAM instead of VRAM — frees VRAM but is slower. Values: true or false." },
  { flag_name: "batch_size", fit_relevant: true, kind: "int", plane: 1, tier: "advanced",
    help: "How many prompt tokens are processed together (throughput vs memory)." },
  { flag_name: "ubatch_size", fit_relevant: true, kind: "int", plane: 1, tier: "advanced",
    help: "Physical batch — the chunk actually run per step. Lower it if prompt processing runs out of memory." },
  { flag_name: "threads", kind: "int", plane: 1, tier: "advanced",
    help: "CPU threads for generation (drive MoE CPU experts). Unset, the engine uses your physical cores." },
  { flag_name: "threads_batch", kind: "int", plane: 1, tier: "advanced",
    help: "CPU threads for prompt processing. Unset, the engine matches CPU threads." },
  { flag_name: "parallel", fit_relevant: true, kind: "int", plane: 1, tier: "advanced",
    help: "Concurrent server slots (used by batch sweeps / Compare)." },
  { flag_name: "cont_batching", kind: "bool", plane: 1, tier: "advanced",
    help: "Overlap requests for throughput; only turn it off to debug. Values: true or false." },
  // context_shift + cache_reuse REMOVED from the catalog (QC-11) — still typeable as
  // custom switches. spec_type carries OPTIONS (2026-07-24, after a typo'd value killed a
  // load — the server refuses unknown spec types): this AMENDS QC-18 for option-carrying
  // knobs only; knobs without options stay free text.
  { flag_name: "spec_type", kind: "string", plane: 1, tier: "advanced",
    help: "Draft-model speculative decode; gains are machine-dependent — measure. draft-mtp auto-uses the catalog's MTP sidecar; dflash/eagle3 need model_draft pointing at a matching trained drafter GGUF (engine >= b10094).",
    options: [{ value: "none" }, { value: "draft-mtp" }, { value: "draft-dflash" }, { value: "draft-eagle3" }, { value: "ngram-mod" }] },
  { flag_name: "spec_n_max", kind: "int", plane: 1, tier: "advanced",
    help: "How many tokens the draft proposes per step. Measured best: 2 for draft-mtp (2026-07-05); the DFlash author's guidance is 6." },
  // model_draft promoted to a first-class knob (2026-07-24): always reachable as a raw
  // switch row — surfacing it with help beats making users guess the name.
  { flag_name: "model_draft", kind: "string", plane: 1, tier: "advanced",
    help: "Path to an explicit speculative-draft GGUF (--model-draft). Normally auto-filled from the catalog's MTP sidecar; set by hand to test an alternate drafter (e.g. DFlash) together with spec_type=draft-dflash. The draft is charged to the VRAM fit." },
  { flag_name: "reasoning_budget", kind: "int", plane: 1, per_request: true, tier: "advanced",
    help: "Thinking-token budget for this model, layered like any switch (global → hardware class → your applied config) — but NOT a launch flag: it is sent with EVERY request as JSON and applies immediately, no reload. -1 = unlimited (can think until the context fills), 0 = thinking off, N = at most N thinking tokens." },
  // ── Plane 2 — per-request samplers: COMMON ──
  // NB (#15 C4): cloud delivery of any sampler knob here is gated by the per-type
  // allowlists (openai_sdk TYPE_PARAM_PROFILES · anthropic mapExtra · gemini buildConfig);
  // ollama + local pass everything. A new sampler here means deciding, per cloud, whether
  // it survives that allowlist. temperature + top_p are edited in the per-call params row.
  { flag_name: "temperature", kind: "float", plane: 2, default_value: "0.7", tier: "common",
    help: "Randomness. Low (≈0) for extraction/JSON; higher (0.8–1.0) for prose." },
  { flag_name: "top_p", kind: "float", plane: 2, default_value: "0.95", tier: "common",
    help: "Nucleus sampling — keep the smallest set of tokens summing to this probability. The cloud-API truncation knob." },
  { flag_name: "top_k", kind: "int", plane: 2, tier: "common",
    help: "Keep only the k most-likely tokens (0 = off)." },
  { flag_name: "min_p", kind: "float", plane: 2, tier: "common",
    help: "Drop tokens below this fraction of the top token's probability. For local models this is the truncation knob to reach for first (try 0.05–0.1)." },
  { flag_name: "repeat_penalty", kind: "float", plane: 2, tier: "common",
    help: "Penalize recently-used tokens (>1 reduces repetition)." },
  { flag_name: "repeat_last_n", kind: "int", plane: 2, default_value: "64", tier: "common",
    help: "How many recent tokens Repeat penalty looks back over (llama.cpp default 64; -1 = whole context, 0 = off)." },
  { flag_name: "seed", kind: "int", plane: 2, tier: "common",
    help: "Fixed RNG seed for reproducible output (-1 = random)." },
  // ── Plane 2 — per-request samplers: ADVANCED ──
  { flag_name: "presence_penalty", kind: "float", plane: 2, tier: "advanced",
    help: "Penalize tokens that already appeared at all (OpenAI-style; 0 = off)." },
  { flag_name: "frequency_penalty", kind: "float", plane: 2, tier: "advanced",
    help: "Penalize tokens by how often they've appeared (OpenAI-style; 0 = off)." },
  { flag_name: "typical_p", kind: "float", plane: 2, tier: "advanced",
    help: "Locally-typical sampling — keep tokens near the expected information content (1.0 = off)." },
  { flag_name: "dry_multiplier", kind: "float", plane: 2, tier: "advanced",
    help: "Don't-Repeat-Yourself: penalize repeated sequences (0 = off). A stronger anti-repetition than Repeat penalty." },
  { flag_name: "dry_base", kind: "float", plane: 2, default_value: "1.75", tier: "advanced",
    help: "How steeply DRY penalizes longer repeats (llama.cpp default 1.75). Used with DRY penalty." },
  { flag_name: "dry_allowed_length", kind: "int", plane: 2, default_value: "2", tier: "advanced",
    help: "Repeats up to this length are free; longer ones get penalized (llama.cpp default 2)." },
  { flag_name: "dry_penalty_last_n", kind: "int", plane: 2, default_value: "-1", tier: "advanced",
    help: "How many recent tokens DRY scans (-1 = whole context, 0 = off)." },
  { flag_name: "xtc_probability", kind: "float", plane: 2, tier: "advanced",
    help: "Exclude-Top-Choices: chance to drop the most-likely tokens for variety (0 = off)." },
  { flag_name: "xtc_threshold", kind: "float", plane: 2, default_value: "0.1", tier: "advanced",
    help: "XTC only removes tokens above this probability (llama.cpp default 0.1; 1.0 = off). Used with XTC probability." },
  { flag_name: "mirostat", kind: "int", plane: 2, tier: "advanced",
    help: "Adaptive perplexity sampler: 0 = off, 1 = v1, 2 = v2." },
  { flag_name: "mirostat_tau", kind: "float", plane: 2, default_value: "5.0", tier: "advanced",
    help: "Mirostat target 'surprise' (entropy) — higher = more varied (llama.cpp default 5.0). Used only when Mirostat is on." },
  { flag_name: "mirostat_eta", kind: "float", plane: 2, default_value: "0.1", tier: "advanced",
    help: "Mirostat learning rate — how fast it adapts (llama.cpp default 0.1). Used only when Mirostat is on." },
  { flag_name: "dynatemp_range", kind: "float", plane: 2, default_value: "0.0", tier: "advanced",
    help: "Dynamic temperature: how far temperature can swing per token (0 = off)." },
  { flag_name: "dynatemp_exponent", kind: "float", plane: 2, default_value: "1.0", tier: "advanced",
    help: "Shape of the dynamic-temperature curve (llama.cpp default 1.0). Used with Dynamic temp range." },
  { flag_name: "top_n_sigma", kind: "float", plane: 2, default_value: "-1.0", tier: "advanced",
    help: "Keep tokens within N standard deviations of the top logit (-1 = off). A newer, simple truncation." },
  { flag_name: "min_keep", kind: "int", plane: 2, default_value: "0", tier: "advanced",
    help: "Always keep at least this many candidate tokens through the filters (0 = no minimum)." },
];

// Prior seeded names, per provider id (#3, 2026-07-08 "Built-in server" → "Built-in
// provider"): existing DBs keep their rows on reseed, so a pure rename never reaches
// them. The seeder refreshes a present row's name ONLY while it still reads exactly one
// of these old seeded strings — a user's own rename is a different fact and is never
// touched.
const RENAMED_PROVIDER_NAMES = { "local-llamacpp": ["Built-in server — llama.cpp"] };

// ── seeders (operate on the passed handle; the caller's tx is the commit) ────
export function seedDefaultProviders(h) {
  const existing = new Map(h.all("select * from llm_providers", [], "llm_providers").map((r) => [r.id, r]));
  let pos = existing.size;
  let added = 0;
  for (const p of DEFAULT_PROVIDERS) {
    if (existing.has(p.id)) {
      const row = existing.get(p.id);
      if ((RENAMED_PROVIDER_NAMES[p.id] || []).includes(row.name)) {
        h.update("llm_providers", { name: strOr(p, "name", "") }, { id: p.id });
      }
      continue;
    }
    h.insert("llm_providers", {
      id: p.id,
      name: strOr(p, "name", ""),
      kind: "llm",
      built_in: true,
      position: pos,
      provider_type: pyStrScalar(p.provider_type),
      base_url: strOr(p, "base_url", ""),
      api_key: null,
      default_model: strOr(p, "default_model", ""),
      embedding_model: strOr(p, "embedding_model", ""),
      timeout_seconds: intOr(p, "timeout_seconds", 60),
      local: truthy(p.local),
    });
    pos += 1;
    added += 1;
  }
  return added;
}

/**
 * Fill-if-missing reasoning_map rows for every provider, keyed by its type (U2-T2).
 * Additive — new providers/levels gain rows at boot; a user edit is never clobbered. Runs
 * AFTER seedDefaultProviders. (Python had to flush first — its host session is autoflush-
 * OFF and the provider query saw none of the just-added rows: fresh boots shipped an empty
 * map until a second boot, 2026-07-14. Every insert here is already visible.)
 */
export function seedDefaultReasoningMap(h) {
  const have = new Set(h.all("select provider_id, level from reasoning_map").map((r) => `${r.provider_id}\u0000${r.level}`));
  let added = 0;
  for (const prov of h.all("select * from llm_providers", [], "llm_providers")) {
    for (const row of seedRowsForType(prov.provider_type)) {
      if (have.has(`${prov.id}\u0000${row.level}`)) continue;
      h.insert("reasoning_map", { provider_id: prov.id, level: row.level, word: row.word || "", tokens: row.tokens, built_in: true });
      added += 1;
    }
  }
  return added;
}

// Use-limited licenses (not free for unrestricted/commercial use) → the ⚠ badge. This
// keyword match runs ONCE at seed time to populate the per-model `use_limited` flag, which
// is then DB-stored + editable per-model — NO hardcoded runtime license rule.
const USE_LIMITED_TERMS = ["community", "research", "non-commercial", "noncommercial", "llama", "gemma", "cc-by-nc"];

const useLimited = (licenseId) => {
  const lic = (licenseId || "").toLowerCase();
  return USE_LIMITED_TERMS.some((t) => lic.includes(t));
};

/**
 * One catalog seed object → a model_catalog row. Shared by the built-in seed and the
 * per-APP extra rows (`seedExtraCatalog`) so the field mapping — including the Gemma-style
 * external MTP draft facts — has a single source.
 */
function catalogRow(cr, builtIn) {
  return {
    id: cr.id,
    name: strOr(cr, "name", ""),
    hf_repo: strOr(cr, "hf_repo", ""),
    quant: strOr(cr, "quant", ""),
    mmproj: get(cr, "mmproj"),
    total_params: strOr(cr, "total_params", ""),
    active_params: strOr(cr, "active_params", ""),
    mtp: truthy(pyOr(get(cr, "mtp"), false)),
    mtp_builtin: truthy(pyOr(get(cr, "mtp_builtin"), false)),
    type: strOr(cr, "type", "dense"),
    mtp_draft_repo: strOr(cr, "mtp_draft_repo", ""),
    mtp_draft_file: strOr(cr, "mtp_draft_file", ""),
    mtp_draft_quant: strOr(cr, "mtp_draft_quant", ""),
    trained_ctx: numOrNull(cr, "trained_ctx"),
    min_vram_mb: numOrNull(cr, "min_vram_mb"),
    min_ram_mb: numOrNull(cr, "min_ram_mb"),
    tier: strOr(cr, "tier", "mid"),
    license: strOr(cr, "license", ""),
    use_limited: useLimited(strOr(cr, "license", "")),
    embedding: truthy(pyOr(get(cr, "embedding"), false)),
    pooling: strOr(cr, "pooling", ""),
    quality_rank: intOr(cr, "quality_rank", 100),
    description: strOr(cr, "description", ""),
    notes: strOr(cr, "notes", ""),
    architecture: strOr(cr, "architecture", ""),
    experts: intOr(cr, "experts", 0),
    size_label: strOr(cr, "size_label", ""),
    size_bytes: numOrNull(cr, "size_bytes"),
    est_vram_mb: numOrNull(cr, "est_vram_mb"),
    // Fit-redesign §13.11 — the physics facts (floors/est compute FRESH from these at read):
    block_count: intOr(cr, "block_count", 0),
    n_kv_heads: intOr(cr, "n_kv_heads", 0),
    head_count: intOr(cr, "head_count", 0),
    embedding_length: intOr(cr, "embedding_length", 0),
    expert_used_count: intOr(cr, "expert_used_count", 0),
    expert_byte_share: floatOr(cr, "expert_byte_share", 0.0),
    kv_windowed_bytes_per_token: floatOr(cr, "kv_windowed_bytes_per_token", 0.0),
    kv_global_bytes_per_token: floatOr(cr, "kv_global_bytes_per_token", 0.0),
    sliding_window: intOr(cr, "sliding_window", 0),
    exps_bytes: intOr(cr, "exps_bytes", 0),
    layers_nonexp_bytes: intOr(cr, "layers_nonexp_bytes", 0),
    output_bytes: intOr(cr, "output_bytes", 0),
    built_in: builtIn,
    position: intOr(cr, "position", 0),
  };
}

const SEED_FACT_KEYS = [
  "block_count",
  "n_kv_heads",
  "head_count",
  "embedding_length",
  "expert_used_count",
  "expert_byte_share",
  "kv_windowed_bytes_per_token",
  "kv_global_bytes_per_token",
  "sliding_window",
];
// vram-truth plan 2026-09-19 §6.2 — the exact tensor bytes. Filled by their OWN gate in
// fillPhysicsFacts: rows that already carry the nine facts above must still gain these.
const SEED_BYTES_KEYS = ["exps_bytes", "layers_nonexp_bytes", "output_bytes"];

// The fill-empty touch-ups below work on an in-memory copy of the row (`row`, mutated like
// the ORM object Python mutated) and record what they set in `set`; the caller writes
// `set` as one UPDATE.
const assign = (row, set, k, v) => {
  row[k] = v;
  set[k] = v;
};

/**
 * Fill-empty touch-up for the §13.11 facts: an EXISTING DB gains them at the next boot
 * without a reset — but a header read that already wrote them (download/inspect: the file
 * truth) is never clobbered. The exact tensor bytes have their OWN gate — the nine-fact
 * gate returns early on every existing row, which would strand them.
 */
function fillPhysicsFacts(row, set, cr) {
  if (!row.layers_nonexp_bytes && truthy(get(cr, "layers_nonexp_bytes"))) {
    for (const k of SEED_BYTES_KEYS) if (get(cr, k) != null) assign(row, set, k, unwrap(cr[k]));
  }
  if (row.block_count) return;
  if (!truthy(get(cr, "block_count"))) return;
  for (const k of SEED_FACT_KEYS) if (get(cr, k) != null) assign(row, set, k, unwrap(cr[k]));
}

/**
 * Seed a NEW catalog row's recommended-sampler rows (the seed ships what the FILE says).
 * Written with built_in=false to be byte-identical with what the download-time identify
 * pass (`setDerived`) produces — seed == file, one shape. Only called when the catalog row
 * itself was just inserted, so a user's own sampler edits are never touched.
 */
function seedSamplers(h, modelId, samplers) {
  for (const [name, val] of Object.entries(samplers || {})) {
    const nm = strip(name || "");
    if (nm) h.insert("model_samplers", { model_id: modelId, param_name: nm, value: pyStrScalar(val), built_in: false });
  }
}

/**
 * Backfill the tier-C BORROWED drafter onto an existing row without a reset — a
 * Gemma-style model with no built-in MTP AND no own draft borrows the official base-family
 * assistant drafter. Empty-only: fire ONLY when the row currently ships no draft of its
 * own. `mtp` is set to the seed's enable value because a draftless row could not have had
 * mtp on to begin with — a newly-available capability, not an override.
 */
function fillInheritedDraft(row, set, cr) {
  if (row.mtp_draft_file || !truthy(get(cr, "mtp_draft_file"))) return;
  assign(row, set, "mtp_draft_repo", strOr(cr, "mtp_draft_repo", ""));
  assign(row, set, "mtp_draft_file", pyStrScalar(cr.mtp_draft_file));
  assign(row, set, "mtp_draft_quant", strOr(cr, "mtp_draft_quant", ""));
  assign(row, set, "mtp", truthy(pyOr(get(cr, "mtp"), false)));
}

/** The fill-empty-only touch-ups shared by both catalog seeders: an existing DB gets the
 * harvested size FACTS without a reset — auto-detected fields only, only when EMPTY. */
function fillSizeFacts(row, set, cr, sizeFirst) {
  const size = () => {
    if (row.size_bytes == null && get(cr, "size_bytes") != null) assign(row, set, "size_bytes", pyIntOf(cr.size_bytes));
  };
  if (sizeFirst) size();
  if (row.est_vram_mb == null && get(cr, "est_vram_mb") != null) assign(row, set, "est_vram_mb", pyIntOf(cr.est_vram_mb));
  if (!sizeFirst) size();
  if (!row.size_label && truthy(get(cr, "size_label"))) assign(row, set, "size_label", pyStrScalar(cr.size_label));
}

const writeSet = (h, id, set) => {
  if (Object.keys(set).length) h.update("model_catalog", set, { id });
};

export function seedDefaultCatalog(h) {
  const existing = new Map(h.all("select * from model_catalog", [], "model_catalog").map((r) => [r.id, r]));
  let added = 0;
  for (const cr of cfg.DEFAULT_CATALOG) {
    const found = existing.get(cr.id);
    if (found) {
      // Fill-empty-only touch-up (#12b, 2026-07-08): a value written at download time
      // (the real local file) or by a fresh inspect always wins; user-editable fields are
      // never touched here.
      const row = { ...found };
      const set = {};
      fillSizeFacts(row, set, cr, true);
      fillInheritedDraft(row, set, cr);
      fillPhysicsFacts(row, set, cr);
      // Known-stale heal (QC-43a): swap an exact historically-seeded wrong value for the
      // current seed fact; anything else is a user/inspect value and stays.
      for (const [[rid, field], stale] of cfg.STALE_SEED_VALUES) {
        if (rid === cr.id && stale.some((x) => pyEq(x, row[field] ?? null)) && truthy(get(cr, field))) {
          assign(row, set, field, unwrap(cr[field]));
        }
      }
      writeSet(h, cr.id, set);
      continue;
    }
    h.insert("model_catalog", catalogRow(cr, true));
    seedSamplers(h, cr.id, get(cr, "samplers"));
    added += 1;
  }
  return added;
}

/**
 * Per-APP extra model-catalog rows (host input via `installLlm`). Insert-if-missing by id
 * — a reset re-creates them, a user edit is never clobbered. Seeded `built_in=false`: they
 * are the app's seed data, not the shared stack's, so the catalog UI treats them as user
 * rows. An existing row gets the fill-empty touch-ups (2026-07-13), mirroring
 * seedDefaultCatalog.
 */
export function seedExtraCatalog(h, rows) {
  const existing = new Map(h.all("select * from model_catalog", [], "model_catalog").map((r) => [r.id, r]));
  let added = 0;
  for (const cr of rows || []) {
    const found = existing.get(cr.id);
    if (found) {
      const row = { ...found };
      const set = {};
      fillSizeFacts(row, set, cr, false);
      fillInheritedDraft(row, set, cr);
      fillPhysicsFacts(row, set, cr);
      writeSet(h, cr.id, set);
      continue;
    }
    h.insert("model_catalog", catalogRow(cr, false));
    seedSamplers(h, cr.id, get(cr, "samplers"));
    added += 1;
  }
  return added;
}

/**
 * Per-APP tune seed for THIS machine (host input via `installLlm`): entries =
 * [{model_id, flags: {flag_name: value}}], keyed under the CURRENT box's `hwKey`. Strictly
 * insert-if-missing per (model, hw, flag), so a user's Quick-tune Save is NEVER clobbered
 * — this only re-creates the app's known-good starting tune after a dev-DB reset.
 */
export function seedModelTunesIfMissing(h, hwKey, entries) {
  if (!hwKey) return 0;
  const existing = new Set(
    h.all("select model_id, flag_name from model_tunes where hw_key = ?", [hwKey]).map((r) => `${r.model_id}\u0000${r.flag_name}`),
  );
  let added = 0;
  for (const e of entries || []) {
    const mid = get(e, "model_id") || "";
    for (const [fname, fval] of Object.entries(get(e, "flags") || {})) {
      if (!mid || existing.has(`${mid}\u0000${fname}`)) continue;
      h.insert("model_tunes", { model_id: mid, hw_key: hwKey, flag_name: fname, flag_value: pyStrScalar(fval) });
      added += 1;
    }
  }
  return added;
}

/** Seed the cloud pricing table from DEFAULT_PRICING (merge-by-id — never clobber edits). */
export function seedDefaultPricing(h) {
  const existing = new Set(h.all("select model_id from model_pricing").map((r) => r.model_id));
  let added = 0;
  for (const [mid, [inp, out]] of Object.entries(DEFAULT_PRICING)) {
    if (existing.has(mid)) continue;
    h.insert("model_pricing", { model_id: mid, input_per_m: Number(inp), output_per_m: Number(out) });
    added += 1;
  }
  return added;
}

/**
 * Seed the per-model embedding task templates — the (empty) shared set plus the APP's
 * registered `embed_templates`. Merge-by-id — never clobber user edits.
 */
export function seedDefaultEmbedTemplates(h) {
  const existing = new Set(h.all("select model_id from model_embed_templates").map((r) => r.model_id));
  let added = 0;
  for (const t of [...DEFAULT_EMBED_TEMPLATES, ...(cfg._APP.embed_templates || [])]) {
    if (existing.has(t.id)) continue;
    h.insert("model_embed_templates", {
      model_id: t.id,
      document_template: pyStrScalar(pyOr(get(t, "document"), "")),
      query_template: pyStrScalar(pyOr(get(t, "query"), "")),
      built_in: true,
    });
    added += 1;
  }
  return added;
}

/** Seed the capability/type switch presets (base + moe + the gated mtp) + their flag rows
 * — each parent before its FK children. */
export function seedDefaultSwitchPresets(h) {
  const existing = new Set(h.all("select id from switch_presets").map((r) => r.id));
  let added = 0;
  for (const p of DEFAULT_SWITCH_PRESETS) {
    if (existing.has(p.id)) continue;
    h.insert("switch_presets", {
      id: p.id,
      label: strOr(p, "label", ""),
      applies_to: strOr(p, "applies_to", "all"),
      position: intOr(p, "position", 0),
      built_in: true,
    });
    for (const [fname, fval] of Object.entries(get(p, "switches") || {})) {
      h.insert("preset_switches", { preset_id: p.id, flag_name: fname, flag_value: pyStrScalar(fval), built_in: true });
    }
    added += 1;
  }
  return added;
}

/**
 * Seed the host's built-in engine presets (the factory preset library — request params +
 * samplers only, NO launch switches) + their FK sampler children. Insert-if-missing, with
 * one refresh: a built-in row whose name still equals the app's recorded OLD default
 * (`name_was`) is renamed to the current seed name — so a factory rename reaches existing
 * DBs while a user who renamed the built-in keeps their name.
 */
export function seedDefaultEnginePresets(h) {
  const existing = new Map(h.all("select * from engine_presets", [], "engine_presets").map((r) => [r.id, r]));
  let added = 0;
  for (const p of appEnginePresets()) {
    const row = existing.get(p.id);
    if (row) {
      const was = strOr(p, "name_was", "");
      if (row.built_in && was && row.name === was) h.update("engine_presets", { name: strOr(p, "name", "") }, { id: p.id });
      continue;
    }
    h.insert("engine_presets", {
      id: p.id,
      name: strOr(p, "name", ""),
      provider_id: strOr(p, "provider_id", ""),
      model: strOr(p, "model", ""),
      temperature: numOrNull(p, "temperature"),
      top_p: numOrNull(p, "top_p"),
      max_tokens: intOr(p, "max_tokens", 0),
      reasoning_effort: strOr(p, "reasoning_effort", ""),
      think: truthy(pyOr(get(p, "think"), false)),
      position: intOr(p, "position", 0),
      built_in: true,
    });
    for (const [pname, pval] of Object.entries(get(p, "samplers") || {})) {
      h.insert("engine_preset_samplers", { preset_id: p.id, param_name: pname, value: pyStrScalar(pval) });
    }
    added += 1;
  }
  return added;
}

/**
 * Seed the built-in per-ACTION preset refs (`feature_preset_refs`) + the global
 * `default_preset_id`. Merge-by-key, fill-if-missing: a user's re-point of an action
 * survives a reseed. FK-safe: skip a ref whose preset_id isn't a known engine preset
 * (seeded above or already in the DB).
 */
export function seedDefaultFeaturePresets(h) {
  const existing = new Set(h.all('select "key" from feature_preset_refs').map((r) => r.key));
  const valid = new Set([...appEnginePresets().map((p) => p.id), ...h.all("select id from engine_presets").map((r) => r.id)]);
  let added = 0;
  for (const [action, presetId] of Object.entries(appFeaturePresets())) {
    if (existing.has(action) || !valid.has(presetId)) continue;
    h.insert("feature_preset_refs", { key: action, preset_id: presetId });
    added += 1;
  }
  // The catch-all default preset — fill-if-empty (a user's default is never clobbered).
  const want = appDefaultPresetId();
  if (want && valid.has(want)) {
    const row = h.get("runner_setting", "default_preset_id");
    if (!row) h.insert("runner_setting", { key: "default_preset_id", value: want, built_in: true });
    else if (!strip(row.value || "")) h.update("runner_setting", { value: want }, { key: "default_preset_id" });
  }
  return added;
}

/**
 * Restore the built-in engine presets to factory: delete the seeded (built_in) presets +
 * their FK children, then re-seed. CUSTOM presets are untouched.
 */
export function restoreBuiltInEnginePresets(h) {
  const ids = h.all("select id from engine_presets where built_in is 1").map((r) => r.id);
  stores._deleteEnginePresetRows(h, ids);
  seedDefaultEnginePresets(h);
}

/**
 * Restore the preset routing to factory (the Presets page 'Reset all'): clear the
 * per-action refs + the global default, RESTORE the built-in engine presets, then re-seed
 * the app's factory refs + default. CUSTOM presets are KEPT; only the built-ins +
 * assignments snap back to defaults.
 */
export function resetRoutingToFactory() {
  const h = db.session();
  h.tx(() => {
    h.run("delete from feature_preset_refs"); // clear the per-action assignments
    if (h.get("runner_setting", "default_preset_id")) {
      h.update("runner_setting", { value: "" }, { key: "default_preset_id" }); // re-seeded below
    }
    restoreBuiltInEnginePresets(h); // delete → re-seed (custom kept)
    seedDefaultFeaturePresets(h); // factory action→preset refs + the default (FK-safe)
  });
}

/**
 * Reset ONE built-in engine preset to its factory config (name + params + samplers),
 * keeping its per-action assignments. A CUSTOM preset (not in the app's built-in library)
 * has no factory to reset to → ValueError (the API maps it to 400).
 */
export function resetPresetToFactory(presetId) {
  const factory = new Map(appEnginePresets().map((p) => [p.id, p]));
  if (!factory.has(presetId)) throw new ValueError(`${pyReprStr(presetId)} is not a built-in preset`);
  const p = factory.get(presetId);
  const h = db.session();
  h.tx(() => {
    const row = h.get("engine_presets", presetId);
    if (!row || !row.built_in) throw new ValueError(`${pyReprStr(presetId)} is not a built-in preset`);
    h.update(
      "engine_presets",
      {
        name: strOr(p, "name", ""),
        provider_id: strOr(p, "provider_id", ""),
        model: strOr(p, "model", ""),
        temperature: numOrNull(p, "temperature"),
        top_p: numOrNull(p, "top_p"),
        max_tokens: intOr(p, "max_tokens", 0),
        reasoning_effort: strOr(p, "reasoning_effort", ""),
        think: truthy(pyOr(get(p, "think"), false)),
      },
      { id: presetId },
    );
    h.delete("engine_preset_samplers", { preset_id: presetId });
    for (const [pname, pval] of Object.entries(get(p, "samplers") || {})) {
      h.insert("engine_preset_samplers", { preset_id: presetId, param_name: pname, value: pyStrScalar(pval) });
    }
  });
}

/**
 * RETIRED built-ins are PRUNED (user, 2026-07-07: the cpu rows left DEFAULT_BINARIES — a
 * CPU-only box can't run local LLMs at usable speed): a built_in row whose (platform, gpu)
 * no longer exists in the defaults is removed at seed time, so existing DBs converge on
 * boot; user-ADDED rows (built_in=false) are never touched.
 */
export function seedDefaultRunnerBinaries(h) {
  const bins = rconfig.DEFAULT_BINARIES;
  const wanted = new Set(bins.map((b) => `${b.platform}\u0000${b.gpu}`));
  // Python queued these deletes and the inserts below in ONE flush, which runs a table's
  // INSERTs before its DELETEs — so the retired rows go last, and a new row's rowid is the
  // same as Python's.
  const retired = h
    .all("select platform, gpu from runner_binary where built_in is 1")
    .filter((r) => !wanted.has(`${r.platform}\u0000${r.gpu}`));
  const existing = new Set(h.all("select platform, gpu from runner_binary").map((r) => `${r.platform}\u0000${r.gpu}`));
  let added = 0;
  bins.forEach((b, i) => {
    if (existing.has(`${b.platform}\u0000${b.gpu}`)) return;
    h.insert("runner_binary", {
      platform: b.platform,
      gpu: b.gpu,
      source: strOr(b, "source", "github"),
      asset_url: get(b, "asset_url"),
      runtime_url: get(b, "runtime_url"),
      image: get(b, "image"),
      sha256: get(b, "sha256"),
      server_exe: strOr(b, "server_exe", "llama-server"),
      built_in: true,
      position: i,
    });
    added += 1;
  });
  for (const r of retired) h.delete("runner_binary", { platform: r.platform, gpu: r.gpu });
  return added;
}

export function seedDefaultRunnerSettings(h) {
  const existing = new Set(h.all('select "key" from runner_setting').map((r) => r.key));
  let added = 0;
  for (const r of DEFAULT_RUNNER_SETTINGS) {
    if (existing.has(r.key)) continue;
    h.insert("runner_setting", { key: r.key, value: strOr(r, "value", ""), built_in: true });
    added += 1;
  }
  return added;
}

/**
 * Seed the online-provider model-list ruleset (#8) as ONE JSON document in the
 * runner_setting store. Seed-REFRESH convention (keyed on `built_in`): a MISSING row is
 * seeded built_in=true; an UNMODIFIED row (still built_in — never PUT by a user) is
 * refreshed to the current seed whenever it drifts from it; a USER-edited row
 * (built_in=false) is NEVER clobbered. Returns 1 when a new row was added.
 */
export function seedModelListRules(h) {
  const want = modelListRules.seedDoc();
  const row = h.get("runner_setting", "model_list_rules");
  if (!row) {
    h.insert("runner_setting", { key: "model_list_rules", value: pyJson(want, { sortKeys: true }), built_in: true });
    return 1;
  }
  if (row.built_in) {
    let cur;
    try {
      cur = JSON.parse(row.value);
    } catch {
      cur = null;
    }
    if (!pyEq(cur, want)) {
      // unmodified but stale (old seed) → refresh in place
      h.update("runner_setting", { value: pyJson(want, { sortKeys: true }) }, { key: "model_list_rules" });
    }
  }
  return 0;
}

/**
 * Seed knob_catalog + its enum options (knob_option), each parent before its FK children.
 *
 * The catalog is APP-OWNED, read-only data (GET /v1/ai/knob-catalog is its only endpoint),
 * so built-in rows SYNC to DEFAULT_KNOBS on every boot: kind/default_value/help/plane/
 * applies_to/tier/position refresh from the seed, built-in rows dropped from the seed are
 * DELETED (their option rows go by the FK's ON DELETE CASCADE — only when the host runs
 * with foreign keys ON, as in Python), and built-in OPTION rows sync in BOTH directions —
 * ones the seed no longer carries are deleted and newly-seeded ones are INSERTED (the
 * 2026-07-25 audit: a sync that only deletes is not a sync).
 */
export function seedDefaultKnobs(h) {
  const existing = new Map(h.all("select * from knob_catalog", [], "knob_catalog").map((r) => [r.flag_name, r]));
  const seededNames = new Set(DEFAULT_KNOBS.map((k) => k.flag_name));
  let added = 0;
  // Python's deletes waited for its next flush (the one after a new knob's insert, else the
  // commit), and a flush runs INSERTs before DELETEs — so deletes queue here and run at
  // those same points, keeping every new row's rowid the same as Python's.
  const pending = [];
  const flush = () => {
    for (const [table, key] of pending.splice(0)) h.delete(table, key);
  };
  for (const [name, row] of existing) {
    if (row.built_in && !seededNames.has(name)) pending.push(["knob_catalog", { flag_name: name }]);
  }
  DEFAULT_KNOBS.forEach((k, i) => {
    const row = existing.get(k.flag_name);
    const fields = {
      kind: strOr(k, "kind", "string"),
      default_value: strOr(k, "default_value", ""),
      help: strOr(k, "help", ""),
      plane: intOr(k, "plane", 1),
      applies_to: strOr(k, "applies_to", "all"),
      tier: strOr(k, "tier", "common"),
      per_request: truthy(pyOr(get(k, "per_request"), false)),
      backends: strOr(k, "backends", ""), // Pass 2: backend applicability
      fit_relevant: truthy(pyOr(get(k, "fit_relevant"), false)), // Phase 5 fingerprint set
      position: i,
    };
    const options = get(k, "options") || [];
    if (row) {
      if (row.built_in) {
        h.update("knob_catalog", fields, { flag_name: k.flag_name });
        // Option SYNC — BOTH halves: stale built-in options are deleted AND newly-seeded
        // ones are INSERTED. A user's own option rows (built_in=false) are never deleted
        // and block no insert dedupe.
        const seededOpts = new Set(options.map((o) => pyStrScalar(o.value)));
        const have = new Set();
        for (const opt of h.all("select * from knob_option where flag_name = ?", [k.flag_name], "knob_option")) {
          if (opt.built_in && !seededOpts.has(opt.value)) pending.push(["knob_option", { flag_name: k.flag_name, value: opt.value }]);
          else have.add(opt.value);
        }
        options.forEach((o, j) => {
          if (have.has(pyStrScalar(o.value))) return;
          h.insert("knob_option", {
            flag_name: k.flag_name,
            value: pyStrScalar(o.value),
            label: pyStrScalar(pyOr(get(o, "label"), o.value)),
            position: j,
            built_in: true,
          });
        });
      }
      return;
    }
    h.insert("knob_catalog", { flag_name: k.flag_name, ...fields, built_in: true });
    flush(); // Python's s.flush() — parent in the DB before its FK children
    options.forEach((o, j) => {
      h.insert("knob_option", {
        flag_name: k.flag_name,
        value: pyStrScalar(o.value),
        label: pyStrScalar(pyOr(get(o, "label"), o.value)),
        position: j,
        built_in: true,
      });
    });
    added += 1;
  });
  flush(); // the rest went at Python's next flush; nothing after this touches these tables
  return added;
}

/**
 * Seed the live routing row (id='active') if missing — with NO choices made (user
 * decision 2026-07-06: "no model is automatically set as default, honestly not even embed
 * should be set, this is all quick setup or manual"). Idempotent (fresh installs only — an
 * existing user's routing is never touched).
 */
export function seedDefaultRouting(h) {
  if (h.get("routing_configs", "active")) return false;
  h.insert("routing_configs", {
    id: "active",
    is_active: true,
    position: 0,
    default_llm_id: "",
    default_embedding_id: "",
    default_embedding_model: "",
  });
  return true;
}

/**
 * Seed the host's registered feature prompts (per-app data; merge by key).
 * Insert-if-missing, plus the registered stale-heals: when the host lists a key's OLD
 * seed system texts and the existing row's system byte-equals one of them, the row is
 * refreshed from the CURRENT spec — a user-edited prompt (text ≠ any old seed) is never
 * touched.
 */
export function seedDefaultFeaturePrompts(h) {
  const existing = new Set(h.all('select "key" from feature_prompts').map((r) => r.key));
  const prompts = appFeaturePrompts();
  const heals = cfg._APP.feature_prompt_heals || {};
  for (const [key, oldTexts] of Object.entries(heals)) {
    const spec = Object.hasOwn(prompts, key) ? prompts[key] : null;
    if (!truthy(spec) || !existing.has(key)) continue;
    const row = h.get("feature_prompts", key);
    if (!row || !oldTexts.includes(row.system)) continue;
    // Refresh ONLY the fields a seed revision carries (system + its schema mirror) — a
    // user who edited user_template while keeping the seed system must not lose that edit.
    h.update("feature_prompts", { system: strOr(spec, "system", ""), json_schema: strOr(spec, "json_schema", "") }, { key });
  }
  // Nav-metadata backfill (parity batch 2026-08-06): a seed revision may ADD label/
  // description to a row that predates them. Fill ONLY when the stored pair is entirely
  // empty — a row anyone named keeps its name.
  for (const [key, spec] of Object.entries(prompts)) {
    if (!existing.has(key) || !(truthy(get(spec, "label")) || truthy(get(spec, "description")))) continue;
    const row = h.get("feature_prompts", key);
    if (row && row.built_in && !row.label && !row.description) {
      h.update("feature_prompts", { label: strOr(spec, "label", ""), description: strOr(spec, "description", "") }, { key });
    }
  }
  let added = 0;
  for (const [key, spec] of Object.entries(prompts)) {
    if (existing.has(key)) continue;
    h.insert("feature_prompts", {
      key,
      feature: strOr(spec, "feature", key),
      system: strOr(spec, "system", ""),
      user_template: strOr(spec, "user_template", ""),
      built_in: true,
      json_mode: truthy(Object.hasOwn(spec, "json_mode") ? spec.json_mode : false),
      json_schema: strOr(spec, "json_schema", ""),
      label: strOr(spec, "label", ""),
      description: strOr(spec, "description", ""),
      subgroup: strOr(spec, "group", ""),
      position: intOr(spec, "position", 0),
    });
    added += 1;
  }
  return added;
}

/** Run every LLM seeder in one transaction (Python's commit). Uses the shared handle when
 * none is given. */
export function seedLlm(h = null) {
  h = h || db.session();
  const app = cfg._APP;
  h.tx(() => {
    seedDefaultProviders(h);
    seedDefaultReasoningMap(h); // after providers exist
    seedDefaultRouting(h);
    seedDefaultCatalog(h); // empty by design (decision ④) — kept for the mechanism
    seedDefaultPricing(h);
    seedDefaultSwitchPresets(h);
    seedDefaultEnginePresets(h);
    seedDefaultFeaturePresets(h);
    seedDefaultRunnerBinaries(h);
    seedDefaultRunnerSettings(h);
    seedModelListRules(h);
    seedDefaultKnobs(h);
    seedDefaultHardwareClasses(h); // before class-tunes: the config's class must exist
    seedDefaultClassTunes(h);
    seedDefaultEmbedTemplates(h);
    seedDefaultFeaturePrompts(h);
    // The registered per-app extras (see configureAppSeed) — insert-if-missing, so user
    // edits / Quick-tune saves are never clobbered by a reseed.
    if (truthy(app.model_catalog_extra)) seedExtraCatalog(h, app.model_catalog_extra);
    if (truthy(app.model_tunes_seed) && app.hw_key_fn) seedModelTunesIfMissing(h, app.hw_key_fn(), app.model_tunes_seed);
    // The store owns the one fill-if-empty implementation.
    if (truthy(app.test_samples)) stores.getTestSampleStore().seedFill(h, app.test_samples);
    // LAST, because it needs the whole catalog — defaults AND the host's extras: bind
    // measured class tunes to the id THIS app gave the same GGUF, and say so when a tune
    // can bind to nothing…
    linkClassTunesToCatalog(h);
    // …then drop seed residue that can never apply. User rows are built_in=false.
    retireOrphanBuiltinClassTunes(h);
  });
}
