<script setup>
// SPDX-License-Identifier: GPL-3.0-or-later
// LuJobSelect — the ONE job-picker dropdown, over the LIVE editable job list
// (/v1/ai/jobs). Exists so every job dropdown (Routing-by-feature's per-feature
// classification, the Recommendations editor's job tag) reflects user-added /
// renamed / removed jobs instead of a hardcoded list — the bug that motivated it.
// v-model is the job id. Pass `:jobs` to reuse a list the parent already fetched
// (avoids a duplicate request); omit it and the component fetches its own.
import { computed, onMounted, ref } from "vue";

import { request } from "../client.js";
import UiSelect from "../common/components/UiSelect.vue";

const props = defineProps({
  modelValue: { type: String, default: "" },
  // Optional caller-supplied job list ([{id,label}]). null → self-fetch.
  jobs: { type: Array, default: null },
  // Label for the leading empty option (e.g. "— default job —"); "" → no empty option.
  emptyLabel: { type: String, default: "" },
  width: { type: String, default: "" },
});
const emit = defineEmits(["update:modelValue"]);

const fetched = ref([]);
async function load() {
  if (props.jobs) return; // parent supplies the list
  try { fetched.value = (await request("/v1/ai/jobs")).rows || []; } catch { fetched.value = []; }
}
onMounted(load);

const list = computed(() => props.jobs || fetched.value);
const options = computed(() => {
  const opts = props.emptyLabel ? [{ value: "", label: props.emptyLabel }] : [];
  for (const j of list.value) opts.push({ value: j.id, label: j.label || j.id });
  // Keep the current value visible even if it's not (or no longer) in the list.
  if (props.modelValue && !list.value.some((j) => j.id === props.modelValue)) {
    opts.push({ value: props.modelValue, label: props.modelValue });
  }
  return opts;
});
</script>

<template>
  <UiSelect :model-value="modelValue" :options="options" :width="width"
    @update:model-value="emit('update:modelValue', $event)" />
</template>
