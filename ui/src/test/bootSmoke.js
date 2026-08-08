// SPDX-License-Identifier: MIT
// THE BOOT SMOKE skeleton (family common; the three apps' src/boot.smoke.test.js
// each carried this whole file — now they pass only their per-app parts).
//
// What it is: imports the app's REAL main.js and lets the REAL boot chain run
// against a stubbed transport, failing on an import-time throw, a boot-chain
// throw, or a mount that renders nothing. This is the gate that kills the
// TDZ-crash class: build:vite compiles the module graph without executing it
// and biome doesn't check .vue identifiers, so a "used before initialization"
// anywhere in the graph ships past a green build (JV's did, live, 2026-08-05).
//
// TEST-ONLY MODULE — imports vitest, so it must NEVER ride the package barrel
// (index.js); apps import it by explicit subpath. What stays in the APP's test
// file, because it cannot move: the `@vitest-environment jsdom` pragma
// (per-file directive) and the `import("./main.js")` thunk (vite resolves a
// dynamic import relative to the declaring file).
//
//   // @vitest-environment jsdom
//   import { registerBootSmoke } from "@delebash/llm-ui/test/bootSmoke.js";
//   registerBootSmoke({
//     boot: () => import("./main.js"),
//     routes: { "/v1/health": { status: "ok", product: "…" }, "/v1/prefs": { prefs: {} } },
//     ready: () => { if (window.__bootErr) throw window.__bootErr; },
//   });

import { beforeAll, expect, it, vi } from "vitest";

/**
 * Register the boot smoke: the stub environment (beforeAll) + the one test.
 *
 * @param {() => Promise<unknown>} boot    thunk importing the app's main.js
 * @param {Record<string, unknown>} routes url-fragment → JSON body for the
 *   fetch stub, first match wins in insertion order; unmatched routes answer {}.
 *   The renderer is a thin client — minimal-but-shaped bodies are enough to
 *   carry the boot chain to mount.
 * @param {() => void} [ready]  extra per-app readiness probe, run inside the
 *   waitFor retry loop after mount is visible — throw to keep waiting (e.g.
 *   rethrow window.__bootErr, or assert a late boot marker).
 */
export function registerBootSmoke({ boot, routes = {}, ready } = {}) {
  beforeAll(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input) => {
        const url = String(typeof input === "string" ? input : input?.url || "");
        let body = {};
        for (const [fragment, shaped] of Object.entries(routes)) {
          if (url.includes(fragment)) {
            body = shaped;
            break;
          }
        }
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
      })),
    );
    // Node ships an EXPERIMENTAL localStorage global that is undefined without
    // --localstorage-file and shadows jsdom's — give the app a working one.
    const store = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      clear: () => store.clear(),
      key: (i) => [...store.keys()][i] ?? null,
      get length() { return store.size; },
    });
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("EventSource", class {
      constructor() { this.readyState = 0; }
      addEventListener() {}
      close() {}
    });
    window.scrollTo = () => {};
    Element.prototype.scrollIntoView = () => {};
  });

  it("the app boots to a mounted shell (TDZ / boot-crash smoke)", async () => {
    document.body.innerHTML = '<div id="app-boot"></div><div id="app"></div>';
    await boot();
    const el = document.getElementById("app");
    await vi.waitFor(() => {
      if (ready) ready();
      expect(el.childElementCount).toBeGreaterThan(0);
    }, { timeout: 8000, interval: 100 });
  }, 15000);
}
