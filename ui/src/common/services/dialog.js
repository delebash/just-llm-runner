// SPDX-License-Identifier: MIT
// Shared imperative, promise-based dialog API — replaces the browser's built-in
// prompt() / confirm() (which leak "from localhost" chrome in dev and look out of
// place in a packaged Tauri shell). App-agnostic; the host component (the shared
// AppDialog / UiDialog) reads `dialogState` and calls _resolveDialog(...) on
// confirm / cancel. Supersedes the per-app services/dialog.js forks.
//
// Usage:
//   const title = await promptDialog({ title: "New chapter", label: "Title", confirmLabel: "Create" });
//   if (!title) return;                                   // user cancelled
//   const values = await promptDialog({ title: "New article", fields: [...] });
//   const yes = await confirmDialog({ title: "Delete?", message: "…", danger: true });

import { reactive } from "vue";

export const dialogState = reactive({
  open: false,
  kind: null,        // "prompt" | "confirm"
  options: null,
  _resolve: null,
});

// Default labels the host AppDialog falls back to when a call omits them. The
// words live in the ONE reactive family store (familyLabels.dialog) — folded
// 2026-08-04; two stores with one meaning is how the drift started. This export
// is a read-through VIEW keeping the property names AppDialog reads (template
// reads stay reactive: the getters read the reactive store), and configureDialog
// stays as a thin alias over the one door so existing hosts keep working.
import { configureFamilyLabels, familyLabels } from "./familyLabels.js";

export const dialogLabels = {
  get defaultTitle() { return familyLabels.dialog.defaultTitle; },
  get confirmLabel() { return familyLabels.dialog.confirm; },
  get okLabel() { return familyLabels.dialog.ok; },
  get cancelLabel() { return familyLabels.dialog.cancel; },
  get closeLabel() { return familyLabels.dialog.close; },
};

export function configureDialog({ labels } = {}) {
  if (!labels) return;
  configureFamilyLabels({
    dialog: {
      defaultTitle: labels.defaultTitle,
      confirm: labels.confirmLabel,
      ok: labels.okLabel,
      cancel: labels.cancelLabel,
      close: labels.closeLabel,
    },
  });
}

function openDialog(kind, options) {
  // If something is already open, cancel it first so the new prompt wins.
  if (dialogState.open && dialogState._resolve) {
    dialogState._resolve(kind === "confirm" ? false : null);
  }
  return new Promise((resolve) => {
    dialogState.kind = kind;
    dialogState.options = options;
    dialogState._resolve = resolve;
    dialogState.open = true;
  });
}

export function promptDialog(options = {}) {
  return openDialog("prompt", options);
}

export function confirmDialog(options = {}) {
  return openDialog("confirm", options);
}

// Called by the dialog host on confirm / cancel. We deliberately keep `kind` and
// `options` set after closing — the host renders its body off those, and Reka
// UI's DialogContent keeps the frame mounted during its ~150ms close animation;
// clearing synchronously made the body vanish mid-fade. The next openDialog
// overwrites both atomically, so the stale data is harmless until then.
export function _resolveDialog(value) {
  const r = dialogState._resolve;
  dialogState.open = false;
  dialogState._resolve = null;
  if (r) r(value);
}
