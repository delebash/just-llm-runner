# The three-app job matrix — Phase 0 evidence (2026-08-14)

**What this is.** One row per JOB the three apps must do, one column per app, a
`file:line` in every cell. Not a search — an enumeration. The method changed
because the old one could not have worked: you cannot grep for the same job done
differently. JustVoice's folder opener was
`std::process::Command::new("explorer")`, JustWrite's was `open::that`,
i18n-docgen's was `tauri_plugin_opener::open_path` — three implementations of
three lines, sharing no text. A search-driven audit finds repeated *strings* and
is structurally blind to duplicated *intent*. An omission is worse: it has no
text at all, so nothing can match it.

**Read the cells, not a summary.** A blank cell means NOT CHECKED — never "same".

**Anything about whether something WORKS is tested, never reasoned.** The one
place this file originally reasoned from a code comment instead of running the
code, it was wrong (see "Verified by test"). "Likely" is not a finding.

**Method limit, stated up front.** This covers the SHELL + renderer plumbing +
project structure. It is not a server-internals review, not a UI review, and not
a per-feature parity check. Rows below the matrix name what was deliberately not
enumerated.

---

## The headline

`node scripts/check-family.mjs` reports **✓ no violations** today — while the
three apps open a folder three different ways, ship three different plugin sets
and three different capability sets, and reach `invoke` two different ways. The
guard is real and it passes; it simply does not look at any of this. That is the
same failure as a hand audit reporting sameness, only automated. **Every row
converged in Phase 2 needs a check that would have failed today, or the row will
drift back and the guard will keep saying ✓.**

---

## A · Native jobs (the Tauri shell)

| Job | JustVoice | JustWrite | i18n-docgen |
|---|---|---|---|
| Open a URL | `plugin-opener` `openUrl`, `src/main.js:17,61` | same, `src/main.js:38,62` | same, `src/main.js:5,30` |
| Open a folder | `plugin-opener` `openPath`, `src/main.js:17,61` | same, `src/main.js:38,62` | same, `src/main.js:5,30` |
| Open a folder (tray "open logs") | `tauri_plugin_opener::open_path`, `lib.rs:829` | same, `lib.rs:676` | same, `lib.rs:512` |
| Pick a folder | cmd `pick_directory`, `lib.rs:474`; called `SettingsView.vue:762` | cmd `pick_directory`, `lib.rs:39`; called `native.js:32` | cmd `pick_directory`, `lib.rs:356`; called `SettingsView.vue:84` |
| Pick a file | **none** | cmd `pick_file`, `lib.rs:202` | **none** |
| Save a file (native dialog) | **none** | cmd `shell_save_file`, `lib.rs:152` | **none** |
| Read the data root | cmd `storage_get_root`, `lib.rs:491` | `lib.rs:67` | `lib.rs:344` |
| Move the data root | cmd `storage_relocate(new_root)`, `lib.rs:502` | `lib.rs:80` | `lib.rs:373` |
| Keep-server-running | cmd `set_keep_server_running`, `lib.rs:552` | `lib.rs:557` | `lib.rs:423` |
| Tray labels from i18n | **none** | cmd `set_tray_labels`, `lib.rs:616` | **none** |
| Sidecar spawn | in `lib.rs` setup + `start/stop/restart_server` cmds `lib.rs:424,438,444` | in `lib.rs` setup, no cmds | in `lib.rs` setup, no cmds |
| Window state | `tauri_plugin_window_state`, `lib.rs:863` | `lib.rs:718` | `lib.rs:536` |
| Cross-origin fetch routing | none | `src/services/tauriFetch.js` (on probation) | none |

**Rows 5, 6 are the live bug** — see finding 1.

### How the renderer reaches a command

| | JustVoice | JustWrite | i18n-docgen |
|---|---|---|---|
| Shape | inline `await import("@tauri-apps/api/core")` per call site | ONE module `src/services/native.js:21` | inline `await import(...)` per call site |
| Sites | 4 — `stores/server.js:65`, `AudioChannelsView.vue:32`, `SettingsView.vue:741,762` | 1 | 5 — `App.vue:58`, `SettingsView.vue:66,84,96,190` |

Two shapes, and the odd one out is the one built today. Needs a ruling either
way — this is exactly the row that drifts back if nothing checks it.

### Rust plugin sets

| Plugin | JV | JW | DG |
|---|---|---|---|
| opener | ✓ `Cargo.toml:26` | ✓ `:30` | ✓ `:22` |
| window-state | ✓ `:20` | ✓ `:23` | ✓ `:23` |
| dialog | ✓ `:21` | ✓ `:20` | ✓ `:24` |
| fs | ✓ `:22` | ✓ `:21` | ✗ |
| http | ✓ `:19` | ✓ `:22` | ✗ |
| process | ✓ `:27` | ✗ | ✗ |

### Capabilities (`src-tauri/capabilities/default.json`)

| Permission | JV | JW | DG |
|---|---|---|---|
| `core:default` | ✓ | ✓ | ✓ |
| `opener:default` | ✓ | ✓ | ✓ |
| `opener:allow-open-path` (scope `**`) | ✓ | ✓ | ✓ |
| `opener:allow-open-url` | ✗ | ✗ | ✓ (redundant — in `opener:default`) |
| `dialog:default` | ✓ | ✓ | ✗ (works: its picker is a Rust-side call, which the ACL does not gate) |
| `fs:default` | ✓ | ✓ | ✗ |
| `http:default` | ✓ **no URL scope** | ✓ **with an 8-entry URL allow-list** | ✗ |
| `process:default` | ✓ | ✗ | ✗ |
| `$schema` | `../gen/schemas/desktop-schema.json` | `https://schema.tauri.app/config/2/capability` | `../gen/schemas/...` |

### npm Tauri packages vs. actual renderer imports

| Package | JV | JW | DG |
|---|---|---|---|
| `@tauri-apps/api` | dep + used | dep + used | dep + used |
| `plugin-opener` | dep + used | dep + used | dep + used |
| `plugin-http` | dep, **never imported** | dep + used (`tauriFetch.js:25`) | not a dep |
| `plugin-fs` | dep, **never imported** | not a dep | not a dep |
| `plugin-process` | dep, **never imported** | not a dep | not a dep |

---

## B · Backup / restore — the shared surface

| | JustVoice | JustWrite | i18n-docgen |
|---|---|---|---|
| Component | kit `DataManagement`, `SettingsView.vue:1204` | `SettingsView.vue:1601` | `SettingsView.vue:232` |
| `save-file` prop passed | **no** | **yes** — `:save-file="canSaveFiles ? saveBackupBlob : null"` | **no** |
| Server router | local `data_admin.get_data_router`, `app.py:77,300` | local `data_admin.get_data_router`, `app.py:47,168` | kit `make_data_router` inline, `app.py:270,290` |
| Restore | kit hidden `<input type=file>`, `DataManagement.vue:144` | same | same |

Same feature, same component, same endpoints. The zip is not a JustWrite
feature — it is the family's one backup surface, mounted by all three.

---

## Verified by test (2026-08-15) — not inferred

The first draft of this file claimed JustVoice's and i18n-docgen's Export backup
"very likely" did nothing, reasoning from JustWrite's code comment. That was a
guess, and it was **wrong**. Both halves were then tested.

**1 · Does the browser fallback save a file inside a real Tauri webview?**
Drove i18n-docgen's built binary (`src-tauri/target/release/…exe`) through its own
e2e harness (tauri-driver + msedgedriver) and executed the exact snippet from
`DataManagement.vue:62-71` — `new Blob` → `createObjectURL` → `<a download>` →
`click()`. Runtime reported by the webview: `Edg/151.0.0.0`.
**Result: SAVED.** `~/Downloads/probe-blob-<ts>.zip`, 13 bytes, content
`PROBE-CONTENT` verified by reading it back, then deleted.
⇒ *WebView2 does NOT ignore `<a download>` on blob: URLs* on this runtime. The
claim in `justwrite-app/src/services/download.js:1-14` no longer holds; it may
have been true when written.

**2 · Does the server half return a real backup?**
`justvoice-server serve --port 8741`, then `GET /v1/data/backup` →
**HTTP 200, 32 910 bytes, `application/zip`, magic bytes `50 4b 03 04` (PK)**.
⇒ JustVoice's endpoint returns a genuine zip.

Both halves pass, so **Export backup works in JustVoice.**

**Attempted and INCONCLUSIVE — recorded so nobody reads it as coverage:** driving
the real button end-to-end in i18n-docgen's UI. The app launched (window title
read back correctly) but `#/settings` yielded zero buttons to the probe — the
release binary is from 2026-08-06 and its bundled UI does not match the selectors
tried. Nothing was learned about docgen's server half; it is untested here.

---

## C · Project structure

| | JustVoice | JustWrite | i18n-docgen |
|---|---|---|---|
| `src/` dirs | components composables config.js i18n router services stores styles views | assets components composables fonts.css i18n router services stores styles views | assets components router services stores styles views |
| `assets/` | **missing** | ✓ | ✓ |
| `composables/` | ✓ | ✓ | ✗ |
| `i18n/` | ✓ | ✓ | ✗ (no i18n) |
| server config | `src/config.js` | `src/services/serverApi.js` | `src/services/serverApi.js` |
| `boot.smoke.test.js` | ✓ | ✓ | ✓ (converged) |
| `e2e/` (tauri-driver) | **missing** — `test` is `scripts/e2e.js` | ✓ | ✓ |
| `scripts/` | **29 entries incl. 8 committed PNGs** + 7 one-off verify/snap scripts | 6 | 1 (`py.js`) |
| vite: dedupe list | identical | identical | identical |
| vite: strictPort / build target | identical | identical | identical |
| dev port / hmr | 1430 / 1431 | 1420 | 1450 / 1451 |

### npm scripts

| Script | JV | JW | DG |
|---|---|---|---|
| `dev` `dev:vite` `build` `build:vite` `preview:vite` `tauri` `server` `lint` `test:unit` `test:server` | ✓ | ✓ | ✓ except `test:server` present, no `preview:vite` diff |
| `test` | `node scripts/e2e.js` | `npm test --prefix e2e` | `npm test --prefix e2e` |
| `smoke` | **absent** (yet `scripts/smoke.js` exists and is the documented gate) | ✓ | **absent** (no `scripts/smoke.js`) |
| `screenshots` | `scripts/smoke_gui.js` | `e2e/capture-direct.js` | `e2e/capture-direct.js` |
| `lint` scope | app only | app only | app **+ the kit's `src`** |
| `test:fast` | ✗ | ✓ | ✗ |
| `bump` / `release*` | ✗ | ✓ | ✗ |
| `i18n:*` | ✗ (has i18n) | ✓ | ✗ (no i18n) |

### Server package

| | JustVoice | JustWrite | i18n-docgen |
|---|---|---|---|
| Common spine (`app.py app_state.py auth.py paths.py serve.py version.py api/`) | ✓ | ✓ | ✓ |
| `database/` `data_admin.py` `errors.py` `feature_catalog.py` `seed_*.py` | ✓ | ✓ | ✗ |
| `cli.py` | ✓ | ✗ | ✓ |
| `tests/` | ✓ | ✓ | ✓ |
| stale `build/` dir committed | ✓ | ✓ | ✗ |

---

## Findings, worst first

1. **Export backup diverges in UX, not in whether it works — and the comment
   that says otherwise is stale. TESTED, see "Verified by test" below.** The kit
   falls back to `URL.createObjectURL` + `a.download` when no `save-file` prop is
   given (`DataManagement.vue:62-71`). JustWrite's `download.js:1-14` claims that
   fallback cannot work — *"WebView2 ignores `<a download>` on blob: URLs"* — and
   that claim is **false on the current runtime**: the file saves. So JustVoice
   and i18n-docgen export fine, straight to the Downloads folder; JustWrite gets
   a native Save-As with a remembered folder. One act, two experiences, and a
   code comment asserting a platform limitation that no longer holds.
2. **`http:default` is unscoped in JustVoice** (`capabilities/default.json`)
   while JustWrite carries an 8-entry URL allow-list. Any future routing of calls
   through the http plugin in JV is denied by an empty scope.
3. **Three dead npm dependencies in JustVoice** — `plugin-fs`, `plugin-process`,
   and `plugin-http` are declared and never imported by the renderer.
4. **Two shapes for calling a command** — one module (JW) vs. inline dynamic
   import at every call site (JV ×4, DG ×4).
5. **Two shapes for mounting the shared data router** — a local `data_admin.py`
   wrapper (JV, JW) vs. the kit factory called inline (DG).
6. **JustVoice has no `e2e/`** — the real-webview acceptance surface the other
   two share, and the one `app-structure.md §10` calls normative. Its `test`
   script points at a bespoke `scripts/e2e.js`.
7. **JustVoice's `scripts/` carries 8 committed PNGs and 7 one-off verify/snap
   scripts**; the other two carry 6 and 1 file.
8. **`smoke` is a script in JW only** — JustVoice's documented gate
   (`scripts/smoke.js`, named in its CLAUDE.md) has no npm script, and docgen has
   no smoke script at all.
9. **Redundant `opener:allow-open-url` in docgen** — already inside
   `opener:default`.
10. **Two `$schema` URLs** for the same capability file.
11. **`assets/` missing in JustVoice**; `config.js` at src root instead of the
    family's `services/serverApi.js`.
12. **Stale `server/build/` committed** in JustVoice and JustWrite.

## Legitimate differences (mark them, so nobody "converges" them later)

- **`cli.py` is NOT a divergence — two different things sharing a filename**
  (row 19, resolved 2026-08-15 by reading both). i18n-docgen's is a **product
  surface**: `translate` · `check` · `escalate` · `accept` · `extract`, the
  headless door of a CLI-first tool. JustVoice's is **dev utilities**:
  `default-settings` · `open-api` · `self-test`. JustWrite needs neither. Do not
  add one to JW and do not "align" them. Worth knowing: docgen's uses `argparse`,
  JustVoice's uses `typer` — irrelevant while they are different concepts, but
  the shape to settle if a dev CLI is ever wanted in every app.

- JustWrite alone has book-level `.zip` export/import — a *book* is a JW concept.
  The save-file PLUMBING under it is NOT a JW concept (finding 1).
- JustWrite alone localises its tray (`set_tray_labels`) — it is the only app
  with a full i18n surface today.
- JustVoice alone has audio capture, hotkeys, dictation, accessibility
  permissions, and a `process` plugin for restart.
- i18n-docgen has no database, no i18n, no feature catalog — it is genuinely a
  smaller app.
- Per-app dev/HMR ports.

## Not enumerated (say so rather than imply coverage)

Server internals beyond package layout · UI components and views · per-feature
parity · the Python test suites · CI · installer/bundling config · the kit's own
internals.

---

## Phase 2 progress — what has actually closed

The tables above are the **"before" record** and are deliberately not rewritten;
closing a row is logged here so the divergence stays visible.

**Row 8 · the cross-origin fetch override — DELETED (tested, not argued).**
The question: does JustWrite need to route calls through Rust to reach its own
sidecar? Test, in the built app driven by tauri-driver, with `JUSTWRITE_DEV_NO_SIDECAR=1`
so a known-live server stayed up (the shell's `spawn_sidecar` otherwise KILLS
whatever holds port 17495 — `lib.rs:387`, which silently ate two earlier runs):

| Probe | Realm | Result |
|---|---|---|
| patched `window.fetch` (through Rust) | `http://tauri.localhost` | 200 |
| **XMLHttpRequest**, never patched | `http://tauri.localhost` | **200 + real body** |
| **same-origin iframe** `fetch`, `patched:false` | `realmOrigin: http://tauri.localhost` | **200 + real body** |

Plain browser networking reaches the sidecar from the app's own origin, so the
override bought nothing. Removed: `src/services/tauriFetch.js`, its `main.js`
call, and `@tauri-apps/plugin-http` + `tauri-plugin-http` + the `http:default`
capability in BOTH apps.

**Then the removal itself was proven, not assumed.** JustWrite was rebuilt with
`npm run tauri build --no-bundle` (13.2 MB, Tauri CLI) and driven again:

| Assertion | Result |
|---|---|
| real app webview | `origin: http://tauri.localhost`, `hasInternals: true`, title `JustWrite` |
| the override is really gone | `fetchIsNative: true` — `window.fetch` is native code |
| the app reaches its server | `GET /v1/health` → **200**, real body |
| the app RENDERED (not the error screen) | 1024 chars, "WELCOME TO JustWrite…", `connError: false` |

**PASS — JustWrite boots, renders and talks to its sidecar with no fetch
override.**

*Four earlier attempts were thrown away rather than reported. Each reason is a
trap worth keeping, because every one of them LOOKS like a result:*

1. *An `about:blank` iframe has a **null** origin, not the parent's — a different
   CORS question entirely. It returned 200 and meant nothing.*
2. *A stale `tauri-driver` left listening on :4444 hands back a blank window
   (`origin: null`, `hasInternals: false`), so the probe measured a blank page
   while appearing to succeed.*
3. *`spawn_sidecar` (`justwrite-app/src-tauri/src/lib.rs:387`) **kills whatever
   holds port 17495** before spawning its own. Launching the app therefore
   murdered the test server, and both fetches failed for want of a server rather
   than for want of the override. `JUSTWRITE_DEV_NO_SIDECAR=1` is the escape
   hatch the shell already provides.*
4. ***`cargo build --release` does NOT produce a production Tauri binary.*** *It
   embeds the **dev URL**, so the app opens `chrome-error://chromewebdata/` with
   the title "localhost" when no vite server is running — and the binary is ~3.6 MB
   against ~16 MB for a real one. Use `npm run tauri build` (add `--no-bundle` to
   skip installers). Anyone testing a packaged app in this family needs this.*

*The probe now asserts `origin === "http://tauri.localhost"` and `hasInternals`
before reporting anything, and refuses to claim a result otherwise. Three of the
four traps above were caught by that assertion rather than by noticing.*

**Row 5 + the deferred plugin question — CLOSED.** `fs` and `process` appeared
ONLY inside their own `init()` calls in both shells — no Rust caller, no JS
import. With `http` gone too, the baseline is now **identical in all three
apps**: `opener`, `dialog`, `window-state`, each one used. npm Tauri deps are
likewise identical: `@tauri-apps/api` + `@tauri-apps/plugin-opener`.

**Rows 4, 6, 7 — CLOSED by the above.** Row 4 (JustVoice's unscoped
`http:default`) is moot: the permission is gone from both apps. All three
capability files are now byte-identical in their permission list, on the same
`$schema`.

Verified after: `cargo check` clean ×2 · biome clean ×2 · vitest 578 (JW) + 48
(JV) · both renderers build.

**File delivery — ONE door, seven sites collapsed (2026-08-15).**
`common/services/fileSave.js` is now the only implementation of "put this file on
the user's disk": native dialog where a host wired one (`configureFileSave`),
browser download otherwise. What it replaced:

| Was | Now |
|---|---|
| JustVoice ×5 — `ExportPanel.vue` (audiobook .m4b + chapter .zip), `AudioToolsView.vue` (mastered audio), `LexiconsView.vue` (lexicon JSON), `LinesView.vue` (voiceline .zip), `ProjectsView.vue` (project .zip) | all call the kit door |
| JustWrite ×1 — `services/download.js` | delegates to the door; keeps ONLY the part that is genuinely JustWrite's — which folder to open at, and remembering where the user put it |
| the kit's own inline copy inside `DataManagement.vue` | gone; the `save-file` PROP is gone with it — a host wires its saver ONCE and every export inherits it |

That prop was the mechanism of the divergence: JustWrite passed it, JustVoice and
docgen did not, so one act had two behaviours. Nothing about JustVoice's behaviour
changes *today* (no native saver is wired there yet), but wiring one is now a
single line rather than five edits.

Verified: biome ×4 clean · JV 48 + JW 578 unit tests · three renderers build · JV
smoke 15/15 · `grep "a.download ="` across JustVoice returns **nothing**. Two JW
test files were rewritten: the browser-fallback assertion moved off JustWrite,
because that decision now belongs to the kit door.

## Proposed guard checks (Phase 3)

Each would have FAILED today. That is the bar — a check that would have passed is
decoration.

1. Every app mounting `DataManagement` passes `save-file` (or declares a reason)
   — a UX-consistency check, not a bug check: without it the export still saves,
   it just lands in Downloads with no dialog and no remembered folder.
2. Rust plugin sets identical across the three, modulo a declared exception list.
3. Capability permission sets identical, modulo a declared exception list;
   `http:default` never unscoped.
4. Every declared `@tauri-apps/*` npm dep is imported somewhere in `src/`.
5. No app-local implementation of a job the family shares — enforced as a
   command-name + parameter-name table the three shells must match.
6. One shape for reaching `invoke` (whichever is ruled canonical).
7. `e2e/` exists in every app; `test` script points at it.
8. Script-name set identical, modulo a declared exception list.
9. No committed binaries under `scripts/`; no committed `server/build/`.
10. No `window.<appname>` global installed by any renderer.
