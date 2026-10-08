// SPDX-License-Identifier: MIT
// The route diff's Node side: a small host mounting the JavaScript kit EXACTLY as docgen's
// server mounts the Python one (docgen app.py create_app + boot_llm_stack + seed_llm_stack):
// the runner router, installLlm with docgen's own arguments (host-args.py dumps them), the
// log ring + the logs and disk routers, then the seed and the provider-registry boot.
// docgen's own routes (workspace, setup, health…) and the two kit routers that need its app
// hooks (/v1/data's table list, /v1/prefs) are NOT here — step 3 ports docgen itself.
//
//   node scripts/node24.js scripts/route-diff/kit-host.js --data-dir <dir> --port <p> --args <docgen-args.json>

import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { installLlm } from "../../src/llm/install.js";
import * as registry from "../../src/llm/registry.js";
import * as seed from "../../src/llm/seed.js";
import * as stores from "../../src/llm/stores.js";
import { makeDiskRouter } from "../../src/platform/disk_api.js";
import { installFileLog, installLogRing, makeLogsRouter } from "../../src/platform/logs_api.js";
import { HttpError } from "../../src/platform/errors.js";
import { createServer } from "../../src/platform/server.js";
import { openDatabase } from "../../src/platform/sql.js";
import { runnerRouter } from "../../src/runner/api.js";

const { values } = parseArgs({
  options: { "data-dir": { type: "string" }, port: { type: "string" }, args: { type: "string" } },
});
const dataDir = path.resolve(values["data-dir"]);
const hostArgs = JSON.parse(readFileSync(values.args, "utf8"));

installLogRing();
installFileLog(path.join(dataDir, "logs", "just-ai-i18n-docgen.log"));

// docgen never called install_error_handlers: FastAPI's default error answers.
const app = createServer({ errors: "fastapi" });
// docgen's catch-all envelope: an unhandled exception answers {title, detail} as JSON 500.
const handler = app.errorHandler;
app.setErrorHandler((err, req, reply) => {
  if (err && !err.statusCode && !err.validation && !(err instanceof HttpError) && !err.errors) {
    return reply.code(500).send({ title: "Internal Server Error", detail: String(err.message || err).slice(0, 300) });
  }
  return handler(err, req, reply);
});

// docgen never turns foreign keys on (its app.py; plan §9 B10).
const h = openDatabase(path.join(dataDir, "app.db"), { foreignKeys: false });
app.register(runnerRouter);
await installLlm(app, { db: h, ...hostArgs, dataDir });
app.register(makeLogsRouter(hostArgs.product));
app.register(makeDiskRouter(dataDir));

// seed_llm_stack: the shared seed, then the provider registry from the DB. (docgen's
// one-time gemma-3 row retirement already ran on the copied database.)
seed.seedLlm(h);
registry.loadFromConfigs(stores.getProviderStore().list());

await app.listen({ host: "127.0.0.1", port: Number(values.port) });
process.stdout.write(`kit-host listening on ${values.port}\n`);
