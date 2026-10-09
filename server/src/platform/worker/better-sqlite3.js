// SPDX-License-Identifier: MIT
// better-sqlite3's API, the part the kit's database wrapper (platform/sql.js) uses, over the
// official SQLite WASM build — so the wrapper, and every route on it, runs unchanged in a web
// worker (the bundle maps `better-sqlite3` here: ./esbuild.js). The worker opens SQLite first
// (async) and hands it here: `useSqliteWasm({ sqlite3, pool })` (runtime.js does). A database's
// own SQLite WASM handle is `.wasmDb` (for code with a WASM adapter of its own, such as the sync
// engine's `sqliteWasmAdapter`).

let wasm = null;
export function useSqliteWasm(w) {
  wasm = w;
}

const toNodeValue = (v) => (v instanceof Uint8Array && typeof Buffer !== "undefined" ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : v);
const toSqlValue = (v) => (typeof v === "boolean" ? (v ? 1 : 0) : v);

class Statement {
  constructor(owner, sql) {
    this.owner = owner;
    this.source = sql;
    this._raw = false;
    this._pluck = false;
  }
  raw(on = true) {
    this._raw = on;
    return this;
  }
  pluck(on = true) {
    this._pluck = on;
    return this;
  }
  _bind(st, args) {
    if (!args.length) return;
    const p = args.length === 1 ? args[0] : args;
    if (Array.isArray(p)) {
      if (p.length) st.bind(p.map(toSqlValue));
      return;
    }
    if (p !== null && typeof p === "object" && !(p instanceof Uint8Array)) {
      const { capi } = wasm.sqlite3;
      const n = capi.sqlite3_bind_parameter_count(st.pointer);
      for (let i = 1; i <= n; i++) {
        const name = capi.sqlite3_bind_parameter_name(st.pointer, i);
        const key = name ? name.slice(1) : null;
        if (key !== null && key in p) st.bind(i, toSqlValue(p[key]));
      }
      return;
    }
    st.bind([toSqlValue(p)]);
  }
  _rows(args, limit = Infinity) {
    const st = this.owner.wasmDb.prepare(this.source);
    try {
      this._bind(st, args);
      const out = [];
      while (out.length < limit && st.step()) {
        const row = st.get(this._raw || this._pluck ? [] : {});
        if (this._pluck) out.push(toNodeValue(row[0]));
        else if (Array.isArray(row)) out.push(row.map(toNodeValue));
        else {
          for (const k of Object.keys(row)) row[k] = toNodeValue(row[k]);
          out.push(row);
        }
      }
      return out;
    } finally {
      st.finalize();
    }
  }
  all(...args) {
    return this._rows(args);
  }
  get(...args) {
    return this._rows(args, 1)[0];
  }
  *iterate(...args) {
    yield* this._rows(args);
  }
  run(...args) {
    const db = this.owner.wasmDb;
    const st = db.prepare(this.source);
    try {
      this._bind(st, args);
      while (st.step()) {
        /* a statement that returns rows, run for its effect */
      }
    } finally {
      st.finalize();
    }
    const { capi } = wasm.sqlite3;
    return { changes: db.changes(), lastInsertRowid: Number(capi.sqlite3_last_insert_rowid(db.pointer)) };
  }
}

export default class Database {
  constructor(file, { readonly = false } = {}) {
    if (!wasm) throw new Error("SQLite WASM isn't open — call useSqliteWasm() first");
    this.name = file;
    this.readonly = readonly;
    this.wasmDb = file === ":memory:" || !wasm.pool ? new wasm.sqlite3.oo1.DB(file === ":memory:" ? ":memory:" : file) : new wasm.pool.OpfsSAHPoolDb(file);
    this.open = true;
    this._depth = 0;
  }
  get inTransaction() {
    return wasm.sqlite3.capi.sqlite3_get_autocommit(this.wasmDb.pointer) === 0;
  }
  prepare(sql) {
    return new Statement(this, sql);
  }
  exec(sql) {
    this.wasmDb.exec(sql);
    return this;
  }
  pragma(source, { simple = false } = {}) {
    const rows = this.wasmDb.exec({ sql: `PRAGMA ${source}`, rowMode: "object", returnValue: "resultRows" });
    if (simple) return rows.length ? Object.values(rows[0])[0] : undefined;
    return rows;
  }
  /** better-sqlite3's: a function that runs `fn` in a transaction; nested calls are savepoints. */
  transaction(fn) {
    const self = this;
    return function run(...args) {
      const nested = self.inTransaction;
      const sp = `s${++self._depth}`;
      self.wasmDb.exec(nested ? `SAVEPOINT ${sp}` : "BEGIN");
      try {
        const r = fn.apply(this, args);
        self.wasmDb.exec(nested ? `RELEASE ${sp}` : "COMMIT");
        return r;
      } catch (e) {
        try {
          self.wasmDb.exec(nested ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : "ROLLBACK");
        } catch {
          /* the transaction already ended */
        }
        throw e;
      } finally {
        self._depth--;
      }
    };
  }
  function(name, opts, fn) {
    const f = typeof opts === "function" ? opts : fn;
    const o = typeof opts === "object" ? opts : {};
    this.wasmDb.createFunction(name, (_ctx, ...a) => f(...a), { deterministic: !!o.deterministic, arity: o.varargs ? -1 : f.length });
    return this;
  }
  close() {
    this.wasmDb.close();
    this.open = false;
  }
}
