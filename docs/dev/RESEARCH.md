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
  no entry is not done. `scripts/check-family.js` check 15 fails any `docs/plans/YYYY-MM-DD-*.md`
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
- The route diff's app mode (`server/scripts/route-diff/route-diff.js --app docgen`) compared
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
- **One copy of the Python helpers** (2026-10-08, the family-sameness sweep — JustVoice's TASKS
  step-5 rec 3). `platform/py.js` gained isDict (a Map or a plain object) and isJsonObject (any
  non-array object, what JSON.parse makes — the copies that tested only that keep it), pyGet,
  pyIter, pyTypeName, setdefault, pyOr, errText, strRepr, cpLen/cpSlice/cpIndex, splitlines,
  pyTitle/pyIsUpper/pyCapitalize, END, reEscape, pyEscapedLen, digitValue/digitsToInt/
  asciiDigits, pyIntOfStr, decodeUtf8 + UnicodeDecodeError, b64decode + Base64Error and the
  Attribute/Index/Overflow/AssertionError classes; `platform/pyjson.js` gained pyRepr, pyStrOf,
  pyStrScalar, isNumber, pyFloatOf, pyIntOfNumber, pyIntOf, unwrap, pyFixed, pyFormatG (now exact
  below 2^-20 too), pyJsonParse, jsonLoads / jsonLoadsExact / jsonRawDecode + JSONDecodeError (one
  scanner, two shapes: plain objects and numbers, or Maps and BigInts); `platform/models.js`
  branchOf and unwrapTyped; `createServer({pyFloats: {routes}})` is JustVoice's request-body
  float opt-in; `extractTarGz(archive, dest, {members})` is tarfile's extractfile walk (JustVoice's
  Japanese dictionary). JustVoice's `py_compat.js` is gone. Proof, before the copies went: each
  new function against every copy it replaced on 20,000–200,000 generated inputs, 0 different
  where merged; CPython 3.12.9's own answers in `tests/fixtures/python-text.json`
  (`py_text.test.js`); the real UniDic sdist through the old walker and `{members}`: 21 files,
  260,469,742 bytes, identical. (*measured 2026-10-08*.)
- **Copies left apart, because merging changes what they answer** (each is an approximation of
  the same CPython function; the user decides whether to converge): repr of a str — strRepr
  escapes the control characters (C0, DEL, C1); `seed.js` pyReprStr, `runner/models.js` pyRepr
  and JustVoice's `persona_render` pyReprStr leave U+0080–U+009F raw; docgen's jsonio `reprStr`
  (and its `pyStr` / `pyRepr`) is CPython-exact (U+00A0, U+00AD, U+200B, U+2028, U+3000, U+FEFF
  escaped too); JustVoice's slot `pyRepr`, html_parser `pyReprStr`, book_prose `reprStr`,
  voice_bundle `reprOf` and JustWrite's book_io `pyRepr` / `pyStrOf` escape less still. str() —
  py.js `pyStr` (String() for floats: `1e-7`), prompts.js `pyStrAny` (a PyFloat as `{'v': 1.0}`,
  NaN as `NaN`). format(x, "g") — JustVoice's pipeline `formatG` and persona_render `fmtG` round
  an exact tie up (123456.5 → "123457"; CPython "123456"). float() — py.js `pyFloatParse` (ASCII
  digits, JavaScript's trim) beside pyjson's CPython `pyFloatOf`. dict.get — JustWrite's
  `pyGet` / `pyItems` (TypeError), JustVoice's projects/extraction `dget` and justwrite adapter
  `pyGet` (their own type words). JustWrite's `setdefault` (a `__proto__` key stays data).
  model_catalog's `excStr` (str() of a thrown non-Error). (*code*, the sweep's fuzz.)
- Two gaps from CPython the fixture found, kept as they were: `pyFloatOf` / `pyIntOfStr` strip
  U+001C–U+001F (str.isspace() counts them; CPython's float() and int() refuse them); JustVoice's
  `pronunciation.js` escapes `-` into a `u`-flag pattern, so a lexicon entry holding a space and
  a hyphen ("Jean-Luc Picard") throws "Invalid escape" where Python matched. (*measured*.)
- **An LLM request body is the text httpx writes** (2026-10-08). httpx 0.28.1 encodes `json=` as
  `json.dumps(ensure_ascii=False, separators=(",", ":"), allow_nan=False)`; `llm/base.js`
  `httpxRequest` / `httpxStream` sent `JSON.stringify`, so a preset's `temperature` 0.0 went out
  as `0` (104 of 243 requests in JustVoice's extraction check) and a NaN as `null` where Python
  raises. They now write `httpxBody(json)` — `pyJson` with those options and the new
  `allowNan: false` (Python's ValueError, thrown before anything is sent, not a transport
  error). The values Python holds as floats are `PyFloat`s: `temperature` in the
  openai-compat and Ollama adapters, `top_p` and float-parsed samplers in `_plane2Extra`.
  After the fix all 243 requests are byte-identical (`httpx_body.test.js`; JustVoice's
  `compare-extraction.js`). The Anthropic, Gemini and OpenAI SDK adapters serialize through
  their SDKs and still write a whole-number float as an integer — JSON-equal.
- **The shell against Electron's security checklist** (2026-10-08,
  electronjs.org/docs/latest/tutorial/security, 20 items, *read against `src/shell/main.js`*).
  Already met: context isolation, the sandbox, no Node in the renderer, web security, a
  written CSP on app://, the custom protocol (`protocol.handle`, no file://), navigation
  (`will-navigate`) and new windows (`setWindowOpenHandler`) refused, `shell.openExternal` only
  for http(s)/mailto, one preload object (no raw ipcRenderer), the server in a
  `utilityProcess`. Missing, added the same day: a permission request + check handler (the
  app's own origin only; clipboard write/read, plus the app's `permissions` — JustVoice's
  "media" for the microphone); the IPC sender check (`senderFrame` origin = the window's home
  origin); `will-attach-webview` refused; `requestSingleInstanceLock` (a second launch on the
  same data folder evicted the first copy's server from the port; it now focuses the first);
  fuses per app (`build.electronFuses`: cookie encryption on, NODE_OPTIONS and --inspect off,
  embedded asar integrity + only-load-from-asar on, file:// extra privileges off — `runAsNode`
  stays ON because each app's headless launcher runs its exe with ELECTRON_RUN_AS_NODE=1).
  electron-builder 26.15.3 takes `electronFuses` (`app-builder-lib/out/configuration.d.ts`).
- **A sandboxed preload is a plain `.js`** (electronjs.org/docs/latest/tutorial/esm):
  sandboxed preloads "are run as plain JavaScript without an ESM context" and "ignore
  "type": "module" fields", so `preload.js` with `require("electron")` works in a module-type
  package; only an ESM preload (`import` syntax, sandbox off) needs `.mjs`. The kit's
  `preload.cjs` became `preload.js` (2026-10-08, the user's no-.mjs/.cjs ruling).
- **A download's name: `platform/server.js` `attachment(filename)`** (2026-10-08). A header
  carries latin-1 only (Starlette encoded it so and raised UnicodeEncodeError; Node rejects
  anything past 0xFF), so JustWrite's export of a book titled in Japanese was a 500 in both
  servers. A name outside printable ASCII now travels as RFC 5987's `filename*=UTF-8''…` beside
  an ASCII fallback (RFC 6266 §4.3; `'()*` percent-encoded too, encodeURIComponent leaves
  them); a plain ASCII name gives the exact `attachment; filename="<name>"` the routes wrote
  before. (`attachment_header.test.js`; JustWrite's `book_transfer.test.js`.)

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
- **Node on a phone stops at 18.20.4** (end of life): nodejs-mobile's newest release, which
  Capawesome's Capacitor Node.js plugin calls "the latest version available". Native add-ons
  only as Android prebuilds; iOS runs it without JIT. The kit needs Node ≥ 24
  (`server/package.json` `engines`). — *web + code, 2026-10-08* ·
  github.com/nodejs-mobile/nodejs-mobile/releases, capawesome.io/docs/sdks/capacitor/nodejs/.
- **A live SQLite file in a sync folder is a corruption risk:** SQLite's own page lists broken
  locking on network filesystems, background copies taken mid-transaction, and copying a
  database without its `-wal`/`-journal`. Joplin syncs desktop and phones through Dropbox,
  OneDrive, Nextcloud, WebDAV, S3 or a folder by moving items, not the database; a note changed on
  two devices keeps the local copy in a Conflicts notebook. — *web, 2026-10-08* ·
  sqlite.org/howtocorrupt.html, joplinapp.org/help/apps/sync/, …/apps/conflict/.
- **sqlite-sync (sqliteai) is Elastic License 2.0, not MIT** — "contact SQLite Cloud, Inc for a
  commercial license" for production or managed-service use. A SQLite extension
  (`cloudsync_init()` per table) with CRDTs (Causal-Length Set, Delete-Wins, Add-Wins, Grow-Only
  Set) and opt-in line-level merge for text columns; syncs through SQLite Cloud, or self-hosted
  PostgreSQL or Supabase (a custom network layer can replace its libcurl); builds for Linux,
  macOS, Windows, iOS, Android, WASM, with packages for Swift, Android, Flutter, Expo, React
  Native, WASM — Capacitor and Node not named. Every device needs the same tables (the server
  checks a schema hash). — *web, 2026-10-08* · github.com/sqliteai/sqlite-sync (README). Turso's
  sync and the rest of the field were checked the same day: "Sync", below.

**Vue UI libraries** (*web + npm registry*, 2026-10-08):

- Quasar 2.35.0 (MIT, 2026-10-07), `@quasar/app-vite` 3.10.2, `@quasar/vite-plugin` 2.0.2 (needs
  Vite 8+, `@vitejs/plugin-vue` 6+, Quasar 2.24+; without its CLI, cross-platform builds are
  "community plugins"). Its Electron mode keeps its own `src-electron/electron-main.js` and
  `electron-preload.js`. **No iOS theme** — the 2.35.0 package has only `QSpinnerIos`; the iOS
  theme was in the 0.x docs. Its look is Material, restyled through Sass variables (most are
  build-time), props and CSS. `QDrawer` has a `breakpoint` phone mode.
- Element Plus 2.14.7 (MIT): "css variables to reconstruct the style system of almost all
  components" — the look changes at runtime. No breakpoint-driven layout component.
- **PrimeVue 5 is not MIT:** 5.0.2 ships a PrimeUI licence with a license key, free only for
  organisations under $1M revenue / 5 developers, renewed yearly; 4.5.5 was the last MIT.
- Reka UI 2.11.0 (MIT) is the Vue port of Radix UI Primitives — the kit already builds
  `AppModal`, `HelpDrawer`, `UiSelect`, `UiMultiSelect` on it.
- Vue Lynx (`vue-lynx` 0.5.1, Apache-2.0) renders native elements, not the DOM — libraries that
  need `document`/`window` must be adapted (TipTap among them); its site still says pre-alpha.
- Also current: Vuetify 4.2.4 (MIT, Material), `@ionic/vue` 9.0.7, Konsta 5.5.0, electron-vite
  5.0.0, `@capacitor/core` 8.5.3, `@tauri-apps/cli` 2.12.1.
- Measured on JustWrite's Locations screen — both Quasar and Element Plus carry the family look
  and follow the appearance engine live: JustWrite's register, "The phone app".

**Quasar as the family framework** (*web*, 2026-10-08 — quasar.dev `.md` pages, npm registry,
published tarballs read not run, GitHub API; full record with every source:
[`docs/plans/2026-10-08-quasar-framework-research.md`](../plans/2026-10-08-quasar-framework-research.md)):

- Versions: `quasar` 2.35.0 and `@quasar/app-vite` 3.10.2 (both 2026-10-07), `create-quasar`
  5.0.32, `@quasar/cli` 5.0.9, `@quasar/mcp` 1.1.0, the Vitest extension
  `@quasar/quasar-app-extension-testing-unit-vitest` 3.0.0 — all MIT. app-vite needs Vite ^8.3,
  `@vitejs/plugin-vue` ^6, `vue-router` ≥ 5, Node ^22.22 / 24 / 26+.
- A new app: `npm init quasar@latest` (the docs show `pnpm create quasar@latest`). app-vite is the
  only engine. Features: TypeScript · Sass · linting (ticked by default; can be unticked) ·
  filename routing · Pinia · i18n. The generated `package.json` is `"type": "module"`;
  `quasar.config` is `.js` or `.ts` only. There is no `main.js` and no `vite.config.js`: start-up
  code goes in boot files (`src/boot/*.js`, `defineBoot` from `#q-app`), Vite through
  `build.extendViteConf`. The generated `index.html` CSP has no `connect-src` for another origin.
- Electron mode (`quasar mode add electron`): `src-electron/electron-main.js` +
  `electron-preload.js` (ESM `.js`; the preload is BUILT to `.cjs` because sandboxed preloads
  can't be ESM) + its own `package.json` (`"type": "module"`, `electron` installed `latest` then
  written `^<version>` — not pinned). The window sets only `contextIsolation: true` and leans on
  Electron's sandbox and nodeIntegration defaults; the packaged window loads `file://`
  (`loadFile`). A custom protocol is one checklist line ("Prefer a custom protocol over
  `file://`"), no how-to. Starting a server, a `utilityProcess` or a tray is not documented.
  `@electron/packager` is the default; electron-builder is `bundler: 'builder'`. Main-process
  dependencies go in `src-electron/package.json`; a `file:` range is copied unchanged into
  `dist/electron/UnPackaged`. Router mode is always `hash` for Electron and Capacitor.
- Capacitor mode (`quasar mode add capacitor`): `src-capacitor/`, Capacitor v5+ supported (the
  template installs ^8.0.0); **`capacitor.config.js` is CommonJS on purpose** ("Capacitor's `.js`
  config loader doesn't yet handle ESM exports correctly") and `src-capacitor/package.json` has no
  `"type": "module"` — the only documented alternative is `capacitor.config.ts`.
- **App Extensions are Quasar's documented way to share across apps**: "App Extensions replace the
  need to create custom starter kits"; one can add boot files, CSS, components, `quasar.config`
  and Vite hooks, Electron main/preload hooks, CLI commands, templates and prompts. Quasar CLI only
  (not the Vite plugin). Building one is pnpm-only (the scaffold is a pnpm workspace); the local
  route is install-it-yourself then `quasar ext invoke <id>` (a `file:` install is untested). Any
  shared package importing `quasar` needs `optimizeDeps.exclude` or a second Quasar copy loads.
- Own controls in Quasar style: QField's `control` slot, `useFormChild`, `useSplitAttrs` (public);
  `useField` and `useDark` are private (`private.use-*`). Theming: Sass variables in
  `src/css/quasar.variables.scss` (build time), `--q-*` brand colours with `setCssVar` at runtime,
  the Dark plugin (`body--dark`), `globalNodes` for portalled popups, `iconSet` / `iconMapFn`.
- Lint: the docs offer oxlint + oxfmt (the scaffold default) or ESLint + Prettier; **Biome isn't
  mentioned**. Vitest through `quasar ext add @quasar/testing-unit-vitest`.
- `@quasar/mcp` serves the installed versions' docs and component API offline — tools
  `list_pages`, `search_docs`, `get_page`, `list_api`, `get_api`, `check_updates`; on Windows
  `claude mcp add quasar -- cmd /c npx -y --fetch-retries=0 @quasar/mcp@latest` (added at user
  scope 2026-10-08). `https://quasar.dev/llms.txt` exists; every docs page has a `.md` sibling.
- Forking: one MIT pnpm monorepo `quasarframework/quasar` (branch `dev`; `ui`, `app-vite`, `cli`,
  `extras`, `create-quasar`, `mcp`, `vite-plugin`, …); build with Node 22.22+ and pnpm 12+, `pnpm
  i && pnpm build`; `dist` is never committed. How a project consumes a fork: not stated.
- Not verified (the template build tests these first): `app://` with Quasar's build; a `file:` kit
  dependency in the packaged Electron app; an App Extension installed via `file:` with npm; Biome
  with Quasar; the CSP vs the renderer's calls to the local server.

**Sync** (*web* and *measured*, 2026-10-08 — for the family's sync decision; the design
discussion is JustWrite's `docs/plans/2026-10-08-sync-design.md`; full records with every source:
[`docs/plans/2026-10-08-sync-research-platforms.md`](../plans/2026-10-08-sync-research-platforms.md)
and [`docs/plans/2026-10-08-sync-research-building-blocks.md`](../plans/2026-10-08-sync-research-building-blocks.md)):

- **SQLite's session extension** records row changes by primary key (tables with a declared,
  non-NULL key only; no virtual tables; DDL not stated) into a binary changeset; applying one
  calls a conflict handler with DATA / NOTFOUND / CONFLICT / CONSTRAINT / FOREIGN_KEY and takes
  OMIT / REPLACE / ABORT. It never merges inside a text cell and has no transport or clock. —
  sqlite.org/sessionintro.html and the session C API pages.
- **better-sqlite3 13.0.3 has no sessions** (no build flags, no API; issue #468 "no plans" since
  2020) — *measured* in Node 26.5 and Electron 44.7. **`node:sqlite` has them**
  (`createSession`, `applyChangeset` with `onConflict`, since Node 22.12 / 23.3; "Release
  candidate (1.2)" in Node 24.21 and 26.11; no rebase or changeset iteration) — *measured* in
  Electron 44.7.0's Node 24.21.0, a conflict resolved with REPLACE. **The official SQLite WASM**
  (`@sqlite.org/sqlite-wasm` 3.53.4-build2, Apache-2.0) has the full session API — *measured*;
  its `opfs-sahpool` storage needs no COOP/COEP; OPFS inside Android WebView / WKWebView is
  unverified (needs a device). `@capacitor-community/sqlite` 8.1.1 (MIT) has no sessions — its
  "sync" is a JSON export of rows changed since a date, with no conflict handling.
- **Yjs 13.6.33 (MIT)** merges offline edits from any number of devices "without merge
  conflicts" (updates commute and are idempotent), storable as BLOBs in our own SQLite;
  **`@tiptap/extension-collaboration` 3.31.4 is MIT** and TipTap Cloud is not required (the paid
  plans are hosted collaboration). Hocuspocus 4.7.0 (MIT, self-hosted) is the optional live
  server; its SQLite extension pins better-sqlite3 ^12.6.2.
- **No ready-made platform fits "our own SQLite schema, self-hosted, MIT, Node and Capacitor":**
  Turso Sync (MIT, 0.8.2, pre-1.0; "last push wins"; its own engine replaces better-sqlite3; the
  self-hosted sync server is documented for dev/test; Turso "joining Supabase", 2026-10-02) ·
  PowerSync (needs a Postgres/MongoDB/MySQL/SQL Server backend; self-hosted Service FSL-1.1-ALv2;
  Capacitor SDK beta) · ElectricSQL (Postgres, read path only) · Zero (Postgres, "does not support
  offline writes") · Replicache (maintenance mode) · RxDB (its own JSON documents; SQLite storage
  paid) · Evolu (its own schema; TypeScript 7) · Jazz (2.0 alpha) · Triplit (AGPL-3.0, site down)
  · InstantDB (sunsetting 2027-08-31) · PouchDB (last release 2024-06) · sqlite-sync (Elastic
  License 2.0; 1.2.0, 2026-09-28) · cr-sqlite (last release 2024-01; the author is on Zero "for at
  least 1-2 years").
- **Litestream** (Apache-2.0, v0.5.17, active) is one-way WAL backup of one writer to S3 and the
  like — it fits backing up a cloud-hosted server, not device sync. LiteFS needs FUSE and is
  unsupported beta. libSQL `sqld` self-hosts one write primary plus replicas; pointing embedded
  replicas at a self-hosted one is not documented.
- No maintained hybrid-logical-clock package exists on npm (the top one has 44 downloads a week).

**Sync, round 2** (*web*, *measured* and *tested*, 2026-10-08 — under the user's "your rec on all go
do the testing"; the decisions so far and the tests' detail are JustWrite's
`docs/plans/2026-10-08-sync-design.md` "Round 2"; full records with every source:
[`…-round2-sqlite-tools.md`](../plans/2026-10-08-sync-research-round2-sqlite-tools.md),
[`…-round2-non-sqlite.md`](../plans/2026-10-08-sync-research-round2-non-sqlite.md),
[`…-round2-reachability.md`](../plans/2026-10-08-sync-research-round2-reachability.md)):

- **cr-sqlite, tested** (*measured*): vlcn-io v0.16.3 and the Fly.io fork's
  v0.18.0-v2-migration-alpha23 (win-x86_64) both load into better-sqlite3 13.0.3 (Node 26.5) and
  both refuse JustWrite's schema as it is — "checked foreign key constraints" on every book table,
  "a NOT NULL column without a DEFAULT VALUE" on `projects`/`image_blobs`; the fork first demands
  `crsql_set_ts()`. With FKs off and defaults added, merges are right (per field; same field →
  one wins; delete beats edit; inserts kept; converged); 2,000 saves of a 7.5 KB row: 336 ms vs
  132 ms plain (WAL). The Fly.io fork is active (pre-releases 2026-09-22 → 10-07), is Corrosion's
  engine, ships no WASM build, and leaves gap tracking to the app (its README).
- **Our own trigger change log, tested** (*measured*, a throwaway script): works on JustWrite's
  schema unchanged — FKs with `ON DELETE CASCADE` on, NOT NULL kept; SQLite's cascade fires the
  child tables' delete triggers; same four results as cr-sqlite; a relay through a third device
  converges.
- **The phone can keep SQLite in the app — Android, tested** (*measured*, a Capacitor 8.5.3 test
  app on an Android 16 emulator, WebView 133.0.6943.137): origin `https://localhost`, secure
  context; OPFS and `createSyncAccessHandle` in a module worker; `@sqlite.org/sqlite-wasm`
  3.53.4-build2 on `opfs-sahpool` through its synchronous API, session API present; the database
  survives a force-stop and an app update (reinstall); `navigator.storage.persist()` returns false;
  2,000 single 7.5 KB saves 14–27 s (7–13 ms a save, emulator), 15 MB in one transaction
  0.23–0.9 s. **iOS not tested** (needs a Mac).
- **…but webview storage is best-effort** (*web*,
  [`…-round2-phone-storage-onedrive.md`](../plans/2026-10-08-sync-research-round2-phone-storage-onedrive.md)
  §A.3): Android WebView's code always denies `persist()` (`aw_permission_manager.cc`; a WebView
  engineer, 2025-09-04: "nothing has changed here"); Capacitor's docs say the OS reclaims webview
  storage when the device runs low; a Capacitor Android app reported total data loss at ~3 % free
  space (eviction suspected, not confirmed). iOS: no Apple statement on WKWebView persistence or the
  7-day cap. Native SQLite plugins are Promise-only ("all asynchronous", Capacitor docs); wa-sqlite's
  calls return Promises too. No public report of `@sqlite.org/sqlite-wasm` on OPFS inside Capacitor
  was found (Trilium's in-repo app, above, is unreleased).
- **OneDrive from the phone** (*web*, same record §B): picking a cloud *folder* through the system
  picker isn't reliable — no source shows OneDrive/Google Drive/Dropbox supporting Android's folder
  picking; on iOS, Dropbox added folder access by 2024, OneDrive is moving to Apple's newer
  file-provider API (rollout to early November 2026); the only free Capacitor plugin that keeps a
  folder grant is `@daniele-rolli/capacitor-scoped-storage` (MIT, 0.1.0). The cloud APIs work:
  OneDrive's app folder (`/me/drive/special/approot`, `Files.ReadWrite.AppFolder`; sign-in in the
  system browser with PKCE), Dropbox's App Folder (PKCE + refresh tokens), Google's hidden app-data
  folder (native authorization on Android). On Windows, reading an online-only OneDrive file
  downloads it while the client runs; `.tmp` files are not synced.
- **Field (*web*):** no open-source tool syncs our own SQLite tables over a file, a folder and a
  server on Node plus a webview. Closest: Syncular (Apache-2.0, pre-1.0, single maintainer; its own
  server on `node:sqlite`; schema declared in its manifest; Yjs columns; no file/folder) ·
  backless-core (MIT in its tarball, repo 404; one changeset folder per device on Google
  Drive/OneDrive — our folder design, on 2023 cr-sqlite WASM) · TinyBase (MIT; replaces the data
  layer, saved to SQLite as one JSON blob). The old SQLite-client `electric-sql` package is
  deprecated (last 0.12.1, 2024-06-19: "We've rebuilt the sync engine").
- **How open-source apps sync (*web*):** none syncs the SQLite file; last write wins by timestamp
  is the default. **Actual Budget** (MIT) — per-cell messages stamped with an HLC applied to its
  own SQLite tables (better-sqlite3 on desktop), a merkle trie to find divergence, a thin
  store-and-forward server (`@actual-app/sync-server`); `@actual-app/crdt` 3.1.3 is MIT but "at your
  own risk" outside Actual. **Trilium** (AGPL — design only) runs its whole server in a web worker
  on the official SQLite WASM over `opfs-sahpool` in an in-repo, unreleased Capacitor app — our
  planned phone shape.
- **Non-SQLite databases (*web*):** none beats SQLite + our own change log for an existing
  relational schema; each serious one (TinyBase, RxDB free, CouchDB/PouchDB, PGlite, LiveStore,
  Automerge-repo) means rewriting the schema, every query and the data layer, and most make it
  async. RxDB's free tier caps open collections at 13; Realm's Device Sync ended 2025-09-30;
  SurrealDB's engine is BUSL; Couchbase's source is BSL.
- **Phone → laptop over the internet (*web*):** every zero-setup path needs a public machine
  someone runs (a rendezvous and a relay). Built-in, open source: mDNS + a QR code on the same
  Wi-Fi; WebRTC data channels with our own signalling and coturn (werift in Node, MIT); iroh (native
  plugins). Separate programs: Syncthing (MPL-2.0) as a folder transport; Headscale (BSD-3).
  Excluded as closed services: ngrok, Cloudflare Tunnel, Tailscale's own coordination, ZeroTier's
  controller.

**The sync product, built** (2026-10-08 — the design:
[`docs/plans/2026-10-08-sync-product-design.md`](../plans/2026-10-08-sync-product-design.md); the
order of work and its status:
[`docs/plans/2026-10-08-sync-and-quasar-program.md`](../plans/2026-10-08-sync-and-quasar-program.md)):
the engine is its own repo, `../just-sqlite-sync` (`@delebash/sqlite-sync`), and its facts —
convergence runs, the change file, both SQLite adapters, the Android 16 emulator and iOS 18.7
simulator runs — live in that repo's `docs/dev/RESEARCH.md`; JustWrite's side in JustWrite's
register, "Sync".

**The phone's in-app server, measured** (*measured*, 2026-10-08/09 — the plan:
[`docs/plans/2026-10-08-the-phone.md`](../plans/2026-10-08-the-phone.md)):
- Real Fastify 5 runs in a browser worker, answering through `inject`, when bundled with esbuild,
  `esbuild-plugins-node-modules-polyfill` and these stand-ins (`server/src/platform/worker/shims/`):
  `http.ServerResponse` as an old-style constructor (light-my-request calls
  `ServerResponse.call(this)`; unenv's is a class), `serverFactory` returning a never-listening
  EventEmitter (Fastify builds an http server at construction), `diagnostics_channel.tracingChannel`,
  `async_hooks.AsyncResource`, `setImmediate`, `assert` as the CommonJS `assert` package (find-my-way
  calls it through require), `perf_hooks` as the platform's own `performance` (the polyfill copies
  `now` unbound: "Illegal invocation" in reply timing), `crypto` from Web Crypto (the polyfill is
  3.8 MB). `inject`'s `signal` needs `stream.addAbortSignal`, which the polyfill lacks — the runtime
  ends the response stream instead.
- JustWrite's phone bundle: 9.5 MB with sync and the online AI stack; boot to the first answer
  ≈ 0.3 s in Chrome.
- linkedom 0.18.13 answers `getAttribute("class")` with `""` for a missing attribute (the DOM says
  null; TipTap reads null) and lists attributes in another order than happy-dom; with the first
  fixed, TipTap's conversion gives the same documents on every tutorial scene.
- A partial WebView's DevTools: Playwright's connectOverCDP fails ("Browser context management is not
  supported"); plain CDP over the page's socket works, and a dedicated worker is reached through the
  page's session (`Target.setAutoAttach`, flatten), not its own /json entry (that hangs).
- Android: a worker's plain-HTTP call from `https://localhost` needs `allowMixedContent` and a network
  config allowing cleartext (it can't name private ranges); `@capacitor/barcode-scanner` 3.1 needs
  minSdk 26.

**Quasar for the family, measured** (*measured*, 2026-10-08 — the template, `template/`, built and
run on this machine; the rules it led to are `docs/app-structure.md` §Q). This answers the "Not
verified" line above:
- `app://` works with Quasar's Electron build: the packaged app loaded `app://familytemplate`
  through the kit's `runDesktopApp`, Quasar's UI rendered, `window.appShell` was present, a fetch
  to the server answered, zero console errors. Dev mode ran the server from source on
  `<repo>/data`.
- A `file:` kit dependency in the packaged app works once `extendElectronPackageJson` makes the
  `file:` paths absolute (Quasar copies them unchanged two folders down) and
  `unPackagedInstallParams: ['install', '--install-links']` installs real copies.
- Biome lints a Quasar app with a `**/*.vue` override (`noUnusedImports` and
  `noUndeclaredVariables` off — template-blind).
- Quasar's default CSP `<meta>` blocks the renderer → server path; `connect-src 'self' http:
  https:` fixes it.
- npm 11.17 with an `allow-scripts` line in `~/.npmrc`: a project install without `allowScripts`
  in its `package.json` fails `EALLOWSCRIPTS`; `npm run` passes the setting to children as
  `npm_config_allow_scripts`, so `npm run build` failed at Quasar's `UnPackaged` install until
  `quasar.config.js` deleted that variable (then the installer built).
- The template's Android build (`quasar build -m capacitor -T android`) ran on the Android 16
  emulator. An App Extension installed through `file:` was not tested (the family doesn't use one).

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
