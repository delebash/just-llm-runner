// SPDX-License-Identifier: MIT
// The template's server entry — `serve [--host H] [--port P] [--data-dir D]`, run three ways
// (the kit's platform/serve.js): by the desktop app in a utilityProcess, headless as
// `<app>-server serve`, and `node src/serve.js serve` in development.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runServer } from "@delebash/llm-runner/platform";
import { createApp } from "./app.js";

export const DEFAULT_PORT = 17490; // the family port registry: JW 17495 · JV 17494 · docgen 8742 · template 17490

export async function main(argv = process.argv.slice(2)) {
  return runServer({
    argv,
    envPrefix: "FAMILY_TEMPLATE",
    build: async ({ dataDir, host, port }) => ({
      app: await createApp({ dataDir, uiDir: process.env.FAMILY_TEMPLATE_UI_DIR || null }),
      host: host ?? "127.0.0.1",
      port: port ?? DEFAULT_PORT,
    }),
  });
}

// Run when started as a program — by the desktop app (a utilityProcess has `parentPort`) or
// `node src/serve.js` — not when a test imports it.
const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (process.parentPort || entry === import.meta.url) await main();
