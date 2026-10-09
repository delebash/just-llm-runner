// SPDX-License-Identifier: MIT
// The family's Quasar theme, part 2: a PostCSS step every family app runs (its postcss.config.js).
//
// Quasar's stylesheet (quasar/src/css/core/visibility.sass) ends every disabled control's own
// look with two global rules no Sass variable reaches:
//   .disabled, [disabled], .disabled *, [disabled] * { outline: 0 !important; cursor: not-allowed !important }
//   .disabled, [disabled] { opacity: .6 !important }
// The !important outranks the apps' and the kit's own disabled styles (JustWrite's title-bar
// arrows at .32 and a plain cursor, JustVoice's Delete buttons…), so with Quasar loaded every
// disabled control looked Quasar's way — measured on both apps, 2026-10-08. The user's decision
// (the kit's TASKS, the Quasar item, 2026-10-08: "your rec all go" on "(b) A small build step of
// our own that removes that one rule"): this step removes exactly those rules, and only from
// Quasar's own stylesheet, so each control keeps its own disabled look. Quasar components the kit
// adopts get their disabled look from the kit's override sheet.
//
// An app's postcss.config.js (Node loads it, so the path is the sibling checkout's, as the kit
// UI alias is):
//   import { dropQuasarDisabledRule } from '../just-llm-runner/ui/src/quasar/postcss.js'
//   export default { plugins: [ dropQuasarDisabledRule(), autoprefixer(…) ] }

const DISABLED_SELECTORS = new Set([".disabled", "[disabled]", ".disabled *", "[disabled] *"]);
const QUASAR_STYLESHEET = /[\\/]node_modules[\\/]quasar[\\/]/;

export function dropQuasarDisabledRule() {
  return {
    postcssPlugin: "family-drop-quasar-disabled-rule",
    Once(root) {
      if (!QUASAR_STYLESHEET.test(root.source?.input?.file || "")) return;
      root.walkRules((rule) => {
        const selectors = rule.selectors || [];
        if (selectors.length && selectors.every((s) => DISABLED_SELECTORS.has(s.trim()))) rule.remove();
      });
    },
  };
}
dropQuasarDisabledRule.postcss = true;
