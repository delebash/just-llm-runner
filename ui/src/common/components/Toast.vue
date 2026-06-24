<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!--
  Shared Toast host — mount once in the host's App.vue. vue-sonner positions
  toasts in a portal and handles stacking, timing, and hover-pause. The bridge
  (services/toastBridge.js → pushToast / clearToasts) drives it imperatively.
  App-agnostic; the host styles the `.ui-toaster` class for its own stacking
  context (e.g. z-index). Supersedes the per-app Toast.vue forks.
-->
<script setup>
import { Toaster } from "vue-sonner";
// vue-sonner ships its own base CSS that its components rely on for
// positioning, animation, and the close button. Without it the toast renders
// as plain unstyled text. Co-located here so the dependency is visible next to
// the component usage.
import "vue-sonner/style.css";
</script>

<template>
  <Toaster
    position="bottom-center"
    :duration="6000"
    :gap="10"
    :visible-toasts="3"
    :offset="40"
    close-button
    rich-colors
    class="ui-toaster"
  />
</template>
