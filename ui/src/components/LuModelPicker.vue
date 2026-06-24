<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// LuModelPicker — the ONE provider+model (route) picker for the shared AI UI.
// A "pin" is { providerId, model, role }: pick a provider (then its model), or
// inherit (a role, or the empty fallback). Used by the Feature Workbench's
// per-action editor, its per-feature group default, and the Quick/Accuracy
// roles — so the control exists once, not copy-pasted per site.
//
// v-model is the pin object (or null = inherit the empty fallback). The host
// owns persistence (writes routing pins / role targets and saves).
import { computed } from "vue";

const props = defineProps({
  modelValue: { type: Object, default: null }, // { providerId, model, role } | null
  providers: { type: Array, default: () => [] },
  // Text of the "no explicit provider" option (e.g. "Inherit default",
  // "Use Default LLM", "Default").
  inheritLabel: { type: String, default: "Inherit default" },
  // Offer "inherit a role" (Quick/Accuracy) options. Off for the roles editor
  // itself (a role can't inherit a role).
  showRoles: { type: Boolean, default: true },
  compact: { type: Boolean, default: false }, // smaller selects (nav)
  labels: { type: Boolean, default: false },  // inline "Provider"/"Model" labels
});
const emit = defineEmits(["update:modelValue"]);

const byId = computed(() => Object.fromEntries(props.providers.map((p) => [p.id, p])));
const pin = computed(() => props.modelValue || { providerId: "", model: "", role: "" });
const route = computed(() => (pin.value.role ? `role:${pin.value.role}` : pin.value.providerId || ""));

// Models offered for a provider. A real per-provider list needs a backend
// endpoint; until then it's "(provider default)" + the provider's saved default.
function modelOptions(pid) {
  const p = byId.value[pid];
  const out = [{ value: "", label: "(provider default)" }];
  if (p?.defaultModel) out.push({ value: p.defaultModel, label: p.defaultModel });
  return out;
}
function setRoute(val) {
  if (!val) emit("update:modelValue", null);
  else if (val.startsWith("role:")) emit("update:modelValue", { providerId: "", model: "", role: val.slice(5) });
  // keep the model only when staying on the same provider
  else emit("update:modelValue", { providerId: val, model: pin.value.providerId === val ? pin.value.model : "", role: "" });
}
function setModel(model) {
  emit("update:modelValue", { ...pin.value, model });
}
</script>

<template>
  <div class="lu-mp" :class="{ 'lu-mp--compact': compact, 'lu-mp--labels': labels }">
    <div class="lu-mp-field">
      <span v-if="labels" class="lu-mp-lbl">Provider</span>
      <select class="lu-input lu-mp-sel" :value="route" aria-label="Provider" @change="setRoute($event.target.value)">
        <option value="">{{ inheritLabel }}</option>
        <template v-if="showRoles">
          <option value="role:quick">Inherit · Quick</option>
          <option value="role:accuracy">Inherit · Accuracy</option>
        </template>
        <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}</option>
      </select>
    </div>
    <div class="lu-mp-field">
      <span v-if="labels" class="lu-mp-lbl">Model</span>
      <select class="lu-input lu-mp-sel" :value="pin.model || ''" :disabled="!pin.providerId" aria-label="Model"
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
</style>
