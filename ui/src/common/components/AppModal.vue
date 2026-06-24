<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!--
  AppModal — shared generic modal wrapper (Reka UI Dialog). Same API both apps
  call: eyebrow / title / wide / noPadding / closable / closeLabel props +
  default / header / footer slots. Reka gives focus trap + scroll lock + Esc +
  ARIA; this ships self-contained, token-driven styles (no app global classes).
  Backdrop dismissal is ALWAYS locked; closable:false also blocks Esc + hides
  the X (for in-flight modals that hold an AbortSignal). Supersedes the per-app
  AppModal.vue forks (JV's `.jv-modal` + JW's `.app-modal`).

  Emits: close (after the leave transition, so a parent v-if removal doesn't
  tear the overlay mid-fade).
-->
<script setup>
import { ref, useSlots, watch } from "vue";
import {
  DialogRoot,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
  DialogClose,
  VisuallyHidden,
} from "reka-ui";
import Icon from "./Icon.vue";

const props = defineProps({
  eyebrow: { type: String, default: "" },
  title: { type: String, default: "" },
  wide: { type: Boolean, default: false },
  noPadding: { type: Boolean, default: false },
  closable: { type: Boolean, default: true },
  closeLabel: { type: String, default: "Close" }, // host may pass an i18n string
});
const emit = defineEmits(["close"]);

const slots = useSlots();
const TRANSITION_MS = 200;
const visible = ref(true);
let pending = null;
watch(visible, (v, prev) => {
  if (!v && prev) {
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => { pending = null; emit("close"); }, TRANSITION_MS);
  }
});
function close() { visible.value = false; }
defineExpose({ close });

// Reka fires escape-key-down BEFORE its built-in close; preventDefault() blocks
// it to enforce closable:false. Backdrop dismissal blocked unconditionally.
function onEscape(e) { if (!props.closable) e.preventDefault(); }
function onOutside(e) { e.preventDefault(); }
</script>

<template>
  <DialogRoot v-model:open="visible">
    <DialogPortal>
      <DialogOverlay class="ui-modal-overlay" />
      <DialogContent
        class="ui-modal"
        :class="{ 'ui-modal--wide': wide, 'ui-modal--flush': noPadding }"
        @escape-key-down="onEscape"
        @pointer-down-outside="onOutside"
        @interact-outside="onOutside"
      >
        <header class="ui-modal__header">
          <slot name="header">
            <DialogTitle as-child>
              <div class="ui-modal__titleblock">
                <div v-if="eyebrow" class="ui-modal__eyebrow">{{ eyebrow }}</div>
                <div v-if="title" class="ui-modal__title">{{ title }}</div>
              </div>
            </DialogTitle>
          </slot>
          <!-- Reka requires a DialogTitle for a11y; when a #header slot replaces
               ours, mount a visually-hidden one. -->
          <VisuallyHidden v-if="slots.header" as-child>
            <DialogTitle>{{ title || "Dialog" }}</DialogTitle>
          </VisuallyHidden>
          <DialogClose v-if="closable" class="ui-modal__close" :aria-label="closeLabel">
            <Icon name="Close" :size="14" />
          </DialogClose>
        </header>

        <div class="ui-modal__body">
          <slot />
        </div>

        <footer v-if="slots.footer" class="ui-modal__footer">
          <slot name="footer" />
        </footer>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style scoped>
.ui-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 200;
  background: var(--scrim, color-mix(in oklab, black 36%, transparent));
  backdrop-filter: blur(3px);
  animation: ui-modal-overlay-in 0.16s ease-out;
}
.ui-modal-overlay[data-state="closed"] { animation: ui-modal-overlay-out 0.16s ease-in forwards; }
@keyframes ui-modal-overlay-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes ui-modal-overlay-out { from { opacity: 1; } to { opacity: 0; } }

.ui-modal {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 201;
  width: min(560px, 92vw);
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--surface);
  color: var(--ink);
  border: 1px solid var(--border);
  border-radius: var(--r-card, var(--r-md, 10px));
  box-shadow: var(--shadow-3, var(--shadow-2, 0 12px 40px rgba(0, 0, 0, 0.2)));
  animation: ui-modal-in 0.18s ease-out;
}
.ui-modal[data-state="closed"] { animation: ui-modal-out 0.16s ease-in forwards; }
@keyframes ui-modal-in {
  from { opacity: 0; transform: translate(-50%, -48%) scale(0.98); }
  to   { opacity: 1; transform: translate(-50%, -50%) scale(1); }
}
@keyframes ui-modal-out {
  from { opacity: 1; transform: translate(-50%, -50%) scale(1); }
  to   { opacity: 0; transform: translate(-50%, -48%) scale(0.98); }
}
.ui-modal--wide { width: min(840px, 94vw); }
.ui-modal--flush .ui-modal__body { padding: 0; }

.ui-modal__header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 20px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.ui-modal__titleblock { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.ui-modal__eyebrow {
  font-size: 10.5px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
}
.ui-modal__title {
  font-family: var(--font-display, inherit);
  font-size: 16px;
  font-weight: 600;
  color: var(--ink);
  margin: 0;
  line-height: 1.25;
}
.ui-modal__close {
  appearance: none;
  background: transparent;
  border: 0;
  color: var(--muted);
  cursor: pointer;
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border-radius: var(--r-sm, 6px);
  flex-shrink: 0;
}
.ui-modal__close:hover { background: var(--hover, var(--surface-2)); color: var(--ink); }
.ui-modal__body { padding: 18px 20px; overflow-y: auto; flex: 1; min-height: 0; }
.ui-modal__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 20px;
  border-top: 1px solid var(--border);
  background: var(--surface-2);
  flex-shrink: 0;
}
</style>
