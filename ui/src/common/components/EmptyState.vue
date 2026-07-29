<!-- SPDX-License-Identifier: MIT -->
<!--
  EmptyState — centred "nothing here yet" placeholder: icon + title + body
  + optional primary action. Used inside cards, modal bodies, and full-pane
  empty states. App-agnostic; token-driven; supersedes the per-app forks.

  Slots:  actions — custom action area; replaces the default button.
  Props:  icon (Icon name, default "Sparkle") · iconSize (px, default 22) ·
          title · message · actionLabel (omit → no button) · compact.
  Emits:  "action" when the default action button is clicked.
-->
<script setup>
import Icon from "./Icon.vue";
import UiButton from "./UiButton.vue";

defineProps({
  icon: { type: String, default: "Sparkle" },
  iconSize: { type: [Number, String], default: 22 },
  title: { type: String, default: "" },
  message: { type: String, default: "" },
  actionLabel: { type: String, default: "" },
  compact: { type: Boolean, default: false },
});
const emit = defineEmits(["action"]);
</script>

<template>
  <div class="ui-empty" :class="{ 'ui-empty--compact': compact }">
    <Icon :name="icon" :size="iconSize" class="ui-empty__icon" />
    <h3 v-if="title" class="ui-empty__title">{{ title }}</h3>
    <p v-if="message" class="ui-empty__message">{{ message }}</p>
    <slot name="actions">
      <UiButton v-if="actionLabel" intent="primary" @click="emit('action')">
        {{ actionLabel }}
      </UiButton>
    </slot>
  </div>
</template>

<style scoped>
.ui-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 36px 16px;
  text-align: center;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-card, 10px);
}
.ui-empty--compact { padding: 20px 12px; }
.ui-empty__icon { color: var(--muted); }
.ui-empty__title {
  font-family: var(--font-display, inherit);
  font-size: 15px;
  font-weight: 600;
  margin: 0;
  color: var(--ink);
}
.ui-empty__message {
  color: var(--muted);
  font-size: 13px;
  line-height: 1.55;
  margin: 0 0 4px;
  max-width: 32em;
}
</style>
