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
- S2: in progress — JustWrite's server side. Done so far (uncommitted in JustWrite): yjs,
  @tiptap/y-tiptap, y-protocols, @tiptap/html, happy-dom added; the editor's extensions moved to
  `src/services/editorSchema.js` (one list for the editor and the server; RichEditor.vue and
  editorMentions.js use it; loads in Node). Next: book_io's diff save (§7.1), `server/src/sync.js`
  (the engine on the book tables, the scene-HTML adapter), the routes, ids, the renderer's client
  id + reload, reset/restore hooks, tests.
- Q1–Q6: not started.

## Stops (things only the user can do)

- OneDrive and Dropbox sign-in need app registrations under the user's accounts (an Azure app id,
  a Dropbox app key) — the code takes them as settings; the real sign-in waits for them.
- No Android phone (the user, 2026-10-08): the low-storage test stays on the emulator.
