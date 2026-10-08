<!-- SPDX-License-Identifier: MIT -->
# Sync platforms: what each one is (research, 2026-10-08)

**What this is.** One of two research records behind the family's sync decision (the user,
2026-10-08: "no we need to decide on sync method for jw and make it so we coudl add it to other
apps easily if we decide we want to say sync acrross desktops or just run the server in the
cloud"). The design discussion is JustWrite's `docs/plans/2026-10-08-sync-design.md`; the other
record is `2026-10-08-sync-research-building-blocks.md` (SQLite sessions, cr-sqlite, Yjs,
Automerge, Litestream, libSQL `sqld`); the register's summary is RESEARCH §2, "Sync". Gathered by
a research agent on 2026-10-08; nothing in any repo was changed. **Nothing is decided.**

Every fact below is **web, 2026-10-08** unless marked otherwise. Sources are each project's own
pages, its GitHub repo (read through `gh api`), and the npm registry (`npm view`). npmjs.com
answered 403 to the fetcher, so READMEs come from `npm view <pkg> readme` or the repo.
"Our reading" marks an inference of ours, not something the page says.
"Not stated on <url>" means the page was read and does not say it.

Context already settled in `justwrite-app/docs/plans/2026-10-08-sync-design.md` (not redone):
Dropbox-file = no, Joplin-style folder sync, sqlite-sync = Elastic License 2.0.

---

## 1a. libSQL embedded replicas (Turso's older path)

- **What it is:** "Embedded Replicas keep a local read replica of a Turso Cloud database."
  "Writes are sent to the remote primary database" by default; "You can write locally if you
  set the `offline` config option to `true`." — docs.turso.tech/features/embedded-replicas/introduction
- **Status:** the same page calls them "fully supported in production" but says "For new
  projects that need sync, we recommend" Turso Sync. The libSQL README: "libSQL is actively
  maintained, but new features are being developed in Turso." and "If you're starting a new
  project, you probably want to look into Turso." — github.com/tursodatabase/libsql (README)
- **Merge:** not stated on the embedded-replicas page (no conflict rule for offline writes).
- **Server:** `syncUrl` is "the URL of the remote Turso Cloud database". libSQL's own server
  `sqld` is self-hostable (docs/USER_GUIDE.md: a primary that accepts writes, replica servers
  that poll it over gRPC; Docker deployment). Whether an embedded replica can sync against a
  self-hosted `sqld`: not stated on the embedded-replicas page.
- **Our schema:** libSQL is "a fork of SQLite" (repo). Our reading: the replica is a SQLite
  file holding our own tables, but the desktop would open it through libSQL's client, not
  better-sqlite3.
- **Node/Electron:** `@libsql/client` 0.18.0 (2026-09-02, MIT), `libsql` 0.5.29 (2026-03-25,
  MIT) — npm. Page: "In certain contexts, such as serverless environments without a
  filesystem, you can't use embedded replicas." Browser: not mentioned on the page.
- **Capacitor/phone:** not stated on the page (mobile named only as a use case).
- **Warnings on the page:** "Do not open the local database while the embedded replica is
  syncing." "This can lead to data corruption."
- **Licence:** MIT (repo + npm).
- **Latest:** GitHub release `libsql-server-v0.24.32`, 2025-02-14; repo last push 2026-10-01.
- **E2EE:** not stated (the page shows encryption-at-rest snippets only).

## 1b. Turso Database + Turso Sync (the current path)

- **Current docs URL:** `docs.turso.tech/features/offline-sync` still 404s. The pages are now
  docs.turso.tech/sync, /sync/usage, /sync/conflict-resolution, /sync/local-sync-server,
  /sync/partial, /sync/checkpoint (from docs.turso.tech/llms.txt).
- **What it is:** Turso Database is "A SQL database in Rust: SQLite-compatible, now also
  speaking Postgres (experimental)" (repo description), MIT. Turso Sync: "With Turso Sync, all
  reads and writes happen locally by default"; you call `push()` and `pull()` yourself; it is
  the "modern equivalent of the `offline: true` flag" of embedded replicas. — docs.turso.tech/sync
- **Bidirectional + offline writes:** yes. "If your app needs to accept writes without internet
  connectivity, write locally and call `push()` when the connection is available." "All
  changes are safely stored in the local database file until they can be synced."
  `bootstrapIfEmpty: false` lets the app start without reaching the remote; the JS `url` can be
  a function returning null, so sync "switches on" later (types.ts in the repo). — /sync/usage.md,
  bindings/javascript/sync/packages/common/types.ts
- **Merge:** "logical statements are sent, and on conflicts the strategy is 'last push wins'."
  On pull with unpushed changes: "Your local database is rolled back to the last synced state",
  remote changes applied, local changes replayed, "atomically". Granularity (row / column /
  statement): not stated on /sync/conflict-resolution.md (its example is two clients updating
  the same row). An optional `transform` callback sees every mutation before push and may
  `skip` or `rewrite` it, "in order to support complex conflict resolution strategy" (types.ts;
  also the 2025-10-08 launch blog).
- **Server:** the docs' usage "uses the Turso Cloud to sync the local Turso databases and
  assumes that you have an account." A sync server is built into the `tursodb` CLI:
  `tursodb ./server.db --sync-server 0.0.0.0:8080`; it "implements the same sync protocol as
  Turso Cloud"; "No auth token is needed for the local server"; the page frames it to "develop
  and test sync workflows entirely on your machine" — production use **not stated** on
  docs.turso.tech/sync/local-sync-server.md. Launch blog (turso.tech/blog/introducing-databases-
  anywhere-with-turso-sync, dated 2025-10-08): the remote is the source of truth; peer-to-peer
  sync is not supported. The Supabase post mentions "BYOC" without details.
- **Our schema:** "SQLite file format is fully supported"; "You should be able to access a
  database created with SQLite in Turso"; the query language is "partially supported"
  (COMPAT.md). Notable gaps: `WITHOUT ROWID` is experimental and "Effectively insert-only";
  `INSTEAD OF` triggers no; plain `VACUUM` experimental; text must be valid UTF-8. JustWrite's
  `server/src` has no `WITHOUT ROWID`, virtual tables or triggers (grep, code 2026-10-08).
  Our reading: sync needs Turso's own engine (`@tursodatabase/sync`), so the desktop would
  replace better-sqlite3; the README samples are async (`await insert.run(...)`,
  `db.transactionAsync`) where better-sqlite3 is synchronous.
- **Node/Electron:** `@tursodatabase/sync` 0.8.2 (2026-10-06, MIT): "This package is for
  syncing local Turso databases to the Turso Cloud and back"; native Node on Linux x86/arm64,
  macOS, Windows. Electron: not named.
- **Browser/WASM:** `@tursodatabase/sync-wasm` 0.8.2 (2026-10-06, MIT). The repo's
  `examples/javascript/sync-wasm-vite` README: "bidirectional synchronization between a local
  file and a remote Turso Cloud database"; needs `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` because it "relies on SharedArrayBuffer".
- **Mobile:** `@tursodatabase/sync-react-native` 0.8.2 (first published 2026-01-28, MIT):
  "React Native bindings for Turso embedded replicas - sync your local SQLite database with
  Turso cloud" (iOS pods, Android minSdk 21). **Capacitor: not stated** anywhere read. Our
  reading: a Capacitor webview would need the WASM package and its COOP/COEP headers — not
  verified that a Capacitor webview can serve them.
- **Licence:** MIT (repo LICENSE.md, all npm packages). Turso Cloud is a paid service; BYOK
  encryption "is available on Pro" and Enterprise (docs.turso.tech/cloud/encryption.md).
- **Latest:** v0.8.2, 2026-10-06 (GitHub "Latest" + npm); v0.8.3-pre.1 on 2026-10-08.
- **Maturity:** repo pushed 2026-10-08. FAQ: "we have not yet reached 1.0", "some features
  are explicitly marked experimental", and "Turso powers production applications today at
  multiple organizations". Sync: the launch blog calls it "the Beta launch of the sync
  feature"; the libSQL README says "Turso is currently in beta"; the docs' sync pages carry no
  label. Partial sync's option is named `partialSyncExperimental`.
- **Ownership:** "Turso is joining Supabase" (supabase.com/blog/supabase-is-acquiring-turso,
  2026-10-02): "For existing users, nothing changes." Turso's own post
  (turso.tech/blog/turso-is-joining-supabase, 2026-10-02): "Turso Database remains open source
  and actively developed." Neither says anything about Sync or the sync server.
- **E2EE:** not stated. Sync has `remoteEncryption` "if cloud database were encrypted by
  default" (types.ts). Cloud BYOK: "Turso never sees or stores your encryption keys", but
  "BYOK Encryption happens at the server level" and covers "The database file and Write-Ahead
  Log (WAL) file on disk and on S3"; it "works seamlessly with both remote queries and sync."

## 2. PowerSync

- **What it is:** "keeps a client-side SQLite database in sync with your backend database ...
  Supports Postgres, MongoDB, MySQL, and SQL Server" (npm READMEs).
- **Backends (source DB):** Postgres, MongoDB, Azure DocumentDB (alpha), MySQL (beta), SQL
  Server (beta), Convex (experimental). **SQLite is not a source database.** —
  docs.powersync.com/configuration/source-db/setup.md
- **What runs server-side:** the PowerSync Service (their cloud, or self-hosted from a Docker
  image) plus "A bucket storage database (MongoDB or Postgres)" separate from the source DB,
  client auth, and a sync config. — …/configuration/powersync-service/self-hosted-instances.md
- **How writes go up:** local writes apply at once and go into an upload queue (`ps_crud`, "a
  blocking FIFO queue"); the SDK calls your `uploadData()`, which sends them to **your own
  backend API**; it writes to the source DB. — …/architecture/client-architecture.md
- **Merge:** "In the simplest backend implementation, the behavior of the overall system will
  be per-field Last-Write-Wins"; deletes win over later updates; "It is up to your app backend
  to implement these operations and associated conflict handling." CRDTs (Yjs) can be stored
  and synced. — …/handling-writes/handling-update-conflicts.md
- **Our schema:** by default client tables are "SQLite views based on the schemaless JSON data
  being synced" (`ps_data__<table>`). "Raw tables" let you use native SQLite tables, but "you
  are responsible for creating the tables", must write the `powersync_crud` triggers yourself,
  and drop/recreate them on `ALTER`. — …/client-sdks/advanced/raw-tables.md
- **Node/Electron:** `@powersync/node` 1.1.1 (2026-10-01, Apache-2.0), installed with
  `better-sqlite3` (or `node:sqlite`); "non-EOL Node.js versions". Electron: listed under the
  Capacitor SDK as Electron 28+ "TO BE VERIFIED", via WASQLite. — npm README;
  …/resources/supported-platforms.md
- **Capacitor:** `@powersync/capacitor` 0.9.3 (2026-10-01, Apache-2.0): "This package is
  currently in a beta release"; uses `@capacitor-community/sqlite` on Android/iOS; Capacitor
  8+, iOS 15, Android SDK 24; "Encryption for native mobile platforms is not yet supported."
  Web: `@powersync/web` 2.4.2 (2026-10-01).
- **Licence:** client SDKs Apache-2.0 (npm, powersync-js repo). **PowerSync Service:
  FSL-1.1-ALv2** (Functional Source License): any use except a "Competing Use" (a commercial
  product that substitutes for it); converts to Apache-2.0 "on the second anniversary" of each
  release (repo LICENSE). The self-hosting page names an "Open Edition" and an "Enterprise
  Self-Hosted Edition with dedicated support plans, advanced functionality and custom pricing";
  the Dashboard "is currently not available when self-hosting".
- **Latest:** service v1.26.1 (2026-09-11); v1.27.0 pre-release 2026-10-06. Service repo
  pushed 2026-10-08; JS SDK repo pushed 2026-10-05.
- **E2EE:** "not a built-in feature" — the app encrypts in memory or keeps decrypted data in
  local-only raw tables; TLS in transit; at rest per SDK. — …/client-sdks/advanced/data-encryption.md

## 3. ElectricSQL

- **Renamed site / direction:** electric-sql.com 301-redirects to electric.ax. Homepage
  tagline: "The agent platform built on sync"; a banner says "Electric is joining Neon at
  Databricks" (no announcement page found). The sync product: "Sync from Postgres in real time".
- **Shape:** "Electric is a read-path sync engine for Postgres" (README). Writes guide: Electric
  "does not do write-path sync"; four patterns, all with **your own API**: online writes,
  optimistic state, shared persistent optimistic state, and "through-the-database sync" (PGlite
  locally, triggers log writes to a `changes` table, your utility sends them). —
  electric.ax/docs/guides/writes
- **Merge:** none for writes (yours). Patterns 3–4 rebase local optimistic state onto synced
  updates; the example's rollback "clearing all local state when any write is rejected".
- **Server:** Elixir service, Docker image `electricsql/electric`, needs "any standard Postgres,
  version 14 and above" with logical replication, connected directly (no pooler); or Electric
  Cloud ("usage-based pricing"). — electric.ax/docs/guides/deployment
- **Our schema:** the Postgres schema is yours; the client gets "Shapes". The TS client
  "materialises the log stream into a shape object"; local persistence and SQLite: not
  stated on electric.ax/docs/api/clients/typescript.
- **Node/Electron:** client is for "the web browser and other JavaScript environments"; Node
  and Electron not named. **Capacitor:** not mentioned. React Native: covered.
- **Licence:** Apache-2.0 (repo, footer "Open protocol · Apache 2.0 · just HTTP").
- **Latest:** `@core/sync-service@1.8.1` (2026-09-07); `@electric-sql/client` 1.5.28
  (2026-09-09). 1.0 released 2025-03-17 (README badge link). Repo pushed 2026-10-06.
- **E2EE:** not stated.

## 4. Rocicorp Zero and Replicache

**Zero**
- "Zero makes web apps feel instant by syncing the data your UI needs into a local, normalized
  client datastore." "As of March 2026, Zero is generally available and fully-supported." —
  zero.rocicorp.dev/docs/introduction, /docs/status
- **Offline writes: no.** "Zero does not support offline writes"; while disconnected, reads
  work and writes "return an offline error". — zero.rocicorp.dev/docs/offline
- **Server:** "To self-host Zero, you will need to deploy zero-cache, a Postgres database, your
  frontend, and your API server"; Postgres with logical replication, direct connection.
  Non-Postgres: not stated. — /docs/self-host
- **Merge:** mutators run first on the client, then your server's push endpoint runs the server
  mutator in a DB transaction ("Server authority"). Client storage: "Zero is backed by
  IndexedDB" (edge cases: "IndexedDB or SQLite"). — /docs/mutators
- **Clients:** React, SolidJS, React Native; community Vue binding `zero-vue` (danielroe). —
  /docs/community. Node/Electron/Capacitor: not stated.
- **Licence:** "the Zero client and server are Apache-2 licensed" (/docs/open-source);
  `@rocicorp/zero` 1.9.0 (2026-08-14) on npm, canary 1.11.0-canary.31; rocicorp/mono pushed
  2026-10-08.
- **E2EE:** not stated.

**Replicache**
- "is now in maintenance mode", "won't add new features", "Existing users should migrate to
  Zero as they are able"; "no longer charge for its use"; "open-sourced the code". —
  replicache.dev
- **Licence conflict across its own pages:** npm `replicache` 15.3.0 (2025-07-02) has
  licence `https://roci.dev/terms.html`, and its packaged LICENSE says the code "is licensed
  according to the Replicache Terms of Service"; those terms (rocicorp.dev/terms.html) say
  "Using Replicache requires acquiring a license key". The source in rocicorp/mono
  `packages/replicache/package.json` (version 15.2.1) says Apache-2.0. The standalone
  rocicorp/replicache repo is archived.
- **How it works:** your server provides push and pull endpoints; "In Replicache, the server is
  authoritative"; on pull the client rewinds and "replays any pending mutations on top";
  pending mutations are persisted. Client store: "in-browser persistent key-value store that is
  git-like" (not SQL). — doc.replicache.dev/concepts/how-it-works

## 5. RxDB

- **What it is:** a JSON-document database for JS with its own replication protocol:
  checkpoint-based pull + push; "The backend server does not have to be an RxDB instance";
  offline: it "can still read and write locally" and continues when online. —
  rxdb.info/replication.html
- **Merge:** client-side conflict handler; "The default conflict handler will always drop the
  fork state and use the master state"; custom `conflictHandler` per collection.
- **Replication plugins** (same page): HTTP, RxServer, GraphQL, WebSocket, CouchDB, WebRTC P2P,
  Firestore, MongoDB, Supabase, Google Drive, Microsoft OneDrive, NATS, Appwrite. Google Drive:
  "This feature is in **beta**", since 17.0.0; "Each RxDB document corresponds to one JSON file"
  in a `docs` folder. — rxdb.info/replication-google-drive.html
- **SQLite storage:** a trial version ships in core — "Use it for evaluation and prototypes
  only!": no indexes, no attachments, at most 500 non-deleted documents, queries in memory. The
  production SQLite storage is **Premium**. Drivers: Capacitor (`@capacitor-community/sqlite`),
  Node `sqlite3` and `node:sqlite`, wa-sqlite, React Native, Expo, Tauri; better-sqlite3 not
  listed. RxDB creates its own tables (`WITHOUT ROWID`, JSON functions). —
  rxdb.info/rx-storage-sqlite.html
- **Capacitor:** recommends the SQLite RxStorage, which "is part of the 👑 Premium Plugins which
  must be purchased"; LocalStorage (free) "while testing and prototyping". —
  rxdb.info/capacitor-database.html. Electron: an "Electron Database" page exists (not read).
- **Our schema:** our reading — no; RxDB stores its own JSON documents in its own tables.
- **Licence/price:** core `rxdb` Apache-2.0, 17.6.0 (2026-10-05). Premium (`rxdb-premium`, no
  licence field on npm): Pro "From $99/ month", Pro Plus "From $239/ month", "billed annually,
  unlimited developers". The Free tier lists "Up to 13 open collections in parallel." —
  rxdb.info/premium/. (JustWrite has 35 tables — our note.)
- **E2EE:** `encryption-crypto-js` free, `encryption-web-crypto` premium; whether data stays
  encrypted on the server: not stated on rxdb.info/encryption.html.
- **Maintenance:** repo pushed 2026-10-08.

## 6. Evolu

- **What it is:** "Evolu is both a TypeScript library and a local-first platform", on SQLite;
  "Works offline-first with sync via self-hosted or cloud relays"; "End-to-end encrypted by
  default." — evolu.dev/docs
- **Merge:** per column by timestamp: Evolu "still resolves the final value of each column
  independently by timestamp" (evolu.dev/docs/schema). "Synced tables retain deleted data".
- **Server:** Evolu Relay — "the `@evolu/relay` npm package and the `evoluhq/relay` Docker
  image"; "We provide a free `free.evoluhq.com` relay for testing, but no hosting"; "Testing
  relay data may be deleted". — evolu.dev/docs/relay. `@evolu/relay` 4.2.3 (2026-10-06, MIT).
- **E2EE:** the relay sees OwnerId, timestamps, padded encrypted blobs and IP addresses;
  "XChaCha20-Poly1305 under a 256-bit symmetric key"; the owner secret is shown as a 24-word
  mnemonic. — evolu.dev/docs/privacy
- **Our schema: no.** Tables are defined in Evolu's TypeScript schema; "Evolu automatically
  adds the system columns `createdAt`, `updatedAt`, `isDeleted`, and `ownerId` to every
  table"; every table needs an Evolu `Id`. Using plain-SQL tables: not stated.
- **Platforms:** npm packages `@evolu/web` 3.5.0 (OPFS SQLite in workers), `@evolu/nodejs`
  4.2.0 ("Node.js 24.20+"), `@evolu/react-native` 16.1.1 ("React Native and Expo"),
  `@evolu/vue` 2.1.0, `@evolu/svelte`, `@evolu/react`. Repo has `examples/react-electron`.
  **Capacitor: no match in the repo** (code search). The docs state the requirement
  "TypeScript 7 or newer with `exactOptionalPropertyTypes` enabled" (evolu.dev/docs/local-first).
- **Licence:** MIT (repo, all npm packages).
- **Maturity:** `@evolu/common` 8.19.0 (2026-10-06); repo pushed 2026-10-08. Docs: data
  purging "currently throw[s]"; "Built-in account management is still being developed"; "Evolu
  8 uses a different local storage format and does not migrate existing Evolu 7 databases
  yet." Blobs/files: not stated.

## 7. Jazz, Triplit, InstantDB

**Jazz (jazz.tools).** Now "Jazz 2.0 alpha with an entirely new API" ("Classic Jazz" lives at
classic.jazz.tools) — repo README. "A local-first relational database for the browser, React
Native and your backend" (repo); offline writes "remain queued while disconnected"; same-field
conflicts resolve by "last-writer-wins (LWW) with deterministic hybrid logical clock
ordering"; "Core owns the authoritative database"; browser storage in IndexedDB
(jazz.tools/docs/concepts/how-sync-works). Self-host: "The single-tenant Jazz server will
always be open source and is easy to self-host" (jazz.tools); Jazz Cloud is metered (e.g.
$0.039/hour for a 2 GB instance). Platforms: React, Vue, Svelte, Solid, plain TypeScript,
server TypeScript; the Expo scaffold says "persistent and device-supported memory runtimes are
not available in this alpha". Electron, Capacitor and E2EE: not stated. Its own data model
(Jazz schema), not our SQLite. MIT. npm `jazz-tools` latest tag 0.20.19 (2026-07-03, Classic);
alpha 2.0.0-alpha.59 (2026-10-04).

**Triplit.** "A full-stack, syncing database" with property-level conflict resolution, CRDTs,
offline mode, pluggable storage incl. SQLite (repo README). **Licence AGPL-3.0** (repo LICENSE;
`@triplit/client` "AGPL-3.0-only"). Last npm release `@triplit/client` 1.0.50 / `@triplit/
server` 1.1.8 on 2025-07-31; last commit on main 2025-09-11. **www.triplit.dev does not
resolve** — open issue #406 (2026-02-27, NXDOMAIN); a commenter asks "is this project still
being maintained? No commits for 6 months." Supabase's post "Triplit joins Supabase"
(supabase.com/blog/triplit-joins-supabase, 2025-10-08) brings the co-founder to Supabase and
says Triplit is "already largely open-source"; it does not say development continues. Our
reading: effectively unmaintained.

**InstantDB.** "Instant is sunsetting. Services will continue until August 31st, 2027"
(instantdb.com, site-wide banner). The essay "instant_team_joins_openai": "the Instant team is
joining OpenAI", new Instant Cloud signups closed, all cloud apps shut down 2027-08-31, backups
until 2028-08-31, "All of Instant is open source" with a self-hosting guide. Self-hosting: VPS
"~$30/mo", AWS "at least $600/mo" (instantdb.com/docs/self-hosting). Data model: "All data in
Instant is stored as triples"; server on Postgres; offline: "Mutations are saved to a persistent
outbox" that "flushes in order and the server reconciles" (instantdb.com/about). Apache-2.0;
`@instantdb/core` 1.0.67 (2026-08-31). Not our SQLite schema. Capacitor/Electron/E2EE: not
stated.

## 8. PouchDB / CouchDB

- **PouchDB:** "Apache PouchDB is currently undergoing Incubation at the Apache Software
  Foundation" (repo README). Latest release 9.0.0 on 2024-06-21 (GitHub + npm); commits continue
  (last 2026-08-25; 2026-07-27 before it). Apache-2.0. JSON documents with revision trees; on
  conflict CouchDB picks "an arbitrary winner based on a deterministic algorithm", losing
  revisions are kept, "conflict resolution is entirely under your control"
  (pouchdb.com/guides/conflicts.html). Storage: IndexedDB in the browser, LevelDB in Node;
  SQLite via the separate `pouchdb-adapter-cordova-sqlite` (Cordova) or the WebSQL adapter on
  `node-websql`; "We recommend avoiding Cordova SQLite unless you are hitting the 50MB storage
  limit in iOS." Capacitor: not mentioned on pouchdb.com/adapters.html. Not our SQLite schema.
  E2EE: not stated.
- **CouchDB:** 3.5.2 released 2026-05-19 (couchdb.apache.org); 3.5.3-RC2 tagged; repo pushed
  2026-10-08. Apache-2.0. Self-hosted server ("multi-primary syncing database").

## 9. sqlite-sync (sqliteai)

- Latest release **1.2.0, 2026-09-28** (GitHub release and npm `@sqliteai/sqlite-sync`; npm
  licence field "SEE LICENSE IN LICENSE.md"; GitHub detects "Other"). Prior: 1.1.4
  (2026-09-21), 1.1.3 (2026-09-11). `@sqliteai/sqlite-wasm` bundles sync 1.2.0 (2026-09-28,
  npm licence field Apache-2.0 for the wasm package).

---

## Summary table

| Option | Self-hostable | Our SQLite schema | Node | Capacitor | Licence | Maturity |
|---|---|---|---|---|---|---|
| libSQL embedded replicas | Turso Cloud named; `sqld` self-hostable, replica-to-sqld not stated | yes (SQLite fork file); libSQL client replaces better-sqlite3 | yes (`@libsql/client`) | not stated | MIT | maintained; new work goes to Turso |
| Turso Sync | `tursodb --sync-server` exists (MIT), docs frame it as dev/test | mostly (SQLite file format; SQL partial); Turso engine replaces better-sqlite3 | yes (`@tursodatabase/sync`) | not stated (WASM needs COOP/COEP; RN package exists) | MIT | pre-1.0; sync launched as beta; Supabase acquiring (2026-10-02) |
| PowerSync | yes (Service FSL-1.1-ALv2 + Mongo/Postgres bucket store + Postgres/Mongo/MySQL/MSSQL source + our API) | via raw tables + our triggers; default is JSON views | yes (better-sqlite3) | yes, beta | SDKs Apache-2.0; Service FSL-1.1-ALv2 | active; Capacitor beta |
| ElectricSQL | yes (Docker + Postgres 14+) | no (Postgres; read path only) | not named | not mentioned | Apache-2.0 | 1.x; company "joining Neon at Databricks" |
| Zero | yes (zero-cache + Postgres + our API) | no (Postgres; IndexedDB client) | not stated | not stated | Apache-2.0 | GA since March 2026; **no offline writes** |
| Replicache | our push/pull server | no (key-value store) | not stated | not stated | conflicting: ToS + licence key (npm) vs Apache-2.0 (mono) | maintenance mode |
| RxDB | yes (any backend; CouchDB, HTTP, WebRTC, …) | no (JSON documents) | yes | yes, but SQLite storage is Premium | core Apache-2.0; Premium from $99/mo | active; free tier 13 collections |
| Evolu | yes (relay npm/Docker, MIT) | no (Evolu schema + system columns) | yes (Node 24.20+) | not found | MIT | active; v8 format change, features unfinished; TS 7 required |
| Jazz 2 | yes (open-source server) | no | server TS yes | not stated | MIT | 2.0 alpha |
| Triplit | yes (server package) | no | yes | not stated | AGPL-3.0 | site down, no commits since 2025-09 |
| InstantDB | yes (guide; VPS ~$30/mo) | no (triples on Postgres) | admin SDK | not stated | Apache-2.0 | cloud sunsets 2027-08-31 |
| PouchDB/CouchDB | yes (CouchDB) | no (JSON docs) | yes | not mentioned | Apache-2.0 | PouchDB last release 2024-06; ASF incubating |
| sqlite-sync | SQLite Cloud / Postgres / Supabase (known) | needs `cloudsync_init` per table (known) | not named (known) | not named (known) | Elastic-2.0 (known) | 1.2.0, 2026-09-28 |

## Could not verify

- Whether Turso's `tursodb --sync-server` is meant or supported for production self-hosting
  (the page names dev/test only), and whether Turso Sync is still beta today (docs carry no
  label; the beta word is from the 2025-10-08 blog and the libSQL README).
- Turso conflict granularity (row vs statement) — not stated.
- Whether `@tursodatabase/sync-wasm` runs in a Capacitor webview (COOP/COEP there) — not tested,
  not stated.
- Whether libSQL embedded replicas sync against a self-hosted `sqld`.
- What Supabase's acquisition means for Turso Sync or the open-source sync server.
- Electric's "joining Neon at Databricks" — banner only; no announcement page found.
- Replicache's actual licence (its pages contradict each other).
- Zero, Electric, Jazz, InstantDB, Triplit on Capacitor or Electron — not stated on any page read.
- E2EE for Turso Sync, PowerSync (build it yourself), Electric, Zero, RxDB replication, Jazz 2,
  PouchDB — none states built-in E2EE; only Evolu does.
- Evolu blobs/files and schema migration story — not stated.
- RxDB Free tier: the premium page also lists premium storages in the Free column, so what Free
  includes is unclear on that page.
- Not checked at all (named in the design doc, not in this brief): cr-sqlite, Automerge, Yjs,
  Litestream.
