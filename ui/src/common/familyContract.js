// SPDX-License-Identifier: MIT
// THE FAMILY SURFACE CONTRACT (2026-08-04) — the machine-readable canon for every
// label and shape the family shares. Born from a 48-item divergence sweep
// (just_ai_i18n_docgen/docs/plans/2026-08-04-consistency-sweep.md): every drift traced
// to a surface authored fresh with no canon and no gate.
//
// TWO KINDS OF ENTRY, two enforcement paths:
//   1. Labels for surfaces the KIT renders — kit components read their OWN defaults
//      from here, so canon and kit cannot disagree (enforced by construction).
//   2. Labels for app-owned chrome the kit cannot render (the sidebar trio, dialog
//      verbs an app passes per-call) — enforced by each app's CONTRACT TEST
//      (docgen: node:test beside its e2e; JW: a vitest twin over this same file).
//
// Entries are { id: english } so an i18n'd app (JW) maps ids → locale keys; the
// contract test compares the app's ENGLISH catalog values against these. App VOICE
// (domain words) never lives here — it goes through the sanctioned copy objects
// (catalogCopy, quickSetupCopy, …) and nothing else.
//
// SHAPES (asserted by the contract tests' scans, not renderable as strings):
//   - Settings is a TOP-TAB page (no vertical rail chrome).
//   - Boot is ONE splash: static index.html plate → app overlay hosting BootModelLoad.
//   - The first-run AI offer is a ONCE-EVER modal (ruling 2026-08-04; the permanent
//     Home-button shape is retired).
//   - The headless-access + token settings live in a section named `settingsSections.server`.

export const FAMILY_LABELS = {
  // The nav trio — every app's sidebar carries exactly these words (domain nav
  // above them is each app's own).
  nav: {
    appSettings: "App Settings",
    aiSettings: "AI Settings",
    aiTasks: "AI tasks",
    help: "Help",
  },

  // Dialog verbs + the host AppDialog's fallback words — the confirm vocabulary
  // every app passes (or maps via locale). Folded 2026-08-04 from dialog.js's own
  // defaults: one store for every family word, or the drift disease returns.
  dialog: {
    confirm: "Confirm",
    ok: "OK",
    cancel: "Cancel",
    defaultTitle: "Are you sure?",
    close: "Close",
  },

  // The AI area's tab strip (the 5th tab is host-supplied app voice).
  aiTabs: {
    providers: "Providers & models",
    routing: "Routing by feature",
    usage: "Usage",
    console: "Server console",
  },

  // The promptless Lab's words (decision 2026-08-04: every NEW kit string rides this
  // door — JW's i18n gates can't see kit files, so hardcoded English here would leak
  // into its Spanish routing page; found dropped by the audit, wired same day).
  lab: {
    generatedPrompt: "Generated prompt",
    generatedNote: "built by the app for every real run — test only; nothing here is saved or applied",
    refresh: "Refresh",
    editCopies: "Edit copies for this test",
    lockCopies: "Lock copies",
    restoreGenerated: "Restore generated",
    changeData: "Change what this prompt says:",
  },

  // DownloadBar's state actions — sat hardcoded + untranslatable under JW's keyed
  // titles until this file existed.
  downloadBar: {
    cancel: "Cancel",
    retry: "Retry",
    dismiss: "Dismiss",
    ready: "Ready ✓",
  },

  // ConnectionError copy (the {appName}/{need} interpolations stay props).
  connectionError: {
    title: "Can't reach the {appName} server",
    retry: "Retry",
  },

  // Quick Setup — the shared defaults an app's quickSetupCopy may override where the
  // entry is VOICE (band captions, step titles); the button labels + engine bar title
  // are canon (ruling 2026-08-04: "The engine", not the binary's name).
  quickSetup: {
    runButton: "Run Quick Setup",
    bandScope: "Sets up the built-in llama.cpp provider only",
    applyButton: "Apply setup",
    cancelButton: "Cancel",
    closeButton: "Close",
    engineBarTitle: "The engine",
    engineBarRole: "the program that runs models",
  },

  // Settings — canonical section names for concepts BOTH apps have; an app may add
  // its own sections (Reviewer) but shared concepts share these exact words.
  settingsSections: {
    appearance: "Appearance",
    storage: "Storage",
    server: "Server", // ruling 2026-08-04: headless access + tokens live HERE, both apps
    logs: "Logs",
    about: "About",
  },

  // Storage-section canon (ruling 2026-08-04: JW's words win; the Total row — docgen's
  // invention — becomes canon BOTH apps render).
  storage: {
    serverLogs: "Server logs",
    freeSpace: "Free disk space",
    total: "Total",
    clearShort: "Clear…",
  },
};
