# The family's servers move to Hono — one server that runs in Node and in a worker (plan, 2026-10-09)

**Status:** DECIDED 2026-10-09 (the kit's TASKS, "The family's servers move to Hono"). Nothing is
coded yet. The feasibility pass (§4) found no blocker. **Before slice 1, the user's word is needed
on the three NOT STANDARD pieces in §3, by name** (the global CLAUDE.md rule, added 2026-10-09:
"A NOT STANDARD piece waits for your word on that piece by name; a blanket 'your rec go' never
covers it"). Where it stands: §9.

## 1 · What it is

One rule for every family app, today's and the next one: **an app writes its screens, its routes
and its tables — nothing else.** Everything below that comes from a standard package, or from the
kit, written once.

1. **The screens:** a Quasar app — Electron mode is the desktop app, Capacitor mode the phone app,
   the SPA build what a headless server serves, the PWA mode the offline web page.
2. **The server:** a **Hono** app (routes + SQL) in the app's own server package, on SQLite.
   Hono is "built on Web Standards… The same code runs on all platforms" (hono.dev): a route gets a
   web-standard `Request` and returns a `Response`, so the same app object runs in three places:
   - **desktop** — Electron runs it in its background process (`utilityProcess`, the kit's
     `runDesktopApp`), listening through `@hono/node-server`;
   - **headless** — the same server package started alone (`<app>-server serve`), no window,
     serving the UI, the API and MCP — unchanged for the user;
   - **phone and offline web page** — the same app in a dedicated web worker on SQLite WASM; the
     kit's request door hands the screens' requests to `app.fetch(request)`. No port, and nothing
     imitates Node.
3. **Code only a computer can run** (files on disk, starting llama.cpp or the speech runtime) is
   chosen per platform through `package.json` `"imports"` conditions (`#platform/...`) — Node,
   Vite and esbuild resolve them; Actual Budget imports `#platform/server/fs` the same way. On a
   phone those routes answer "not on this device" and their screens hide. This replaces the kit's
   `.phone.js` twin plugin (`platform/worker/esbuild.js`).
4. **Sync:** `just-sqlite-sync` — through a server, a shared folder or a file, any mix (JustWrite's
   TASKS, Sync decisions 3 and 5). Unchanged except its Fastify routes (`/app`).

**Why** (the session of 2026-10-09, in short — the user's questions led each step):
- Tauri was weighed first and stays out: Quasar has no Tauri mode, and the desktop needs Node for
  the server and the runners anyway (two runtimes).
- Offline-first apps that ship one web codebase on desktop and phones run their app logic inside
  the app on every device — **Actual Budget** (MIT, 29.4k stars) is the reference and has our exact
  platform set: one core (`loot-core`) in Electron's `utilityProcess`, in a web worker
  (`backend-worker.ts`) on the browser and its Capacitor 8 phone app, and in Node for headless use
  (`@actual-app/api`), with a file per platform picked at build (`sqlite/index.electron.ts`,
  `index.api.ts`, `index.ts`) and its own CRDT sync + a thin sync server. Ours had the same shape;
  the one non-standard piece was that our core is a Fastify server, so the phone ran Fastify
  through `inject` with ~400 lines imitating Node's `http`, `crypto` and more — unsupported by
  Fastify.
- Hand-building Actual's handler layer would make every app write its logic twice (handlers +
  REST routes); oRPC adds a procedure layer whose payoff is TypeScript types. **Hono keeps REST as
  the one API and removes the imitation**, because it never needed Node.
- Yjs was weighed as the data layer and dropped for the family: it is the standard for documents,
  not for an app's whole data, and `just-sqlite-sync` already merges text through Yjs
  (`sceneTextAdapter`, JustWrite `server/src/sync.js:53`). Postgres-backed engines (PowerSync,
  ElectricSQL, Zero) were discarded in the sync research (2026-10-08) and stay out.

## 2 · The decision

The kit's TASKS item carries the user's words verbatim. As shown (the family standard):
"1. A Quasar app for the screens — Electron, Capacitor, the web, a PWA for the offline web page.
2. A Hono server package (routes + SQL) on SQLite. 3. Desktop: Electron runs the server in its
background process. Headless: the same server, no window. Phone and offline web page: the same
server in a worker. 4. Computer-only modules chosen through `#platform` imports; on a phone those
routes answer 'not on this device' and their screens hide. 5. Sync through `just-sqlite-sync` —
server, folder, file." The user: "your rec lets do it keeep working until the conversion is done,
only stop if you need a major decision from me make hono the standard".

## 3 · Each piece — standard, or NOT STANDARD

| Piece | Standard it follows |
|---|---|
| Screens, desktop/phone/web/PWA builds | Quasar's modes (quasar.dev, developing-electron-apps, -capacitor-apps, -pwa) |
| The server framework | Hono 4.13.13 (MIT, 73M downloads/week), hono.dev/docs |
| Listening on Node (desktop, headless) | `@hono/node-server` 2.1.4 (MIT, 67.7M/week) — `serve()`; `serveStatic` (handles `Range`); `getConnInfo` for the client address |
| Running in the worker | `app.fetch(request)` — Hono's own entry point (hono.dev "Service Worker" page shows Hono in the browser) |
| Streams (AI answers, task progress) | Hono's `streamSSE` / `stream` helpers |
| MCP | the official SDK's `webStandardStreamableHttp.js` (in `@modelcontextprotocol/sdk` 1.32.1) through `@hono/mcp` 0.3.2 (MIT, 417k/week) |
| Body size limits | `hono/body-limit` |
| CORS | `hono/cors` (the kit's CSRF/origin rules stay ours, as today) |
| Large uploads streamed (backup restore) | busboy (`@fastify/busboy` 3.2.2, MIT, 36.7M/week — framework-free) on the Node request (`c.env.incoming`) |
| Tests | Hono's `app.request()` (hono.dev "Testing") in place of Fastify's `inject` |
| Per-platform modules | `package.json` `"imports"` conditions (Node subpath imports) |
| Validation | **open — §5** |
| **NOT STANDARD — the request door** | the kit's transport (`ui/src/common/services/transport.js`, 118 lines) + the worker side of `platform/worker/runtime.js`: carries a `Request` into the worker and the `Response` (streamed) back. Every app of this shape has one (Actual: `platform/client/connection`). **Needs the user's word by name.** |
| **NOT STANDARD — SQLite in WASM with better-sqlite3's API** | `platform/worker/better-sqlite3.js` (152 lines) over the official `@sqlite.org/sqlite-wasm` (`opfs-sahpool`), so `platform/sql.js` and every route run unchanged in the worker. **Needs the user's word by name.** |
| **NOT STANDARD — the validation glue (if §5 option a)** | ~20–30 lines joining Hono's `validator()` to ajv. **Needs the user's word by name.** |
| Our own, already decided by name | `just-sqlite-sync` (JustWrite's TASKS, Sync decision 5: "we can also write our own…") |
| Our own, existing, out of this change | the kit's Electron shell (`runDesktopApp` — Quasar documents no server start); `platform/sql.js`; the error envelopes in pydantic/FastAPI's shapes (`platform/errors.js`) — the apps' wire contract, carried unchanged |

## 4 · The feasibility pass — every Fastify feature in use, and its Hono answer

Counted 2026-10-09 (`grep -rEo` over `*.js`, node_modules excluded):

```
just-llm-runner/server/src:  reply.raw=1 req.raw=1 hijack(=1 addHook(=6 setErrorHandler=2 setNotFoundHandler=2
  addContentTypeParser=4 schema:=70 reply.code(=13 reply.header(=2 reply.headers(=3 .inject(=1 @fastify/multipart=1
  req.parts(=1 bodyLimit=2 .listen(=2 serverFactory=3 routeOptions|routerPath|routeConfig=7 req.ip|req.socket=4
  req.hostname|req.protocol=1 reply.getHeader=2 text/event-stream=2
JustVioce/server/src:  reply.raw=8 req.raw=3 hijack(=2 addHook(=4 decorate(=1 addContentTypeParser=1 prefix:=2
  schema:=89 reply.code(=24 reply.header(=2 reply.type(=11 reply.redirect(=2 @fastify/static=5 @fastify/multipart=2
  req.parts(=1 .listen(=1 req.ip|req.socket=2 reply.getHeader=1 StreamableHTTPServerTransport=3 text/event-stream=2
justwrite-app/server/src:  addHook(=4 prefix:=1 schema:=17 reply.code(=21 reply.header(=1 reply.type(=1
  reply.redirect(=1 @fastify/static=3 serverFactory=2
just_ai_i18n_docgen/server:  reply.raw=1 hijack(=1 setErrorHandler=2 prefix:=17 schema:=25 reply.code(=2
  reply.type(=1 .inject(=2 @fastify/static=3 reply.getHeader=1 text/event-stream=1
just-sqlite-sync/src:  addContentTypeParser=1 schema:=4 reply.code(=1 reply.header(=1 reply.type(=1 bodyLimit=5
  req.ip|req.socket=3
template/server:  prefix:=1 @fastify/static=3
```

| Fastify | Hono |
|---|---|
| `reply.code/header/type/send`, `reply.redirect` | `c.json(x, status)`, `c.header()`, `c.body()`, `c.redirect()` |
| `addHook` onRequest / preHandler / onResponse | middleware (`app.use`), code after `await next()` for onResponse |
| `onClose` hook | the kit's shutdown path (`serve()` returns the Node server; close it, then the app's close hooks) |
| `setErrorHandler`, `setNotFoundHandler` | `app.onError`, `app.notFound` — feeding the same envelopes (`platform/errors.js`) |
| `register(plugin, { prefix })` | `app.route(prefix, subApp)` |
| `decorate` | `c.set/c.get` (context variables) |
| `addContentTypeParser` (raw bodies: sync change files, octet-stream) | `c.req.arrayBuffer()` / `c.req.text()` in the route |
| `bodyLimit` | `hono/body-limit` |
| `reply.raw.write` / `hijack` (SSE, streams) | `streamSSE` / `stream`; a Node stream → `Readable.toWeb` |
| `@fastify/static` (the UI build, JustVoice's `/legacy/`) | `serveStatic` from `@hono/node-server` (Range supported — its source has a `RANGE_PATTERN`) |
| `@fastify/multipart` (`req.parts()`: the kit's data restore, JustVoice's captures) | busboy over `c.env.incoming` (streamed; the restore takes files of any size) |
| `req.ip`, `req.socket`, `hostname/protocol` | `getConnInfo(c)` (`@hono/node-server/conninfo`), `new URL(c.req.url)` |
| `routeOptions.url` / `routerPath` | `c.req.routePath` |
| `serverFactory` (the phone's never-listening server) | not needed — `app.fetch` |
| `inject` (the worker runtime; tests: kit 137 calls in 38 files, JustVoice 10 in 9, JustWrite 2 in 2, docgen 2 in 2, sync 9 in 1) | `app.fetch` in the worker; `app.request()` in tests |
| MCP over `StreamableHTTPServerTransport` with `req.raw`/`reply.raw` | `@hono/mcp`'s `StreamableHTTPTransport` on the SDK's web-standard transport |
| The request-body float opt-in (`pyFloats`, `platform/server.js:36`) | the same logic in the body-reading middleware |
| `schema:` (~405 blocks: kit 38 body/23 headers/18 params/24 querystring/1 response · JustVoice 80/11/13/17 · JustWrite 25 body/2 querystring · docgen 15/10/8/1 · sync 5/7) | §5 |

No `Range` serving in any route (only the runner's download client reads `Content-Range`), no
WebSockets, one `response:` schema (kit).

## 5 · The one open technical choice — validation

Fastify validates with ajv using `coerceTypes: 'array', useDefaults: true, removeAdditional: true,
allErrors: false` (`@fastify/ajv-compiler` 4.0.6 `lib/default-ajv-options.js`), and the kit turns
ajv's errors into pydantic's shapes (`platform/errors.js` `ajvToPydantic`) — that 422 body is the
apps' wire contract.

- **a · Hono's documented `validator()` + ajv with exactly those options** — identical behaviour
  (querystring/params strings coerced to numbers and booleans, defaults filled, extra fields
  removed) and identical error bodies; `errors.js` unchanged; the glue (~20–30 lines, one
  `schema({ body, querystring, params, headers })` middleware in the kit) is ours → NOT STANDARD.
  **Lean.**
- **b · `@hono/typebox-validator` 1.1.0** (honojs/middleware, MIT, peer `typebox ^1.0.30` — ours is
  1.3.36; 18.6k/week). Its source: `Compile(schema)`, optional `Clean`, `Errors` — **no `Convert`,
  no `Default`**, so every querystring/param number or boolean and every body default changes
  behaviour, and `errors.js` needs a new mapping for TypeBox's errors.
- Out: `@hono/ajv-validator` 0.0.2 (3 downloads/week).

## 6 · Blast radius (pasted, 2026-10-09)

Files importing Fastify packages directly (src):
```
just-llm-runner/server/src/platform/data_api.js
just-llm-runner/server/src/platform/server.js
just-llm-runner/template/server/src/app.js
JustVioce/server/src/api/captures_api.js
JustVioce/server/src/app.js
justwrite-app/server/src/app.js
just_ai_i18n_docgen/server/src/app.js
```
Tests importing Fastify: `just-sqlite-sync/tests/app.test.js`, `just-sqlite-sync/tests/http.test.js`.

Files registering routes: kit 26 · JustVoice 42 · JustWrite 14 · docgen 5 · sync 2 · template 1.
Routes: JustVoice 190 · kit 119 · JustWrite 52 · docgen 32.

Every caller of the server hub:
```
just-llm-runner/server/src/platform/serve.js:62:    await app.listen({ host, port });
just-llm-runner/server/src/platform/server.js:87:export function createServer({
JustVioce/server/src/app.js:262:  const app = createServer({ typeBase: TYPE_BASE, onUnhandled: errorEnvelope, pyFloats: { routes: PY_FLOAT_ROUTES } });
justwrite-app/server/src/app.js:154:  const app = createServer({ typeBase: TYPE_BASE, onUnhandled: errorEnvelope });
justwrite-app/server/src/phone.js:75:  const app = createServer({ typeBase: TYPE_BASE, onUnhandled: errorEnvelope, serverFactory });
just_ai_i18n_docgen/server/src/app.js:465:  const app = createServer({ errors: "fastapi" });
just-llm-runner/template/server/src/app.js:22:  const app = createServer({ typeBase: TYPE_BASE });
```
The phone's worker layer that changes or goes (`server/src/platform/worker/`, 745 lines):
`shims/` 406 (http 194, async_hooks 52, undici 49, crypto 41, diagnostics_channel 36, url 15,
perf_hooks 8, globals 6, https 5) — mostly go; `runtime.js` 122 — `inject` → `app.fetch`;
`better-sqlite3.js` 152 — stays; `esbuild.js` 65 — the `.phone.js` plugin → `#platform` imports.

The wire contract every client depends on — status codes, JSON bodies, the 422/500 envelopes,
SSE frames, headers (CSRF, auth tokens, `Content-Disposition` via `attachment()`) — must be
byte-identical after each slice; each app's route tests are the proof.

## 7 · Order of work

Each slice ends green (its repo's suites, lint, the family guard) and committed.

0. **The user's word on §3's three NOT STANDARD pieces and §5.**
1. **The kit's server hub** — `platform/server.js` on Hono with the same options (`typeBase`,
   `onUnhandled`, `errors: "fastapi"`, `pyFloats`), the envelopes on `onError`/`notFound`, the
   CSRF/auth/origin middleware, validation (§5), body limits; `platform/serve.js` on
   `@hono/node-server`; `data_api.js`'s restore on busboy. Then the kit's 26 route files and its
   38 test files (`app.request`).
2. **`just-sqlite-sync`'s `/app`** (2 route files, 2 test files).
3. **The template** (`template/server`).
4. **JustWrite** — 14 route files; the phone: `runtime.js` on `app.fetch`, the shims that are no
   longer needed deleted, `#platform` imports in place of the `.phone.js` plugin; checked on the
   Android 16 emulator (the tutorial book, an image, sync with the computer, an AI stream).
5. **docgen** — 5 route files.
6. **JustVoice** — 42 route files, MCP on `@hono/mcp`, captures' multipart.
7. **The rules** — `docs/app-structure.md` §Q (the server package on Hono), `scripts/check-family.js`
   (a server package depends on `hono`, not `fastify`), each CLAUDE.md ("Fastify" → "Hono"), the
   global CLAUDE.md Stack line (shown to the user first), RESEARCH.

## 8 · Checks

Per app: its server tests (JustVoice 1055, JustWrite 141, docgen 161 — the last known counts),
unit tests, lint, the guard, the renderer smoke on the app's real data (CLAUDE.md's gate recipe),
e2e where the app has one; one packaged installer + the headless launcher per app; JustWrite's
phone on the emulator. A route's answer compared before/after on the same database for every
route a test doesn't cover.

## 10 · The conversion rules (a Fastify route → a Hono route)

The kit's hub (`server/src/platform/server.js`) gives every app: `createServer(opts)` (a Hono app
with the family's error answers), `input({params, body, querystring, headers, pyFloats})` (the
family's request pipeline as one route middleware — Fastify's FastAPI-compatible reading,
conversion and ajv validation; the result read with `c.req.valid(...)`), `readJson(c)` (a JSON body
by the same rules, for a route with no body schema), `onClose(app, fn)` / `closeApp(app)`, and
`attachment(name)`. Apps import them from `@delebash/llm-runner/platform` (or `/platform/server`).
The middleware: `csrfOrigin`, `starletteCors`, `bearerAuth` (`clientHost(c)` in `platform/auth.js`).

**One Hono for the family: an app imports `Hono` and `stream` from the kit**
(`import { Hono, stream } from "@delebash/llm-runner/platform"`), never from `"hono"`. The kit is
linked into each app (`file:`), so an app's own `hono` is a second copy, and Hono's `app.route()`
recognises a sub-app's default error handler by identity (`hono-base.js` `route()`:
`app.errorHandler === errorHandler`) — a sub-app built from another copy answers its errors with
Hono's plain 500 instead of the family's envelopes. (Found 2026-10-09 while converting the kit.)
A package that must not depend on the kit (`just-sqlite-sync`) adds its routes to the app it is
given and creates no Hono of its own.

**A router** is a factory that returns a Hono sub-app; the host mounts it with `app.route()`:
```js
// Fastify                                         // Hono
export function makeXRouter(deps) {                export function makeXRouter(deps) {
  return async function xRouter(app) {               const app = new Hono();
    app.get("/v1/x/:id",                             app.get("/v1/x/:id",
      { schema: { params: P, querystring: Q } },       input({ params: P, querystring: Q }),
      async (req, reply) => { … });                    async (c) => { … });
  };                                                 return app;
}                                                  }
app.register(makeXRouter(deps));                   app.route("/", makeXRouter(deps));
app.register(r, { prefix: "/p" });                 app.route("/p", r);
export async function router(app) { … }           export function router() { const app = new Hono(); …; return app; }
```
Hono runs middleware in the order added and copies a sub-app's routes when it is mounted: **an app
adds its middleware (`app.use("*", …)`) before it mounts its routers**, and a router is complete
before it is mounted.

**Route options** `{ schema: { params, body, querystring, headers }, config: { pyFloats: true } }`
→ `input({ params, body, querystring, headers, pyFloats: true })` (same property names). No schema →
no `input`.

**Inside a handler** `(req, reply)` → `(c)`:

| Fastify | Hono |
|---|---|
| `req.params` with a params schema | `c.req.valid("param")` |
| `req.params.x` without | `c.req.param("x")` |
| `req.query` with a querystring schema | `c.req.valid("query")` |
| `req.query.x` without | `c.req.query("x")` (a repeated key: `c.req.queries("x")`, all values) |
| `req.body` with a body schema | `c.req.valid("json")` |
| `req.body` without | `await readJson(c)` |
| `req.sentBody` | `c.get("sentBody")` |
| `req.headers.foo` / `req.headers` | `c.req.header("foo")` / `c.req.header()` |
| `req.method` | `c.req.method` |
| `req.url` (path + query) | `c.req.path` (+ `new URL(c.req.url).search`) — `c.req.url` is the whole URL |
| `req.ip` / `req.socket.remoteAddress` | `clientHost(c)` (`platform/auth.js`) |
| `req.raw` (Node's request) | `c.req.raw` (the web Request); Node's own only as `c.env.incoming` (Node only — never on the phone) |

**Answers** — every return path returns a Response:

| Fastify | Hono |
|---|---|
| `return obj` (object, array, number, boolean, null) | `return c.json(obj)` |
| `return "text"` | `return c.text("text")` |
| `reply.code(n); return obj` · `reply.code(n).send(obj)` · `reply.status(n).send(obj)` | `return c.json(obj, n)` |
| `reply.code(204).send()` | `return c.body(null, 204)` |
| `reply.type(t).send(x)` | `return c.body(x, 200, { "Content-Type": t })` |
| `reply.header(k, v)` · `reply.headers({…})` | `c.header(k, v)` before the return (or the headers argument) |
| `reply.redirect(url[, code])` | `return c.redirect(url[, code])` |
| `reply.send(buffer)` | `return c.body(buffer, 200, { "Content-Type": "application/octet-stream" })` (or the type the route set) |
| `reply.send(nodeReadable)` | `return c.body(Readable.toWeb(stream), …)` |
| `reply.hijack()` + `reply.raw.writeHead/write/end` (SSE, streams) | `stream(c, async (s) => { await s.write(…) })` from `hono/streaming`, headers set with `c.header()` first; a client gone: `s.onAbort(…)` / `s.aborted` |
| a thrown `ApiError` / `HttpError` / `RequestValidationError` | unchanged |

**Hooks:** `addHook("onRequest" | "preHandler", fn)` app-wide → `app.use("*", async (c, next) => { …;
await next(); })` added before the routes · `addHook("onResponse", fn)` → the same, `fn` after
`await next()` · `addHook("onClose", fn)` → `onClose(app, fn)` (run when the server stops, the last
added first, as Fastify) · `decorate` → a variable in scope, or `c.set`/`c.get` · a Fastify plugin
that only added hooks → its middleware.

**Tests:** `app.inject({ method, url, payload, headers, remoteAddress })` →
`app.request(url, { method, body: JSON.stringify(payload), headers: { "content-type": "application/json", …headers } }, remoteAddress ? { incoming: { socket: { remoteAddress } } } : undefined)`
(a string payload with no content type goes as BYTES — `new TextEncoder().encode(s)` — because
`new Request` gives a string body `text/plain;charset=UTF-8` by itself, which the family rules read
as text, where inject sent none and it was read as JSON) · the client address: inject defaulted to
`127.0.0.1`, `app.request` has no socket (`clientHost(c)` is ""), so a test that relied on loopback
passes `{ incoming: { socket: { remoteAddress: "127.0.0.1" } } }` · `r.statusCode` →
`r.status` · `r.json()` → `await r.json()` · `r.body` / `r.payload` → `await r.text()` ·
`r.headers["x"]` → `r.headers.get("x")` · `app.ready()` → nothing · `app.close()` → `closeApp(app)`
where close hooks matter · a router: `app.route("/", makeXRouter(…))` after any middleware.

## 9 · Where it stands

- 2026-10-09: decided; this plan written; the feasibility pass done (§4). The user's word on §3/§5:
  "your rec on all go" (the door yes, the SQLite-WASM wrapper yes, validation a).
- Slice 1 DONE — the kit: `platform/server.js` (createServer, `input`, `readJson`, `onClose` /
  `closeApp`, the re-exported `Hono` / `stream`), `errors.js` (onError / notFound),
  `serve.js` (`@hono/node-server`, `serveStatic` re-exported), `auth.js` / `cors.js` / `csrf.js`
  (`bearerAuth`, `starletteCors`, `csrfOrigin`), every router a Hono sub-app (`llm/`, `runner/`,
  `platform/`), the SSE stream on `stream`, the restore on busboy, the worker runtime on
  `app.fetch`; `fastify` and `@fastify/multipart` out of its package; its tests on `app.request`
  (1,136 passed, 2 expected fail, 12 skipped). The validation glue is a plain Hono middleware
  (`input`), not Hono's `validator()`: `validator("json")` ignores a body with no JSON content
  type and answers bad JSON with a 400 (RESEARCH §2), where the contract is FastAPI's (no type →
  JSON; bad JSON → 422 with its position). It carries Fastify's FastAPI-compatible hooks
  (~100 lines, moved from the old `createServer`), not 20–30 new ones.
- Found while converting: **one Hono** (§10 — `app.route()` and a second copy of Hono), recorded
  in §10, app-structure §Q.3 and the guard (`checkOneHono`); route order (a fixed segment must be
  added before a `:param` one that also matches).
- Slice 2 DONE — `just-sqlite-sync`: `src/transports/hono.js` (`registerSyncRoutes(app, …)` on the
  app's own Hono), `appSync.routes(app)`, `createAppSync({ readJson })`; `./fastify` → `./hono`;
  47/47.
- Slice 3 DONE — the template on Hono (`app.use` guards, `serveStatic` from the kit).
- Slice 4 DONE — JustWrite: 14 routers, `app.js`, `phone.js`, `sync.js`, the error envelope,
  the test client on `app.request` (148/148); the phone versions chosen by `server/package.json`
  `"imports"` (`#app_state`, `#api/autosave_api`, `#database/demo_seed`, `#editor/html`,
  `#sync_platform`) and the kit's `#runner/lifecycle` — the kit's twin plugin and six Fastify-only
  stand-ins deleted; the phone bundle 8.0 MB; checked in Chrome on `dist/spa-in-app` (the book,
  an image, an AI stream) and on the Android 16 emulator (the debug APK: the tutorial book made
  through the UI, kept across a force-stop, an AI answer through native HTTP from a provider that
  refuses a webview's call).
- Slice 5 DONE — docgen (a helper agent): 4 routers, `app.js` (FastAPI errors + its envelope as
  `onUnhandled`), the SSE jobs stream, the static UI behind a 405 route, the test client (161/161).
- Slice 6 DONE — JustVoice (a helper agent): 40 routers, `app.js` (the guards, the MCP stamp and
  the sync flush as middleware before the routers; `serverHandle` through `c.set`), MCP on the
  SDK's own `WebStandardStreamableHTTPServerTransport` (the SDK's Node transport is that class
  behind `@hono/node-server`, so not `@hono/mcp`), the SSE streams on `stream`, the captures /
  align / voice-bundle / import uploads on busboy, the static UI and `/legacy/` with `app.get`, the
  test helpers on `app.request` (1,061/1,061; run again here). Fixed vs `:param` pairs checked on
  the built app (340 routes): three, all already in Fastify's order. One timing difference, not on
  the wire: the sync flush after a STREAMED answer runs when the route returns, before the stream
  ends (Fastify's onResponse ran after it) — changes written during the analyze stream are stamped
  by the next mutating request or the next sync, in the order they were made.
- Slice 7 DONE — app-structure §Q.3, the kit's READMEs, the guard's `checkOneHono` (proven to fire
  on a probe), every app's CLAUDE.md / README / ARCHITECTURE lines.
- **The conversion is complete.** Not run: a packaged installer and the headless launcher per app
  (§8) — the suites, the in-app and emulator checks and JustVoice's real-socket run cover the
  server; the packaging is unchanged by this move.
- Repos at the start: kit `main` clean, 47 commits ahead of origin; JustVoice `main` clean, pushed;
  JustWrite `master` clean, 32 ahead; docgen `main` 9 ahead (`out/` untracked, left alone);
  `just-sqlite-sync` 1 ahead with `biome.json` modified (not this session's — left alone).
- The phone's slice 5 (its screens) was in progress on 2026-10-09 (the program doc); this change
  touches only its server side.
