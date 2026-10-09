// SPDX-License-Identifier: MIT
// The engine-cache router (llm/cache_api.js) on its own. Not a Python test file: Python
// checks this router inside tests/test_shared_cache.py with a real RunnerService (that file
// is the integrator's, wave 4). Here the runner service and installLlm's resolveCacheRoots
// are fakes through `cacheApi.deps` (`runner/lifecycle.js` is not ported yet), and the
// family registry lives in a temp JUST_AI_HOME — never the machine's real one.
//
// The scenarios mirror test_shared_cache.py's four router tests. Its
// `the_wizard_is_offered_the_way_back` FAILS in Python today (2026-10-07): its fixture puts
// the model file at `hf/models--org--big/blob`, outside `snapshots/`, which `summarize` has
// not counted since 2026-10-06 — so `current.models` is []. The fixture below puts it in
// `snapshots/`, where a real download lands.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import * as cacheApi from "../src/llm/cache_api.js";
import * as stores from "../src/llm/stores.js";
import { RuntimeError } from "../src/platform/py.js";
import { createServer } from "../src/platform/server.js";
import * as cacheRegistry from "../src/runner/cache_registry.js";
import { freshDb } from "./helpers.js";

let tmp;
let wired;

/** The runner service's cache surface (Python's RunnerService.cache_root/runtime_root/
 * repoint_cache), with its busy refusal. */
class FakeService {
  constructor(cacheRoot, runtimeRoot) {
    this.cacheRoot = cacheRoot;
    this.runtimeRoot = runtimeRoot;
    this.busy = false;
  }
  repointCache(cacheRoot, runtimeRoot = null) {
    if (this.busy) throw new RuntimeError("the engine is running — unload the model first, or restart the app to apply this");
    this.cacheRoot = cacheRoot;
    this.runtimeRoot = runtimeRoot || join(cacheRoot, "llamacpp");
  }
}

/** installLlm's resolveCacheRoots, as Python wrote it (llm/install.py). */
function resolveCacheRoots(dataDir = null, cacheRoot = null, stored = "") {
  const own = dataDir ? join(dataDir, "ai-cache") : null;
  const chosen = cacheRoot || stored || null;
  const root = chosen ? chosen : own;
  const shared = !!(root && own && !cacheApi.samePath(root, own));
  const runtime = shared && dataDir ? join(dataDir, "ai-runtime") : null;
  return [root, runtime, shared];
}

beforeEach(() => {
  freshDb();
  tmp = mkdtempSync(join(tmpdir(), "kit-cache-api-"));
  vi.stubEnv("JUST_AI_HOME", join(tmp, "family"));
  // A configured service whose cache is a sibling's — the post-share state.
  const shared = join(tmp, "jw", "ai-cache");
  mkdirSync(join(shared, "hf", "models--org--big", "snapshots", "abc"), { recursive: true });
  writeFileSync(join(shared, "hf", "models--org--big", "snapshots", "abc", "m.gguf"), "x".repeat(9000));
  mkdirSync(join(shared, "llamacpp", "b10107"), { recursive: true });
  const svc = new FakeService(shared, join(tmp, "mine", "ai-runtime"));
  vi.spyOn(cacheApi.deps, "getService").mockImplementation(async () => svc);
  vi.spyOn(cacheApi.deps, "resolveCacheRoots").mockImplementation(async (...a) => resolveCacheRoots(...a));
  wired = { shared, dataDir: join(tmp, "mine"), svc };
});

function client(product = "Mine") {
  const app = createServer({ typeBase: "https://example.test/errors/" });
  app.route("/", cacheApi.makeCacheRouter(wired.dataDir, product));
  return app;
}
const getState = async (app) => (await app.request("/v1/ai/engine-cache")).json();
const put = (app, payload) =>
  app.request("/v1/ai/engine-cache", { method: "PUT", body: JSON.stringify(payload), headers: { "content-type": "application/json" } });

test("router: the wizard is offered the way back", async () => {
  cacheRegistry.register("JustWrite", wired.shared, join(tmp, "jw"));
  const body = await getState(client());
  expect(body.shared).toBe(true);
  expect(cacheApi.samePath(body.root, wired.shared)).toBe(true);
  expect(cacheApi.samePath(body.runtimeRoot, join(wired.dataDir, "ai-runtime"))).toBe(true);
  expect(body.current.models).toEqual(["org/big"]);
  expect(body.current.product).toBe("JustWrite"); // a shared cache in use is named after its app
  expect(Object.keys(body)).toEqual(["root", "ownRoot", "runtimeRoot", "shared", "stored", "current", "options"]);
  // "keep my own" is always an option, even though that directory doesn't exist yet.
  expect(body.options.map((o) => o.root)).toEqual([cacheRegistry.pyPath(join(wired.dataDir, "ai-cache"))]);
  expect(body.options[0].product).toBe("this app");
  expect(body.options[0].exists).toBe(false);
  // And a cache already in use is never offered as something to switch to.
  expect(body.options.every((o) => !cacheApi.samePath(o.root, wired.shared))).toBe(true);
});

test("router: your own cache is offered once even after you start sharing", async () => {
  // Seen live: the app's own row is still in the registry from boot, so excluding only the
  // cache IN USE listed "keep my own" twice.
  mkdirSync(join(wired.dataDir, "ai-cache"), { recursive: true });
  cacheRegistry.register("Mine", join(wired.dataDir, "ai-cache"), wired.dataDir);
  cacheRegistry.register("JustWrite", wired.shared, join(tmp, "jw"));
  const roots = (await getState(client())).options.map((o) => o.root);
  expect(roots).toEqual([cacheRegistry.pyPath(join(wired.dataDir, "ai-cache"))]);
});

test("router: switching applies live while the engine is idle", async () => {
  // A choice recorded but not applied would be contradicted by the very download the wizard
  // starts next — so idle means apply now.
  const r = await put(client(), { root: join(wired.dataDir, "ai-cache") });
  const body = await r.json();
  expect(body).toEqual({
    ok: true,
    root: cacheRegistry.pyPath(join(wired.dataDir, "ai-cache")),
    applied: true,
    restartRequired: false,
    detail: "",
  });
  expect(cacheApi.samePath(wired.svc.cacheRoot, join(wired.dataDir, "ai-cache"))).toBe(true);
  // "my own cache" is stored as the ABSENCE of a choice
  expect(stores.getRunnerConfigStore().getCacheRoot()).toBe("");
  expect(stores.getRunnerConfigStore().cacheRootChosen()).toBe(true);
});

test("router: switching under a live engine waits for a restart", async () => {
  wired.svc.busy = true;
  const body = await (await put(client(), { root: join(wired.dataDir, "ai-cache") })).json();
  expect(body.applied).toBe(false);
  expect(body.restartRequired).toBe(true);
  expect(body.detail).toContain("unload");
  expect(cacheApi.samePath(wired.svc.cacheRoot, wired.shared)).toBe(true); // unchanged under a running engine
});

test("router: a sibling choice is stored and a relative path is refused", async () => {
  const app = client();
  let r = await put(app, { root: "relative/cache" });
  expect(r.status).toBe(400);
  expect((await r.json()).detail).toBe("cache root must be an absolute path");
  const elsewhere = join(tmp, "other", "ai-cache");
  r = await put(app, { root: ` ${elsewhere} ` });
  expect((await r.json()).applied).toBe(true);
  expect(stores.getRunnerConfigStore().getCacheRoot()).toBe(elsewhere); // stored as typed (trimmed)
  const state = await getState(app);
  expect(state.stored).toBe(elsewhere);
  expect(state.shared).toBe(true);
});
