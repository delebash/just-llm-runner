<script setup>
// SPDX-License-Identifier: MIT
// Every host element the shared UI needs mounted, as ONE tag in the app shell.
//
// These are not decorative. `confirmDialog()` resolves through whatever renders
// `<AppDialog />`; with no host mounted its promise never settles, so a confirmed
// action is a button that does nothing at all — measured in just_ai_i18n_docgen on
// 2026-08-03, where Change folder, Clear models cache, Clear spawn logs and Apply-all
// were ALL dead, under a green suite (the smoke test asserted the panel's strings,
// which is exactly what presence-testing cannot catch).
//
// One tag rather than a list, because the failure mode was mounting SOME of them.
import AppDialog from "../common/components/AppDialog.vue";
import Toast from "../common/components/Toast.vue";
</script>

<template>
  <Toast />
  <AppDialog />
</template>
