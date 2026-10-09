// SPDX-License-Identifier: MIT
// Tab stays inside a modal: from its last control Tab goes to its first, and Shift+Tab from its
// first to its last — the loop the kit's modals had under Reka UI. QDialog (Quasar) traps focus
// its own way, which leaves a gap (measured on AppModal, Q3 slice 7 —
// docs/plans/2026-10-09-kit-controls-on-quasar.md): Tab past the last control lets the focus leave
// the page for one press, and the next press lands on the first control that carries a tabindex
// attribute, skipping plain buttons before it.
//
// Usage: a keydown listener on the dialog that calls wrapTab(event, panelElement). It acts only
// while the focus is in the panel (or on QDialog's own wrapper, where it starts), so the popups
// a modal opens (select lists, the feature chip's popover) keep their own Tab order.

const TABBABLE = [
  "a[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(", ");

function tabbables(root) {
  return [...root.querySelectorAll(TABBABLE)].filter(
    (el) => el.tabIndex >= 0 && el.getClientRects().length > 0 && !el.closest("[inert]"),
  );
}

export function wrapTab(e, panel) {
  if (e.key !== "Tab" || !panel) return;
  const active = document.activeElement;
  const onWrapper = active?.classList?.contains("q-dialog__inner");
  if (!panel.contains(active) && !onWrapper) return;
  const list = tabbables(panel);
  if (!list.length) return;
  const first = list[0];
  const last = list[list.length - 1];
  if (e.shiftKey && (active === first || onWrapper)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || onWrapper)) {
    e.preventDefault();
    first.focus();
  }
}
