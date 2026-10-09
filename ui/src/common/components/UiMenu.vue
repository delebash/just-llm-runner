<!-- SPDX-License-Identifier: MIT -->
<script setup>
// Shared action menu — a trigger button (a row's ⋯) that opens a list of actions.
//
//   <UiMenu label="Persona actions" trigger-class="ev-kebab" content-class="ev-menu" align="end">
//     <template #trigger>⋯</template>
//     <UiMenuItem class="ev-menu-item" @select="edit(row)">Edit</UiMenuItem>
//     <UiMenuItem class="ev-menu-item" :disabled="!canMerge" @select="merge(row)">Merge into…</UiMenuItem>
//     <UiMenuSeparator class="ev-menu-sep" />
//     <UiMenuItem class="ev-menu-item danger" @select="remove(row)">Delete</UiMenuItem>
//   </UiMenu>
//
// Quasar's QMenu underneath (the kit's controls on Quasar — docs/plans/2026-10-09-kit-controls-
// on-quasar.md, slice 7b; Reka UI's DropdownMenu before it, whose shape this keeps): QMenu places
// the list under the trigger, closes it on Esc or an outside click and gives the focus back to the
// trigger; while it is open the page behind takes no pointer, so a click outside only closes it
// (useModalPopup), as Reka's did. The kit keeps the menu keyboard: Enter, Space or ↓ on the
// trigger opens it on its first item (↑ on its last); ↑/↓, Home/End and typing a label's first
// letters move between the items; Enter or Space picks; Tab stays in the menu (under Reka the
// focus stayed on the trigger and the keys did little). The items and the trigger carry Reka's
// state attributes (data-highlighted, data-disabled, data-state), so the hosts' styles still read
// them. The look is the caller's (its trigger and content classes).
import { QMenu } from "quasar";
import { provide, ref } from "vue";
import { MENU_KEY } from "./menuContext.js";
import { useModalPopup } from "../composables/useModalPopup.js";

let uid = 0;

const props = defineProps({
  label: { type: String, default: undefined }, // the trigger's aria-label (and its title, unless given)
  title: { type: String, default: undefined },
  triggerClass: { type: [String, Array, Object], default: undefined },
  contentClass: { type: [String, Array, Object], default: undefined },
  align: { type: String, default: "start" }, // start | end — which edges of trigger and list line up
  sideOffset: { type: Number, default: 4 },
  disabled: { type: Boolean, default: false },
});

const open = ref(false);
// while open, the page behind takes no pointer (Reka's menus were modal so)
useModalPopup(open);
const id = `ui-menu-${++uid}`;
const triggerId = `${id}-trigger`;
let focusOnOpen = null; // "first" | "last" — set when the keyboard opens the menu

const listEl = () => document.getElementById(id);
const items = () => [...(listEl()?.querySelectorAll('[role="menuitem"]:not([data-disabled])') ?? [])];
const focus = (el) => el?.focus({ preventScroll: true });

function onTriggerKeydown(e) {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    focusOnOpen = e.key === "ArrowDown" ? "first" : "last";
    if (open.value) onShow();
    else open.value = true;
  } else if (e.key === "Enter" || e.key === " ") {
    // the click the key makes opens the menu (QMenu's own anchor events are off — on a native
    // button they toggled twice for Enter, on its click and again on its keyup)
    focusOnOpen = "first";
  }
}
// A pointer leaves the focus on the trigger (no-focus), as Reka did; the keyboard puts it on an item.
function onShow() {
  const list = items();
  if (focusOnOpen === "first") focus(list[0]);
  else if (focusOnOpen === "last") focus(list[list.length - 1]);
  focusOnOpen = null;
}

let typed = "";
let typedTimer = null;
function onListKeydown(e) {
  const list = items();
  if (!list.length) return;
  const at = list.indexOf(document.activeElement);
  if (e.key === "ArrowDown") {
    e.preventDefault();
    focus(list[at < 0 ? 0 : Math.min(at + 1, list.length - 1)]);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    focus(list[at < 0 ? list.length - 1 : Math.max(at - 1, 0)]);
  } else if (e.key === "Home" || e.key === "PageUp") {
    e.preventDefault();
    focus(list[0]);
  } else if (e.key === "End" || e.key === "PageDown") {
    e.preventDefault();
    focus(list[list.length - 1]);
  } else if (e.key === "Tab") {
    e.preventDefault();
  } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key !== " " || typed)) {
    e.preventDefault();
    clearTimeout(typedTimer);
    typed += e.key.toLowerCase();
    typedTimer = setTimeout(() => { typed = ""; }, 1000);
    const from = typed.length === 1 ? at + 1 : Math.max(at, 0);
    const order = [...list.slice(from), ...list.slice(0, from)];
    focus(order.find((el) => el.textContent.trim().toLowerCase().replace(/^\W+/u, "").startsWith(typed)));
  }
}

function close() { open.value = false; }
// A click outside lands on nothing (the page takes no pointer while the menu is open), so the
// focus would be left on <body>: it goes back to the trigger, as Reka's did.
function onHide() {
  if (!document.activeElement || document.activeElement === document.body) focus(document.getElementById(triggerId));
}
provide(MENU_KEY, { close, focusList: () => focus(listEl()) });
</script>

<template>
  <button
    :id="triggerId"
    type="button"
    :class="triggerClass"
    :aria-label="label"
    :title="title ?? label"
    aria-haspopup="menu"
    :aria-expanded="open ? 'true' : 'false'"
    :aria-controls="open ? id : undefined"
    :data-state="open ? 'open' : 'closed'"
    :disabled="disabled"
    @click="open = !open"
    @keydown="onTriggerKeydown"
  >
    <slot name="trigger" />
    <QMenu
      :id="id"
      v-model="open"
      role="menu"
      :aria-labelledby="triggerId"
      :class="contentClass"
      style="pointer-events: auto"
      :anchor="align === 'end' ? 'bottom right' : 'bottom left'"
      :self="align === 'end' ? 'top right' : 'top left'"
      :offset="[0, sideOffset]"
      :transition-duration="0"
      no-focus
      no-parent-event
      @show="onShow"
      @hide="onHide"
      @keydown="onListKeydown"
    >
      <slot />
    </QMenu>
  </button>
</template>
