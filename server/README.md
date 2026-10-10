<!-- SPDX-License-Identifier: MIT -->
# @delebash/llm-runner — the kit in JavaScript

The family's shared server kit — the LLM stack (providers, routing, presets, prompts, usage),
the bundled llama.cpp runner, the platform pieces (errors, the spawn door, the data folder,
backup, logs, ZIP archives) and the desktop shell — in plain JavaScript on Node 24 (Electron's). It
began as the port of the kit's Python core, made for the family's move to Electron and a Node server
(JustVoice's `docs/plans/2026-10-07-electron-node-plan.md` §4); every app has moved and the Python
is gone. The server runs on Hono since 2026-10-09 — one server in Node (the desktop app, headless)
and in the phone's web worker (`../docs/plans/2026-10-09-hono-standard.md`, §10 the route rules).

How it was built and every convention a change follows:
[`../docs/plans/2026-10-07-kit-in-javascript.md`](../docs/plans/2026-10-07-kit-in-javascript.md).
Facts: the kit's `docs/dev/RESEARCH.md` §2.

## Consume it

An app's Hono server mounts the whole stack with one call:

```js
import { router as runnerRouter, installLlm } from "@delebash/llm-runner";
import { createServer, openDatabase, runServer } from "@delebash/llm-runner/platform";

await runServer({
  envPrefix: "MYAPP",
  build: async ({ dataDir, host, port }) => {
    const app = createServer({ typeBase: "https://myapp.dev/errors/" }); // or { errors: "fastapi" }
    const db = openDatabase(`${dataDir}/app.db`, { foreignKeys: true }); // the app decides (plan §9 B10)
    app.route("/", runnerRouter()); // /v1/llm-runner/* — the host mounts it
    await installLlm(app, { db, dataDir, product: "My App" /* , featureCatalog, enginePresets, … */ });
    return { app, host: host || "127.0.0.1", port: port || 9000 };
  },
});
```

`installLlm(app, { db, dataDir })` is a complete call. `app = null` is the headless boot (every
store, seed and seam wired, nothing mounted). It awaits hardware detection once: the tune layers'
machine and class keys read what it found.

**One Hono:** an app imports `Hono`, `stream` and `serveStatic` from `@delebash/llm-runner/platform`,
never `hono` itself — a second copy's sub-apps answer errors with plain 500s (the guard's
`checkOneHono`). The desktop shell is `@delebash/llm-runner/shell` (`runDesktopApp`, the preload
bridge, the data folder ladder).

## Check it

```bash
npm test                 # vitest on Electron's Node 24
npm run lint
node ../scripts/check-family.js    # the family guard, from any family repo
```

`tests/process_job.test.js` proves the Windows kill-on-close job for real when run with
`KIT_REAL_SPAWN=1`; `tests/realrouter_smoke.test.js` needs `JW_REALROUTER=1` and a real engine.
`scripts/router-check/router-check.js` is the hands-on runner check — a real model loaded,
stopped, loaded again and hard-killed, with no llama-server left and VRAM back to its baseline
(run it with the family apps closed; its header has the arguments).
