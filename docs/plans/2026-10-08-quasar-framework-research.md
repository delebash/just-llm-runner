<!-- SPDX-License-Identifier: MIT -->
# Quasar — framework facts for the family move (2026-10-08)

**What this is.** The research behind the framework rules: every family app moves to Quasar
(decided 2026-10-08 — this repo's TASKS, "Every family app moves to Quasar, built by one set of
framework rules"). These facts feed the rewrite of `docs/app-structure.md` (the family app
standard) and `scripts/check-family.js` for Quasar. The register's summary is RESEARCH §2,
"Quasar as the family framework". Gathered by a research agent on 2026-10-08 from quasar.dev's
`.md` pages, the npm registry, published tarballs (read, not run) and the GitHub API; nothing was
installed or built. **The "Could not verify" list at the end is what the template build has to
test first.**

Every fact is tagged with its source. Tags:
- *web, 2026-10-08* · `<url>` — a quasar.dev page, read through its `.md` sibling.
- *web (npm tarball), 2026-10-08* · `<pkg>@<ver>/<path>` — the published package, downloaded with
  `npm pack` and read (nothing executed).
- *web (npm registry), 2026-10-08* — `npm view`.
- *web (GitHub API), 2026-10-08* — `gh api repos/quasarframework/quasar/...` on branch `dev`.

Already known and not redone: just-llm-runner `docs/dev/RESEARCH.md` lines 405–426, and
JustWrite's `docs/plans/2026-10-08-phone-ui-library-test.md`.

---

## 0 · Versions (npm registry, 2026-10-08)

| Package | Version | Licence | Released |
|---|---|---|---|
| `quasar` | 2.35.0 | MIT | 2026-10-07T08:58Z |
| `@quasar/app-vite` | 3.10.2 | MIT | 2026-10-07T08:47Z |
| `@quasar/cli` | 5.0.9 | MIT | 2026-09-22T15:01Z |
| `create-quasar` | 5.0.32 | MIT | 2026-10-07T08:56Z |
| `@quasar/extras` | 2.1.0 | MIT | 2026-09-14 |
| `@quasar/vite-plugin` | 2.0.2 | MIT | 2026-08-25 |
| `@quasar/mcp` | 1.1.0 | MIT | 2026-09-22T08:16Z (1.0.0 on 2026-09-17) |
| `@quasar/quasar-app-extension-testing-unit-vitest` | 3.0.0 | MIT | 2026-08-24 |
| `@quasar/icongenie` | 7.0.0 | MIT | 2026-09-22 |
| `@quasar/app-webpack` | 4.4.5 | MIT | 2026-04-06 |
| `electron` (latest) | 44.7.0 | — | 2026-10-07 |
| `@electron/packager` | 20.3.0 | — | — |
| `electron-builder` | 26.15.3 | — | — |
| `@capacitor/core`, `@capacitor/cli` | 8.5.3 | — | — |

- `@quasar/app-vite` 3.10.2: `engines.node` `^30 || ^28 || ^26 || ^24 || ^22.22.0`; depends on
  `vite ^8.3.0`, `rolldown ^1.2.9`, `@vitejs/plugin-vue ^6.0.9`, `@quasar/vite-plugin ^2.0.2`,
  `sass-embedded`; peers: `vue ^3.2.29`, `pinia ^2||^3||^4`, `quasar ^2.24.0`, `vue-router >= 5`,
  `electron-builder >= 22`, `@electron/packager >= 19`, `@capacitor/cli >= 5`, `typescript >= 5`
  (peers are optional in practice — a JS project doesn't install TS). — *web (npm registry), 2026-10-08*
- `quasar` 2.35.0 `package.json`: `"type": "module"`, `exports` `"."` (import →
  `dist/quasar.client.js`, node → `dist/quasar.server.prod.js`), `"./wrappers"`, and `"./*": "./*"`
  (every file reachable by path). No dependencies or peerDependencies. — *web (npm tarball), 2026-10-08*

---

## 1 · Creating a project

**Command.** The docs show `pnpm create quasar@latest` (Quick Start, Quasar CLI, "Creating a
@quasar/app-vite Project"). Requirements: "Node.js v22+", "PNPM v11+ (recommended), Yarn v1
classic, NPM or Bun". — *web, 2026-10-08* · https://quasar.dev/start/quasar-cli.md,
https://quasar.dev/quasar-cli-vite/creating-a-quasar-app-vite-project-folder.md

- For npm, `create-quasar`'s own help prints `npm init quasar@latest` (pnpm: `pnpm create
  quasar@latest`, yarn: `yarn create quasar`, bun: `bun create quasar@latest`). — *web (npm
  tarball), 2026-10-08* · `create-quasar@5.0.32/bin/create-quasar.js` `showHelp()`
- Global CLI (optional, "strongly recommended"): `pnpm add -g @quasar/cli@latest`. Without it,
  run `pnpm quasar dev` / `npx quasar dev` or the generated `npm run dev`. — *web, 2026-10-08* ·
  https://quasar.dev/start/quasar-cli.md

**The questions it asks** (create-quasar 5.0.32, read from source — the docs don't list them):
1. `What would you like to build?` — `App with Quasar CLI, let's go!` (`app`, default) |
   `AppExtension for Quasar CLI` (`ae`; **"PNPM only"** — disabled when not run through pnpm).
2. `Project folder:` (default `quasar-project`); if non-empty: `… is not empty. Remove existing files and continue?`
3. `Package name:` (derived from the folder).
4. `Project product name: (must start with letter if building mobile apps)` (default `Quasar App`).
5. `Pick features:` (multiselect; **initially checked: `sass`, `linting`**):
   `TypeScript` · `Sass CSS preprocessor` · `Linting & Formatting (oxlint + oxfmt or ESLint + Prettier)` (hint
   "recommended") · `Vue Router filename-based routing` · `State Management (Pinia)` ·
   `Internationalization (vue-i18n)`.
6. Only if linting was picked — `Project linter & formatter:` `oxlint + oxfmt` (hint "recommended,
   but full .vue support is still in progress") | `ESLint + vite-plugin-checker + Prettier`.
7. `Install project dependencies? (recommended)` — `Yes, use <PM>` | `No, I will handle that myself`.
8. Then `git init` unless `--no-git`.

There is **no app-vite vs webpack question**: the app template has only `templates/app/vite-3`.
— *web (npm tarball), 2026-10-08* · `create-quasar@5.0.32/lib/create-project-folder.js`,
`templates/app/create-quasar-script.js`, `templates/app/vite-3/create-quasar-script.js`

**Flags** (5.0.32 `--help`): `--template app|ae`, `--overwrite`, `--preset` (repeatable; app:
`typescript, sass, oxlint, eslint, i18n, pinia, fbr`), `--name`, `--author`, `--no-git`,
`--install [pnpm|yarn|npm|bun]`, `--product`, `--defaults`, `--no-color`. With `--defaults` and no
`--preset`, the app presets are `['sass', 'oxlint']`; `oxlint`+`eslint` together is an error.
— *web (npm tarball), 2026-10-08* · `create-quasar@5.0.32/bin/create-quasar.js`
- ⚠ The docs page still lists `--engine, -e … vite-3 or vite-2`; the 5.0.32 binary has no
  `--engine` option and parses with `strict: true`. — docs: https://quasar.dev/quasar-cli-vite/creating-a-quasar-app-vite-project-folder.md

**Can ESLint be left out?** Yes — uncheck `Linting & Formatting`; then no `lint` scripts and no
linter config files are generated. Non-interactive: pass `--preset` without `oxlint`/`eslint`
(e.g. `--preset sass --preset pinia`). — *web (npm tarball), 2026-10-08* · `templates/app/vite-3/js/BASE/_package.json`

**Is it ES modules?** Yes. The generated `package.json` has `"type": "module"`, `"private": true`,
scripts `"dev": "quasar dev"`, `"build": "quasar build"`, `"postinstall": "quasar prepare
--silent"`; deps `quasar ^2.35.0`, `@quasar/extras ^2.1.0`, `vue ^3.5.22`, `vue-router ^5.0.6`
(+ `pinia ^4.0.2` with Pinia, `vue-i18n ^11.3.0` with i18n); devDeps `@quasar/app-vite ^3.10.2`,
`autoprefixer`, `postcss`; `engines.node` `">= 26 || ^24 || ^22.12"`. — *web (npm tarball),
2026-10-08* · `templates/app/vite-3/js/BASE/_package.json`
- `/quasar.config` "can come with `.js` or `.ts` extensions only. Dropped support for `.cjs`,
  `.mjs`, `.cts` and `.mts`." — *web, 2026-10-08* · https://quasar.dev/quasar-cli-vite/upgrade-guide.md

**Generated files** (JS, Sass, manual routing, Pinia, no linter):
```
.editorconfig  .gitignore  README.md  index.html  postcss.config.js  quasar.config.js
jsconfig.json            → { "extends": "./.quasar/tsconfig.json" }  (.quasar/ made by `quasar prepare`)
pnpm-workspace.yaml      → allowBuilds list (written for every PM)
.vscode/extensions.json  .vscode/settings.json  .vscode/mcp.json  (registers @quasar/mcp)
public/favicon.ico  public/icons/*.png
src/App.vue              → <router-view />
src/assets/quasar-logo-vertical.svg
src/boot/.gitkeep
src/components/EssentialLink.vue
src/css/app.scss  src/css/quasar.variables.scss     (app.css only, without Sass)
src/layouts/MainLayout.vue
src/pages/IndexPage.vue  SecondPage.vue  ErrorNotFound.vue
src/router/index.js  src/router/routes.js
src/stores/index.js  src/stores/example-store.js      (Pinia only)
```
Linter adds `.oxlintrc.json` + `.oxfmtrc.json` (oxlint) or `eslint.config.js` + `.prettierrc.json`
(ESLint). Filename-based routing replaces layouts/routes.js with `src/pages/index.vue`,
`index/(index).vue`, `index/second.vue`, `[...path].vue`. — *web (npm tarball), 2026-10-08* ·
`create-quasar@5.0.32/templates/app/vite-3/js/**`
- The docs' directory listing names `src/css/app.sass` / `quasar.variables.sass`; the Sass preset
  actually writes `.scss`. — *web, 2026-10-08* · https://quasar.dev/quasar-cli-vite/directory-structure.md
- No `vite.config.js` exists: "Quasar CLI generates the Vite configuration for you"; tweak via
  `build.extendViteConf(viteConf)` and `build.vitePlugins`. `quasar inspect [-c build] [-m electron]`
  prints the generated config. — *web, 2026-10-08* · https://quasar.dev/quasar-cli-vite/handling-vite.md
- No `main.js`: app-init code goes in **boot files** (`src/boot/<name>.js`, `export default
  defineBoot(({ app, router, store, urlPath, publicPath, redirect }) => …)` from `'#q-app'`), listed
  in order in `quasar.config.js > boot`. `quasar new boot <name>`. — *web, 2026-10-08* ·
  https://quasar.dev/quasar-cli-vite/boot-files.md
- Aliases auto-injected: `#q-app` (the CLI) and `@/` (→ `/src`). — *web, 2026-10-08* ·
  https://quasar.dev/quasar-cli-vite/quasar-config-file.md (`alias`)
- `build.vueOptionsAPI` is `false` by default in app-vite v3 — Options-API components need it set
  `true`. — *web, 2026-10-08* · https://quasar.dev/quasar-cli-vite/upgrade-guide.md
- Generated `index.html` carries a CSP `<meta>`: `default-src 'self'; script-src 'self'; style-src
  'self' 'unsafe-inline';` (+ dev-only `connect-src 'self' ws://localhost:*; worker-src 'self'
  blob:`). It is emitted when the linter is **not** ESLint. No `connect-src` for any other origin.
  — *web (npm tarball), 2026-10-08* · `templates/app/vite-3/js/BASE/index.html`

---

## 2 · Electron mode

**Add / dev / build.** `quasar mode add electron` creates `/src-electron` and installs its
dependencies; `quasar dev -m electron` (also adds the mode if missing; opens DevTools; renderer
HMR; main/preload edits rebuild and restart Electron); `quasar dev -m electron --devtools` (Vue
DevTools); `quasar build -m electron` (`-d`/`--debug`, `--skip-pkg`, `--bundler packager|builder`,
`--target`, `--arch`, `-P onTag|onTagOrDraft|always|never` for electron-builder publish). On
PowerShell, pass Electron args after `'--'`. — *web, 2026-10-08* ·
https://quasar.dev/quasar-cli-vite/developing-electron-apps/preparation.md,
https://quasar.dev/quasar-cli-vite/developing-electron-apps/build-commands.md,
https://quasar.dev/quasar-cli-vite/commands-list.md

**Files generated** (JS project):
```
src-electron/electron-main.js
src-electron/electron-preload.js
src-electron/package.json          { "name": "quasar-electron-app", "private": true, "type": "module",
                                     "devDependencies": { "electron": "latest" } }  → rewritten to "^<installed>"
src-electron/pnpm-workspace.yaml   onlyBuiltDependencies: [electron]
src-electron/electron-assets/icons/icon.icns  icon.ico  icon.png
```
— *web (npm tarball), 2026-10-08* · `@quasar/app-vite@3.10.2/templates/electron/{common,js}`,
`lib/modes/electron/electron-installation.js`

**Electron version.** Not pinned: the template asks for `"electron": "latest"`, then writes
`^<installed version>` into `src-electron/package.json`. Upgrade later with `pnpm add -D
electron@latest` from `/src-electron`. "Electron v43+ downloads its binary on first launch."
app-vite peers: `electron-builder >= 22`, `@electron/packager >= 19` (v18 and below dropped).
— *web (npm tarball), 2026-10-08* · `electron-installation.js`; *web, 2026-10-08* ·
https://quasar.dev/quasar-cli-vite/developing-electron-apps/electron-upgrade-guide.md,
…/preparation.md, https://quasar.dev/quasar-cli-vite/upgrade-guide.md

**Main and preload.**
- Source files are `.js` (or `.ts`), ESM `import` syntax. Main is bundled by **Rolldown, format
  `esm`**, to `electron-main.js`; each preload is bundled to **CommonJS `<name>.cjs`** — "Electron
  requires ESM preload scripts to run with sandbox disabled… (Sandboxed preload scripts are run as
  plain JavaScript without an ESM context)". The `.cjs` is build output only. — *web (npm tarball),
  2026-10-08* · `lib/modes/electron/electron-config.js`; *web, 2026-10-08* ·
  https://quasar.dev/quasar-cli-vite/developing-electron-apps/build-commands.md ("Electron has only
  CJS support for the preload scripts")
- Generated `electron-main.js`: `new BrowserWindow({ icon: resolveElectronAssetsPath('icons/icon.png'),
  width: 1000, height: 600, useContentSize: true, webPreferences: { contextIsolation: true,
  preload: path.join(import.meta.dirname, 'electron-preload.cjs') } })`; dev
  `mainWindow.loadURL(import.meta.env.QUASAR_APP_URL)`, prod **`mainWindow.loadFile('index.html')`**;
  DevTools open when `import.meta.env.QUASAR_DEBUG`, else force-closed; `app.whenReady()` →
  `registerQuasarRuntime()` + `createWindow()`; quits on `window-all-closed` except darwin.
  — *web (npm tarball), 2026-10-08* · `templates/electron/js/electron-main.js`
- Generated `electron-preload.js`: `contextBridge.exposeInMainWorld("quasarRuntime", quasarRuntime)`
  from `'#q-app/electron/preload'` (path helpers `resolvePublicPath`, `resolveElectronAssetsPath`,
  via `ipcRenderer.sendSync`). Optional — "you can rename … or expose only the helpers your
  renderer needs". — *web, 2026-10-08* ·
  https://quasar.dev/quasar-cli-vite/developing-electron-apps/electron-accessing-files.md
- Rename/add files: `sourceFiles.electronMain` (default `'src-electron/electron-main'`, no
  extension) and `electron.preloadScripts` (default `['electron-preload']`). — *web, 2026-10-08* ·
  https://quasar.dev/quasar-cli-vite/developing-electron-apps/configuring-electron.md

**Security defaults.**
- "Quasar's default Electron template keeps Node.js integration disabled and context isolation
  enabled." The generated window sets only `contextIsolation: true`; `sandbox` and `nodeIntegration`
  are **not written** — the docs rely on Electron's own defaults ("Current Electron versions also
  sandbox renderers by default and disable Node.js integration by default. Preserve those defaults")
  and show `contextIsolation: true, sandbox: true, nodeIntegration: false` as the explicit form.
  — *web, 2026-10-08* · https://quasar.dev/quasar-cli-vite/developing-electron-apps/introduction.md,
  …/electron-security-concerns.md; template as above
- Docs' rules: expose "one method per IPC message", never `ipcRenderer.send`/`invoke` raw ("Bad:
  `contextBridge.exposeInMainWorld('electronAPI', { invoke: ipcRenderer.invoke })`"); validate
  `event.senderFrame` in `ipcMain.handle`; `will-navigate` → `preventDefault`;
  `setWindowOpenHandler` → `{ action: 'deny' }`; restrictive CSP; review fuses. — *web, 2026-10-08* ·
  …/electron-security-concerns.md, …/electron-preload-script.md

**Custom protocol (`app://`).** Only one line: checklist item 9, "Prefer a custom protocol over
`file://` for packaged content when your application requires a stronger origin model." No how-to,
no API, no example; the template uses `loadFile('index.html')` (file://). *Not stated on*
https://quasar.dev/quasar-cli-vite/developing-electron-apps/electron-security-concerns.md how to
wire `protocol.handle`/`registerSchemesAsPrivileged` (grep of all Electron pages and of app-vite's
`lib/` and `templates/` finds neither — *web (npm tarball), 2026-10-08*). The main file is
ordinary user code, so the app's own protocol code would go there.
- Router mode for Electron and Capacitor: "it's always 'hash' for compatibility reasons". —
  *web, 2026-10-08* · https://quasar.dev/quasar-cli-vite/quasar-config-file.md (`vueRouterMode`)

**Running extra code in main (server, utilityProcess, tray).** *Not stated on* any Electron page
(https://quasar.dev/quasar-cli-vite/developing-electron-apps/*.md — no mention of
`utilityProcess`, `Tray`, `child_process` or starting a server). What is stated:
- "The main process runs the package's `main` entry, manages the application lifecycle, and
  creates browser windows." — …/introduction.md
- Runtime deps of main go in `/src-electron/package.json` `dependencies` ("installed in
  `/dist/electron/UnPackaged` before packaging"); renderer deps stay in the root `package.json`.
  "Removing a dependency required by externalized main-process code will make the packaged
  application fail at runtime." — …/configuring-electron.md, …/installing-electron-dependencies.md
- Source detail: in production, Rolldown externalises `electron` + every key of
  `src-electron/package.json > dependencies`; the generated `UnPackaged/package.json` is the root
  `package.json` (so it keeps `"type": "module"`) with `dependencies` replaced by those deps
  (versions pinned to installed; ranges starting with a letter — `file:`, `git+…`, URLs — copied
  unchanged), `devDependencies`/`scripts` removed, `main: './electron-main.js'`; then the package
  manager runs `install` in `UnPackaged`. — *web (npm tarball), 2026-10-08* ·
  `lib/modes/electron/electron-config.js`, `electron-builder.js`, `lib/utils/get-pinned-deps.js`
- Hooks for adjusting that: `electron.extendElectronPackageJson(pkgJson)`,
  `electron.beforePackaging({ appPaths, unpackagedDir })`, `electron.unPackagedInstallParams`,
  `electron.extendElectronMainConf(rolldownConf)`, `electron.extendElectronPreloadConf`. —
  …/configuring-electron.md

**Packager vs builder.** `electron.bundler: 'packager' | 'builder'` — "`@electron/packager` … is the
Quasar default"; builder "adds installer targets, code-signing integration, and publishing".
`electron.packager` takes @electron/packager options except `dir`/`out`; `electron.builder` takes
electron-builder configuration. The tool is installed into `/src-electron` "on the first production
build that needs it". Generated config: `bundler: 'packager'`, `builder: { appId: '<pkg name>' }`,
`inspectPort: 5858`. — *web, 2026-10-08* · …/configuring-electron.md,
…/installing-electron-dependencies.md; template `quasar.config.js`
- Output folder: default `build.distDir` is `dist/<mode>`, so `dist/electron/UnPackaged` and
  `dist/electron/Packaged` (source + troubleshooting page). ⚠ The build-commands page draws the
  tree as `dist-electron/…`. — *web (npm tarball), 2026-10-08* · `lib/quasar-config-file.js:1182`;
  docs …/build-commands.md vs …/troubleshooting-and-tips.md
- `quasar build -m electron --skip-pkg` stops at `UnPackaged` for inspection. — …/troubleshooting-and-tips.md
- Mode flags in renderer code: `import.meta.env.QUASAR_MODE`, `QUASAR_ELECTRON_MODE`,
  `QUASAR_CAPACITOR_MODE`, … — *web, 2026-10-08* · https://quasar.dev/quasar-cli-vite/handling-import-meta-env.md

---

## 3 · Capacitor mode

- `quasar mode add capacitor` (non-interactive: `--app-id org.capacitor.quasar.app --app-name "My
  App"`; prompts `What is the Capacitor app id?` / `What is the Capacitor app display name?`).
  Dev: `quasar dev -m capacitor -T [android|ios]` (alias `quasar dev -m android`) — starts the dev
  server on the machine's external IP, points Capacitor at it, syncs plugins, opens Android
  Studio/Xcode. Build: `quasar build -m capacitor -T [ios|android]` → `/src` built into
  `/src-capacitor/www`, then Gradle/xcodebuild; output in `/dist/capacitor`; `--skip-pkg` (only
  fills `www`), `--ide`, `-d`. — *web, 2026-10-08* ·
  https://quasar.dev/quasar-cli-vite/developing-capacitor-apps/preparation.md, …/build-commands.md
- Versions: "The officially supported versions of Capacitor are v5+." v8 needs Node v22.22+, Xcode
  26+, iOS 15+, Android Studio Otter 2025.2.1+, Android SDK min API 24 / compile+target 36; v8 uses
  Swift Package Manager by default. — *web, 2026-10-08* · …/capacitor-version-support.md
- Generated `src-capacitor/package.json`: `"name": "quasar-capacitor-app"`, deps `@capacitor/app`,
  `@capacitor/cli`, `@capacitor/core` all `^8.0.0` — **no `"type": "module"`**. Adding a platform
  installs `@capacitor/<target>@^<cap major>.0.0` and runs `cap add <target>`. — *web (npm tarball),
  2026-10-08* · `@quasar/app-vite@3.10.2/templates/capacitor/common/package.json`,
  `lib/modes/capacitor/capacitor-installation.js`
- **`capacitor.config.js` is CommonJS** in JS projects: `const { defineCapacitorConfig } =
  require('@quasar/app-vite/capacitor'); module.exports = defineCapacitorConfig({ appId, appName })`
  — "Capacitor's `.js` config loader doesn't yet handle ESM exports correctly, so we have to stick
  with `module.exports` in JS projects." TS projects get `capacitor.config.ts` with `export
  default`. `defineCapacitorConfig` defaults `webDir: 'www'`, injects `server.url` in dev. Env vars
  `QUASAR_DEV` (string `'true'`/`'false'`), `QUASAR_TARGET`, `QUASAR_APP_URL`, `QUASAR_MODE`. —
  *web, 2026-10-08* · …/configuring-capacitor.md
- Plugins: install in `/src-capacitor` (`pnpm add @capacitor/geolocation`, then `pnpm exec cap
  sync`); "The packages installed in `/src-capacitor` are resolvable from the `/src` folder
  regardless of the Quasar mode" (app-vite v3.7+); guard native-only code with
  `import.meta.env.QUASAR_CAPACITOR_MODE` + dynamic `import()`. `@capacitor/app` and
  `@capacitor/splash-screen` "are optional, but Quasar can provide additional UI behavior". —
  *web, 2026-10-08* · …/capacitor-api.md, …/capacitor-version-support.md

---

## 4 · App Extensions (AEs)

**What.** "a way to painlessly inject complicated (or simple) libraries with a variety of
dependencies, boot files, templates and custom logic. They can extend Vite configuration, the
`quasar.config` file, tightly couple external UI components to core, and even register new commands
with the Quasar CLI." **"designed specifically for Quasar CLI only"** — not usable with the Vite
plugin or UMD. Package name must be `quasar-app-extension-<id>` or
`@scope/quasar-app-extension-<id>` (ext-id `@scope/<id>`). — *web, 2026-10-08* ·
https://quasar.dev/app-extensions/introduction.md

**What an AE can provide** (four scripts in `/ae/src`):
- `index.js` (required; runs on every `quasar dev`/`build`): `api.extendQuasarConf` (add boot files
  and css with the `~` node_modules prefix, plugins, iconSet, extras…), `api.extendViteConf`,
  `api.extendElectronMainConf`, `api.extendElectronPreloadConf`, `api.extendElectronPackageJson`,
  PWA/SSR/SSG/BEX hooks, `api.beforeDev/afterDev/beforeBuild/afterBuild/onPublish`,
  `api.registerCommand` (`quasar run <ext-id> <cmd>`), `api.registerDescribeApi` (for `quasar
  describe`), `api.compatibleWith('quasar', '^2.0.0')`. — *web, 2026-10-08* ·
  https://quasar.dev/app-extensions/development-guide/index-api.md
- `install.js`: `api.render('./templates/…', scope)` copies template files into the app,
  `api.extendPackageJson`, `api.extendJsonFile`. `prompts.js`: questions at install (answers stored in
  `quasar.extensions.json`). `uninstall.js`: `api.removePath`. — *web, 2026-10-08* ·
  …/install-api.md, …/prompts-api.md, …/uninstall-api.md
- Components: ship `.vue` files in `ae/src/runtime/`, register them from a boot file the index script
  adds (`boot: ['~quasar-app-extension-my-ext/src/runtime/boot.register.js']`, boot does
  `app.component('my-component', MyComponent)`). — *web, 2026-10-08* ·
  https://quasar.dev/app-extensions/common-formulas-and-patterns/provide-ui-elements.md
- Don't install `quasar`, `@quasar/extras`, `@quasar/app-vite` as AE deps; use `api.compatibleWith()`.
  — …/development-guide/introduction.md
- ⚠ **Second-copy-of-Quasar trap:** any package — "a component library, a helper package, an App
  Extension" — that imports from `"quasar"` gets pre-bundled by Vite's dep optimizer against a
  second copy of Quasar (`Notify.create is not a function`). Fix: `optimizeDeps: { exclude:
  ['<pkg>'] }` via `build.extendViteConf` (or the AE's `api.extendViteConf`). Production builds rely
  on Quasar's import mapping over `framework.autoImportScriptExtensions` (default
  `['js','jsx','ts','tsx']`). — *web, 2026-10-08* · https://quasar.dev/quasar-cli-vite/handling-vite.md,
  …/inject-quasar-plugin.md

**Installing from a local folder (not npm).**
- `quasar ext add <ext-id>` installs the npm package by name, then runs prompts + install script.
- `quasar ext invoke <ext-id>` — "Add Quasar App Extension, but skip installing the npm package
  (assumes it's already installed)"; `quasar ext uninvoke <ext-id>` the reverse. — *web, 2026-10-08*
  · https://quasar.dev/quasar-cli-vite/commands-list.md (Ext)
- The official AE scaffold links its playground to the AE with `"<ae-name>": "workspace:*"` (a pnpm
  workspace) and runs `quasar ext invoke <id>`. — *web (npm tarball), 2026-10-08* ·
  `create-quasar@5.0.32/templates/ae/js/BASE/playground/_package.json`
- `file:` dependencies: *not stated on* https://quasar.dev/app-extensions/development-guide/introduction.md.
  Source: the CLI decides "installed" by resolving `<pkg>/package.json` (or the package, or its
  index script) from the app folder — so any install that makes the name resolvable should satisfy
  `invoke`. Untested. — *web (npm tarball), 2026-10-08* ·
  `@quasar/app-vite@3.10.2/lib/app-extension/AppExtensionInstance.js` `#loadPackageInfo`
- **AE development is pnpm-only:** "PNPM v11+ only!" (`pnpm create quasar@latest`, pick
  AppExtension); the scaffold is a pnpm workspace `/ae` + `/playground`. — *web, 2026-10-08* ·
  …/development-guide/introduction.md; create-quasar refuses `--install` other than pnpm for `ae`.
- AE package shape: `"type": "module"`, `"main": "src/index.js"`, `"imports": { "#q-app":
  "@quasar/app-vite" }`, peer `@quasar/app-vite ^3.5.0`. — *web (npm tarball), 2026-10-08* ·
  `templates/ae/js/BASE/ae/_package.json`
- "Installing an App Extension runs third-party code … not sandboxed … initialized again on each
  `quasar dev` and `quasar build`." — …/app-extensions/introduction.md

**Recommended for sharing across a family?** Yes, in so many words: "App Extensions **replace the
need to create custom starter kits**." and the "Starter kit equivalent" page: "This allows you to
have multiple projects sharing a common structure/logic (and only one package to manage them rather
than having to change all projects individually to match your common pattern)". — *web, 2026-10-08*
· https://quasar.dev/app-extensions/introduction.md,
https://quasar.dev/app-extensions/common-formulas-and-patterns/starter-kit-equivalent.md

**"UI kit" template.** None in the current scaffolder: `create-quasar` 5.0.32 has only `app` and
`ae` templates. The official component packages (`@quasar/qcalendar`, `qmarkdown`, …) are listed as
AEs ("Official App Extensions & UI kits"). A UI-kit starter is *not stated on*
https://quasar.dev/app-extensions/discover.md or any page fetched. — *web (npm tarball), 2026-10-08*;
*web, 2026-10-08* · https://quasar.dev/how-to-contribute/running-projects.md
- Documenting your own component's API: a JSON file with `"type": "component"` (same schema as
  `node_modules/quasar/dist/api`), registered with `api.registerDescribeApi('MyComponent', './…json')`.
  — …/index-api.md, …/json-api.md

---

## 5 · Your own components, Quasar-style, and theming

**Components.**
- `QField`: "QField allows you to display any form control (or almost anything …) inside it. Just
  place your desired content inside the `control` slot." The slot scope gives `id`, `ariaInvalid`,
  `ariaDescribedby`, `ariaErrormessage` — "it is your responsibility to bind them". "Do NOT wrap
  QInput, QFile or QSelect with QField as these components already inherit QField." — *web,
  2026-10-08* · https://quasar.dev/vue-components/field.md
- `useFormChild({ validate, resetValidation, requiresQForm })` — for "QForm wrapping your own custom
  component". `useSplitAttrs()` → `{ attributes, listeners }`. — *web, 2026-10-08* ·
  https://quasar.dev/vue-composables/use-form-child.md, …/use-split-attrs.md
- **`useField` and `useDark` are private**: in quasar 2.35.0 they are
  `src/composables/private.use-field/` and `private.use-dark/`, not exported from `quasar`'s
  `composables.js`, and no docs page exists. Public composables: useAnimationFrame,
  useBroadcastChannel, useDebounce, useDialogPluginComponent, useDropZone, useElementSize,
  useEventListener, useEventSource, useFilePicker, useFormChild, useHydration, useId, useIdle,
  useIntersection, useKeyboardShortcut, useInterval, useMeta, useMutation, useObjectUrl,
  useQuasar, useRenderCache, useScroll, useSoftFullscreen, useSplitAttrs, useThrottle, useTick,
  useTimeout, useWebSocket, useWebWorker, useWebWorkerFn. — *web (npm tarball), 2026-10-08* ·
  `quasar@2.35.0/src/composables.js`, `src/composables/`
- Dark state for your own component: `useQuasar().dark.isActive`. — https://quasar.dev/quasar-plugins/dark.md
- A guide to extending/wrapping Q-components in general: *not stated on* any page fetched (the
  closest are QField's `control` slot and the AE "Provide UI elements" page).

**Sass variables.** `src/css/quasar.variables.scss` (or `.sass`) — overrides apply to "ALL your
.sass AND .scss project files (including inside of .vue files)" and Quasar's own CSS is compiled
from it; without the file, "pre-compiled Quasar CSS" is used. Keep it declarations-only for the
fast targeted injection (v2.24+/app-vite v3.4+). Creating/deleting the file needs a dev-server
restart. — *web, 2026-10-08* · https://quasar.dev/style/sass-scss-variables.md

**CSS variables at runtime.** Brand colours are `--q-primary`, `--q-secondary`, `--q-accent`,
`--q-dark`, `--q-positive`, `--q-negative`, `--q-info`, `--q-warning` on `:root`.
`setCssVar(colorName, colorValue[, element])` (default element `document.body`) and
`getCssVar(colorName[, element])` from `'quasar'`. Build-time defaults:
`framework.config.brand: { primary, …, ...customColors }`. — *web, 2026-10-08* ·
https://quasar.dev/style/color-palette.md
- Shadows: `--q-shadow-color` (default `#000`) and `--q-dark-shadow-color` (default `#fff`), set on
  `:root` or `body` (v2.31+). — https://quasar.dev/style/dark-mode.md

**Dark mode.** `Dark` plugin / `$q.dark`: `isActive`, `mode` (`'auto'|true|false`), `set()`,
`toggle()`; config `framework.config.dark`. Effects: `body--dark` / `body--light` class on
`<body>`, every component with a `dark` prop gets it automatically. — *web, 2026-10-08* ·
https://quasar.dev/quasar-plugins/dark.md, https://quasar.dev/style/dark-mode.md,
https://quasar.dev/style/body-classes.md (also `electron`, `native-mobile`, `mobile`, `desktop`,
`platform-ios`, `platform-android` body classes)

**Portals.** Dialogs/menus/tooltips render into `#q-portal--…` nodes on `<body>`; give them a class
with `framework.config.globalNodes: { class: 'my-app' }`. — *web, 2026-10-08* ·
https://quasar.dev/options/global-node.md

**Icons.** `framework.iconSet: '<set>'` (webfont or `svg-*`); runtime `$q.iconSet.set(def)` /
`IconSet.set(def)` (reactive); single icon `$q.iconSet.editor.header1 = …`. Custom mapping:
`$q.iconMapFn` (in `App.vue`) or `IconSet.iconMapFn` (in a boot file) — `(iconName) => { icon } |
{ cls, content? } | void`; "must be a pure mapping … Quasar caches its results per function"; it
affects every component that takes an icon prop. Image icons: `img:/path.svg`. — *web, 2026-10-08*
· https://quasar.dev/options/quasar-icon-sets.md, https://quasar.dev/vue-components/icon.md (Custom mapping)

---

## 6 · Router, Pinia, Vitest, lint

**Router.** `src/router/index.js` exports `defineRouter(({ store, ssrContext }) => createRouter({…}))`
(from `'#q-app'`); history picked from `import.meta.env.QUASAR_VUE_ROUTER_MODE` —
`createWebHashHistory` unless `'history'`. Generated `quasar.config.js` sets `build.vueRouterMode:
'hash'` (also the default); "For Capacitor and Electron, it's always 'hash'". Routes in
`src/router/routes.js` (lazy `() => import('@/pages/…')`, catch-all `/:catchAll(.*)*` last).
Optional filename-based routing (`build.filenameBasedRouting: true`, Vue Router v5+). — *web,
2026-10-08* · https://quasar.dev/quasar-cli-vite/page-routing-with-vue-router.md,
…/quasar-config-file.md; template `manualRouting/src/router/*.js`

**Pinia.** `src/stores/index.js`: `export default defineStore(() => createPinia())` with
`defineStore` from `'#q-app'` (Pinia plugins added there); one file per store; `quasar new store
<name>` creates `src/stores/<name>.js`; the Pinia instance is passed to `defineRouter` and boot
files as `store`; `this.router` inside store actions. Store location overridable with
`sourceFiles.store` (default `src/stores/index`). — *web, 2026-10-08* ·
https://quasar.dev/quasar-cli-vite/state-management-with-pinia.md, …/quasar-config-file.md

**Vitest.** `quasar ext add @quasar/testing-unit-vitest` (package
`@quasar/quasar-app-extension-testing-unit-vitest` 3.0.0). It adds `vitest.config.js` (JS projects)
built on `quasarViteTestingConfig()` (derives the Vite config from your `quasar.config`, drops
`vite-plugin-checker` and `vite-plugin-vue-devtools`), `installQuasarPlugin()` for test files,
example tests in `test/vitest/__tests__`, package.json scripts. Peers: `vitest ^4 || ^5`,
`@vitest/ui`, `@vue/test-utils ^2.4.6`, `@quasar/app-vite ^3`, `quasar ^2.24`; depends on
`happy-dom`. "app-vite v3 projects are ESM by default, so the `m` prefix is no longer needed." —
*web (npm registry/README), 2026-10-08*; docs: https://quasar.dev/quasar-cli-vite/testing-and-auditing.md
(lists `@quasar/testing-unit-vitest`, `-unit-jest`, `-e2e-cypress`; details at testing.quasar.dev)

**Lint.** The docs offer two stacks: **Oxlint + Oxfmt** (scaffold default; `"lint": "oxfmt &&
oxlint --fix"`) or **ESLint v10 + Prettier** (`pluginQuasar.configs.recommended()` from
`@quasar/app-vite/eslint`, `vite-plugin-checker`). `pluginQuasar.configs.recommended()` ignores
`dist/*`, `src-capacitor/*`, `src-cordova/*`, `.quasar/*`, `quasar.config.*.temporary.compiled*`
(the oxlint template ignores the same, plus `**/node_modules/`). **Biome: not stated** — a grep of
all ~75 fetched pages for "biome" finds nothing. — *web, 2026-10-08* ·
https://quasar.dev/quasar-cli-vite/lint-and-format-code.md

---

## 7 · AI-agent support

- `@quasar/mcp` 1.1.0, MIT, created 2026-09-17, 1.1.0 on 2026-09-22; bin `quasar-mcp`; repo
  `quasarframework/quasar`, directory `mcp`; Node ≥ 22; deps `@modelcontextprotocol/sdk ^1.30.0`,
  `zod ^4.6.0`. — *web (npm registry), 2026-10-08*
- Serves "the documentation pages and the component API of the exact Quasar versions installed in
  your project, offline" from `node_modules` (pages ship inside `quasar` and `@quasar/app-vite`).
  Requires Quasar UI v2.33+ and `@quasar/app-vite` v3.9+. — *web, 2026-10-08* ·
  https://quasar.dev/start/ai-agents.md
- Tools: `list_pages`, `search_docs`, `get_page`, `list_api`, `get_api`, `check_updates`. Update
  check at most once a day, honours `NO_UPDATE_NOTIFIER`. Monorepo: finds every Quasar app below the
  root; every tool takes an `app` argument; `"--project", "apps/web"` serves one. — same page
- Setup: `{"mcpServers":{"quasar":{"command":"npx","args":["-y","--fetch-retries=0","@quasar/mcp@latest"]}}}`.
  Claude Code: `claude mcp add quasar -- npx -y --fetch-retries=0 @quasar/mcp@latest`; **on native
  Windows**: `claude mcp add quasar -- cmd /c npx -y --fetch-retries=0 @quasar/mcp@latest`. A CLI
  scaffold already ships `.vscode/mcp.json`. — same page; https://quasar.dev/start/vs-code-configuration.md
- **llms.txt:** https://quasar.dev/llms.txt (377 lines) — "indexes the markdown version of the
  official Quasar v2.35.0 documentation"; every page also has a `.md` sibling URL.
  `https://quasar.dev/llms-full.txt` returns 404. — *web, 2026-10-08*
- The repo root carries `AGENTS.md`, `CLAUDE.md`, `context7.json`. — *web (GitHub API), 2026-10-08*

---

## 8 · Forking

- Repo `quasarframework/quasar`: **MIT**, default branch **`dev`** ("All the work happens on the
  `dev` branch"), not archived, last push 2026-10-07. — *web (GitHub API), 2026-10-08*;
  https://quasar.dev/how-to-contribute/contribution-guide.md
- **pnpm monorepo** (`packageManager: pnpm@12.3.4`, root `"type": "module"`). `pnpm-workspace.yaml`
  packages: `app-vite` (+ `playground-js`, `playground-ts`), `vite-plugin` (+ playground), `extras`,
  `icongenie`, `ui` (+ `ui/playground`), `create-quasar`, `cli`, `mcp`, `utils/art`,
  `utils/render-ssr-error`, `utils/ssl-certificate`, `utils/update-notifier`, `docs`.
  `@quasar/app-webpack` "is maintained on its own branch". — *web (GitHub API), 2026-10-08*;
  contribution guide
- Build steps: Node **v22.22+** ("v24 is what our CI runs") + **pnpm v12+**; at the root `pnpm i`,
  then `pnpm build` ("build the Quasar UI dist files"; = `pnpm --filter quasar build` →
  `node build/script.build.js` in `/ui`), `pnpm lint` (oxfmt + oxlint), `pnpm test`. `/ui`: `pnpm dev`
  runs `ui/playground` with HMR on the Quasar sources. — *web, 2026-10-08* · contribution guide;
  *web (GitHub API), 2026-10-08* · root and `ui/package.json`
- The `quasar` package publishes `dist`, `lang`, `icon-set`, `src`, `wrappers`; `dist` is a build
  product ("**DO NOT** check in `dist` or other generated files"); `prepublishOnly` = `pnpm build &&
  pnpm generate:mcp`. — *web (GitHub API), 2026-10-08* · `ui/package.json`; contribution guide
- How a project consumes a fork (git dependency, workspace link, `file:`): *not stated on*
  https://quasar.dev/how-to-contribute/contribution-guide.md.

---

## Could not verify / gaps

1. Custom protocol (`app://`) for Quasar Electron: one checklist line, no how-to, no example —
   untested whether `loadURL('app://…')` + hash router + the generated asset paths work.
2. Starting a server / `utilityProcess` / tray from the Quasar main: not documented; that a shared
   kit listed in `src-electron/package.json` works in the packaged app is inferred from source
   only. A `file:` kit dependency is copied unchanged into `dist/electron/UnPackaged/package.json`,
   where the relative path would point elsewhere — untested.
3. Installing an AE through `file:` with npm (not pnpm), then `quasar ext invoke`: inferred from
   source, untested.
4. Biome with Quasar: nothing in the docs either way.
5. The generated CSP has no `connect-src` for a local HTTP server (the family's renderer→server
   path); whether it blocks those fetches under `file://` or a custom scheme was not tested.
6. Capacitor's `capacitor.config.js` is CommonJS by design, and `src-capacitor/package.json` has
   no `"type": "module"` — against the family's ESM-only rule; the only documented alternative is
   `capacitor.config.ts`.
7. The vitest AE's default test-file globs were read from its README's ESLint snippet only, not its
   generated config.
8. Docs inconsistencies found: `--engine` flag (docs yes, binary no); `dist-electron/` vs
   `dist/electron/` in the Electron pages; `.sass` names in the directory listing vs `.scss` written.
