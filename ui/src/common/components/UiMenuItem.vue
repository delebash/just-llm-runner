<!-- SPDX-License-Identifier: MIT -->
<script setup>
// One action in a UiMenu (see UiMenu.vue). Emits `select` with an Event when picked — by a
// click, or Enter/Space while it has the focus — and the menu then closes unless the handler
// called preventDefault() on that event, as Reka's DropdownMenuItem did. The pointer moving over
// an item focuses it, and the focused item carries data-highlighted (its look is the host's); a
// `disabled` item carries data-disabled, stays in the list and is skipped by the keys.
import { inject, ref } from "vue";
import { MENU_KEY } from "./menuContext.js";

const props = defineProps({
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits(["select"]);
const menu = inject(MENU_KEY, null);
const el = ref(null);
const highlighted = ref(false);

function select() {
  if (props.disabled) return;
  const ev = new Event("select", { cancelable: true });
  emit("select", ev);
  if (!ev.defaultPrevented) menu?.close();
}
function onKeydown(e) {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    select();
  }
}
function onPointerMove() {
  if (!props.disabled && document.activeElement !== el.value) el.value?.focus({ preventScroll: true });
}
function onPointerLeave() {
  if (document.activeElement === el.value) menu?.focusList();
}
</script>

<template>
  <div
    ref="el"
    role="menuitem"
    tabindex="-1"
    :aria-disabled="disabled ? 'true' : undefined"
    :data-disabled="disabled ? '' : undefined"
    :data-highlighted="highlighted ? '' : undefined"
    @focus="highlighted = true"
    @blur="highlighted = false"
    @pointermove="onPointerMove"
    @pointerleave="onPointerLeave"
    @click="select"
    @keydown="onKeydown"
  >
    <slot />
  </div>
</template>
