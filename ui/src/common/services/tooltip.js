// SPDX-License-Identifier: MIT
// Shared v-tooltip directive. Floating UI handles positioning (flip + shift
// fallbacks) so a tooltip near the viewport edge bounces to a side that fits.
// Delay-debounced show on hover OR focus, instant hide on click. App-agnostic
// (styles ride on the global .ui-tooltip rule in common/styles.css). Supersedes
// the per-app services/tooltip.js forks.
//
//   v-tooltip="'text'"            — defaults to bottom
//   v-tooltip.top/.bottom/.left/.right="'text'"
//   v-tooltip.bottom="expr"       — reactive string is fine; updated() syncs

import { computePosition, autoUpdate, offset, flip, shift } from "@floating-ui/dom";

const SHOW_DELAY = 350;
const HIDE_DELAY = 80;
let idCounter = 0;

function placementFromModifiers(mods) {
  if (mods.top) return "top";
  if (mods.bottom) return "bottom";
  if (mods.left) return "left";
  if (mods.right) return "right";
  return "bottom";
}

function createTooltipEl(content) {
  const el = document.createElement("div");
  el.className = "ui-tooltip";
  el.setAttribute("role", "tooltip");
  el.id = `ui-tt-${++idCounter}`;
  el.textContent = content;
  document.body.appendChild(el);
  return el;
}

// One state record per element with the directive applied. Stored on the element
// under a non-enumerable property to survive Vue's reactivity layer.
function stateFor(el) {
  return el.__uiTooltip;
}

function setupState(el, content, placement) {
  let tooltipEl = null;
  let cleanupPos = null;
  let showTimer = null;
  let hideTimer = null;

  // QC-33/34 (#231): while a tooltip is VISIBLE, any scroll, pointerdown, or
  // Escape kills it instantly — a tooltip that outlives the interaction that
  // summoned it is the "stuck" class the user kept hitting. Document-level,
  // capture-phase (scrolls in nested panes don't bubble), attached only for
  // the tooltip's lifetime.
  const onDocInteract = () => killNow();
  const onDocKey = (e) => { if (e.key === "Escape") killNow(); };
  function addDocListeners() {
    document.addEventListener("scroll", onDocInteract, { capture: true, passive: true });
    document.addEventListener("pointerdown", onDocInteract, { capture: true });
    document.addEventListener("keydown", onDocKey, { capture: true });
  }
  function removeDocListeners() {
    document.removeEventListener("scroll", onDocInteract, { capture: true });
    document.removeEventListener("pointerdown", onDocInteract, { capture: true });
    document.removeEventListener("keydown", onDocKey, { capture: true });
  }

  // Immediate teardown — no fade, no timers. The one path every kill route
  // (click, scroll, Escape, detached anchor, destroy) funnels through.
  function killNow() {
    clearTimeout(showTimer); showTimer = null;
    clearTimeout(hideTimer); hideTimer = null;
    if (cleanupPos) { cleanupPos(); cleanupPos = null; }
    removeDocListeners();
    if (tooltipEl) { tooltipEl.remove(); tooltipEl = null; }
    el.removeAttribute("aria-describedby");
  }

  const show = () => {
    clearTimeout(hideTimer);
    if (tooltipEl || !s.content) return;
    showTimer = setTimeout(() => {
      // The anchor can leave the DOM during the show delay (a closing modal,
      // a re-rendered row) — never open against a detached node.
      if (!el.isConnected) return;
      tooltipEl = createTooltipEl(s.content);
      el.setAttribute("aria-describedby", tooltipEl.id);
      addDocListeners();
      cleanupPos = autoUpdate(el, tooltipEl, () => {
        // QC-33 root cause: an anchor detached by non-Vue DOM ops (editor
        // content, swapped rows) never fires beforeUnmount OR mouseleave —
        // the orphaned tooltip then positions against a dead 0×0 reference
        // and sticks at the top-left corner forever. Detect and kill.
        if (!el.isConnected) { killNow(); return; }
        if (!tooltipEl) return;
        computePosition(el, tooltipEl, {
          strategy: "fixed",
          placement: s.placement,
          middleware: [offset(6), flip(), shift({ padding: 6 })],
        }).then(({ x, y }) => {
          if (!tooltipEl) return;
          tooltipEl.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
        });
      });
      requestAnimationFrame(() => tooltipEl?.classList.add("is-visible"));
    }, SHOW_DELAY);
  };

  // QC-34: clicking a control keeps it focused, and a bare `focus` listener
  // re-summons the tooltip the pointer already dismissed — only KEYBOARD
  // focus (:focus-visible) should show it.
  const onFocus = () => {
    try {
      if (!el.matches(":focus-visible")) return;
    } catch { /* older engines without :focus-visible — show as before */ }
    show();
  };

  const hide = () => {
    clearTimeout(showTimer);
    if (!tooltipEl) return;
    hideTimer = setTimeout(() => {
      if (!tooltipEl) return;
      tooltipEl.classList.remove("is-visible");
      if (cleanupPos) { cleanupPos(); cleanupPos = null; }
      removeDocListeners();
      const node = tooltipEl;
      tooltipEl = null;
      el.removeAttribute("aria-describedby");
      // Let the fade-out finish before removing from the DOM.
      setTimeout(() => node.remove(), 160);
    }, HIDE_DELAY);
  };

  const s = {
    content,
    placement,
    show, hide,
    destroy() {
      killNow();
      el.removeEventListener("mouseenter", show);
      el.removeEventListener("mouseleave", hide);
      el.removeEventListener("focus", onFocus);
      el.removeEventListener("blur", hide);
      el.removeEventListener("click", killNow);
    },
  };

  el.addEventListener("mouseenter", show);
  el.addEventListener("mouseleave", hide);
  el.addEventListener("focus", onFocus);
  el.addEventListener("blur", hide);
  el.addEventListener("click", killNow);

  Object.defineProperty(el, "__uiTooltip", { value: s, configurable: true, writable: true });
}

export const tooltipDirective = {
  mounted(el, binding) {
    const content = binding.value == null ? "" : String(binding.value);
    if (!content) return;
    setupState(el, content, placementFromModifiers(binding.modifiers));
  },
  updated(el, binding) {
    const content = binding.value == null ? "" : String(binding.value);
    const placement = placementFromModifiers(binding.modifiers);
    const s = stateFor(el);
    if (!s) {
      if (content) setupState(el, content, placement);
      return;
    }
    if (!content) { s.destroy(); el.__uiTooltip = null; return; }
    s.content = content;
    s.placement = placement;
  },
  beforeUnmount(el) {
    const s = stateFor(el);
    if (s) { s.destroy(); el.__uiTooltip = null; }
  },
};
