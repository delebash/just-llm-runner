// SPDX-License-Identifier: MIT
// Choose where the engine + model cache lives — `GET/PUT /v1/ai/engine-cache`; the port of
// llm/cache_api.py.
//
// The problem this solves, measured on the author's box 2026-08-03: two family apps each
// kept their own `<data>/ai-cache` and so held the SAME model twice —
// `unsloth/gemma-4-26B-A4B-it-qat-GGUF @ UD-Q4_K_XL`, **14,249,047,104 bytes in both** — plus
// two full llama.cpp installs. The artifacts are content-addressed (repo + quant + snapshot;
// build number), so the second copy buys nothing.
//
// The user ruled the shape: **detect an existing family cache during Quick Setup and ASK,
// with an override** for an app that should keep its own. So this endpoint reports what
// exists and records a CHOICE — it never moves, copies or deletes a byte. A cache you
// already filled stays exactly where it is, and switching back is the same one click. The
// choice binds at wiring time (installLlm), so it applies on the next start — or live, when
// the engine is idle (PUT below).
//
// The runner service (`runner/lifecycle.js`) and `resolveCacheRoots` (`llm/install.js`) are
// reached LAZILY, through `deps`, as Python imported them inside the handlers: a test
// replaces `deps.getService` / `deps.resolveCacheRoots` (`vi.spyOn(cacheApi.deps, …)`).

import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { Hono } from "hono";
import { HttpError } from "../platform/errors.js";
import { model, opt, T } from "../platform/models.js";
import { IS_WIN, RuntimeError } from "../platform/py.js";
import { input } from "../platform/server.js";
import * as cacheRegistry from "../runner/cache_registry.js";
import * as stores from "./stores.js";

export const CacheOption = T.Object({
  root: T.String(),
  exists: T.Boolean(),
  engineBuilds: opt(T.Array(T.String()), []),
  models: opt(T.Array(T.String()), []),
  bytes: opt(T.Integer(), 0),
  product: opt(T.String(), ""), // the app that registered it ("" = the family default spot)
  lastSeen: opt(T.String(), ""),
});

export const CacheState = T.Object({
  root: T.String(), // the cache in use right now
  ownRoot: T.String(), // this app's private cache (`<data>/ai-cache`)
  runtimeRoot: T.String(), // where THIS app's models.ini + spawn logs go
  shared: T.Boolean(), // is `root` somewhere other than ownRoot?
  stored: T.String(), // the recorded choice ("" = follow ownRoot)
  current: CacheOption,
  options: T.Array(CacheOption), // siblings worth offering — never includes `root`
});

export const CacheChoice = T.Object({
  root: opt(T.String(), ""), // "" = go back to this app's own cache
});

/** The lazily-reached collaborators (Python's in-handler imports). */
export const deps = {
  /** The runner service: `.cacheRoot`, `.runtimeRoot`, `repointCache(cache, runtime)`. */
  getService: async () => (await import("#runner/lifecycle")).getService(),
  /** `resolveCacheRoots(dataDir, cacheRoot, stored)` → [cacheRoot, runtimeRoot, shared] (Python's
   * positional-or-keyword parameters stay positional). */
  resolveCacheRoots: async (dataDir, cacheRoot, stored) =>
    (await import("./install.js")).resolveCacheRoots(dataDir, cacheRoot, stored),
};

// ── path helpers (candidates for platform/) ──────────────────────────────────

/** pathlib's `==`: the normal form, case-folded on Windows (PureWindowsPath compares
 * case-insensitively). */
export function samePath(a, b) {
  const norm = (p) => {
    const s = cacheRegistry.pyPath(p);
    return IS_WIN ? s.toLowerCase() : s;
  };
  return norm(a) === norm(b);
}

/** `Path(p).is_absolute()`: on Windows a drive AND a root (`C:\x`) or a UNC share; `\x`
 * and `C:x` are not absolute (Node's isAbsolute says `\x` is). */
export function pyIsAbsolute(p) {
  const s = String(p);
  if (IS_WIN) return /^[A-Za-z]:[\\/]/.test(s) || /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/.test(s);
  return s.startsWith("/");
}

/** Build the engine-cache router. `dataDir` is what makes "my own cache" a knowable path —
 * the runner service is app-agnostic and cannot answer that. */
export function makeCacheRouter(dataDir = null, product = "") {
  const own = dataDir ? cacheRegistry.pyPath(join(String(dataDir), "ai-cache")) : null;

  const app = new Hono();
  const state = async () => {
    const svc = await deps.getService();
    const root = cacheRegistry.pyPath(svc.cacheRoot);
    let stored;
    try {
      stored = stores.getRunnerConfigStore().getCacheRoot();
    } catch {
      stored = ""; // a pre-seed DB is not an error here
    }
    // Exclude the app's OWN root as well as the one in use: this function offers "keep my
    // own" explicitly below, and the registry still carries this app's own row from boot
    // — passing only `root` listed it twice once we shared.
    const options = cacheRegistry.discover([root, own]).map((o) => model(CacheOption, o));
    const shared = !!(own && !samePath(root, own));
    if (shared) {
      // Always offer the way back. It is listed even when empty: "my own cache" is a real
      // choice, not a directory that has to already exist.
      options.unshift(model(CacheOption, { ...cacheRegistry.summarize(own), product: "this app" }));
    }
    // A shared cache in use is named after its app, so the setup can offer it (startup
    // takes a sibling's by itself when nothing is chosen, 2026-10-06).
    return model(CacheState, {
      root,
      ownRoot: own || "",
      runtimeRoot: cacheRegistry.pyPath(svc.runtimeRoot),
      shared,
      stored,
      current: model(CacheOption, {
        ...cacheRegistry.summarize(root),
        product: shared ? cacheRegistry.productOf(root, dataDir) : "",
      }),
      options,
    });
  };

  app.get("/v1/ai/engine-cache", async (c) => c.json(await state()));

  /**
   * Record the choice and, when the engine is idle, apply it immediately.
   *
   * NOTHING is moved — the previous cache keeps its files, which is what makes this
   * reversible and what stops a mis-click costing 14 GB. Applying live matters because
   * Quick Setup asks this BEFORE the first download: a choice that waited for a restart
   * would be contradicted by the download the same wizard starts.
   */
  app.put("/v1/ai/engine-cache", input({ body: CacheChoice }), async (c) => {
    const body = model(CacheChoice, c.req.valid("json"));
    let chosen = String(body.root || "").trim();
    if (chosen) {
      const path = cacheRegistry.pyPath(chosen);
      if (!pyIsAbsolute(path)) throw new HttpError(400, "cache root must be an absolute path");
      try {
        mkdirSync(path, { recursive: true });
      } catch (e) {
        throw new HttpError(400, `cannot use ${path}: ${e.message}`);
      }
      if (own && samePath(path, own)) chosen = ""; // "my own cache" is stored as the absence of a choice
    }
    stores.getRunnerConfigStore().setCacheRoot(chosen);

    const [cache, runtime] = await deps.resolveCacheRoots(dataDir, null, chosen);
    let applied = false;
    let detail = "";
    if (cache) {
      try {
        const svc = await deps.getService();
        await svc.repointCache(cache, runtime);
        applied = true;
        // Keep the family registry truthful: it said where this app cached at BOOT, and
        // that is no longer where it caches.
        cacheRegistry.register(product || (dataDir ? basename(cacheRegistry.pyPath(dataDir)) : ""), cache, dataDir);
      } catch (e) {
        if (!(e instanceof RuntimeError || e?.name === "RuntimeError")) throw e;
        detail = e.message; // busy: the choice stands, it just waits for a restart
      }
    }
    return c.json({
      ok: true,
      root: cache ? cacheRegistry.pyPath(cache) : own || "",
      applied,
      restartRequired: !applied,
      detail,
    });
  });
  return app;
}
