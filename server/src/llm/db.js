// SPDX-License-Identifier: MIT
// Shared LLM storage — the single home for every LLM table (the port of
// llm_runner/llm/db.py). The tables are the DDL Python's create_all writes, captured in
// db_schema.js; the host owns the database handle (platform/sql.js) and hands it to
// `configureStorage`, and `installLlm` calls `createAll` + `configureStorage` for it.
// Every store reaches the database through `session()`.

import { TABLES } from "./db_schema.js";

export { TABLES };

// Additive column migrations: an existing database gains a column added after it was
// made, without a reset. `[table, column, "SQL type + default"]`, applied when missing.
// Additive only — kept identical to db.py's _ADDED_COLUMNS.
export const ADDED_COLUMNS = [
  ["model_catalog", "mtp_builtin", "BOOLEAN NOT NULL DEFAULT 0"],
  ["model_catalog", "est_vram_mb", "INTEGER"],
  ["model_catalog", "block_count", "INTEGER NOT NULL DEFAULT 0"],
  ["model_catalog", "n_kv_heads", "INTEGER NOT NULL DEFAULT 0"],
  ["model_catalog", "head_count", "INTEGER NOT NULL DEFAULT 0"],
  ["model_catalog", "embedding_length", "INTEGER NOT NULL DEFAULT 0"],
  ["model_catalog", "expert_used_count", "INTEGER NOT NULL DEFAULT 0"],
  ["model_catalog", "expert_byte_share", "REAL NOT NULL DEFAULT 0"],
  ["model_catalog", "kv_windowed_bytes_per_token", "REAL NOT NULL DEFAULT 0"],
  ["model_catalog", "kv_global_bytes_per_token", "REAL NOT NULL DEFAULT 0"],
  ["model_catalog", "sliding_window", "INTEGER NOT NULL DEFAULT 0"],
  ["model_catalog", "exps_bytes", "INTEGER NOT NULL DEFAULT 0"],
  ["model_catalog", "layers_nonexp_bytes", "INTEGER NOT NULL DEFAULT 0"],
  ["model_catalog", "output_bytes", "INTEGER NOT NULL DEFAULT 0"],
  ["hardware_classes", "vram_bw_gbps", "REAL NOT NULL DEFAULT 0"],
  ["hardware_classes", "ram_bw_gbps", "REAL NOT NULL DEFAULT 0"],
  ["engine_presets", "think", "BOOLEAN NOT NULL DEFAULT 0"],
  ["knob_catalog", "backends", "VARCHAR NOT NULL DEFAULT ''"],
  ["model_tunes", "backend", "VARCHAR NOT NULL DEFAULT ''"],
  ["model_measurements", "backend", "VARCHAR NOT NULL DEFAULT ''"],
  ["model_measurements", "vram_model_mb", "INTEGER NOT NULL DEFAULT 0"],
  ["model_measurements", "kind", "VARCHAR NOT NULL DEFAULT 'llm'"],
  ["model_measurements", "realtime_x", "REAL NOT NULL DEFAULT 0"],
  ["knob_catalog", "fit_relevant", "BOOLEAN NOT NULL DEFAULT 0"],
  ["feature_prompts", "position", "INTEGER NOT NULL DEFAULT 0"],
];

let handle = null;

/** The host hands its database handle (platform/sql.js `openDatabase`). */
export function configureStorage(h) {
  handle = h;
  if (h) h.register(TABLES);
}

/** The database every shared store uses. */
export function session() {
  if (!handle) throw new Error("LLM storage not configured — call configureStorage() during boot");
  return handle;
}

/** Is storage configured? (pricing's no-DB fallback asks.) */
export const isConfigured = () => handle !== null;

/** Create every LLM table that's missing, then the additive columns. */
export function createAll(h) {
  h.createTables(TABLES, ADDED_COLUMNS);
}
