// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * useRovingTabindex — keyboard focus management for linear lists.
 *
 * Usage:
 *   const { activeIndex, getTabindex, onKeydown, registerItem } =
 *     useRovingTabindex({ length, orientation, loop, onActivate })
 *
 * Parameters (all reactive-compatible):
 *   length      — ref / computed / plain number: current item count
 *   orientation — 'vertical' | 'horizontal' | 'both' (default 'vertical')
 *   loop        — boolean, default true; wrap focus at list ends
 *   onActivate  — function(index) called on Enter / Space
 *
 * Returns:
 *   activeIndex, getTabindex, onKeydown, registerItem, focusAt
 *
 * Shared util for the common UI kit (the future @delebash/ui). Only depends on
 * vue, so it's host-agnostic.
 */

import { ref, toValue } from "vue";

export function useRovingTabindex({ length, orientation = "vertical", loop = true, onActivate } = {}) {
  const activeIndex = ref(-1);

  // Sparse element registry — index → HTMLElement. Updated imperatively.
  const _els = new Map();

  function _len() {
    return toValue(length) ?? 0;
  }

  function _focus(i) {
    activeIndex.value = i;
    const el = _els.get(i);
    if (el) {
      el.focus();
    }
  }

  function getTabindex(i) {
    const active = activeIndex.value;
    if (active === -1) return i === 0 ? 0 : -1;
    return i === active ? 0 : -1;
  }

  function onKeydown(e, idx) {
    const max = _len() - 1;
    if (max < 0) return;

    const isHoriz = orientation === "horizontal" || orientation === "both";
    const isVert = orientation === "vertical" || orientation === "both";

    let target = idx;
    let handled = true;

    if ((e.key === "ArrowDown" && isVert) || (e.key === "ArrowRight" && isHoriz)) {
      target = idx >= max ? (loop ? 0 : max) : idx + 1;
    } else if ((e.key === "ArrowUp" && isVert) || (e.key === "ArrowLeft" && isHoriz)) {
      target = idx <= 0 ? (loop ? max : 0) : idx - 1;
    } else if (e.key === "Home") {
      target = 0;
    } else if (e.key === "End") {
      target = max;
    } else if (e.key === "Enter" || e.key === " ") {
      if (onActivate) onActivate(idx);
      e.preventDefault();
      return;
    } else {
      handled = false;
    }

    if (handled) {
      e.preventDefault();
      _focus(target);
    }
  }

  function registerItem(index, el) {
    if (el) {
      _els.set(index, el);
    } else {
      _els.delete(index);
    }
  }

  function focusAt(i) {
    _focus(i);
  }

  return { activeIndex, getTabindex, onKeydown, registerItem, focusAt };
}
