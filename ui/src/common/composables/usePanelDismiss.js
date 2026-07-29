// SPDX-License-Identifier: MIT
// THE one panel-dismiss behaviour: Esc + click-outside closes a slide-in panel.
// Extracted from JustWrite's ChatPanel (2026-07-19) so every panel — Ask-the-book,
// AI tasks, and any future one — dismisses identically instead of each re-deriving
// the same three edge cases. Its explanatory comments moved here VERBATIM; they are
// the reason this is mousedown-based and selector-exempted, and they must not be lost.
//
// PANELS ONLY. Modals keep their locked backdrop (AppModal's `dismissable: false`
// default is deliberate — it prevents accidental data loss). Do not wire this into
// AppModal.
//
// Usage:
//   const panelEl = ref(null);
//   usePanelDismiss(() => open.value, panelEl, close);
//   // extra host-specific exemptions:
//   usePanelDismiss(() => tasks.panelOpen, panelEl, close, {
//     exempt: ["[data-sonner-toast]"],
//   });
import { onBeforeUnmount, unref } from "vue";

// Toggle triggers carry this attribute. Without the exemption, clicking a trigger
// while its panel is open would close the panel on mousedown, and the trigger's own
// click handler would then re-open it — the toggle would look dead.
export const PANEL_TOGGLE_ATTR = "[data-panel-toggle]";

// Surfaces that are visually "inside" the panel but live elsewhere in the DOM:
//   - [role="dialog"] — portaled modals (e.g. IndexBuildModal via AppModal)
//     teleport outside the panel; clicks inside them aren't "outside".
//   - [role="listbox"] / .ui-select-content / [data-reka-popper-content-wrapper] —
//     Reka Select popover content (character/model pickers) is portaled outside
//     the panel element.
const PORTAL_EXEMPTIONS = '[role="dialog"], [role="listbox"], .ui-select-content, [data-reka-popper-content-wrapper]';

/**
 * @param {import("vue").Ref<boolean>|(() => boolean)} isOpen  panel open-state
 * @param {import("vue").Ref<HTMLElement|null>} panelEl        template ref to the panel root
 * @param {() => void} close                                   closes the panel
 * @param {{ exempt?: string[] }} [options]                    extra exempt selectors
 */
export function usePanelDismiss(isOpen, panelEl, close, options = {}) {
  const extra = Array.isArray(options.exempt) ? options.exempt : [];
  const exemptSelector = [PANEL_TOGGLE_ATTR, PORTAL_EXEMPTIONS, ...extra].join(", ");

  const open = () => (typeof isOpen === "function" ? isOpen() : !!unref(isOpen));

  function onDocKeydown(e) {
    if (e.key === "Escape" && open()) {
      e.stopPropagation();
      close();
    }
  }

  // Click-outside dismissal. Listens on mousedown rather than click because
  // Reka's Select removes the dropdown content from the DOM synchronously on
  // selection — by the time a click bubbles to document, target.closest()
  // returns null because the option's ancestors are detached. Mousedown fires
  // before Reka's handler so closest() still walks an intact tree.
  function onDocMousedown(e) {
    if (!open()) return;
    const target = e.target;
    const root = unref(panelEl);
    if (!target || !root) return;
    if (root.contains(target)) return;
    if (target.closest?.(exemptSelector)) return;
    close();
  }

  document.addEventListener("keydown", onDocKeydown);
  document.addEventListener("mousedown", onDocMousedown);
  onBeforeUnmount(() => {
    document.removeEventListener("keydown", onDocKeydown);
    document.removeEventListener("mousedown", onDocMousedown);
  });

  // Returned for tests + hosts that need to tear down early.
  return {
    destroy() {
      document.removeEventListener("keydown", onDocKeydown);
      document.removeEventListener("mousedown", onDocMousedown);
    },
  };
}
