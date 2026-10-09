// SPDX-License-Identifier: MIT
// Port of tests/test_shared_cache.py — one engine + model cache for the whole family, chosen,
// never assumed (2026-08-03).
//
// Measured on the author's box: JustWrite and just_ai_i18n_docgen each kept their own
// `<data>/ai-cache`, so the SAME artifact sat on disk twice — `unsloth/
// gemma-4-26B-A4B-it-qat-GGUF @ UD-Q4_K_XL`, snapshot `7b92b5b2…`, 14,249,047,104 bytes in
// both — plus two llama.cpp installs. User ruling: detect an existing family cache during
// Quick Setup and ASK, with an override for an app that wants its own.
//
// The trap guarded here is the SECOND half. Sharing the cache naively also shares
// `models.ini`, which each app RENDERS FROM ITS OWN CATALOGUE — so app B's emit overwrites
// app A's. The split (`cacheRoot` shared, `runtimeRoot` private) is what makes sharing safe,
// and it must stay invisible to an app that shares nothing.
//
// Paths: Python compared `Path` objects; the JS compares strings in pathlib's normal form
// (`pyPath`) — or, where a Path came back from JSON, with `samePath` (pathlib's ==). The
// engine-cache router's lazy `deps` reach the REAL runner service (`lifecycle.state.service`,
// restored after each test) and the real `resolveCacheRoots` here; tests/cache_api.test.js
// checks the same router against fakes.
//
// FAILING IN PYTHON TODAY, failing the same way here (build sheet rule 21 — `test.fails`, so
// the suite stays green and the stale test stays visible): `discovery_reports_a_sibling_with_
// what_is_in_it` and `the_wizard_is_offered_the_way_back`. Both fixtures put the model
// somewhere other than `snapshots/` (an empty `models--…` folder; a `blob` file beside
// `snapshots/`), and since the 2026-10-06 counting change a repo counts only from a finished
// file in `snapshots/` — so `models` is [] where the tests expect the repo. Fix in both
// languages: write the file at `hf/models--<org>--<repo>/snapshots/<sha>/m.gguf`. (Build sheet
// §6 records the wizard one; the discovery one is the same cause.)
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { makeCacheRouter, samePath } from "../src/llm/cache_api.js";
import { resolveCacheRoots } from "../src/llm/install.js";
import * as stores from "../src/llm/stores.js";
import { makeDiskRouter } from "../src/platform/disk_api.js";
import { createServer } from "../src/platform/server.js";
import * as cacheRegistry from "../src/runner/cache_registry.js";
import { pyPath } from "../src/runner/cache_registry.js";
import * as lifecycle from "../src/runner/lifecycle.js";
import { RunnerService } from "../src/runner/lifecycle.js";
import { fakeRouter } from "./_lifecycle_fakes.js";

let tmp;
let savedService;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "kit-shared-cache-"));
  savedService = lifecycle.state.service;
});

afterEach(() => {
  lifecycle.state.service = savedService;
});

/** `tmp_path / a / b …` in pathlib's normal form. */
const p = (...parts) => pyPath(join(tmp, ...parts));
const readApps = (home) => JSON.parse(readFileSync(join(home, "caches.json"), "utf8")).apps;

// ── which roots an app ends up with ──────────────────────────────────────────

test("own_cache_is_the_default_and_changes_nothing", () => {
  const [cache, runtime, shared] = resolveCacheRoots(tmp);
  expect(cache).toBe(p("ai-cache"));
  expect(shared).toBe(false);
  // null → the service keeps writing models.ini + logs exactly where it always did, so an
  // existing install needs no migration.
  expect(runtime).toBeNull();
});

test("a_stored_choice_shares_the_cache_but_never_the_generated_state", () => {
  const sibling = p("other-app", "ai-cache");
  const [cache, runtime, shared] = resolveCacheRoots(p("mine"), null, sibling);
  expect(cache).toBe(sibling);
  expect(shared).toBe(true);
  // The ini + spawn logs move under THIS app's data dir — the whole point.
  expect(runtime).toBe(p("mine", "ai-runtime"));
});

test("an_explicit_argument_beats_the_stored_choice", () => {
  const [cache, _runtime, shared] = resolveCacheRoots(tmp, p("wired"), p("stored"));
  expect(cache).toBe(p("wired"));
  expect(shared).toBe(true);
});

test("choosing_your_own_path_is_not_sharing", () => {
  // Storing the app's own path explicitly must not trip the shared branch.
  const [cache, runtime, shared] = resolveCacheRoots(tmp, null, p("ai-cache"));
  expect(cache).toBe(p("ai-cache"));
  expect(shared).toBe(false);
  expect(runtime).toBeNull();
});

test("service_keeps_generated_state_out_of_a_shared_cache", async () => {
  // The bite: with models.ini left in the cache, two apps sharing one would each overwrite
  // the other's preset file.
  const sharedCache = p("shared");
  const svc = new RunnerService(sharedCache, { runtimeRoot: p("mine", "ai-runtime") });
  expect(svc.cacheRoot).toBe(sharedCache);
  expect(svc.runtimeRoot).toBe(p("mine", "ai-runtime"));

  const seen = {};
  svc._startRouter = (_exe, kw) => {
    Object.assign(seen, kw);
    return fakeRouter();
  };
  svc._findPort = (_h, port) => port;
  await svc._spawnRouter(p("llama-server.exe"), svc._configFn());

  expect(pyPath(seen.modelsPreset)).toBe(p("mine", "ai-runtime", "models.ini"));
  expect(pyPath(seen.modelsDir)).toBe(pyPath(join(sharedCache, "hf"))); // weights DO come from the shared one
});

test("an_unshared_service_writes_where_it_always_did", () => {
  const svc = new RunnerService(p("ai-cache"));
  expect(svc.runtimeRoot).toBe(p("ai-cache", "llamacpp"));
});

// ── discovery ────────────────────────────────────────────────────────────────

/** Point the registry at a throwaway home through the SAME env var a real deployment would
 * use — replacing `familyHome` would skip the write guard these tests also exercise. */
function familyHome() {
  const home = join(tmp, "family");
  vi.stubEnv("JUST_AI_HOME", home);
  return home;
}

test("an_app_registers_itself_so_the_next_one_can_find_it", () => {
  const home = familyHome();
  cacheRegistry.register("JustWrite", join(tmp, "jw", "ai-cache"), join(tmp, "jw"));
  expect(readApps(home).map((e) => e.product)).toEqual(["JustWrite"]);

  // Idempotent by product — a hundred boots leave one row, not a hundred.
  cacheRegistry.register("JustWrite", join(tmp, "jw", "ai-cache"), join(tmp, "jw"));
  expect(readApps(home).length).toBe(1);
});

test.fails("discovery_reports_a_sibling_with_what_is_in_it", () => {
  // FAILS in Python today too — see the header: the model folder below is empty, so it
  // doesn't count since the 2026-10-06 change (`models` is []).
  familyHome();
  const jw = join(tmp, "jw", "ai-cache");
  mkdirSync(join(jw, "llamacpp", "b10107"), { recursive: true });
  writeFileSync(join(jw, "llamacpp", "b10107", "llama-server.exe"), Buffer.alloc(100, "x"));
  mkdirSync(join(jw, "hf", "models--unsloth--gemma-4-26B-A4B-it-qat-GGUF"), { recursive: true });
  cacheRegistry.register("JustWrite", jw, join(tmp, "jw"));

  const found = cacheRegistry.discover(join(tmp, "mine", "ai-cache"));
  expect(found.length).toBe(1);
  expect(found[0].product).toBe("JustWrite");
  expect(found[0].engineBuilds).toEqual(["b10107"]);
  expect(found[0].models).toEqual(["unsloth/gemma-4-26B-A4B-it-qat-GGUF"]);
  expect(found[0].bytes).toBe(100);
});

test("your_own_cache_is_never_offered_to_you", () => {
  familyHome();
  const mine = join(tmp, "mine", "ai-cache");
  mkdirSync(mine, { recursive: true });
  cacheRegistry.register("Mine", mine, join(tmp, "mine"));
  expect(cacheRegistry.discover(mine)).toEqual([]);
});

test("a_vanished_cache_is_pruned_not_offered", () => {
  // An entry is a claim about the disk, not a subscription. An uninstalled app or a
  // throwaway run leaves a path that no longer exists, and "share JustWrite's 0 B cache" is
  // worse than saying nothing.
  familyHome();
  const gone = join(tmp, "gone", "ai-cache");
  cacheRegistry.register("Gone", gone, join(tmp, "gone"));
  expect(cacheRegistry.discover(join(tmp, "mine"))).toEqual([]);
});

test("two_installs_of_one_app_do_not_erase_each_other", () => {
  // Keying on product alone let whichever booted last delete the other's row — which is how
  // a pytest run with a tmp data dir replaced the real JustWrite entry.
  familyHome();
  const dev = join(tmp, "dev", "ai-cache");
  const release = join(tmp, "release", "ai-cache");
  mkdirSync(dev, { recursive: true });
  mkdirSync(release, { recursive: true });
  cacheRegistry.register("JustWrite", dev, join(tmp, "dev"));
  cacheRegistry.register("JustWrite", release, join(tmp, "release"));

  const roots = new Set(cacheRegistry.discover(join(tmp, "mine")).map((e) => pyPath(e.root)));
  expect(roots).toEqual(new Set([pyPath(dev), pyPath(release)]));
  // Still idempotent for the SAME install.
  cacheRegistry.register("JustWrite", dev, join(tmp, "dev"));
  expect(cacheRegistry.discover(join(tmp, "mine")).length).toBe(2);
});

test("an_install_that_switches_cache_leaves_no_ghost_row", () => {
  // Seen live: after one switch and one switch back, the registry listed the app against
  // BOTH roots — one of which it no longer used. The install (data dir) is the thing that has
  // a cache; the root is only what it currently says about itself.
  familyHome();
  const own = join(tmp, "mine", "ai-cache");
  const sibling = join(tmp, "jw", "ai-cache");
  mkdirSync(own, { recursive: true });
  mkdirSync(sibling, { recursive: true });
  cacheRegistry.register("Mine", own, join(tmp, "mine"));
  cacheRegistry.register("Mine", sibling, join(tmp, "mine")); // the user shares

  const rows = cacheRegistry.discover(join(tmp, "elsewhere"));
  expect(rows.map((r) => pyPath(r.root))).toEqual([pyPath(sibling)]);
});

test("a_suite_that_forgets_the_override_writes_NOTHING", () => {
  // The bite for the incident itself: without this guard, three repos' test runs wrote their
  // temp paths into the author's real machine-wide registry. (vitest sets VITEST, which the
  // guard reads as pytest's PYTEST_CURRENT_TEST.)
  vi.stubEnv("JUST_AI_HOME", undefined);
  vi.spyOn(cacheRegistry, "familyHome").mockReturnValue(p("real"));
  cacheRegistry.register("Leaky", join(tmp, "c"));
  expect(existsSync(join(tmp, "real"))).toBe(false);
});

test("an_explicit_override_still_writes", () => {
  vi.stubEnv("JUST_AI_HOME", join(tmp, "elsewhere"));
  cacheRegistry.register("X", join(tmp, "c"));
  expect(existsSync(join(tmp, "elsewhere", "caches.json"))).toBe(true);
});

test("a_scratch_server_in_the_os_temp_dir_never_registers", () => {
  // The 2026-08-08 ghost: a smoke gate snapshots the app into %TEMP% and boots a real server
  // there — and that boot registered itself like any other. Quick Setup offered it as a real
  // sibling, pre-selected "share", and one proceed click repointed a 248 GB install's cache at
  // a Temp dir. Without an explicit JUST_AI_HOME a root under the OS temp dir never enters the
  // machine-wide registry.
  vi.stubEnv("JUST_AI_HOME", undefined);
  // writes ON, like a real boot (Python unset PYTEST_CURRENT_TEST; the JS guard also reads VITEST)
  vi.stubEnv("PYTEST_CURRENT_TEST", undefined);
  vi.stubEnv("VITEST", undefined);
  vi.spyOn(cacheRegistry, "familyHome").mockReturnValue(p("real"));
  vi.spyOn(cacheRegistry, "gettempdir").mockReturnValue(p("ostmp"));

  cacheRegistry.register("JustWrite Server", join(tmp, "ostmp", "jw-smoke-x", "ai-cache"), join(tmp, "ostmp", "jw-smoke-x"));
  expect(existsSync(join(tmp, "real"))).toBe(false); // refused — nothing written
  // A durable root on the same box still registers.
  cacheRegistry.register("JustWrite", join(tmp, "jw", "ai-cache"), join(tmp, "jw"));
  expect(readApps(join(tmp, "real")).map((e) => e.product)).toEqual(["JustWrite"]);
});

test("a_temp_row_already_in_the_registry_is_pruned_on_read", () => {
  // Refusing the write is not enough: a registry polluted BEFORE the guard still carries the
  // row, and the scratch dir can outlive its run — reads drop it even while the dir exists.
  vi.stubEnv("JUST_AI_HOME", undefined);
  vi.spyOn(cacheRegistry, "familyHome").mockReturnValue(p("real"));
  vi.spyOn(cacheRegistry, "gettempdir").mockReturnValue(p("ostmp"));

  const ghost = join(tmp, "ostmp", "jw-smoke-x", "ai-cache");
  mkdirSync(ghost, { recursive: true }); // exists — the isDir prune keeps it
  const real = join(tmp, "jw", "ai-cache");
  mkdirSync(real, { recursive: true });
  mkdirSync(join(tmp, "real"), { recursive: true });
  writeFileSync(
    join(tmp, "real", "caches.json"),
    JSON.stringify({
      version: 1,
      apps: [
        { product: "JustWrite Server", cacheRoot: ghost, dataDir: "" },
        { product: "JustWrite", cacheRoot: real, dataDir: "" },
      ],
    }),
    "utf8",
  );

  expect(cacheRegistry.discover(join(tmp, "mine")).map((e) => e.product)).toEqual(["JustWrite"]);
});

test("a_corrupt_registry_reads_as_an_empty_one", () => {
  const home = familyHome();
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "caches.json"), "{not json", "utf8");
  expect(cacheRegistry.discover()).toEqual([]); // never throws into a boot
  cacheRegistry.register("New", join(tmp, "c")); // and recovers on the next write
  expect(readApps(home).map((e) => e.product)).toEqual(["New"]);
});

// ── what the wizard is shown, and what the disk panel measures ───────────────

/** A configured service whose cache is a sibling's — the post-share state (Python's `wired`
 * fixture; `afterEach` restores the singleton). */
function wiredFixture() {
  const shared = join(tmp, "jw", "ai-cache");
  mkdirSync(join(shared, "hf", "models--org--big"), { recursive: true });
  writeFileSync(join(shared, "hf", "models--org--big", "blob"), Buffer.alloc(9000, "x"));
  mkdirSync(join(shared, "llamacpp", "b10107"), { recursive: true });
  const svc = new RunnerService(shared, { runtimeRoot: join(tmp, "mine", "ai-runtime") });
  lifecycle.state.service = svc;
  return { shared, dataDir: join(tmp, "mine"), svc };
}

function cacheApp(dataDir) {
  const app = createServer({ typeBase: "https://example.test/errors/" });
  app.route("/", makeCacheRouter(dataDir, "Mine"));
  return app;
}

/** A PUT with a JSON body. */
const put = (app, url, payload) =>
  app.request(url, { method: "PUT", body: JSON.stringify(payload), headers: { "content-type": "application/json" } });

test.fails("the_wizard_is_offered_the_way_back", async () => {
  // FAILS in Python today too (build sheet §6): the fixture's `blob` sits outside
  // `snapshots/`, so `current.models` is [] since the 2026-10-06 change.
  familyHome();
  const wired = wiredFixture();
  cacheRegistry.register("JustWrite", wired.shared, join(tmp, "jw"));
  const body = await (await cacheApp(wired.dataDir).request("/v1/ai/engine-cache", { method: "GET" })).json();

  expect(body.shared).toBe(true);
  expect(samePath(body.root, wired.shared)).toBe(true);
  expect(samePath(body.runtimeRoot, join(wired.dataDir, "ai-runtime"))).toBe(true);
  expect(body.current.models).toEqual(["org/big"]);
  // "keep my own" is always an option, even though that directory doesn't exist yet.
  expect(body.options.map((o) => pyPath(o.root))).toEqual([pyPath(join(wired.dataDir, "ai-cache"))]);
  // And a cache already in use is never offered as something to switch to.
  expect(body.options.every((o) => !samePath(o.root, wired.shared))).toBe(true);
});

test("your_own_cache_is_offered_once_even_after_you_start_sharing", async () => {
  // Seen live: the app's own row is still in the registry from boot, so excluding only the
  // cache IN USE listed "keep my own" twice.
  familyHome();
  const wired = wiredFixture();
  mkdirSync(join(wired.dataDir, "ai-cache"), { recursive: true });
  cacheRegistry.register("Mine", join(wired.dataDir, "ai-cache"), wired.dataDir);
  cacheRegistry.register("JustWrite", wired.shared, join(tmp, "jw"));
  const body = await (await cacheApp(wired.dataDir).request("/v1/ai/engine-cache", { method: "GET" })).json();
  expect(body.options.map((o) => pyPath(o.root))).toEqual([pyPath(join(wired.dataDir, "ai-cache"))]);
});

test("switching_applies_live_while_the_engine_is_idle", async () => {
  // A choice recorded but not applied would be contradicted by the very download the wizard
  // starts next — so idle means apply now.
  familyHome();
  const wired = wiredFixture();
  vi.spyOn(stores, "getRunnerConfigStore").mockReturnValue({ setCacheRoot: () => {} });
  const r = await put(cacheApp(wired.dataDir), "/v1/ai/engine-cache", { root: join(wired.dataDir, "ai-cache") });
  const body = await r.json();

  expect(body.applied).toBe(true);
  expect(body.restartRequired).toBe(false);
  expect(wired.svc.cacheRoot).toBe(pyPath(join(wired.dataDir, "ai-cache")));
  // The ini bookkeeping must reset, or the emitter compares against the OLD root's text and
  // never writes one into the new location.
  expect(wired.svc._lastIniText).toBe("");
});

test("switching_under_a_live_engine_waits_for_a_restart", async () => {
  familyHome();
  const wired = wiredFixture();
  vi.spyOn(stores, "getRunnerConfigStore").mockReturnValue({ setCacheRoot: () => {} });
  wired.svc._router = fakeRouter("http://127.0.0.1:8080", true);
  const r = await put(cacheApp(wired.dataDir), "/v1/ai/engine-cache", { root: join(wired.dataDir, "ai-cache") });
  const body = await r.json();

  expect(body.applied).toBe(false);
  expect(body.restartRequired).toBe(true);
  expect(body.detail).toContain("unload");
  expect(wired.svc.cacheRoot).toBe(pyPath(wired.shared)); // unchanged under a running engine
});

test("disk_usage_measures_the_cache_actually_in_use", async () => {
  // Without this the Storage panel reports a confident 0 B for 9 KB it can see — or, on the
  // real box, for 14 GB.
  const wired = wiredFixture();
  const app = createServer({ typeBase: "https://example.test/errors/" });
  app.route("/", makeDiskRouter(String(wired.dataDir)));
  const body = await (await app.request("/v1/disk/usage", { method: "GET" })).json();
  expect(body.modelsCache).toBe(9000);
  expect(body.cacheShared).toBe(true);
});
