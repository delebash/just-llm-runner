<!-- SPDX-License-Identifier: MIT -->
# Sync research, round 2 — SQLite sync and local-first tools

All facts below were **checked 2026-10-08** against the source named beside them (GitHub REST API,
npm registry, READMEs, official docs). Where a source does not state something, the record says
**not found**. Anything marked *inferred* is my reading of a stated fact, not a stated fact.

Rules applied (from the brief and the 2026-10-08 rule change): only open-source tools, or one we
build. Nothing paid or proprietary, no paid tiers, no copyleft (GPL, LGPL, AGPL), no Elastic / BSL.
FSL is allowed. Such candidates are dropped with one line each (§3).

Our requirements in short: our own SQLite tables (JustWrite: 35 tables, most keyed
`(project_id, id)`), Node 24 + better-sqlite3 on desktop, SQLite-in-WASM inside a Capacitor webview
on the phone, three transports (file carried by hand, a shared cloud folder with one change file per
device, our own self-hosted server), Yjs for chapter rich text.

The tools already checked in round 1 (see `just-llm-runner/docs/dev/RESEARCH.md` "Sync") were not
re-researched. One new fact about one of them is in §2.0.

Layout: §0 summary table · §1 the eight named tools · §2 the sweep · §3 dropped (closed, paid,
copyleft) · §4 the closer-look picks · §5 not found / open · §6 reference apps (how open-source
local-first apps sync phone and desktop — added at the coordinator's request).

---

## 0 · Summary table

"Our tables?" = does it sync the app's own, existing SQLite tables. "Own transport" = can changes
go through a file, a folder, or our own HTTP server.

| name | our tables? | Node | webview / Capacitor | file / folder / own transport | licence | latest release | verdict |
|---|---|---|---|---|---|---|---|
| **TinyBase** | No — its own in-memory store; a MergeableStore is saved to SQLite only as one JSON blob | Yes — better-sqlite3 and node:sqlite persisters | WASM SQLite persister; `CapacitorSqlitePersister` (tests use a mock) | Own WebSocket server (Node), BroadcastChannel, or a custom synchronizer (any transport); file: not documented | MIT | v10.0.0, 2026-09-24 (npm 10.0.1) | Partial: right platforms and transports, but it replaces our data layer |
| **LiveStore** | No — its own event log; SQLite is a view built from events; "doesn't yet provide a way to re-use an existing database" | Node adapter (SQLite build not stated) | Web adapter on wa-sqlite + OPFS; no Capacitor adapter | Central sync backend that orders events (own server possible: custom provider or celld); file/folder: not found | Apache-2.0 | 0.4.0, 2026-06-02 (beta) | No |
| **Graft** | Yes at page level (any SQLite file), but no merge | Yes — `sqlite-graft` (node:sqlite ≥ 23.10, or better-sqlite3) | Not stated; npm ships desktop binaries only | Remote = local filesystem, S3-compatible, or memory | MIT OR Apache-2.0 | v0.2.1, 2025-12-04 (alpha) | No — a second writer's push is rejected; merge "not yet implemented" |
| **Loro** | No — CRDT documents | Yes (WASM npm package) | WASM in JS; Capacitor not named | Bytes export/import — any transport incl. files | MIT | loro-crdt 1.16.4, 2026-09-30 | Only as a Yjs alternative for chapter text |
| **SQLSync** | No — tables are created by a Rust reducer it runs | Not stated | Browser (shared worker), React only | Its own coordinator ("COMING SOON" in the guide) | Apache-2.0 | npm 0.3.2, 2024-03-11; no GitHub releases | No — prototype, not for production, idle |
| **Marmot** | Yes, but on server nodes | No (Go server, MySQL wire protocol) | No | gRPC between cluster nodes | MIT | v2.10.0-beta, 2026-09-30 | No — server cluster; minority side cannot write |
| **Corrosion** | Yes (cr-sqlite CRRs), on server nodes | No (Rust agent + HTTP API) | No | QUIC gossip between cluster agents | Apache-2.0 | v1.0.0, 2026-05-14 | No — Fly.io service-discovery cluster |
| **WatermelonDB** | No — its own models; records carry `_status`/`_changed` | Yes — SQLite via better-sqlite3 | Web adapter is LokiJS (IndexedDB), not SQLite; Capacitor not mentioned | `pullChanges`/`pushChanges` are our functions (any transport), but the protocol needs a server clock | MIT | 0.28.0, 2025-04-07 | No; its pull/push protocol is a useful pattern |
| **Syncular** | Partly — ordinary SQLite tables, but defined through its manifest + migrations; existing DBs not imported | Server on node:sqlite; client "Bun, Node" per npm | Browser on SQLite WASM + OPFS (`opfs-sahpool`); Capacitor not named | Its own server (self-hosted: Node/Bun/Workers); file/folder: not found | Apache-2.0 | v0.31.0, 2026-10-07 (pre-1.0) | Closest to the "own server" path, incl. Yjs columns; no file/folder path |
| **Syzy** | Yes — plain SQLite file + extension | No JS binding (Go API or loadable extension + daemon) | No — Linux and macOS only | TCP peer mesh + object storage | Apache-2.0 | GitHub releases are build artefacts only (2026-08-03) | No — no Windows, no phone |
| **Loomabase** | Yes on the Rust client (SQLite triggers); JS SDK stores JSON files | JS SDK (JSON-file storage), not on npm | Browser `localStorage` prototype | Server is PostgreSQL | Apache-2.0 | no releases; last commit 2026-06-28 (alpha) | No — needs Postgres; a design reference |
| **AMPLI-SYNC** | Yes (declared tables) | No (Java 17 WAR on Tomcat) | Client not in repo | HTTPS + JWT to its server; server is PostgreSQL | MIT | no releases; last commit 2026-08-14 | No — Java + Postgres |
| **backless-core** | Yes — declared tables made into cr-sqlite CRRs | Not stated (browser, Vite-only WASM import) | Browser (cr-sqlite WASM); Capacitor not named | **Per-device changeset folders in Google Drive / OneDrive** | MIT (LICENSE file; no `license` field; GitHub repo 404) | 0.10.3, 2026-09-24 | Not usable (cr-sqlite WASM 2023, repo gone) — but the closest published design for our folder path |
| **Quereus + @quereus/sync** | No — its own pure-TypeScript SQL engine, not SQLite | Yes (pure JS) | Yes (pure JS); Capacitor not named | `getChangesSince` / `applyChanges` — any transport | MIT | v4.20.2, 2026-10-06 | No (not SQLite); API shape is a reference |
| **SQLiteChangesetSync** | Yes — session-extension changesets | No (Swift) | No (iOS) | Git-like push/fetch to any backend (demo: CloudKit) | MIT | none; last commit 2023-12-15 | No (Swift, idle); reference for a session-based design |
| **sql_crdt / sqlite_crdt** | Yes — adds `is_deleted`, `hlc`, `modified` to every table | No (Dart) | No (Flutter) | `getChangeset` / `merge` — any transport | Apache-2.0 | sql_crdt 3.0.3, 2025-05-03 | No (Dart); reference for the HLC-column design |
| other sweep finds | see §2.x one-liners | | | | | | |

**Candidates worth a closer look** (reasons in §4):
1. **Syncular** — the only maintained, permissive engine that keeps an ordinary local SQLite per
   client, runs its server on Node, and merges Yjs columns on the server. Weak on file/folder.
2. **backless-core** (as a design, not a dependency) — per-device changeset folders on Google Drive
   / OneDrive with snapshots and compaction: our folder transport, already worked out.
3. **TinyBase** — permissive, active, has a better-sqlite3 persister, a Capacitor persister and a
   pluggable transport; the cost is that TinyBase becomes the data layer.

---

## 1 · The eight named tools

### 1.1 TinyBase

- **What it is:** "A reactive data store & sync engine" (GitHub description). An in-memory store of
  tables/rows/cells with persisters and synchronizers. [a]
- **Data model:** its own store. A `MergeableStore` "records additional metadata as the data is
  changed so that potential conflicts can be reconciled". [c] SQLite persisters have two modes: JSON
  (whole store in one row of a `tinybase` table) and tabular (maps store tables to database tables,
  needs a row-id column that is a primary or unique key). [b] **A MergeableStore can be persisted to
  SQLite "only in the 'JSON-serialization' mode"**; the metadata "cannot be easily stored in a plain
  SQLite database". [c] The release notes mention MergeableStore with SQLite, Capacitor, MS SQL and
  PostgreSQL only in JSON mode. [e] So it **does not sync our own tables**; at most a plain
  (non-mergeable) Store can be bound to existing tables, with caveats: TinyBase may remove empty
  columns, sparse tables become dense, data that does not round-trip is lost, not advised for large
  tables because TinyBase is in-memory. [b]
- **Where it runs:** persisters `BetterSqlite3Persister` (better-sqlite3), `SqliteNodePersister`
  (node:sqlite), `SqliteWasmPersister` (sqlite-wasm in a browser), `CapacitorSqlitePersister`
  ("SQLite in Capacitor, via capacitor-sqlite"), Expo, React Native, LibSQL, PowerSync. [b] The
  Capacitor persister (v9.6) "tests run against a mocked plugin". [e] better-sqlite3 and node:sqlite
  persisters poll for changes. [e] v10.0 removed the cr-sqlite, `sqlite3` and ElectricSQL persisters. [e]
- **Transport:** `WsSynchronizer` (WebSockets), `BroadcastChannelSynchronizer`, `LocalSynchronizer`,
  or a custom one. [d] `createCustomSynchronizer(store, send, registerReceive, destroy,
  requestTimeoutSeconds, …)` — we supply `send` and wire incoming messages to `receive`, so any
  transport works. [f] A `WsServer` is created with the `ws` package; a second argument persists
  server data (example: a file persister). [d] MergeableStore has `getMergeableContent`,
  `setMergeableContent`, `applyMergeableChanges`, `merge`. [g] Exporting to a file and merging an
  import: methods exist; the docs do not describe it — **file exchange not documented**.
- **Merge rule:** "each update gets a timestamp, based on a hybrid logical clock (HLC), and a hash";
  "'last write wins' (LWW)". Metadata exists at cell, row, table and store level. Delete
  representation: not found. [c]
- **Licence:** MIT (GitHub API, npm). Commercial terms: not found. [a][h]
- **Release / maintenance:** v10.0.0 published 2026-09-24 (GitHub); npm `latest` 10.0.1
  (2026-09-24), `beta` 10.1.0-beta.0; last commit 2026-09-23; pushed 2026-10-08; 5,189 stars; not
  archived. [a][h]
- **Verdict:** partial — the transports and platforms fit, but it would replace our SQLite tables
  with TinyBase's in-memory store saved as a JSON blob.

Sources (checked 2026-10-08): [a] https://api.github.com/repos/tinyplex/tinybase (+ `/releases`,
`/commits`) · [b] https://tinybase.org/guides/persistence/database-persistence/ ·
[c] https://tinybase.org/guides/synchronization/using-a-mergeablestore/ ·
[d] https://tinybase.org/guides/synchronization/using-a-synchronizer/ ·
[e] https://tinybase.org/guides/releases/ ·
[f] https://tinybase.org/api/synchronizers/functions/creation/createcustomsynchronizer/ ·
[g] https://tinybase.org/api/mergeable-store/interfaces/mergeable/mergeablestore/ ·
[h] https://registry.npmjs.org/tinybase

### 1.2 LiveStore

- **What it is:** "a next-generation state management framework based on reactive SQLite and built-in
  sync engine" (GitHub description). [a]
- **Data model:** event-sourced. It syncs events, not the database; clients "materialize" events into
  SQLite. [b] Not our tables: "LiveStore doesn't yet provide a way to re-use an existing database";
  "All the client app data should fit into a in-memory SQLite database" (up to 1 GB "should be
  okay"). [c] Rich text: "LiveStore doesn't yet have built-in rich text primitives" — use Yjs,
  Automerge or Loro beside it. [h]
- **Where it runs:** adapters for web, Expo, Node, Electron, Tauri, Cloudflare Durable Objects; no
  Capacitor adapter in the docs index. [d] GitHub code search for "capacitor" in the repo: 0 hits. [i]
  Web adapter: installs `@livestore/wa-sqlite`, OPFS is the only storage, needs OPFS,
  `navigator.locks`, WASM; Android Chrome runs single-tab; Android WebView / WKWebView not covered. [e]
  Node adapter: "Works with Node.js, Bun and Deno"; which SQLite it uses: not found. [f] npm packages
  peer-depend on Effect. [g]
- **Transport:** "via a central sync backend", which is "the global authority" setting event order;
  clients pull before they push and rebase unpushed events (git-like). [b] A custom sync provider
  implements `pull(cursor)` and `push(batch)`; the server must process pushes one at a time to keep
  a total order. [j] Providers: Cloudflare Workers, ElectricSQL, S2, custom. [d] Self-hosting the
  Cloudflare backend with **celld** (denoland/celld, Apache-2.0, v0.6.2 2026-10-07, "self-hosted,
  distributed Durable Objects", needs an S3/GCS/Azure bucket) was documented on `main` on 2026-10-02;
  it is not on the published docs page yet. [k][l][m] File or folder exchange, peer-to-peer: not found.
- **Merge rule:** total order set by the backend; client events rebased on top. The "Merge conflicts"
  section text: not retrieved (not found). [b]
- **Licence:** Apache-2.0 (GitHub, npm). Commercial terms: not found. [a][g]
- **Release / maintenance:** npm `latest` 0.4.0 (2026-06-02), `dev` 0.5.0-dev.0 (2026-08-24); GitHub
  v0.4.0 2026-06-02; last commit 2026-10-05; "currently in **beta**"; "no specific timeline for a 1.0
  release"; minor releases may break APIs and storage formats. [a][g][n]
- **Verdict:** no — own event log instead of our tables, a central ordering backend, no Capacitor,
  no file/folder path.

Sources (checked 2026-10-08): [a] https://api.github.com/repos/livestorejs/livestore ·
[b] https://docs.livestore.dev/building-with-livestore/syncing/ ·
[c] https://docs.livestore.dev/overview/when-livestore/ · [d] https://docs.livestore.dev/llms.txt ·
[e] https://docs.livestore.dev/platform-adapters/web-adapter/ ·
[f] https://docs.livestore.dev/platform-adapters/node-adapter/ ·
[g] https://registry.npmjs.org/@livestore/livestore (+ `adapter-web`, `adapter-node`, `sync-cf`) ·
[h] https://docs.livestore.dev/patterns/rich-text-editing/ ·
[i] https://api.github.com/search/code?q=capacitor+repo:livestorejs/livestore ·
[j] https://docs.livestore.dev/sync-providers/custom/ ·
[k] https://github.com/livestorejs/livestore/blob/main/docs/src/content/docs/sync-providers/cloudflare.mdx (commit 858cb258, 2026-10-02) ·
[l] https://docs.livestore.dev/sync-providers/cloudflare/ (no celld section) ·
[m] https://api.github.com/repos/denoland/celld · [n] https://docs.livestore.dev/misc/state-of-the-project/

### 1.3 Graft (orbitinghail)

- **What it is:** "an open-source transactional storage engine designed for efficient data
  synchronization at the edge … lazy, partial replication with strong consistency". Used through a
  SQLite extension (`libgraft_ext`, a VFS + pragmas) or as a Rust crate. [a][c]
- **Data model:** pages, schema-agnostic — any SQLite file. No row-level or semantic merge; changes
  tracked per page. [a][c]
- **Where it runs:** npm `sqlite-graft` 0.2.1 (2025-12-04); the docs' example uses `node:sqlite`
  (Node ≥ 23.10.0) and say other libraries "should work", naming better-sqlite3. [b][f] The npm
  package's optional binaries: linux-x64, linux-arm64, darwin-arm64, windows-x64, windows-arm64 —
  no Android, iOS or WASM. [f] Browser/WASM: not mentioned. [b] **WAL is not supported**; the same
  database cannot be opened from several processes. [d]
- **Transport:** remote storage `fs` (a local directory, "Good for development and single-machine
  deployments"), `s3_compatible` ("Recommended for production"), or `memory`. [e] Whether the `fs`
  remote is safe on a cloud-sync folder: not found.
- **Merge rule:** optimistic concurrency. "If two clients commit from the same snapshot, one commit
  will succeed and the other will fail." The loser must fork into a new volume, or reset to the
  server snapshot and replay (replay can fail). **Merge is "Not yet implemented by Graft."** [g]
  "divergence requires manual intervention". [c]
- **Licence:** MIT OR Apache-2.0 (README; GitHub API reports Apache-2.0; npm "MIT OR Apache"). The
  FAQ plans "hosted services and support plans"; the core "is and will remain free and open". [a][f][h]
- **Release / maintenance:** v0.2.1 2025-12-04; last commit on `main` 2026-06-17; repo pushed
  2026-10-05 (another branch); README: "should be considered **Alpha** quality software … contact
  @carlsverre before using it in production". [a]
- **Verdict:** no — built for one writer at a time; offline edits on two devices cannot be merged.

Sources (checked 2026-10-08): [a] https://api.github.com/repos/orbitinghail/graft (+ README) ·
[b] https://graft.rs/docs/sqlite/usage/javascript/ · [c] https://graft.rs/docs/internals/ ·
[d] https://graft.rs/docs/sqlite/compatibility/ · [e] https://graft.rs/docs/sqlite/config/ ·
[f] https://registry.npmjs.org/sqlite-graft · [g] https://graft.rs/docs/concepts/consistency/ ·
[h] https://graft.rs/docs/about/faq/ — note: npm `graft` (2014) and npm `sqlsync` (2016) are
unrelated packages.

### 1.4 Loro

- **What it is:** "a CRDTs … library that makes building local-first and collaborative apps easier.
  You can now use it in Rust, JS (via WASM), and Swift." [a]
- **Data model:** its own CRDT documents (text via Fugue, rich text, movable tree, movable list,
  LWW map), not SQLite. [a]
- **Where it runs:** JS via WASM (`loro-crdt`), Rust, Swift; other bindings in `loro-ffi`. [a] A
  separate `loro.js` line was released (0.3.0, 2026-09-30) whose notes describe matching Rust's
  behaviour. [b] Capacitor: not named.
- **Transport:** `doc.export({ mode: "update", from: version })` returns bytes; `doc.import(bytes)`
  merges — any transport, including files. [a]
- **Merge rule:** CRDT merge (Fugue text, rich-text CRDT, LWW map, movable tree). [a]
- **Rich text:** `loro-prosemirror` 0.4.4 (MIT, 2026-08-22) — ProseMirror binding with cursors and
  undo/redo. [c][d] A TipTap extension: not found.
- **Licence:** MIT (GitHub, npm). [a][c]
- **Release / maintenance:** `loro-crdt` 1.16.4 (2026-09-30); last commit 2026-09-30; 6,203 stars. [a][c]
- **Verdict:** not a table-sync tool; only relevant as an alternative to Yjs for chapter text (and
  Yjs is already the plan).

Sources (checked 2026-10-08): [a] https://api.github.com/repos/loro-dev/loro (+ README) ·
[b] https://api.github.com/repos/loro-dev/loro/releases · [c] https://registry.npmjs.org/loro-crdt ,
https://registry.npmjs.org/loro-prosemirror · [d] https://api.github.com/repos/loro-dev/loro-prosemirror

### 1.5 SQLSync (orbitinghail)

- **What it is:** "a collaborative offline-first wrapper around SQLite … to synchronize web
  application state between users, devices, and the edge". [a]
- **Data model:** all mutations go through a "Reducer" that "currently … has to be written in Rust"
  compiled to WASM; the reducer creates and writes the tables. [b]
- **Where it runs:** browser, in a shared web worker; "React is the only supported framework". [a][b]
  Node: not stated.
- **Transport:** its coordinator — guide step 4 "Connect to the coordinator (COMING SOON)" needs the
  project built from source. [b]
- **Merge rule:** mutations run optimistically on the client, then "in a globally consistent order
  on the server"; the client syncs by something "similar to a Git Rebase". [c]
- **Licence:** Apache-2.0. [a]
- **Release / maintenance:** no GitHub releases or tags; npm `@orbitinghail/sqlsync-worker` /
  `-react` 0.3.2 (2024-03-11); last commit 2025-11-19; guide: "do not use it in a production
  application". [a][b][d]
- **Verdict:** no.

Sources (checked 2026-10-08): [a] https://api.github.com/repos/orbitinghail/sqlsync (+ README) ·
[b] https://github.com/orbitinghail/sqlsync/blob/main/GUIDE.md ·
[c] https://sqlsync.dev/posts/stop-building-databases/ (Nov 2023) ·
[d] https://registry.npmjs.org/@orbitinghail/sqlsync-worker

### 1.6 Marmot (maxpert)

- **What it is:** "a leaderless, distributed SQLite replication system built on a gossip-based
  protocol with distributed transactions and eventual consistency", spoken to over the MySQL wire
  protocol. [a]
- **Data model:** SQL on each node's SQLite file; row-level CDC. [a]
- **Where it runs:** a server binary (`marmot-v2`) per node; Go (commit: "move to Go 1.27"). [a][b]
  No phone or browser client.
- **Transport:** gRPC between nodes. [a]
- **Merge rule:** writes need the configured consistency (ONE/QUORUM/ALL); in a partition the
  minority side's writes **fail**; on heal, anti-entropy log pull and per-row LWW on the commit HLC
  timestamp. [a]
- **Licence:** MIT. [a]
- **Release / maintenance:** v2.10.0-beta 2026-09-30 (all recent releases are `-beta`); last commit
  2026-09-30. [b]
- **Verdict:** no — a server cluster, not offline devices.

Sources (checked 2026-10-08): [a] https://github.com/maxpert/marmot (README) ·
[b] https://api.github.com/repos/maxpert/marmot (+ `/releases`, `/commits`)

### 1.7 Corrosion (superfly)

- **What it is:** "Gossip-based service discovery (and more) for large distributed systems", built
  to replace Consul's central database at Fly.io. [a]
- **Data model:** a SQLite database per node, CRDTs via cr-sqlite, file-based schemas. [a]
- **Where it runs:** an agent on every host; other programs use its HTTP API; Rust (`cargo build`). [a]
  Phone / browser: not addressed. [b]
- **Transport:** SWIM membership (Foca), QUIC peer-to-peer, gossip, periodic sync with a subset of
  nodes. [a]
- **Merge rule:** cr-sqlite CRDTs; eventual consistency. [a][b]
- **Licence:** Apache-2.0. [c]
- **Release / maintenance:** v1.0.0 2026-05-14; last commit 2026-10-08. [c]
- **Verdict:** no — a datacenter cluster tool.

Sources (checked 2026-10-08): [a] https://github.com/superfly/corrosion (README) ·
[b] https://superfly.github.io/corrosion/ · [c] https://api.github.com/repos/superfly/corrosion

### 1.8 WatermelonDB (Nozbe)

- **What it is:** "Reactive & asynchronous database for powerful React and React Native apps";
  "Multiplatform. iOS, Android, Windows, web, and Node.js". [a]
- **Data model:** its own models; sync records carry `_status` and `_changed` fields (the backend
  must ignore them). [d]
- **Where it runs:** `SQLiteAdapter` on React Native iOS/Android and Node.js; **the web uses
  `LokiJSAdapter`** (IndexedDB), not SQLite. [b] Node needs the better-sqlite3 peer dependency. [c]
  Electron and Capacitor: not mentioned. [b][c]
- **Transport:** `synchronize({ database, pullChanges, pushChanges })` — both are app-written async
  functions; the example uses `fetch`, any transport is allowed. [e] But the backend must keep a
  `last_modified` server timestamp per row and return a timestamp to use as the next
  `lastPulledAt`. [d]
- **Merge rule:** the server must abort a push containing a record modified after `lastPulledAt`;
  the client then pulls again. [d] Client-side `conflictResolver` option; default behaviour: not
  described on the page. [e]
- **Licence:** MIT. [f]
- **Release / maintenance:** npm `latest` 0.28.0 (2025-04-07), `next` 0.28.1-0 (2025-07-24); no
  GitHub releases; last commit on `master` 2025-08-11; repo pushed 2026-09-16 (another branch). [f][g]
- **Verdict:** no — own schema, web storage is not SQLite, no Capacitor; its pull/push protocol is a
  useful written spec for the "own server" path.

Sources (checked 2026-10-08): [a] https://github.com/Nozbe/WatermelonDB (README) ·
[b] https://watermelondb.dev/docs/Setup · [c] https://watermelondb.dev/docs/Installation ·
[d] https://watermelondb.dev/docs/Sync/Backend · [e] https://watermelondb.dev/docs/Sync/Frontend ·
[f] https://api.github.com/repos/Nozbe/WatermelonDB · [g] https://registry.npmjs.org/@nozbe/watermelondb

---

## 2 · The sweep — what else exists

Where the sweep looked (all checked 2026-10-08):
- localfirstweb.dev → now redirects to https://lofi.so/ (its directory lists ElectricSQL, PowerSync,
  Dexie.js, WatermelonDB, remoteStorage, RxDB).
- GitHub lists: alexanderop/awesome-local-first, schickling/awesome-local-first,
  alantriesagain/awesome-local-first, zhongkechen/awesome-local-first, arn4v/offline-first,
  planetopendata/awesome-sqlite, lichuang/awesome-sqlite, gdamdam/awesome-decentralized-web.
- GitHub repository search: "sqlite crdt", "sqlite sync offline-first", "sqlite replication
  multi-master", "local-first sync engine sqlite", "sqlite multi-writer replication".
- npm registry search: "sqlite crdt", "sqlite sync offline", "sqlite replication", "local-first
  sqlite sync", "sync engine sqlite", "hlc crdt sqlite", "capacitor sqlite sync", "sqlite changeset",
  "sqlite merge databases".
- Web search: "sqlite crdt sync library multi-writer offline open source 2026", "sqlite multi-master
  replication offline devices open source", "npm sqlite crdt hybrid logical clock sync".
- Graft's comparison page https://graft.rs/docs/about/comparison/ (mvSQLite, Litestream, cr-sqlite,
  Cloudflare D1/DO, Turso, rqlite, Verneuil).

### 2.0 Update to a round-1 item: cr-sqlite

Not re-researched, one new fact: vlcn-io/cr-sqlite has commits in August 2026 (2026-08-10 "align
android loadable to 16 kb page size", "Fix macos headerpad"; 2026-08-04 "fix ios simulator build"),
but the latest release is still v0.16.3 (2024-01-17). Source (checked 2026-10-08):
https://api.github.com/repos/vlcn-io/cr-sqlite/commits , `/releases`.

### 2.1 Syncular — found by web search ("sqlite crdt sync library …") and GitHub search

- **What it is:** "Syncular keeps an SQLite database on each client and synchronizes it through a
  server-owned commit log. Apps read from local SQLite and continue to work offline." A write goes to
  local state and an outbox, and the server checks it on sync. [a]
- **Data model:** ordinary SQLite tables, but declared in its manifest (`syncular.json`) plus
  migrations, compiled by `bunx syncular generate`; "Typegen reads SQL files only. It does not
  inspect or import an existing database." [c] So our 35 tables would have to be re-declared through
  its migrations — *inferred*: possible, since they are plain tables.
- **Where it runs:** browser client on SQLite WASM over OPFS (`opfs-sahpool`, "needs no COOP/COEP
  headers and no SharedArrayBuffer"); [d] `@syncular/client` 0.31.0 depends on
  `@sqlite.org/sqlite-wasm`; its npm description says "(WASM/OPFS, Bun, Node)". [f] Native
  bindings: Rust, Swift, Kotlin, Flutter, React Native, Tauri. [a] Server: Bun, Node or Cloudflare
  Workers; storage SQLite (on Node: built-in `node:sqlite`, Node ≥ 22.13; better-sqlite3 not
  mentioned), Postgres or D1. [a][e] Capacitor, Electron: not mentioned. [c][d]
- **Transport:** its own wire protocol (written spec `docs/SPEC.md`) between client and its server;
  WebSocket realtime loop. [a][b] File or folder exchange: not found.
- **Merge rule:** without `baseVersion`, upserts apply "with last-write-wins per column"; with
  `baseVersion`, a conflict fires when a named column's `column_version > baseVersion`, the whole
  commit is rolled back, and the app keeps server, keeps local, or pushes a custom merge. [g]
  **CRDT columns:** a `CRDT` column type merged on the server by `merge(stored, incoming)`; Yjs is
  the built-in merger (`@syncular/crdt-yjs`, `yjs-doc`); CRDT-only operations never conflict. [h]
- **Licence:** Apache-2.0. [b][f]
- **Release / maintenance:** v0.31.0 2026-10-07; last commit 2026-10-07; 301 stars; "pre-1.0 and
  currently maintained by me, Benjamin Kniffler"; public APIs and protocol may change before 1.0. [a][b]
- **Verdict:** the closest maintained fit for the "own self-hosted server" path, including Yjs
  merges in SQLite columns; no file/folder path, single maintainer, schema owned by its manifest,
  node:sqlite rather than better-sqlite3 on the server.

Sources (checked 2026-10-08): [a] https://github.com/syncular/syncular (README) ·
[b] https://api.github.com/repos/syncular/syncular (+ `/releases`, `/commits`) ·
[c] https://syncular.dev/add-to-existing-app.md · [d] https://syncular.dev/platform-web.md ·
[e] https://syncular.dev/server-storage.md · [f] https://registry.npmjs.org/@syncular/client ,
https://registry.npmjs.org/@syncular/server · [g] https://syncular.dev/concepts-conflicts.md ·
[h] https://syncular.dev/concepts-crdt.md

### 2.2 backless-core — found by npm search ("local-first sqlite sync")

- **What it is:** "Core library for local-first SQLite sync via cloud storage", with
  `backless-google-drive` and `backless-onedrive` providers. [a]
- **Data model:** our own declared tables: `syncedTables` lists them, and `Backless.init()` calls
  `crsql_as_crr` on each (a non-nullable primary key is required). Adds `_sync_meta` and
  `_sync_cursors`. [a]
- **Where it runs:** loads cr-sqlite WASM through a Vite-only `?url` import; media kept in the
  browser Cache API. [a] Depends on `@vlcn.io/crsqlite-wasm` 0.16.0 (2023-12-16). [b] Node and
  Capacitor: not stated.
- **Transport (the useful part):** one app folder in the user's cloud storage:
  `changesets/device-<uuid>/cs-NNNNN.json` plus `snapshot-NNNNN.json`; "Each device writes **only to
  its own folder**. Other devices never write to each other's folders, so there are no cloud-level
  write conflicts." `sync()` pulls (all other devices' folders, applied in sequence), then pushes one
  new changeset file. Snapshot every 100 pushes; covered changesets deleted 200 pushes later; a
  device that fell behind a compacted peer gets a warning and must wipe and re-sync; device folders
  inactive 20+ days are pruned. [a]
- **Merge rule:** cr-sqlite — "last-writer-wins per column using Lamport timestamps (`col_version`)";
  deletes are tombstones. [a]
- **Licence:** the published tarball contains an MIT `LICENSE` ("Copyright (c) 2026 mikocot");
  `package.json` has no `license` field. [c] The repository it names, github.com/mikocot/backless,
  returns 404. [d]
- **Release / maintenance:** 0.10.3, 2026-09-24; first published 2026-03-14; one maintainer. [a]
- **Verdict:** not usable as a dependency (cr-sqlite WASM from 2023, browser-only, repo not public),
  but it is a worked design of exactly our folder transport.

Sources (checked 2026-10-08): [a] https://registry.npmjs.org/backless-core (README, versions) ·
[b] https://registry.npmjs.org/@vlcn.io/crsqlite-wasm ·
[c] https://registry.npmjs.org/backless-core/-/backless-core-0.10.3.tgz (LICENSE, package.json read) ·
[d] https://api.github.com/repos/mikocot/backless (404)

### 2.3 Syzy — found by GitHub search ("sqlite multi-writer replication")

- **What:** "a local-first, multi-writer replication system for SQLite and Postgres. Applications
  read and write a standard local SQLite file". [a]
- **Data model:** our own tables in a plain SQLite file; replicated DDL. [a]
- **Runs:** embedded Go API or loadable SQLite extension plus a daemon; "Linux and macOS, amd64 and
  arm64". [a] No JS, Windows, phone or WASM.
- **Transport:** one TCP connection per peer pair (gossip, catch-up), plus object storage for
  backup/restore. [b]
- **Merge rule:** transactional causal consistency with CRDT convergence; per-column ("cell-LWW")
  arbitration on cell-group tables; row liveness by causal length. [c]
- **Licence:** Apache-2.0. **Release:** GitHub releases are `guest-libs-…` build artefacts
  (latest 2026-08-03); last commit 2026-08-26; "pre-1.0". [a][d]
- **Verdict:** no — no Windows, phone or JS.

Sources (checked 2026-10-08): [a] https://github.com/wjordan/syzy (README) ·
[b] https://github.com/wjordan/syzy/blob/main/docs/TRANSPORT.md ·
[c] https://github.com/wjordan/syzy/blob/main/docs/CRDT.md · [d] https://api.github.com/repos/wjordan/syzy

### 2.4 Loomabase — found by web search and GitHub search ("sqlite crdt")

- **What:** "an open-source offline-first sync engine for applications that use SQLite on clients
  and PostgreSQL on the server." [a]
- **Data model:** SQLite triggers capture local changes; metadata per cell `(row_id, column_name) ->
  (typed_value, lamport_clock, device_id)`. [a]
- **Runs:** Rust core and SQLite client (`rusqlite`); a TypeScript SDK with "Node/Electron JSON-file
  replica storage" and a browser `localStorage` prototype; not on npm (`loomabase`, `loomabase-js`,
  `@loomabase/js` → 404). [a][c]
- **Transport:** server is a PostgreSQL adapter. [a]
- **Merge rule:** column-level LWW — incoming wins when its Lamport clock is higher, ties broken by
  device id; row lifecycle as a liveness register. [a]
- **Licence:** Apache-2.0. **Release:** none; last commit 2026-06-28 ("Disable GitHub Actions
  workflows", "Simplify README for alpha release"); "Status: alpha". [a][b]
- **Verdict:** no (Postgres server, JSON-file JS storage); a clear write-up of the column-LWW rule.

Sources (checked 2026-10-08): [a] https://github.com/JustVugg/loomabase (README) ·
[b] https://api.github.com/repos/JustVugg/loomabase · [c] https://registry.npmjs.org/loomabase

### 2.5 AMPLI-SYNC (SQLite-sync.com) — found by GitHub search ("sqlite sync offline-first")

- **What:** "Offline-first data synchronization between local SQLite databases on edge/mobile
  clients and a central PostgreSQL backend"; "schema-agnostic … You declare which tables participate
  in sync". A Java 17 / Jersey WAR on Tomcat. [a]
- **Transport:** HTTPS + JWT endpoints (`receive-changes`, `sync-compressed`, `commit-sync`,
  `prepopulate-db`); version counters and soft-delete markers. [a]
- **Merge rule:** not fixed — "Last Write Wins — version-counter based" or "Server authority". [a]
- **Licence:** MIT. **Release:** none; last commit 2026-08-14. [a][b]
- **Verdict:** no — Java server and PostgreSQL; client library not in this repo.

Sources (checked 2026-10-08): [a] https://github.com/AMPLIFIER-sp-z-o-o/ampli-sync (README) ·
[b] https://api.github.com/repos/AMPLIFIER-sp-z-o-o/ampli-sync

### 2.6 Quereus + @quereus/sync — found by npm search ("hlc crdt sqlite")

- **What:** "A pure-TypeScript SQL engine. No WASM. No native bindings." Storage through virtual
  table modules: IndexedDB, LevelDB, SQLite (NativeScript only), or custom. [a]
- **Sync:** "fully opaque CRDT replication"; "Column-level conflict resolution … Same column uses
  Last-Write-Wins with hybrid logical clocks"; DDL propagates; "Transport agnostic — Bring your own
  WebSocket, HTTP, or WebRTC"; API `getChangesSince(peerSiteId)` / `applyChanges(changes)`. [a]
- **Licence:** MIT. **Release:** v4.20.2, 2026-10-06; 1 star. [b][c]
- **Verdict:** no — it is not SQLite; the change-set API is a reference for our own.

Sources (checked 2026-10-08): [a] https://github.com/gotchoices/quereus (README) ·
[b] https://api.github.com/repos/gotchoices/quereus · [c] https://registry.npmjs.org/@quereus/sync

### 2.7 SQLiteChangesetSync — found by GitHub search ("sqlite sync offline-first")

- **What:** a Swift package that uses the SQLite session extension to capture changesets; "Similar
  to git, these changesets can then be 'pushed' to a remote repository such as a CloudKit database";
  operations push, fetch, pull, merge; "Works with existing SQLite databases". "an experimental
  concept". [a]
- **Licence:** MIT. **Release:** none; last commit 2023-12-15. [b]
- **Verdict:** no (Swift, idle); a reference for a session-extension design (round 1 measured
  `node:sqlite` and the official SQLite WASM have sessions; better-sqlite3 has not).

Sources (checked 2026-10-08): [a] https://github.com/gerdemb/SQLiteChangesetSync (README) ·
[b] https://api.github.com/repos/gerdemb/SQLiteChangesetSync

### 2.8 sql_crdt / sqlite_crdt (Dart) — found by web search ("npm sqlite crdt hybrid logical clock")

- **What:** "Dart implementation of Conflict-free Replicated Data Types (CRDTs) using SQL
  databases", influenced by James Long's "CRDTs for Mortals". "Every table gets 3 columns
  automatically added: `is_deleted`, `hlc`, and `modified`"; deletes are flags; `getChangeset` and
  `merge` to sync with remote nodes; `crdt_sync` adds networking. [a] Merge granularity: one `hlc`
  per row — *inferred*: per-record LWW.
- **Licence:** Apache-2.0. **Release:** sql_crdt 3.0.3 (2025-05-03); sqlite_crdt pushed 2026-03-25. [b]
- **Verdict:** no (Dart); the plainest reference for "HLC columns on our own tables".

Sources (checked 2026-10-08): [a] https://github.com/cachapa/sql_crdt (README) ·
[b] https://api.github.com/repos/cachapa/sql_crdt , https://api.github.com/repos/cachapa/sqlite_crdt

### 2.9 One-line sweep finds (open-source, permissive or FSL, but not a fit)

Each line: what · why not · licence · latest activity. Sources checked 2026-10-08.

- **sqlite3_crdt** (rodydavis) — C loadable extensions (uuid, hlc, crdt) for SQLite, after James
  Long's talk · native extension, no JS/WASM build, idle · Apache-2.0 · last commit 2025-03-31.
  https://github.com/rodydavis/sqlite3_crdt
- **sqlite-replication** (mmouterde) — TypeScript replication "for collaborative offline-first mobile
  app built with capacitor sqlite plugin"; master > slaves, conflicts resolved on the server;
  fetchPull/fetchPush are ours · idle, 3 stars · MIT · npm 0.0.26-b 2024-02-26, last commit
  2024-02-27. https://github.com/mmouterde/sqlite-replication , https://registry.npmjs.org/sqlite-replication
- **hooksync.js** — npm: "SQLite replication library — trigger-based change capture, ACK-based sync,
  last-write-wins conflict resolution" · no repository listed, 16 downloads/week · MIT · 0.3.0
  2026-09-11. https://registry.npmjs.org/hooksync.js
- **ZamSync** — Rust binary, append-only event replication with HLC and version vectors over its own
  TCP protocol · its own event log, not SQLite tables · MIT · v1.3.3 2026-06-27.
  https://github.com/Etoile-Bleu/ZamSync
- **CRStore** (Azarattum) — "Conflict-free replicated store" on cr-sqlite · inherits cr-sqlite's
  status · MIT · last push 2025-02-11. https://api.github.com/repos/Azarattum/CRStore
- **3leaps/cr-sqlite** — another cr-sqlite fork · 0 stars, last push 2024-10-25 · MIT.
  https://api.github.com/repos/3leaps/cr-sqlite
- **Mycelite** — "physical, single-writer replication for SQLite"; WAL databases not supported ·
  single writer · Apache-2.0 · last push 2023-09-25. https://github.com/mycelial/mycelite
- **rqlite** — "fault-tolerant, distributed relational database built on SQLite"; Graft calls it
  "focused on increasing SQLite's durability and availability through consensus" · server cluster ·
  MIT · pushed 2026-10-08. https://api.github.com/repos/rqlite/rqlite ,
  https://graft.rs/docs/about/comparison/
- **Verneuil** — SQLite VFS that "asynchronously replicates databases to S3-compatible blob stores";
  "asynchronous read replication to working single-node systems" · one writer · MIT · pushed
  2026-09-09. https://github.com/backtrace-labs/verneuil
- **mvSQLite** — "Distributed, MVCC SQLite that runs on top of FoundationDB" · needs FoundationDB ·
  Apache-2.0 · pushed 2026-10-02. https://github.com/losfair/mvsqlite
- **Turbolite** — SQLite VFS for cold queries against S3 · storage, not sync · Apache-2.0 · pushed
  2026-06-20. https://api.github.com/repos/russellromney/turbolite
- **Dotmim.Sync** — "database synchronization framework, multi platform, multi databases" · .NET,
  not JS · MIT · pushed 2025-08-28. https://api.github.com/repos/Mimetis/Dotmim.Sync
- **remelonDB** — from-scratch WatermelonDB rewrite on SQLite for React Native, web, Node, with a
  sync protocol · 1 star · MIT · pushed 2026-09-30. https://github.com/dustyway/remelonDB
- **nuxt-sync-engine** (alexanderop) — educational Vue/Nuxt todo app: sql.js WASM on the client,
  better-sqlite3 on the server, WebSocket sync, LWW with a deterministic tie-breaker · a demo, no
  licence file (GitHub licence null) · pushed 2026-02-01. https://github.com/alexanderop/nuxt-sync-engine
- **crdt-example-app** (James Long) — "A full implementation of CRDTs using hybrid logical clocks and
  a demo app" (the design Actual Budget grew from; Actual is in the reference-apps section) · demo,
  no licence file found (GitHub licence null) · pushed 2022-12-11.
  https://api.github.com/repos/jlongster/crdt-example-app
- **@actual-app/crdt** — npm "CRDT layer of Actual" · covered in the reference-apps section · MIT ·
  3.1.3 2026-09-12. https://registry.npmjs.org/@actual-app/crdt
- **@terreno/syncdb** — "Local-first data layer with TinyBase, durable outbox, and delta sync" ·
  Expo/React, part of a framework · Apache-2.0 · 57.12.0 2026-10-07. https://registry.npmjs.org/@terreno/syncdb
- **orez-lite** — "SQLite and Rust sync engine for Zero applications" · tied to Zero (round 1: no) ·
  MIT · 0.16.19 2026-09-20. https://registry.npmjs.org/orez-lite
- **TanStack DB** — "The reactive client store for your API", with SQLite persistence and
  offline-transactions packages · a client layer over another sync engine · MIT · 0.12.3 2026-10-07.
  https://api.github.com/repos/TanStack/db , https://registry.npmjs.org/@tanstack/db
- **Kikko** — "SQLite adapter for web, mobile and desktop" (lists Capacitor) · reactive queries, no
  sync · MIT · pushed 2024-01-15. https://api.github.com/repos/kikko-land/kikko ,
  https://github.com/arn4v/offline-first
- **Verdant** — "Storage, sync & realtime for local-first web apps"; IndexedDB; optional own server
  with HTTP push/pull or WebSocket · not SQLite · MIT (GitHub; npm `@verdant-web/store` 5.5.0 has no
  licence field) · pushed 2026-08-22. https://github.com/a-type/verdant
- **Legend-State** — state library with sync plugins · not SQLite; v3 still `beta` (3.0.0-beta.48,
  2026-07-12), `latest` 2.1.15 (2024-08-30) · MIT. https://registry.npmjs.org/@legendapp/state
- **remoteStorage** — open protocol for app data on a user-chosen storage server · JSON/documents,
  not SQLite · MIT · remotestoragejs 2.0.0-beta.10 2026-08-12. https://registry.npmjs.org/remotestoragejs
- **Kinto / kinto.js** — "A generic JSON document store with sharing and synchronisation
  capabilities" + "An Offline-First JavaScript Client" · JSON documents, not SQLite · Apache-2.0
  (LICENSE: Mozilla Foundation) · both pushed 2026-10. https://github.com/Kinto/kinto
- **Fireproof** — "syncs anywhere" document database · its own documents · GitHub Apache-2.0, npm
  `@fireproof/core` 0.24.19 says AFL-2.0 · pushed 2026-05-07. https://api.github.com/repos/fireproof-storage/fireproof
- **DXOS** — TypeScript P2P framework (ECHO database on Automerge) · its own objects · FSL-1.1 with
  Apache-2.0 future licence (LICENSE file; npm `@dxos/client` "FSL-1.1-Apache-2.0") · 0.13.0
  2026-10-07. https://github.com/dxos/dxos
- **NextGraph** — "Decentralized, local-first and encrypted ecosystem" in Rust · its own data model ·
  Apache-2.0 · pushed 2026-09-30. https://api.github.com/repos/nextgraph-org/nextgraph-rs
- **p2panda** — Rust crates for P2P apps (core, net, sync, store) · its own data model · Apache-2.0
  and MIT texts in `LICENSES/` · pushed 2026-10-08. https://github.com/p2panda/p2panda
- **GUN** — decentralized graph database · not SQLite · `(Zlib OR MIT OR Apache-2.0)` · 0.2020.1241
  2025-07-01. https://registry.npmjs.org/gun
- **OrbitDB** — "Peer-to-Peer Databases for the Decentralized Web" on IPFS · not SQLite · MIT ·
  `@orbitdb/core` 4.0.0 2026-05-14. https://registry.npmjs.org/@orbitdb/core
- **m-ld** — RDF/JSON-LD CRDT engine · listed "Dormant (no repository activity since 2024-08)" · MIT ·
  pushed 2024-08-03. https://github.com/gdamdam/awesome-decentralized-web , https://api.github.com/repos/m-ld/m-ld-js
- **SyncedStore** — Yjs with a state-based API · Yjs wrapper, idle · MIT · 0.6.0 2023-10-15.
  https://registry.npmjs.org/@syncedstore/core
- **Y-Sweet** — "A realtime CRDT-based document store, backed by S3" (a Yjs server) · Yjs server
  only · MIT (LICENSE) · `@y-sweet/client` 0.9.1 2025-09-16. https://github.com/jamsocket/y-sweet
- **diamond-types** — "The world's fastest CRDT. WIP." (text) · WIP · ISC (README) · pushed
  2026-09-02. https://github.com/josephg/diamond-types
- **Collabs** — composable CRDT library · "low activity" per the list · Apache-2.0 · pushed
  2025-03-25. https://api.github.com/repos/composablesys/collabs
- **Iroh** — "adds QUIC + NAT Traversal to your app" (dial by key) · a transport, not a sync engine;
  could carry phone↔desktop traffic directly · `@number0/iroh` 1.1.0 (2026-07-16) "MIT OR
  Apache-2.0" · pushed 2026-10-08. https://api.github.com/repos/n0-computer/iroh ,
  https://registry.npmjs.org/@number0/iroh
- **Syncthing** — "Open Source Continuous File Synchronization", P2P, LAN-capable · a user-run
  folder transport, not a library we would ship; MPL-2.0 is weak copyleft · pushed 2026-10-08.
  https://api.github.com/repos/syncthing/syncthing

---

## 3 · Dropped: proprietary, paid, or excluded licence (one line each, checked 2026-10-08)

- **AergoLite** — "Trustless SQLite Replication" (blockchain consensus; Android/iOS builds) — dual
  AGPL-3.0 or commercial. https://github.com/aergoio/aergolite/blob/master/LICENSING
- **LiteSync / litereplica** — npm `litesync` and `litereplica` licence "AGPLv3 or Commercial".
  https://registry.npmjs.org/litesync
- **SymmetricDS** — database replication incl. file sync — README badge "License: AGPL v3".
  https://github.com/jumpmindinc/symmetric-ds
- **dqlite** (Canonical) — Raft-replicated SQL engine — LGPL-3.0 with a linking exception.
  https://github.com/canonical/dqlite/blob/master/LICENSE
- **Bedrock** (Expensify) — LGPL-3.0. https://api.github.com/repos/Expensify/Bedrock
- **Earthstar** — offline-first P2P document store — LGPL-3.0 (GitHub; npm `earthstar` 10.2.2 is
  "LGPL-3.0-only", 2023-08-31). https://registry.npmjs.org/earthstar
- **json-joy** — JSON and rich-text CRDT — npm `json-joy` 18.30.0 is "AGPL-3.0-only"; repo root
  AGPL-3.0-only, per-package licences vary. https://registry.npmjs.org/json-joy ,
  https://github.com/streamich/json-joy/blob/master/LICENSE.md
- **Couchbase Lite** — peer-to-peer sync is an Enterprise-edition feature (per a web-search summary
  of couchbase.com/products/editions/mobile; the page itself returned HTTP 403 to fetch — partly
  unverified).
- **Ditto** — listed as "P2P database for edge and mobile (commercial)" in
  alexanderop/awesome-local-first; github.com/getditto/ditto returns 404.
- **ObjectBox** — "with built-in data sync … (sync is commercial)" per alexanderop/awesome-local-first.
- **Dexie Cloud** — hosted plans with a paid production tier; on-premises edition €3,495 one-time;
  server not described as open source (Dexie.js itself is Apache-2.0 IndexedDB). https://dexie.org/cloud/pricing
- **Realm / Atlas Device Sync** — "We announced the deprecation of Atlas Device Sync + Realm SDKs in
  September 2024." https://github.com/realm/realm-js (README)

---

## 4 · Closer look — why these three

1. **Syncular.** Every client keeps an ordinary SQLite database (OPFS WASM in a browser), the server
   runs on Node with SQLite, conflicts are per column with an explicit opt-in check, and Yjs
   documents in SQLite columns are merged by the server. That matches path 3 (our own server) and
   the Yjs plan. Open questions before trusting it: whether the WASM client works inside Android
   WebView / WKWebView under Capacitor (not stated); whether it can run on better-sqlite3 (server
   docs name only node:sqlite); how a hand-carried file or a cloud folder could feed its commit log
   (not found — it is server-ordered); bus factor (one maintainer, pre-1.0).
2. **backless-core, as a design.** It is the only published library found that syncs SQLite tables
   through Google Drive / OneDrive with one folder per device — our path 2 — including snapshot
   compaction, stale-device pruning and the "fell behind a compacted peer" case. We cannot depend on
   it (cr-sqlite WASM from 2023, browser-only, repository not public), but its folder layout and
   cycle are a ready specification for building our own.
3. **TinyBase.** MIT, very active, with persisters for better-sqlite3, node:sqlite, SQLite WASM and
   Capacitor SQLite, an HLC last-write-wins MergeableStore, and a synchronizer API that takes any
   transport. The catch is decisive for our "own tables" requirement: a MergeableStore lives in
   memory and is saved to SQLite only as one JSON blob, so TinyBase would become our data layer
   rather than sync the 35 tables we have.

Reference designs worth reading even though they are not dependencies: WatermelonDB's backend sync
spec (pull/push with server timestamps), Loomabase's and Quereus's column-LWW rules, sql_crdt's
three HLC columns, SQLiteChangesetSync's session-extension "git" model. From §6: **Actual Budget**
(MIT) applies HLC-stamped cell messages to its own SQLite tables on better-sqlite3, with a merkle
trie to find divergence and a thin store-and-forward server — the closest copyable design for our
own tables; **Trilium** (AGPL, so design only) already runs a Capacitor app whose whole server runs
in a web worker on the official SQLite WASM over `opfs-sahpool` — our planned phone architecture,
in someone's repo (not yet released).

---

## 5 · Not found / open

- TinyBase: how deletes are represented in a MergeableStore; whether a MergeableStore can ever be
  persisted in tabular mode (docs say JSON only as of v10); file-based exchange (methods exist, not
  documented); whether the Capacitor persister was ever tested on a device (tests use a mock).
- LiveStore: the "Merge conflicts" section text; which SQLite the Node adapter uses; Android WebView
  / WKWebView support; file/folder or P2P sync.
- Graft: prebuilt Android/iOS/WASM builds; whether the `fs` remote is safe on a cloud-synced folder.
- Loro: a TipTap extension; Capacitor/webview statements.
- SQLSync: Node support; coordinator deployment without building from source.
- WatermelonDB: default client conflict rule (page points to `src/sync/index.js`).
- Syncular: Capacitor / Android WebView / WKWebView; Node client's SQLite driver; better-sqlite3 on
  the server; any file or folder transport.
- backless-core: public source repository (404); Node or Capacitor support.
- Couchbase Lite edition terms (vendor page returned 403).
- Licences not stated anywhere checked: alexanderop/nuxt-sync-engine, jlongster/crdt-example-app
  (no licence file reported by GitHub).
- Reference apps (Actual, Joplin, Anytype, Logseq, Standard Notes, Notesnook, Obsidian, Zotero,
  Trilium, Colanode, Super Productivity, AFFiNE, Anki, Spacedrive, SiYuan, AppFlowy): §6, which has
  its own "not found / open" list at its end.

---

## 6 · Reference apps: how open-source local-first apps sync phone and desktop

Web research only, 2026-10-08. Every fact carries its source and "checked 2026-10-08". GitHub
facts come from `gh api repos/<owner>/<repo>` (licence, pushed_at), `/releases`, `/commits`,
`/contents/...` (code read, not run). Per the coordinator's rule change: paid or closed sync
parts get one line (is the sync part open source and self-hostable?), nothing more.

### What the field does

Six patterns, from the apps below:

1. **Cell or row changes in an op log, relayed by a thin server.** Each change is a small
   message stamped with a clock. The device applies it to its own SQLite tables. The newest
   write wins per cell (Actual), per field (Super Productivity) or per entity (Trilium,
   Spacedrive). Actual's server only stores and forwards messages; a merkle trie of timestamps
   finds where two devices diverge.
2. **One file per item in a dumb store** (folder, WebDAV, Dropbox, OneDrive, S3). Joplin writes
   every note, notebook and tag as `<id>.md`. A note changed on both sides keeps the remote
   version, and the local copy goes to a "Conflict" notebook. No text merge.
3. **Whole-state file or snapshot.** Super Productivity's file providers write one shared
   `sync-data.json`. It is only safe where the store can compare-and-swap; its LocalFile
   provider is "single-writer/backup-only". Anki merges normally but forces a one-way "full
   sync" after schema changes. SiYuan syncs git-like snapshots of its data folder.
4. **Document replication.** Obsidian's Self-hosted LiveSync uses CouchDB/PouchDB, object
   storage, or WebRTC peer-to-peer.
5. **CRDT documents.** AFFiNE stores Yjs documents in IndexedDB or SQLite. Colanode keeps
   SQLite on the client, with Yjs for pages and records. Anytype uses signed CRDT DAGs
   (any-sync).
6. **Encrypted item servers that duplicate on conflict.** Standard Notes duplicates the note.
   Notesnook takes the newest `dateModified`, and flags close-in-time edits to the same content
   as a conflict for the user.

What the apps share:

- **No app syncs the SQLite file itself.** They all exchange rows, items, ops or documents.
  Anki and Anytype warn against putting the data folder in a third-party sync service.
- **Last-writer-wins by timestamp is the default merge.** Only the grain changes: cell (Actual),
  field (Super Productivity), entity (Trilium, Spacedrive, Notesnook). Rich text either keeps a
  conflict copy (Joplin, Standard Notes, Notesnook) or uses a CRDT (AFFiNE and Colanode with
  Yjs).
- **The phone almost always reaches the desktop through a server or a cloud store.** Direct
  local-network sync exists only in Anytype (same-LAN P2P), Spacedrive (Iroh/QUIC P2P),
  LiveSync (WebRTC P2P) and Trilium (desktop to desktop with LAN access on).
- **Two apps run our planned stack in their own code:**
  - **Trilium:** an Electron desktop on better-sqlite3. Its in-repo Capacitor mobile app
    wraps a "standalone" build: the whole server runs in a web worker on the official SQLite
    WASM, stored in OPFS through the `opfs-sahpool` VFS, on both Android and iOS. The mobile
    build is not attached to any release up to v0.106.0.
  - **Actual:** Electron and its API on better-sqlite3, the browser on sql.js + absurd-sql
    (IndexedDB). A Capacitor `mobile-client` scaffold was checked in on 2026-07-03.
- **Code we could copy under a permissive licence:**
  - Actual (MIT): `@actual-app/crdt`, the HLC and merkle trie.
  - Super Productivity (MIT): its op-log and vector-clock design docs.
  - Colanode (Apache-2.0).
  - any-sync (MIT).
  - LiveSync and obsidian-git (MIT).
  - Spacedrive (Apache-2.0 per the GitHub API).

  Joplin, Trilium, Logseq, Standard Notes, Notesnook, Zotero, Anki, SiYuan and AppFlowy are
  AGPL or GPL.
- **Inference (mine, not a source's):** Super Productivity's file-provider problem is that
  every device writes one shared file. "One change file per device" (our decided design)
  sidesteps that, because no two devices ever write the same file.

---

### Actual Budget

- **What:** "A local-first personal finance app" (MIT). Latest release v26.10.0, 2026-10-02;
  last commit 2026-10-08. — `gh api repos/actualbudget/actual` and `/releases`, checked
  2026-10-08.
- **Device store: SQLite.**
  - Desktop (Electron) and the Node API use `better-sqlite3`
    (`packages/loot-core/src/platform/server/sqlite/index.electron.ts` imports `better-sqlite3`).
  - The browser/PWA build uses `@jlongster/sql.js` with `absurd-sql`, which "serves every page
    cache miss with a synchronous round trip to IndexedDB" (`.../sqlite/index.ts`).
  - Source: github.com/actualbudget/actual/tree/master/packages/loot-core/src/platform/server/sqlite,
    checked 2026-10-08.
- **Sync model:**
  - Every change is a message `{dataset, row, column, value}` (table, row id, column, value),
    stamped with a timestamp. The client stores them in its `messages_crdt` table.
  - Applying a message runs `INSERT INTO <dataset> (id, <column>)` or
    `UPDATE <dataset> SET <column> = ? WHERE id = ?` on the app's own tables.
  - `compareMessages` flags a message as "old" "when a later value for the same cell already
    exists"; old messages are not applied but still go into the merkle trie. That is
    **last-writer-wins per cell**.
  - A merkle trie keyed by timestamp ("trinary radix trie", base-3 minutes) is compared with
    the server's to find where to resend from.
  - The wire format is protobuf (`SyncRequest {messages, fileId, groupId, keyId, since}`,
    `SyncResponse {messages, merkle}`), with optional per-message encryption
    (`EncryptedData {iv, authTag, data}`).
  - Sources: github.com/actualbudget/actual/blob/master/packages/loot-core/src/server/sync/index.ts,
    …/packages/crdt/src/crdt/merkle.ts, …/packages/crdt/src/proto/sync.proto, checked
    2026-10-08.
  - Its author: the messages_crdt timestamp "is a HLC"; the server "is basically a thin client
    that keeps messages … and moves them around" — jlongster.com/using-crdts-in-the-wild,
    checked 2026-10-08.
- **The CRDT package:**
  - `@actual-app/crdt` 3.1.3 (MIT, 2026-09-12; deps uuid, murmurhash, @bufbuild/protobuf) —
    registry.npmjs.org/@actual-app/crdt, checked 2026-10-08.
  - Its README: "shared between the client and server … any usage of it outside Actual is
    undocumented and at your own risk" — github.com/actualbudget/actual/tree/master/packages/crdt,
    checked 2026-10-08.
- **Offline and conflicts (docs):**
  - It "stores all of your data on your local device" and syncs "in the background" when
    online.
  - Conflicts: "This should work unless the edits conflict." A sync reset reverts un-synced
    changes from other devices.
  - Optional end-to-end encryption.
  - Source: actualbudget.org/docs/getting-started/sync/, checked 2026-10-08.
- **Self-host:**
  - Docker, a "Server CLI", desktop apps that connect to a server, or managed PikaPods/Fly.io.
    "A server is not required … but it is strongly recommended"; device sync needs one —
    actualbudget.org/docs/install/, checked 2026-10-08.
  - The server is the npm package `@actual-app/sync-server` 26.10.0 (MIT, 2026-10-02; depends
    on express, better-sqlite3, @actual-app/crdt) — registry.npmjs.org/@actual-app/sync-server,
    checked 2026-10-08.
- **File/folder sync:**
  - None found for live sync.
  - Export gives a zip with `db.sqlite` + `metadata.json`. Importing it via "Import File"
    creates a separate budget; the docs suggest renaming it and deleting the old copy
    afterwards, so it is not a merge.
  - Sources: actualbudget.org/docs/backup-restore/backup, …/restore, checked 2026-10-08.
- **Phone ↔ desktop:**
  - Through the sync server. The phone uses the web app, which "can also be installed on your
    device"; on mobile "an installed web page will work offline" —
    actualbudget.org/docs/install/, checked 2026-10-08.
  - A Capacitor `packages/mobile-client` (Capacitor ^8.4.2, Android + iOS, `webDir` = the web
    build) was checked in on 2026-07-03 ("Check in mobile app scaffolding generated by
    Capacitor (#8387)"). The install docs don't mention it —
    github.com/actualbudget/actual/tree/master/packages/mobile-client, checked 2026-10-08.

### Joplin

- **What:** A note app for Windows, macOS, Linux, Android and iOS. Latest release v3.7.21,
  2026-09-25; last commit 2026-10-08. — `gh api repos/laurent22/joplin`, checked 2026-10-08.
- **Licence:**
  - Repo default is **AGPL-3.0-or-later**, "unless a directory contains a LICENSE".
    `packages/server` carries the **"Joplin Server Personal Use License"**: "may be used for
    personal non-commercial purposes only" (§2.3) — github.com/laurent22/joplin/blob/dev/LICENSE,
    …/packages/server/LICENSE.md, checked 2026-10-08.
  - "Joplin Server Business" is the commercial licence — …/packages/server/README.md, checked
    2026-10-08.
- **Device store:** SQLite. Desktop and lib depend on `sqlite3` 5.1.6; mobile on `expo-sqlite`;
  `app-mobile` also lists `@sqlite.org/sqlite-wasm` — packages/app-desktop, app-mobile,
  lib `package.json`, checked 2026-10-08.
- **Sync model:**
  - Targets: Joplin Cloud, Nextcloud, S3, WebDAV, Dropbox, OneDrive "or the local filesystem",
    through drivers with a filesystem-like interface (read, write, delete, list) —
    joplinapp.org/help/apps/sync/, checked 2026-10-08.
  - Each item is one file named `<id>.md` (`BaseItem.systemPath`): title, body, then
    `key: value` property lines (`BaseItem.serialize`) —
    github.com/laurent22/joplin/blob/dev/packages/lib/models/BaseItem.ts, checked 2026-10-08.
  - Per-item sync state is kept in a `sync_items` table (`sync_time`). Changes upload "within a
    few seconds"; clients poll every few minutes. The target's settings live in `info.json` —
    joplinapp.org/help/dev/spec/sync, checked 2026-10-08.
- **Merge rule:** Same note changed in two places → "the remote note replaces the local note"
  and the local copy goes to a "Conflict" notebook. No text merge —
  joplinapp.org/help/apps/conflict/, checked 2026-10-08.
- **Self-host:**
  - `docker run … joplin/server:latest`. SQLite is the default "to test the app"; PostgreSQL
    for production — github.com/laurent22/joplin/blob/dev/packages/server/README.md, checked
    2026-10-08.
  - Self-hosting is also unnecessary: any WebDAV, S3 or folder target works.
- **File/folder sync:**
  - Yes: "the local filesystem" target, usable with Syncthing and similar tools.
  - On Android, forum users call it slow (SAF) and unreliable, and point to WebDAV instead —
    discourse.joplinapp.org/t/feature-request-enable-filesystem-sync-on-mobile-android-ios/48336,
    …/t/android-filesystem-sync-99-reliable/41134 (user reports, not official), checked
    2026-10-08.
- **Phone ↔ desktop:** Both point at the same sync target (cloud, WebDAV, S3, Joplin Server).

### Anytype

- **What:** A local-first, encrypted object workspace.
- **Licences (they split):**
  - The protocol `anyproto/any-sync` is **MIT** (tag v0.13.8; last commit 2026-10-07; no
    GitHub releases).
  - The clients `anytype-ts` (v0.57.4, 2026-10-03), `anytype-heart` and `anytype-kotlin` carry
    the **"Any Source Available License 1.0"**: use "only (a) for Non-Commercial Use, or (b)
    for Commercial Use in Allowed Networks". Not open source.
  - Sources: `gh api repos/anyproto/{any-sync,anytype-ts,anytype-heart,anytype-kotlin}` and
    `/license`, checked 2026-10-08.
- **Device store:**
  - "Offline first … all data … stored locally first"; "a private IPFS network to handle
    storage"; files in encrypted fragments in `flatfs`; the database engine is not named —
    doc.anytype.io/anytype/data/storage, checked 2026-10-08.
  - `anytype-heart` `go.mod` lists any-store v1.0.2 (MIT, "Document-oriented embedded
    database for Go"), SQLite drivers and badger — github.com/anyproto/anytype-heart/blob/develop/go.mod,
    `gh api repos/anyproto/any-store`, checked 2026-10-08.
- **Sync model and merge:**
  - Data "stored as encrypted Directed Acyclic Graphs"; "CRDT-based … cryptographically signing
    every change in its DAGs"; consistent final state "without traditional consensus
    protocols".
  - Node types: sync, file, consensus, coordinator.
  - Source: github.com/anyproto/any-sync (README), checked 2026-10-08.
- **Self-host:**
  - The team maintains `any-sync-dockercompose` (MIT, v8.0.1, 2026-09-25). The community
    `grishy/any-sync-bundle` (MIT, v1.6.1, 2026-10-06) merges "all official Anytype sync
    modules into a single binary".
  - Clients load a `.yml` network config: "Network → Self-hosted", on desktop and mobile.
  - Sources: doc.anytype.io/anytype/data/sync-and-backup/self-host, pkg.go.dev/github.com/grishy/any-sync-bundle,
    `gh api` both repos, checked 2026-10-08.
- **File/folder sync:** None. Local-only mode warns that network drives or third-party sync
  services "will likely corrupt data" — doc.anytype.io/anytype/data/sync-and-backup/local-only,
  checked 2026-10-08.
- **Phone ↔ desktop:**
  - Through the Anytype network or a self-hosted network.
  - Or direct: "Local P2P is supported … if they are connected through the same local network",
    in any mode, and "the only way" in local-only mode (experimental) —
    doc.anytype.io/anytype/data/storage, …/local-only, checked 2026-10-08.

### Logseq

- **What:** Licence AGPL-3.0. Latest release 2.0.2, 2026-10-07 — `gh api repos/logseq/logseq`,
  checked 2026-10-08.
- **Sync part:**
  - The DB-version sync server lives in the repo (`deps/db-sync`, `@logseq/db-sync`): "the
    Cloudflare Worker implementation and a Node.js adapter for self-hosting". The adapter
    stores "sqlite + assets" and is documented with Cognito auth.
  - The device graph DB is SQLite (a `kvs` table).
  - Sources: github.com/logseq/logseq/tree/master/deps/db-sync (README, package.json:
    better-sqlite3 ^12.8.0), checked 2026-10-08.
  - Official sync is part of paid Logseq Pro, per a community FAQ — discuss.logseq.com
    threads / logseq.io FAQ via search (community, not official), checked 2026-10-08. Not
    researched further (paid).

### Standard Notes

- **Sync part:** Open source and self-hostable.
  - The server `standardnotes/server` is **GPL-3.0** ("fully self-hostable"); the clients
    `standardnotes/app` are **AGPL-3.0** — `gh api`, checked 2026-10-08.
  - Docker Compose ("only 4 total containers"), MySQL, a LocalStack bootstrap script. You
    "cannot use app.standardnotes.com with a self-hosted server" —
    standardnotes.com/help/self-hosting/docker, checked 2026-10-08.
- **Merge:** The server "cannot read your note contents, so cannot automatically resolve
  conflicts"; "conflicts are handled on the app-level, usually by duplicating your note" —
  standardnotes.com/help/33/how-do-i-clear-duplicates, checked 2026-10-08.
- **Device store:** Not found. Paid plans not researched.

### Notesnook

- **Licences:** App **GPL-3.0** (`streetwriters/notesnook`; v3.4.9 2026-10-06, Android 3.4.14
  2026-10-08). Sync server **AGPL-3.0** (`notesnook-sync-server`, "self-hosting in alpha"; last
  release v1.0-beta.4 2025-10-07, last commit 2026-09-21) — `gh api`, checked 2026-10-08.
- **Self-host:** Docker Compose with MongoDB, MinIO and the Notesnook services; "possible, but
  without support". The identity server and SSE messaging are still listed "to be open-sourced"
  — github.com/streetwriters/notesnook-sync-server, checked 2026-10-08.
- **Device store:** SQLite through Kysely.
  - Core and desktop use `better-sqlite3-multiple-ciphers`; mobile uses `react-native-quick-sqlite`.
  - The web app carries its own SQLite VFS files (`AccessHandlePoolVFS.js`,
    `IDBBatchAtomicVFS.js`) in `apps/web/src/common/sqlite`.
  - Source: github.com/streetwriters/notesnook package.json files, checked 2026-10-08.
- **Merge rule:**
  - `mergeItem`: the remote item wins if `remoteItem.dateModified > localItem.dateModified`
    (LWW per item).
  - Rich-text content (`tiptap`) edits within a threshold (60 s) are marked `conflicted` for
    the user to resolve.
  - Source: github.com/streetwriters/notesnook/blob/master/packages/core/src/api/sync/merger.ts,
    checked 2026-10-08.
- **File/folder sync:** Not found. Its paid cloud is not researched.

### Obsidian and community sync plugins

- **Obsidian Sync:** Paid ($4–$10 per user per month). The page does not say it is open source
  or self-hostable, and obsidian.md/license reserves rights to "code in the app" —
  obsidian.md/sync, obsidian.md/license, checked 2026-10-08. Closed; not researched further.
- **Self-hosted LiveSync** (`vrtmrz/obsidian-livesync`, **MIT**, 1.0.35, 2026-10-05):
  - Backends: CouchDB, or object storage (MinIO, S3, R2), or WebRTC peer-to-peer (needs a
    signalling relay only).
  - "Automatically merge simple conflicts"; end-to-end encryption; "all Obsidian-compatible
    platforms".
  - Self-host guides for CouchDB (also on fly.io and Raspberry Pi).
  - Source: github.com/vrtmrz/obsidian-livesync, checked 2026-10-08.
- **Remotely Save** (`remotely-save/remotely-save`):
  - Licence split: `src`, `tests`, `docs`, `assets` are Apache-2.0; `pro` is PolyForm Strict
    1.0.0 (source-available).
  - Last release 0.5.25, 2024-10-20; last commit 2024-11-10.
  - Backends: S3, Dropbox, OneDrive (app folder), WebDAV; others PRO.
  - Free version "can detect conflicts, but users have to choose to keep newer version or
    larger version"; merging markdown is PRO "Smart Conflict". Mobile supported.
  - Sources: github.com/remotely-save/remotely-save (README, LICENSE), checked 2026-10-08.
- **obsidian-git** (`Vinzent03/obsidian-git`, **MIT**, 2.41.1, 2026-10-02): "Automatic
  commit-and-sync (commit, pull, and push)". Mobile runs on isomorphic-git: "very unstable", no
  SSH — github.com/Vinzent03/obsidian-git, checked 2026-10-08.
- **Device store:** The vault is a folder of files. The plugins sync files, not a database.

### Zotero

- **Licence:** **AGPL-3.0** for the client (`zotero/zotero`, COPYING; latest tag 10.0.5, no
  GitHub releases) and for the server (`zotero/dataserver`, COPYING; last commit 2026-10-07) —
  `gh api`, checked 2026-10-08.
- **Device store:** "Zotero … reads the `zotero.sqlite` file" — zotero.org/support/zotero_data,
  checked 2026-10-08.
- **Sync model:** "Data syncing merges library items, notes, links, tags" through Zotero's
  servers, which need an account. File sync goes through Zotero Storage or WebDAV; WebDAV is
  for files only. Conflicting changes show "a conflict resolution dialog asking which version
  you'd like to keep" — zotero.org/support/sync, checked 2026-10-08.
- **Self-host:** The data server's code is published, but self-hosting is not supported (forum
  replies, 2014–2026) — forums.zotero.org/discussion/comment/191719,
  forums.zotero.org/discussion/comment/312497 (community, via search), checked 2026-10-08.
- **Phone ↔ desktop:** Through zotero.org. iOS and Android apps exist (`zotero/zotero-ios`,
  `zotero/zotero-android`; licence NOASSERTION) — `gh api`, checked 2026-10-08.

### Trilium Notes (TriliumNext) — found in the sweep

- **What:** **AGPL-3.0**. Latest release v0.106.0, 2026-09-25; last commit 2026-10-08 —
  `gh api repos/TriliumNext/Trilium`, checked 2026-10-08.
- **Device store:**
  - Server and desktop use `better-sqlite3` 13.0.3 (Electron 44.5.1).
  - `apps/standalone` is a "Standalone client for TriliumNext with SQLite WASM backend"
    (`@sqlite.org/sqlite-wasm` 3.51.1-build2). Its worker installs the `opfs-sahpool` VFS
    (`installOpfsSAHPoolVfs`) and loads the DB "from SAHPool (WAL)".
  - Sources: github.com/TriliumNext/Trilium apps/{server,desktop,standalone}/package.json,
    apps/standalone/src/local-server-worker.ts, checked 2026-10-08.
- **Mobile:**
  - `apps/mobile` is a "Capacitor-based mobile app for TriliumNext, built on the standalone
    client" (Capacitor 8.5.2, Android + iOS).
  - "There is **no network backend** — the whole server runs in-process as WASM in a web
    worker." API and sync calls go through `window.standaloneApi.localFetch`.
  - Android loads at `https://localhost` with a service worker. iOS loads at
    `capacitor://localhost` with fetch/XHR interceptors, because "Capacitor **ignores**
    `iosScheme: "https"`".
  - Source: github.com/TriliumNext/Trilium/blob/main/apps/mobile/README.md, checked
    2026-10-08.
  - First commit in `apps/mobile` within the last 72: 2026-04-20; newest 2026-10-06. No
    APK/iOS asset in releases v0.102.0–v0.106.0, so not released — `gh api` commits and
    releases, checked 2026-10-08.
- **Sync model and merge:**
  - Changes are logged in `entity_changes` (`changeId`, `hash`, `utcDateChanged`), synced via
    `/api/sync/check`, `/pull` and `/push`. Content conflicts: "Last-write-wins based on
    `utcDateModified`" — docs.triliumnotes.org/developer-guide/concepts/sync, checked
    2026-10-08.
  - Topology is "star-shaped" around a sync server. Two desktops can also sync "without
    requiring a Server Installation" (LAN access needed since v0.104.0) —
    docs.triliumnotes.org/user-guide/setup/synchronization, checked 2026-10-08.
- **Self-host:** Docker, a packaged Linux build, NixOS, manual, Kubernetes (doc navigation) —
  same page, checked 2026-10-08.
- **File/folder sync:** Not found.

### Colanode — handed over by the parent's sweep

- **What:** "Open-source and local-first Slack and Notion alternative". **Apache-2.0**.
  Latest release v0.4.7, 2026-04-03; last commit 2026-04-03 (six months quiet) —
  `gh api repos/colanode/colanode`, checked 2026-10-08.
- **Device store:**
  - "All changes … are saved to a local SQLite database first and then synced to the server."
  - Desktop: Electron ^40.8.5 + `better-sqlite3` ^12.8.0. Web: `@sqlite.org/sqlite-wasm`.
    `apps/mobile`: Expo + `expo-sqlite` (not Capacitor). Server: Postgres (pgvector) via
    Kysely, plus Redis.
  - Sources: github.com/colanode/colanode README and apps/*/package.json, checked 2026-10-08.
- **Merge rule:** Pages and database records use Yjs CRDTs; deletions are "specialized
  transactions"; "Messages and file operations don't support concurrent edits and use simpler
  database tables" — README, checked 2026-10-08.
- **Self-host:** Docker Compose (`hosting/`), Helm charts (`hosting/kubernetes/`) — README,
  checked 2026-10-08.
- **File/folder sync:** Not found.
- **Phone ↔ desktop:** Through the server. The README lists web (early preview) and desktop
  clients only; the mobile app exists in the repo, release status not found.

### Super Productivity — found in the sweep

- **What:** A to-do and time-tracking app. **MIT**. Latest release v19.1.0, 2026-09-19 —
  `gh api repos/super-productivity/super-productivity`, checked 2026-10-08.
- **Platforms:** Electron desktop, plus Capacitor 8 for Android and iOS
  (`@capacitor/android`, `@capacitor/ios`, `@capacitor/filesystem`) — root package.json,
  checked 2026-10-08.
- **Device store:** IndexedDB. "IndexedDB remains the live op-log backend on every platform";
  a native SQLite migration was "Parked by maintainer decision" on 2026-09-26 —
  github.com/super-productivity/super-productivity/blob/master/docs/sync-and-op-log/sqlite-migration.md,
  checked 2026-10-08.
- **Sync model:**
  - "The Operation Log is the **single client sync pipeline** for SuperSync and file
    providers"; "Vector clocks detect causal order and concurrent edits" — docs/sync-and-op-log/README.md,
    checked 2026-10-08.
  - Merge: "Concurrent edits to different fields can be combined safely; overlapping edits use
    deterministic LWW" (per field) — docs/sync-and-op-log/conflict-journal-and-review.md,
    checked 2026-10-08.
- **Transports:**
  - SuperSync, its own server: `packages/super-sync-server`, Prisma on PostgreSQL —
    package.json, checked 2026-10-08. An Unraid listing says the official image sits in a
    private registry — ca.unraid.net/apps/supersync-1awhsqf0pha5mr (third party), checked
    2026-10-08.
  - File providers (Dropbox, WebDAV/Nextcloud, OneDrive, LocalFile) share one
    `sync-data.json` envelope ("state, archives, vector clock, and a bounded recent-operation
    window"); an opt-in v3 splits off `sync-ops.json`.
  - Compare-and-swap holds only on Dropbox and OneDrive, and on WebDAV with strong ETags.
    "LocalFile … is therefore single-writer/backup-only."
  - Source: docs/sync-and-op-log/sync-architecture.html, checked 2026-10-08.
- **Phone ↔ desktop:** Through SuperSync or a shared cloud file.

### AFFiNE — found in the sweep

- **Licence (split):**
  - Outside `packages/backend` and `packages/common/native`: **MIT**.
  - The backend server's "Enterprise Edition (EE) license" allows production use only with a
    subscription. Parts that ship as AFFiNE Community Edition are MPL-2.0.
  - Sources: github.com/toeverything/AFFiNE LICENSE and packages/backend/server/LICENSE,
    checked 2026-10-08.
- **Release:** Latest non-canary v0.27.4, 2026-08-18 — `gh api`, checked 2026-10-08.
- **Device store:** `@affine/nbstore` has `idb` and `sqlite` implementations and depends on
  `yjs` ^13.6.27 — packages/common/nbstore/package.json, checked 2026-10-08.
- **Mobile:** Android and iOS apps are Capacitor ^8.4.2 (`packages/frontend/apps/{android,ios}`)
  — package.json files, checked 2026-10-08.
- **Merge rule:** Yjs, inferred from the dependency; not documented on a page I read.
- **Self-host:** Not researched; the server is EE-licensed for production.

### Anki — found in the sweep

- **Licence:** "AGPL, version 3 or later", portions BSD-3 (`ankitects/anki` LICENSE; 26.09.3,
  2026-09-23). AnkiDroid is GPL-3.0 (v2.25.1, 2026-10-06) — `gh api`, checked 2026-10-08.
- **Device store:** `collection.anki2` (the docs repair it with `sqlite3` commands). "We do not
  recommend you sync your Anki folder directly with a third-party synchronization service" —
  docs.ankiweb.net/files.html, checked 2026-10-08.
- **Merge rule:**
  - "Reviews and note edits can be merged". Changes to note format (a field, a card template)
    force a one-way sync where "only changes on one end can be preserved".
  - A card reviewed on two devices keeps both reviews and "the state it was when it was most
    recently answered".
  - Source: docs.ankiweb.net/syncing.html, checked 2026-10-08.
- **Self-host:** Built in. `anki --syncserver`, `pip install anki` + `python -m anki.syncserver`,
  or the Rust `anki-sync-server` binary; a user-contributed Dockerfile. Plain HTTP (use a VPN
  or HTTPS proxy). AnkiDroid 2.16+ and AnkiMobile can point at it —
  docs.ankiweb.net/sync-server.html, checked 2026-10-08.
- **Phone ↔ desktop:** Through AnkiWeb or the self-hosted sync server.

### Spacedrive — found in the sweep

- **What:** **Apache-2.0** per the GitHub API. v2.0.0-alpha.2, 2026-02-07, plus nightlies —
  `gh api repos/spacedriveapp/spacedrive`, checked 2026-10-08.
- **Sync model:**
  - "Sync uses two protocols based on data ownership". Device-owned data (locations, files)
    uses state broadcast; shared resources (tags, collections) use an "HLC-ordered log", with
    "Last Write Wins based on HLC ordering".
  - "No central server … Every device is equal". Transport: JSON messages "over Iroh/QUIC
    streams". Store: a SQLite `sync.db` (debug command).
  - Source: v2.spacedrive.com/core/library-sync.md, checked 2026-10-08.
- **Mobile participation:** Not stated (only a "Mobile" configuration preset).

### Others: one line each

- **SiYuan** (AGPL-3.0, v3.8.7-alpha.6): sync and snapshots come from `siyuan-note/dejavu`
  (AGPL-3.0), "Git-like version control … Cloud sync and backup". Which sync backends are free
  vs paid: not found — `gh api` + dejavu README, checked 2026-10-08.
- **AppFlowy** (AGPL-3.0): the open `AppFlowy-Cloud` server is archived. Self-hosting now goes
  to "AppFlowy-SelfHost-Commercial", and new server features are "only available in the
  official prebuilt Docker images" — github.com/AppFlowy-IO/AppFlowy-Cloud README, checked
  2026-10-08. Not open source going forward; dropped.

### Table

| App | Device store | Sync model / merge | Self-host | File/folder sync | Licence | Phone ↔ desktop |
|---|---|---|---|---|---|---|
| Actual Budget | SQLite: better-sqlite3 (Electron); sql.js + absurd-sql/IndexedDB (web) | HLC-stamped cell messages applied to own tables; LWW per cell; merkle trie finds divergence | Docker or npm `@actual-app/sync-server` (Node, better-sqlite3) | No (export zip → import = new budget) | MIT (app, crdt, server) | Via server; phone = PWA; Capacitor scaffold in repo (2026-07) |
| Joplin | SQLite (sqlite3; expo-sqlite on mobile) | One `<id>.md` per item; remote wins, local copy → Conflict notebook | `joplin/server` Docker (Postgres for prod) — or none needed | Yes (filesystem, WebDAV, S3, Dropbox, OneDrive) | Clients AGPL-3.0-or-later; Server = personal-use, non-commercial | Same sync target |
| Anytype | Go stores (any-store, SQLite drivers, badger) + private IPFS | Signed CRDT DAGs (any-sync) | Docker Compose (team) or single binary (any-sync-bundle, community) | No (warns it corrupts) | any-sync MIT; clients source-available (non-commercial) | Network/self-hosted node, or same-LAN P2P |
| Logseq | SQLite (`kvs`) for DB graphs | DB sync (RTC/worker); details not researched (paid) | Node adapter in repo (Cognito auth) | — | AGPL-3.0 | Paid Logseq Pro sync, or self-hosted adapter |
| Standard Notes | not found | Encrypted items; conflict → duplicate note | Docker Compose (MySQL) | No | Server GPL-3.0; apps AGPL-3.0 | Via server |
| Notesnook | SQLite via Kysely (better-sqlite3-multiple-ciphers; quick-sqlite) | LWW by `dateModified`; close rich-text edits flagged as conflict | Docker Compose (alpha, unsupported) | not found | App GPL-3.0; server AGPL-3.0 | Via server |
| Obsidian + LiveSync | Vault folder (plugin: PouchDB) | CouchDB replication / object storage / WebRTC P2P; auto-merge simple conflicts | CouchDB (Docker, Pi, fly.io) | Remotely Save, obsidian-git (files) | Obsidian closed; LiveSync MIT; Remotely Save Apache-2.0 + PolyForm Strict | Via CouchDB/S3, or P2P |
| Zotero | `zotero.sqlite` | Server merge; conflict dialog | Code published (AGPL), self-host unsupported | WebDAV for attachments only | AGPL-3.0 | Via zotero.org |
| Trilium | SQLite: better-sqlite3 (desktop/server); SQLite WASM + OPFS sahpool (standalone/mobile) | `entity_changes` push/pull; LWW by `utcDateModified` | Docker, packages, K8s; or desktop-to-desktop | not found | AGPL-3.0 | Sync server; Capacitor mobile (server-in-WASM) in repo, not released |
| Colanode | SQLite: better-sqlite3 (Electron), sqlite-wasm (web), expo-sqlite (mobile) | Yjs for pages/records; simple tables for messages/files | Docker Compose, Helm (needs Postgres, Redis) | not found | Apache-2.0 | Via server; quiet since 2026-04 |
| Super Productivity | IndexedDB op log (SQLite parked) | Op log + vector clocks; per-field LWW | SuperSync (Postgres; image reportedly private) | Yes, but one shared `sync-data.json`; LocalFile single-writer | MIT | Via SuperSync or a shared cloud file |
| AFFiNE | nbstore: IndexedDB or SQLite, Yjs docs | Yjs (from deps) | EE licence for production server | not found | Client MIT; server EE / MPL-2.0 (CE) | Capacitor apps; via server |
| Anki | `collection.anki2` (SQLite) | Merge reviews/edits; schema change → one-way full sync | Built in (`--syncserver`, pip, Rust binary) | No (advises against) | AGPL-3.0+; AnkiDroid GPL-3.0 | Via AnkiWeb or own server |
| Spacedrive | SQLite (`sync.db`) | Device-owned state + HLC log; LWW | No server (P2P) | — | Apache-2.0 (API) | Iroh/QUIC P2P; mobile not stated |

### Not found / open

- Standard Notes: device store.
- Notesnook: file/folder sync; whether the identity server is open-sourced yet.
- Joplin: official word on file-system sync on mobile (only user reports found).
- Actual: release status of the Capacitor `mobile-client` (in repo, not in the install docs).
- Trilium: when the Capacitor mobile app ships (not in releases up to v0.106.0).
- Colanode: release status of `apps/mobile`; whether it is maintained (no commit since
  2026-04-03).
- AFFiNE: Yjs merge as a documented rule (inferred from dependencies); self-host terms in
  detail.
- SiYuan: which sync backends are free.
- Spacedrive: whether mobile devices take part in sync.
