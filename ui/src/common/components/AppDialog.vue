<!-- SPDX-License-Identifier: MIT -->
<!--
  AppDialog — shared singleton host for promptDialog() / confirmDialog()
  (../services/dialog.js). Mount ONCE at the top of App.vue. Supersedes the
  per-app AppDialog.vue forks (JV's `.jv-dialog` + JW's `.app-dialog`).

  Built ON the shared AppModal shell — one overlay / animation / token system,
  no second modal frame to keep in sync. The imperative service drives an
  internal `hostOpen` v-if; confirm/cancel stash a result then call AppModal's
  exposed close() so its leave animation plays before we resolve the promise on
  the post-animation @close. Backdrop + Esc resolve to the cancel sentinel
  (false for confirm, null for prompt).

  Field types: text (default) · textarea · select (the union of both forks).
  Labels fall back to dialogLabels (configurable via configureDialog for i18n).
-->
<script setup>
import { computed, nextTick, ref, watch } from "vue";
import { dialogState, _resolveDialog, dialogLabels } from "../services/dialog.js";
import AppModal from "./AppModal.vue";
import UiButton from "./UiButton.vue";
import UiInput from "./UiInput.vue";
import UiTextarea from "./UiTextarea.vue";
import UiSelect from "./UiSelect.vue";

// Normalize the active dialog into a single shape the template reads. A
// single-field prompt becomes a one-element `fields` list so the template
// handles exactly one case.
const dialog = computed(() => {
  if (!dialogState.kind) return null;
  const opts = dialogState.options || {};
  if (dialogState.kind === "confirm") {
    return {
      kind: "confirm",
      title: opts.title || dialogLabels.defaultTitle,
      message: opts.message || "",
      confirmLabel: opts.confirmLabel || dialogLabels.confirmLabel,
      cancelLabel: opts.cancelLabel || dialogLabels.cancelLabel,
      danger: !!opts.danger,
    };
  }
  const fields = Array.isArray(opts.fields) && opts.fields.length
    ? opts.fields
    : [{
        key: "value",
        label: opts.label || "",
        placeholder: opts.placeholder || "",
        defaultValue: opts.defaultValue ?? "",
        type: opts.type || "text",
        options: opts.options,
      }];
  return {
    kind: "prompt",
    title: opts.title || "",
    message: opts.message || "",
    confirmLabel: opts.confirmLabel || dialogLabels.okLabel,
    cancelLabel: opts.cancelLabel || dialogLabels.cancelLabel,
    danger: !!opts.danger,
    fields,
    isSingle: !Array.isArray(opts.fields),
    // requireMatch: the first field's value must equal this string before
    // Confirm enables ("type DELETE to confirm"-style guards).
    requireMatch: opts.requireMatch || null,
  };
});

// hostOpen drives the AppModal v-if. It stays true through the leave animation
// (cleared in onClosed) so the overlay doesn't tear mid-fade.
const hostOpen = ref(false);
const modalRef = ref(null);
// The value the pending promise resolves to. Seeded to the cancel sentinel on
// open so backdrop / Esc / X (which close AppModal directly) resolve to cancel.
let pendingResult = null;

const values = ref({});
const firstInput = ref(null);

watch(
  () => dialogState.open,
  async (open) => {
    if (!open || !dialog.value) return;
    pendingResult = dialog.value.kind === "confirm" ? false : null;
    if (dialog.value.kind === "prompt") {
      const next = {};
      for (const f of dialog.value.fields) next[f.key] = f.defaultValue ?? "";
      values.value = next;
    }
    hostOpen.value = true;
    await nextTick();
    const el = firstInput.value;
    if (el) { el.focus?.(); if (typeof el.select === "function") el.select(); }
  },
  { immediate: true },
);

const canSubmit = computed(() => {
  const d = dialog.value;
  if (d?.kind !== "prompt") return true;
  if (d.requireMatch != null) {
    const first = d.fields[0]?.key;
    if (String(values.value[first] ?? "") !== d.requireMatch) return false;
  }
  for (const f of d.fields) {
    if (f.type === "select") continue;
    if (f.optional) continue;
    const v = String(values.value[f.key] ?? "").trim();
    if (!v) return false;
  }
  return true;
});

// Capture the first field's DOM node so focus()/select() work whether the ref
// is a native element or a component instance ($el).
function captureFirst(el, i) {
  if (i !== 0) return;
  firstInput.value = el?.$el ?? el ?? null;
}

// Begin closing: stash the result, then play AppModal's leave animation. The
// promise resolves in onClosed (fired after the transition).
function dismiss(result) {
  pendingResult = result;
  modalRef.value?.close();
}

function cancel() {
  if (!dialog.value) return;
  dismiss(dialog.value.kind === "confirm" ? false : null);
}

function submit() {
  const d = dialog.value;
  if (!d) return;
  if (d.kind === "confirm") { dismiss(true); return; }
  if (!canSubmit.value) return;
  if (d.isSingle) {
    dismiss(String(values.value[d.fields[0].key] ?? "").trim());
  } else {
    const out = {};
    for (const f of d.fields) {
      const raw = values.value[f.key];
      out[f.key] = typeof raw === "string" ? raw.trim() : raw;
    }
    dismiss(out);
  }
}

// AppModal finished its leave animation (backdrop/Esc/X or our dismiss()).
function onClosed() {
  hostOpen.value = false;
  _resolveDialog(pendingResult);
}

function onEnter(e, isLastField) {
  if (e.shiftKey) return;
  if (isLastField) { e.preventDefault(); submit(); }
}
</script>

<template>
  <AppModal
    v-if="hostOpen"
    ref="modalRef"
    :title="dialog?.title || ''"
    :close-label="dialog?.cancelLabel || dialogLabels.closeLabel"
    :max-width="'440px'"
    dismissable
    @close="onClosed"
  >
    <div v-if="dialog" class="ui-dialog__body">
      <p v-if="dialog.message" class="ui-dialog__message">{{ dialog.message }}</p>

      <template v-if="dialog.kind === 'prompt'">
        <div
          v-for="(f, i) in dialog.fields"
          :key="f.key"
          class="ui-dialog__field"
        >
          <label v-if="f.label" class="ui-dialog__label" :for="`ui-field-${f.key}`">{{ f.label }}</label>
          <UiSelect
            v-if="f.type === 'select'"
            :input-id="`ui-field-${f.key}`"
            :ref="el => captureFirst(el, i)"
            v-model="values[f.key]"
            :options="f.options || []"
          />
          <UiTextarea
            v-else-if="f.type === 'textarea'"
            :id="`ui-field-${f.key}`"
            :ref="el => captureFirst(el, i)"
            :placeholder="f.placeholder || ''"
            :rows="f.rows || 6"
            v-model="values[f.key]"
            @keydown.escape.prevent="cancel"
          />
          <UiInput
            v-else
            :id="`ui-field-${f.key}`"
            :ref="el => captureFirst(el, i)"
            :type="f.type || 'text'"
            :placeholder="f.placeholder || ''"
            v-model="values[f.key]"
            @keydown.enter="onEnter($event, i === dialog.fields.length - 1)"
            @keydown.escape.prevent="cancel"
          />
          <span v-if="f.help" class="ui-dialog__help">{{ f.help }}</span>
        </div>
      </template>
    </div>

    <template #footer>
      <UiButton intent="ghost" :label="dialog?.cancelLabel || dialogLabels.cancelLabel" @click="cancel" />
      <UiButton
        :intent="dialog?.danger ? 'danger' : 'primary'"
        :label="dialog?.confirmLabel || dialogLabels.okLabel"
        :disabled="!canSubmit"
        @click="submit"
      />
    </template>
  </AppModal>
</template>

<style scoped>
.ui-dialog__body { display: flex; flex-direction: column; gap: 14px; }
.ui-dialog__message {
  font-size: 13px;
  line-height: 1.5;
  color: var(--ink-2, var(--muted));
  white-space: pre-line;
  margin: 0;
}
.ui-dialog__field { display: flex; flex-direction: column; gap: 6px; }
.ui-dialog__label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
}
.ui-dialog__help { font-size: 11.5px; color: var(--muted); }
</style>
