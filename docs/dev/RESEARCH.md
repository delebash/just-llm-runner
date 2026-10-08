<!-- SPDX-License-Identifier: MIT -->
# Research register — what we already know, and where the proof is (just-llm-runner)

**Read the section for your subject before researching anything** — before reading code to
answer a question, before measuring, before briefing an agent. Then grep `docs/plans` for
anything newer. This repo's register holds the shared AI stack's facts (the kit, the shared
server, llama.cpp, the memory arbiter); each app's own register holds its domain:
[JustVoice](../../../JustVioce/docs/dev/RESEARCH.md) ·
[JustWrite](../../../justwrite-app/docs/dev/RESEARCH.md) ·
[docgen](../../../just_ai_i18n_docgen/docs/dev/RESEARCH.md).

## The rule (family-wide, decided 2026-10-04)

The user: *"why do we keep re researching stuff, we need a primary research doc that we point to
so we dont keep duplicating or forgeting what we have done in the past"* — approved "your rec on
all go". JustVoice's register tells the story that prompted it.

- **One register per repo** (`docs/dev/RESEARCH.md`), organised by subject.
- **Before research:** read the subject's section and grep `docs/plans`. An agent's brief
  carries that section and the line *"don't re-derive these; re-check one only if the code it
  cites changed after its date"*.
- **After research:** its facts land in the register in the same change. A research doc with
  no entry is not done. `scripts/check-family.mjs` check 15 fails any `docs/plans/YYYY-MM-DD-*.md`
  dated 2026-10-04 or later that its repo's register does not link, and any register link that
  points nowhere. (It can check the link, not that the facts came with it — that part is the
  rule.)
- **Filled as each subject comes up.** Until then a subject's records are indexed under
  "Records not yet distilled", so they can at least be found.

How it differs from its neighbours: `TASKS.md` says what is OPEN; the distilled records
(`model-research.md`, `serving-design.md`) and `../app-structure.md` say what was DECIDED or
ruled; this page says what is TRUE and where the proof lives. Plan docs stay as the evidence.

## How an entry reads

One fact per bullet, then *how it was checked and when*, then where the proof is.

- **measured** — run on a machine (which one is in the proof) · **code** — read in source ·
  **web** — checked against an upstream page · **git** — read from history · **record** —
  carried from a record and not re-checked since · **agent** — found by a review agent reading
  code and not re-checked by the session that recorded it.
- A fact that turns out wrong is **rewritten**, ending "(was: … until <date>)". Never leave a
  fact standing beside its correction.
- A fact cites code by `file:line`. If that file changed after the fact's date, re-check that
  one fact — don't redo the research.

Subjects: [1 · Memory: the arbiter and the probes](#1--memory-the-arbiter-and-the-probes) ·
[2 · The family stack: Electron, Node, phones](#2--the-family-stack-electron-node-phones) ·
[3 · AI tasks and the stream frames](#3--ai-tasks-and-the-stream-frames) ·
[4 · The AI cache](#4--the-ai-cache-shared-between-apps) ·
[5 · Starting other programs](#5--starting-other-programs) ·
[Records not yet distilled](#records-not-yet-distilled)

---

## 1 · Memory: the arbiter and the probes

**Records:** [`serving-design.md`](serving-design.md) (router, arbiter, cancel — distilled) ·
[`2026-09-19-vram-truth-exact-bytes-units-offload.md`](../plans/2026-09-19-vram-truth-exact-bytes-units-offload.md) ·
[`2026-08-09-fit-redesign.md`](../plans/2026-08-09-fit-redesign.md) and its
[debate ledger](../plans/2026-08-09-fit-redesign-debate.md).
What a speech model costs, measured, is in JustVoice's register §2.

- `make_room(needed, exclude=key)` never evicts the excluded key, and never evicts a kind that
  is protected or busy. So a booking left behind under the key being loaded can only be cleared
  by releasing it — no admission removes it. — *code, 2026-10-04* ·
  `llm_runner/runner/arbiter.py:326-370` (the candidate filter at 362, protected and busy kinds
  at 358).
- `process_tree_device_mem_mb(pid)` measures the dedicated graphics memory of a process **and
  its children** (Windows venv pythons are launcher shims whose child holds the memory). It asks
  nvidia-smi first; on Windows' WDDM driver model, where nvidia-smi answers N/A per process, it
  reads the "GPU Process Memory" counter per pid. None = no per-process reading worked. —
  *code, 2026-10-04* · `llm_runner/runner/hardware.py:719-736`.
- `used_pool_mb()` is the family's one cached reading of used pool memory; `fresh=True` skips
  the cache (the load door must). None = unmeasurable, and callers fall back to the ledger
  rather than guess. — *code, 2026-10-04* · `llm_runner/runner/hardware.py:468-480`.

---

## 2 · The family stack: Electron, Node, phones

**Records:** JustVoice's
[`2026-10-05-electron-node-study.md`](../../../JustVioce/docs/plans/2026-10-05-electron-node-study.md)
(the study — direction decided 2026-10-05: Electron + a Node server, Tauri and Python go, the
whole family; tracked in JustVoice's TASKS). JustVoice's own facts are in its register §6.
Agent findings were checked against code or upstream pages on 2026-10-05 by the agents; the
ones this session re-checked are marked ✓ in the study.

**Electron and Node** (*web + measured, 2026-10-05*):

- Electron 44.5.1 (2026-09-29) ships Chromium 152.0.7977.130 and Node 24.21.0; the latest
  three majors are supported, 45 goes stable 2026-10-20 — about six months of life per major.
  WebView2 on the dev machine is already 154.0.4258.53.
- `ELECTRON_RUN_AS_NODE=1` runs the app's own exe as plain Node (no display), if the `runAsNode`
  fuse is left on — one binary can serve headless.
- `globalShortcut` fires on press only: no key-up, no left/right modifiers, no modifier-only
  chords. `uiohook-napi` compiles in libuiohook, LGPL-3.0-or-later — fails the licence rule.
- System-audio loopback is built in on Windows (`setDisplayMediaRequestHandler`, `audio:
  'loopback'`); macOS has open bug electron#52738 on the custom-handler path; Linux has no
  backend.
- electron-builder (MIT) covers NSIS, AppImage, deb/rpm, dmg; `electron-updater` updates all
  three OSes. Electron Forge has no NSIS or AppImage.
- An Electron NSIS installer of a small Vue app is 111.7 MB, 370 MB installed (*measured*).

**SQLite in Node** (*web + measured*):

- `node:sqlite` is "Release candidate (1.2)" in Node 24 and 26, not Stable. It works with no
  flag in Electron 44.5.1's main process, a `utilityProcess` and under `ELECTRON_RUN_AS_NODE`,
  including `VACUUM INTO` and `ATTACH` (*measured*).
- better-sqlite3 13 is Node-API with prebuilt binaries in the package: 13.0.3 loads unchanged in
  Electron 44.5.1 and Node 26.5.0 — no per-Electron rebuild (*measured*).

**The step-0 spikes** (*measured 2026-10-07*, Windows 11, Electron 44.7.0 and 45.0.0-alpha.16 —
the same on both; JustVoice's
[`2026-10-07-electron-node-plan.md`](../../../JustVioce/docs/plans/2026-10-07-electron-node-plan.md)
§1):

- On 2026-10-07 npm had only alphas of Electron 45 (45.0.0-alpha.16, no beta), against its
  schedule of beta 2026-10-01 and stable 2026-10-20. 45 ships Chromium 156 and Node 24.21.0.
- A `utilityProcess` ends when main is hard-killed. The programs the server started survive
  through their own children unless the server put them in a kill-on-close job (koffi). With
  the job, the whole tree dies on a hard kill of main, a hard kill of the server, `app.quit()`
  and a hard kill of the headless server. A job held by main adds nothing.
- A Node process shows libuv's job (flags `0x3c00`) only after its first `spawn`. Electron's
  main isn't in a job when launched outside one.
- `app://`, registered `standard`, `secure`, `supportFetchAPI`, `corsEnabled` and `stream`:
  - reaches `http://127.0.0.1` with `fetch` and SSE, with `Origin: app://<host>`, cross-site;
  - a JSON `POST` sends a CORS preflight;
  - no Local Network Access block.
- The boot race: the server listened ~170 ms after main started and the page began loading at
  ~60 ms. The page's first request can come before the server listens — it did on 45.
- better-sqlite3 13.0.3 and `node:sqlite` read all 17,374 cells of JustVoice's real database
  exactly as Python's `sqlite3` does.
  - better-sqlite3 is about twice as fast as `node:sqlite`.
  - Kysely 0.29.6 runs over both (`node:sqlite` through a 15-line adapter) and its core is
    browser-safe. But it deadlocks when a query goes through the database handle while a
    transaction is open — one connection behind a lock.
  - `kysely-capacitor-sqlite` was unpublished from npm on 2023-10-31.
- Electron 46 (stable 2027-01-05 per its schedule): `utilityProcess` `child.kill()` no longer
  force-kills two seconds later (electron `docs/breaking-changes.md`).

**The query layer** (*measured 2026-10-07*, the plan's §1.5; *code* where a file is cited):

- **Drizzle 0.45.3 on better-sqlite3 is synchronous.** Its transaction is better-sqlite3's own,
  and nested ones use savepoints (`better-sqlite3/session.js:37-54`).
- **Drizzle against plain SQL** (better-sqlite3 plus a small helper), on JustVoice's real
  database:
  - both read 17,374 cells exactly as SQLAlchemy returns them, and wrote 714 cells
    byte-identical to SQLAlchemy's;
  - both ran the real `LexiconStore`'s ten steps with identical answers and identical tables;
  - in both, a query through the database handle inside a transaction finishes and sees the
    transaction's row;
  - both refuse an `async` transaction function ("Transaction function cannot return a
    promise"), and roll back a write made before its first `await`;
  - speed: reads ~6% slower on Drizzle; 5,000 inserts took 90 ms plain against 193 ms Drizzle.
- **Knex 3.3.0** gives SQLite a one-connection pool (`dialects/sqlite3/index.js:228-229`) and
  waits 60 s for a connection by default (`client.js:253`).
- **Prisma 7's** default generator (`prisma-client`) writes TypeScript; the JavaScript one
  (`prisma-client-js`) is deprecated (prisma.io generators docs). On 2026-10-07 npm's
  `prisma` "latest" was 8.0.0-rc.21, and `@prisma/client` 7.10.0.
- **Foreign keys:** better-sqlite3 13 and `node:sqlite` turn them on by default; Python's
  `sqlite3` doesn't.
- **JSON text and floats.** Python's `json.dumps` writes a whole-number float as `1.0`, which
  JavaScript can't tell from `1`. That's the only difference a faithful `json.dumps` port showed
  across 355 stored JSON cells, so float-ness has to come from field types.

**Step 2's first pieces** (*measured 2026-10-07*, Electron 44.7.0 / Node 24.21.0; the build
sheet `docs/plans/2026-10-07-kit-in-javascript.md`):

- The shared shell (`server/src/shell/main.js`, `runDesktopApp`) on a test app: the page on
  `app://<id>` reached the server with a GET and a preflighted JSON POST (the server answering
  CORS for `app://<id>`); the server got its data root through the env variable and posted
  `ready` over `parentPort`; quitting asked it to stop — its close hook ran, Electron exited 0,
  the port was freed. Chromium's `userData` / `sessionData` landed under `<root>/electron`;
  nothing was written to `%APPDATA%` or `%LOCALAPPDATA%`.
- The JavaScript runner on the real card (*measured 2026-10-08*, RTX 2070 SUPER 8 GB, llama.cpp
  b11239, `gemma-4-26b-a4b-qat`): load → 7.3 GB; `stop()` → back to the 437 MB baseline, the
  model child exiting ~1 s after the router; a hard kill of the Node process owning the router
  (`taskkill /F`) → baseline, no llama-server left — the koffi job takes the tree
  (`server/scripts/router-check/`).
- `vi.spyOn(namespace, "fn")` (vitest 4.1.11) reaches calls made through a module namespace —
  from other modules, and from inside the module through `import * as self` — but not a direct
  call inside the module. That is the port's monkeypatch rule.
- TypeBox 1.3 keeps its markers as non-enumerable properties; spreading a schema
  (`{...schema}`) turns `~optional` into a real key, which ajv's strict mode rejects.
- FastAPI 0.139 keeps included routers behind a lazy `_IncludedRouter`, so `app.routes` does
  not list their routes; the OpenAPI document does. The kit mounts **118 routes** (GET 45,
  POST 39, PUT 17, DELETE 15, PATCH 2) — `server/scripts/route-table.json`.
- The kit's Python tables have no Python-side callable column defaults (the schema capture
  lists none).
- How FastAPI reads a request, which the JavaScript server copies (*measured 2026-10-07* by the
  ports, against the Python routers through TestClient):
  - a pydantic query bool accepts `1/0/t/f/y/n/yes/no/on/off/true/false` in any case, untrimmed;
    `""` and `" true"` answer 422 `bool_parsing`; an int accepts `"5"`, `"5.0"`, `" 7 "`,
    `"1_000"`, not `"5.5"`;
  - a repeated query key gives a scalar parameter its LAST value;
  - a `{p}` path parameter is one non-empty segment matched after decoding: `a%2Fb` and an
    empty segment both answer 404;
  - a route nobody serves answers `{"detail": "Not Found"}`, not problem+json (Starlette's own
    404 never reaches the kit's handler).
- better-sqlite3 binds every JavaScript number as REAL; Python's sqlite3 binds an int as
  INTEGER, so the same 5 lands in a TEXT column as '5.0' vs '5'. The kit's SQL helper binds
  whole numbers as BigInt. ajv's type coercion turns null into "" / 0 inside a nullable union;
  the kit's server does pydantic's lax conversion itself instead. (*measured*, the build sheet §6.)

**The kit in JavaScript** (*code + measured*, study §3):

- `llm_runner`: 70 files / 25,941 lines, 61 test files / 19,215 lines, 1,019 test functions,
  119 routes, 26 tables; ~100 ORM query sites; the kit's wire format is camelCase
  (`llm/schema.py:11-17`, `runner/schema.py:20-26`).
- **Process trees on Windows**: Node's `child_process` puts children in libuv's kill-on-close
  job, but that job sets SILENT_BREAKAWAY_OK — a **grandchild survived** a hard kill of the
  server; with our own Job Object through `koffi` (MIT) it died too (*measured*). llama-server's
  router mode starts per-model children (`runner/arbiter.py:4`, `process.py:382`), so the kit's
  spawn needs that job (today: ctypes, `runner/process.py:831-907`).
- undici's header and body timeouts default to 300 s; `fetch` ignores `HTTP(S)_PROXY` unless
  `NODE_USE_ENV_PROXY=1`.
- JavaScript's `\w`/`\b` are ASCII-only and it has no `casefold` — a naive regex port gives
  wrong results on non-English text silently.
- The official `openai`, `@anthropic-ai/sdk` and `@google/genai` JS SDKs carry every call the
  kit's adapters use; the MCP SDK mounts in Fastify as an ordinary route.

**The data-dir ladder** (*agent*, study §4.1): the Rust shells and `platform/data_paths.py`
disagree today — the OS fallback folder (Tauri's `%APPDATA%\<id>` vs platformdirs'
`%LOCALAPPDATA%\<App>\<App>`), the `dataroot.txt` pointer (only Rust reads it) and the dev root
(`target/debug` vs the checkout). Tauri also writes `.window-state.json` and `EBWebView` outside
the chosen root.

**The shared model cache lives in JustWrite's dev root** (*measured 2026-10-07*, the three dev
databases read-only, plus the registry):
- `…\justwrite-app\src-tauri\target\debug\data\ai-cache` is JustVoice's and docgen's saved
  cache folder — `runner_setting` row `cache_root`, written at `llm/stores.py:897`;
- saved model measurements hold model paths inside it: JustVoice 3, JustWrite 2 —
  `measurement_switches.flag_value`, written at `llm/stores.py:1406`;
- `%LOCALAPPDATA%\just-ai\caches.json` lists JustWrite and JustVoice with it as `cacheRoot`.

Renaming JustWrite's dev root breaks all of these unless they are rewritten (the plan's §10 Q9).

**docgen on Electron** (*measured 2026-10-08*, this machine, docgen's step 3; the JustVoice
plan §5 and its TASKS entry):
- electron-builder 26.15.3's NSIS uninstaller ends with `RMDir /r $INSTDIR`, and an update runs
  the old uninstaller first — with the family's data folder beside the exe, a silent uninstall
  left only `resources\`. The kit's `server/src/shell/installer.nsh` (`customRemoveFiles`, each
  app's `nsis.include`) keeps `data\` and `dataroot.txt`; a marker file in `data\` then survived
  an update and an uninstall.
- better-sqlite3 ships its build leftovers (sources, object files, PDBs) inside the package; in a
  long install path they hit MAX_PATH and the uninstall left empty folders. Leaving them out of
  `build.files` fixed it; the unpacked app still opened its database. docgen's installer: 124 MB.
- Headless runs the installed exe as Node: `ELECTRON_RUN_AS_NODE=1` and the server's entry inside
  `resources\app.asar` (`build/launcher/*.cmd`); it served on a second port beside the window.
- Playwright's Electron driver (`playwright-core` 1.63.0, `_electron.launch`) drives the dev app
  and the installed exe; docgen's e2e ran 20/20 in about 10 s.
- docgen's Python server answered errors in FastAPI's default shape (`{"detail": …}`, 422 items
  with `input`/`ctx`), not problem+json — found by the route diff, not by reading. The kit's
  `createServer({ errors: "fastapi" })` reproduces it.
- The route diff's app mode (`server/scripts/route-diff/route-diff.mjs --app docgen`) compared
  docgen's whole server, Python vs Node, on copies of its real database: 83 reads (70 identical,
  13 volatile — times, ids, the backup file), 37/37 writes, 1,910 database cells, 0 different.

**JustWrite on Electron** (*measured 2026-10-08*, this machine, step 4; JustWrite's register
has its app-side facts):
- electron-builder packages every `dependencies` entry into the app; a renderer library listed
  there ships twice (Vite already bundled it). Moving the renderer's libraries to
  devDependencies took JustWrite's installer from 170 MB to 134 MB; docgen's got the same split.
  `dependencies` now holds only what the server and shell load: the kit and `@fastify/static`.
- better-sqlite3 13 and koffi ship per-platform N-API prebuilds, so neither needs a rebuild for
  Electron's ABI — locally or on CI.
- The shell evicts a stale listener on the app's port before starting the server, so a second
  copy of an app (or a headless server on the same port) is stopped, as the Tauri shells did.
- The kit's CSP default forbids eval; an app adds sources per directive with `cspAdd`.

**JustVoice's server port** (*measured 2026-10-08*; JustVoice's register has its app-side facts):
- `runner/binary.js` `extractTarGz` left the archive open for the life of the process when it
  stopped at the end marker (the gunzip stream was destroyed, the file stream under it never):
  one open handle per extraction, counted. It now closes the file before returning
  (`binary.test.js` `extract_tar_gz_closes_the_archive` fails on the old code).
- `platform/http.js` runs its own undici copy, so a `FormData` made by another copy (an app's,
  or Node's global) is sent as the text "[object FormData]". Multipart bodies are written out
  with `http.multipart(parts)` instead (`http_multipart.test.js`).
- Extra arguments after `node -e "<code>"` must follow `--`, or Node reads them as its own
  options.
- **One ZIP module, `platform/zip.js`** (2026-10-08), replacing four copies (the backup routes',
  the runner's `extractZip`, JustWrite's book transfer, JustVoice's voice bundles) under the
  family-sameness law. It writes and reads what CPython 3.12's zipfile does: `ZipWriter`
  (`writestr` in memory, `addFile` streamed; ZIP64 at CPython's thresholds), `ZipReader`
  (`open(file)` / `fromBuffer(buf)`, `read`, `extract`, `extractAll`), `extractZip`. Where the
  copies disagreed CPython won: one timestamp per `writestr` call, strict UTF-8 for a flagged
  name and cp437 otherwise, CPython's end-record search (the copies looked one byte too far or
  scanned their own way), the central directory walked by size, prepended data handled, the
  member checks in CPython's order, `ntpath.splitdrive`'s drive rules. With the clock pinned the
  old and new writers give identical bytes for the backup, JustWrite's book export and
  JustVoice's bundle and voice-line export, and Python's `testzip()` reads all of them clean.
  (*measured 2026-10-08*, an agent's byte check; `server/tests/zip.test.js` reads an archive
  CPython 3.12.9 made, `tests/fixtures/python-zipfile.zip`.) Not covered, as before: bzip2/lzma
  members, the 0x7075 Unicode-path field, 3.12's overlapped-entries check.
- `NotImplementedError` lives in `platform/py.js` with the other Python error classes (the
  runner, the ZIP reader and JustVoice's blending each had their own).
- **An LLM request body is the text httpx writes** (2026-10-08). httpx 0.28.1 encodes `json=` as
  `json.dumps(ensure_ascii=False, separators=(",", ":"), allow_nan=False)`; `llm/base.js`
  `httpxRequest` / `httpxStream` sent `JSON.stringify`, so a preset's `temperature` 0.0 went out
  as `0` (104 of 243 requests in JustVoice's extraction check) and a NaN as `null` where Python
  raises. They now write `httpxBody(json)` — `pyJson` with those options and the new
  `allowNan: false` (Python's ValueError, thrown before anything is sent, not a transport
  error). The values Python holds as floats are `PyFloat`s: `temperature` in the
  openai-compat and Ollama adapters, `top_p` and float-parsed samplers in `_plane2Extra`.
  After the fix all 243 requests are byte-identical (`httpx_body.test.js`; JustVoice's
  `compare-extraction.mjs`). The Anthropic, Gemini and OpenAI SDK adapters serialize through
  their SDKs and still write a whole-number float as an integer — JSON-equal.

**Phones** (*web*, study §5):

- Tauri 2's sidecar works on desktop only. iOS apps may not spawn child processes, so the
  kit's runner (download a llama.cpp binary, spawn it) cannot exist on iOS.
- Capacitor (Ionic, MIT, 8.5.2) runs a plain Vue build — Ionic Framework (a UI toolkit) isn't
  needed. Capawesome sells its SQLite and some other plugins (Insiders: $99/month); its
  Capacitor-Electron platform is MIT, v0.1.1, three months old. `@capacitor-community/electron`
  is unmaintained. `@capacitor-community/sqlite` 8.1.1 is MIT.
- CapacitorHttp buffers whole responses and has no SSE; the kit's client streams with
  `res.body.getReader()` (`ui/src/client.js:157-169`). No maintained MIT llama.cpp plugin for
  Capacitor exists.

---

## 3 · AI tasks and the stream frames

- An app endpoint's SSE stream speaks six frames: `{delta}` (answer tokens), `{thinking}` (a
  thinking model's reasoning, before its answer — added 2026-10-06), `{progress}` (prompt
  reading, before the first token only), `{step: {name, done, total}}` (a later pass over part
  of the work, counted — added 2026-10-06), `{done, promptTokens, completionTokens, model, …}`
  and `[DONE]`; errors as `{error}`. — *code, 2026-10-06* · `ui/src/client.js` requestStream.
- `runAiEndpointStream` puts a step on the task's count: `stepText(step)` words it,
  `stepHint(step)` is the count's tooltip (the task store's `progress.hint`), `onStep(step)`
  tells the app. Without `stepText` the count reads `done/total`. — *code, 2026-10-06* ·
  `ui/src/services/appTask.js`, `stores/aiTasks.js` `_setProgress`.
- A strip says *stuck* only on a streaming task whose last token is ≥ 25 s old (or 8× its own
  mean gap); only token deltas refresh it — a step or a count does not. — *code, 2026-10-06* ·
  `ui/src/common/services/streamFreshness.js`, `stores/aiTasks.js` `_recordDelta`.
- A task's tok/s is tokens ÷ (now − first token), shown only once that span reaches 1 s
  (`common/services/runStats.js` `taskTps`, since 2026-10-06 — before, the span was floored at
  1 ms and 3 tokens read 3000 tok/s); the strip and the status panel both read it. Tokens are
  (answer + thinking characters) ÷ 4 while running (`taskTokensSoFar`) and
  `usage.completionTokens` at done. — *code + live, 2026-10-06*.
- A model's thinking reaches the strip (since 2026-10-06): llama.cpp streams it as
  `delta.reasoning_content` (one delta per token, before the answer — live probe: 199 thinking
  deltas, first at 1.07 s); `openai_compat.stream_chat` yields `StreamDelta(reasoning=…)`, the
  kit's `/v1/ai/stream` and JustVoice's Analyze / Second look streams send `{thinking}`, and the
  task store's `_recordThinking` makes its first piece the first token and counts it
  (`thinkingChars`, `thinking` until the answer starts). The OpenAI-compatible adapter only —
  cloud providers' thinking is not carried. — *code + live, 2026-10-06* · The Keystone's Analyze:
  *thinking…* from 7.1 s (was "first token in 26.7 s") to 29 s at ~35 tok/s live (was ~28).

## 4 · The AI cache (shared between apps)

- The cache choice is a stored setting (`runner_setting` row `cache_root`, "" = the app's own
  `<data>/ai-cache`); startup takes an explicit host root, else the stored choice, else the own
  folder (`llm/install.py` `resolve_cache_roots`). No host passes an explicit root (JV
  `app.py:253`, JW `app.py:197`). — *code, 2026-10-06*.
- No row at all means never chosen (`stores.cache_root_chosen`), and since 2026-10-06 startup then
  adopts a sibling: when the own cache has no finished model, the registry's cache with the most
  models (then bytes) is used and saved (`install._sibling_cache_with_models`). A row holding ""
  ("keep my own") is a choice and is kept. A factory reset deletes the DB file and the seed writes
  no `cache_root` row, so a reset counts as never chosen; the running engine keeps its cache until
  the next start. — *code + live on JustVoice, 2026-10-06* (reset → restart → JustWrite's cache,
  saved, gemma 26B + 12B listed as downloaded).
- An app sharing a sibling's cache records that root in the registry too, so the in-use cache is
  named by the first OTHER install recorded against it (`cache_registry.product_of`, excluding this
  data dir) → `GET /v1/ai/engine-cache` `current.product` when shared. The setup offers the in-use
  shared cache first (`QuickSetup.vue` `cacheOffer`), so *Keep a separate copy* stays reachable
  after startup adopted one. — *code + live, 2026-10-06*.
- `GET /v1/ai/engine-cache` never lists the cache in use among `options`, and lists the app's own
  folder (as "this app") whenever the cache in use is not it (`llm/cache_api.py`). The setup
  recommends the first option with models — since 2026-10-06 never `ownRoot` (`QuickSetup.vue`
  `cacheOffer`). — *code, 2026-10-06*.
- A repo counts as a model in a cache only when a finished file sits in its `snapshots/`, and a
  cache's bytes leave out `.part` / `.incomplete` / `.tmp` files (`runner/cache_registry.py`
  `summarize`, 2026-10-06). Before, a `models--…` folder holding only a `.part` counted.
  — *code + measured on a scratch tree, 2026-10-06*.
- What re-downloaded gemma on JustVoice (2026-10-06): a factory reset without a restart left it on
  JustWrite's cache; its own folder held a `models--unsloth--gemma-4-26B-A4B-it-qat-GGUF` folder
  from an unfinished 2026-10-05 download, so "this app" looked like a cache with models and the
  setup's share pick chose it — 14,249,047,104 bytes fetched again. — *log + disk, 2026-10-06*.

## 5 · Starting other programs

- **Every program the kit starts goes through `llm_runner/platform/procs.py`, with no console to
  inherit (`CREATE_NO_WINDOW` on Windows, 0 elsewhere).** A child started without it inherits
  the server's console; when the shell that started the app is gone, that console has no host
  and Windows can't start the child at all — exit `0xC0000142`. Reproduced 2026-10-07 with a
  test process whose console host was killed: `hardware.detect()` → no GPU (nvidia-smi could not
  start), with a live console → the RTX 2070 SUPER; `llama-server --version` → `0xc0000142`
  plainly, exit 0 through `procs.run`. In the app, the lost GPU meant no llama.cpp build matched
  — the engine read "no llama.cpp binary configured for platform=windows", not installed — while
  the running llama-server (started before the console went) kept working. Since 2026-10-07:
  `hardware.py` (15 calls), `bandwidth.py`, `binary.py` (the launch checks), `process.py` and
  `calibrate.py` (the spawns) use it; JustVoice's mastering, export, system info and speech
  runtime import it. A test that patches `subprocess.run` / `Popen` still reaches its fake — the
  wrappers look `subprocess` up at call time. — *measured + code, 2026-10-07* · JustVoice
  `docs/dev/RESEARCH.md` §3 (the mastering failure that found it).

---

## Records not yet distilled

Indexed by subject so they can be found; their facts move into a section above when work next
touches the subject. History in [`../plans/archive/`](../plans/archive/) is not listed.

**AI tasks — the model's thinking in the strip** (its facts are distilled into §3) —
[`2026-10-06-thinking-in-the-strip.md`](../plans/2026-10-06-thinking-in-the-strip.md)

**llama.cpp — updates, the pin, the stable channel** —
[`2026-09-19-engine-update-safety-and-stable-channel.md`](../plans/2026-09-19-engine-update-safety-and-stable-channel.md) ·
[`../llama-cpp-watch.md`](../llama-cpp-watch.md) (the upstream review ledger).

**Speed** — [`2026-09-19-speed-truth-and-calibrated-pick.md`](../plans/2026-09-19-speed-truth-and-calibrated-pick.md).

**The CPU-only band** — [`2026-07-19-cpu-only-band-test.md`](../plans/2026-07-19-cpu-only-band-test.md).

**Jobs across the three apps** — [`2026-08-14-three-app-job-matrix.md`](../plans/2026-08-14-three-app-job-matrix.md).

**Models** — [`model-research.md`](model-research.md) (distilled verdicts, licensing laws).

**Features and routing** — [`../feature-model-system.md`](../feature-model-system.md).

**Family structure** — [`../app-structure.md`](../app-structure.md) (the standard) ·
[`../family-structure-audit.md`](../family-structure-audit.md) ·
[`../target-tree.md`](../target-tree.md).

**Installing the stack** — [`install-runbook.md`](install-runbook.md).
