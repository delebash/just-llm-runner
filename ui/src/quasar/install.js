// SPDX-License-Identifier: MIT
// The family's Quasar theme at runtime: installLlmUi() calls installQuasarTheme() once, in every
// app's boot file. Quasar itself is installed by the app (Quasar's CLI, before any boot file);
// this only sets what a quasar.config.js can't name — the kit's icon set (./iconSet.js).
//
// Dark mode needs no bridge: the kit's controls take every colour from the appearance engine's
// live CSS variables (tokens.css, switched by <html data-theme>), so Quasar's Dark plugin stays
// off and Quasar's light-mode colours never show — theme.css restates each one Quasar sets.
import { IconSet, Notify, Quasar } from "quasar";
import { createApp } from "vue";
import iconSet from "./iconSet.js";

export function installQuasarTheme() {
  IconSet.set(iconSet);
}

// Quasar's options for an app Quasar's CLI doesn't start: the settings every app's
// quasar.config.js gives its `framework` (ripple off, the Notify plugin the toasts run on — the
// guard checks both) plus the icon set.
export const QUASAR_TEST_OPTIONS = { config: { ripple: false }, plugins: { Notify }, iconSet };

// A unit test that mounts a component made of the kit's controls creates its app with this
// instead of Vue's createApp: the same app, with Quasar installed as Quasar's CLI installs it in
// the real app. Imported by path (`@delebash/llm-ui/quasar/install.js`), so a test that mocks
// the kit's barrel still gets it.
export function createTestApp(...args) {
  return createApp(...args).use(Quasar, QUASAR_TEST_OPTIONS);
}
