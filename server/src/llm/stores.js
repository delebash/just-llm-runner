// SPDX-License-Identifier: MIT
// The concrete LLM stores — ONE shared implementation of every store over the shared
// database (`db.session()`); the port of llm/stores.py. An app installs the shared LLM
// stack and gets these — it does not implement storage.
//
// Each method is one short synchronous call (a multi-statement change runs in one
// `tx`, as the Python store committed once per call). Rows go out in the wire shape —
// camelCase, exactly the fields the Python store's pydantic model carried, in its order.
// `resetToFactory` restores factory rows for shipped keys and preserves user-added rows.
//
// Port notes (binding for callers):
//   - Python keyword-only parameters (after `*`) are an options object here
//     (`setDerived(id, {modelType, …})`, `record(id, {machineKey, …})`); positional-or-
//     keyword ones stay positional.
//   - Every SELECT keeps SQLAlchemy's ORDER BY — and has none where Python had none
//     (SQLite then answers in rowid order, as it did for Python).
//   - After a write the Python store read the row back (expire_on_commit); so do these.
//   - TEXT columns are always written as strings (`pyStrScalar`): better-sqlite3 binds every
//     JS number as REAL, so an integer 5 would land as '5.0' where Python stores '5'.

import { randomUUID } from "node:crypto";
import { model } from "../platform/models.js";
import { pyFloat, pyIntOf, pyJson, pyStrScalar, unwrap } from "../platform/pyjson.js";
import { pyFloatParse, pyInt, pyOr, pySorted, pyStr, strip, truthy, ValueError } from "../platform/py.js";
import * as rconfig from "../runner/config.js";
import { RunnerConfig } from "../runner/schema.js";
import * as db from "./db.js";
import * as identity from "./identity.js";
import { CatalogRow } from "./model_catalog_api.js";
import * as modelListRules from "./model_list_rules.js";
import { EnginePresetRow } from "./presets_api.js";
import { REASONING_LEVELS, ReasoningLevelRow, seedRowsForType } from "./reasoning_map_api.js";
import { RoutingConfig } from "./routing_api.js";
import { LLMProviderConfig } from "./schema.js";
import * as seed from "./seed.js";
import { SwitchPresetRow } from "./switch_presets_api.js";
import * as switchResolve from "./switch_resolve.js";

const ACTIVE_ID = "active";

// ── Python value helpers ─────────────────────────────────────────────────────
// (Host seed data marks Python floats as PyFloat. `v or d` is platform/py.js's pyOr, Python
// truthiness its truthy, `float(v)` its pyFloatParse (a PyFloat reads as its number there);
// `int(v)` is platform/pyjson.js's pyIntOf and `str(v)` for a TEXT column its pyStrScalar.)

/** Python's `==` on plain data (dicts, lists, numbers, strings, None). */
export function pyEq(a, b) {
  a = unwrap(a);
  b = unwrap(b);
  if (a === b) return true;
  if (typeof a === "boolean" || typeof b === "boolean") return Number(a) === Number(b) && typeof a !== "string" && typeof b !== "string";
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => pyEq(x, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    return ka.every((k) => Object.hasOwn(b, k) && pyEq(a[k], b[k]));
  }
  return false;
}

const newHex12 = () => randomUUID().replaceAll("-", "").slice(0, 12);
const inList = (ids) => ids.map(() => "?").join(", ");

// ── providers ────────────────────────────────────────────────────────────────
const providerToConfig = (r) => ({
  id: r.id,
  name: r.name,
  providerType: r.provider_type,
  baseUrl: r.base_url,
  apiKey: r.api_key || null,
  defaultModel: r.default_model,
  embeddingModel: r.embedding_model,
  timeoutSeconds: r.timeout_seconds,
  local: r.local,
  extra: {},
});

const providerColumns = (cfg) => ({
  name: cfg.name,
  provider_type: cfg.providerType,
  base_url: cfg.baseUrl,
  api_key: cfg.apiKey || null,
  default_model: cfg.defaultModel,
  embedding_model: cfg.embeddingModel,
  timeout_seconds: cfg.timeoutSeconds,
  local: cfg.local,
});

export class ProviderStore {
  list() {
    return db
      .session()
      .all("select * from llm_providers order by position", [], "llm_providers")
      .map(providerToConfig);
  }

  get(providerId) {
    const row = db.session().get("llm_providers", providerId);
    return row ? providerToConfig(row) : null;
  }

  add(cfg) {
    cfg = model(LLMProviderConfig, cfg);
    const h = db.session();
    h.tx(() => {
      h.insert("llm_providers", {
        id: cfg.id,
        kind: "llm",
        built_in: false,
        position: h.count("llm_providers"),
        ...providerColumns(cfg),
      });
    });
    // U2-T2: fill the new provider's reasoning-map rows from its type (fill-if-missing).
    reasoningMap.seedMissing(cfg.id, seedRowsForType(cfg.providerType));
  }

  replace(providerId, cfg) {
    cfg = model(LLMProviderConfig, cfg);
    const h = db.session();
    if (!h.get("llm_providers", providerId)) return;
    h.update("llm_providers", providerColumns(cfg), { id: providerId }); // id/built_in/kind/position immutable on edit
    // U2-T2: a type change adds any missing reasoning-map rows for the new type
    // (fill-if-missing — existing rows + user edits untouched).
    const ptype = h.get("llm_providers", providerId).provider_type;
    if (ptype) reasoningMap.seedMissing(providerId, seedRowsForType(ptype));
  }

  remove(providerId) {
    const h = db.session();
    h.tx(() => {
      if (!h.get("llm_providers", providerId)) return;
      // Cascade the provider's reasoning-map rows (no FK on reasoning_map): a retype via
      // delete+re-add would otherwise inherit the old type's rows (fill-if-missing never
      // overwrites them) and mis-map thinking.
      h.delete("reasoning_map", { provider_id: providerId });
      h.delete("llm_providers", { id: providerId });
    });
  }
}

// ── routing (the global default) ─────────────────────────────────────────────
const rowToRouting = (r) => ({
  default: {
    llmId: r.default_llm_id,
    model: r.default_model,
    embeddingId: r.default_embedding_id,
    embeddingModel: r.default_embedding_model,
  },
});

export class RoutingStore {
  getRouting() {
    const row = db.session().get("routing_configs", ACTIVE_ID);
    return row ? rowToRouting(row) : model(RoutingConfig, {});
  }

  setRouting(cfg) {
    cfg = model(RoutingConfig, cfg);
    const h = db.session();
    // The default LLM + embedding are the whole routing config — the per-feature pins
    // were removed 2026-07-15 (presets are the one source).
    const vals = {
      default_llm_id: cfg.default.llmId,
      default_model: cfg.default.model,
      default_embedding_id: cfg.default.embeddingId,
      default_embedding_model: cfg.default.embeddingModel,
    };
    h.tx(() => {
      if (h.get("routing_configs", ACTIVE_ID)) h.update("routing_configs", vals, { id: ACTIVE_ID });
      else h.insert("routing_configs", { id: ACTIVE_ID, is_active: true, position: 0, ...vals });
    });
  }
}

// ── feature prompts (DB-seeded, Lab-editable) ────────────────────────────────
// FeaturePromptRow (prompts.js) is Python's dataclass — snake field names.
const promptToRow = (r) => ({
  key: r.key,
  feature: r.feature,
  system: r.system,
  user_template: r.user_template,
  built_in: r.built_in,
  json_mode: r.json_mode,
  json_schema: r.json_schema,
  label: r.label,
  description: r.description,
  group: r.subgroup,
});

export class PromptStore {
  get(key) {
    const row = db.session().get("feature_prompts", key);
    return row ? promptToRow(row) : null;
  }

  list() {
    return db
      .session()
      .all('select * from feature_prompts order by position, "key"', [], "feature_prompts")
      .map(promptToRow);
  }

  upsert(row) {
    const h = db.session();
    const vals = {
      feature: row.feature,
      system: row.system,
      user_template: row.user_template,
      json_mode: row.json_mode ?? false,
      json_schema: row.json_schema ?? "",
      label: row.label ?? "",
      description: row.description ?? "",
      subgroup: row.group ?? "",
    };
    h.tx(() => {
      if (!h.get("feature_prompts", row.key)) h.insert("feature_prompts", { key: row.key, built_in: row.built_in, ...vals });
      else h.update("feature_prompts", vals, { key: row.key });
    });
  }
}

// ── model catalog ────────────────────────────────────────────────────────────
const PHYSICS_FACT_KEYS = [
  "block_count",
  "n_kv_heads",
  "head_count",
  "embedding_length",
  "expert_used_count",
  "expert_byte_share",
  "kv_windowed_bytes_per_token",
  "kv_global_bytes_per_token",
  "sliding_window",
  "exps_bytes",
  "layers_nonexp_bytes",
  "output_bytes",
];

const rowFacts = (r) => Object.fromEntries(PHYSICS_FACT_KEYS.map((k) => [k, r[k] || 0]));

/**
 * [floor_ctx_tokens, ram_headroom_mb] — the two floor-rule seeded facts (fit-redesign
 * §8.21/§13.13), read from runner_setting with the config defaults as fallback.
 */
function floorCfgFromSettings(h) {
  const get = (key, dflt) => {
    const row = h.get("runner_setting", key);
    try {
      return row && strip(pyStr(row.value)) ? pyInt(row.value) : dflt;
    } catch (e) {
      if (e instanceof ValueError) return dflt;
      throw e;
    }
  };
  return [get("floor_ctx_tokens", rconfig.DEFAULT_FLOOR_CTX_TOKENS), get("ram_headroom_mb", rconfig.DEFAULT_RAM_HEADROOM_MB)];
}

/**
 * A catalog row → CatalogRow. COMPUTED-FRESH NUMBERS (fit-redesign §13.11): a CHAT row
 * whose physics facts were read gets its floors + est computed from them at read time —
 * the stored columns stop being consulted. EMBED rows keep their CURATED floors (§8.6 —
 * deliberate wizard-steering values `embed_placement` gates on). Rows with no facts
 * (manifest-only, never inspected) fall back to the stored values.
 */
function catalogToWire(r, samplers = null, floorCfg = null) {
  let minVram = r.min_vram_mb;
  let minRam = r.min_ram_mb;
  let est = r.est_vram_mb;
  const facts = rowFacts(r);
  if (!r.embedding && facts.block_count) {
    const [floorCtx, headroom] = floorCfg || [4096, 4096];
    const [cVram, cRam, cEst] = identity.computedRowNumbers(facts, r.size_bytes, r.trained_ctx, {
      floorCtx,
      ramHeadroomMb: headroom,
    });
    if (cVram != null) {
      minVram = cVram;
      minRam = cRam;
      est = cEst;
    }
  }
  const present = Object.fromEntries(Object.entries(facts).filter(([, v]) => v));
  return {
    id: r.id,
    name: r.name,
    hfRepo: r.hf_repo,
    quant: r.quant,
    mmproj: r.mmproj,
    totalParams: r.total_params,
    activeParams: r.active_params,
    mtp: r.mtp,
    mtpBuiltin: r.mtp_builtin,
    type: r.type,
    mtpDraftRepo: r.mtp_draft_repo,
    mtpDraftFile: r.mtp_draft_file,
    mtpDraftQuant: r.mtp_draft_quant,
    trainedCtx: r.trained_ctx,
    samplers: { ...(samplers || {}) },
    minVramMb: minVram,
    minRamMb: minRam,
    tier: r.tier,
    license: r.license,
    useLimited: r.use_limited,
    embedding: r.embedding,
    pooling: r.pooling,
    qualityRank: r.quality_rank,
    description: r.description,
    notes: r.notes,
    architecture: r.architecture,
    experts: r.experts,
    sizeLabel: r.size_label,
    sizeBytes: r.size_bytes,
    estVramMb: est,
    physicsFacts: Object.keys(present).length ? present : null,
    position: r.position,
    builtIn: r.built_in,
  };
}

const samplersOf = (h, modelId) =>
  Object.fromEntries(
    h.all("select param_name, value from model_samplers where model_id = ?", [modelId]).map((s) => [s.param_name, s.value]),
  );

export class ModelCatalogStore {
  list() {
    const h = db.session();
    const byModel = new Map();
    for (const sp of h.all("select * from model_samplers order by model_id, param_name", [], "model_samplers")) {
      if (!byModel.has(sp.model_id)) byModel.set(sp.model_id, {});
      byModel.get(sp.model_id)[sp.param_name] = sp.value;
    }
    const floorCfg = floorCfgFromSettings(h);
    return h
      .all("select * from model_catalog order by position, id", [], "model_catalog")
      .map((r) => catalogToWire(r, byModel.get(r.id), floorCfg));
  }

  /** Returns the stored row's wire form — computed with the DEFAULT floor config
   * (4096, 4096), not the settings rows: Python's upsert passed no floor_cfg. */
  upsert(row) {
    row = model(CatalogRow, row);
    const h = db.session();
    const vals = {
      name: row.name,
      hf_repo: row.hfRepo,
      quant: row.quant,
      mmproj: row.mmproj,
      total_params: row.totalParams,
      active_params: row.activeParams,
      mtp: row.mtp,
      mtp_builtin: !!row.mtpBuiltin, // header truth round-trips read-only through the form
      type: row.type || "dense",
      mtp_draft_repo: row.mtpDraftRepo || "",
      mtp_draft_file: row.mtpDraftFile || "",
      mtp_draft_quant: row.mtpDraftQuant || "",
      trained_ctx: row.trainedCtx,
      min_vram_mb: row.minVramMb,
      min_ram_mb: row.minRamMb,
      tier: row.tier || "mid",
      license: row.license || "",
      use_limited: !!row.useLimited,
      embedding: !!row.embedding,
      pooling: row.pooling || "",
      quality_rank: row.qualityRank,
      description: row.description || "",
      notes: row.notes || "",
      architecture: row.architecture || "",
      experts: pyInt(row.experts || 0),
      size_label: row.sizeLabel || "",
      size_bytes: row.sizeBytes,
      est_vram_mb: row.estVramMb,
    };
    // The physics facts ride the PUT when the form has read them (inspect fills
    // e.physicsFacts; absent/null = leave as stored).
    if (truthy(row.physicsFacts)) {
      for (const k of PHYSICS_FACT_KEYS) if (Object.hasOwn(row.physicsFacts, k)) vals[k] = unwrap(row.physicsFacts[k]);
    }
    vals.position = row.position;
    vals.built_in = false;
    return h.tx(() => {
      if (h.get("model_catalog", row.id)) h.update("model_catalog", vals, { id: row.id });
      else h.insert("model_catalog", { id: row.id, ...vals });
      return catalogToWire(h.get("model_catalog", row.id), samplersOf(h, row.id));
    });
  }

  delete(modelId) {
    const h = db.session();
    h.tx(() => {
      if (!h.get("model_catalog", modelId)) return;
      h.delete("model_samplers", { model_id: modelId });
      h.delete("model_catalog", { id: modelId });
    });
  }

  resetToFactory() {
    const h = db.session();
    h.tx(() => {
      for (const cid of new Set(seed.cfg.DEFAULT_CATALOG.map((c) => c.id))) {
        h.delete("model_samplers", { model_id: cid });
        h.delete("model_catalog", { id: cid });
      }
      seed.seedDefaultCatalog(h);
    });
  }

  /**
   * Set ONLY the capability `type` (moe|dense) on a catalog row — for GGUF identity
   * auto-detect. Preserves every other field incl. `built_in` (unlike `upsert`, which
   * marks the row user-edited). Returns true if it changed.
   */
  setType(modelId, modelType) {
    const h = db.session();
    const existing = h.get("model_catalog", modelId);
    if (!existing || existing.type === modelType) return false;
    h.update("model_catalog", { type: modelType }, { id: modelId });
    return true;
  }

  /**
   * Set the FILE-DERIVED catalog fields (`type`/`mtp_builtin`/`trained_ctx`, and
   * `total_params` when the file gives one) AND replace the per-model recommended sampler
   * rows, from a GGUF header read. Writes `mtp_builtin` (the header `nextn_predict_layers>0`
   * truth), NEVER the user-facing `mtp` ENABLE flag — a Gemma external-draft model reads
   * mtp_builtin=false yet stays MTP-enabled via its draft. `totalParams` is written only
   * when not null — a MoE expert-label ("128x9.4B") does NOT decompose, so the curated
   * value is preserved. The identity facts write only when given (null = leave as is;
   * sizeBytes is the QUANT-SPECIFIC file size). Preserves every other field incl.
   * `built_in` AND the user's `notes`. The sampler set is always REPLACED with the given
   * map (empty clears it). Returns true if a scalar value changed; false when the model
   * row is absent.
   */
  setDerived(
    modelId,
    {
      modelType,
      mtpBuiltin,
      trainedCtx,
      totalParams = null,
      samplers = null,
      architecture = null,
      experts = null,
      sizeLabel = null,
      sizeBytes = null,
      estVramMb = null,
      physicsFacts = null,
    },
  ) {
    trainedCtx ??= null;
    const h = db.session();
    return h.tx(() => {
      const ex = h.get("model_catalog", modelId);
      if (!ex) return false;
      const changed =
        ex.type !== modelType ||
        !!ex.mtp_builtin !== !!mtpBuiltin ||
        ex.trained_ctx !== trainedCtx ||
        (totalParams != null && ex.total_params !== totalParams) ||
        (architecture != null && ex.architecture !== architecture) ||
        (experts != null && ex.experts !== experts) ||
        (sizeLabel != null && ex.size_label !== sizeLabel) ||
        (sizeBytes != null && ex.size_bytes !== sizeBytes) ||
        (estVramMb != null && ex.est_vram_mb !== estVramMb);
      const vals = { type: modelType || "dense", mtp_builtin: !!mtpBuiltin, trained_ctx: trainedCtx };
      if (totalParams != null) vals.total_params = totalParams;
      if (architecture != null) vals.architecture = architecture;
      if (experts != null) vals.experts = pyInt(experts);
      if (sizeLabel != null) vals.size_label = sizeLabel;
      if (sizeBytes != null) vals.size_bytes = pyInt(sizeBytes);
      if (estVramMb != null) vals.est_vram_mb = pyInt(estVramMb);
      if (truthy(physicsFacts)) {
        // §13.11: the facts are file truths — a header read replaces them wholesale (same
        // motion as size_bytes; never fill-when-blank).
        for (const k of PHYSICS_FACT_KEYS) if (Object.hasOwn(physicsFacts, k)) vals[k] = unwrap(physicsFacts[k]);
      }
      h.update("model_catalog", vals, { id: modelId });
      h.delete("model_samplers", { model_id: modelId });
      for (const [name, val] of Object.entries(samplers || {})) {
        const nm = strip(name || "");
        if (nm) h.insert("model_samplers", { model_id: modelId, param_name: nm, value: pyStrScalar(val), built_in: false });
      }
      return changed;
    });
  }
}

// ── capability/type switch presets (base/moe/mtp) ────────────────────────────
const switchPresetToWire = (p, switches) => ({
  id: p.id,
  label: p.label,
  appliesTo: p.applies_to,
  position: p.position,
  builtIn: p.built_in,
  switches: switches.map((s) => ({ flagName: s.flag_name, flagValue: s.flag_value })),
});

export class SwitchPresetStore {
  list() {
    const h = db.session();
    const presets = h.all("select * from switch_presets order by position, id", [], "switch_presets");
    const byPreset = new Map();
    for (const r of h.all("select * from preset_switches order by flag_name", [], "preset_switches")) {
      if (!byPreset.has(r.preset_id)) byPreset.set(r.preset_id, []);
      byPreset.get(r.preset_id).push(r);
    }
    return presets.map((p) => switchPresetToWire(p, byPreset.get(p.id) || []));
  }

  /** Returns the row AS GIVEN (Python returned its input model, not a re-read). */
  upsert(row) {
    row = model(SwitchPresetRow, row);
    const h = db.session();
    const vals = { label: row.label, applies_to: row.appliesTo || "all", position: row.position, built_in: false };
    h.tx(() => {
      if (h.get("switch_presets", row.id)) h.update("switch_presets", vals, { id: row.id });
      else h.insert("switch_presets", { id: row.id, ...vals }); // parent row before its FK children
      h.delete("preset_switches", { preset_id: row.id });
      for (const sw of row.switches) {
        const fn = strip(sw.flagName || "");
        if (fn) h.insert("preset_switches", { preset_id: row.id, flag_name: fn, flag_value: sw.flagValue || "", built_in: false });
      }
    });
    return row;
  }

  delete(presetId) {
    const h = db.session();
    h.tx(() => {
      h.delete("preset_switches", { preset_id: presetId });
      h.delete("switch_presets", { id: presetId });
    });
  }

  resetToFactory() {
    const h = db.session();
    h.tx(() => {
      for (const p of seed.DEFAULT_SWITCH_PRESETS) {
        h.delete("preset_switches", { preset_id: p.id });
        h.delete("switch_presets", { id: p.id });
      }
      seed.seedDefaultSwitchPresets(h);
    });
  }
}

// ── engine presets (model + per-request params + samplers — NO launch switches; those
// are owned by the model × machine tune stack in `switch_resolve`). Assigned per-ACTION
// via `feature_preset_refs`, with the `default_preset_id` runner setting as the global
// default. ──
const enginePresetToWire = (p, samplers) => ({
  id: p.id,
  name: p.name,
  providerId: p.provider_id,
  model: p.model,
  temperature: p.temperature,
  topP: p.top_p,
  maxTokens: p.max_tokens,
  reasoningEffort: p.reasoning_effort,
  think: p.think,
  samplers: samplers.map((x) => ({ flagName: x.param_name, flagValue: x.value })),
  builtIn: p.built_in,
  position: p.position,
  factoryModel: "",
});

/**
 * Delete engine presets + their FK children (samplers) explicitly, on the given handle.
 * Host-agnostic — does NOT rely on SQLite ON DELETE CASCADE (the runner's own reset path
 * runs with FK enforcement off). ONE teardown path, shared by EnginePresetStore.delete +
 * seed.restoreBuiltInEnginePresets. Also drops any per-feature OVERRIDE
 * (`feature_preset_refs`) pointing at a deleted preset so the feature falls to the default
 * preset rather than stranding on a dangling id.
 */
export function _deleteEnginePresetRows(h, ids) {
  ids = ids.filter((i) => i);
  if (!ids.length) return;
  h.run(`delete from engine_preset_samplers where preset_id in (${inList(ids)})`, ids);
  h.run(`delete from feature_preset_refs where preset_id in (${inList(ids)})`, ids);
  h.run(`delete from engine_presets where id in (${inList(ids)})`, ids);
}

export class EnginePresetStore {
  list() {
    const h = db.session();
    const sm = new Map();
    for (const r of h.all("select * from engine_preset_samplers", [], "engine_preset_samplers")) {
      if (!sm.has(r.preset_id)) sm.set(r.preset_id, []);
      sm.get(r.preset_id).push(r);
    }
    return h
      .all("select * from engine_presets order by position, id", [], "engine_presets")
      .map((p) =>
        enginePresetToWire(
          p,
          pySorted(sm.get(p.id) || [], (x) => x.param_name),
        ),
      );
  }

  /** Python set the id on (and returned) the given model; this returns the filled row
   * and also sets `id` on the object passed in. */
  save(preset) {
    const p = model(EnginePresetRow, preset);
    const h = db.session();
    const pid = p.id || newHex12();
    h.tx(() => {
      const vals = {
        name: p.name,
        provider_id: p.providerId,
        model: p.model,
        temperature: p.temperature,
        top_p: p.topP,
        max_tokens: p.maxTokens,
        reasoning_effort: p.reasoningEffort,
        think: p.think,
      };
      if (h.get("engine_presets", pid)) h.update("engine_presets", vals, { id: pid });
      else h.insert("engine_presets", { id: pid, position: h.count("engine_presets"), ...vals });
      h.delete("engine_preset_samplers", { preset_id: pid });
      for (const x of p.samplers) {
        if (!strip(x.flagName || "")) continue;
        h.insert("engine_preset_samplers", { preset_id: pid, param_name: strip(x.flagName), value: x.flagValue || "" });
      }
    });
    p.id = pid;
    if (preset && typeof preset === "object") preset.id = pid;
    return p;
  }

  delete(presetId) {
    const h = db.session();
    h.tx(() => _deleteEnginePresetRows(h, [presetId])); // children + parent (host-agnostic)
  }
}

/**
 * The per-ACTION preset assignment store (`feature_preset_refs`) — THE one source of what
 * an action runs. Keyed by ACTION id; "" clears the row so the action falls to the global
 * default preset.
 */
export class FeaturePresetRefStore {
  /** {actionKey: presetId}, in row order. */
  list() {
    return Object.fromEntries(db.session().all("select * from feature_preset_refs").map((r) => [r.key, r.preset_id]));
  }

  set(featureKey, presetId) {
    const h = db.session();
    h.tx(() => {
      const row = h.get("feature_preset_refs", featureKey);
      if (!presetId) {
        if (row) h.delete("feature_preset_refs", { key: featureKey });
      } else if (!row) h.insert("feature_preset_refs", { key: featureKey, preset_id: presetId });
      else h.update("feature_preset_refs", { preset_id: presetId }, { key: featureKey });
    });
  }
}

// ── cloud pricing (the usage-ledger cost source) ─────────────────────────────
const pricingToWire = (r) => ({ modelId: r.model_id, inputPerM: r.input_per_m, outputPerM: r.output_per_m });

export class PricingStore {
  list() {
    return db
      .session()
      .all("select * from model_pricing order by model_id", [], "model_pricing")
      .map(pricingToWire);
  }

  /** {modelId(lowercased): [inputPerM, outputPerM]} */
  asMap() {
    const out = {};
    for (const r of db.session().all("select * from model_pricing", [], "model_pricing")) {
      out[r.model_id.toLowerCase()] = [r.input_per_m, r.output_per_m];
    }
    return out;
  }

  upsert(row) {
    const h = db.session();
    const mid = (row.modelId || "").trim().toLowerCase();
    const vals = { input_per_m: Number(row.inputPerM || 0.0), output_per_m: Number(row.outputPerM || 0.0) };
    return h.tx(() => {
      if (h.get("model_pricing", mid)) h.update("model_pricing", vals, { model_id: mid });
      else h.insert("model_pricing", { model_id: mid, ...vals });
      return pricingToWire(h.get("model_pricing", mid));
    });
  }

  delete(modelId) {
    db.session().delete("model_pricing", { model_id: (modelId || "").trim().toLowerCase() });
  }
}

// ── the per-provider reasoning map ───────────────────────────────────────────
const reasoningMapToWire = (r) => ({ level: r.level, word: r.word, tokens: r.tokens });

/**
 * Per-provider reasoning level→value rows (U2-T2). Read by the resolver
 * (`llm/reasoning.js`) + the /v1/ai/reasoning-map CRUD; seeded per provider TYPE,
 * fill-if-missing per instance (never clobbers a user edit).
 */
export class ReasoningMapStore {
  static ORDER = new Map(REASONING_LEVELS.map((lvl, i) => [lvl, i]));

  forProvider(providerId) {
    const rows = db.session().all("select * from reasoning_map where provider_id = ?", [providerId], "reasoning_map");
    return pySorted(rows, (r) => ReasoningMapStore.ORDER.get(r.level) ?? 99).map(reasoningMapToWire);
  }

  /** level → row, for the resolver's lookup. */
  mapFor(providerId) {
    return Object.fromEntries(this.forProvider(providerId).map((r) => [r.level, r]));
  }

  upsert(providerId, row) {
    row = model(ReasoningLevelRow, row);
    const h = db.session();
    const key = { provider_id: providerId, level: row.level };
    const vals = { word: row.word || "", tokens: row.tokens };
    h.tx(() => {
      if (h.get("reasoning_map", key)) h.update("reasoning_map", vals, key);
      else h.insert("reasoning_map", { ...key, ...vals });
    });
  }

  /** Fill-if-missing: insert a (provider, level) row only when absent — never clobber a
   * user edit. Called at seed + on provider create. */
  seedMissing(providerId, rows) {
    const h = db.session();
    h.tx(() => {
      const have = new Set(h.all("select level from reasoning_map where provider_id = ?", [providerId]).map((r) => r.level));
      for (const row of rows) {
        if (have.has(row.level)) continue;
        h.insert("reasoning_map", {
          provider_id: providerId,
          level: row.level,
          word: row.word || "",
          tokens: row.tokens ?? null,
          built_in: true,
        });
      }
    });
  }
}

// ── embedding task templates ─────────────────────────────────────────────────
const embedTemplateToWire = (r) => ({
  modelId: r.model_id,
  documentTemplate: r.document_template,
  queryTemplate: r.query_template,
  builtIn: r.built_in,
});

/**
 * Per-model embedding task templates (the RAG build) — the model FACTS /v1/ai/embeddings
 * wraps inputs with. Seeded from the app's registered templates, editable via
 * /v1/ai/embed-templates; a model with no row passes through.
 */
export class EmbedTemplateStore {
  list() {
    return db
      .session()
      .all("select * from model_embed_templates order by model_id", [], "model_embed_templates")
      .map(embedTemplateToWire);
  }

  get(modelId) {
    const r = db.session().get("model_embed_templates", strip(modelId || ""));
    return r ? embedTemplateToWire(r) : null;
  }

  upsert(row) {
    const h = db.session();
    const mid = strip(row.modelId || "");
    const vals = {
      document_template: pyStrScalar(row.documentTemplate || ""),
      query_template: pyStrScalar(row.queryTemplate || ""),
    };
    return h.tx(() => {
      if (h.get("model_embed_templates", mid)) h.update("model_embed_templates", vals, { model_id: mid });
      else h.insert("model_embed_templates", { model_id: mid, ...vals });
      return embedTemplateToWire(h.get("model_embed_templates", mid));
    });
  }

  delete(modelId) {
    db.session().delete("model_embed_templates", { model_id: strip(modelId || "") });
  }
}

// ── the bundled llama.cpp engine config ──────────────────────────────────────
const runnerBinaryToRow = (b) => ({
  platform: b.platform,
  gpu: b.gpu,
  source: b.source,
  assetUrl: b.assetUrl,
  runtimeUrl: b.runtimeUrl,
  image: b.image,
  serverExe: b.serverExe,
});

const settingValue = (h, key) => h.get("runner_setting", key)?.value;

/**
 * The bundled llama.cpp engine config — binaries (download URLs) + pinned build + VRAM
 * margin. DB-backed + seeded, editable via /v1/ai/engine-config so a moved/renamed release
 * asset can be pasted-fixed with no code change. The runner reads the SAME rows live via
 * `buildRunnerConfig()`.
 */
export class RunnerConfigStore {
  getConfig() {
    const cfg = buildRunnerConfig();
    // update_policy + ack_hw_fingerprint are API-surface-only config — not part of the
    // runner's RunnerConfig; read the setting rows directly (absent → defaults).
    // ack_hw_fingerprint: the last "gpu-name|vramMb" the user's UI acknowledged — the
    // hardware-change toast fires once per change.
    const h = db.session();
    const policy = settingValue(h, "update_policy") || "notify";
    const ackFp = settingValue(h, "ack_hw_fingerprint") ?? "";
    const preferred = settingValue(h, "preferred_gpu") || "";
    const warm = (settingValue(h, "warm_default_on_startup") ?? "1") !== "0";
    // The RAM-headroom seeded fact rides the same panel — read via the ONE floor-config
    // reader.
    const [, ramHeadroom] = floorCfgFromSettings(h);
    return {
      pinnedBuild: cfg.llamacpp.pinnedBuild,
      safetyMarginMb: cfg.safetyMarginMb,
      ctxCapTokens: cfg.ctxCapTokens,
      bandFastToks: cfg.bandFastToks,
      bandFineToks: cfg.bandFineToks,
      bandSlowToks: cfg.bandSlowToks,
      bandDeadzoneFrac: cfg.bandDeadzoneFrac,
      speedFloorGrace: cfg.speedFloorGrace,
      calibModelUrl: cfg.calibModelUrl,
      calibModelSha256: cfg.calibModelSha256,
      calibModelSizeBytes: cfg.calibModelSizeBytes,
      calibActiveExpertMb: cfg.calibActiveExpertMb,
      calibNonexpertMb: cfg.calibNonexpertMb,
      ramHeadroomMb: ramHeadroom,
      modelsMax: cfg.modelsMax,
      sleepIdleSeconds: cfg.sleepIdleSeconds,
      downloadSegmentsEnabled: cfg.downloadSegmentsEnabled,
      downloadSegmentCount: cfg.downloadSegmentCount,
      downloadSegmentMinBytes: cfg.downloadSegmentMinBytes,
      downloadSegmentRetries: cfg.downloadSegmentRetries,
      downloadMaxConcurrent: cfg.downloadMaxConcurrent,
      updatePolicy: policy,
      ackHwFingerprint: ackFp,
      preferredGpu: preferred,
      classKeyOverride: getClassKeyOverride(),
      warmDefaultOnStartup: warm,
      binaries: cfg.llamacpp.binaries.map(runnerBinaryToRow),
    };
  }

  upsertBinary(row) {
    const h = db.session();
    const platform = strip(row.platform);
    const gpu = strip(row.gpu);
    const key = { platform, gpu };
    const vals = {
      source: strip(row.source || "github"),
      asset_url: row.assetUrl || null,
      runtime_url: row.runtimeUrl || null,
      image: row.image || null,
      server_exe: strip(row.serverExe || "llama-server"),
    };
    h.tx(() => {
      if (h.get("runner_binary", key)) {
        h.update("runner_binary", vals, key);
        return;
      }
      const positions = h.all("select position from runner_binary").map((r) => r.position);
      const position = (positions.length ? Math.max(...positions) : 0) + 1;
      h.insert("runner_binary", { ...key, position, ...vals });
    });
  }

  /**
   * The engine + model cache root the user CHOSE, or "" for this app's own
   * `<data_dir>/ai-cache`. Read at wiring time (installLlm), not at load time: moving a
   * cache under a running engine is not a thing, so a change takes effect on the next
   * start and nothing on disk is ever relocated for you.
   */
  getCacheRoot() {
    return settingValue(db.session(), "cache_root") || "";
  }

  /**
   * Whether a cache choice was ever saved. `getCacheRoot` answers "" both for "my own
   * cache" chosen and for nothing chosen yet (a fresh or reset database); only the second
   * lets startup adopt a sibling's cache (2026-10-06).
   */
  cacheRootChosen() {
    return db.session().get("runner_setting", "cache_root") != null;
  }

  /** Point this app at a cache root ("" = back to its own). Records the CHOICE only — no
   * files move, so the previous cache stays exactly where it is. */
  setCacheRoot(root) {
    this.setSetting("cache_root", strip(root || ""));
  }

  setSetting(key, value) {
    const h = db.session();
    const v = pyStrScalar(value);
    h.tx(() => {
      if (h.get("runner_setting", key)) h.update("runner_setting", { value: v }, { key });
      else h.insert("runner_setting", { key, value: v });
    });
  }

  /**
   * Restore the shipped binary rows (corrected URLs) + the scalar settings (pinned build,
   * VRAM margin, the router residency knobs, …) to their seed defaults; user-added custom
   * rows are preserved.
   */
  resetToDefaults() {
    const c = rconfig;
    const h = db.session();
    h.tx(() => {
      for (const b of c.DEFAULT_BINARIES) h.delete("runner_binary", { platform: b.platform, gpu: b.gpu });
      seed.seedDefaultRunnerBinaries(h);
      const pairs = [
        ["pinned_build", c.DEFAULT_PINNED_BUILD],
        ["safety_margin_mb", String(c.DEFAULT_SAFETY_MARGIN_MB)],
        ["ctx_cap_tokens", String(c.DEFAULT_CTX_CAP_TOKENS)],
        ["band_fast_toks", pyFloat(c.DEFAULT_BAND_FAST_TOKS)],
        ["band_fine_toks", pyFloat(c.DEFAULT_BAND_FINE_TOKS)],
        ["band_slow_toks", pyFloat(c.DEFAULT_BAND_SLOW_TOKS)],
        ["band_deadzone_frac", pyFloat(c.DEFAULT_BAND_DEADZONE_FRAC)],
        ["speed_floor_grace", pyFloat(c.DEFAULT_SPEED_FLOOR_GRACE)],
        ["calib_model_url", c.DEFAULT_CALIB_MODEL_URL],
        ["calib_model_sha256", c.DEFAULT_CALIB_MODEL_SHA256],
        ["calib_model_size_bytes", String(c.DEFAULT_CALIB_MODEL_SIZE_BYTES)],
        ["calib_active_expert_mb", pyFloat(c.DEFAULT_CALIB_ACTIVE_EXPERT_MB)],
        ["calib_nonexpert_mb", pyFloat(c.DEFAULT_CALIB_NONEXPERT_MB)],
        ["bw_eff_device", pyFloat(c.DEFAULT_BW_EFF_DEVICE)],
        ["bw_eff_host", pyFloat(c.DEFAULT_BW_EFF_HOST)],
        ["bw_eff_host_probe", pyFloat(c.DEFAULT_BW_EFF_HOST_PROBE)],
        ["ram_headroom_mb", String(c.DEFAULT_RAM_HEADROOM_MB)],
        ["models_max", String(c.DEFAULT_MODELS_MAX)],
        ["sleep_idle_seconds", String(c.DEFAULT_SLEEP_IDLE_SECONDS)],
        ["preferred_gpu", ""],
        ["class_key_override", ""],
        ["download_segments_enabled", c.DEFAULT_DOWNLOAD_SEGMENTS_ENABLED ? "1" : "0"],
        ["download_segment_count", String(c.DEFAULT_DOWNLOAD_SEGMENT_COUNT)],
        ["download_segment_min_bytes", String(c.DEFAULT_DOWNLOAD_SEGMENT_MIN_BYTES)],
        ["download_segment_retries", String(c.DEFAULT_DOWNLOAD_SEGMENT_RETRIES)],
        ["download_max_concurrent", String(c.DEFAULT_DOWNLOAD_MAX_CONCURRENT)],
        ["warm_default_on_startup", "1"],
      ];
      for (const [key, val] of pairs) {
        if (h.get("runner_setting", key)) h.update("runner_setting", { value: val }, { key });
        else h.insert("runner_setting", { key, value: val, built_in: true });
      }
    });
  }
}

// ── per-(model, machine) MEASURED tunes ──────────────────────────────────────
/**
 * The per-(model, machine) MEASURED tune rows (Plan B) — Quick tune's Save. Never seeded;
 * user data only. `replace` swaps the (model, hw) set wholesale (the verbatim-snapshot
 * semantics, D5); empty flag names are dropped.
 */
export class ModelTuneStore {
  get(modelId, hwKey) {
    // Only rows applicable under the ACTIVE backend show as "your applied config" — a
    // cuda-measured tune must not display (or apply) under vulkan/cpu. Legacy "" rows
    // read as cuda; unwired context → all rows. Same predicate the resolution layer uses.
    const act = switchResolve.activeBackend();
    return db
      .session()
      .all("select * from model_tunes where model_id = ? and hw_key = ? order by flag_name", [modelId, hwKey], "model_tunes")
      .filter((r) => switchResolve.tuneRowApplies(r.backend ?? "", act))
      .map((r) => ({ flagName: r.flag_name, flagValue: r.flag_value }));
  }

  /**
   * Swap the (model, machine) tune wholesale. `baseline` = the LAYER-resolved defaults
   * standing at apply time (§7.6 drift detection) — stored in the same transaction; null
   * clears any stored baseline (a caller that can't resolve one must not leave a stale one
   * behind).
   */
  replace(modelId, hwKey, rows, baseline = null) {
    const h = db.session();
    h.tx(() => {
      h.delete("model_tunes", { model_id: modelId, hw_key: hwKey });
      // Stamp the backend the tune was measured on, so resolution can refuse it under a
      // different engine family. Unwired context stamps "" (legacy: reads as cuda).
      const backend = switchResolve.activeBackend();
      const seen = new Set();
      for (const r of rows) {
        const name = strip(r.flagName || "");
        if (!name || seen.has(name)) continue;
        seen.add(name);
        h.insert("model_tunes", { model_id: modelId, hw_key: hwKey, flag_name: name, flag_value: r.flagValue || "", backend });
      }
      h.delete("model_tune_baselines", { model_id: modelId, hw_key: hwKey });
      for (const [name, value] of Object.entries(baseline || {})) {
        if (strip(name || "")) {
          h.insert("model_tune_baselines", {
            model_id: modelId,
            hw_key: hwKey,
            flag_name: strip(name),
            flag_value: pyStrScalar(pyOr(value, "")),
          });
        }
      }
    });
  }

  /** The layer baseline stored when this tune was applied — null when the tune predates
   * baseline tracking (no drift claim possible for it). */
  getBaseline(modelId, hwKey) {
    const rows = db.session().all("select * from model_tune_baselines where model_id = ? and hw_key = ?", [modelId, hwKey]);
    return rows.length ? Object.fromEntries(rows.map((r) => [r.flag_name, r.flag_value])) : null;
  }

  /** Every model tuned on THIS machine → its rows (the §7.6 badge state). */
  listForMachine(hwKey) {
    const out = {};
    for (const r of db.session().all("select * from model_tunes where hw_key = ? order by model_id, flag_name", [hwKey])) {
      (out[r.model_id] ??= []).push({ flagName: r.flag_name, flagValue: r.flag_value });
    }
    return out;
  }

  delete(modelId, hwKey) {
    const h = db.session();
    h.tx(() => {
      h.delete("model_tunes", { model_id: modelId, hw_key: hwKey });
      h.delete("model_tune_baselines", { model_id: modelId, hw_key: hwKey });
    });
  }
}

// ── per-(model, HARDWARE-CLASS) tunes + the named classes ───────────────────
/**
 * The seeded + editable per-(model, HARDWARE-CLASS) tune rows — the class-tune library
 * behind /v1/ai/class-tunes. Same verbatim-snapshot semantics as ModelTuneStore, but
 * LIBRARY-shaped: `listAll` returns every config grouped, `builtIn` = the whole group is
 * untouched seed rows. `replace` writes `built_in=false` — an edited config is the
 * user's (the boot seeder inserts a built-in config only when its (model, class) has NO
 * rows, so it never clobbers an edit; a fully deleted built-in config re-seeds on the
 * next start).
 */
export class ClassTuneStore {
  listAll() {
    const groups = new Map();
    for (const r of db
      .session()
      .all("select * from class_tunes order by model_id, class_key, flag_name", [], "class_tunes")) {
      const k = `${r.model_id}\u0000${r.class_key}`;
      if (!groups.has(k)) groups.set(k, { modelId: r.model_id, classKey: r.class_key, grp: [] });
      groups.get(k).grp.push(r);
    }
    return [...groups.values()].map(({ modelId, classKey, grp }) => ({
      modelId,
      classKey,
      builtIn: grp.every((r) => r.built_in),
      rows: grp.map((r) => ({ flagName: r.flag_name, flagValue: r.flag_value })),
    }));
  }

  replace(modelId, classKey, rows) {
    const h = db.session();
    h.tx(() => {
      h.delete("class_tunes", { model_id: modelId, class_key: classKey });
      const seen = new Set();
      for (const r of rows) {
        const name = strip(r.flagName || "");
        if (!name || seen.has(name)) continue;
        seen.add(name);
        h.insert("class_tunes", {
          model_id: modelId,
          class_key: classKey,
          flag_name: name,
          flag_value: r.flagValue || "",
          built_in: false,
        });
      }
    });
  }

  delete(modelId, classKey) {
    db.session().delete("class_tunes", { model_id: modelId, class_key: classKey });
  }
}

/**
 * The NAMED hardware-class sidecar — name + editable whole-GB VRAM/RAM per `class_key`.
 * The class_key stays the identity + join to `class_tunes`; this store owns only the label
 * + the integer fields the add/edit form binds to. The class_key is DERIVED from vram/ram
 * by the caller (the API) — this store takes it explicit.
 */
export class HardwareClassStore {
  listAll() {
    return db
      .session()
      .all("select * from hardware_classes order by mem_type, vram_gb, ram_gb, class_key", [], "hardware_classes")
      .map((r) => ({
        classKey: r.class_key,
        memType: r.mem_type || "discrete",
        vramGb: r.vram_gb,
        ramGb: r.ram_gb,
        name: r.name || "",
        builtIn: r.built_in,
        vramBwGbps: r.vram_bw_gbps || 0.0,
        ramBwGbps: r.ram_bw_gbps || 0.0,
      }));
  }

  /**
   * Upsert a class. One class per key: a duplicate `classKey` is rejected (ValueError)
   * UNLESS it is the row being edited (`origKey === classKey`). When the edit MOVED the
   * key (type/VRAM/RAM changed → a new class_key), the model-configs cascade onto the new
   * key and the old sidecar row is dropped. A user save takes ownership (`built_in=false`).
   * `vramBwGbps`/`ramBwGbps` null = the caller didn't send the field — keep stored.
   */
  save(classKey, memType, vramGb, ramGb, name, origKey = "", vramBwGbps = null, ramBwGbps = null) {
    const h = db.session();
    h.tx(() => {
      const orig = strip(origKey || "");
      if (h.get("hardware_classes", classKey) && orig !== classKey) {
        throw new ValueError(`a hardware class for ${classKey} already exists`);
      }
      const moved = orig && orig !== classKey;
      if (moved) h.update("class_tunes", { class_key: classKey }, { class_key: orig });
      const vals = {
        mem_type: memType,
        vram_gb: pyIntOf(vramGb),
        ram_gb: pyIntOf(ramGb),
        name: strip(name || ""),
        built_in: false,
      };
      if (vramBwGbps != null) vals.vram_bw_gbps = Math.max(0.0, pyFloatParse(vramBwGbps));
      if (ramBwGbps != null) vals.ram_bw_gbps = Math.max(0.0, pyFloatParse(ramBwGbps));
      if (h.get("hardware_classes", classKey)) h.update("hardware_classes", vals, { class_key: classKey });
      else h.insert("hardware_classes", { class_key: classKey, ...vals });
      // SQLAlchemy's flush ran the new row's INSERT before the old row's DELETE; kept in
      // that order so the new row's rowid is the same as Python's.
      if (moved) h.delete("hardware_classes", { class_key: orig });
    });
  }

  /**
   * Create a blank-named sidecar row for `classKey` if none exists — the Tune-modal 'Save
   * for hardware class' path saves a config for the box's class before any class form ran.
   * No-op when the class already exists (never clobbers a name). A created row gets the
   * class-typical bandwidth seeds (§5.5 source 3 — same values a seeded class carries).
   */
  ensure(classKey, memType, vramGb, ramGb) {
    const h = db.session();
    if (h.get("hardware_classes", classKey)) return;
    const [vramBw, ramBw] = seed._classBwSeed(memType, pyIntOf(vramGb));
    h.insert("hardware_classes", {
      class_key: classKey,
      mem_type: memType,
      vram_gb: pyIntOf(vramGb),
      ram_gb: pyIntOf(ramGb),
      name: "",
      built_in: false,
      vram_bw_gbps: vramBw,
      ram_bw_gbps: ramBw,
    });
  }

  /** [vram_bw_gbps, ram_bw_gbps] for one class — the runner's ladder source 3 read
   * (injected as `classBwFn`). [0, 0] when the class has no row or no numbers: the ladder
   * skips the source, never fabricates. */
  bwFor(classKey) {
    const row = db.session().get("hardware_classes", classKey);
    if (!row) return [0.0, 0.0];
    return [row.vram_bw_gbps || 0.0, row.ram_bw_gbps || 0.0];
  }

  /** Delete the class AND all its model-configs (a config is meaningless without its class). */
  delete(classKey) {
    const h = db.session();
    h.tx(() => {
      h.delete("class_tunes", { class_key: classKey });
      h.delete("hardware_classes", { class_key: classKey });
    });
  }
}

// ── Lab test samples ─────────────────────────────────────────────────────────
/**
 * Canned Lab test samples (§7.3): list by ACTION (or all); upsert/delete for editability;
 * `seedFill` inserts only where (action_key, label) is absent so edited/deleted-then-
 * reseeded rows behave like every other seeder. A host authors each blob ONCE and lists
 * its sibling ACTIONS (the fan-out below) — no copy-paste.
 */
export class TestSampleStore {
  varsFor(h, ids) {
    const out = new Map();
    if (ids.length) {
      for (const v of h.all(`select * from test_sample_vars where sample_id in (${inList(ids)})`, ids)) {
        if (!out.has(v.sample_id)) out.set(v.sample_id, {});
        out.get(v.sample_id)[v.name] = v.value;
      }
    }
    return out;
  }

  listForAction(action = "") {
    const h = db.session();
    const samples = action
      ? h.all("select * from test_samples where action_key = ? order by position, id", [action])
      : h.all("select * from test_samples order by position, id");
    const varsBy = this.varsFor(
      h,
      samples.map((x) => x.id),
    );
    return samples.map((x) => ({ id: x.id, action: x.action_key, label: x.label, variables: varsBy.get(x.id) || {} }));
  }

  upsert(action, label, variables, sampleId = null) {
    const h = db.session();
    return h.tx(() => {
      let id = sampleId ? h.get("test_samples", sampleId)?.id : undefined;
      if (id == null) {
        id = Number(h.insert("test_samples", { action_key: action, label }).lastInsertRowid);
      } else {
        h.update("test_samples", { action_key: action, label }, { id });
        h.delete("test_sample_vars", { sample_id: id });
      }
      for (const [name, value] of Object.entries(variables || {})) {
        const n = strip(name || "");
        if (n) h.insert("test_sample_vars", { sample_id: id, name: n, value: pyStrScalar(pyOr(value, "")) });
      }
      return id;
    });
  }

  delete(sampleId) {
    const h = db.session();
    h.tx(() => {
      h.delete("test_sample_vars", { sample_id: sampleId });
      h.delete("test_samples", { id: sampleId });
    });
  }

  /**
   * Insert missing (action_key, label) samples on the GIVEN handle. Each host row authors
   * ONE blob and fans it to its sibling actions: `actions` (a list) — or a single `action`
   * — names every action the blob seeds. Returns how many rows were added.
   */
  seedFill(h, rows) {
    let added = 0;
    let pos = 0;
    for (const r of rows || []) {
      const label = strip(r.label || "");
      const variables = r.variables || {};
      let actions = r.actions;
      if (actions == null) {
        const one = strip(r.action || "");
        actions = one ? [one] : [];
      }
      if (!label) continue;
      for (const action of actions) {
        const a = strip(action || "");
        if (!a) continue;
        if (h.one("select id from test_samples where action_key = ? and label = ? limit 1", [a, label])) continue;
        const id = Number(h.insert("test_samples", { action_key: a, label, position: pos }).lastInsertRowid);
        pos += 1;
        for (const [name, value] of Object.entries(variables)) {
          const n = strip(name || "");
          if (n) h.insert("test_sample_vars", { sample_id: id, name: n, value: pyStrScalar(pyOr(value, "")) });
        }
        added += 1;
      }
    }
    return added;
  }
}

// ── the measurement history ──────────────────────────────────────────────────
/**
 * The persistent measurement history (#142) — every real decode-speed result from the
 * Tune modal + the auto-tune sweep. Append-only (`record`), newest-first reads (`list`),
 * user-cleared (`clear`). Never seeded. The switches that produced a number are child
 * rows deleted explicitly with their parent (soft refs, the tune-family convention).
 */
export class ModelMeasurementStore {
  /** `backend` overrides the active LLM engine family for rows another engine measured
   * (a speech model on the CPU says "cpu"); null = the LLM's. */
  record(
    modelId,
    {
      machineKey,
      source,
      label,
      tokensPerSec,
      vramTotalMb,
      at,
      rows,
      vramModelMb = 0,
      kind = "llm",
      realtimeX = 0.0,
      backend = null,
    },
  ) {
    const h = db.session();
    return h.tx(() => {
      const id = Number(
        h.insert("model_measurements", {
          model_id: modelId,
          machine_key: machineKey || "",
          source: source || "tune",
          label: label || "",
          tokens_per_sec: pyFloatParse(pyOr(tokensPerSec, 0)),
          vram_total_mb: pyIntOf(pyOr(vramTotalMb, 0)),
          at: pyIntOf(pyOr(at, 0)),
          // Which engine family measured it (a caller may name its own).
          backend: backend == null ? switchResolve.activeBackend() : backend,
          vram_model_mb: pyIntOf(pyOr(vramModelMb, 0)), // Phase 5: the true-up footprint
          kind: kind || "llm",
          realtime_x: pyFloatParse(pyOr(realtimeX, 0)),
        }).lastInsertRowid,
      );
      const seen = new Set();
      for (const r of rows || []) {
        const name = strip(r.flagName || "");
        if (!name || seen.has(name)) continue;
        seen.add(name);
        h.insert("measurement_switches", { measurement_id: id, flag_name: name, flag_value: r.flagValue || "" });
      }
      return id;
    });
  }

  list(modelId = null) {
    const h = db.session();
    const ms = modelId
      ? h.all("select * from model_measurements where model_id = ? order by at desc, id desc", [modelId])
      : h.all("select * from model_measurements order by at desc, id desc");
    const ids = ms.map((m) => m.id);
    const flags = new Map();
    if (ids.length) {
      for (const f of h.all(
        `select * from measurement_switches where measurement_id in (${inList(ids)}) order by flag_name`,
        ids,
      )) {
        if (!flags.has(f.measurement_id)) flags.set(f.measurement_id, []);
        flags.get(f.measurement_id).push({ flagName: f.flag_name, flagValue: f.flag_value });
      }
    }
    return ms.map((m) => ({
      id: m.id,
      modelId: m.model_id,
      machineKey: m.machine_key,
      source: m.source,
      label: m.label,
      tokensPerSec: m.tokens_per_sec,
      vramTotalMb: m.vram_total_mb,
      at: m.at,
      backend: m.backend || "",
      vramModelMb: m.vram_model_mb || 0,
      kind: m.kind || "llm",
      realtimeX: Number(m.realtime_x || 0),
      switches: flags.get(m.id) || [],
    }));
  }

  clear(modelId = null) {
    const h = db.session();
    return h.tx(() => {
      const ids = (
        modelId ? h.all("select id from model_measurements where model_id = ?", [modelId]) : h.all("select id from model_measurements")
      ).map((m) => m.id);
      let n = 0;
      if (ids.length) {
        h.run(`delete from measurement_switches where measurement_id in (${inList(ids)})`, ids);
        n = h.run(`delete from model_measurements where id in (${inList(ids)})`, ids).changes;
      }
      return n;
    });
  }

  /**
   * §13.2 retention: keep-latest-`keep` rows of `source` per (model, machine, FINGERPRINT)
   * — the fingerprint being each row's fit-relevant switch subset (§13.3's classification,
   * read from knob_catalog, never a hardcoded list). Called by the load recorder right
   * after a record; without it, 'load' (and '__overhead__' probe) rows grow unboundedly.
   * Returns rows deleted.
   */
  pruneLoadRows(modelId, machineKey, fitRelevant, keep, source = "load") {
    const fr = fitRelevant instanceof Set ? fitRelevant : new Set(fitRelevant);
    const h = db.session();
    return h.tx(() => {
      const rows = h.all(
        "select * from model_measurements where model_id = ? and machine_key = ? and source = ? order by at desc, id desc",
        [modelId, machineKey || "", source || "load"],
      );
      if (rows.length <= keep) return 0;
      const ids = rows.map((m) => m.id);
      const flags = new Map();
      for (const f of h.all(`select * from measurement_switches where measurement_id in (${inList(ids)})`, ids)) {
        if (!flags.has(f.measurement_id)) flags.set(f.measurement_id, new Map());
        flags.get(f.measurement_id).set(f.flag_name, f.flag_value);
      }
      const perFp = new Map();
      const doomed = [];
      for (const m of rows) {
        // newest-first — the first `keep` of each fingerprint survive
        const pairs = [...(flags.get(m.id) || new Map())].filter(([k]) => fr.has(k));
        const fp = JSON.stringify(pySorted(pairs));
        perFp.set(fp, (perFp.get(fp) || 0) + 1);
        if (perFp.get(fp) > Math.max(1, keep)) doomed.push(m.id);
      }
      if (doomed.length) {
        h.run(`delete from measurement_switches where measurement_id in (${inList(doomed)})`, doomed);
        h.run(`delete from model_measurements where id in (${inList(doomed)})`, doomed);
      }
      return doomed.length;
    });
  }
}

// ── the singletons ───────────────────────────────────────────────────────────
const provider = new ProviderStore();
const routing = new RoutingStore();
const prompt = new PromptStore();
const modelCatalog = new ModelCatalogStore();
const pricing = new PricingStore();
const reasoningMap = new ReasoningMapStore();
const embedTemplate = new EmbedTemplateStore();
const runnerConfig = new RunnerConfigStore();
const switchPreset = new SwitchPresetStore();
const enginePreset = new EnginePresetStore();
const featurePresetRef = new FeaturePresetRefStore();
const modelTune = new ModelTuneStore();
const classTune = new ClassTuneStore();
const hardwareClass = new HardwareClassStore();
const testSample = new TestSampleStore();
const modelMeasurement = new ModelMeasurementStore();

export const getProviderStore = () => provider;
export const getRoutingStore = () => routing;
export const getPromptStore = () => prompt;
export const getModelCatalogStore = () => modelCatalog;
export const getPricingStore = () => pricing;
export const getReasoningMapStore = () => reasoningMap;
export const getEmbedTemplateStore = () => embedTemplate;
export const getRunnerConfigStore = () => runnerConfig;
export const getSwitchPresetStore = () => switchPreset;
export const getEnginePresetStore = () => enginePreset;
export const getFeaturePresetRefStore = () => featurePresetRef;
export const getModelTuneStore = () => modelTune;
export const getClassTuneStore = () => classTune;
export const getHardwareClassStore = () => hardwareClass;
export const getModelMeasurementStore = () => modelMeasurement;
export const getTestSampleStore = () => testSample;

// ── module functions ─────────────────────────────────────────────────────────
/**
 * The fingerprint SET (§13.3): flag names whose value changes a load's memory footprint —
 * read from knob_catalog's seeded `fit_relevant` column, never hardcoded. Injected into the
 * runner as `fitRelevantFlagsFn`.
 */
export function listFitRelevantFlags() {
  return new Set(db.session().all("select flag_name from knob_catalog where fit_relevant is 1").map((k) => k.flag_name));
}

/** The §13.2 retention K (runner_setting `load_rows_keep`, a seeded fact). */
export function loadRowsKeep() {
  const row = db.session().get("runner_setting", "load_rows_keep");
  try {
    return row && strip(pyStr(row.value)) ? Math.max(1, pyInt(row.value)) : rconfig.DEFAULT_LOAD_ROWS_KEEP;
  } catch (e) {
    if (e instanceof ValueError) return rconfig.DEFAULT_LOAD_ROWS_KEEP;
    throw e;
  }
}

// The global default engine preset — the one catch-all for an action with no ref. Stored
// as a runner_setting scalar (relocated 2026-07-15 from the deleted TaskKindPreset[""] row).
export function getDefaultPresetId() {
  const row = db.session().get("runner_setting", "default_preset_id");
  return row ? row.value : "";
}

export function setDefaultPresetId(presetId) {
  const h = db.session();
  h.tx(() => {
    if (h.get("runner_setting", "default_preset_id")) {
      h.update("runner_setting", { value: presetId || "" }, { key: "default_preset_id" });
    } else h.insert("runner_setting", { key: "default_preset_id", value: presetId || "", built_in: false });
  });
}

// The online-provider model-list ruleset (#8) — ONE JSON document in the same
// runner_setting store as `default_preset_id` (NOT a new table). `built_in` is the
// unmodified-signal: a seeded/reset doc is built_in=true (a seed bump refreshes it,
// seed.seedModelListRules); a user PUT flips it false so a reseed never clobbers it.

/** The stored rules document {seedVersion, rules}. Missing/corrupt → the factory seed (so
 * the endpoint + resolver always have a well-formed doc). */
export function getModelListRules() {
  const row = db.session().get("runner_setting", "model_list_rules");
  if (!row || !strip(row.value || "")) return modelListRules.seedDoc();
  let doc;
  try {
    doc = JSON.parse(row.value);
  } catch {
    return modelListRules.seedDoc();
  }
  return doc && typeof doc === "object" && !Array.isArray(doc) ? doc : modelListRules.seedDoc();
}

/** Persist a USER edit — marks the row built_in=false so a reseed never clobbers it. */
export function setModelListRules(doc) {
  const value = pyJson(truthy(doc) ? doc : {}, { sortKeys: true });
  const h = db.session();
  h.tx(() => {
    if (h.get("runner_setting", "model_list_rules")) {
      h.update("runner_setting", { value, built_in: false }, { key: "model_list_rules" });
    } else h.insert("runner_setting", { key: "model_list_rules", value, built_in: false });
  });
}

/** Snap the rules back to the shipped seed and re-arm seed-refresh (built_in=true). */
export function resetModelListRules() {
  const value = pyJson(modelListRules.seedDoc(), { sortKeys: true });
  const h = db.session();
  h.tx(() => {
    if (h.get("runner_setting", "model_list_rules")) {
      h.update("runner_setting", { value, built_in: true }, { key: "model_list_rules" });
    } else h.insert("runner_setting", { key: "model_list_rules", value, built_in: true });
  });
}

/**
 * The (model, class) pairs that HAVE a class config — served on the catalog response (one
 * fetch). The §9 ruled shape: the recommendation IS the visible class-config list ("the
 * config that matches your hardware names your model").
 */
export function listClassTuneRefs() {
  return db
    .session()
    .all("select distinct model_id, class_key from class_tunes")
    .map((r) => ({ modelId: r.model_id, classKey: r.class_key }));
}

/**
 * The user's class override ("" = auto-detect) — 'detection proposes, never dictates'
 * (user ruling 2026-07-22): a wrong sensor must cost one setting, not a dead subsystem.
 * Stored as an ordinary runner_setting row, the preferred_gpu precedent.
 */
export function getClassKeyOverride() {
  return settingValue(db.session(), "class_key_override") || "";
}

/** The knob catalog joined with its enum options, as plain camelCase objects — name →
 * friendly KnobGrid metadata. */
export function listKnobCatalog() {
  const h = db.session();
  const opts = new Map();
  for (const o of h.all("select * from knob_option order by flag_name, position", [], "knob_option")) {
    if (!opts.has(o.flag_name)) opts.set(o.flag_name, []);
    opts.get(o.flag_name).push({ value: o.value, label: o.label });
  }
  return h.all("select * from knob_catalog order by plane, position", [], "knob_catalog").map((k) => ({
    flagName: k.flag_name,
    kind: k.kind,
    default: k.default_value,
    help: k.help,
    plane: k.plane,
    appliesTo: k.applies_to,
    tier: k.tier,
    perRequest: k.per_request,
    backends: k.backends,
    options: opts.get(k.flag_name) || [],
  }));
}

/**
 * Backend applicability per knob (Pass 2, 2026-07-22): {flag_name: "cuda,rocm,…"} for
 * knobs that are NOT applicable everywhere ("" rows are omitted — absent = all). Injected
 * into the runner (`knobBackendsFn`) so its section construction can drop a flag the
 * ACTIVE engine family can't use; the llm/ package stays decoupled.
 */
export function listKnobBackends() {
  return Object.fromEntries(
    db
      .session()
      .all("select flag_name, backends from knob_catalog")
      .filter((k) => strip(k.backends || ""))
      .map((k) => [k.flag_name, k.backends]),
  );
}

/**
 * Build the bundled runner's RunnerConfig from the DB (runner_binary + runner_setting) —
 * the host-side replacement for the old runner-manifest.json. Wired into the runner
 * service as its `configFn` by installLlm. Falls back to the runner's seed defaults if the
 * binaries haven't been seeded yet.
 */
export function buildRunnerConfig() {
  const c = rconfig;
  const h = db.session();
  const bins = h.all("select * from runner_binary order by position, platform", [], "runner_binary").map((b) => ({
    platform: b.platform,
    gpu: b.gpu,
    source: b.source,
    assetUrl: b.asset_url,
    runtimeUrl: b.runtime_url,
    image: b.image,
    sha256: b.sha256,
    runtimeSha256: null, // given explicitly: model() appends a defaulted field after the given ones
    serverExe: b.server_exe,
  }));
  if (!bins.length) return c.defaultConfig(); // not seeded yet → the engine defaults
  const settings = new Map(h.all('select "key", value from runner_setting').map((r) => [r.key, r.value]));
  const get = (key) => settings.get(key);
  const int = (key, dflt) => {
    try {
      return pyInt(get(key) || dflt);
    } catch (e) {
      if (e instanceof ValueError) return dflt;
      throw e;
    }
  };
  const bool = (key, dflt) => {
    const raw = strip(get(key) || "").toLowerCase();
    if (["1", "true", "on", "yes"].includes(raw)) return true;
    if (["0", "false", "off", "no"].includes(raw)) return false;
    return dflt;
  };
  const float = (key, dflt) => {
    try {
      return pyFloatParse(get(key) || dflt);
    } catch (e) {
      if (e instanceof ValueError) return dflt;
      throw e;
    }
  };
  return model(RunnerConfig, {
    llamacpp: { pinnedBuild: get("pinned_build") || c.DEFAULT_PINNED_BUILD, binaries: bins },
    safetyMarginMb: int("safety_margin_mb", c.DEFAULT_SAFETY_MARGIN_MB),
    ctxCapTokens: int("ctx_cap_tokens", c.DEFAULT_CTX_CAP_TOKENS),
    bandFastToks: float("band_fast_toks", c.DEFAULT_BAND_FAST_TOKS),
    bandFineToks: float("band_fine_toks", c.DEFAULT_BAND_FINE_TOKS),
    bandSlowToks: float("band_slow_toks", c.DEFAULT_BAND_SLOW_TOKS),
    bandDeadzoneFrac: float("band_deadzone_frac", c.DEFAULT_BAND_DEADZONE_FRAC),
    speedFloorGrace: float("speed_floor_grace", c.DEFAULT_SPEED_FLOOR_GRACE),
    calibModelUrl: get("calib_model_url") || c.DEFAULT_CALIB_MODEL_URL,
    calibModelSha256: strip(get("calib_model_sha256") || c.DEFAULT_CALIB_MODEL_SHA256).toLowerCase(),
    calibModelSizeBytes: int("calib_model_size_bytes", c.DEFAULT_CALIB_MODEL_SIZE_BYTES),
    calibActiveExpertMb: float("calib_active_expert_mb", c.DEFAULT_CALIB_ACTIVE_EXPERT_MB),
    calibNonexpertMb: float("calib_nonexpert_mb", c.DEFAULT_CALIB_NONEXPERT_MB),
    bwEffDevice: float("bw_eff_device", c.DEFAULT_BW_EFF_DEVICE),
    bwEffHost: float("bw_eff_host", c.DEFAULT_BW_EFF_HOST),
    bwEffHostProbe: float("bw_eff_host_probe", c.DEFAULT_BW_EFF_HOST_PROBE),
    ramHeadroomMb: int("ram_headroom_mb", c.DEFAULT_RAM_HEADROOM_MB),
    modelsMax: int("models_max", c.DEFAULT_MODELS_MAX),
    sleepIdleSeconds: int("sleep_idle_seconds", c.DEFAULT_SLEEP_IDLE_SECONDS),
    preferredGpu: get("preferred_gpu") || "",
    downloadSegmentsEnabled: bool("download_segments_enabled", c.DEFAULT_DOWNLOAD_SEGMENTS_ENABLED),
    downloadSegmentCount: int("download_segment_count", c.DEFAULT_DOWNLOAD_SEGMENT_COUNT),
    downloadSegmentMinBytes: int("download_segment_min_bytes", c.DEFAULT_DOWNLOAD_SEGMENT_MIN_BYTES),
    downloadSegmentRetries: int("download_segment_retries", c.DEFAULT_DOWNLOAD_SEGMENT_RETRIES),
    downloadMaxConcurrent: int("download_max_concurrent", c.DEFAULT_DOWNLOAD_MAX_CONCURRENT),
  });
}
