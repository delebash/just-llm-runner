<!-- SPDX-License-Identifier: MIT -->
# Sync research, round 2: would a non-SQLite database serve us better?

Checked 2026-10-08. Web research, plus one read-only count of our own code (section 0.2).
No repo file was changed.

**Rule applied mid-task (from the coordinator, the user's ruling):** only open-source solutions,
or one we build. Nothing paid or proprietary: no paid tiers, no commercial editions, no "free
but closed" services. Mixed offerings are judged only on their open-source part. Proprietary or
paid candidates get one line each in section 16.

**Open question for the user (not decided here):** FSL (Functional Source License) was on the
original allowed list. It is source-available, not OSI open source. Under the new rule it is
unclear whether FSL still counts. Affected here: DXOS (section 15). Affected earlier: PowerSync's
self-hosted service.

How facts are cited: each section ends with numbered sources [n]. Every source line carries
"checked 2026-10-08". "Not found" means I looked and found nothing. It does not mean "no".

---

## 0. Our side

### 0.1 Setup (from the brief, not re-verified)
- Electron desktop app plus a Node 24 server on better-sqlite3. The code is synchronous,
  transactions included.
- JustWrite has 35 tables, most keyed `(project_id, id)`, with link tables and foreign keys.
- The phone app is Quasar on Capacitor, running in the system webview. There is no Node on the
  phone.
- Sync must be offline-first, with every device holding the whole library. It must work over
  three transports:
  - a file carried by hand;
  - a shared cloud folder, one change file per device;
  - our own self-hosted server.
- Rich text merges through Yjs.

### 0.2 Our data layer today (code, read-only grep, 2026-10-08)

The repos were at justwrite-app `8db75b8` and JustVoice `36814c9`. These are pattern greps, so the
counts are approximate.

- **The kit's handle is synchronous, and every app write goes through it.**
  - File: `just-llm-runner/server/src/platform/sql.js`, function `openDatabase()` → `wrap(db)`.
  - Writes: `insert(table, obj)`, `update(table, obj, where)`, `delete(table, where)`.
  - Transactions: `tx(fn)`, which is `db.transaction(fn)()`, commented "Never async".
  - Raw SQL: `all/one/value/run/exec`.
- **JustWrite server** (`server/src`):
  - Schema:
    - `grep -o -i "CREATE TABLE"` → 35
    - `grep -o -i -E "REFERENCES [a-z_]+"` → 30
    - `grep -o -i "ON DELETE CASCADE"` → 28
    - `grep -o -i -w JOIN` → 36
    - SQL statement keywords (`SELECT|INSERT INTO|UPDATE x SET|DELETE FROM`) → 25
  - `getDb()` → 46 uses in 12 files.
  - Handle calls, counted with `grep -rhoE "\b(h|db|handle|session)\.(get|insert|tx|…)\("`:
    - reads and writes: `.get(` 26, `.insert(` 18, `.update(` 12, `.all(` 9, `.delete(` 8, `.one(` 2, `.value(` 1
    - transactions: `.tx(` 13
    - raw SQL: `.run(` 7, `.exec(` 2
  - Raw `run`/`exec` appear in 6 files: `chat_api.js`, `rag_api.js`, `sessions_api.js`,
    `settings_api.js`, `book_io.js`, `data_admin.js`.
  - The DB comment says: "the FK cascade is what deletes a book's rows"
    (`server/src/database/session.js`).
- **JustVoice server**:
  - Schema (`src/database`): 23 `CREATE TABLE`, 30 `REFERENCES`.
  - Transactions: `.tx(` 55 times in `src`.
  - 32 files touch `getDb(` / `openDatabase(` / `.tx(`.

---

## 1. CouchDB (server) + PouchDB (client)

- **What it is:** a JSON document store per database, with a revision tree per document.
  - PouchDB is the JavaScript client.
  - CouchDB is the Erlang server.
  - Both speak the CouchDB replication protocol ("multi-primary sync") [1][2].
- **Where it runs:**
  - Browser/webview: the IndexedDB adapter is the default [3].
  - Node: LevelDB is the default; there is also a memory adapter and a SQLite adapter through `pouchdb-adapter-node-websql` [3].
  - Cordova SQLite is documented. **Capacitor is not named** [3].
  - The repo gained an unreleased `pouchdb-adapter-nodesqlite` (built on `@neighbourhoodie/websql`)
    on 2026-04-08. A warning when the leveldb adapter is used was added on 2026-04-10 [4][5].
- **Sync model:**
  - Replication can run peer to peer between any two PouchDB/CouchDB endpoints. The source or
    target can be "a PouchDB instance, a CouchDB URL, or the name of a local PouchDB database",
    and `sync()` replicates in both directions [6].
  - Own transport: replication speaks CouchDB's HTTP protocol. For files there are third-party
    dump/load plugins: `pouchdb-load` 2.0.0 (2025-12-11) and `pouchdb-replication-stream` 1.2.9
    (2016-09-12) [7].
  - A shared cloud folder with one change file per device is not supported out of the box: not found.
- **Merge rule:** per whole document, not per field.
  - CouchDB "picks one arbitrary revision as the 'winner', using a deterministic algorithm".
  - The losing revisions are kept under `_conflicts` until the app merges them.
  - "Actually performing the merge is an application-specific function" [8].
- **API:** asynchronous (callbacks/promises) [6]. No SQL and no joins.
- **Licence:**
  - Client: PouchDB is Apache-2.0 [9].
  - Server: CouchDB is Apache-2.0 [2]. `pouchdb-server` 4.2.0 is Apache-2.0, last release 2019-09-25 [7].
  - No commercial restrictions.
- **Release and maintenance:**
  - PouchDB 9.0.0 (2024-06-21) is still the latest npm release [9].
  - Code commits continue into 2026: replication fixes on 2026-03-11, the adapter above, and a
    `__proto__` fix on 2026-05-16 [4].
  - The project is now "Apache PouchDB (incubating)" at the ASF [10].
  - CouchDB 3.5.2 was released 2026-05-19 [2]. A 3.5.3-RC2 tag is dated 2026-10-07 [11].
- **Fit:** a mature protocol, but it brings a document model with whole-document conflicts, an
  async API and no FKs or joins. The client has had no release in 28 months. It does not fit our
  relational, synchronous server.

Sources:
1. https://couchdb.apache.org/ — checked 2026-10-08
2. https://couchdb.apache.org/ (3.5.2, 2026-05-19, Apache-2.0) — checked 2026-10-08
3. https://pouchdb.com/adapters.html — checked 2026-10-08
4. `gh api repos/pouchdb/pouchdb/commits?path=packages&since=2025-06-01` — checked 2026-10-08
5. https://github.com/pouchdb/pouchdb/blob/master/packages/node_modules/pouchdb-adapter-nodesqlite/src/index.js — checked 2026-10-08
6. https://pouchdb.com/api.html — checked 2026-10-08
7. https://registry.npmjs.org/pouchdb-load, …/pouchdb-replication-stream, …/pouchdb-server — checked 2026-10-08
8. https://docs.couchdb.org/en/stable/replication/conflicts.html — checked 2026-10-08
9. https://registry.npmjs.org/pouchdb (9.0.0 @ 2024-06-21, Apache-2.0); `gh api repos/pouchdb/pouchdb` — checked 2026-10-08
10. https://github.com/pouchdb/pouchdb/blob/master/DISCLAIMER — checked 2026-10-08
11. `gh api repos/apache/couchdb/commits/3.5.3-RC2` — checked 2026-10-08

---

## 2. RxDB, free (open-source) parts only

- **What it is:** a JSON document database. Each collection has a JSON-Schema.
  - "There are no joins in RxDB"; references between documents are resolved with `populate()`,
    which returns a Promise [1].
  - Reads and writes are awaited (`await collection.insert(...)`) [1].
- **The free version caps open collections at 13.**
  - The source says `export const NON_PREMIUM_COLLECTION_LIMIT = 13;`, and error COL23 reads: "In
    the open-source version of RxDB, the amount of collections that can exist in parallel is
    limited to 13" [2][3].
  - The same source comments: "Yes you are allowed to fork the repo and just overwrite this
    function" [2].
  - JustWrite's 35 tables would be 35 collections.
- **Free storages and where they run** [4]:
  - Free:
    - Memory: everywhere, not persistent.
    - LocalStorage: browser.
    - Dexie.js: browser, IndexedDB.
    - Remote: a wrapper.
    - MongoDB and FoundationDB: server side.
    - DenoKV.
    - Electron IpcRenderer/IpcMain: free by inference, since it carries no crown mark.
  - Premium: IndexedDB, OPFS, Filesystem Node, SQLite (Node, Electron, Capacitor), Worker,
    SharedWorker, Sharding, Memory-Mapped [4][5].
  - The open-source repo ships `getRxStorageSQLiteTrial`, with `TRIAL_SQLITE_DOCUMENT_LIMIT = 500`
    and `TRIAL_SQLITE_OPERATION_LIMIT = 500` and the warning "you should never use the trial
    version in production" [6].
  - So for Node there is **no free persistent file-backed storage** besides MongoDB/FoundationDB.
    In a Capacitor webview, the free choices are Dexie or LocalStorage [4].
- **Replication (free):**
  - The open-source repo contains these plugins: CouchDB, GraphQL, WebSocket, WebRTC (P2P),
    Firestore, MongoDB, NATS, Supabase, Appwrite, Google Drive and Microsoft OneDrive [7]. None is
    on the premium list [5].
  - Own transport: yes. The protocol is checkpoint-based: a pull handler returns docs written after
    a checkpoint; a push handler returns the conflicting master states; "build a replication with
    any infrastructure" [8].
  - Through files:
    - No file-carried replication plugin was found.
    - The Google Drive plugin stores "one JSON file" per document in a `docs` folder, with a
      `transaction` lock file. It is beta: "may have breaking changes without a major RxDB version
      release" [9].
    - A custom pull/push over files is possible with the protocol above [8].
- **Merge rule:**
  - Default: "The default conflict handler will always drop the fork state and use the master
    state" (per document) [8].
  - The CRDT plugin (open-source repo [7]) stores operations per document and replays them
    deterministically. After it is enabled, "it is no longer allowed to do non-CRDT writes" [10].
- **Licence:**
  - Core and these plugins: Apache-2.0 [11].
  - Premium is paid ("from $99/month") [5] and is out under the rule.
- **Release:** 17.6.0, 2026-10-05. Very active [11].
- **Fit:** no. It means a document model, an async API, no free persistent Node storage, and a
  13-collection cap unless we fork it.

Sources:
1. https://rxdb.info/population.html — checked 2026-10-08
2. https://github.com/pubkey/rxdb/blob/master/src/plugins/utils/utils-premium.ts — checked 2026-10-08
3. https://github.com/pubkey/rxdb/blob/master/src/plugins/dev-mode/error-messages.ts (COL23) — checked 2026-10-08
4. https://rxdb.info/rx-storage.html — checked 2026-10-08
5. https://rxdb.info/premium/ — checked 2026-10-08
6. https://github.com/pubkey/rxdb/tree/master/src/plugins/storage-sqlite (index.ts, sqlite-storage-instance.ts) — checked 2026-10-08
7. `gh api repos/pubkey/rxdb/contents/src/plugins` — checked 2026-10-08
8. https://rxdb.info/replication.html — checked 2026-10-08
9. https://rxdb.info/replication-google-drive.html — checked 2026-10-08
10. https://rxdb.info/crdt.html — checked 2026-10-08
11. https://registry.npmjs.org/rxdb (17.6.0 @ 2026-10-05, Apache-2.0); `gh api repos/pubkey/rxdb` — checked 2026-10-08

---

## 3. PGlite (Postgres in WASM)

- **What it is:** "Embeddable Postgres" that runs in JavaScript, a relational database. It has "a
  single exclusive connection to the database" [1][5].
- **Where it runs:**
  - Node, Bun, Deno and the browser [1].
  - Persistence:
    - Node FS.
    - IndexedDB, which is the recommended choice in the browser.
    - OPFS AHP, which needs a Web Worker and does not work in Safari: "Safari appears to have a
      limit of 252 open sync access handles" [2].
  - Capacitor and webviews are not named [1][2].
- **API:** every query method (`query`, `sql`, `exec`, `execProtocol*`, `describeQuery`) returns a
  Promise. There is no synchronous query method [3].
- **Sync model:**
  - `@electric-sql/pglite-sync` is read-path only, from an Electric server in front of Postgres:
    "We don't yet support local writes being synced out, or conflict resolution". It is alpha [4].
  - No peer-to-peer or file sync was found.
- **Merge rule:** none (see above) [4].
- **Licence:** Apache-2.0 for the client and the sync plugin [5]. The Electric server was checked
  in round 1.
- **Release:** `@electric-sql/pglite` 0.5.8 and `pglite-sync` 0.6.9, both 2026-08-26. The repo is
  active [5].
- **Fit:** no. Its sync can't write back, so we would still build our own change log. On top of
  that we would port SQLite SQL to Postgres and make every call async.

Sources:
1. https://pglite.dev/docs/ — checked 2026-10-08
2. https://pglite.dev/docs/filesystems — checked 2026-10-08
3. https://pglite.dev/docs/api — checked 2026-10-08
4. https://pglite.dev/docs/sync — checked 2026-10-08
5. https://registry.npmjs.org/@electric-sql/pglite, …/@electric-sql/pglite-sync; `gh api repos/electric-sql/pglite` — checked 2026-10-08

---

## 4. Automerge + automerge-repo as the database

- **What it is:** CRDT JSON documents.
  - A `Repo` "is a little like a database"; it holds `DocHandle`s [1].
  - No query or index across documents was found in its docs [1][2].
  - Guidance: a document is "best suited to being a unit of collaboration between two people or a
    small group". "Having hundreds of docs should be fine", but for very granular documents "the
    overhead of syncing many thousands of documents was high". Documents keep their entire history [2].
- **Where it runs:**
  - Storage adapters: IndexedDB (browser) and NodeFS. NodeFS "is safe for multiple processes to use
    the same data directory" [3].
  - Custom storage on "any key/value store which supports range queries" [3].
  - Capacitor is not named.
- **Sync model:**
  - Point-to-point message passing between Repos.
  - Adapters: WebSocket client/server, MessageChannel, BroadcastChannel. A Repo "can have many (or
    zero) NetworkAdapters" [4].
  - Self-hosted server: `@automerge/automerge-repo-sync-server` 0.3.0, MIT, 2026-09-30 [5].
  - Files: `save()` exports a document as a compressed `Uint8Array`, and `merge(local, remote)`
    merges another copy [6][7]. Carrying a file by hand or using one file per device in a cloud
    folder therefore works at the library level.
- **Merge rule:**
  - Concurrent writes to the same map key: one value is chosen ("randomly choose one value"), and
    all nodes agree.
  - Delete versus update: the update wins.
  - Counters add up.
  - Text merges like lists [8].
- **Licence:** MIT for the core, the repo and the sync server [5][9].
- **Release:**
  - Core `@automerge/automerge` 3.5.0, 2026-09-16 [9].
  - `automerge-repo`: the npm `latest` dist-tag points at **2.6.0-alpha.3** (2026-08-07). The last
    stable is 2.5.6 (2026-05-18). There is also a 3.0.0-experimental.1 (2026-10-05) [5][10].
  - Active.
- **Fit:** no as the database. It has no relational model, no queries, and history that grows
  forever. As a merge engine it overlaps with Yjs, which we already chose for text.

Sources:
1. https://automerge.org/docs/reference/repositories/ — checked 2026-10-08
2. https://automerge.org/docs/cookbook/modeling-data/ — checked 2026-10-08
3. https://automerge.org/docs/reference/repositories/storage/ — checked 2026-10-08
4. https://automerge.org/docs/reference/repositories/networking/ — checked 2026-10-08
5. https://registry.npmjs.org/@automerge/automerge-repo, …/automerge-repo-sync-server — checked 2026-10-08
6. https://automerge.org/automerge/api-docs/js/functions/save.html — checked 2026-10-08
7. https://automerge.org/automerge/api-docs/js/functions/merge.html — checked 2026-10-08
8. https://automerge.org/docs/reference/under-the-hood/merge-rules/ — checked 2026-10-08
9. https://registry.npmjs.org/@automerge/automerge (3.5.0 @ 2026-09-16, MIT) — checked 2026-10-08
10. `gh api repos/automerge/automerge-repo/releases` — checked 2026-10-08

---

## 5. Loro as the database

- **What it is:** a CRDT library, not a database. Its containers are Fugue text, rich text, movable
  tree, movable list, a "Last-Write-Wins Map" and counters. It has time travel and shallow
  snapshots [1].
- **Where it runs:** Rust, JS (via WASM) and Swift [1]. There are also React Native, Python and FFI
  repos [2]. Node and webview are not named separately. Capacitor is not named.
- **Sync model:** P2P by bytes. `doc.export({mode:"update"})` gives bytes, and `doc.import(bytes)`
  takes them, so any transport works, files included [1].
  - `loro-protocol` (MIT) is "a small, transport-agnostic syncing protocol" with a WebSocket client
    and "minimal servers for local testing or self-hosting" [3].
- **Merge rule:** LWW for map keys; CRDT merge for lists, text and trees [1].
- **Licence:** MIT for the library and the protocol [1][3].
- **Release:** `loro-crdt` 1.16.4, 2026-09-30. Active [4].
- **Fit:** no as the database. It has no tables, queries or persistence. It is an alternative to
  Yjs, not to SQLite.

Sources:
1. https://github.com/loro-dev/loro (README) — checked 2026-10-08
2. `gh api orgs/loro-dev/repos` — checked 2026-10-08
3. https://github.com/loro-dev/protocol (README) — checked 2026-10-08
4. https://registry.npmjs.org/loro-crdt — checked 2026-10-08

---

## 6. TinyBase (sweep find; the closest to our planned design)

- **What it is:** "an in-memory data store" of tables, rows and cells plus values [1].
  - Data is lost on reload without a persister [1].
  - The examples write and read straight after one another with no `await` (`store.setCell(...)`,
    `store.getCell(...)`) [2].
  - Queries use TinyQL, "a typed, programmatic" JS API, not SQL. Its joins use "left join"
    semantics by Row Id [3].
  - Foreign keys, referential integrity and transactions are not discussed there [3].
- **MergeableStore is our planned merge, built in:**
  - Every change carries a hybrid logical clock timestamp and a hash.
  - Conflicts resolve "last write wins".
  - `merge(other)` combines two stores [4].
- **Where it runs:**
  - Browser and Node 16+ [2].
  - SQLite persisters: better-sqlite3, `node:sqlite`, sqlite-wasm, **capacitor-sqlite**, expo-sqlite,
    LibSQL and PowerSync [5].
- **The catch for us: MergeableStore persistence.**
  - A MergeableStore can be persisted by "database-oriented Persister types … *only* in the
    'JSON-serialization' mode", "partly because this extra metadata cannot be easily stored in a
    plain SQLite database" [4].
  - JSON mode saves "the whole Store as a serialized value in a single row" [5].
  - So our tables could not stay real SQLite tables.
  - Even tabular mode (non-mergeable) maps each row to one row-id column that must be "a primary
    or unique key" [5]. That is a single key, not our `(project_id, id)`.
- **Sync model:**
  - Synchronizers: WebSocket (with an optional persisting `WsServer`), BroadcastChannel, Local, and
    `createCustomSynchronizer` "if you have a transmission medium" [6].
  - Files: `getMergeableContent()` plus `merge()` on import, at the library level [4].
- **Merge rule:** LWW per change using HLC [4].
- **Licence:** MIT, client and server [7].
- **Release:** 10.0.1, 2026-09-24. 10.1.0-beta.0 is out. The repo was pushed 2026-10-08 [7].
- **Fit:** the merge design matches our plan almost exactly, but adopting it means replacing SQLite
  as our data model:
  - the whole library in memory;
  - one JSON blob in SQLite;
  - no SQL, FKs or cascades;
  - single-column row ids.
  - Worth reading as a reference, not as a dependency.

Sources:
1. https://tinybase.org/guides/the-basics/architectural-options/ — checked 2026-10-08
2. https://tinybase.org/guides/the-basics/getting-started/ — checked 2026-10-08
3. https://tinybase.org/guides/using-queries/tinyql/ — checked 2026-10-08
4. https://tinybase.org/guides/synchronization/using-a-mergeablestore/ — checked 2026-10-08
5. https://tinybase.org/guides/persistence/database-persistence/ — checked 2026-10-08
6. https://tinybase.org/guides/synchronization/using-a-synchronizer/ — checked 2026-10-08
7. https://registry.npmjs.org/tinybase (10.0.1 @ 2026-09-24, MIT); `gh api repos/tinyplex/tinybase` — checked 2026-10-08

---

## 7. LiveStore (sweep find; SQLite-based event sourcing)

- **What it is:** "a reactive embedded SQLite database powered by real-time sync (via
  event-sourcing)". Change events are persisted and synced, then applied to SQLite by
  "materializers" [1].
  - State derives from events [2].
  - It "assumes app data fits in memory" (an in-memory SQLite per session) [2].
- **Where it runs:**
  - Adapters for Web, Expo, Node (`@livestore/adapter-node`, `storage: {type:'fs'}`), Electron,
    Tauri and Cloudflare [2][3].
  - Capacitor is not named [2].
  - Web storage: "LiveStore currently only support OPFS". It needs OPFS, `navigator.locks` and WASM [4].
- **API:** `store.query(...)` "Synchronously queries the database". Store creation is async [3].
- **Sync model:**
  - The sync backend is "the global authority and determines the total order of events".
  - Clients pull before they push and rebase unpushed local events [5].
  - Providers: Cloudflare, ElectricSQL, S2, or your own. Your own needs "an efficient way to query
    an ordered list of events" [5].
  - Peer-to-peer: not found.
  - A file or cloud-folder transport has no single orderer: not found.
- **Merge rule:** "Merge conflict handling isn't implemented yet". "Compaction isn't implemented
  yet" [6].
- **Licence:** Apache-2.0 [1].
- **Release:** `@livestore/livestore` 0.4.0, 2026-06-02. The dev tag is 0.5.0-dev.0. Active [7].
- **Fit:** no. It has no conflict handling and needs a central total order, which our file and
  cloud-folder transports lack. Every write would have to be re-expressed as an event plus a
  materializer.

Sources:
1. https://github.com/livestorejs/livestore (README, Apache-2.0) — checked 2026-10-08
2. https://docs.livestore.dev/evaluation/design-decisions/ — checked 2026-10-08
3. https://docs.livestore.dev/getting-started/node/ — checked 2026-10-08
4. https://github.com/livestorejs/livestore/blob/main/docs/src/content/docs/platform-adapters/web-adapter.mdx — checked 2026-10-08
5. https://docs.livestore.dev/reference/syncing/ — checked 2026-10-08
6. https://github.com/livestorejs/livestore/blob/main/docs/src/content/docs/building-with-livestore/syncing.mdx ("Merge conflicts", "Compaction") — checked 2026-10-08
7. https://registry.npmjs.org/@livestore/livestore — checked 2026-10-08

---

## 8. Dexie.js (open part only; Dexie Cloud is in section 16)

- **What it is:** "a wrapper library for indexedDB". It is promise-based [1].
- **Where it runs:** "all browsers, Electron for Desktop apps, Capacitor for iOS / Android apps" [1].
  Node: not named in the README [1].
- **Sync model:**
  - The open-source sync addon `dexie-syncable` (an `ISyncProtocol` you implement) was last
    published as 4.0.1-beta.13 on 2023-01-17 [2].
  - Peer-to-peer or file sync: not found.
- **Merge rule:** defined by the sync protocol you write. Not found for the addon.
- **Licence:** Apache-2.0 [2][3].
- **Release:** `dexie` 4.4.6, 2026-09-10. Active [3].
- **Fit:** no. It is IndexedDB only, its open-source sync is stale since 2023, and it has no Node
  storage.

Sources:
1. https://github.com/dexie/Dexie.js (README) — checked 2026-10-08
2. https://registry.npmjs.org/dexie-syncable — checked 2026-10-08
3. https://registry.npmjs.org/dexie (4.4.6 @ 2026-09-10, Apache-2.0) — checked 2026-10-08

---

## 9. GUN

- **What it is:** "a graph synchronization protocol with a lightweight embedded engine". "Graph
  data lets you use key/value, tables, documents" [1].
- **Where it runs:** the browser and Node (`require('gun')`). React Native has an example [1].
  Capacitor: not named.
- **Sync model:** peer-to-peer mesh with relay peers you can self-host [1]. File transport: not found.
- **Merge rule:** state-based. On equal state, a "Lexical sort" decides deterministically.
  Future-dated updates are deferred "until this machine arrives at that state". This is the author's
  2015 description [2].
- **Licence:** "(Zlib OR MIT OR Apache-2.0)" [1][3].
- **Release:** npm 0.2020.1241, 2025-07-01. Commits continue in 2026-09 [3][4].
- **Fit:** no. It is a graph model with no relational queries, has a pre-1.0 versioning scheme,
  and assumes a P2P mesh.

Sources:
1. https://github.com/amark/gun (README, LICENSE.md) — checked 2026-10-08
2. https://gun.eco/distributed/matters.html — checked 2026-10-08
3. https://registry.npmjs.org/gun — checked 2026-10-08
4. `gh api repos/amark/gun/commits` — checked 2026-10-08

---

## 10. OrbitDB

- **What it is:** a "serverless, distributed, peer-to-peer database" on IPFS (Helia) and libp2p
  pubsub. Its database types are events, documents, keyvalue and keyvalue-indexed, all on a
  Merkle-CRDT op log [1].
- **Where it runs:** "Browsers and Node.js" [1]. Capacitor: not named.
- **Sync model:** P2P over libp2p [1]. Own transport or files: not found.
- **Merge rule:** "Last Write Wins": the entry with the greater clock wins, and ties go by clock id
  (`src/oplog/conflict-resolution.js`) [2].
- **Licence:** MIT [1].
- **Release:** `@orbitdb/core` 4.0.0, 2026-05-14. The last commit was the same day [3][4].
- **Fit:** no. It means an IPFS/libp2p stack and a document/key-value model.

Sources:
1. https://github.com/orbitdb/orbitdb (README) — checked 2026-10-08
2. https://github.com/orbitdb/orbitdb/blob/main/src/oplog/conflict-resolution.js — checked 2026-10-08
3. https://registry.npmjs.org/@orbitdb/core — checked 2026-10-08
4. `gh api repos/orbitdb/orbitdb/commits` — checked 2026-10-08

---

## 11. any-sync (Anytype)

- **What it is:** "an open-source protocol" for "peer-to-peer synchronization of encrypted
  communication channels (spaces)". Data is "encrypted Directed Acyclic Graphs". It pairs with
  `any-store`, a document database for Go [1][2].
- **Where it runs:** Go [1][2]. JavaScript, Node or webview: not found.
- **Sync model:** P2P plus sync nodes (`any-sync-node`, MIT, v0.13.4, 2026-10-07) [3].
- **Merge rule:** "Each device independently applies and cryptographically verifies CRDT updates" [1].
- **Licence:**
  - The protocol, the node and any-store: MIT [1][2][3].
  - Anytype's client library `anytype-heart` is "Any Source Available License 1.0" (non-commercial,
    or commercial "in Allowed Networks") [4], so it is out.
- **Release:** `any-sync` tag v0.13.8, 2026-10-07 [5].
- **Fit:** no. It is Go-only, so there is nothing to embed in Node or a webview.

Sources:
1. https://github.com/anyproto/any-sync (README) — checked 2026-10-08
2. `gh api repos/anyproto/any-store` — checked 2026-10-08
3. `gh api repos/anyproto/any-sync-node/releases` — checked 2026-10-08
4. https://github.com/anyproto/anytype-heart/blob/develop/LICENSE.md — checked 2026-10-08
5. `gh api repos/anyproto/any-sync/commits/v0.13.8` — checked 2026-10-08

---

## 12. SurrealDB (embedded / WASM)

- **What it is:** a "document-graph database" [1].
- **Where it runs:**
  - `@surrealdb/wasm` runs SurrealDB "inside the browser — in-memory or persisted to IndexedDB" [2].
  - `@surrealdb/node` is the Node engine [3].
  - Capacitor: not named.
- **Sync model:** none built in. "replication to a central instance runs through your application,
  on the connection and schedule it chooses" [4].
- **Merge rule:** none (the app's job) [4].
- **Licence:**
  - The engine is **BUSL-1.1**: "you may not use the Licensed Work as a Database Service", with
    change date 2030-01-01 [1]. The crates.io `surrealdb` 3.3.2 lists its licence as "non-standard" [5].
  - The JS SDK and the npm engine wrappers are labelled Apache-2.0 [3]. The engine inside them is
    the BSL-licensed core. Their packaging licence is not otherwise stated: not found.
  - BSL is on the excluded list.
- **Release:** server v3.3.0, 2026-09-28; v3.2.5, 2026-10-06. JS SDK 2.1.0 and engines 3.1.0, all
  2026-10-08 [3][6].
- **Fit:** no, on licence (BSL). It also has no sync.

Sources:
1. https://github.com/surrealdb/surrealdb/blob/main/LICENSE — checked 2026-10-08
2. https://github.com/surrealdb/surrealdb.js/tree/main/packages/wasm (README) — checked 2026-10-08
3. https://registry.npmjs.org/surrealdb, …/@surrealdb/wasm, …/@surrealdb/node — checked 2026-10-08
4. https://surrealdb.com/use-cases/embedded-edge.md — checked 2026-10-08
5. https://crates.io/api/v1/crates/surrealdb — checked 2026-10-08
6. `gh api repos/surrealdb/surrealdb/releases` — checked 2026-10-08

---

## 13. Realm (open-source part: Realm JS "community", no sync)

- **Status:**
  - "We announced the deprecation of Atlas Device Sync + Realm SDKs in September 2024" [1].
  - "Device Sync has reached its end-of-life status and be removed on September 30, 2025" [2].
- **What is left:** Realm JS without sync, from the `community` branch or npm tag. It is an object
  database supporting "React Native …, Node.js and Electron" [1]. Webview/Capacitor: not named.
- **Sync model:** none in the open-source part. Atlas Device Sync is gone [2].
- **Licence:** Apache-2.0 [1].
- **Release:**
  - npm `latest` 20.2.0, 2025-08-11; `community` tag 20.1.0, 2024-12-02 [3].
  - The last repo commit is 2025-10-16 [1].
- **Fit:** no. It is deprecated, has no sync, and does not run in a webview.

Sources:
1. https://github.com/realm/realm-js (README); `gh api repos/realm/realm-js/commits` — checked 2026-10-08
2. https://www.mongodb.com/docs/atlas/app-services/sync/device-sync-deprecation.md — checked 2026-10-08
3. https://registry.npmjs.org/realm — checked 2026-10-08

---

## 14. Sweep: other open-source offline-first sync stores (short)

Each line lists the model, where it runs, the sync model, the merge rule, the licence, the latest
release and a verdict. Sources are listed below the table.

| Candidate | Facts | Verdict |
|---|---|---|
| **WatermelonDB** | Async database for React/React Native [1]. You write the backend: two endpoints on its sync protocol [2]. Merge, per its source: "per-column resolution … All columns that were changed locally win" [3]. MIT. 0.28.0, 2025-04-07 [4]. Node: not found. | No: React Native/web focus, async, needs its own backend |
| **Logux** | Action log, client and server in Node, MIT. Offline actions are kept "in the memory" unless you switch to `IndexedStore`. The server can revoke actions [5]. Client 0.26.0, server 0.17.0, both 2026-10-06 [4]. | No: server-centric, not a whole-library store |
| **Verdant** | Documents in IndexedDB. The optional server runs on "a Node server and a SQLite database". No P2P, no hosted cloud [6]. MIT. 5.5.0, 2026-08-22 [4]. | No: browser-only client |
| **SignalDB** | "reactive, local-first JavaScript database" with sync you implement [7]. MIT. `@signaldb/core` 1.8.1, 2026-03-17 [4]. | No: in-memory collections, not relational |
| **TanStack DB** | "The reactive client store for your API" [7]. MIT. 0.12.3, 2026-10-07 [4]. Not a sync engine itself. | No: client cache layer |
| **Fireproof** | "embedded document database with encrypted live sync"; Merkle clock from Pail; syncs "via commodity object storage" [8]. README says "Dual-licensed under MIT or Apache 2.0", but npm metadata says "AFL-2.0" (mismatch) [4][8]. 0.24.19, 2026-04-15 [4]. | No: document model; licence metadata inconsistent |
| **DXOS (ECHO)** | Object database inside DXOS's SDK. `@dxos/client` and `@dxos/echo` are **FSL-1.1-Apache-2.0** [4]. 0.13.0, 2026-10-07 [4]. | Licence question (FSL, see top); otherwise its own data model |
| **Autobase / Hypercore** | "multiwriter data structure": writers' append-only logs are "linearized into an eventually consistent order" with event sourcing [9]. Apache-2.0 (Autobase), MIT (Hypercore). v7.28.2 (2026-09-08), v11.37.2 (2026-10-05) [7]. Browser/webview: not found in the README. | No: Holepunch P2P stack, no relational model |
| **Graft** | Transactional page storage, used as a SQLite extension. "Alpha quality". Apache-2.0 OR MIT [10]. Optimistic commits; "divergence requires manual intervention"; no merge [11]. v0.2.1, 2025-12-04 [7]. | No: no multi-writer merge |
| **SQLSync** | "collaborative offline-first wrapper around SQLite" [12]. Apache-2.0. No release; last commit 2025-11-19 [7]. | No: dormant |
| **Earthstar** | LGPL-3.0; v10.2.2, 2023-08-31 [4][7]. | No: copyleft, dormant |
| **SyncedStore** | Yjs wrapper, MIT; 0.6.0, 2023-10-15; last push 2024-03 [4][7]. | No: dormant, Yjs only |
| **Kinto** | "A generic JSON document store with sharing and synchronisation". The server is Python (Apache-2.0); 26.4.0, 2026-10-07 [7]. `kinto` (JS client) 17.1.1, 2025-12-09 [4]. | No: Python server, document model |
| **NextGraph** | Rust; "NextGraph is in alpha release"; Apache-2.0 OR MIT [13]. | No: alpha |
| **p2panda** | Rust crates, "APIs are not yet considered stable for production use". Apache-2.0 OR MIT. v0.7.1, 2026-08-21 [14]. | No: Rust, pre-1.0 |

Sources:
1. https://github.com/Nozbe/WatermelonDB — checked 2026-10-08
2. https://watermelondb.dev/docs/Sync/Intro — checked 2026-10-08
3. https://github.com/Nozbe/WatermelonDB/blob/master/src/sync/impl/helpers.js — checked 2026-10-08
4. npm registry for each package: @nozbe/watermelondb, @logux/client, @logux/server, @verdant-web/store, @signaldb/core, @tanstack/db, @fireproof/core, @dxos/client, @dxos/echo, earthstar, @syncedstore/core, kinto, autobase — checked 2026-10-08
5. https://logux.org/guide/concepts/action/ — checked 2026-10-08
6. https://github.com/a-type/verdant (README) — checked 2026-10-08
7. `gh api repos/<owner>/<repo>` and `…/releases/latest` for maxnowack/signaldb, TanStack/db, holepunchto/autobase, holepunchto/hypercore, orbitinghail/graft, orbitinghail/sqlsync, earthstar-project/earthstar, yousefed/SyncedStore, kinto/kinto — checked 2026-10-08
8. https://github.com/fireproof-storage/fireproof (README) — checked 2026-10-08
9. https://github.com/holepunchto/autobase (README) — checked 2026-10-08
10. https://github.com/orbitinghail/graft (README) — checked 2026-10-08
11. https://graft.rs/docs/internals/ — checked 2026-10-08
12. https://github.com/orbitinghail/sqlsync (README) — checked 2026-10-08
13. https://github.com/nextgraph-org/nextgraph-rs (README) — checked 2026-10-08
14. https://github.com/p2panda/p2panda (README) — checked 2026-10-08

---

## 15. FSL — left for the user

- **DXOS:** FSL-1.1-Apache-2.0 [section 14, source 4]. It was allowed under the original rule.
  Under "only open-source" it is unclear. Its fit is weak either way, since it is its own object
  model.

---

## 16. Dropped: proprietary or paid (one line each, per the rule)

- **Ditto:** proprietary.
  - The binary licence forbids reverse engineering [1].
  - Self-managed deployment only on the Enterprise tier, "Contact Us" [2].
  - Requires "one-time authentication with Ditto Server" [3].
- **Couchbase Lite (Community and Enterprise), Couchbase Lite for JavaScript, Sync Gateway:** no
  open-source part is usable.
  - Core and Sync Gateway source files are BSL-1.1, which bars linking into a product "offered …
    for a fee or otherwise on a commercial or other for-profit basis" [4][5].
  - Community binaries use a "revocable and personal" licence for "internal business purposes" [6].
  - `@couchbase/lite-js` 1.0.2 ships an Enterprise licence. Its "Free License is allowed only for
    development use and evaluation" [7].
  - Peer-to-peer "is an Enterprise Edition feature" [8].
- **ObjectBox and ObjectBox Sync:** the bindings are Apache-2.0, but the native core is under the
  "ObjectBox Binary License" [9]. "ObjectBox Sync is a commercial product" [10]. No JavaScript
  binding was found [10].
- **MongoDB Atlas Device Sync:** end of life on 2025-09-30 [11]. The open Realm part is in section 13.
- **Dexie Cloud server:** paid on-prem (€3,495 / €7,995); source only with Enterprise [12]. The
  open Dexie.js part is in section 8.
- **RxDB premium plugins:** paid ("from $99/month") [13]. The free part is in section 2.

Sources:
1. `npm pack @dittolive/ditto@5.1.0` → package/LICENSE.md — checked 2026-10-08
2. https://www.ditto.com/pricing — checked 2026-10-08
3. https://docs.ditto.live/sdk/latest/install-guides/js — checked 2026-10-08
4. https://github.com/couchbase/couchbase-lite-core/blob/master/licenses/BSL-Couchbase.txt (Licensed Work: Couchbase Lite 4.2, change date May 1, 2029) — checked 2026-10-08
5. https://github.com/couchbase/sync_gateway/blob/main/licenses/BSL-Couchbase.txt — checked 2026-10-08
6. https://feed.nuget.org/packages/Couchbase.Lite/3.1.7/License (CCELA/Apr2021/v3) — checked 2026-10-08
7. `npm pack @couchbase/lite-js@1.0.2` → package/LICENSE.txt §2.1 — checked 2026-10-08
8. https://docs.couchbase.com/couchbase-lite/3.1/c/p2psync-custom.html — checked 2026-10-08
9. https://objectbox.io/faq/ — checked 2026-10-08
10. https://objectbox.io/sync/ — checked 2026-10-08
11. https://www.mongodb.com/docs/atlas/app-services/sync/device-sync-deprecation.md — checked 2026-10-08
12. https://dexie.org/cloud/pricing — checked 2026-10-08
13. https://rxdb.info/premium/ — checked 2026-10-08

---

## 17. Summary table (open-source candidates)

| Candidate | Data model | Node | Webview / Capacitor | Sync: P2P/server; files or own transport | Merge rule | Licence (client / server) | Latest release | Fit |
|---|---|---|---|---|---|---|---|---|
| CouchDB + PouchDB | JSON docs, revision trees | Yes (LevelDB default) | IndexedDB; Capacitor not named | Both (any endpoint pair); files via third-party dump/load | Whole doc; deterministic winner, losers kept | Apache-2.0 / Apache-2.0 | PouchDB 9.0.0 (2024-06-21); CouchDB 3.5.2 (2026-05-19) | No: docs, async, no client release in 28 months |
| RxDB (free) | JSON docs, no joins | Only Memory/Mongo/FoundationDB free; SQLite trial capped at 500 docs | Dexie or LocalStorage free; Capacitor SQLite premium | Server-style pull/push, custom handlers; WebRTC P2P; Drive/OneDrive beta | Master wins per doc (default); optional CRDT ops | Apache-2.0 / (any backend) | 17.6.0 (2026-10-05) | No: 13-collection cap, async, docs |
| PGlite | Relational (Postgres) | Yes | IndexedDB/OPFS; Capacitor not named | Read-path only from Electric (alpha) | None | Apache-2.0 / — | 0.5.8 (2026-08-26) | No: no write sync, async, SQL port |
| Automerge-repo | CRDT JSON docs, no queries | Yes (NodeFS) | IndexedDB; Capacitor not named | P2P or self-hosted server; save/merge bytes allow files | Map key: one value chosen; update beats delete | MIT / MIT | Core 3.5.0 (2026-09-16); repo `latest` = 2.6.0-alpha.3 | No: not a database for relational data |
| Loro | CRDT containers | Via JS/WASM | Not named | P2P bytes; any transport | LWW map; CRDT lists, text, trees | MIT / MIT | 1.16.4 (2026-09-30) | No: a Yjs alternative, not a DB |
| TinyBase | In-memory tables/rows/cells | Yes | capacitor-sqlite persister | WS server, custom synchronizer; files via content+merge | LWW per change with HLC | MIT / MIT | 10.0.1 (2026-09-24) | No as DB (merged state is one JSON blob); yes as a reference |
| LiveStore | Events → SQLite | Yes | OPFS only; Capacitor not named | Central total-order backend | "isn't implemented yet" | Apache-2.0 / Apache-2.0 | 0.4.0 (2026-06-02) | No: no conflicts, needs an orderer |
| Dexie.js | IndexedDB tables | Not named | Yes (Capacitor named) | Stale `dexie-syncable` (2023) | You define it | Apache-2.0 / — | 4.4.6 (2026-09-10) | No |
| GUN | Graph | Yes | Browser; Capacitor not named | P2P mesh, relays | State + lexical tiebreak | Zlib/MIT/Apache-2.0 | 0.2020.1241 (2025-07-01) | No |
| OrbitDB | Docs / key-value on IPFS | Yes | Browser; Capacitor not named | P2P libp2p | LWW by clock, then id | MIT | 4.0.0 (2026-05-14) | No |
| any-sync | Encrypted DAG spaces (Go) | No | No | P2P + sync nodes | CRDT updates | MIT (protocol, node); client lib source-available | v0.13.8 (2026-10-07) | No: Go only |
| SurrealDB | Document-graph | Yes | Browser WASM | None (app's job) | None | SDK Apache-2.0; engine BUSL-1.1 | 3.3.0 (2026-09-28) | No: BSL |
| Realm (community) | Objects | Yes | No | None | None | Apache-2.0 | 20.2.0 (2025-08-11) | No: deprecated, no sync |
| *Ours:* SQLite + change log + HLC LWW + Yjs | Our relational schema, unchanged | better-sqlite3 (today) | sqlite-wasm (Apache-2.0) or `@capacitor-community/sqlite` (MIT), from round 1 | All three transports are ours by design | Per-field LWW (HLC); Yjs for text | MIT/Apache deps | — | Baseline |

---

## 18. Judgement

**Question:** for our setup, does any non-SQLite option beat "SQLite on every device plus our own
change log and merge (per-field LWW with a hybrid logical clock, and Yjs for rich text)"?

The setup is:
- an existing relational schema;
- a synchronous server code base on better-sqlite3;
- three transports;
- offline first.

**Answer: no.** None of them beats it. The reasons follow.

### 18.1 Every contender throws away our schema and most of our code
The part these products would save us is the merge itself. That is the smallest part of our plan.

What we have (section 0.2):
- 35 JustWrite tables, plus 23 in JustVoice.
- About 30 `REFERENCES` and 28 `ON DELETE CASCADE` in JustWrite. Its own comment says the cascade
  "is what deletes a book's rows".
- 36 `JOIN`s.
- Synchronous transactions through the kit's `h.tx(fn)`, "Never async": 13 in JustWrite, 55 in
  JustVoice.

What each serious contender would force:

- **TinyBase** (closest in merge design):
  - **Schema:** rewritten into TinyBase tables. Each row gets one string row id, because tabular
    persistence needs one primary/unique id column [§6, source 5]. So `(project_id, id)` keys
    become synthetic ids.
  - **Every query:** the 36 JOINs and ~25 SQL statements become TinyQL or JS. FKs and cascades
    become our own JS code.
  - **Server data layer:** the kit's `sql.js` handle is replaced by a Store. The whole library
    lives in memory. On disk, the merged store is **one JSON blob** in SQLite, because a
    MergeableStore can use database persisters "only in the 'JSON-serialization' mode" [§6, source 4].
  - **What we gain:** HLC plus per-cell LWW plus a sync handshake. That is exactly the piece we
    planned to write, and it is the small piece.
- **RxDB (free):**
  - **Schema:** 35 collections, which hits the free cap of 13 [§2, source 2].
  - **Every query:** rewritten to Mango-style queries with `populate()`; "no joins" [§2, source 1].
  - **Server data layer:** goes async, because every read and write is awaited.
  - **Storage:** no free persistent Node storage [§2, source 4]. Its default merge is
    "master state" per document [§2, source 8].
- **CouchDB/PouchDB:**
  - **Schema:** becomes JSON documents.
  - **Every query:** becomes Mango or map/reduce. No FKs or cascades.
  - **Server data layer:** goes async. Merge is per whole document, which is coarser than our
    per-field plan [§1, source 8]. We would add a second server technology (Erlang CouchDB).
  - **Upside:** a mature P2P replication protocol.
  - **Downside:** no client release since 2024-06 [§1, source 9].
- **PGlite:**
  - Keeps a relational model, but every SQLite statement would be ported to Postgres, and every
    call goes async (no synchronous query method [§3, source 3]).
  - Its only sync is read-path and alpha [§3, source 4]. So we would still build the change log
    and merge ourselves: all the cost of switching with none of the sync.
- **LiveStore:**
  - Keeps SQLite, but state must derive from events. Every write becomes an event plus a
    materializer.
  - Conflict handling and compaction are "not implemented yet" [§7, source 6].
  - A central backend must set a total order [§7, source 5]. That rules out the hand-carried file
    and the cloud folder as equal peers.
- **Automerge-repo / Loro:**
  - Not databases. No tables, no cross-document queries, and history that grows forever
    [§4, source 2].
  - Using one as the store means the whole schema becomes JSON documents, with every query done
    in JS over them.
  - For text we already chose Yjs.

### 18.2 The three transports favour owning the change format
- File carried by hand, or one file per device in a cloud folder: only the CRDT libraries
  (Automerge `save/merge`, Loro `export/import`, TinyBase `getMergeableContent/merge`) handle these
  natively. The rest need a server, or a total-order backend (LiveStore).
- Our own change file (rows plus HLC per field) gives all three transports one format. The server
  becomes one more peer. Nothing above makes that easier without the schema rewrite.

### 18.3 Our write path is already centralised, which makes our own change log cheap
- In `just-llm-runner/server/src/platform/sql.js`, all writes go through one wrapper (`wrap()`):
  `insert`, `update`, `delete` and `tx`. That is one natural place to record changes.
- The exceptions are raw `h.run`/`h.exec` SQL: 7 + 2 in JustWrite, in 6 files (section 0.2). They
  must be routed through the wrapper or caught by triggers. This is an observation, not a plan.

### 18.4 Licence and maintenance do not rescue any contender
- The open-source contenders are licensed acceptably: MIT, Apache-2.0, or Zlib/MIT/Apache-2.0.
  The exceptions are SurrealDB's engine (BSL) and DXOS (FSL, see the open question).
- Several are pre-1.0, alpha or stale:
  - LiveStore 0.4.0;
  - PGlite sync alpha;
  - the automerge-repo `latest` tag is an alpha;
  - GUN 0.2020.x;
  - PouchDB has not released since 2024-06;
  - Graft is alpha.

### 18.5 What is worth borrowing, not adopting
These are reading references only. Nothing here is decided.
- **TinyBase's MergeableStore** (MIT): a working design of HLC timestamps plus per-cell LWW plus
  hashes for a sync handshake.
- **CouchDB's "keep the losing revision"** (`_conflicts`): a precedent for keeping the overwritten
  value visible instead of silently dropping it.
- **RxDB's checkpoint pull/push contract**: a precedent for the self-hosted server endpoint shape.
- **WatermelonDB's per-column "locally changed columns win"** resolver: shows how a column-level
  dirty set is kept.
