// SPDX-License-Identifier: MIT
// The family server's entry — `<app>-server serve` and the desktop app's server process,
// one door (the port of each app's serve.py shape: docgen's was the donor).
//
// Run three ways, the same code:
//   - by the desktop app's main process in a `utilityProcess` — it tells main when it is
//     listening (`{type: "ready", host, port}` over `process.parentPort`; the page's first
//     request can come before the server listens — plan §1.2) and stops on `{type:
//     "stop"}`;
//   - headless, the app's own exe run as Node (`ELECTRON_RUN_AS_NODE=1`) — stops on
//     SIGINT / SIGTERM;
//   - plain `node` in development.
// A stop is graceful: the server closes (its onClose hooks stop engines and release the
// GPU), with a 3 s grace for open streams as uvicorn's `timeout_graceful_shutdown=3`, then
// the process exits 0. A server that can't listen (port taken) exits 3, uvicorn's
// STARTUP_FAILURE code.

import path from "node:path";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { closeApp } from "./server.js";

// The built UI on a computer's server (Node only — the phone's in-app server serves none): an app
// takes it from here, so it uses the kit's @hono/node-server like everything else it serves.
export { serveStatic } from "@hono/node-server/serve-static";

const GRACE_MS = 3000;
// Node's own server settings as Fastify set them: no limit on receiving a request (Node's
// default 300 s would cut off a large backup upload) and Fastify's 72 s keep-alive.
const SERVER_OPTIONS = { requestTimeout: 0, keepAliveTimeout: 72_000 };

/** Listen with `app` on host:port; resolves the Node server once it listens. */
function listen(app, host, port) {
  return new Promise((resolve, reject) => {
    const server = serve(
      // The platform's own Request/Response stay global (the kit's HTTP client relies on them).
      { fetch: app.fetch, hostname: host, port, serverOptions: SERVER_OPTIONS, overrideGlobalObjects: false },
      () => {
        server.off("error", reject);
        resolve(server);
      },
    );
    server.once("error", reject);
  });
}

/**
 * Parse `serve [--host H] [--port P] [--data-dir D] [--log-level L]`, with env fallbacks
 * named by the app (`<APP>_HOST`, `<APP>_PORT`, `<APP>_DATA_DIR`, `<APP>_LOG_LEVEL`).
 */
export function parseServeArgs(argv, { envPrefix, env = process.env } = {}) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      host: { type: "string" },
      port: { type: "string" },
      "data-dir": { type: "string" },
      "log-level": { type: "string" },
    },
  });
  const cmd = positionals[0] ?? "serve";
  if (cmd !== "serve") throw new Error(`unknown command '${cmd}' (choose from 'serve')`);
  const e = (k) => (envPrefix ? (env[`${envPrefix}_${k}`] ?? "").trim() || null : null);
  const port = values.port ?? e("PORT");
  return {
    host: values.host ?? e("HOST"),
    port: port != null ? Number(port) : null,
    // ABSOLUTE, always: a relative --data-dir resolves differently in every child process
    // with its own working directory (JustVoice's 2026-08-22 lesson).
    dataDir: (values["data-dir"] ?? e("DATA_DIR")) ? path.resolve(values["data-dir"] ?? e("DATA_DIR")) : null,
    logLevel: values["log-level"] ?? e("LOG_LEVEL") ?? "info",
  };
}

/**
 * Run a Hono app as the family server. `build(args)` returns `{app, host, port,
 * banner?}` — host/port already resolved (CLI/env over the app's settings store);
 * `app` is the app's Hono instance. Returns `{app, server, stop, port}`.
 */
export async function runServer({ argv = process.argv.slice(2), envPrefix, build, log = console }) {
  const args = parseServeArgs(argv, { envPrefix });
  const { app, host, port, banner } = await build(args);
  let server;
  try {
    server = await listen(app, host, port);
  } catch (e) {
    log.error?.(`could not listen on ${host}:${port}: ${e.message}`);
    process.exit(3);
  }
  const addr = server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : port;
  if (banner) process.stdout.write(`${banner}\n`);

  let stopping = null;
  const stop = (why = "stop") => {
    if (stopping) return stopping;
    stopping = (async () => {
      log.info?.(`server stopping (${why})`);
      // Stop taking connections; idle keep-alive sockets go now, open streams get the grace.
      const closed = new Promise((resolve) => server.close(() => resolve()));
      server.closeIdleConnections?.();
      const t = setTimeout(() => {
        // Open streams past the grace: close their sockets so close() can finish.
        server.closeAllConnections?.();
      }, GRACE_MS);
      try {
        await closeApp(app);
        await closed;
      } catch (e) {
        log.error?.(`close failed: ${e?.stack || e}`);
      } finally {
        clearTimeout(t);
      }
      process.exit(0);
    })();
    return stopping;
  };

  const port0 = process.parentPort;
  if (port0) {
    port0.on("message", (e) => {
      if (e?.data?.type === "stop") stop("asked by the app");
    });
    port0.postMessage({ type: "ready", host, port: boundPort });
  }
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  return { app, server, stop, port: boundPort };
}
