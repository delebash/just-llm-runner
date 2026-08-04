# THE FAMILY APP STANDARD — every Tauri + Vue + Python app, identical by construction

Ruled by the user, 2026-08-02, after parity gaps kept surfacing one at a time: **one
document that covers EVERYTHING, so a new app is the same as the last one — layout,
scripts, tests, shell, server, API — and adding llm-runner is the same every time.**
This doc is the generator you would otherwise run. If an item here is ambiguous, the
canonical implementations are **justwrite-app** (the richest shell) and
**just_ai_i18n_docgen** (the newest full pass through this checklist).

A deviation is allowed only when flagged to the user AND recorded here in the same
change. Unflagged deviations are how this document came to exist.

---

## 1 · Creating the app

```bash
npm create tauri-app@latest   # Vue, JavaScript — take the scaffolder's layout UNTOUCHED
```

- **Repo root**: `index.html` + `src/` + `src-tauri/` + `public/` exactly as scaffolded.
  NEVER `src/renderer/` — that Electron habit cost two apps a restructure.
- **Names, one per layer**: repo name (any style) · Python package `snake_case` ·
  console scripts `kebab-case`. The Python package REPEATS the app name one level down
  (`server/<snake_name>/`) because Python imports by NAME where JS imports by path —
  the full reasoning + PyPA citation is §7.
- **Port registry** (a new app claims the next): JW **17495** · JV **8741** ·
  i18n-docgen **8742**. The app's OWN server port is the only one it claims — the
  bundled engine's router port is **allocated at spawn**, never registered and never
  assumed (§8), so two family apps can run at once.
- **Identifier**: `com.<kebab-name>.app`.
- **Env vars**: data dir `<SNAKE_NAME_UPPER>_DATA_DIR` (e.g. `JUSTWRITE_DATA_DIR`);
  python override for scripts `<ABBR>_PYTHON` (e.g. `JW_PYTHON`, `JAID_PYTHON`).

## 2 · Root files — the exact contract

**package.json scripts — these NAMES are the contract** (`npm run dev` opens the
DESKTOP APP in every repo; getting this wrong is the #1 confusion):

```jsonc
{
  "dev": "tauri dev",              // THE APP — window + sidecar-spawned server
  "dev:vite": "vite",              // browser-only dev loop (:1420)
  "build": "tauri build",
  "build:vite": "vite build",
  "preview:vite": "vite preview",
  "server": "cd server && node ../scripts/py.js -m <snake_name>.serve serve",
  "test:server": "cd server && node ../scripts/py.js -m pytest -q",
  "lint": "biome check src",
  "tauri": "tauri"
}
```

- **`scripts/py.js`** — the venv-python resolver (copy from just_ai_i18n_docgen;
  self-contained). Bare `python` resolves to whatever is first on PATH and the failure
  reads as broken test config instead of a missing install.
- **biome.json** — copy from JW/i18n-docgen verbatim, including the `**/*.vue` override
  that turns `noUnusedImports`/`noUnusedVariables` OFF for SFCs (biome cannot see
  template usage; without the override every view file is a false positive).
- **index.html** — the app's real `<title>`; the CSP comment (headers come from
  tauri.conf, a meta CSP would break the IPC bridge); no scaffold logos.
- **.gitignore** — `node_modules`, `server/.venv`, `__pycache__`, `*.egg-info`,
  `.pytest_cache`, `.ruff_cache`. **`dist/` is COMMITTED** — the server serves it
  headless and a user needs no npm install.
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
  port: 1420, strictPort: true,
  fs: { allow: [resolve(__dirname), resolve(__dirname, "../just-llm-runner/ui")] },
  proxy: { "/v1": "http://127.0.0.1:<PORT>" },   // dev rides the proxy to the server
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
- **Transport**: the kit's `configureServerApi` + `makeOriginAwareResolver({ devPorts:
  ["1420"], fallback: "http://127.0.0.1:<PORT>" })`, called once in `main.js` — and the
  SAME resolved base into **`configureLlmUi({ baseUrl: resolveBase() })`**: with no
  baseUrl the kit falls back to `window.location.origin`, which is `tauri.localhost` in
  the packaged webview, and every kit LLM view renders empty IN PRODUCTION ONLY (found
  live 2026-08-03). Also `configureExternal` (Tauri swallows `_blank` — without it every
  external link is silently dead in the desktop app). Never hand-rolled fetch helpers.
- **Wire shape: camelCase** — matching the shared stack's `CamelModel` contract.
- **NAME YOUR DONOR** (user-ruled 2026-08-03, after a hand-rolled disk-usage panel
  shipped beside JW's canonical one): before writing ANY UI element, name where it
  already exists — a kit export, a JW section, a JV section. Hand-writing is allowed
  only after that search comes up empty, and the new piece is then usually born in the
  kit. Copy donors WHOLE — strings, confirms, loading states — never a lookalike.
- **TitleBar** (JW `components/TitleBar.vue` is the donor): an in-app toolbar above the
  content — back/forward over the router's history state, the current title, the mode
  control and `AiStatusButton` on the right. Every app carries one; a shell without a
  native-feel title row was ruled a divergence (2026-08-03).

## 5 · The Tauri shell

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

- **Portable data root**: `data/` beside the exe when writable, else the OS app-data
  dir; a `dataroot.txt` pointer (outside the root, atomic tmp+rename writes) records a
  user override; `storage_get_root`/`storage_relocate` commands do the crash-safe move
  (copy → rename → pointer commit → delete old).
- **Spawn arms**: debug prefers `server/.venv/…/<name>-server(.exe) serve` resolved
  from `CARGO_MANIFEST_DIR/..` (so `npm run dev` works from ANY shell), then PATH,
  then `python -m <snake_name>.serve serve`; release spawns the bundled exe beside the
  app. Always with `DATA_DIR_ENV` set.
- **Port eviction**: a stale listener on the port is killed before spawning
  (netstat/taskkill · lsof/kill); still-occupied → reuse with a loud warning.
- **Never spawn the unqualified app name** — the Tauri binary shares it, and Windows
  resolves it to OUR exe first: an infinite window-spawn loop (JW's lesson).
- **Escape hatch**: `<ABBR>_DEV_NO_SIDECAR` env skips the spawn for manual-server dev.
- **Teardown**: `WindowEvent::CloseRequested` → kill the child. Single window, no tray.
- **Plugins**: `tauri-plugin-window-state` is standard (window geometry persists).
  `dialog`/`fs`/`http` are added when a feature needs them, not by default.

## 6 · The Python server

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
- **Data dir**: `--data-dir` flag → `<SNAKE_UPPER>_DATA_DIR` env → `platformdirs`.
  The shell sets the env var; everything the server writes lives under it.
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
(README "Consume it" has the full tiers; this is the app recipe):

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
  (via `configured_service()`), never `<data_dir>/ai-cache`.
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

## 9 · Adding llm-runner to an EXISTING Python app (the JV path)

Full convergence, in order: (1) delete concepts the shared stack replaced (JV's
`llm_roles`); (2) adopt `install_llm`, replacing à-la-carte mounts; (3) migrate
providers from app settings into the DB store, one-time, idempotent by id; (4) boot
the registry from the DB; (5) rename any same-name app tables that collide with the
shared schema (JV's `feature_prompts` → `jv_feature_prompts`); (6) stand up a runnable
suite — convergence without one just resets the rot clock. JustVoice commits
`14b3ea7`/`aa1363f` are the worked example.

## 10 · The e2e harness — the real webview is the acceptance surface

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

| Chrome | Canonical | App writes |
|---|---|---|
| **AI area** (providers CRUD, model catalog + downloads, presets, usage/tokens) | kit `AiModelsArea` (JW `AiView.vue` = that + one app tab) | one route (`/ai`), one component |
| **Global AI progress + cancel** | kit `AiStatusButton` → `AiStatusPanel` in the TitleBar, PLUS a sidebar nav row "AI tasks" toggling the same panel with a count/error badge (JW `Sidebar.vue:148`) | one mount + one nav row |
| **TitleBar** | JW `components/TitleBar.vue` | back/forward, title, mode, status chip |
| **Settings page** | JW `/settings/:section?` pattern | sections rail + panels below |
| — Appearance | kit engine + catalogs (`UI_FONTS`, `ACCENT_PRESETS`, `UI_SCALES`); JV panel shape | mode/font/accent/scale controls over `setAppearance` |
| — Storage | shell `storage_get_root`/`storage_relocate` (§5) + shared `make_disk_router(data_dir)` | path display, relocate control, usage table |
| — Logs | platform `install_log_ring()` + `install_file_log()` + `make_logs_router(name)`; kit `LogsPanel` | 3 server lines, one component |
| — Server | JW's headless/auth section: headless URL + bearer tokens over the app's auth endpoints | one panel |
| — About | version, repo | one panel |
| Backup/restore/reset | platform `make_data_router` + kit `DataManagement` | when adopted — record if deferred |

Server wiring is JW's exact lines, ring BEFORE app construction:

```python
install_log_ring()
install_file_log(data_dir / "logs" / "<kebab-name>.log")
app.include_router(make_logs_router(PRODUCT))
app.include_router(make_disk_router(data_dir))
```

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

**Setup wizards**: machinery in the kit (`useCatalogMeta`, `useRunnerModels`,
`useModelApply`, `DownloadBar`, `createDownloadTask` + the three channels), the wizard
VIEW per app (steps + words) — JV's TTS wizard was always app-local, i18n's translate
wizard follows, and `AiModelsArea`'s `wizard` prop mounts it. JW's `QuickSetup`
(embedding woven through) stays JW's. The SHAPE to copy is its step machine: advance on
TERMINAL TASK STATES (`done` | `error` | `cancelled` from `createDownloadTask`), never
on a watched model status — a derived status cannot report three of those four
outcomes. During a run the footer carries no buttons and the modal is `:closable="false"`,
so each `DownloadBar`'s own Cancel is the only cancel on screen.
Trap, found live (i18n 2026-08-03): `setAsDefault(providerId, modelId)` — the FIRST
argument is the PROVIDER (`setAsDefault(LOCAL_RUNNER_ID, id)`, QuickSetup.vue:466).
Passing the model alone rewrites every task preset's `providerId` to a model id and
then toasts success; no smoke test catches it, because none completes a model load.

**The boot-splash first-run offer** (a strip on the splash: "set up local AI"): gate
it on NO DEFAULT PROVIDER AT ALL (`currentDefaultProviderId` empty). Gating on
`currentDefaultId` is wrong — that value is local-gated, so an online-default box
reads as "no AI" and gets nagged every boot. JW's shape is different and also fine:
its offer is a modal dialog, fired ONCE ever via the persisted `aiSetupPrompted`
setting. Pick one deliberately: once-ever flag for an intrusive surface, live
no-default-at-all gating for a strip that only exists on the boot screen (i18n).

And the test is CONTENT, not mounting: log a marker line, fetch `/v1/logs/tail`,
assert the marker (a 200 from an empty ring proves nothing).

## 12 · Definition of done — a new app ships when every box checks

- [ ] `npm run dev` opens the DESKTOP APP with the server spawned by the shell
- [ ] `npm run dev:vite` + `npm run server` = the browser loop at :1420 via the proxy
- [ ] `npm run test:server` green from a fresh clone (`scripts/py.js` resolves the venv)
- [ ] `npm run lint` (biome) and server `ruff check` clean
- [ ] `npm run build:vite` clean; `dist/` committed; the server serves it headless
- [ ] tauri.conf: real productName/identifier/title; sidecar constants set; port claimed in §1
- [ ] Closing the window kills the Python process (no orphan on :PORT)
- [ ] All routes under `/v1/*`; wire shape camelCase
- [ ] Kit-first UI; any new control landed in `@delebash/llm-ui`
- [ ] `install_llm` + seeds + registry boot per §8; presets own every tunable
- [ ] Error envelope + CORS per §6, with the Origin-header test that bites
- [ ] `e2e/` harness per §10; `npm test` (smoke, real webview) green against the
      release build; `npm run screenshots` captures every surface
- [ ] The standard app chrome per §11: `/ai` area, AiStatusButton, Settings with
      appearance/storage/logs/about, log ring + file + router with the content test
- [ ] CLAUDE.md present, first Where-to-look row → this document
- [ ] Any deviation: flagged to the user AND recorded here
