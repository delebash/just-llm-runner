<!-- SPDX-License-Identifier: MIT -->
# The family's sync product — the design (2026-10-08)

**Status: designed; nothing built.** The decisions behind it, verbatim, are JustWrite's TASKS "Sync
— offline first, by file, folder and server" (items 1–7); the discussion and the round-2 tests are
JustWrite's `docs/plans/2026-10-08-sync-design.md`; the research is this repo's
`docs/plans/2026-10-08-sync-research-*.md` and RESEARCH §2 "Sync" / "Sync, round 2". This file is
the design until the product's own repo exists, then it moves there. The product's name is the
user's to pick ("The name is yours to pick") — below it is called **the sync engine**.

---

## 1 · What it is

A sync engine for SQLite databases, owned by one person and used on many devices. Every device keeps
a full copy and works offline; devices swap changes by a file carried by hand, through a cloud folder,
or over HTTP with a server or another device. Its own repo and npm package, plain JavaScript, built to
product standard (a versioned file format, real docs, heavy tests). It works on any SQLite database
whose synced tables have primary keys, on Node (better-sqlite3) and in a browser or phone webview
(the official SQLite WASM). The kit uses it, so JustWrite, JustVoice and docgen get it.

**In:** one owner · many devices · any schema with primary keys · field-by-field merge · rich-text
columns that merge edit by edit · three transports · end-to-end encryption for files and folders.
**Out until wanted** (the design must not block them): many users, permissions, partial sync, other
languages.

## 2 · How authors use it

Six ways, one change format underneath. Every device has a name ("Dan's laptop"); the sync status
always shows the last sync, from which device, and changes waiting.

| Way | When | Setup |
|---|---|---|
| 1. Same Wi-Fi | at home | Desktop: Settings → Sync → "Let my other devices connect" → a QR code. Phone: Sync → Pair → scan it. |
| 2. Cloud folder | anywhere; the laptop may be off | Desktop: pick a folder in Dropbox or OneDrive. Phone: sign in to OneDrive or Dropbox in the app (the service's app folder, `Apps/<app>`, the same folder the desktop sees). Each device writes only its own files; they're encrypted with the library key, scanned once per device. |
| 3. By hand | no network, no accounts | Export changes → the books changed since the last export are ticked → one file → send it any way → Import on the other device, which merges. |
| 4. Internet, direct | phone away, laptop at home and on | Install Tailscale or ZeroTier on both, log in; pair as in 1 with the laptop's Tailscale/ZeroTier address. Our docs explain it; no code of theirs in ours. |
| 5. Your own server | an always-on copy; any browser | `<app>-server` on a NAS or a rented machine; each device pairs with it (address + token, or the QR code). |
| 6. Server only | a phone short on storage | "Use the server directly" — online only, nothing stored on the device (the thin client). |

What the author sees when it works: writes on the desktop, closes it, opens the tablet: "Synced 2 min
ago · from Dan's laptop", and the chapter is there. A paragraph added on the phone and a typo fixed in
the same scene on the desktop both survive. Nothing asks the author to resolve a conflict.

## 3 · How it works

### 3.1 Library, devices, tables

- A **library** is one app's database. It has an id (random, made once) shown nowhere but in the
  files. Each **device** has a random id and a name the user can edit.
- The app tells the engine which tables sync and their primary keys, plus which columns are rich text
  (§3.6) or blobs. Everything else is per device (settings, keys, AI tables, search index, stats).
- Engine tables, created by the engine: `sync_meta` (library id, device id, device name, schema
  version, the clock's last value), `sync_clock` (one row per synced field: table, primary key,
  column, stamp, origin device, origin sequence), `sync_peers` (per origin device, the highest
  sequence this device holds — its version vector), `sync_text` (per rich-text field, its Yjs state).

### 3.2 Recording changes

Triggers generated from the table list, `AFTER INSERT / UPDATE / DELETE` on each synced table (tested
on JustWrite's real schema, foreign keys and `ON DELETE CASCADE` on: the cascade fires the child
tables' delete triggers). For each changed field the trigger stamps it and upserts its `sync_clock`
row; a delete stamps the row's `__row` entry as deleted. **History-free:** only the latest stamp per
field is kept, and the value is the current row — no log of old values (the round-2 test's full log
cost 10× the write time; cr-sqlite's history-free clock cost 2.5×). Triggers stay quiet while the
engine applies remote changes (a SQL function the engine controls). The stamp and the flag are SQL
functions registered from JavaScript: better-sqlite3 `db.function`, SQLite WASM `db.createFunction`.

### 3.3 The clock

A hybrid logical clock: wall time in ms, a counter, the device id — written as one sortable string
(`<ms base36, 11>-<counter base36, 4>-<device id>`), so two stamps never tie. Receiving a stamp moves
the local clock forward; a remote stamp more than a day ahead of local time is refused and reported
(a device with a wrong clock can't win every field forever).

### 3.4 Merging

- **Per field, the newer stamp wins.**
- **A delete** stamps the row; field edits older than the delete are ignored; an insert newer than
  the delete brings the row back.
- **Rich-text columns merge edit by edit** (§3.6) — never a winner.
- **Blobs** (images) are rows like any other; their bytes travel once.
- Applying a batch is one transaction with `PRAGMA defer_foreign_keys = ON`, so order inside a batch
  doesn't matter; a failed batch changes nothing.
- Every applied field keeps its origin (device + sequence), so a device relays what it received: a
  third device that only ever syncs with the second ends equal (tested).

### 3.5 What each device already has

Version vectors: each change carries its origin device and that device's sequence number. A device
keeps, per origin, the highest sequence it holds (`sync_peers`). To sync with a peer it sends the
changes whose sequence is above the peer's vector for that origin — so nothing comes back to where it
came from (round 2's naive "changes since" sent 910 rows back after an 11-row edit). History-free
means a field overwritten later has only its newest change left; an older sequence that vanished was
superseded, never lost (cr-sqlite's rule, as Fly.io's fork documents).

### 3.6 Rich text: scenes merge with Yjs

The editor stays as it is and keeps saving HTML. The engine holds a Yjs document per rich-text field
(`sync_text`). When the app writes new HTML into such a field, an **app-supplied adapter** turns it
into a ProseMirror document and `y-prosemirror`'s `updateYFragment` changes the Yjs document by the
smallest difference — the same function y-prosemirror's editor binding calls on every keystroke. The
change that travels is the Yjs update, not the HTML. Receiving one merges it into the Yjs document
and the adapter renders the merged HTML back into the field. Why on the server and not in the editor:
JustWrite's chapter editor holds every scene of a chapter and splits them on save
(`SceneBoundary`, `src/services/sceneSplit.js`), so a per-scene Yjs binding in the editor doesn't
fit; server-side, each scene's HTML diffs into its own document.
**Needs:** the editor's schema importable in Node — today it's built inline in
`src/components/RichEditor.vue:370-398` with Vue node views; the schema moves to a plain module, the
node views stay in the component. **To prove first (slice 3's spike):** `updateYFragment` exported
and stable; TipTap's HTML parsing in Node (`@tiptap/html`).

### 3.7 Schema versions

Each change file carries the app id and its schema version. A device refuses changes from a newer
schema ("Update JustWrite on this device to sync") and accepts older ones (columns they lack keep
their local values).

## 4 · The change file

One format for all transports: a header (format version, app, library id, schema version, sender
device, created, encryption), then the changes (table, primary key, column, value or Yjs update,
stamp, origin device, origin sequence), as JSON lines, gzip-compressed. Blobs travel as base64 inside
it. **Encrypted** when it leaves the device through a file or folder: AES-256-GCM with the library
key, through WebCrypto (built into Node and every webview — no dependency). The library key is made
on the first device and moves to others in the pairing QR code.

## 5 · Transports

### 5.1 By hand

Export: the picker lists the books (any app-defined unit), the ones changed since the last export
ticked; the file holds those books' current state as changes (every field with its stamp), so
importing it twice, or importing an older file, changes nothing that's newer. Import: decrypt, check
schema, apply. Size: prose is 5.5 bytes a word as stored (measured), so a 90,000-word novel is about
0.5 MB; images add their own bytes.

### 5.2 Cloud folder

`<folder>/<library id>/<device id>/` holds that device's numbered change files and periodic
snapshots; a device writes only in its own folder and reads all others (no two devices ever write
one file — backless-core's layout, which round 2 found; Super Productivity's single shared file is
the failure it avoids). Sync runs when the app opens, when it closes, and every few minutes. Every
100 files a device writes a snapshot and later deletes the files it covers; a device that fell behind
a deleted range restarts from the snapshot; folders of devices silent for 60 days are pruned (the
user can see and remove devices). Files are written as `.tmp` and renamed (OneDrive doesn't sync
`.tmp` files). **Desktop:** the folder on disk. **Phone:** OneDrive's app folder through Microsoft
Graph (`/me/drive/special/approot`, sign-in in the system browser with PKCE), then Dropbox's App
Folder; Google Drive later (its app-data folder is hidden from the desktop).

### 5.3 HTTP — a server or another device

Three routes on every app server: `GET /v1/sync/hello` (library, device, version vector),
`POST /v1/sync/pull` (my vector → your changes), `POST /v1/sync/push` (my changes). Every device's
server is a peer; "your own server" is a peer that's always on. Auth: the pairing token as a bearer
token (the servers already have bearer auth: `server/src/api/server_auth_api.js`, the kit's
`platform/auth.js`). Same Wi-Fi, Tailscale, ZeroTier and a rented server are all just addresses.

### 5.4 Pairing

Desktop, Settings → Sync → "Let my other devices connect" (off by default): the server listens on the
network instead of only `127.0.0.1`, makes a device token, and shows a QR code with its addresses
(the LAN address, plus a Tailscale/ZeroTier one if present), the token and the library key. The phone
scans it. Windows Firewall asks once.

### 5.5 Server only (the thin client)

The kit already supports pointing an app at another server with a token (`serverOverrideKey`,
`configureServerApi({ authToken })`); JustVoice wires both, JustWrite neither, and neither has a
screen. Sync adds the screen: "Use the server directly".

## 6 · The phone

- The app's server code runs in a web worker on `@sqlite.org/sqlite-wasm` over `opfs-sahpool`
  (tested on an Android 16 emulator: works, survives a force-stop and an app update; iOS untested).
- **Storage guard:** Android WebView storage is best-effort (`persist()` is always denied). The phone
  also writes its outgoing change files to the app's native data folder (`@capacitor/filesystem`); if
  the webview's database is found empty, it rebuilds from them.
- **Plain HTTP to private addresses:** Android blocks it from our `https://localhost` page by default;
  the app's network config allows cleartext for private address ranges (Tailscale/ZeroTier encrypt
  the traffic); iOS needs `NSAllowsLocalNetworking`.
- The phone app is the Quasar/Capacitor app of the Quasar move, which isn't built yet, so the phone
  slice waits for it.

## 7 · What JustWrite has to change first

1. **The save must write only what changed.** Today every save deletes all of the book's rows and
   re-inserts them (`server/src/book_io.js:205-206`); with change recording on, every field would get
   a new stamp and overwrite the other device's edits. The fix keeps the whole-book PUT: the server
   remembers, per open renderer, the rows that renderer last loaded or saved; a PUT is diffed against
   *that*, and only the user's own edits are written (a field a sync changed meanwhile isn't in the
   diff, so it stays). The renderer sends a client id with its book requests and reloads the book
   when a sync changed it (a light status poll; JustWrite has no server push today).
2. **Ids:** `uid(prefix)` = time + 4 random base-36 characters (`src/stores/project.js:29`, 34 call
   sites) → time + 16 random characters, so two devices can't collide.
3. **Synced tables:** `projects` + `PROJECT_TABLES` (`server/src/book_io.js:31-53`) + `image_blobs`
   + `chapter_versions`; out: chats (position-keyed: `chat_messages`, `chat_session_messages` — later),
   `sweep_drafts`, `rag_*`, `sessions*`, `settings`, the AI tables. `scenes.body` is the rich-text
   column.
4. **Listening on the network:** a setting, off by default (today `127.0.0.1`,
   `server/src/serve.js:64`).
5. **The thin client:** wire `serverOverrideKey` and the token, as JustVoice does.
6. Known and accepted for v1: two devices reordering the same list at once can leave equal positions
   (the list then orders by position, then id); the bundled tutorial book has fixed ids, so two
   devices' tutorial copies merge into one.

## 8 · The engine's shape

Plain JS ESM, no native code. One adapter per SQLite binding, both synchronous: better-sqlite3 and the
SQLite WASM OO1 API. Roughly:
`openSync({ db, app, schemaVersion, tables: { scenes: { pk: ["project_id", "id"], text: { body: adapter } }, … } })`
→ `{ changesFor(vector), apply(changes), vector(), exportFile(filter, key), importFile(bytes, key),
folder(fsLike), routes(fastify) }`. Dependencies: `yjs` and `y-prosemirror` only where an app uses
rich-text columns.

## 9 · Tests

- **Convergence:** random inserts, edits, deletes and re-inserts on three copies, synced in random
  orders over random transports — all three must end identical, every run (seeded, thousands of runs).
- Clock: skew, the far-future refusal. Apply: a failing batch leaves nothing. Files: tamper and
  wrong-key rejection, older-schema import.
- JustWrite: a save after a sync keeps the synced fields; deleting a book syncs; the tutorial book.
- Phone: the Android emulator test (done for storage), then the engine inside it; iOS on GitHub's
  Mac runners with the simulator (the workflow's repo is open, §11).

## 10 · Build order

1. The product repo (needs its name) and the engine core: tables, triggers, clock, merge, apply,
   version vectors, both SQLite adapters, the convergence tests.
2. The change file and the by-hand transport, with encryption.
3. Rich text: a spike proving `updateYFragment` + TipTap HTML in Node on JustWrite's schema, then the
   text columns and JustWrite's adapter (the schema moved out of `RichEditor.vue`).
4. JustWrite: the diff-based save (§7.1), ids, the table list, Settings → Sync (export/import), docs.
5. The cloud folder on the desktop: layout, snapshots, pruning, the UI.
6. HTTP sync and pairing: the network setting, tokens, the QR code, the thin-client screen, the
   Tailscale/ZeroTier/Syncthing docs.
7. The phone, once the Quasar/Capacitor app exists: the worker server, the storage guard, OneDrive
   and Dropbox sign-in, scanning the QR code, the network config; the iOS test.
8. JustVoice and docgen adopt it (JustVoice's audio files as content-addressed blobs).

## 11 · Open

- The product's name (the user's).
- Which repo holds the iOS test workflow — lean: the product repo once it exists.
- A real Android phone for the low-storage test.
- Does the first phone release ship with sync? (The user's earlier "3 sync" was read as yes; not
  confirmed.)

## 12 · Blast radius (greps, 2026-10-08, JustWrite unless named)

The whole-book save and its callers:
```
server/src/book_io.js:205-206   // Wipe existing child rows; reinsert below.
                                for (const t of PROJECT_TABLES) h.run(`DELETE FROM ${t} WHERE ${t}.project_id = ?`, [projectId]);
server/src/api/projects_api.js:50   bookIo.decompose(getDb(), req.params.project_id, pyOr(req.body, {}));   (PUT /v1/projects/:id)
server/src/api/projects_api.js:64   bookIo.decompose(getDb(), req.params.project_id, pyOr(req.body, {}));   (PUT /v1/projects/:id/book)
server/src/book_io.js:809           h.tx(() => decompose(h, projectId, internalizeImages(...)));          (importBookSnapshot: import + sample seeder)
src/services/projectApi.js:83       return put(`/v1/projects/${id}/book`, snap, { keepalive: true })
src/stores/project.js:42            function saveSnap(id, snap) { if (id) projectApi.putSnapshot(id, snap); }
src/views/SettingsView.vue:490      flushPending();
tests mocking putSnapshot: deleteProject.test.js:23, entityLinks.test.js:23, sceneSplit.test.js:18, projectHistory.test.js:16
```
Raw SQL writes the triggers will also see (all on per-device tables or the save above):
```
server/src/api/chat_api.js:138      DELETE FROM chat_messages …        (chats: not synced in v1)
server/src/api/rag_api.js:120       DELETE FROM rag_vectors …          (not synced)
server/src/api/sessions_api.js:61-63 DELETE FROM sessions / session_chapter_words / session_meta (not synced)
server/src/api/settings_api.js:51   DELETE FROM settings …             (not synced)
server/src/data_admin.js:57-58      DROP TABLE …                       (reset: sync tables must be dropped/re-made with it)
```
Ids: `src/stores/project.js:29` `const uid = (p) => \`${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}\`` — 34 `uid("…")` call sites; `src/services/aiDiff.js:14` and `src/services/markers.js:29` have their own `uid()` for in-text marks (not database keys; unchanged).
The editor schema: `src/components/RichEditor.vue:370-398` (extensions inline; `SceneBoundaryView.vue` node view); copies in `src/ui-test/{element,quasar}/RichEditor.vue:376` (the theming test).
Listening and the thin client: `server/src/serve.js:64` `host: env.JUSTWRITE_HOST ?? "127.0.0.1"`; `src/main.js:50-74` (no `serverOverrideKey`, no `authToken`); kit `server/src/shell/main.js:240-243` CSP `connect-src 'self' http://127.0.0.1:* http://localhost:*` (a desktop window pointed at another server needs it widened).
Foreign keys: every book table `project_id → projects(id) ON DELETE CASCADE` (`server/src/database/models.js:13`); the cascade fires our delete triggers (tested).
