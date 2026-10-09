<script setup>
// SPDX-License-Identifier: MIT
// Shared tag — a label on a row, a card or a heading: one `intent` picks its colours, as on
// UiButton. Supersedes JwTag/JvTag. `removable` adds the ✕ affordance (born for the i18n app's
// glossary terms, 2026-08-03 — new capabilities land in the KIT, never an app).
//
// Quasar's QBadge underneath (the kit's controls on Quasar —
// docs/plans/2026-10-09-kit-controls-on-quasar.md). The family look is the kit's theme
// (../../quasar/theme.css, "Tag"): an intent sets --ui-tag-bg / --ui-tag-ink / --ui-tag-border,
// so a host adds an intent of its own (JustVoice's ui-tag--violet) by setting those three.
// QBadge marks itself role="status" (a live region); a tag is not one, so the role is dropped.
import { QBadge } from "quasar";
import { computed } from "vue";

const props = defineProps({
  intent: { type: String, default: "primary" }, // primary | secondary | success | info | accent2 | danger | solid | ghost
  value: { type: [String, Number], default: "" },
  removable: { type: Boolean, default: false },
});
const emit = defineEmits(["remove"]);
const classes = computed(() => ["ui-tag", `ui-tag--${props.intent}`]);
</script>

<template>
  <QBadge :class="classes" :role="null">
    <slot name="icon" />
    <slot>{{ value }}</slot>
    <button
      v-if="removable" type="button" class="ui-tag__x"
      :aria-label="`Remove ${value || 'tag'}`" @click.stop="emit('remove')"
    >✕</button>
  </QBadge>
</template>
