// SPDX-License-Identifier: MIT
// The in-app server: an app's own Hono server answering inside a web worker, on SQLite WASM
// over the origin-private file system — how the phone runs the app's server (docs/plans/
// 2026-10-08-the-phone.md). The routes, validation and error answers are the app's and the
// kit's, unchanged; requests arrive as messages from the window (the kit UI's `workerFetch`) and
// are answered by the app's own `app.fetch(request)` (Hono runs on the web-standard Request and
// Response — docs/plans/2026-10-09-hono-standard.md), the body streamed back chunk by chunk (an
// AI answer arrives as it's written).
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

/**
 * Open SQLite (the official WASM build, with `sqliteOptions` — its `locateFile` finds the .wasm;
 * `storage` names the app's private pool), build the app's server (`build()` → a Hono app), and
 * answer the window's requests. Returns the app.
 */
export async function serveInWorker({ sqlite3InitModule, sqliteOptions = {}, storage, build }) {
  let app;
  try {
    const sqlite3 = await sqlite3InitModule(sqliteOptions);
    const pool = await sqlite3.installOpfsSAHPoolVfs({ name: storage });
    useSqliteWasm({ sqlite3, pool });
    app = await build({ sqlite3, pool });
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
    // An aborted request stops its answer's stream: the reader is cancelled, which a streaming
    // route sees as its client gone (`onAbort`).
    const aborter = new AbortController();
    let reader = null;
    inflight.set(m.id, () => {
      aborter.abort();
      reader?.cancel().catch(() => {});
    });
    try {
      const request = new Request(new URL(m.url, self.location.origin), {
        method: m.method,
        headers: m.headers,
        body: m.body ? m.body : undefined,
        signal: aborter.signal,
      });
      const res = await app.fetch(request);
      if (aborter.signal.aborted) return;
      self.postMessage({ type: "head", id: m.id, status: res.status, statusText: res.statusText ?? "", headers: Object.fromEntries(res.headers) });
      if (res.body) {
        reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done || aborter.signal.aborted) break;
          const data = new Uint8Array(value); // a copy: transferring it can't take a buffer the stream still uses
          self.postMessage({ type: "chunk", id: m.id, data }, [data.buffer]);
        }
      }
      if (!aborter.signal.aborted) self.postMessage({ type: "end", id: m.id });
    } catch (e) {
      if (!aborter.signal.aborted) self.postMessage({ type: "error", id: m.id, message: String(e?.stack ?? e?.message ?? e) });
    } finally {
      inflight.delete(m.id);
    }
  });
  self.postMessage({ type: "ready" });
  return app;
}
