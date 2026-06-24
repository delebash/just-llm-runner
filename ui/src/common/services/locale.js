// SPDX-License-Identifier: GPL-3.0-or-later
// Shared UI locale — the BCP-47 tag kit components use for locale-aware
// formatting (currently UiNumber's Intl.NumberFormat grouping/decimals). Kept
// here so the kit stays decoupled from any one i18n library: the host calls
// setUiLocale(tag) once at boot and again whenever it switches language (e.g.
// from a vue-i18n locale watcher). null = the runtime's default locale.
//
//   import { setUiLocale } from "@delebash/llm-ui";
//   setUiLocale(i18n.global.locale.value);   // and re-call on locale change

import { ref } from "vue";

export const uiLocale = ref(null);

export function setUiLocale(tag) {
  uiLocale.value = tag || null;
}
