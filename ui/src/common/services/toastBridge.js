// SPDX-License-Identifier: GPL-3.0-or-later
// Shared bridge between callers (a ui store, anywhere) and vue-sonner's
// imperative toast() API. sonner needs no service-binding from a setup()
// context — `toast(...)` works anywhere — so this stays a thin shim that keeps
// call sites (pushToast / clearToasts) stable across toast backends.
// App-agnostic; vue-sonner resolves from the host (peerDependency + Vite
// resolve.dedupe). Supersedes the per-app services/toastBridge.js forks.
//
// Toasts carry an optional `action` ({ label, fn }) for the inline button that
// soft-delete uses to surface "Undo" — mapped to sonner's `action` shape
// ({ label, onClick }) here.

import { toast } from "vue-sonner";

// Show one toast.
//
// `kind` ("success" | "error" | "warning" | "info") routes to the matching
// vue-sonner variant so the Toaster's rich-colors give errors a red frame,
// successes green, etc. `duration` (ms) on the options object wins; the legacy
// positional `ms` arg is still honored as a fallback. `title` + `description`
// are accepted alongside `message` because many call sites pass that shape;
// sonner takes `description` natively.
export function pushToast({ message, title, description, kind, action, duration } = {}, ms) {
  const text = message ?? title;
  if (!text) return;
  const opts = {
    duration: duration ?? ms ?? 6000,
    description,
    action: action ? { label: action.label, onClick: action.fn } : undefined,
  };
  const fn =
    kind === "error"
      ? toast.error
      : kind === "success"
        ? toast.success
        : kind === "warning" || kind === "warn"
          ? toast.warning
          : kind === "info"
            ? toast.info
            : toast;
  fn(text, opts);
}

// Dismiss any visible toast.
export function clearToasts() {
  toast.dismiss();
}
