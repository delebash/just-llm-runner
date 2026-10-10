<!-- SPDX-License-Identifier: MIT -->
# The family app template (Quasar)

A fresh default Quasar app (`npm init quasar@5.0.32 template -- --template app --preset sass
--preset pinia`), made into the shape every family app takes — the reference the framework rules
(`../docs/app-structure.md`) are written from. Decided 2026-10-08: the kit's TASKS, "Every family
app moves to Quasar, built by one set of framework rules"; the facts behind it:
`../docs/plans/2026-10-08-quasar-framework-research.md`; the program:
`../docs/plans/2026-10-08-sync-and-quasar-program.md`.

## The shape

| Folder | What | How it runs |
|---|---|---|
| `src/` | the renderer (Vue 3, Quasar components, Pinia, hash router) | Quasar CLI builds it for every mode |
| `server/` | the app's Node server — its own package (`family-template-server`): Hono on the kit's platform (`Hono` and `serveStatic` from the kit — one Hono), the family guards (CSRF, CORS, bearer auth), the app's routes, the built UI for the headless path | the desktop app runs it in a utilityProcess; `npm run server` headless |
| `src-electron/` | the desktop app: `electron-main.js` calls the kit's `runDesktopApp` (data folder, server, tray, the `app://` window, security); `electron-preload.js` is the kit's preload | `quasar dev -m electron` · `quasar build -m electron` (electron-builder, NSIS) |
| `src-capacitor/` | the phone app (Android, iOS) | `quasar build -m capacitor -T android` |
| `build/launcher/` | the headless launcher `family-template-server.cmd`: the installed app's own exe (`familytemplate.exe`) run as Node on its server package — never the exe's name (§Q.3) | copied beside the exe by the installer; `family-template-server serve` |

## Commands

```bash
npm install                      # the renderer and the server/ workspace; once: cd src-electron && npm install
npm run dev                      # the desktop app, live (quasar dev -m electron)
npm run dev:spa                  # the renderer alone in a browser tab (quasar dev)
npm run build                    # the installer → dist/electron/Packaged (quasar build -m electron)
npm run build:spa                # the browser build → dist/spa
npm run build:unpacked           # the desktop app unpackaged → dist/electron/UnPackaged (what an e2e drives)
npm run build:android            # the Android app (quasar build -m capacitor -T android)
npm run server                   # the server alone, on Electron's Node (scripts/node24.js; headless;
                                 #   FAMILY_TEMPLATE_UI_DIR=dist/spa serves the UI)
npm run lint                     # Biome
```

## What differs from Quasar's default, and why

- **`src-electron/electron-main.js` is the kit's shell**, not Quasar's window code: one shared
  implementation of the data folder, the server process, the tray and the window on `app://<id>`
  (the family rule; Quasar's template loads `file://`).
- **The main process's dependencies are local packages** (`file:` the app's `server/` and the
  kit): `quasar.config.js` makes their paths absolute for `dist/electron/UnPackaged` and installs
  them with `npm install --install-links` (real copies, production dependencies only).
- **`server/` is an npm workspace** of the root, so one `npm install` installs its dependencies
  beside the renderer's, one copy of each package the two share (JustWrite's renderer and server
  both use TipTap).
- **The server runs on Electron's own Node** (`scripts/node24.js`, which runs the electron binary
  from `src-electron/` as Node) — the runtime it ships on, and the one its native modules
  (better-sqlite3) are built for.
- **electron-builder**, not Quasar's default @electron/packager: the family ships NSIS installers.
- **The CSP `<meta>`** in `index.html` lets the page reach its server (`connect-src http: https:`)
  — Quasar's default has no `connect-src`, which blocks the renderer → server path.
- **Biome**, not oxlint/ESLint (the family rule); `.vue` files skip the two template-blind rules.
- **`allowScripts`** in every `package.json` Quasar installs into (see "Traps").
- `src-capacitor/capacitor.config.js` stays CommonJS as Quasar generates it ("Capacitor's `.js`
  config loader doesn't yet handle ESM exports") — the one non-ESM file, generated config.

## Traps (found 2026-10-08)

- **npm 11 refuses `allow-scripts` from `.npmrc` in a project install** unless the project's
  `package.json` declares `allowScripts` (then it uses that). Hence `allowScripts` in the root,
  `src-electron/` and `src-capacitor/` package.json. `npm run` also hands the setting to every
  child as `npm_config_allow_scripts`, which made the installs Quasar spawns fail
  (`EALLOWSCRIPTS`), so `quasar.config.js` deletes that variable first thing.
- **The agent's shell sets `NoDefaultCurrentDirectoryInExePath=1`**, so cmd won't run
  `gradlew.bat` from the current folder; build Android there with
  `env -u NoDefaultCurrentDirectoryInExePath …` (a normal terminal is unaffected).
- Quasar's dev watcher must not watch `data/` (Chromium keeps its files locked) — `quasar.config.js`
  `extendViteConf`.
