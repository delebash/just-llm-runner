// SPDX-License-Identifier: MIT
// Shared "hand something to the OS" — THE seam for external links (#12a) and,
// since 2026-08-14, for local FOLDERS ("Open folder" on both model catalogs).
//
// WHY A SEAM AT ALL: a Tauri webview swallows `target=_blank` and `window.open`,
// so a desktop app must route these through its OS opener. The kit cannot import
// `@tauri-apps/plugin-opener` itself — that would break every non-Tauri consumer's
// build — so the host hands its openers in once at boot. In all three apps that is
// now the SAME two functions from the SAME plugin (the 2026-08-14 convergence:
// they were plugin-shell, a hand-written Rust command, and plugin-opener):
//
//   import { openPath, openUrl } from "@tauri-apps/plugin-opener";
//   installLlmUi(app, { external: { open: openUrl, openPath } });
//
// THE GATE LIVES HERE, not in the apps. Those openers only work inside the Tauri
// webview, and every app also runs in a plain browser (`vite dev`, and JustVoice's
// headless `serve` UI). So this module decides:
//   - openExternal → the host's opener in the webview, `window.open` in a browser
//     (which works there).
//   - openPath → the host's opener in the webview, and FALSE anywhere else. There
//     is no browser fallback and there cannot be one: a page cannot hand a
//     filesystem path to the file manager. It reports failure instead of
//     pretending, and the caller says what that means in its own words.
// That is why the apps' wiring is three words long and identical: no app decides
// what it can do, and none of them repeats this reasoning.
//
// Components keep a real <a :href> for copy-link + a11y and route the CLICK
// through openExternal via @click.prevent.

const config = { open: null, openPath: null };

/** Inside a Tauri webview? `__TAURI_INTERNALS__` is the IPC bootstrap every
 *  Tauri 2 window gets. NOT `window.__TAURI__`, which exists only when an app
 *  sets `withGlobalTauri` — JustVoice does not, and its folder-openers were
 *  silently dead for exactly that reason until 2026-08-14. */
export function isTauriShell() {
  return typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;
}

/** Merge semantics (configureServerApi's shape): a host that wires only `open`
 *  keeps whatever folder opener was configured before, and vice versa. */
export function configureExternal({ open, openPath: openPathFn } = {}) {
  if (open !== undefined) config.open = open || null;
  if (openPathFn !== undefined) config.openPath = openPathFn || null;
}

export function openExternal(url) {
  if (!url) return;
  if (config.open && isTauriShell()) {
    config.open(url);
    return;
  }
  if (typeof window !== "undefined") window.open(url, "_blank", "noopener,noreferrer");
}

/** Can this host reveal a local folder? False in any browser. */
export function canOpenPath() {
  return !!config.openPath && isTauriShell();
}

/** Show `path` in the OS file manager. Returns false when this host can't —
 *  the caller says what that means to the user. */
export function openPath(path) {
  if (!path || !canOpenPath()) return false;
  config.openPath(path);
  return true;
}
