// SPDX-License-Identifier: GPL-3.0-or-later
// Shared "open a URL outside the app" — THE seam for external links (#12a).
// Plain target=_blank anchors (and window.open) are swallowed by the Tauri
// webview, so kit components must route external clicks through here; the host
// wires its shell bridge once at boot (mirrors configureHelp/configureDialog):
//
//   import { configureExternal } from "@delebash/llm-ui";
//   configureExternal({ open: (url) => window.justwrite?.shell?.openExternal
//     ? window.justwrite.shell.openExternal(url)
//     : window.open(url, "_blank", "noopener,noreferrer") });
//
// Unconfigured (browser dev path / a host without a shell bridge) it falls back
// to window.open, which works there. Components keep a real <a :href> for
// copy-link + a11y and route the CLICK through openExternal via @click.prevent.

const config = { open: null };

export function configureExternal({ open } = {}) {
  config.open = open || null;
}

export function openExternal(url) {
  if (!url) return;
  if (config.open) {
    config.open(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
