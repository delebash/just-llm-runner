// SPDX-License-Identifier: MIT
// The family's database helper: better-sqlite3 (synchronous, one connection) with plain
// SQL, plus the two conversions SQLAlchemy did for us — DateTime and Boolean — and the
// Python-side column defaults, all driven by a column map captured from the Python
// models (scripts/capture-schema.py). Decided 2026-10-07 (plan §10 Q2/Q3, measured in
// §1.5): plain SQL over Drizzle, better-sqlite3 over node:sqlite.
//
// One connection, synchronous: a transaction (`tx`) must never span an `await` —
// better-sqlite3 refuses an async transaction function outright. Every store call is
// short and synchronous, as the Python stores' one-session-per-call was.

import Database from "better-sqlite3";

// SQLAlchemy stores DateTime as "YYYY-MM-DD HH:MM:SS.ffffff"; Python's isoformat() gives
// "YYYY-MM-DDTHH:MM:SS[.ffffff]", dropping the fraction when it is zero.
const STORED = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/;
export function dtFromDb(text) {
  if (text == null) return null;
  const m = STORED.exec(text);
  if (!m) return text;
  const f = (m[3] || "").padEnd(6, "0");
  return `${m[1]}T${m[2]}${f === "000000" ? "" : `.${f}`}`;
}

// An ISO string, naive or with an offset (or a Date). SQLAlchemy's SQLite DateTime drops
// the offset and keeps the wall-clock time, so this does too.
const ISO = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(?:Z|[+-]\d{2}:?\d{2})?$/;
export function dtToDb(v) {
  if (v == null) return null;
  if (v instanceof Date) v = v.toISOString();
  const m = ISO.exec(v);
  if (!m) throw new Error(`not a datetime: ${v}`);
  return `${m[1]} ${m[2]}.${(m[3] || "").padEnd(6, "0")}`;
}

/** Python's `datetime.now(timezone.utc).replace(tzinfo=None).isoformat()` — microseconds
 * from the millisecond clock (the last three digits are 000). */
export function utcNowIso() {
  const iso = new Date().toISOString(); // 2026-10-07T12:34:56.789Z
  return `${iso.slice(0, 23)}000`;
}

export const boolToDb = (v) => (v == null ? null : v ? 1 : 0);
export const boolFromDb = (v) => (v == null ? null : !!v);

/** A table list (the capture's TABLES) → {table: {column: spec}}. */
export function columnMap(tables) {
  const out = {};
  for (const t of tables) out[t.name] = t.columns || {};
  return out;
}

/**
 * Open a database. `foreignKeys` is the host's choice and has no default on purpose:
 * Python's sqlite3 leaves them OFF, better-sqlite3 turns them ON — each app decides
 * (plan §9 B10), so the call says which.
 */
export function openDatabase(file, { foreignKeys, readonly = false, timeoutMs = 5000 } = {}) {
  if (foreignKeys !== true && foreignKeys !== false) {
    throw new Error("openDatabase: say foreignKeys: true or false (plan §9 B10)");
  }
  const db = new Database(file, { readonly, timeout: timeoutMs });
  if (!readonly) db.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
  return wrap(db);
}

function wrap(db) {
  const cols = {};
  const stmts = new Map();
  const prep = (sql) => {
    let s = stmts.get(sql);
    if (!s) {
      s = db.prepare(sql);
      stmts.set(sql, s);
    }
    return s;
  };
  const params = (p) => (p === undefined ? [] : p);

  const fromRow = (table, row) => {
    if (!row || !table) return row ?? null;
    const k = cols[table];
    if (!k) return row;
    for (const c in row) {
      const kind = k[c]?.kind;
      if (kind === "datetime") row[c] = dtFromDb(row[c]);
      else if (kind === "bool") row[c] = boolFromDb(row[c]);
    }
    return row;
  };
  const toDb = (table, col, v) => {
    const kind = cols[table]?.[col]?.kind;
    if (kind === "datetime") return dtToDb(v);
    if (kind === "bool") return boolToDb(v);
    if (typeof v === "boolean") return v ? 1 : 0;
    return v;
  };
  const withDefaults = (table, obj) => {
    const spec = cols[table];
    if (!spec) return obj;
    const out = { ...obj };
    for (const [c, s] of Object.entries(spec)) {
      if (out[c] !== undefined) continue;
      if ("default" in s) out[c] = s.default;
      else if (s.defaultFn) out[c] = defaultFns[s.defaultFn]?.() ?? missingFn(s.defaultFn);
    }
    return out;
  };
  const q = (name) => `"${name}"`;

  const h = {
    raw: db,
    /** Register a captured TABLES list (the kit's and the app's own). */
    register(tables) {
      Object.assign(cols, columnMap(tables));
      return h;
    },
    columnsOf: (table) => cols[table] || null,
    /** Rows, converted when `table` names a registered table. */
    all: (sql, p, table) => prep(sql).all(params(p)).map((r) => fromRow(table, r)),
    one: (sql, p, table) => fromRow(table, prep(sql).get(params(p))) ?? null,
    value: (sql, p) => {
      const r = prep(sql).raw(true).get(params(p));
      return r ? r[0] : null;
    },
    run: (sql, p) => prep(sql).run(params(p)),
    exec: (sql) => db.exec(sql),
    /** The row with this primary key (single or composite: {col: value}). */
    get(table, key) {
      const where = typeof key === "object" && key !== null ? key : { [pkOf(table)]: key };
      const names = Object.keys(where);
      return h.one(
        `select * from ${q(table)} where ${names.map((c) => `${q(c)} = ?`).join(" and ")}`,
        names.map((c) => toDb(table, c, where[c])),
        table,
      );
    },
    /** Insert one row; Python-side defaults fill the columns it leaves out. */
    insert(table, obj) {
      const full = withDefaults(table, obj);
      const names = Object.keys(full).filter((c) => full[c] !== undefined);
      return prep(
        `insert into ${q(table)} (${names.map(q).join(", ")}) values (${names.map(() => "?").join(", ")})`,
      ).run(names.map((c) => toDb(table, c, full[c])));
    },
    /** Update columns of the rows matching `where` ({col: value} or SQL text + params). */
    update(table, obj, where, whereParams) {
      const spec = cols[table] || {};
      const set = { ...obj };
      for (const [c, s] of Object.entries(spec)) {
        if (set[c] === undefined && s.onupdateFn) set[c] = defaultFns[s.onupdateFn]?.() ?? missingFn(s.onupdateFn);
      }
      const names = Object.keys(set).filter((c) => set[c] !== undefined);
      if (!names.length) return { changes: 0 };
      const [wsql, wp] = whereClause(table, where, whereParams);
      return prep(`update ${q(table)} set ${names.map((c) => `${q(c)} = ?`).join(", ")} where ${wsql}`).run([
        ...names.map((c) => toDb(table, c, set[c])),
        ...wp,
      ]);
    },
    delete(table, where, whereParams) {
      const [wsql, wp] = whereClause(table, where, whereParams);
      return prep(`delete from ${q(table)} where ${wsql}`).run(wp);
    },
    count(table, where, whereParams) {
      if (where === undefined) return h.value(`select count(*) from ${q(table)}`);
      const [wsql, wp] = whereClause(table, where, whereParams);
      return h.value(`select count(*) from ${q(table)} where ${wsql}`, wp);
    },
    /** Run `fn` in one transaction (nested calls become savepoints). Never async. */
    tx: (fn) => db.transaction(fn)(),
    tableNames: () => h.all("select name from sqlite_master where type = 'table'").map((r) => r.name),
    columnNames: (table) => db.pragma(`table_info(${q(table)})`).map((c) => c.name),
    /**
     * Create every missing table (and its indexes) with the captured DDL — the exact text
     * Python's create_all writes — then apply additive columns ([table, column, decl]).
     */
    createTables(tables, addedColumns = []) {
      h.register(tables);
      const have = new Set(h.tableNames());
      h.tx(() => {
        for (const t of tables) {
          if (have.has(t.name)) continue;
          db.exec(t.ddl);
          for (const ix of t.indexes || []) db.exec(ix);
        }
        for (const [table, column, decl] of addedColumns) {
          if (!have.has(table)) continue; // just created, with the column already there
          if (h.columnNames(table).includes(column)) continue;
          db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
        }
      });
    },
    close: () => db.close(),
  };

  const pkOf = (table) => {
    const spec = cols[table];
    const pks = spec ? Object.keys(spec).filter((c) => spec[c].pk) : [];
    if (pks.length !== 1) throw new Error(`get(${table}): give the key as {column: value}`);
    return pks[0];
  };
  const whereClause = (table, where, whereParams) => {
    if (typeof where === "string") return [where, params(whereParams)];
    const names = Object.keys(where || {});
    if (!names.length) return ["1 = 1", []];
    return [
      names.map((c) => (where[c] === null ? `${q(c)} is null` : `${q(c)} = ?`)).join(" and "),
      names.filter((c) => where[c] !== null).map((c) => toDb(table, c, where[c])),
    ];
  };
  return h;
}

// Python-side callable defaults, by the qualified name the capture writes. The kit's own
// tables have none; an app registers its own here (`registerDefaultFn`).
const defaultFns = {};
export function registerDefaultFn(name, fn) {
  defaultFns[name] = fn;
}
function missingFn(name) {
  throw new Error(`no JavaScript default registered for ${name} (registerDefaultFn)`);
}
