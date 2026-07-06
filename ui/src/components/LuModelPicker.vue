<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// LuModelPicker — the ONE provider+model (route) picker for the shared AI UI.
// A "pin" is { providerId, model }: pick a provider, then its model; the empty
// fallback (null) inherits the default. Used by the routing defaults, the
// Feature Workbench's per-action editor, and its per-feature group default — so
// the control exists once, not copy-pasted per site. (Inheritance = the empty
// null fallback above; the old job/role-inherit options are gone.)
//
// v-model is the pin object (or null = inherit the empty fallback). The host
// owns persistence (writes the routing pin and saves).
import { computed, watch } from "vue";
import { useProviderModels } from "../composables/useProviderModels.js";
import LuCombobox from "./LuCombobox.vue";

const props = defineProps({
  modelValue: { type: Object, default: null }, // { providerId, model } | null
  providers: { type: Array, default: () => [] },
  // Text of the "no explicit provider" option (e.g. "Inherit default",
  // "Use Default LLM", "Default").
  inheritLabel: { type: String, default: "Inherit default" },
  compact: { type: Boolean, default: false }, // smaller selects (nav)
  labels: { type: Boolean, default: false },  // inline "Provider"/"Model" labels
  stacked: { type: Boolean, default: false }, // provider OVER model (1 col) for narrow columns
  // Model field is a pick-OR-type combobox (LuCombobox) rather than a native
  // <select> — for the main pickers (Default LLM/embedding, roles, per-action
  // editor) where a provider may not list the model (esp. embeddings, which are
  // usually typed in). The compact nav Set-all pickers keep the native select:
  // its popup escapes the overflow-clipped sticky nav column, a combobox's
  // absolutely-positioned list would not.
  editable: { type: Boolean, default: false },
  // "chat" | "embedding" — filters the suggestion list (chat hides embedding
  // models and vice-versa, mirroring the provider form's /embed/i split).
  kind: { type: String, default: "chat" },
});
const emit = defineEmits(["update:modelValue"]);

const byId = computed(() => Object.fromEntries(props.providers.map((p) => [p.id, p])));
const pin = computed(() => props.modelValue || { providerId: "", model: "" });
const route = computed(() => pin.value.providerId || "");

// Model lists come from THE shared per-provider cache (useProviderModels —
// one cache + one endpoint accessor kit-wide, C5); previously this component
// kept its own per-instance cache over the same endpoint. A provider with no
// key / unreachable just yields an empty list (the dropdown falls back to
// "(provider default)" + the saved default).
const { modelsFor, ensureModels } = useProviderModels();
// Fetch the pinned provider's models on mount + whenever it changes.
watch(() => pin.value.providerId, (pid) => { if (pid) ensureModels(pid); }, { immediate: true });

// Fetched models for a provider, filtered by kind so a chat picker doesn't
// suggest embedding models (and vice-versa) — same /embed/i split the provider
// form uses. Free text is always allowed in editable mode, so this only shapes
// the suggestion list, never restricts what can be entered.
const EMBED_RX = /embed/i;
function filteredModels(pid) {
  const all = modelsFor(pid);
  return props.kind === "embedding" ? all.filter((m) => EMBED_RX.test(m)) : all.filter((m) => !EMBED_RX.test(m));
}

// Models offered in the native <select>: the (kind-filtered) fetched list, plus
// "(provider default)" and any saved/pinned model not already in it (so the
// current value always shows).
function modelOptions(pid) {
  const p = byId.value[pid];
  const out = [{ value: "", label: "(provider default)" }];
  for (const m of filteredModels(pid)) out.push({ value: m, label: m });
  for (const extra of [props.kind === "embedding" ? p?.embeddingModel : p?.defaultModel, pin.value.model]) {
    if (extra && !out.some((o) => o.value === extra)) out.push({ value: extra, label: extra });
  }
  return out;
}
// Suggestions for the editable combobox — the kind-filtered fetched list. The
// current value lives in the input itself, so it needn't be injected here.
function comboItems(pid) { return filteredModels(pid); }
function setRoute(val) {
  if (!val) emit("update:modelValue", null);
  // keep the model only when staying on the same provider
  else emit("update:modelValue", { providerId: val, model: pin.value.providerId === val ? pin.value.model : "" });
}
function setModel(model) {
  emit("update:modelValue", { ...pin.value, model });
}
</script>

<template>
  <div class="lu-mp" :class="{ 'lu-mp--compact': compact, 'lu-mp--labels': labels, 'lu-mp--stacked': stacked }">
    <div class="lu-mp-field">
      <span v-if="labels" class="lu-mp-lbl">Provider</span>
      <select class="lu-input lu-mp-sel" :value="route" aria-label="Provider" @change="setRoute($event.target.value)">
        <option value="">{{ inheritLabel }}</option>
        <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}</option>
      </select>
    </div>
    <div class="lu-mp-field">
      <span v-if="labels" class="lu-mp-lbl">Model</span>
      <LuCombobox v-if="editable" :model-value="pin.model || ''" :items="comboItems(pin.providerId)"
        :disabled="!pin.providerId" :show-fetch="false"
        :placeholder="pin.providerId ? '(provider default)' : 'Pick a provider first'"
        @update:model-value="setModel" />
      <select v-else class="lu-input lu-mp-sel" :value="pin.model || ''" :disabled="!pin.providerId" aria-label="Model"
        :title="pin.providerId ? 'Models for the pinned provider' : 'Pick a provider first to choose its model'"
        @change="setModel($event.target.value)">
        <option v-for="o in modelOptions(pin.providerId)" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
    </div>
  </div>
</template>

<style scoped>
/* Provider + model always side by side (grid, never wrap), each filling its
   column so the selected value shows in full — no max-width truncation. */
.lu-mp { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; align-items: end; min-width: 0; }
.lu-mp-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.lu-mp-lbl { font-size: 11px; font-weight: 600; color: var(--muted); }
.lu-mp-sel { cursor: pointer; appearance: auto; width: 100%; min-width: 0; }
.lu-mp--compact .lu-mp-sel { font-size: 11px; padding: 3px 6px; }
/* Stacked: provider over model — full-width selects in a narrow column. */
.lu-mp--stacked { grid-template-columns: 1fr; }
/* The editable model field reuses LuCombobox — let it shrink to the grid cell
   instead of forcing its own 160px min-width, and fill the column. */
.lu-mp :deep(.lu-cb) { min-width: 0; }
.lu-mp :deep(.lu-cb-wrap) { width: 100%; }
</style>
