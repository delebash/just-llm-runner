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
| `server/` | the app's Node server — its own package (`family-template-server`): Fastify on the kit's platform, the family guards (CSRF, CORS, bearer auth), the app's routes, the built UI for the headless path | the desktop app runs it in a utilityProcess; `npm run server` headless |
| `src-electron/` | the desktop app: `electron-main.js` calls the kit's `runDesktopApp` (data folder, server, tray, the `app://` window, security); `electron-preload.js` is the kit's preload | `quasar dev -m electron` · `quasar build -m electron` (electron-builder, NSIS) |
| `src-capacitor/` | the phone app (Android, iOS) | `quasar build -m capacitor -T android` |

## Commands

```bash
npm install                      # also: cd server && npm install; cd src-electron && npm install
node node_modules/@quasar/app-vite/bin/quasar.js dev -m electron     # the desktop app, live
node node_modules/@quasar/app-vite/bin/quasar.js build -m electron   # the installer → dist/electron/Packaged
node node_modules/@quasar/app-vite/bin/quasar.js build               # the browser build → dist/spa
npm run server                   # the server alone (headless; FAMILY_TEMPLATE_UI_DIR=dist/spa serves the UI)
npm run lint                     # Biome
```

Run the Quasar CLI with `node …/quasar.js` (or `npm run dev` / `npm run build`) — see "Traps".

## What differs from Quasar's default, and why

- **`src-electron/electron-main.js` is the kit's shell**, not Quasar's window code: one shared
  implementation of the data folder, the server process, the tray and the window on `app://<id>`
  (the family rule; Quasar's template loads `file://`).
- **The main process's dependencies are local packages** (`file:` the app's `server/` and the
  kit): `quasar.config.js` makes their paths absolute for `dist/electron/UnPackaged` and installs
  them with `npm install --install-links` (real copies, production dependencies only).
- **electron-builder**, not Quasar's default @electron/packager: the family ships NSIS installers.
- **The CSP `<meta>`** in `index.html` lets the page reach its server (`connect-src http: https:`)
  — Quasar's default has no `connect-src`, which blocks the renderer → server path.
- **Biome**, not oxlint/ESLint (the family rule); `.vue` files skip the two template-blind rules.
- **`allowScripts`** in every `package.json` Quasar installs into (see "Traps").
- `src-capacitor/capacitor.config.js` stays CommonJS as Quasar generates it ("Capacitor's `.js`
  config loader doesn't yet handle ESM exports") — the one non-ESM file, generated config.

## Traps (found 2026-10-08)

- **npm 11 refuses `allow-scripts` from `.npmrc` in a project install** unless the project's
  `package.json` declares `allowScripts` (then it uses that). Commands run through `npx`/`npm run`
  pass the setting to the installs Quasar spawns → `EALLOWSCRIPTS`. Hence `allowScripts` in the
  root, `src-electron/` and `src-capacitor/` package.json, and the plain `node …/quasar.js`.
- **The agent's shell sets `NoDefaultCurrentDirectoryInExePath=1`**, so cmd won't run
  `gradlew.bat` from the current folder; build Android there with
  `env -u NoDefaultCurrentDirectoryInExePath …` (a normal terminal is unaffected).
- Quasar's dev watcher must not watch `data/` (Chromium keeps its files locked) — `quasar.config.js`
  `extendViteConf`.
