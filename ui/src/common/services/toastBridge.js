// SPDX-License-Identifier: MIT
// Shared bridge between callers (a ui store, anywhere) and the toasts. Keeps the call sites
// (pushToast / clearToasts) stable across toast backends. App-agnostic. Supersedes the
// per-app services/toastBridge.js forks.
//
// Quasar's Notify plugin underneath (the kit's controls on Quasar —
// docs/plans/2026-10-09-kit-controls-on-quasar.md, slice 7; vue-sonner before it). Every app
// lists Notify in quasar.config.js's framework.plugins (the family guard checks it). The look
// is the kit's theme (../../quasar/theme.css, "Toast"); what sonner did beyond Notify's own
// is kept here: a toast stays its full duration while the pointer is on a toast or the window
// is hidden (the timers pause), at most three are up at once (a fourth retires the oldest),
// and each has a ✕ in its corner.
//
// Toasts carry an optional `action` ({ label, fn }) for the inline button that soft-delete
// uses to surface "Undo".

import { Notify } from "quasar";

// sonner's icons for the four kinds (Heroicons, MIT License, Copyright (c) Tailwind Labs,
// Inc.), copied from vue-sonner 2.0.9, in QIcon's "path@@style|viewBox" form, under its licence:
//
//   MIT License
//
//   Copyright (c) 2022 Yunwei Xiao
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy
//   of this software and associated documentation files (the "Software"), to deal
//   in the Software without restriction, including without limitation the rights
//   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
//   copies of the Software, and to permit persons to whom the Software is
//   furnished to do so, subject to the following conditions:
//
//   The above copyright notice and this permission notice shall be included in all
//   copies or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
//   SOFTWARE.
const FILLED = "fill:currentColor;fill-rule:evenodd";
const ICONS = {
  success: `M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z@@${FILLED}|0 0 20 20`,
  info: `M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z@@${FILLED}|0 0 20 20`,
  warning: `M9.401 3.003c1.155-2 4.043-2 5.197 0l7.355 12.748c1.154 2-.29 4.5-2.599 4.5H4.645c-2.309 0-3.752-2.5-2.598-4.5L9.4 3.003zM12 8.25a.75.75 0 01.75.75v3.75a.75.75 0 01-1.5 0V9a.75.75 0 01.75-.75zm0 8.25a.75.75 0 100-1.5.75.75 0 000 1.5z@@${FILLED}|0 0 24 24`,
  error: `M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 0110 5zm0 10a1 1 0 100-2 1 1 0 000 2z@@${FILLED}|0 0 20 20`,
};
const CLOSE_ICON = "M18 6L6 18M6 6l12 12@@fill:none;stroke:currentColor;stroke-linecap:round;stroke-linejoin:round|0 0 24 24";
const MAX_VISIBLE = 3;

// The toasts up now, oldest first: { dismiss, remaining, startedAt, timer }.
const live = [];
let hovered = false;
const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

function run(t) {
  if (t.remaining === Number.POSITIVE_INFINITY || t.timer !== null) return;
  t.startedAt = Date.now();
  t.timer = setTimeout(() => t.dismiss(), t.remaining);
}
function hold(t) {
  if (t.timer === null) return;
  clearTimeout(t.timer);
  t.timer = null;
  t.remaining = Math.max(0, t.remaining - (Date.now() - t.startedAt));
}
function sync() {
  for (const t of live) {
    if (hovered || hidden()) hold(t);
    else run(t);
  }
}
if (typeof document !== "undefined") document.addEventListener("visibilitychange", sync);
const onEnter = () => { hovered = true; sync(); };
const onLeave = () => { hovered = false; sync(); };

function kindOf(kind) {
  if (kind === "warn") return "warning";
  return ["success", "error", "warning", "info"].includes(kind) ? kind : "";
}

// Show one toast.
//
// `kind` ("success" | "error" | "warning" | "info") gives the toast its colours and icon.
// `duration` (ms) on the options object wins; the legacy positional `ms` arg is still
// honored as a fallback (Infinity keeps the toast until it's closed). `title` +
// `description` are accepted alongside `message` because many call sites pass that shape.
export function pushToast({ message, title, description, kind, action, duration } = {}, ms) {
  const text = message ?? title;
  if (!text) return;
  const k = kindOf(kind);
  const t = { dismiss: null, remaining: duration ?? ms ?? 6000, startedAt: 0, timer: null };
  t.dismiss = Notify.create({
    message: String(text),
    caption: description || undefined,
    position: "bottom",
    timeout: 0, // the timer is the bridge's, so it can pause
    group: false,
    progress: false,
    multiLine: false,
    textColor: undefined, // Notify's default white text
    icon: k ? ICONS[k] : undefined,
    classes: `ui-toast ui-toast--${k || "normal"}`,
    attrs: { role: "status", "data-kind": k || "normal", onMouseenter: onEnter, onMouseleave: onLeave },
    actions: [
      { icon: CLOSE_ICON, class: "ui-toast__close", "aria-label": "Close toast", round: true, dense: true, ripple: false },
      ...(action ? [{ label: action.label, handler: action.fn, class: "ui-toast__action", noCaps: true, ripple: false }] : []),
    ],
    onDismiss: () => {
      if (t.timer !== null) clearTimeout(t.timer);
      const i = live.indexOf(t);
      if (i !== -1) live.splice(i, 1);
      // a toast closed under the pointer gets no mouseleave: the rest run again until the
      // pointer enters one of them
      hovered = false;
      sync();
    },
  });
  live.push(t);
  sync();
  while (live.length > MAX_VISIBLE) live[0].dismiss();
}

// Dismiss any visible toast.
export function clearToasts() {
  for (const t of [...live]) t.dismiss();
}
