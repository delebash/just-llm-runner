<!-- SPDX-License-Identifier: MIT -->
# @delebash/llm-runner — the kit in JavaScript

The family's shared server kit — the LLM stack (providers, routing, presets, prompts, usage),
the bundled llama.cpp runner, the platform pieces (errors, the spawn door, the data folder,
backup, logs, ZIP archives) and the desktop shell — in plain JavaScript on Node 24 (Electron's). It is the
JavaScript port of `../llm_runner/`, made for the family's move to Electron and a Node server
(JustVoice's `docs/plans/2026-10-07-electron-node-plan.md` §4). Both exist until every app has
moved, and a kit server change lands in both (plan §10 Q6).

How it was built, every convention a change follows, and what differs from Python:
[`../docs/plans/2026-10-07-kit-in-javascript.md`](../docs/plans/2026-10-07-kit-in-javascript.md).
Facts: the kit's `docs/dev/RESEARCH.md` §2.

## Consume it

An app's Hono server mounts the whole stack with one call, as its FastAPI server called
`install_llm` — same routes, same camelCase JSON, same tables:

```js
import { router as runnerRouter, installLlm } from "@delebash/llm-runner";
import { createServer, openDatabase, runServer } from "@delebash/llm-runner/platform";

await runServer({
  envPrefix: "MYAPP",
  build: async ({ dataDir, host, port }) => {
    const app = createServer({ typeBase: "https://myapp.dev/errors/" }); // or { errors: "fastapi" }
    const db = openDatabase(`${dataDir}/app.db`, { foreignKeys: true }); // the app decides (plan §9 B10)
    app.register(runnerRouter); // /v1/llm-runner/* — the host mounts it, as with Python
    await installLlm(app, { db, dataDir, product: "My App" /* , featureCatalog, enginePresets, … */ });
    return { app, host: host || "127.0.0.1", port: port || 9000 };
  },
});
```

`installLlm(app, { db, dataDir })` is a complete call. `app = null` is the headless boot (every
store, seed and seam wired, nothing mounted). It awaits hardware detection once: the tune layers'
machine and class keys read what it found.

The desktop shell is `@delebash/llm-runner/shell` (`runDesktopApp`, the preload bridge, the data
folder ladder).

## Check it

```bash
npm test                                                 # vitest on Electron's Node 24
node scripts/node24.js scripts/route-diff/route-diff.js   # the route diff against a REAL Python server
node scripts/node24.js scripts/compare-seed.js            # seed parity, cell by cell
npm run lint
```

The route diff runs docgen's Python server and a Node host mounting this kit the same way, each
on its own copy of docgen's dev database, then compares every kit GET, a 37-step write sequence
and both databases cell by cell. `scripts/route-table.json` is the Python kit's 118-route list
(`scripts/route-table.py` regenerates it); `scripts/capture-schema.py` regenerates
`src/llm/db_schema.js` when a Python table changes.

`tests/process_job.test.js` proves the Windows kill-on-close job for real when run with
`KIT_REAL_SPAWN=1`; `tests/realrouter_smoke.test.js` keeps Python's gate (`JW_REALROUTER=1` and a
real engine).
