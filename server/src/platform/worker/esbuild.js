// SPDX-License-Identifier: MIT
// Bundling an app's server for a web worker — the phone's in-app server (docs/plans/
// 2026-10-08-the-phone.md) — with esbuild. The app's build script passes this plugin BEFORE the
// browser polyfills of Node's built-ins (esbuild-plugins-node-modules-polyfill, which the app
// installs) and injects WORKER_GLOBALS:
//
//   import { build } from "esbuild";
//   import { nodeModulesPolyfillPlugin } from "esbuild-plugins-node-modules-polyfill";
//   import { WORKER_GLOBALS, workerShims } from "@delebash/llm-runner/platform/worker/esbuild";
//   await build({ entryPoints: ["src/phone/server-worker.js"], bundle: true, format: "esm",
//     platform: "browser", inject: [WORKER_GLOBALS],
//     plugins: [workerShims({ appRoot, dedupe: ["yjs"] }),
//       nodeModulesPolyfillPlugin({ globals: { Buffer: true, process: true }, fallback: "empty" })] });
//
// What it does:
//   - `crypto` → this folder's stand-in (`shims/crypto.js`: ids from Web Crypto — Node's polyfill
//     is 3.8 MB);
//   - `better-sqlite3` → better-sqlite3.js, the same API over SQLite WASM; `undici` → the
//     platform's fetch, falling back to the window's native HTTP for a call the webview refuses
//     (shims/undici.js);
//   - `dedupe` (as Vite's): packages that must be ONE copy, resolved from the app — a linked
//     package (the sync engine, the kit) brings its own node_modules, and Yjs refuses two copies
//     ("Yjs was already imported").
//
// The server itself needs nothing else: Hono runs on the web-standard Request and Response
// (docs/plans/2026-10-09-hono-standard.md — the stand-ins for Node's http, https, url,
// async_hooks, diagnostics_channel and perf_hooks, and the npm `assert`, served Fastify and went
// with it). A module that needs the disk has a phone version chosen by the app's package.json
// `"imports"` with a `"browser"` condition (Node's subpath imports — esbuild resolves the
// condition for `platform: "browser"`), not by this plugin.
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STANDS_IN = ["crypto"];
// packages a worker can't run, with stand-ins here
const PACKAGES = ["undici"];

/** The worker's Node timer globals (setImmediate) — esbuild's `inject`. */
export const WORKER_GLOBALS = path.join(HERE, "shims", "globals.js");

export function workerShims({ appRoot, dedupe = [] }) {
  return {
    name: "worker-shims",
    setup(build) {
      const builtins = new RegExp(`^(node:)?(${STANDS_IN.join("|")})$`);
      build.onResolve({ filter: builtins }, (args) => ({ path: path.join(HERE, "shims", `${args.path.replace(/^node:/, "")}.js`) }));
      build.onResolve({ filter: new RegExp(`^(${PACKAGES.join("|")})$`) }, (args) => ({ path: path.join(HERE, "shims", `${args.path}.js`) }));
      build.onResolve({ filter: /^better-sqlite3$/ }, () => ({ path: path.join(HERE, "better-sqlite3.js") }));
      const one = new Set(dedupe);
      if (one.size) {
        build.onResolve({ filter: /^[^./]/ }, (args) => {
          if (!one.has(args.path) || args.pluginData?.deduped) return undefined;
          return build.resolve(args.path, { resolveDir: appRoot, kind: args.kind, pluginData: { deduped: true } });
        });
      }
    },
  };
}
