# THE FAMILY APP STANDARD — every family app, identical by construction

**Two kinds of app while the family moves (2026-10-08).** The TARGET is the Electron + Vue +
Node app of **§0** — every app ends there. The Tauri + Vue + Python standard of §1–§14 still
governs each app **until it moves**: docgen is moving now (step 3), JustWrite moves in step 4,
JustVoice in step 5 (JustVoice's `docs/plans/2026-10-07-electron-node-plan.md`). The guard
(`scripts/check-family.mjs`) tells the kinds apart — "electron" when `electron/main.js`
exists — and checks each against its own half.

Ruled by the user, 2026-08-02, after parity gaps kept surfacing one at a time: **one
document that covers EVERYTHING, so a new app is the same as the last one — layout,
scripts, tests, shell, server, API — and adding llm-runner is the same every time.**
This doc is the generator you would otherwise run. If an item here is ambiguous, the
canonical implementations are **justwrite-app** (the richest shell) and
**just_ai_i18n_docgen** (the newest full pass through this checklist).

A deviation is allowed only when flagged to the user AND recorded here in the same
change. Unflagged deviations are how this document came to exist.

Scope note (2026-08-04; "Tauri" dropped 2026-10-08): this standard governs the family's
APPS. The repo hosting it (`just-llm-runner`) is the shared LIBRARY — it follows §13
(docs) and its own CLAUDE.md/README contract, and is exempt from the app-shaped sections
(§0/§1/§2/§5/§10/§12).

**Recorded deviations (2026-08-04, found by the docs campaign):** JustWrite predates
§4's boot rules and still hand-wires `configureLlmUi`/`configureServerApi`/
`configureExternal` (`main.js:41-59`), mounts `<Toast />` + `<AppDialog />`
individually instead of `<LlmUiHosts />`, and hand-builds its AI-tasks nav row
(`Sidebar.vue:148`) instead of `useAiTasksNav()`. Convergence is tracked in JW's
`docs/dev/TASKS.md`; new apps follow §4 as written. (JW's last two gaps closed
2026-08-06/08: its `lint` script landed with slice 11, and target-tree P3 moved
its console script to `justwrite_server.serve:main` — nothing is grandfathered.)

**Recorded change (2026-10-08) — the Electron target.** The family moves to Electron and a
Node server; Tauri, Rust and Python go (the direction ruled 2026-10-05; the plan approved
2026-10-07; docgen's layout decided 2026-10-08 — JustVoice's `docs/dev/TASKS.md`, "The
family moves to Electron and a Node server", answer 8). In this change:
- **§0 added** — the Electron app, the family's target: layout, scripts, the shell and its
  one bridge, the server and the headless launcher, the dev data folder, the installer, the
  e2e harness.
- **§1, §2, §5, §6, §7, §10, §12 and §14 marked** "until the app moves" where they describe
  the Tauri + Python shape; §8 and §11 name their Electron twins. Nothing deleted: JustWrite
  and JustVoice still run on them.
- **§5's rule "no `window.<app>` global" became "one bridge object (`window.appShell`), read
  only by `services/native.js`"** — in an Electron app the kit's preload installs it; the
  renderer still installs nothing on `window`.
- **The guard runs per kind** (check 3 scripts, 4 server layout, 8 skeleton, 12–14 the
  shell); checks 1, 2, 5, 6, 7, 9, 10, 11 and 15 run for both kinds.

**Recorded deviation (2026-10-08) — docgen mid-move.** Until its step's last slice deletes
them, docgen still carries `src-tauri/`, `server/just_ai_i18n_docgen/`,
`server/pyproject.toml`, `server/tests/test_*.py` and `scripts/py.js`. The guard reports
them as ADVISORY ("leftover of the Tauri/Python era") — neither required nor forbidden — so
the deletion itself neither adds nor clears a violation.

---

## 0 · The Electron app — the family's TARGET (2026-10-08)

Every app ends here (plan §0). docgen is the first (step 3); its files are the reference
until a second app has moved. Where §0 and §1–§14 disagree for a moved app, §0 wins; what
§0.8 lists carries over unchanged.

### 0.1 · The layout

```
<repo>/
├── package.json            # ONE npm project — the UI, the server and Electron
│                           #   "main": "electron/main.js"
├── electron/main.js        # ~40 lines: the kit's runDesktopApp({...}) — config, no logic
├── index.html · src/ · public/   # the renderer, as before (Vite → dist/)
│   └── src/services/native.js    # the ONLY reader of window.appShell (§0.3)
├── server/
│   ├── src/                # the server, plain JavaScript (ES modules), one file per old
│   │   │                   #   Python module with the same name (app.js, paths.js, api/…)
│   │   ├── serve.js        # the entry — `serve` (§0.4)
│   │   └── cli.js          # the domain CLI, where the app has one
│   ├── tests/*.test.js     # vitest
│   └── vitest.config.js    # include: tests/**/*.test.js
├── scripts/
│   ├── node24.mjs          # runs a script on Electron's own Node 24, not PATH's `node`
│   └── dev.mjs             # `npm run dev` (§0.2)
├── build/                  # icons (icon.ico · icon.icns · icon.png · tray.png)
│   └── launcher/*.cmd      # the headless launchers (§0.4)
├── data/                   # the dev data folder — gitignored (§0.5)
└── e2e/                    # Playwright's Electron driver (§0.7)
```

- **package.json** — `dependencies` carry `"@delebash/llm-runner":
  "file:../just-llm-runner/server"` (the kit's server, its shell and its data ladder);
  `devDependencies` carry `electron` and `electron-builder` at exact versions (the version
  policy is the plan's §8); `allowScripts` names the packages whose install scripts run
  (`electron`, `koffi`, `better-sqlite3`); a `build` block configures the installer (§0.6).
  **No `@tauri-apps/*` package and no `tauri` script.**
- **The kit's UI** stays a Vite source alias (§3) — no change.
- **The names**: the shell's `id` is the kebab name (`just-ai-i18n-docgen`) — the `app://`
  host and `com.<id>.app`; the identifier, the port registry and the data-dir variable
  `<SNAKE_UPPER>_DATA_DIR` are §1's, unchanged.
- **No `scripts/py.js`, no `pyproject.toml`, no ruff, no pytest, no `src-tauri/`** — they go
  with the move (plan §0 "What goes").

### 0.2 · Root files — the scripts contract

The NAMES are the contract, as in §2; `npm run dev` still opens the DESKTOP APP.

```jsonc
{
  "dev": "node scripts/dev.mjs",           // THE APP — Vite on the app's own port (§3) + the
                                           //   desktop app pointed at it (DEV_URL); the shell
                                           //   starts the server on <repo>/data; closing the
                                           //   window ends both
  "dev:vite": "vite",                      // the browser-only loop
  "build": "vite build && electron-builder", // the installer (§0.6)
  "build:vite": "vite build",
  "preview:vite": "vite preview",
  "server": "node scripts/node24.mjs server/src/serve.js serve",
  "test:server": "node scripts/node24.mjs node_modules/vitest/vitest.mjs run --config server/vitest.config.js",
  "lint": "biome check .",
  "test": "npm test --prefix e2e",         // §0.7
  "screenshots": "node e2e/capture-direct.js",
  "test:unit": "vitest run",               // the renderer's tests (root vitest.config.js)
  "cli": "node scripts/node24.mjs server/src/cli.js"   // where the app has a domain CLI
}
```

- **Everything server-side runs on Electron's own Node 24** — the runtime the server ships
  on — through `scripts/node24.mjs` (it runs the `electron` binary with
  `ELECTRON_RUN_AS_NODE=1`). Never whatever `node` is first on PATH: that is the
  bare-`python` trap of §2 again.
- The guard (check 3) asserts the names, `server`, `test:server`, `dev` →
  `scripts/dev.mjs`, `build` → `electron-builder`, and no `tauri` script.

### 0.3 · The shell and its one bridge

**The shell is the kit's.** `electron/main.js` calls `runDesktopApp` from
`@delebash/llm-runner/shell` with the app's settings and does nothing else — it imports only
`node:*` modules and the shell. The rule that kept business logic out of Rust carries over:
a need the shell can't meet is built in the KIT's `server/src/shell/`, for every app.

| Field | Required | What |
|---|---|---|
| `id` | yes | the kebab name — the `app://` host, the tray id, `com.<id>.app` |
| `appName` | yes | the data folder's name under the OS fallback (§0.5) |
| `productName` | yes | shown in the tray and dialogs |
| `port` | yes | the app's registered server port (§1) |
| `serverEntry` | yes | `server/src/serve.js`, absolute |
| `dataDirEnv` | yes | `<SNAKE_UPPER>_DATA_DIR` |
| `repoRoot` | yes | the checkout root — the dev data folder is `<repoRoot>/data` |
| `distDir` | yes | the built UI (`dist/`) |
| `window` · `icon` · `trayIcon` · `logFile` | per app | window size/title/background, icons, the server's live log (tray "Open log file") |
| `closeHoldMs` · `csp` · `cspAdd` · `trayExtras` | optional | JustWrite's 400 ms pagehide hold · the `app://` CSP (the kit writes a default) · sources added to the default's directives (JustWrite: `{"img-src": ["https:"]}`, for images pasted from the web) · extra tray items sent as `tray:<event>` |

What the kit's shell does, so no app does it: resolves the data root before Chromium writes
anything and keeps Chromium's own files under `<root>/electron`; runs `serverEntry` in a
`utilityProcess` (`serve --port <port>`, the root in `dataDirEnv`) after evicting a stale
listener, and stops it gracefully on quit (asks, waits, then kills); loads the window from
`app://<id>/` (`DEV_URL` in development) — it opens even with the server down and shows the
kit's connection-error screen; the §11 tray and keep-running switch; the native dialogs; the
opener. The server's own escape hatch is `<ID_UPPER>_DEV_NO_SERVER=1` (it replaces §5's
`<ABBR>_DEV_NO_SIDECAR`).

**One bridge object — `window.appShell` — read only by `src/services/native.js`.** The kit's
preload exposes it: `invoke(command, args)` for the shell's commands (`pickDirectory`,
`pickFile`, `saveFile`, `storageGetRoot`, `storageRelocate`, `setKeepRunning`,
`setTrayLabels`, `openExternal`, `openPath`), `on(event, fn)` for its `tray:*` pushes,
`platform`, and `versions` (`{ electron, chrome }`, for an About page). `native.js` is the one file that reads it and the one that asks the kit's
`isDesktopShell()`; it exports one function per command plus `openUrl` / `openPath` /
`onShellEvent`, and outside the desktop app (Vite in a browser, the headless UI) each answers
the browser's way — null or a no-op. **No `@tauri-apps` import anywhere.** A new command is
added in the kit (main's `COMMANDS` and the preload's list), never per app.

§5's three doors carry over: the opener is `native.js`'s `openUrl`/`openPath` handed to
`installLlmUi(app, { external })`; a command goes through `native.js`; a file goes to disk
through the kit's `saveBlob`/`downloadBlob`. The guard (checks 12–14) fails a
`window.appShell` or `isDesktopShell` read outside `native.js`, any `@tauri-apps` import, a
main that doesn't import `runDesktopApp` from the kit, imports anything else, misses a
required field, or passes a port off the registry.

### 0.4 · The server, its entry, and headless

- **`server/src/serve.js`** is the entry: `serve [--host] [--port] [--data-dir]
  [--log-level]` through the kit's `runServer({ envPrefix, build })`, a Fastify app from the
  kit's `createServer`, the kit mounted with `installLlm(app, {…})` — the JavaScript twin of
  `install_llm` (`../server/README.md`). Same routes, same JSON, same SQLite file with the
  same schema as the Python server it replaced (ruling 5). Plain JavaScript on Electron's
  Node 24, no TypeScript.
- **The §6 server rules carry over in meaning** — bearer auth for the headless path, the
  error envelope before CORS, the Origin-header test — from the kit's JavaScript `platform`
  (`BearerAuthMiddleware`, `CsrfOriginMiddleware`, `installErrorHandlers`,
  `makePrefsRouter`, `makeLogsRouter`, `makeDiskRouter`, `makeDataRouter`). The window's
  origin is `app://<id>` — cross-site, so a JSON POST sends a preflight (plan §1.2) — and
  the server's CORS and CSRF allowlists carry it.
- **Tests**: `server/tests/*.test.js`, vitest on Electron's Node (`npm run test:server`);
  routes through `fastify.inject`.
- **Headless is the app's own exe run as Node** (ruling 4): `build/launcher/<name>-server.cmd`
  sets `ELECTRON_RUN_AS_NODE=1` and runs the exe on `resources/app.asar/server/src/serve.js`;
  the installer puts `build/launcher/` beside the exe. Same server, same UI at `/ui/`, no
  window. A domain CLI gets a launcher the same way (docgen's `just-ai-i18n-docgen.cmd` →
  `server/src/cli.js`). In a checkout: `npm run server`.
- **A launcher never shares the app executable's name** — Windows resolves a bare name to
  the GUI exe first and spawns windows forever (JustVoice's CreateProcessW trap, §5's "never
  spawn the unqualified app name"; it moves from the console script to the launcher). The
  guard fails it.

### 0.5 · The data folder — one ladder

ONE module, the kit's `server/src/platform/data_paths.js`, used by the shell before the
window opens and by the headless server — the §6 policy, unchanged in meaning: the app's
data-dir variable (`--data-dir` sets it) → the Change-folder pointer `dataroot.txt` (a
pointer naming the computed default is residue and is deleted) → **`data/` in the install
directory** (packaged: beside the exe; a checkout: `<repo>/data`, ruling 6) → the OS
fallback `%LOCALAPPDATA%\<App>\<App>` only when the install directory isn't writable, its
pointer beside it at `%LOCALAPPDATA%\<App>\dataroot.txt` (decided 2026-10-08).

- **The dev data folder is `<repo>/data`**, gitignored (the guard checks `.gitignore`).
  `npm run dev`, `npm run server` and the e2e harness all open it — one ladder, so §6's
  two-dev-roots `--data-dir` trap is gone.
- Chromium's own files and the window position live under the root (`<root>/electron`), so
  nothing lands where the user didn't choose — the 2026-08-14 ruling Tauri broke.

### 0.6 · The installer

`npm run build` = `vite build && electron-builder` (MIT; docgen's block: NSIS on Windows,
AppImage + deb on Linux). The `build` block in package.json: `appId`
`com.<kebab-name>.app`, `productName`, `directories` (`buildResources: build`, `output:
release`), `files` =
`electron/**`, `server/src/**`, `dist/**`, `package.json`; `asarUnpack` for the native
modules (`**/*.node`); `extraResources` copying `build/launcher` beside the exe; per-platform
icons from `build/`; on Windows an `executableName` and a per-user NSIS install with a
choosable folder (`oneClick: false`, `perMachine: false`). Auto-update is not part of the
move (plan §0).

### 0.7 · The e2e harness

`e2e/` drives the REAL desktop app through Playwright's Electron driver (`playwright-core`'s
`_electron`): it launches `electron .` from the checkout on the BUILT UI from `app://` (run
`npm run build:vite` first) — no browser download, no driver binary. Scripts run in the page
over the debugger protocol, so the app's real Content-Security-Policy stays on. The test
files and root script names are §10's (`test`, `screenshots`); the tests' switch keeps the
shell from starting its own server (`<ID_UPPER>_DEV_NO_SERVER`). It replaces §10's
tauri-driver + msedgedriver.

### 0.8 · What carries over unchanged

§3 (vite config and the kit UI alias) · §4 (frontend standards; the opener is `native.js`'s,
not `@tauri-apps/plugin-opener`) · §8's AI-call convention and the stack's behaviour (the
server half through `installLlm`) · §11 (the standard chrome — tray, keep-running and the
log opener now live in the kit's shell) · §13 (docs) · §14's renderer and config layer. The
server's module names carry over one-for-one (`serve`, `app`, `app_state`, `paths`,
`version`, `api/<area>_api`, …) as `.js` files; the guard asserts `serve.js` today, not yet
the rest of §14's server skeleton.

---

## 1 · Creating the app

> **Tauri + Python — until the app moves** (JustWrite step 4, JustVoice step 5): the
> scaffolder and the Python names. The port registry, identifier and data-dir variable hold
> for both kinds; an Electron app's layout is §0.1.

```bash
npm create tauri-app@latest   # Vue, JavaScript — take the scaffolder's layout UNTOUCHED
```

- **Repo root**: `index.html` + `src/` + `src-tauri/` + `public/` exactly as scaffolded.
  NEVER `src/renderer/` — that Electron habit cost two apps a restructure.
- **Names, one per layer**: repo name (any style) · Python package `snake_case` ·
  console scripts `kebab-case`. The Python package REPEATS the app name one level down
  (`server/<snake_name>/`) because Python imports by NAME where JS imports by path —
  the full reasoning + PyPA citation is §7.
- **Port registry** (a new app claims the next): JW **17495** · JV **17494** ·
  i18n-docgen **8742**. (This registry said "JV 8741" until 2026-08-04 while JV's
  `lib.rs` listened on 17494 — the registry records reality, verify against the
  app's `SERVER_PORT` const before repeating it.) The app's OWN server port is the
  only one it claims — the
  bundled engine's router port is **allocated at spawn**, never registered and never
  assumed (§8), so two family apps can run at once.
- **Identifier**: `com.<kebab-name>.app`.
- **Env vars**: data dir `<SNAKE_NAME_UPPER>_DATA_DIR` (e.g. `JUSTWRITE_DATA_DIR`);
  python override for scripts `<ABBR>_PYTHON` (e.g. `JW_PYTHON`, `JAID_PYTHON`).

## 2 · Root files — the exact contract

> **Tauri + Python — until the app moves** (JustWrite step 4, JustVoice step 5). An Electron
> app's scripts contract is §0.2; biome.json and CLAUDE.md below hold for both. In an
> Electron app index.html still carries no meta CSP — the policy is a response header from
> the shell's `app://` handler (§0.3) — and `.gitignore` also holds `data/` (§0.5).

**package.json scripts — these NAMES are the contract** (`npm run dev` opens the
DESKTOP APP in every repo; getting this wrong is the #1 confusion):

```jsonc
{
  "dev": "tauri dev",              // THE APP — window + sidecar-spawned server
  "dev:vite": "vite",              // browser-only dev loop (the app's OWN port — JW 1420 · JV 1430 · docgen 1450; P10)
  "build": "tauri build",
  "build:vite": "vite build",
  "preview:vite": "vite preview",
  "server": "cd server && node ../scripts/py.js -m <snake_name>.serve serve",
  "test:server": "cd server && node ../scripts/py.js -m pytest -q",
  "lint": "biome check .",   // biome.json includes gate the surface (src + scripts + vite config)
  "tauri": "tauri"
}
```

- **`scripts/py.js`** — the venv-python launcher: a thin adapter over the kit's
  `scripts/lib/exec-resolve.mjs` (target-tree P7) binding the app's env override and
  venv location (file-relative import — node scripts don't see the vite alias, so the
  kit sibling checkout is required here too). Bare `python` resolves to whatever is
  first on PATH and the failure reads as broken test config instead of a missing
  install.
- **biome.json** — copy from JW/i18n-docgen verbatim, including the `**/*.vue` override
  that turns `noUnusedImports`/`noUnusedVariables` OFF for SFCs (biome cannot see
  template usage; without the override every view file is a false positive).
- **index.html** — the app's real `<title>`; the CSP comment (headers come from
  tauri.conf, a meta CSP would break the IPC bridge); no scaffold logos.
- **.gitignore** — `node_modules`, `server/.venv`, `__pycache__`, `*.egg-info`,
  `.pytest_cache`, `.ruff_cache`, **and `dist/`** — corrected 2026-08-05 (s2
  audit): the old "dist/ is COMMITTED" line contradicted every app in the family
  (all three gitignore it). Reality: the release exe EMBEDS dist/; headless
  serving needs a prior `npm run build:vite` (or the bundled exe). Practice wins.
- **CLAUDE.md** — every app has one: what it is, the command block, "what bites",
  a Where-to-look table whose FIRST row points at this document.

## 3 · vite.config.js — the kit consumption contract

```js
resolve: {
  alias: { "@delebash/llm-ui": resolve(__dirname, "../just-llm-runner/ui/src") },
  // ONE copy of every peer — Reka provide/inject + Vue reactivity break with two.
  dedupe: ["vue", "reka-ui", "@floating-ui/dom", "pinia", "vue-router",
           "marked", "vue-sonner", "@vueuse/core", "@tanstack/vue-table"],
},
server: {
  port: 1420, strictPort: true,   // per-app pair: JW 1420 · JV 1430/1431 · docgen 1450/1451
  fs: { allow: [resolve(__dirname), resolve(__dirname, "../just-llm-runner/ui")] },
  // NO /v1 proxy (corrected 2026-08-05 s2 audit — this snippet used to show one):
  // nothing requests a relative /v1. The origin-aware resolver builds ABSOLUTE
  // URLs to the server port from dev, which is exactly why §6's CORS is
  // load-bearing. A proxy line here is dead config that misdescribes the wire.
  // WATCH IGNORES are part of the contract: the vite root is the repo, so guard
  // the big non-frontend trees or chokidar walks them (JV measured 500 ms → 6.2 s
  // to first HTML): ignored: ["**/src-tauri/**", "**/.venv/**", "**/e2e/**", "**/dist/**"]
}
```

The kit's peer deps go in THIS app's package.json (`ui/package.json` lists them; the
kit is consumed as source from the sibling clone — no publish step exists).

## 4 · Frontend standards

- **Vue 3 + `vue-router` in HASH mode** + **per-domain Pinia stores** (`stores/<domain>.js`).
- **`src/styles/tokens.css`** — copy the reference block from the kit's
  `common/tokens.contract.css` and retune values; **`src/styles/styles.css`** — layout
  only: the `height:100%` chain (NEVER `100vh`), ONE scroller per area.
- **Kit-first, always**: controls come from `@delebash/llm-ui` (`UiButton`, `UiInput`,
  `UiSelect`, `UiMultiSelect`, `UiCheckbox`, `Toast`…). **A missing capability is
  built IN THE KIT** on reka-ui primitives with the one-`intent` design contract —
  never app-local (UiMultiSelect is the precedent: born for i18n-docgen, owned by all).
- **`installLlmUi(app, …)` in `main.js` — the UI twin of `install_llm`** (2026-08-04).
  ONE call resolves the origin-aware base and feeds it to BOTH transports, wires the
  external opener, declares `capabilities`, and registers `<LlmUiHosts />`. Do not call
  `configureServerApi` / `configureLlmUi` / `configureExternal` by hand: each was a step
  a host had to know about, and every omission failed SILENTLY — the two base URLs
  disagreeing made every kit LLM view render empty IN PRODUCTION ONLY (`configureLlmUi`
  with no baseUrl falls back to `window.location.origin` = `tauri.localhost` in the
  packaged webview, found live 2026-08-03).

  ```js
  installLlmUi(app, {
    devPorts: ["<DEV_PORT>"], fallbackBase: "http://127.0.0.1:<PORT>",
    capabilities: { embeddings: false },        // what this app's stack does
    catalogCopy: { … },                          // this app's words
    external: async (url) => (await import("@tauri-apps/plugin-opener")).openUrl(url),
  });
  ```

  The opener stays the APP's — `@tauri-apps/plugin-opener` is a Tauri dependency and
  importing it inside the kit breaks every non-Tauri consumer's build (measured
  2026-08-04). Tauri swallows `target=_blank`, so a desktop app that passes none has
  silently dead external links; the kit warns loudly in a webview when that happens.
- **`<LlmUiHosts />` in the shell, and the AI-tasks row from `useAiTasksNav()`.** The
  hosts are one tag because the failure mode was mounting SOME of them: with no
  `<AppDialog/>`, `confirmDialog()`'s promise never settles and every confirmed action
  is a dead button. The nav row is a composable, not a component (each app styles its
  own nav) — spread its `navAttrs` so the row cannot be rebuilt without
  `data-panel-toggle`, whose absence made the panel open and instantly close.
- **Wire shape: camelCase** — matching the shared stack's `CamelModel` contract.
- **NAME YOUR DONOR** (user-ruled 2026-08-03, after a hand-rolled disk-usage panel
  shipped beside JW's canonical one): before writing ANY UI element, name where it
  already exists — a kit export, a JW section, a JV section. Hand-writing is allowed
  only after that search comes up empty, and the new piece is then usually born in the
  kit. Copy donors WHOLE — strings, confirms, loading states — never a lookalike.
- **TitleBar** — the KIT's `common/components/TitleBar.vue` frame (back/forward over
  the router's history state with the post-nav settle, the centred title, window drag
  with no-drag on its buttons and slotted content, disabled-reason tooltips); the app
  fills the right side via the slot (JW: theme/mode/undo/chat cluster · docgen: mode
  cycler + `AiStatusButton`). Every app carries one; a shell without a native-feel
  title row was ruled a divergence (2026-08-03). JW's `components/TitleBar.vue` was
  the donor and now WRAPS the frame like its siblings (2026-08-07) — this line named
  it as the canonical implementation long after the kit had absorbed it, which kept
  the donor from converting.

## 5 · The Tauri shell

> **Tauri — until the app moves** (JustWrite step 4, JustVoice step 5). An Electron app's
> shell is the kit's `runDesktopApp` (§0.3). The three doors and the bridge rule at the end
> of this section hold for both kinds.

**tauri.conf.json**: `productName`, `version`, `identifier` (§1),
`build.beforeDevCommand: "npm run dev:vite"`, `beforeBuildCommand: "npm run build:vite"`,
`frontendDist: "../dist"`, one window (title = productName, 1440×900 min 1000×640,
`backgroundColor` = the app's `--surface-2`), `security.csp: null`, bundle icons +
descriptions.

**The sidecar — the shell's whole job** (`src-tauri/src/lib.rs`): the desktop window
spawns the Python server on startup and kills it on close. The canonical implementation
is JW's `lib.rs` §"Python server sidecar" (JV is the original precedent; i18n-docgen is
the constants-only port). A new app copies it changing **exactly three constants**:
`SERVER_PORT`, `SERVER_BIN` (`<kebab-name>-server`), `DATA_DIR_ENV`. The pattern:

- **Portable data root** (the §6 family policy, resolved here in Rust because the
  shell runs before the server): `data/` beside the exe when writable, else the OS
  app-data dir; a `dataroot.txt` pointer (outside the root, atomic tmp+rename writes)
  records ONLY an explicit user override; `storage_get_root`/`storage_relocate`
  commands do the crash-safe move (copy → rename → pointer commit → delete old).
  **Never write the computed default into the pointer on first run** — that lock
  pinned JustVoice installs to an obsolete default and vetoed the new one silently;
  a pointer equal to a computed/former default is deleted as residue on resolve.
- **Spawn arms**: debug prefers `server/.venv/…/<name>-server(.exe) serve` resolved
  from `CARGO_MANIFEST_DIR/..` (so `npm run dev` works from ANY shell), then PATH,
  then `python -m <snake_name>.serve serve`; release spawns the bundled exe beside the
  app. Always with `DATA_DIR_ENV` set.
- **Port eviction**: a stale listener on the port is killed before spawning
  (netstat/taskkill · lsof/kill); still-occupied → reuse with a loud warning.
- **Never spawn the unqualified app name** — the Tauri binary shares it, and Windows
  resolves it to OUR exe first: an infinite window-spawn loop (JW's lesson).
- **Escape hatch**: `<ABBR>_DEV_NO_SIDECAR` env skips the spawn for manual-server dev.
- **Teardown**: `WindowEvent::CloseRequested` → kill the child — unless the §11
  keep-server-running switch is ON, in which case the window hides to the tray
  and the server stays (the family tray rides every app since 2026-08-04).
- **Plugins — the baseline is FIXED and identical in all three apps** (2026-08-15,
  enforced by `scripts/check-family.mjs`): `tauri-plugin-opener`,
  `tauri-plugin-dialog`, `tauri-plugin-window-state`. Nothing else, unless a
  feature genuinely needs it AND every app declares it too — the guard fails on
  differing plugin sets, and fails again on a plugin declared in `Cargo.toml` that
  `lib.rs` never initialises. That check exists because `http`, `fs` and `process`
  sat init-only in two shells for months: declared, permissioned, never used.
  The old wording here ("added when a feature needs them, not by default") is how
  three apps ended up with three different surfaces.
- **Capabilities**: the permission list is identical across the apps too — the same
  guard compares them. Today: `core:default`, `dialog:default`, `opener:default`,
  and `opener:allow-open-path` scoped `**` (the model catalogs' "Open folder").

### The three doors a renderer may use to reach the shell

Each is ONE implementation, and the guard fails anything that goes around them.

1. **Opening a URL or a folder** — `@tauri-apps/plugin-opener`, handed to the kit
   as the same one line in every app:
   `installLlmUi(app, { external: { open: openUrl, openPath } })`. The kit decides
   browser-vs-webview (`common/services/external.js`); no app repeats that test.
   Never hand-roll a per-platform `explorer`/`open`/`xdg-open` spawn, and never use
   `tauri-plugin-shell`'s `open` for a path — its default scope admits
   http(s)/mailto/tel only, so a filesystem path is rejected.
2. **Calling a command** — `src/services/native.js`, one thin export per
   `#[tauri::command]`, so a command's name-as-a-string exists in exactly one place.
   `@tauri-apps/api/core` is imported THERE and nowhere else. Commands throw;
   callers use try/catch, and a cancelled dialog resolves `null`.
3. **Putting a file on disk** — the kit's `saveBlob`/`downloadBlob`
   (`common/services/fileSave.js`): native dialog where the host wired one via
   `configureFileSave`, browser download otherwise. `a.download = …` anywhere in an
   app is a guard failure. (JustVoice had five copies of it, one per view.)

**Native dialogs are Rust commands, not the JS dialog plugin** — one capability
surface, and a dialog cannot end up at two different layers across three apps.
`pick_directory` is the shared example; copy it verbatim.

**One bridge object (`window.appShell`), read only by `services/native.js`** (this rule
replaced "no `window.<app>` global", 2026-10-08). In an Electron app the kit's preload
installs that one object (§0.3); `native.js` is the only file that reads it, and the rest
of the renderer imports `native.js`. A Tauri app has no bridge object — its door is
`@tauri-apps/api/core`, imported in `native.js` alone. Either way **the renderer installs
nothing on `window`**: apps import modules. A `window.<appname>` bridge was the shape of
JustWrite's Electron-era shim, deleted 2026-08-14 — the guard fails it (check 13), and fails
a `window.appShell` read outside `native.js` (check 12).

## 6 · The Python server

> **Python — until the app moves** (JustWrite step 4, JustVoice step 5). An Electron app's
> server is §0.4 and its data ladder §0.5; the data-location policy, bearer auth and the
> error-envelope-before-CORS rules below hold for both kinds in meaning.

```
server/
├── pyproject.toml          # flat discovery: include = ["<snake_name>*"]
├── <snake_name>/           # the import package — flat layout (§7)
│   ├── app.py              # create_app(data_dir, ...) + boot_llm_stack(...)
│   └── serve.py            # main(): `<name>-server serve` (+ flags)
├── tests/                  # pytest; testpaths = ["tests"]
└── .venv/                  # gitignored
```

- **Console scripts**: `<kebab-name>-server = "<snake>.serve:main"` taking a `serve`
  subcommand (the shell and npm scripts use that form). The `-server` suffix is
  MANDATORY — an unsuffixed name collides with the Tauri binary (§5).
- **Data dir — THE family policy, one implementation** (user ruling 2026-08-14:
  *"all that can be the same should be, this includes how data is stored"*).
  `paths.py` is a THIN CALL into the kit, never a re-implementation:

  ```python
  from llm_runner.platform import resolve_data_dir
  SOURCE_ROOT = Path(__file__).resolve().parents[2]      # the checkout root

  def default_data_dir() -> Path:
      return resolve_data_dir(app_name="JustWrite", env_var="JUSTWRITE_DATA_DIR",
                              source_root=SOURCE_ROOT)
  ```

  The ladder: `--data-dir` flag → `<SNAKE_UPPER>_DATA_DIR` env (the user's
  choice; also how the shell hands down a Change-folder selection) → **`data/`
  in the install directory** (frozen: beside the exe; source: beside the
  checkout root) → the OS app-data dir ONLY when the install dir is not
  writable. **Nothing may land anywhere the user did not choose** — the
  app-data arm is a read-only-install necessity, never the default.
  The shell implements the identical ladder in Rust (§5) because it resolves
  the root before the server exists, then sets the env var; keep the two in
  lock-step. The shell must NOT write the computed default into
  `dataroot.txt` on first run — that lock pinned JustVoice installs to an
  obsolete default and silently vetoed the new one; the pointer records ONLY
  an explicit Change-folder, and one equal to a computed/former default is
  deleted as residue. `data/` is gitignored in every app.
- **Tooling**: `ruff` (line-length 100, `target-version = "py310"`), `pytest`.
  `requires-python >= 3.10`.
- **llm-runner is NOT a hard dependency** — editable in dev (`pip install -e
  ../../just-llm-runner`, so a git pull is live), pinned tag in a `bundle` extra
  (JW's pyproject comment is the canonical text). Pin instead when you do NOT run that
  consumer's suite routinely.
- **Bearer auth for the headless path** (JW `auth.py` is the donor, storage seam per
  app): headless serving is a first-class way to run every server — so every server
  carries the token middleware (OFF while the token list is empty; loopback exempt
  unless required) + a Settings → Server section to manage tokens. Added BEFORE CORS
  so CORS wraps auth's 401/403.
- **Error envelope + CORS, in that order** (JW's `app.py` is the canonical text): a
  catch-all `@app.middleware("http")` that turns unhandled exceptions into JSON 500s,
  registered BEFORE `CORSMiddleware` (allow-all fallback), so errors flow OUT through
  CORS. Both are load-bearing for the browser dev loop: the kit's origin-aware resolver
  hits the server port DIRECTLY from Vite dev, so a server without CORS fails silently —
  and no TestClient test can see it (same-origin). The test that bites sends an
  `Origin:` header and asserts `access-control-allow-origin` comes back. Found live
  2026-08-02: the i18n rewrite shipped 126 green tests and zero working browser
  requests.

## 7 · Why `server/<name>/` repeats the app name (the JS-vs-Python trap)

> **Python — until the app moves.** An Electron app's server is `server/src/` — the
> JavaScript case this section's first sentence already calls correct.

In JS, `server/src/` with no name is correct — Node imports by FILE PATH and the name
lives in package.json. **Python imports by NAME**: the package folder's name is the
import statement, the console-script target, and what pip installs. Name it `src` and
every family app is `import src` — no two could share a venv (they do: llm-runner's
suite runs in JW's venv). PyPA (packaging.python.org, "src layout vs flat layout",
verified 2026-08-02) defines exactly two standard layouts and the package directory
carries the project name in BOTH. **The family ruling is FLAT** (`server/<name>/`) —
the USER's explicit decision with src-layout fully costed and declined: these servers
are never-published PyInstaller-frozen applications, src-layout's benefits target
published libraries, and the top tier splits anyway (pip/Poetry/Flask src; FastAPI/
Django/NumPy flat).

## 8 · Adopting the shared LLM stack (llm-runner)

The standard is `install_llm` — three lines plus seeds, identical in every app
(README "Consume it" has the full tiers; this is the app recipe). **The Python recipe holds
until the app moves**; an Electron app's server calls the JavaScript twin,
`installLlm(app, { db, dataDir, product, featureCatalog, … })` (`../server/README.md`,
"Consume it") — same routes, same JSON, same tables. The rules below hold for both.

```python
app.include_router(llm_runner.router)                 # the host's line
install_llm(app, engine=…, session_factory=…, data_dir=data_dir,
            feature_catalog=FEATURES,                 # this app's actions
            feature_prompts={} or PROMPTS,            # {} if the app builds its own
            engine_presets=…, feature_presets=…, default_preset_id=…)
seed_llm()                                            # idempotent, insert-if-missing
load_from_configs(stores.get_provider_store().list()) # registry from the DB
```

- **Features → engine presets, one-source**: each action points at a preset owning
  provider+model+temperature/think/samplers. Tunables NEVER live in app config files.
- **Structured output**: hand adapters the OpenAI `response_format` shape via `extra`
  — the adapters own per-provider translation (Ollama converts it to `format` itself).
  A hand-built per-provider fork DEFEATED that routing once; found live (2026-08-02).
- **App-owned settings** (reviewer name, etc.): the host's OWN table on its OWN
  declarative Base, same engine/session — one database, two Bases (the pattern
  llm-runner's db.py documents; `appmeta.py` in i18n-docgen is the reference).
- **A routeless door** (CLI) boots the same stack with `install_llm(None, …)` —
  first-class headless: storage, seeds, registry, runner wiring, no routes. Presets
  resolve through the stores; nothing works before storage is configured. (The first
  consumer re-implemented this against private imports; the capability went upstream
  instead — 2026-08-02.)
- **Pass `product=`, and let the user share one AI cache.** `install_llm(…,
  product=PRODUCT)` records this app's cache location in the family registry
  (`%LOCALAPPDATA%\just-ai\caches.json`), which is how the NEXT app's Quick Setup can
  offer to share the engine + models already on the box instead of downloading them
  again — the same model in two apps' caches was 14.2 GB twice, measured. The app's
  wizard asks (`GET`/`PUT /v1/ai/engine-cache`); the answer is a recorded CHOICE and
  never moves a file, so it is reversible in one click. What the app GENERATES —
  `models.ini`, spawn logs — moves to `<data_dir>/ai-runtime` whenever the cache is
  shared, because each app renders that ini from its own catalogue. Anything measuring
  or clearing engine files must read `service.cache_root` / `service.runtime_root`
  (via `configured_service()`), never `<data_dir>/ai-cache`. Two guards keep the
  registry honest (2026-08-08): a cache root under the OS temp dir is never registered
  and never surfaces from a read — a smoke gate boots a real server on a `%TEMP%`
  snapshot, and one surviving scratch got itself offered as "JustWrite Server already
  has the engine", repointing the real install's cache at a Temp dir with one proceed
  click (`JUST_AI_HOME` opts a harness out, which is also how the suite's tmp-rooted
  tests keep running); and the wizard only offers a sibling cache that holds MODELS —
  the question exists to skip model downloads, so an engine-only cache is not worth
  switching roots for. A harness that boots a server on a scratch data dir must ALSO
  set `JUST_AI_HOME` to the scratch (JW's `scripts/smoke.js` is the precedent), not
  lean on the temp-dir net.
- **The engine's port is allocated, so never print, probe or configure `:8080`.**
  `find_free_port` binds the first free port from 8080 up; the live URL is
  `RunnerService.router_url()` and it is what `/v1/llm-runner/status` reports. Nothing
  app-side may rebuild that URL — the `local-llamacpp` provider row's `baseUrl` is a
  seeded fallback that the running engine overrules. This exists because every app
  hardcoded 8080 and the second app's traffic silently reached the first app's engine
  (the 2026-08-03 JustWrite "corrupt install" that was neither).
- **API namespace: EVERYTHING under `/v1/*`** — app routes beside the shared stack's.
- **Tests**: never hand `install_llm` an in-memory StaticPool DB (the backfill daemon
  thread silently rolls seeding back) — file-backed SQLite; reset `lifecycle._service`
  and `seed._APP` per test. `just-llm-runner/tests/test_install_llm.py` is the
  hermeticity reference.
- **After any shared-export change** run llm-runner's `scripts/check-consumers.py`;
  after any dep/`__init__` change there, `scripts/check-clean-install.py`.

> **The install SEQUENCE — both halves, step by step — is
> `docs/dev/install-runbook.md`** (user-ruled 2026-08-08: one page a human and
> an AI can follow into a new project). This section is the depth behind it.

### The AI-call convention (2026-08-08) — app code never owns a task lifecycle

Born the hard way: the LLM core converged (every app runs `run_action`), the task
store converged (2026-08-07), and still no JustVoice LLM task had ever shown a
token — because no rule said how app code CALLS AI, so 17 sites hand-managed
their own lifecycles and every one dropped `finish({usage})`. Ten structural
audits passed over it; there was no contract to audit against. This section is
that contract, and check-family's **check 11** enforces the greppable half.

**The rule.** App code never calls `tasks.start()` / `finish()` / `fail()`.
Every AI or long-task call goes through a kit runner:

- **`runAiFeature` / `runAiFeatureStream`** — features whose variables are in
  the renderer's hand (an editor selection, a chat message, fetched context
  passed along). Posts the shared `/v1/ai/run|stream`; streaming, tokens,
  cancel, errors all automatic. JustWrite's writer + RAG features are the
  reference consumers.
- **`withAiTask(opts, fn)`** (+ the `runAiEndpoint` JSON convenience) —
  everything else: server-composed endpoints (the server gathers roster /
  corrections / files and post-processes the answer), TTS renders and
  generates, engine installs, exports, poll-loop jobs, batch owners (one task,
  N sub-calls, `setProgress(n, m)`). The wrapper owns start / finish-with-usage
  / abort-classification / error wrapping; the callback keeps full domain
  freedom and returns `{ result, usage }` so tokens surface.

The lane is chosen **per feature, never per app** — every app has both kinds.
Where composition lives is the feature's business; the seam below it is
identical everywhere.

**Corollaries.** Every AI response carries usage (JustVoice's §16 rule,
family-wide; `toTaskUsage` accepts snake_case and camelCase so nobody
hand-maps). A surface shows **one** task indicator per run — a surface that
mounts its own `AiTaskStrip` marks the task `inline: true` so the global stack
never doubles it; hand-rolled progress banners are banned. A trigger button
**disables** while its task runs — the strip is the spinner. Reads are free:
chrome may observe the store (`visibleTasks`, `runningCount`) from check 11's
per-app allowlist; creating lifecycles outside the runners is the violation.

**Why a check and not just this text:** every seam that had only prose drifted;
the seams with a canon + a gate (familyContract.js labels, the target tree)
held. Rules that matter get a check — the doc explains why.

## 9 · Retrofitting an EXISTING Python app — a COMPLETED migration, not a second path

> **Nothing here is outstanding. Every app in the family consumes the stack
> identically** — code-verified 2026-08-07: JustWrite, JustVoice and i18n-docgen each
> mount `llm_runner.router`, then call `install_llm(app, engine=…, session_factory=…,
> feature_catalog=…, feature_prompts=…, engine_presets=…, feature_presets=…,
> default_preset_id=…, product=PRODUCT)`, then `seed_llm()`, then the byte-identical
> `load_from_configs(stores.get_provider_store().list())`. Only the DATA each passes
> differs, which §11 rules is per-app BY DESIGN.
>
> This section was headed "the JV path" until 2026-08-07, and that name did real
> damage: it read as though JustVoice were a permanent exception, so a structure audit
> spent a session treating "JustVoice consumes llm-runner differently" as an open
> question when the migration had been finished since 2026-08-05. A section describing
> a completed one-time job must say so in its title.

The recipe below stands for the NEXT app that arrives with a server already built —
JustVoice is its worked example, not its owner.

Full convergence, in order: (1) delete concepts the shared stack replaced (JV's
`llm_roles`); (2) adopt `install_llm`, replacing à-la-carte mounts; (3) migrate
providers from app settings into the DB store, one-time, idempotent by id; (4) boot
the registry from the DB; (5) rename any same-name app tables that collide with the
shared schema (JV's `feature_prompts` → `jv_feature_prompts`); (6) stand up a runnable
suite — convergence without one just resets the rot clock. JustVoice commits
`14b3ea7`/`aa1363f` are the worked example.

## 10 · The e2e harness — the real webview is the acceptance surface

> **The tauri-driver harness — until the app moves** (JustWrite step 4, JustVoice step 5).
> An Electron app's harness is Playwright's Electron driver (§0.7). The principle — the real
> app is the acceptance surface, a Chrome tab is a proxy — and the root script names hold
> for both kinds.

A Chrome tab on the vite port is a PROXY: the app ships in WebView2, and "it looks
right" claims are made against the window, never the proxy (user-ruled 2026-08-02,
after exactly that mistake). JustWrite's `e2e/` is the canonical harness — copy its
SHAPE verbatim; only the app binary path changes:

```
e2e/
├── package.json            # zero deps; postinstall = scripts/fetch-driver.js
├── lib/driver.js           # ~190-line raw W3C WebDriver wrapper (verbatim from JW)
├── scripts/fetch-driver.js # Edge-version-matched msedgedriver download (verbatim)
├── tests/*.test.js         # node --test smoke suite against the REAL app
├── capture-direct.js       # screenshot every surface → e2e/shots/ (gitignored)
└── drivers/                # msedgedriver.exe (gitignored, version-coupled)
```

- **How it works**: `tauri-driver` (cargo-installed, :4444) + `msedgedriver` attach a
  normal WebDriver session to the WebView2 inside the real window — navigate, exec,
  click, screenshot. Direct HTTP, no WebdriverIO (JW measured v8 AND v9 failing the
  session handshake; ~120 lines of fetch is deterministic).
- **Root scripts**: `"test": "npm test --prefix e2e"`, `"screenshots": "node
  e2e/capture-direct.js"` — same names in every app.
- **It drives `target/release/`** — build with `npm run tauri build -- --no-bundle`
  first; the binary is whatever was last built.
- **Hermetic by default**: the smoke suite sets `<ABBR>_DEV_NO_SIDECAR=1` so a test
  run never evicts your dev server or spawns strays; capture does the same so shots
  can use a demo-data server you started deliberately.
- **What smoke asserts is the CONTRACT, not pixels**: shell mounts, nav works, and
  any user-ruled UI behaviour holds (e.g. i18n's "the whole Setup form is visible with
  an explicit Check-path button") — rulings become assertions so they cannot silently
  regress.

## 11 · The standard app chrome — every app carries these, no exceptions

Ruled 2026-08-03 after the i18n rewrite shipped its workflow with NONE of this — the
user had to ask "are you bringing in the data directory, the style changer, the ai
progress cancel, the logs?" The answer must never again be no. Each row names its
canonical implementation; all of it is kit/platform code — the app writes wiring only.
**Canonical WORDS live in `ui/src/common/familyContract.js` (FAMILY_LABELS), never in
this document** — this section names components and shapes; the manifest is the one
source the kit components read their own defaults from, and the contract tests
assert. (2026-08-04: §11 stopped restating label words.)

**The governing principle (user's words, law — parity batch 2026-08-05):**
*Same function ⇒ same kit surface and mechanism, in every app — including
JustWrite.* The DATA each app feeds the mechanism (model catalogs, presets,
prompt rows, per-app options, app-specific settings sections) is per-app BY
DESIGN. Parity of surface is mandatory; parity of content is wrong. **No
escape valves:** a "verify at build, else fall back" clause is not an outcome
— if a kit surface can't host an app's need, THE KIT GROWS until it can
(SettingsShell, UpdatesPanel, and JW tray localization were each committed
this way; bespoke twins are the deviation class this section exists to stop).

**The copy law (parity batch):** every user-facing label and description
speaks OUTCOMES in the user's words — internal vocabulary (tier / action /
preset / row / pipeline / variant / manifest / pin) never reaches the screen.
Prompt-row labels live in each app's DB seed (recorded limit: vue-i18n cannot
reach DB rows; row-label localization is a future family design).

**The Settings canon (from code, 2026-08-06):** the seven family sections
keep this RELATIVE order wherever they appear —
**Appearance · Backups · Storage · Server · Logs · Updates · About**
(`FAMILY_LABELS.settingsSections` is the word source). App sections may
lead, trail, or interleave freely: JW leads with Project; JV leads with
General and trails its voice-domain sections (Mastering → Webhooks); docgen
interleaves Reviewer before About. Every app renders them through the kit
`SettingsShell` (all three adopted, parity slices 3/4/6); Server is the
headless-URL + bearer-token + keep-running section in every app.

**The AI-console canon (from code, 2026-08-06):** one route (`/ai`), one kit
`AiModelsArea`. The strip is providers · (models, via the opt-in `modelsTab`
split) · Routing by feature · usage · console, plus the app's HOST TABS via
`appTabs` (`[{id, label, after}]` — `after` anchors each into the strip;
`#app-tab-<id>` slots carry the content; tabs mount lazily on first visit).
Words relabel per app ONLY through the labels feed (`configureFamilyLabels`
— JV says "LLM providers"/"LLM models" because it has two provider kinds;
siblings keep the canon words). Deep links: `initialTab` (?tab=) and
`initialFeatureAction` (?action= → the Workbench focuses that action row) —
both one-shot, consumed off the URL on mount. The Lab runs an app's REAL
pipeline through the `labAdapters` seam (installLlmUi option, keyed by
FEATURE: `{run(body,{signal}), render, configExtra}`) — JV's speaker
attribution is the reference adapter; without one, columns run the generic
`/v1/ai/run`.

| Chrome | Canonical | App writes |
|---|---|---|
| **AI area** (providers CRUD, model catalog + downloads, presets, usage/tokens) | kit `AiModelsArea` — host tabs via `appTabs` (JV mounts two speech tabs), `modelsTab` split opt-in, `labAdapters` for real-pipeline Lab columns | one route (`/ai`), one component |
| **Global AI progress + cancel** | kit `AiStatusButton` → `AiStatusPanel` in the TitleBar, PLUS a sidebar nav row "AI tasks" toggling the same panel with a count/error badge (JW `Sidebar.vue:148`). Finished tasks LINGER per `FAMILY_TASK_LINGER` (familyContract.js — completed 5 s · cancelled 3 s · failed until dismissed, the store default since 2026-08-07); the panel splits Running / Recent; failed rows carry the error + Retry until acknowledged | one mount + one nav row |
| **TitleBar** | kit `TitleBar` frame (lifted from JW 2026-08-04; drag + tooltips folded up 2026-08-07) | the right-side slot: mode, status chip, app cluster |
| **Settings page** | kit `SettingsShell` (TOP TABS — the contract killed the rail, 2026-08-04) over JW's `/settings/:section?` pattern | sections as data + panels below |
| **First AI contact** | kit `AiSetupOffer` — the ONCE-EVER modal (ruling R3 2026-08-04; permanent setup buttons are retired), host persists the flag + routes the emits | one App-level mount + one flag |
| — Appearance | kit engine + catalogs (`UI_FONTS`, `ACCENT_PRESETS`, `UI_SCALES`); JV panel shape | mode/font/accent/scale controls over `applyAppearance` |
| — Storage | shell `storage_get_root`/`storage_relocate` (§5) + shared `make_disk_router(data_dir)` | path display, relocate control, usage table |
| — Logs | platform `install_log_ring()` + `install_file_log()` + `make_logs_router(name)`; kit `LogsPanel` | 3 server lines, one component |
| — Server | JW's headless/auth section: headless URL + bearer tokens over the app's auth endpoints | one panel |
| — About | version, repo | one panel |
| — Backups (backup/restore/reset) | platform `make_data_router` + kit `DataManagement` (adopted in all three, parity slices 4-6; per-app skip options via the `options` seam → `?exclude=`) | asset roots + on_replaced + option rows |
| — Updates | kit `UpdatesPanel` (+ `#actions` slot for an app's own updater verbs) | one panel + a whats-new loader |
| **Tray + keep-running** (family headless ruling 2026-08-04 + the full-donor ruling 2026-08-05; JV is the donor) | tray icon (app icon), left-click toggles the window, menu = the donor WHOLE with JV's emoji: 📺 Show window · 🔵 Hide window · ▶️ Start server · ⏹ Stop server · 🔄 Restart server · ⚙️ Open settings · 📋 Copy server URL · 📜 Open log file · ℹ️ About <App> · 🚪 Quit <App> (app-specific entries like JV's dictate/MCP stay that app's) — every entry WORKS: settings/about/copy show the window and ride `tray:*` renderer listeners (a focused webview's clipboard write is reliable; a hidden one's is not), Open log file opens the server's live log Rust-side, Quit kills the sidecar (JW: through its D5 drain); `keep_running_on_close` in the shell + `set_keep_server_running` command; Settings → Server carries "Keep server running after the app closes" — OFF ⇒ closing stops everything, ON ⇒ hide to tray, server stays; the renderer persists the flag and re-applies it every boot. Tray text is English in every app for now — a NOTED localization gap | the tray block + the four `tray:*` listeners + the toggle row + one persisted flag |

Server wiring is JW's exact lines, ring BEFORE app construction:

```python
install_log_ring()
install_file_log(data_dir / "logs" / "<kebab-name>.log")
app.include_router(make_logs_router(PRODUCT))
app.include_router(make_disk_router(data_dir))
```

**In an Electron app (§0.3) the chrome is the same; where it lives moves.** The tray (its
labels through `setTrayLabels`), keep-running (`setKeepRunning`), "Open log file" (the
shell's `logFile`) and the Storage verbs (`storageGetRoot` / `storageRelocate`, which
replace §5's Rust commands) are the kit shell's; the server lines above are the kit's
JavaScript twins (`installLogRing`, `installFileLog`, `makeLogsRouter`, `makeDiskRouter`).

**PORTING A DONOR MEANS PORTING ITS STATES, NOT ITS SHAPE.** Naming the donor in a
comment is not checking it. Before writing a surface that copies one, read the donor's
answers to these and copy them or record a deviation:

- what happens on **error**, on **cancel**, and when the work is **already done**?
- what is **clickable while the work runs** — and what does the donor deliberately
  disable or omit then?
- which of its calls are **awaited to a terminal state** vs watched?

The i18n wizard (2026-08-03) is the cautionary case: it named the kit's `QuickSetup`
in its header, copied the look, and invented its own completion — a `busy` flag plus a
watch on a derived model status. That has one happy path, so an already-resident model,
a failed or cancelled engine install and a cancelled download each left "Working…"
forever, and a footer Cancel sat beside the bar's own Cancel meaning something else.
The donor answered all four questions already. Reading it took ten minutes; not reading
it cost a rewrite and shipped a routing-corrupting bug behind a success toast.

**Setup wizards**: since the surgery (2026-08-04) there is ONE wizard — the kit's
`QuickSetup` (LLM chat/embedding) — voiced per app through `quickSetupCopy` (the
copy seam) and gated by `llmUiCapabilities` (embeddings hidden where an app has
none); `AiModelsArea` mounts it inline and the `wizard` prop exists only for a
DIFFERENT wizard kind (JV's TTS wizard is app-local — a different pipeline, not a
fork). i18n's 359-line fork is DELETED; forking the kit wizard again is the
deviation class this section exists to stop. Its step machine advances on
TERMINAL TASK STATES (`done` | `error` | `cancelled` from `createDownloadTask`),
never on a watched model status — a derived status cannot report three of those
four outcomes. During a run the footer carries no buttons and the modal is
`:closable="false"`, so each `DownloadBar`'s own Cancel is the only cancel on
screen. Trap, found live (i18n 2026-08-03): `setAsDefault(providerId, modelId)` —
the FIRST argument is the PROVIDER (`setAsDefault(LOCAL_RUNNER_ID, id)`).
Passing the model alone rewrites every task preset's `providerId` to a model id
and then toasts success; no smoke test catches it, because none completes a
model load.

**The once-ever AI offer** (ruling R3, 2026-08-04 — JW's donor is THE family
shape; permanent "set up AI" buttons and boot-splash strips are retired): the kit
`AiSetupOffer` modal, fired ONCE EVER off a persisted flag, at the app's
first-project moment — JW right after the user creates/opens their first
project, i18n at Setup's first successful save (the boot-time approximation
popped over live dialogs and died 2026-08-05). Gate the no-AI check on
NO DEFAULT PROVIDER AT ALL (`currentDefaultProviderId` empty) — gating on
`currentDefaultId` is wrong: that value is local-gated, so an online-default box
reads as "no AI" and gets nagged.

**The boot splash + warm start** (2026-08-04, born from a real divergence): the splash
PAGE is per-app — the brand plate, where the load group sits on it — but everything
INSIDE the load group is the kit's `<BootModelLoad />` (engine bar → model bar **titled
with the model name**, one Continue, auto-dismiss on resident), driven by the kit's
`startWarmOnBoot()` which the app **awaits BEFORE `app.mount()`** (JW main.js is the
donor; pass `skip` for boots that must never warm, e.g. JW's bench). The app's overlay
`v-if`s on the kit's `warmModelId`. `index.html`'s static pre-JS layer shows the SAME
plate image with the same fit — no spinner, ever — so boot is one continuous image:
static plate → Vue splash → shell. A load that ends in error renders the control's
`#failed` slot under the bar (props `{ task, modelId }`; `task.retry()` is the bar's own
Retry) — the app's own help for that failure. JustVoice fills it with an offer to stop
speech engines left over from an earlier session, which had been holding the GPU memory
the model needed (2026-09-29). Hand-copying the load group per app is how one
consumer got a model-ID title divergence, a spinner-then-plate double splash, and a
shell flash between them; the control exists so none of that can be rebuilt.

**Prompt ownership + the Lab** (2026-08-04): the ENGINE PRESET — provider · model ·
every ask-param — and its whole editing surface (the Feature Workbench's Lab, columns,
Save-as-preset, "Use in production") are the KIT's. The FEATURE LIST is the app's, and
every feature is one of two kinds: **prompt-row-owned** (JW's writing actions — editable
system/user templates that save and apply) or **pipeline-owned** (`feature_prompts={}` —
the app builds the real prompt in code each run). A pipeline-owned app implements the
family contract `POST /v1/ai/prompt-preview {feature, lang?, keys?} → {system, user,
sample}` — the REAL builders over a small live sample. The default sample is the
BUSIEST language's pending keys, and a FINISHED language samples already-translated
keys with `sample` saying so (ruling 2026-08-04: the Lab always renders on a healthy
project — a preview that 400s because the user's work is done punishes success).
Loud NAMED 400s are for genuinely broken states only: no targets configured, an
unknown feature, explicit keys that don't fit, a catalogue with no keys.
(`lang`/`keys` are server-accepted extras; the kit's Workbench
sends only `{feature}` today — `FeatureWorkbench.vue:235`.) The optional
`dataLinks` prop (`[{label, href}]`, forwarded AiModelsArea → Workbench → Lab)
lets a pipeline app link the DATA its builder assembles — context · glossary ·
notes — under the generated prompt ("Change what this prompt says:", manifest
`lab.changeData`); apps that pass nothing render nothing. The kit's Lab shows it read-only (unlockable per-column copies,
ephemeral, never saved) above the same preset columns every app gets. `jsonMode` is
prompt-row state, so pipeline-owned features carry no JSON toggle: the app's adapters
own `response_format` (the 6-keys-exhausted lesson). A registered feature that never
calls the engine is a LIE on the routing surface — register it the day it routes.

And the test is CONTENT, not mounting: log a marker line, fetch `/v1/logs/tail`,
assert the marker (a 200 from an empty ring proves nothing).

## 12 · Definition of done — a new app ships when every box checks

> **The Tauri + Python rows — until the app moves** (JustWrite step 4, JustVoice step 5). For
> an Electron app read them through §0: `test:server` is vitest through `scripts/node24.mjs`
> (no venv, no ruff); "tauri.conf" becomes `electron/main.js`'s required fields (§0.3);
> "closing the window kills the Python process" becomes "closing the window stops the
> server — no orphan on :PORT"; the e2e row drives the Electron app (§0.7); and `npm run
> build` produces the installer, which installs and starts (§0.6).

- [ ] `npm run dev` opens the DESKTOP APP with the server spawned by the shell
- [ ] `npm run dev:vite` + `npm run server` = the browser loop on the app's OWN dev port (JW 1420 · JV 1430 · docgen 1450 — P10; the kit's origin-aware resolver hits the server directly, no proxy)
- [ ] `npm run test:server` green from a fresh clone (`scripts/py.js` resolves the venv)
- [ ] `npm run lint` (biome, the pinned family version) and server `ruff check` clean (the pinned family `select` — P10)
- [ ] `npm run build:vite` clean (`dist/` is gitignored build output); the server serves it headless
- [ ] tauri.conf: real productName/identifier/title; sidecar constants set; port claimed in §1
- [ ] Closing the window kills the Python process (no orphan on :PORT)
- [ ] All routes under `/v1/*`; wire shape camelCase
- [ ] Kit-first UI; any new control landed in `@delebash/llm-ui`
- [ ] Boot: static index.html plate (no spinner) → pre-mount `startWarmOnBoot()` →
      app splash hosting the kit `<BootModelLoad />` — ONE continuous splash
- [ ] `install_llm` + seeds + registry boot per §8; presets own every tunable
- [ ] Error envelope + CORS per §6, with the Origin-header test that bites
- [ ] `e2e/` harness per §10; `npm test` (smoke, real webview) green against the
      release build; `npm run screenshots` captures every surface
- [ ] The standard app chrome per §11: `/ai` area, AiStatusButton, Settings with
      appearance/storage/logs/about, log ring + file + router with the content test
- [ ] Every AI/long-task call goes through a kit runner per §8's AI-call
      convention — no `useAiTasksStore` import outside check 11's allowlist
- [ ] Run an LLM feature and LOOK: tokens on the strip, one indicator total,
      the trigger button disabled (not spinning) while it runs
- [ ] A batch shows real n/m; a polled job's percent reaches the strip
- [ ] CLAUDE.md present, first Where-to-look row → this document
- [ ] `docs/dev/TASKS.md` + `docs/dev/IDEAS.md` + `docs/dev/RESEARCH.md` present per §13
- [ ] Any deviation: flagged to the user AND recorded here

## 13 · The docs convention — every repo, including this one

Ruled by the user 2026-08-04 (modeled on JustWrite; enforced family-wide by the
docs campaign the same day):

- **`docs/dev/TASKS.md` is THE live open-work tracker** — one line per open item plus
  a pointer to its detail doc; the depth lives in the linked doc, never in the
  tracker. **Close = delete**: when an item ships and its QC is done, its line leaves
  the file — git and the plan docs keep history. A tracker line is a CLAIM, not
  evidence — verify against code before repeating it.
- **An item lives where the code that closes it lives** — kit/shared-server work in
  this repo's tracker, app work in the app's. One item, one home; cross-repo
  interest is a pointer, not a copy.
- **`docs/dev/IDEAS.md`** holds unscheduled ideas — adding one is never starting it.
- **`docs/dev/RESEARCH.md` is the research register** (ruled 2026-10-04) — what is
  already known, by subject, one verified fact per bullet with how and when it was
  checked and where the proof is. **Read the subject's section before researching
  anything** (and put it in any agent's brief); research is not done until its facts
  land there. The kit's register holds the shared stack's facts, each app's its
  domain. `scripts/check-family.mjs` check 15 fails a missing register, a plan dated
  2026-10-04 or later that the register doesn't link, and a register link to nothing.
- **`docs/plans/*.md` keep history**: a completed plan gets a loud ✅ CLOSED /
  SUPERSEDED banner at the top (or moves to `docs/plans/archive/`); before a plan
  closes, any still-open item or durable ruling inside it is extracted to its real
  home (TASKS / IDEAS / a dev doc). A stale `file:line` in a tracker or plan is NOT
  a fixed bug — correct the pointer; close only when the underlying issue is
  verified dead in code.
- **CLAUDE.md stays small** — rules and pointers, never tasks or status.
- User-facing docs (where an app has them) update in the SAME change that alters
  anything a user sees.

## 14 · The family skeleton — NORMATIVE (the target tree, executed)

The 2026-08-08 convergence program (docs/target-tree.md, pieces P2–P11) made the
three apps structurally identical outside their domain code. That page is the
program RECORD (each piece's status row carries its gates, scope calls and sweep
receipts); THIS section is the normative end state, and `scripts/check-family.mjs`
**check 8** asserts it structurally — apps against this list, plus the retired
names of every rename the program performed (check 7).

> **The Python server package, `scripts/py.js` and the ruff pin — until the app moves**
> (JustWrite step 4, JustVoice step 5). For an Electron app check 8 asserts §0.1 instead:
> `electron/main.js`, `scripts/node24.mjs` (riding `ELECTRON_RUN_AS_NODE`), `scripts/dev.mjs`,
> `server/vitest.config.js`, `"main": "electron/main.js"`, no `@tauri-apps/*` package, `data/`
> in `.gitignore`, a `<name>-server` launcher not named like the app exe. The renderer and
> config layer below hold for both kinds.

**Server package** (`server/<snake_name>/`): `serve.py` (the entry; console
script `<name>-server = <snake>.serve:main`) · `app.py` · `app_state.py`
(set_state/get_state) · `paths.py` · `version.py` · `auth.py` (the per-app
settings-read seam) · `api/` where every route file is `<area>_api.py`
(leading-underscore private helpers allowed beside them) with `health_api.py`
(one base wire: `status/product/version/apiVersion` + per-app extras) and the
family `/v1/prefs` door mounted via the kit's `make_prefs_router` ·
`database/` (`session.py`/`models.py`/`seed.py`) where the app owns SQL — JW +
JV; docgen deliberately has NONE (workspace sidecars + the shared runner DB) ·
NO per-app `csrf.py` (pure kit); `errors.py` exists only as the §3b re-export
alias (JW + JV). Seeding is SERVE-time in all three (`seed_workspace()` /
`seed_llm_stack()`); `cli.py` stays where an app has domain subcommands.

**Renderer** (`src/`): lanes `components/ views/ stores/ services/ router/
styles/` ×3 (+ `composables/` and `i18n/` where the app has them — JW + JV
today; docgen gains each the day it has one) · `styles/tokens.css` +
`styles/styles.css` · `views/HomeView.vue` · `components/KeyboardCheatsheet.vue`
where the feature exists (JW + JV) · `stores/ui.js` exporting `useUiStore`,
prefs SERVER-backed via the kit client · tests BESIDE their files (no
`__tests__/` dirs) with `boot.smoke.test.js` riding the kit's
`registerBootSmoke` · `services/helpDocs.js` riding `makeDocsHelpAdapter` ·
`scripts/py.js` riding the kit's `scripts/lib/exec-resolve.mjs` (directly, or
through JW's `tests/lib/smoke-common.js` door).

**Config layer**: dev ports JW 1420 · JV 1430/1431 · docgen 1450/1451 (tauri
devUrl in lock-step) · ONE `biome.json`, byte-identical ×3, CLI exact-pinned
(no ranges), lint script `biome check .` so the includes actually gate ·
`@renderer` alias in vite AND vitest configs · build block: per-platform
targets (chrome105 / safari17), boolean minify-unless-debug,
sourcemap-on-debug · `.gitattributes` ×4 (`* text=auto`, `.bat/.cmd` CRLF,
`.sh` LF) · the family ruff pin `select = ["E4", "E7", "E9", "F"]` in all four
pyprojects.

**Known, recorded, deliberately open** (not silent drift): JW + JV ride vite 8
(rolldown) while docgen rides vite 6 (classic) — implementation alignment is
its own decision; JW's `/v1/settings` still mixes operator rows with the
renderer document behind the mapped `/v1/prefs` door (the deeper split is
recorded future work); docgen's problem+json handler adoption and the §3b
alias sweep remain parked in the target tree.
