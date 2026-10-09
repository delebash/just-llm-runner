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
//   - the built-ins the polyfills don't cover well → this folder's stand-ins (`shims/`): http and
//     https (ServerResponse for Fastify's inject), url, crypto (Web Crypto — Node's polyfill is
//     3.8 MB), async_hooks, diagnostics_channel, perf_hooks (the platform's own performance — the
//     polyfill's copies `now` unbound); `assert` → the npm `assert` package (callable through
//     require, as find-my-way calls it), resolved from the app;
//   - `better-sqlite3` → better-sqlite3.js, the same API over SQLite WASM;
//   - a module with a phone twin beside it (`<name>.phone.js` next to `<name>.js`) → the twin:
//     the way an app swaps a module that needs the disk for one that doesn't;
//   - `dedupe` (as Vite's): packages that must be ONE copy, resolved from the app — a linked
//     package (the sync engine, the kit) brings its own node_modules, and Yjs refuses two copies
//     ("Yjs was already imported").
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STANDS_IN = ["http", "https", "url", "crypto", "async_hooks", "diagnostics_channel", "perf_hooks"];

/** The worker's Node timer globals (setImmediate) — esbuild's `inject`. */
export const WORKER_GLOBALS = path.join(HERE, "shims", "globals.js");

export function workerShims({ appRoot, dedupe = [] }) {
  return {
    name: "worker-shims",
    setup(build) {
      const builtins = new RegExp(`^(node:)?(${STANDS_IN.join("|")})$`);
      build.onResolve({ filter: builtins }, (args) => ({ path: path.join(HERE, "shims", `${args.path.replace(/^node:/, "")}.js`) }));
      build.onResolve({ filter: /^(node:)?assert$/ }, () => build.resolve("assert/", { resolveDir: appRoot, kind: "require-call" }));
      build.onResolve({ filter: /^better-sqlite3$/ }, () => ({ path: path.join(HERE, "better-sqlite3.js") }));
      const one = new Set(dedupe);
      if (one.size) {
        build.onResolve({ filter: /^[^./]/ }, (args) => {
          if (!one.has(args.path) || args.pluginData?.deduped) return undefined;
          return build.resolve(args.path, { resolveDir: appRoot, kind: args.kind, pluginData: { deduped: true } });
        });
      }
      build.onResolve({ filter: /^\.\.?\// }, (args) => {
        const file = path.resolve(args.resolveDir, args.path);
        if (!file.endsWith(".js") || file.endsWith(".phone.js")) return undefined;
        const twin = `${file.slice(0, -3)}.phone.js`;
        return existsSync(twin) ? { path: twin } : undefined;
      });
    },
  };
}
