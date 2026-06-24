// SPDX-License-Identifier: GPL-3.0-or-later
// Shared in-app Help open-state + host configuration. App-agnostic: the kit
// owns the drawer open-state (so HelpDrawer + every HelpTrigger share ONE
// reactive source), while the host app supplies the CONTENT adapter
// (loadDoc / hasDoc / titleForSlug over its own docs/*.md corpus) and, when it
// has them, the "Open full docs" (router) / "Open on the web" (shell) actions —
// all via configureHelp() once at boot. Supersedes the per-app uiStore
// help-drawer state (helpDrawerSlug / helpDrawerAnchor + openHelp / closeHelp).
//
// Usage (host, once at boot — minimal, JustVoice today):
//   import { configureHelp } from "@delebash/llm-ui";
//   import { loadDoc, hasDoc, titleForSlug } from "./services/helpDocs.js";
//   configureHelp({ loadDoc, hasDoc, titleForSlug });
//
// Usage (richer host with a full-pane reader + public docs site — JustWrite):
//   configureHelp({
//     loadDoc, hasDoc, titleForSlug,
//     onOpenFull: (slug) => { router.push(slug ? `/help/${slug}` : "/help"); closeHelp(); },
//     onOpenWeb:  (slug) => openExternal(webUrlFor(slug)),
//   });

import { reactive } from "vue";

// slug === null → drawer closed. Any string opens it; anchor is an optional
// in-doc heading id to scroll to.
export const helpState = reactive({ slug: null, anchor: "" });

// Host-provided content adapter + optional actions. Safe no-op defaults so the
// drawer renders its empty state if a host forgets to configure it.
const config = reactive({
  loadDoc: async () => null,
  hasDoc: () => false,
  titleForSlug: (s) => s || "Help",
  onOpenFull: null, // (slug) => void — "Open full docs" button shown iff set
  onOpenWeb: null, // (slug) => void — "Open on the web" button shown iff set
});

export const helpConfig = config;

export function configureHelp(adapter = {}) {
  if (adapter.loadDoc) config.loadDoc = adapter.loadDoc;
  if (adapter.hasDoc) config.hasDoc = adapter.hasDoc;
  if (adapter.titleForSlug) config.titleForSlug = adapter.titleForSlug;
  config.onOpenFull = adapter.onOpenFull || null;
  config.onOpenWeb = adapter.onOpenWeb || null;
}

// Open the drawer to a doc. Accepts the convenience form "slug#anchor" so a
// HelpTrigger can deep-link to a section: openHelp("voices#cloning").
export function openHelp(slug, anchor = "") {
  let s = slug || "";
  let a = anchor || "";
  const hash = s.indexOf("#");
  if (hash !== -1) {
    a = a || s.slice(hash + 1);
    s = s.slice(0, hash);
  }
  helpState.slug = s;
  helpState.anchor = a;
}

export function closeHelp() {
  helpState.slug = null;
  helpState.anchor = "";
}
