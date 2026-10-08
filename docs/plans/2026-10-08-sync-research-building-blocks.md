<!-- SPDX-License-Identifier: MIT -->
# Sync building blocks — facts (2026-10-08)

**What this is.** One of two research records behind the family's sync decision (the user,
2026-10-08: "no we need to decide on sync method for jw and make it so we coudl add it to other
apps easily if we decide we want to say sync acrross desktops or just run the server in the
cloud"). The design discussion is JustWrite's `docs/plans/2026-10-08-sync-design.md`; the other
record is `2026-10-08-sync-research-platforms.md` (the ready-made sync services); the register's
summary is RESEARCH §2, "Sync". Gathered by a research agent on 2026-10-08; nothing in any repo
was changed. **Nothing is decided.**

Sources: each project's own pages, the npm registry (`npm view … dist-tags time license`), the
GitHub API (repo licence, last push, releases, issues). Every fact below is *web, 2026-10-08*
unless marked *measured, 2026-10-08* (run on the dev machine: Windows 11, Node 26.5.0, and
Electron 44.7.0's Node 24.21.0 under `ELECTRON_RUN_AS_NODE=1`, against the installed packages;
scripts lived in the scratchpad, no repo touched) or *code* (read from our repos).

**Our versions (code, 2026-10-08):** the kit's `server/package.json` has `better-sqlite3 ^13.0.3`
(installed 13.0.3) and `engines.node >=24.0.0`; JustWrite gets better-sqlite3 through the kit
(`@delebash/llm-runner: file:../just-llm-runner/server`; JustWrite's own package.json names it
only under `allowScripts` and the build file filters). JustWrite: TipTap `^3.27.1` (npm latest is
3.31.4, 2026-09-30), `electron 44.7.0`.

---

## 1 · SQLite's session extension

**What it is.** A C extension in the SQLite amalgamation since 3.13.0, off by default; enabled
with `-DSQLITE_ENABLE_SESSION -DSQLITE_ENABLE_PREUPDATE_HOOK` (or `--enable-session`).
A session object attached to tables records changes; it produces a *changeset* or a smaller
*patchset* that can be applied to another database.

**What a changeset/patchset records** (sessionintro.html, sqlite3session_changeset.html):
- INSERT: "the values of each field of a new database row".
- DELETE: "the original values of each field of a deleted database row".
- UPDATE: "the original values of each field of an updated database row" and "the updated
  values for each updated non-primary-key column".
- A primary-key update is recorded as a DELETE + INSERT.
- Net effect per row: "For each unique primary key value, data is only recorded once" — insert
  then delete in one session leaves nothing; delete then re-insert becomes an UPDATE.
- Order: changes grouped per table, tables in attach order, order within a table undefined.
- Patchset: DELETE carries "the PRIMARY KEY fields only"; UPDATE "the PRIMARY KEY fields and the
  new values of modified fields only"; gives "more limited conflict detection and resolution
  options".
- Changesets can be inverted ("undoes the changes made by the original") and concatenated
  (`sqlite3changeset_concat()`, `sqlite3_changegroup`).

**Requirements and limits:**
- "The session extension only works with tables that have a declared PRIMARY KEY." Attaching a
  table without one is not an error, but "no changes will be recorded".
- "No changes affecting rows with one or more NULL values in PRIMARY KEY columns are recorded."
- "There is no support for virtual tables."
- WITHOUT ROWID tables: supported since 3.17.0 (sessionintro.html).
- `zTab = NULL` attaches every table, including ones created later (sqlite3session_attach.html).
- **Schema changes:** no page fetched says DDL is recorded; the pages describe row changes only.
  Applying needs a "compatible" target table — same name, "at least as many columns as recorded
  in the changeset", primary-key columns in the same positions. "If there is no compatible table,
  it is not an error, but none of the changes associated with the table are applied" (a warning
  goes to `sqlite3_log`). `sqlite3changegroup_schema()` pads changesets that have fewer columns
  than the table with the schema's defaults — i.e. ADD COLUMN on one side can still combine.
- **BLOBs / size limits:** not stated on sessionintro.html or sqlite3session_changeset.html.

**Conflicts when applying** (`sqlite3changeset_apply`, c_changeset_conflict.html,
c_changeset_abort.html). The handler receives one of:
- `SQLITE_CHANGESET_DATA` — DELETE/UPDATE: row with that PK exists but its non-key values don't
  match the recorded "before" values.
- `SQLITE_CHANGESET_NOTFOUND` — DELETE/UPDATE: no row with that PK.
- `SQLITE_CHANGESET_CONFLICT` — INSERT: PK already exists.
- `SQLITE_CHANGESET_CONSTRAINT` — another constraint (UNIQUE, CHECK, NOT NULL) fails.
- `SQLITE_CHANGESET_FOREIGN_KEY` — invoked "exactly once" before commit if FK violations remain.

It returns `OMIT` ("The change that caused the conflict is not applied"), `REPLACE` (only for
DATA or CONFLICT — overwrite / delete-and-retry) or `ABORT` (everything rolled back, returns
`SQLITE_ABORT`). The whole apply runs inside a savepoint (`SQLITE_CHANGESETAPPLY_NOSAVEPOINT`
removes it). Other flags: `INVERT`, `IGNORENOOP` (skip the handler for no-op changes),
`FKNOACTION`. An `xFilter` callback can skip whole tables (per table; per change in `apply_v3`).
`sqlite3changeset_apply_v2()` can return a **rebase buffer**; the `sqlite3_rebaser` object then
rebases local changesets over the remote's conflict decisions — both are marked experimental
("subject to change without notice").

**What it gives us:** a per-row change log of the SQLite file for free (no triggers), in a
compact binary format, with a conflict callback where our rule (last-writer-wins, keep both,
ask) lives. It does **not** give: merge of a text value (a whole cell is replaced), a transport,
clocks/ordering, or DDL capture. Every synced table needs a non-NULL declared primary key
(JustWrite's position-keyed chat tables would merge badly, as the design file notes).

**Licence:** SQLite's own licence page was not fetched this session. **Sources:**
sqlite.org/sessionintro.html · sqlite.org/session/sqlite3changeset_apply.html ·
…/c_changeset_conflict.html · …/c_changeset_abort.html · …/c_changesetapply_fknoaction.html ·
…/sqlite3session_changeset.html · …/sqlite3session_attach.html ·
…/sqlite3changegroup_schema.html · …/rebaser.html

---

## 2 · Which of our SQLite engines expose sessions

### better-sqlite3 — **no sessions**
- npm latest **13.0.3** (2026-08-05), **MIT**. Repo WiseLibs/better-sqlite3, last push
  2026-08-10.
- `docs/api.md` Database methods: `prepare, transaction, pragma, explain, backup, serialize,
  function, aggregate, table, loadExtension, exec, close` — no session/changeset method.
- `docs/compilation.md` bundled config: SQLite 3.53.4; the option list has **no
  `SQLITE_ENABLE_SESSION` / `SQLITE_ENABLE_PREUPDATE_HOOK`**. Custom builds possible with
  `--build-from-source --sqlite3=<amalgamation dir>`.
- Issue #468 "Support for Session 'Extension'" — open since 2020-10-08; maintainer (2020): "There
  are no plans for this at this time, but I'll keep this ticket open to track interest/support."
  Last comment (2025-04-21) points to Node's `createSession`. A commenter (2025-04-08) compiled
  with the flags: they appear in `compile_options` but nothing in the JS API exposes them.
- *Measured:* 13.0.3 in Node 26.5.0 and Electron 44.7.0: `pragma_compile_options` has no
  SESSION/PREUPDATE entry; `db.createSession`/`db.applyChangeset` undefined.

### Node's built-in `node:sqlite` — **sessions yes**
- `database.createSession({table, db})`, `database.applyChangeset(changeset, {filter,
  onConflict})`, `Session.changeset()` / `.patchset()` (→ `Uint8Array`) / `.close()`: **added
  v23.3.0, v22.12.0**. `onConflict` gets DATA / NOTFOUND / CONFLICT / FOREIGN_KEY / CONSTRAINT and
  returns OMIT / REPLACE (DATA or CONFLICT only) / ABORT; default handler returns ABORT; a throw
  or other value aborts and rolls back. `sqlite.constants` (v23.5.0, v22.13.0) carries them.
- **Not on the page** (Node 24.21.0 and 26.11.1 docs): the rebase buffer, changeset iteration
  (`sqlite3changeset_start/next/op/old/new`), concat/invert/changegroup, `session.attach` of more
  tables after creation, `sqlite3session_diff`. To read *what* a changeset contains in JS we would
  parse the binary format ourselves or apply it to a scratch database.
- Stability: **"Stability: 1.2 – Release candidate"** in Node **24.21.0** docs (history: "v24.15.0
  SQLite is now a release candidate") and in Node **26.11.1** docs ("v25.7.0"). Unflagged since
  v23.4.0 / v22.13.0 ("but still experimental" at that point).
- Other APIs on the v24 page: `function()` (v23.5.0/v22.13.0), `aggregate()` (v24.0.0),
  `sqlite.backup()` (v23.8.0), `loadExtension`/`enableLoadExtension` (v23.5.0/v22.13.0, needs
  `allowExtension`), `serialize`/`deserialize` (v24.16.0 on the v24 page; v26.1.0 on the v26
  page), `setAuthorizer`. better-sqlite3's virtual-table `table()` has no counterpart
  (*measured*: `db.table` undefined).
- Compile flags: `deps/sqlite/sqlite.gyp` in nodejs/node has `SQLITE_ENABLE_SESSION` and
  `SQLITE_ENABLE_PREUPDATE_HOOK` (also RBU, FTS5, RTREE…); bundled SQLite 3.53.4 (main and v24.x).
- *Measured:* in Electron 44.7.0 (Node 24.21.0, SQLite 3.53.4) and Node 26.5.0 (SQLite 3.53.3):
  compile options include `ENABLE_SESSION, ENABLE_PREUPDATE_HOOK`; a session on db A recorded two
  inserts (25-byte changeset); `applyChangeset` on db B hit one `SQLITE_CHANGESET_CONFLICT` (3),
  `REPLACE` resolved it, B ended equal to A. The register already records better-sqlite3 as ~2×
  faster than `node:sqlite` (kit RESEARCH §2).

### Official SQLite WASM — `@sqlite.org/sqlite-wasm` — **sessions yes**
- npm latest **3.53.4-build2** (2026-10-02); npm licence **Apache-2.0** (README "License: Apache
  2.0" — the wrapper package; GitHub reports no SPDX id). Repo sqlite/sqlite-wasm, last push
  2026-10-02.
- The C-style API doc (sqlite.org/wasm/doc/trunk/api-c-style.md) has a "Session and Changeset
  APIs" section (JS functions accepted for callbacks; `sqlite3changeset_new_js/old_js`
  helpers). It does not say which build includes it.
- *Measured:* the 3.53.4-build2 package's `sqlite3.wasm`/JS export `sqlite3session_*`,
  `sqlite3changeset_*` (incl. `apply_v2/v3`, `concat`, `invert`, iteration) and the rebaser;
  run in Node, `pragma_compile_options` lists `ENABLE_PREUPDATE_HOOK, ENABLE_SESSION`, and
  `sqlite3session_changeset` returned rc 0 with a 14-byte changeset for one insert.
- README: "Node.js is currently only supported for in-memory databases without persistence."
- **Persistence** (sqlite.org/wasm/doc/trunk/persistence.md):
  - `opfs` VFS: Worker only; needs `SharedArrayBuffer` → COOP `same-origin` + COEP
    `require-corp` headers; Chromium ~mid-2022+, Firefox 111+, Safari 16.4+ but "Safari below 17
    is incompatible" (WebKit sub-worker storage bug).
  - `opfs-sahpool` (since 3.43): Worker only, **no COOP/COEP needed**, "reported to work on all
    major browsers released since March 2023", fastest; no multi-connection (except same-thread;
    "versions before 3.54 have a locking bug that can corrupt data in that case"), stored file
    names differ from the client's, paths absolute; `importDb()` / `exportFile()`.
  - `opfs-wl` (since 3.53.0): like `opfs` with Web Locks; needs `Atomics.waitAsync()`.
  - `kvvfs`: whole db in localStorage/sessionStorage, ~5 MB.
  - Android WebView and WKWebView: **not mentioned** on the page.
- OPFS in webviews: MDN browser-compat-data (`api/FileSystemSyncAccessHandle.json`,
  `api/StorageManager.json`) marks `webview_android` and `webview_ios` as **"mirror"** — copied
  from Chrome Android 109 and Safari iOS (Safari 15.2), not separately recorded.
  caniwebview.com shows only "*" for both. No source found on OPFS under Capacitor's own scheme
  (`capacitor://localhost` on iOS); sqlite/sqlite-wasm issues have no hits for WKWebView,
  webview or capacitor.

### `@capacitor-community/sqlite` — **no sessions; has its own JSON "sync"**
- npm latest **8.1.1** (2026-08-06), **MIT**; peer `@capacitor/core >=8.0.0`. Repo last push
  2026-08-06, releases 8.0.0 (2026-01-23) → 8.1.1; maintainer Robin Genz (Capawesome); 38 open
  issues.
- Platforms: Android, iOS, Electron, Web. Web = `jeep-sqlite` (Stencil component on **sql.js**,
  stored in **IndexedDB**; jeep-sqlite latest 2.8.0, last published 2024-08-16). Native uses
  SQLCipher "(even for unencrypted databases)"; Electron uses `better-sqlite3-multiple-ciphers`
  and the README says `@capacitor-community/electron` v5 users "have to stick to
  Electron@25.8.4 till further notice".
- No mention of the session extension or changesets.
- Its "sync" (docs/ImportExportJson.md): `exportToJson` *full* or *partial* (partial = rows
  whose `last_modified` is after the sync date; needs `last_modified` on every table, kept by an
  auto-created trigger), deletes as `sql_deleted = 1` soft-deletes, `createSyncTable` /
  `setSyncDate` / `getSyncDate`, `deleteExportedRows` after a sync; `importFromJson` upserts by
  the first column (must be the PK). **No conflict detection or resolution is described.**

---

## 3 · cr-sqlite (vlcn-io/cr-sqlite)

- **What it is:** a loadable SQLite extension; `crsql_as_crr('t')` turns a table into a CRR;
  changes are read from and applied by inserting into the `crsql_changes` virtual table, filtered
  by `db_version` / `site_id`; `crsql_finalize()` before close; loaded first on every connection.
- **Merge:** rows matched by primary key; per-column CRDTs — last-write-wins, fractional index,
  observe-remove sets available; deletes via a causal-length set; "Counter and rich-text CRDTs
  are still being implemented" (Peritext listed as notional). No text merge inside a cell.
- **Schema change:** wrap ALTER in `crsql_begin_alter('t')` … `crsql_commit_alter('t')` (the
  README also names it `crsql_alter_commit` — inconsistent). Inserts into CRRs ~2.5× slower.
- **Networking:** none — "the app must supply its own transport" (README: networking code uses
  `crsql_changes`).
- **Loading:** `load_extension(path, 'sqlite3_crsqlite_init')` from any binding; better-sqlite3
  has `loadExtension()` (api.md) — cr-sqlite's README does not name better-sqlite3. v0.16.3
  release assets: android aarch64, darwin x64/arm64, iOS xcframework, linux x64/arm64, win
  i686/x64. WASM lives in the separate vlcn-io/js repo (`@vlcn.io/crsqlite-wasm` 0.16.0,
  2023-12-16, on its own `@vlcn.io/wa-sqlite` 0.22.0 — not the official WASM build; vlcn-io/js
  last push 2024-01-17).
- **Licence:** repo LICENSE **MIT** ("Copyright (c) 2023 One Law LLC"); npm `@vlcn.io/crsqlite`
  says "Apache 2"; `@vlcn.io/crsqlite-wasm` has no licence field.
- **Version:** last release **v0.16.3, 2024-01-17** (npm 0.16.3 same day). README: "main may not
  be 100% stable", build against a release tag.
- **Maintenance:** commits since then: a handful in 2024 (last 2024-10-25), then five build
  commits 2026-08-04/10 by contributors (android ABIs, Windows arm64, iOS simulator, 16 KB
  page alignment); no new release. Issue #444 "Is this project dead?" (open): the author
  (tantaman, 2024-12-30): "I'm full time on https://zero.rocicorp.dev/ these days … I don't see
  that happening for at least 1-2 years". Fly.io (2025-08-16) still uses it via its own fork
  (superfly/cr-sqlite).
- **Gives us:** row/column CRDT merge on plain SQLite tables with no server; we'd write
  transport and the WASM/phone loading; text cells still LWW.
- **Sources:** github.com/vlcn-io/cr-sqlite (README, LICENSE, releases, commits, issue #444) ·
  github.com/vlcn-io/js · npm.

---

## 4 · Yjs + TipTap collaboration

**Yjs** — npm latest **13.6.33** (2026-09-23), **MIT** (LICENSE file; GitHub API reports
NOASSERTION). v14 is in release candidates on GitHub (v14.0.0-rc.28, 2026-09-29); npm `beta` tag
is 14.0.0-16 (2025-12-07). Repo last push 2026-10-07.
- docs.yjs.dev/api/document-updates: "Document updates are *commutative, associative,* and
  *idempotent*" — apply "in any order and multiple times"; "All clients will sync up when they
  received all document updates." API: `encodeStateAsUpdate`, `applyUpdate`,
  `encodeStateVector`, `mergeUpdates` ("removing duplicate information"), `diffUpdate`,
  `encodeStateVectorFromUpdate`. Updates from the `update` event can be stored "in a database";
  merging updates doesn't drop deleted content — "You still need to load the document to a Y.Doc
  to reduce the document size."
- README: offline editing supported; changes "merged without merge conflicts". Persistence
  providers listed: y-indexeddb, y-op-sqlite (React Native/op-sqlite), y-postgresql,
  y-mongodb-provider, y-fire; servers: y-websocket, y-webrtc, Hocuspocus ("SQLite persistence"),
  y-sweet, y-redis…
- **Storing a Y.Doc in SQLite:** a `Uint8Array` state/update blob per document (Hocuspocus's
  Database extension: `fetch` "returns a Y.js compatible Uint8Array (or null)", `store`
  "persists the Y.js binary data"; its SQLite extension keeps a `documents(name varchar(255)
  unique, data blob)` table). Don't build a fresh Y.Doc from HTML each load — "would lead to a
  new history (and duplicated content)".

**`@tiptap/extension-collaboration`** — npm latest **3.31.4** (2026-09-30), **MIT** (package.json
in the ueberdosis/tiptap repo, repo MIT). Peers: `yjs ^13`, `@tiptap/y-tiptap ^3.0.7` (3.0.9,
2026-08-18, MIT — "ProseMirror Tiptap binding for Yjs"), `@tiptap/core`/`pm` 3.31.4. Install per
docs: `@tiptap/extension-collaboration @tiptap/y-tiptap yjs y-websocket`. The extension brings
its own history — "Make sure to disable the `UndoRedo` extension." (Caret extension:
`@tiptap/extension-collaboration-caret` 3.31.4, MIT.)
- **Is TipTap Cloud required?** Not by any page read. tiptap.dev/pricing: "The Tiptap Editor is
  open source (MIT) and free"; paid plans (Start $59/mo … Enterprise) are for *Tiptap
  Collaboration* cloud docs, version-history compare, on-prem, AI Toolkit, Tracked Changes.
  TipTap's offline guide (tiptap.dev/docs/guides/offline-support) uses open-source y-indexeddb and
  names no paid plan.

**Hocuspocus** — `@hocuspocus/server` / `provider` / `extension-sqlite` / `extension-database` /
`transformer` all **4.7.0** (2026-09-09), **MIT** (npm + GitHub); repo last push 2026-10-07.
Self-hostable WebSocket server (Node, Bun, Deno, Cloudflare Workers per its overview); server
`engines.node >=22`. Docs: "It's totally fine to change a document while being offline and merge
it with other changes when the device is online again." `@hocuspocus/extension-sqlite` depends on
**better-sqlite3 ^12.6.2** (we run 13.0.3); its page frames it for "local development".
`@hocuspocus/transformer` gives `TiptapTransformer.toYdoc(json, field, extensions)` /
`fromYdoc(doc)` (Y.Doc ↔ TipTap JSON on the server); the hooks page says to use `toYdoc` "to
migrate data only, not as a permanent way to store your data".

**y-indexeddb** — npm latest **9.0.12** (2023-11-02), MIT; last commit 2025-02-12 (typo fix).

**What it gives us:** chapter prose as a Yjs document that two offline devices can edit and
merge automatically (CRDT; order-free, idempotent updates) — stored as BLOBs in our own SQLite,
moved by any transport. Our reading, not a page's: the HTML column would become derived from
the Y.Doc (or vice versa via the transformer); live multi-user (Hocuspocus) is optional.

**Sources:** github.com/yjs/yjs · docs.yjs.dev/api/document-updates ·
tiptap.dev/docs/editor/extensions/functionality/collaboration · tiptap.dev/pricing ·
tiptap.dev/docs/guides/offline-support · tiptap.dev/docs/hocuspocus/getting-started/overview ·
…/hocuspocus/guides/collaborative-editing · …/hocuspocus/server/extensions/sqlite ·
…/hocuspocus/server/extensions/database · github.com/ueberdosis/{tiptap,hocuspocus,y-tiptap} · npm.

---

## 5 · Automerge

- **What it is:** a CRDT library for local-first apps; JS "works with Node.js, Electron, and
  modern browsers"; the core is Rust compiled to WebAssembly (the 3.5.0 package ships
  `dist/automerge.wasm`, a base64-inlined entry and a `./slim` entry; browsers need a bundler per
  its README); a C API for iOS etc. Network-agnostic.
- **Versions:** `@automerge/automerge` **3.5.0** (2026-09-16), MIT; repo last push 2026-10-08,
  releases monthly (3.4.0 07-31, 3.4.1 08-12, 3.5.0 09-16).
  `@automerge/automerge-repo`: npm `latest` tag points at **2.6.0-alpha.3** (2026-08-07); last
  plain release **2.5.6** (2026-05-18); `next` 2.6.0-alpha.5 (09-16); 3.0.0-experimental.1
  (10-05). MIT.
- **automerge-repo:** networking/storage library. Built-in storage adapters: IndexedDB and
  NodeFS ("There are two built in storage adapters"); custom adapters on "any key/value store
  which supports range queries" (no SQLite adapter named). Websocket network adapter same
  versions as repo.
- **Sync server:** `@automerge/automerge-repo-sync-server` **0.3.0** (2026-09-30; previous
  0.2.8 was 2024-07-03), MIT — "very simple", "unsecured Express app", stores to `DATA_DIR`; no
  auth.
- **Rich text:** text + **marks** (name, value, `expand`) + **block markers**; `mark`, `marks`,
  `splitBlock`, `updateBlock`, `block`, `spans`, `updateSpans` (which "does not yet update
  formatting spans"). ProseMirror binding `@automerge/prosemirror` **0.2.0** (2026-02-25),
  npm MIT (GitHub repo has no licence file per API); README: **"beta quality software"**, API
  "will probably change"; needs a schema that is "a very specific subset of the ProseMirror
  schema" mapped via a `SchemaAdapter`. TipTap is not mentioned.
- **Gives us:** whole-book (or per-chapter) documents that merge offline, with rich text — but
  the data would live in Automerge documents, not our SQLite tables, and the TipTap path is an
  unproven beta binding.
- **Sources:** automerge.org/docs/hello/ · automerge.org/docs/reference/documents/rich-text/ ·
  automerge.org/docs/reference/repositories/storage/ · github.com/automerge/{automerge,
  automerge-repo, automerge-prosemirror, automerge-repo-sync-server} · npm.

---

## 6 · Hybrid logical clock libraries on npm

No widely used, maintained HLC package found (`npm search "hybrid logical clock"`, npm
downloads API, last week):
- `@tpp/hybrid-logical-clock` 1.0.0 (2020-04-02), ISC — 44 downloads/week.
- `@consento/hlc` 2.1.0 (2021-02-04), MIT — 15/week.
- `liepoch` 1.0.3 (2026-06-21), MIT — 8/week.
- `@sovereignbase/hybrid-logical-clock` 1.0.0 (2026-06-13), Apache-2.0 — 4/week.
- `@valkyr/time` 0.19.3 (2023-04-15), MIT — 3/week; `@bobbyfidz/hlc` 0.2.1 (2025-08-14), no
  licence field — 3/week.
None qualifies as "well-maintained industry standard".

---

## 7 · Litestream and LiteFS

**Litestream** (benbjohnson/litestream, **Apache-2.0**, latest **v0.5.17, 2026-08-31**, releases
roughly monthly, last push 2026-10-08; site: "actively maintained"). A separate process that
"continuously copies write-ahead log pages from disk to a replica" (S3, GCS, Azure Blob, SFTP,
file, NATS JetStream, WebDAV, S3-compatibles); it takes over checkpointing; restore to a TXID or
timestamp at LTX-file granularity; optional `litestream-vfs` serves read queries straight from
replica storage. "Each database replicates to a single replica destination." It is one-way
backup/replication of one writer's database — **no merge**; fits "back up the cloud server's
database", not device ↔ device sync. Sources: litestream.io, litestream.io/how-it-works/, GitHub.

**LiteFS** (superfly/litefs, **Apache-2.0**, latest **v0.5.14, 2025-04-22**, last push
2026-05-11). A FUSE file system that replicates SQLite across a cluster: "SQLite operates as a
single-writer database", one primary takes writes (primary chosen through a Consul lease),
other nodes hold full copies. README: "actively maintained but is currently in a beta state";
Fly docs: "We are not able to provide support or guidance for this product. Use with caution",
"pre-1.0 so APIs may change". Needs FUSE (Linux containers in its examples) — not usable on
phones or Windows desktops. **Out** for device sync. Sources: github.com/superfly/litefs,
docs.fly.io/litefs, docs.fly.io/litefs/how-it-works.

---

## 8 · libSQL server (sqld) self-hosting

- **libSQL** (tursodatabase/libsql, **MIT**): "open source, open contribution fork of SQLite";
  README: "actively maintained, but new features are being developed in Turso", recommended for
  new projects (tursodatabase/turso — "A SQL database in Rust: SQLite-compatible…", MIT, v0.8.2
  2026-10-06).
  Last libsql-server release **v0.24.32, 2025-02-14**; commits continue (last 2026-08-23).
- **Self-hosting sqld: yes.** docs/USER_GUIDE.md: "`sqld` provides libsql over HTTP and supports
  transparent replication"; a *primary* "responsible for accepting writes", replicas "delegate
  the write to a primary node", poll it over gRPC+TLS. Docker image
  `ghcr.io/tursodatabase/libsql-server` (`SQLD_NODE=primary|replica`). Also "incremental
  snapshots" for not-always-connected replicas (`--snapshot-exec`, applied with the Rust crate's
  `Database::sync_frames()`).
- **Embedded replicas** (docs.turso.tech/features/embedded-replicas/introduction): reads from a
  local file; "Writes are sent to the remote primary database" and "are NOT written to the local
  file first", unless `offline: true`; `sync()` / `syncInterval`; "fully supported in
  production"; for new projects needing sync Turso recommends **Turso Sync**. The page describes
  only Turso Cloud — **pointing an embedded replica at a self-hosted sqld is not stated** there,
  in the libsql README, or in libsql-client-ts's README (its quickstart syncs "from Turso").
- npm: `@libsql/client` 0.18.0 (2026-09-02), `libsql` 0.5.29 (2026-03-25), both MIT.
- **Single writer:** libSQL "keeps SQLite's single-writer limit" — the server is the one
  primary; no multi-master merge.

**Incidental (outside the brief, Turso Sync, two pages only):** docs.turso.tech/sync/usage —
`push()` sends local changes "as logical statements", `pull()` applies remote ones; offline
writes stay in the local file until pushed; conflicts **"last push wins"**; SDKs named:
TypeScript `@tursodatabase/sync` (0.8.2, 2026-10-06, MIT), Python, Go — browser/WASM, React
Native, mobile not mentioned. docs.turso.tech/sync/local-sync-server: `tursodb ./server.db
--sync-server 0.0.0.0:8080`, "No auth token is needed", "implements the same sync protocol as
Turso Cloud", framed for "develop and test"; production self-hosting not stated.

---

## Could not verify

1. OPFS (and so `opfs-sahpool`) inside **Android WebView / iOS WKWebView under Capacitor** —
   only MDN's "mirror" entries; nothing from WebKit, Chromium, Capacitor or sqlite.org. Needs a
   device test.
2. Whether a session **records anything for DDL**, and how a session behaves when a table is
   ALTERed while attached — not stated on the pages read.
3. BLOB handling / size limits in changesets — not stated.
4. Whether an **embedded replica (or `@tursodatabase/sync`) works against a self-hosted
   server** in production — not stated; the tursodb sync server is documented for dev/test.
5. Whether `node:sqlite`'s session support is identical inside Electron's **main process /
   utilityProcess** (measured only under `ELECTRON_RUN_AS_NODE`).
6. IndexedDB durability/eviction for y-indexeddb or jeep-sqlite inside WKWebView — not checked.
7. Automerge's maturity statement (automerge.org pages read make none) and the
   `@automerge/prosemirror` licence file (npm says MIT; GitHub API shows none).
8. SQLite's own licence page was not fetched this session.
