// SPDX-License-Identifier: MIT
// The family's Quasar theme at runtime: installLlmUi() calls installQuasarTheme() once, in every
// app's boot file. Quasar itself is installed by the app (Quasar's CLI, before any boot file);
// this only sets what a quasar.config.js can't name — the kit's icon set (./iconSet.js).
//
// Dark mode needs no bridge: the kit's controls take every colour from the appearance engine's
// live CSS variables (tokens.css, switched by <html data-theme>), so Quasar's Dark plugin stays
// off and Quasar's light-mode colours never show — theme.css restates each one Quasar sets.
import { IconSet } from "quasar";
import iconSet from "./iconSet.js";

export function installQuasarTheme() {
  IconSet.set(iconSet);
}

// Quasar's options for an app Quasar's CLI doesn't start — a unit test that mounts a kit control
// with createApp: app.use(Quasar, QUASAR_TEST_OPTIONS). The same settings every app's
// quasar.config.js gives its `framework` (ripple off — the guard checks it) plus the icon set.
export const QUASAR_TEST_OPTIONS = { config: { ripple: false }, iconSet };
