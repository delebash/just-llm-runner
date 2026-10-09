<!-- SPDX-License-Identifier: MIT -->
# The sync product and the Quasar move — the program (started 2026-10-08)

**The go:** the user, 2026-10-08: "just-sqlite-sync you have a go on it all your recs complete the
whole project without stopping unless you need to, i dont have an andriod phone," and, mid-work,
"we need to do the quasar conversion as well you have a go on that". The sync decisions are
JustWrite's TASKS "Sync — offline first, by file, folder and server"; the sync design is
`2026-10-08-sync-product-design.md`; the Quasar decisions are this repo's TASKS "Every family app
moves to Quasar…"; the Quasar facts are `2026-10-08-quasar-framework-research.md`.

**This file is the order of work and its live status. Update the status line of a step the moment
it changes; a step is DONE only with its commit named.**

## Order, and why

The phone needs both halves (the sync engine, and JustWrite as a Quasar/Capacitor app), so:

1. **S1 · `just-sqlite-sync`** — its own repo beside the kit (`../just-sqlite-sync`, package
   `@delebash/sqlite-sync`, the family's `@delebash/<name without just->` pattern), the engine
   core, both SQLite adapters, the change file + encryption, the by-hand, folder and HTTP
   transports, the convergence tests, docs, CI. Depends on nothing.
2. **S2 · JustWrite's server side of sync** — the diff-based save (design §7.1), ids, the engine on
   the book tables, scene text through Yjs (spike first), the sync routes, export/import, the folder
   scheduler, listening on the network, pairing tokens. No UI yet (the UI is built on Quasar).
3. **Q1 · the family template** — a fresh default Quasar app (the official `npm init quasar`
   scaffold), made the family template with the theming test's theme; Electron mode calling the
   kit's shared desktop function; Capacitor mode; plain JS; Biome.
4. **Q2 · the framework rules** — `docs/app-structure.md` rewritten for Quasar, `scripts/check-family.js`
   checking it; the global CLAUDE.md Stack line (shown to the user first — kit TASKS OPEN 6).
5. **Q3 · the kit's UI on Quasar** — Quasar's components replace the kit's generic controls; the
   family pieces (AI settings, task strip, model catalog, theme) rebuilt on Quasar.
6. **Q4 · JustWrite on Quasar**, then its Settings → Sync screen, then the phone: Capacitor mode, the
   server in a web worker on SQLite WASM, the storage guard, OneDrive/Dropbox sign-in, the QR code.
7. **Q5 · JustVoice on Quasar**, and its sync.
8. **Q6 · docgen on Quasar**.

## Choices made under "your recs" where the record had a gap (each is reversible; listed so the user sees them)

- Package name `@delebash/sqlite-sync` for the repo `just-sqlite-sync` (the kit's pattern:
  `just-llm-runner` → `@delebash/llm-runner`).
- The repo is public on GitHub, like `justwrite-app`, `just-llm-runner` and `audio.cpp`.
- The iOS storage test's workflow lives in `just-sqlite-sync` (the rec: "the product repo once it
  exists").

## Status

- S1: DONE 2026-10-08 — `github.com/delebash/just-sqlite-sync` (public), commits 3a0f3ad (the
  engine, the file, three transports, tests), 448f4ea (OneDrive/Dropbox stores, the storage guard,
  the engine on a phone), 0f425b1 (pure-SQL recording: writes from any connection; flush). 41 tests
  + thousands of seeded convergence runs; CI green on Linux/Windows/macOS; the phone test passes on
  the Android 16 emulator (local) and the iOS 18.7 simulator (GitHub). Its own TASKS: a real
  OneDrive/Dropbox sign-in needs the user's app registrations.
- S2: DONE 2026-10-08 — JustWrite 37152e0 (the save writes only what changed; server/src/sync.js
  — the engine on the book tables, scene text through Yjs on the editor's own schema
  `src/services/editorSchema.js`, the routes, pairing, auto-sync, listening on the network; the
  renderer's ids, window id and reload on sync); kit 02a4560 (CSRF allows the phone webview's
  origins); engine ef846e4 (`openSync({ yjs })`). Server 141/141, unit 590/590, lint, build, the
  headless smoke. The Sync screen and the phone come with Q4.
- Q1: DONE 2026-10-08 — kit ac2385b: `template/` = a fresh default Quasar app (create-quasar 5.0.32) in the family shape (its own `server/` package; Electron mode on the kit's `runDesktopApp`, electron-builder NSIS; Capacitor mode; Biome; the CSP; SPDX headers; README with the traps). Verified: the packaged app (app://, Quasar UI, appShell, server fetch, zero errors), dev mode (server from source, `<repo>/data`), the Android build on the emulator. The kit shell gained `devUrl`/`preload`. The theme (the theming test's Sass-variable mapping, override sheet, icon set) moves into the kit with Q3.
- Strategy for Q3/Q4 (decided while building, under "your recs"): Q3 rebuilds the kit's `Ui*` controls ON Quasar components with the same props, so every app's controls convert at once with few view changes; Q4 then moves each app onto the Quasar project structure (boot files, router, layouts, modes), its Sync screen and the phone.
- Order changed while building (under "your recs", 2026-10-08): **Q4 (JustWrite) before Q3.** Q3
  makes every consumer of the kit's UI need Quasar at once, and docgen's working tree is held (the
  user: "leave it all for now" — JustVoice's TASKS, "REVERSED 2026-10-08"); JustWrite moves onto
  Quasar with the kit's current controls, which are plain Vue and run inside a Quasar app. The
  theme part of Q3 (the kit's Quasar Sass variables) went first, with JustWrite's move — it
  touches only Quasar apps.
- Q2: DONE 2026-10-08 — kit 58a585d "The framework rules on Quasar", then the follow-up commit
  "Quasar rules from JustWrite's move" (the workspace, scripts/node24.js, the kit's theme file): `docs/app-structure.md` §Q (the Quasar app, from the template), §0 relabelled the
  Electron + Vite shape the apps run until they move, the Tauri and Python halves deleted (no app
  runs either); `scripts/check-family.js` kind "quasar" (scripts, server package, desktop main
  and preload, the layout, the CSP, the npm traps) plus the template checked, kind "tauri" and
  its checks deleted; the template's npm scripts made desktop-first and `npm run build` fixed
  (`quasar.config.js` deletes `npm_config_allow_scripts`). The guard passes on the template.
  The global CLAUDE.md Stack line waits for the user (kit TASKS, the Quasar item, OPEN 3).
- Q4: IN PROGRESS — JustWrite on Quasar, on branch `quasar` in the worktree `../justwrite-quasar`
  (the user's checkout `../justwrite-app` runs the app, so the move stays off its master until
  the user merges). Built and verified 2026-10-08: the desktop app in dev mode, the installer and
  the packaged app (app://, the bridge, the server, five routes, zero errors), the headless
  launcher serving the UI from the archive, the e2e 7/7 and the smoke on a copy of the real data,
  unit 590/590, server 141/141, lint, the guard (kind quasar, no violations); ten screens match
  the Electron + Vite build to within 0.02 % of their pixels except Quasar's global disabled rule
  (kit TASKS, the Quasar item, OPEN 5). Then Settings → Sync (JustWrite 366fc62 on `quasar`; the
  kit's `SyncPanel`, fbdb43c): the screen, the user guide `docs/sync.md`, joining with a code when
  the other device is off, the export picker's "changed since the last export", a sync shortly
  after start — checked on a copy of the real data. **The phone waits for a scope answer** (asked
  of the user): which of JustWrite's features run on the phone — the server in a web worker can't
  run the local AI runner (llama.cpp processes), the local search index's embeddings, or the
  file-based autosave; the book itself, its images and versions, sync and remote AI providers can.
  Fastify needs Node, so the worker gets a small router over the same route handlers and a SQLite
  WASM implementation of the kit's database wrapper.
- Q5: the move BUILT — JustVoice on Quasar, branch `quasar` in the worktree `../justvoice-quasar`
  (7e4d71a; its own checkout runs the app, so the user merges). The same shape as JustWrite's, plus:
  the audio.cpp dev build in Quasar's `beforeDev` hook; the dictation pill as a third root; the
  app's stylesheets in Quasar's `css` list (a boot file's CSS is preloaded with its chunk, and
  styles.css @imports Google Fonts, which a CSP blocks — failing the start-up); the height chain on
  `#q-app`; the initial navigation made in the boot file (Quasar installs the router after it).
  Verified: unit 183/183, server 1055/1055, lint, the guard, the smoke on a snapshot of the real
  data, dev mode with the audio.cpp dev build, the installer, the packaged app and the headless
  launcher; ten screens match today's build except disabled buttons. Q5 DONE 2026-10-08 with
  JustVoice's sync — JustVoice ca75306 (projects, scripts, personas, lexicons on the product's app
  layer, just-sqlite-sync e1f703a + c3d93b2; Settings → Sync; docs/sync.md; JustVoice's TASKS lists
  the choices made where the decision had gaps). JustWrite's sync moved onto the same app layer
  (JustWrite 6ed2b63).
- Merged 2026-10-08 by the user's go ("your rec all go"): JustWrite and JustVoice's `quasar`
  branches fast-forwarded into their main branches (JustVoice pushed; JustWrite local). The
  disabled-rule PostCSS step, the template's theme and the Stack line followed the same go.
  Decided the same turn: the phone's scope (JustWrite's TASKS, Sync decision 8) and JustVoice's
  sync scope (projects, scripts, personas, lexicons — JustVoice's TASKS).
- The phone (Q4's last part): planned 2026-10-08 — `2026-10-08-the-phone.md` (what it is, the worker
  server, images by id, sync and AI on the phone, slices, four questions, the blast radius); waits
  for the user's go on it.
- Q3: IN PROGRESS 2026-10-09 — the plan: `2026-10-09-kit-controls-on-quasar.md` (what it is, the
  map, the blast radius, ten slices, the checks). Slice 0 (the theme: the override sheet, the icon
  set from the kit's own icon paths, ripple off, `quasar` deduped, the guard) DONE — all 30
  screens identical to the build before it. Slice 1 (tags, chips) and slice 2 (buttons; Quasar's
  stylesheet in a cascade layer; Quasar in the unit tests) DONE — screens and states identical,
  every app's suites green. Slice 3 (checkbox, switch; the theme's selector rule) DONE. Slice 4 (text fields on QInput; their events the native element's own) DONE. Slice 5 (selects
  on QSelect) DONE, the three apps' end-to-end suites green. Slice 6 (segmented, tab strip,
  slider, progress, the colour picker's popover) DONE.
- Q6: DONE 2026-10-09 — docgen on Quasar, branch `quasar` in the worktree `../docgen-quasar`
  (dce418d), fast-forwarded into docgen's main under the go ("keep going using yo9ur recs … dont
  stop", then "go"); the held tree went into a named stash first (the rec, kit TASKS question 5).
  The same shape as JustWrite's and JustVoice's, without Capacitor. Verified: unit 3/3, server
  161/161, lint, the guard (kind quasar), e2e 20/20 twice on the real project and data folder (the
  suite's Setup create-flow test raced the form's prefill; it now waits), dev mode, the installer,
  the packaged app and the headless launcher; ten screens match the Electron + Vite build except
  live values and the appearance slider (2 px — Quasar's reset of a range input's margin).
  docgen's TASKS, "docgen on Quasar".

## Stops (things only the user can do)

- OneDrive and Dropbox sign-in need app registrations under the user's accounts (an Azure app id,
  a Dropbox app key) — the code takes them as settings; the real sign-in waits for them.
- No Android phone (the user, 2026-10-08): the low-storage test stays on the emulator.
