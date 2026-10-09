// SPDX-License-Identifier: MIT
// The in-app server: an app's own Fastify server answering inside a web worker, on SQLite WASM
// over the origin-private file system — how the phone runs the app's server (docs/plans/
// 2026-10-08-the-phone.md). The routes, validation and error answers are the app's and the
// kit's, unchanged; requests arrive as messages from the window (the kit UI's `workerFetch`) and
// are answered through Fastify's `inject`, the body streamed back chunk by chunk (an AI answer
// arrives as it's written).
//
//   // the app's worker entry (bundled with ./esbuild.js's plugin)
//   import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
//   import { serveInWorker } from "@delebash/llm-runner/platform/worker/runtime";
//   serveInWorker({ sqlite3InitModule, sqliteOptions: { locateFile }, storage: "justwrite",
//     build: () => createPhoneApp() });
//
// Messages: window → worker `{type: "request", id, method, url, headers, body}` and
// `{type: "abort", id}`; worker → window `{type: "ready"}`, `{type: "failed", message}`, and per
// request `{type: "head", id, status, statusText, headers}`, `{type: "chunk", id, data}` (a
// Uint8Array, transferred), `{type: "end", id}` or `{type: "error", id, message}`.
//
// The other way — the server asking the window for what only the window has (the phone's native
// plugins: its file system for the storage guard): `callWindow(op, args)` posts
// `{type: "call", id, op, args}`; the window answers `{type: "call-result", id, ok, value | error}`
// (the kit UI's `answerWorkerCalls(worker, handlers)`).
import { EventEmitter } from "node:events";
import { useSqliteWasm } from "./better-sqlite3.js";

let nextCall = 0;
const calls = new Map();

// the window's answers (listening from the start: the app's build may already ask)
if (typeof self !== "undefined" && typeof self.addEventListener === "function") {
  self.addEventListener("message", (event) => {
    const m = event.data;
    if (m?.type !== "call-result") return;
    const c = calls.get(m.id);
    calls.delete(m.id);
    if (!c) return;
    if (m.ok) c.resolve(m.value);
    else c.reject(new Error(m.error));
  });
}

/** Ask the window to run `op` (one of the handlers it gave `answerWorkerCalls`); resolves its value. */
export function callWindow(op, args) {
  const id = ++nextCall;
  return new Promise((resolve, reject) => {
    calls.set(id, { resolve, reject });
    self.postMessage({ type: "call", id, op, args });
  });
}

/** Fastify's `serverFactory` in a worker: a server object that never listens (`inject` only). */
export function workerServerFactory() {
  return Object.assign(new EventEmitter(), {
    listening: false,
    address: () => null,
    close(callback) {
      callback?.();
    },
    setTimeout() {},
  });
}

/**
 * Open SQLite (the official WASM build, with `sqliteOptions` — its `locateFile` finds the .wasm;
 * `storage` names the app's private pool), build the app's server (`build()` → a Fastify app
 * made with `serverFactory: workerServerFactory`), and answer the window's requests. Returns
 * the app.
 */
export async function serveInWorker({ sqlite3InitModule, sqliteOptions = {}, storage, build }) {
  let app;
  try {
    const sqlite3 = await sqlite3InitModule(sqliteOptions);
    const pool = await sqlite3.installOpfsSAHPoolVfs({ name: storage });
    useSqliteWasm({ sqlite3, pool });
    app = await build({ sqlite3, pool });
    await app.ready();
  } catch (e) {
    self.postMessage({ type: "failed", message: String(e?.stack ?? e?.message ?? e) });
    throw e;
  }
  const inflight = new Map();
  self.addEventListener("message", async (event) => {
    const m = event.data;
    if (m?.type === "abort") {
      inflight.get(m.id)?.();
      return;
    }
    if (m?.type !== "request") return;
    // An aborted request stops its answer's stream (inject's own `signal` needs
    // stream.addAbortSignal, which the browser polyfill of node:stream doesn't have).
    let stopped = false;
    let stream = null;
    inflight.set(m.id, () => {
      stopped = true;
      stream?.destroy();
    });
    try {
      const res = await app.inject({
        method: m.method,
        url: m.url,
        headers: m.headers,
        payload: m.body ? Buffer.from(m.body) : undefined,
        payloadAsStream: true,
      });
      if (stopped) return;
      self.postMessage({ type: "head", id: m.id, status: res.statusCode, statusText: res.statusMessage ?? "", headers: res.headers });
      stream = res.stream();
      for await (const chunk of stream) {
        const data = new Uint8Array(chunk); // a copy: the polyfill's Buffers can share one pool
        self.postMessage({ type: "chunk", id: m.id, data }, [data.buffer]);
      }
      if (!stopped) self.postMessage({ type: "end", id: m.id });
    } catch (e) {
      if (!stopped) self.postMessage({ type: "error", id: m.id, message: String(e?.stack ?? e?.message ?? e) });
    } finally {
      inflight.delete(m.id);
    }
  });
  self.postMessage({ type: "ready" });
  return app;
}
