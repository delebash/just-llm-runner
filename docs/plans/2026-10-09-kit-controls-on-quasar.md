<!-- SPDX-License-Identifier: MIT -->
# The kit's controls on Quasar (plan, 2026-10-09)

The program's step Q3 (`2026-10-08-sync-and-quasar-program.md`). The decision is the kit's TASKS,
"Every family app moves to Quasar…", rec 2 as approved: "Quasar's components replace the kit's
generic controls (inputs, table, buttons, dialogs). The kit keeps only what Quasar doesn't ship
(the AI settings, the task strip, the model catalog, the theme from the test), rebuilt on Quasar.
The rule becomes 'nothing hand-rolled that Quasar or the kit ships'." The strategy, chosen while
building under "your recs" (the program doc): "Q3 rebuilds the kit's `Ui*` controls ON Quasar
components with the same props, so every app's controls convert at once with few view changes".
The go: "keep going using yo9ur recs, think on your recs twice do it unitl the whole conversions is
complete including the move to quasar dont stop", then "go" (the phone plan §4 puts Q3 after Q6).

## 1 · What it is

Every generic control the three apps draw — buttons, text fields, selects, checkboxes, switches,
sliders, tags, segmented choices, tabs, tables, progress bars, dialogs and toasts — becomes a
Quasar component underneath, while the kit keeps the name the apps already use.

- **For the person using the apps, nothing changes.** Every screen looks the same as today — the
  family look, following Settings → Appearance live (dark mode, accent hue, button radius and
  density, label case, fonts) — and every control works the same way: the same keys, the same
  focus, the same values. The measure is today's screens, side by side (§5).
- **For the apps' code, almost nothing changes.** `<UiButton intent="secondary" size="small">`
  still works: `UiButton` is now a thin layer that turns the family's props into a `QBtn`. The
  apps' ~1,500 uses (§4) keep their props, events, slots and the `ui-*` classes their stylesheets
  and tests reach for.
- **What changes underneath:** the controls' behaviour (keyboard, focus, popups, positioning) is
  Quasar's, not ours or Reka UI's; the kit drops Reka UI, vue-sonner, @tanstack/vue-table and
  @floating-ui/dom where nothing else needs them; the phone (Capacitor) gets Quasar's touch
  behaviour for free, which is what slice 5 of the phone plan builds the phone screens on.
- **What it isn't:** no redesign — a control that looks or behaves differently afterwards is a
  bug, not a choice; no app view rewritten onto `q-*` tags (an app may use Quasar directly for a
  shape the kit doesn't have, as the rule allows); the servers are untouched.

## 2 · How a control is built

One file per control, as today, in `ui/src/common/components/`. Each:

1. renders the Quasar component that does the job (§3), with Quasar's Material defaults switched
   off — `no-caps`, `unelevated`, `flat`, `dense`, `borderless` and the like, so the family look
   comes from the theme alone;
2. keeps every prop, event, slot, `defineExpose` and fallthrough target it has today, mapping each
   onto the Quasar prop that does it (the map is in each file's header comment);
3. keeps its `ui-*` classes on the same element roles (the root, the trigger, the popup, the
   rows), next to Quasar's own `q-*` classes, so the apps' CSS hooks and tests still find them;
4. takes its look from the kit's theme (below), never from scoped one-offs.

**Quasar's stylesheet is the lowest layer** (decided in slice 2, under "your recs"): the kit's
PostCSS step `quasarBaseLayer()` puts Quasar's whole stylesheet in the cascade layer `quasar`, so
every rule of the kit and the apps outranks every Quasar rule, the way a page's CSS outranks the
browser's defaults — whatever its specificity, whatever order the build loads the files in. The
family's existing rules (`.ui-btn*` …) keep their look and their priorities among themselves;
the theme only resets what Quasar sets that they don't. **How a theme rule is written** (settled in
slice 3): a control's own look keeps the exact selector it had in `common/styles.css` (`.ui-tag`,
`.ui-chip.is-selected`…), so the apps' rules that styled a control keep beating it as before;
a rule that only resets something Quasar sets, or styles one of Quasar's inner elements, is
wrapped in `:where(…)` — zero specificity, never competing with an app's rule, and still above
Quasar, which sits in its layer. One exception: an `!important` inside a
layer outranks an unlayered one, so the kit keeps away from Quasar's `!important` rules (the
global disabled rule is removed by `dropQuasarDisabledRule()`; `UiButton` sets the native
`disabled` instead of QBtn's `disable`, whose class carries one).

**The theme** moves out of JustWrite's theming test (branch `ui-library-test`, 359964a) into
`ui/src/quasar/`:

- `variables.scss` — already there (Quasar's Sass variables → the kit's live CSS variables);
- `theme.css` — the override sheet, re-keyed from the test's `.jw-*` classes to the kit's `.ui-*`
  classes: Quasar's uppercase labels, focus overlays, dense heights, table row heights and dialog
  scrim switched off, and today's sizes restated where Quasar sets its own. It replaces the
  matching `.ui-*` rules in `common/styles.css` control by control, so each control has one
  stylesheet;
- `iconSet.js` — Quasar's own icons (select arrow, chip remove, table sort, pager) drawn with the
  kit's line icons, read from `common/iconPaths.js` (the paths `Icon.vue` draws — one copy);
- `installQuasarTheme()` — called by `installLlmUi`: sets the icon set.

**Dark mode needs no bridge** (a change from the test, which bridged `<html data-theme>` to
Quasar's `Dark` plugin): every colour the kit's controls show comes from the tokens, which switch
with `data-theme`, and `theme.css` restates each colour Quasar's light mode sets on an element the
kit uses — so Quasar's `Dark` plugin stays off and its `body--dark` rules (which would override the
apps' own page background) never apply. Each slice's checks include dark mode.

Each app's `quasar.config.js` turns the ripple off (`framework.config.ripple: false`) and adds
`quasar` to the kit's dedupe list (one Quasar, from the app's `node_modules`, for the aliased kit),
and so does its `vitest.config.js`; the family guard checks both. Unit tests that mount a kit
control install Quasar with the kit's `QUASAR_TEST_OPTIONS`.

## 3 · The map

| Kit control | Quasar | Notes |
|---|---|---|
| `UiButton` | `QBtn` | `intent`/`size` → classes; `as="a"` → `href`/`type="a"`; `as="label"` (file pickers) → a `QBtn` that clicks the file input in its slot; `loading` → Quasar's spinner in the kit's look |
| `UiTag` | `QBadge` | `removable` → the ✕ kept as today |
| `UiChip` | `QChip` | `selected`, `clickable` |
| `UiInput`, `UiSecretInput`, `UiTextarea`, `UiNumber` | `QInput` | `width` → the `ui-w-*` caps; `invalid` → `error`; the number parsing and stepping of `UiNumber` stays the kit's; `expose`d `focus()`/`select()`/`el` kept |
| `UiField` | `QField`'s label layout or kept as plain layout | it draws no control |
| `UiCheckbox` | `QCheckbox` | the 16 px box of today |
| `UiToggle` | `QToggle` | 38 × 22 track |
| `UiSlider` | `QSlider` | the number box and the measured mark labels stay the kit's |
| `UiSegmented` | `QBtnToggle` | `blocked` for disabled options, roving focus, type-ahead |
| `UiTabStrip` | `QTabs` + `QTab` | |
| `UiSelect`, `UiMultiSelect` | `QSelect` | `emit-value` + `map-options`; multi with chips and the filter box (`use-input`) |
| `UiColorPicker` | `QMenu` (the popover) | the preset swatches and the browser's own colour dialog kept — built without `QColor`, which would replace both (slice 6) |
| `UiProgress` | `QLinearProgress` | indeterminate when `max` ≤ 0 |
| `UiTable` | `QTable` | column slots, `head-*` slots, `empty`, `full-row`, `rowClass` (`table-row-class-fn`), global filter (`filter-method`), sorting (`update:sort`), the pager |
| `AppModal`, `AppDialog`, `HelpDrawer` | `QDialog` + `QCard` | `closable`/`dismissable` → `no-esc-dismiss`/`no-backdrop-dismiss`; the drag-by-header stays the kit's; `confirmDialog`/`promptDialog` keep their promises; the help drawer (a Reka dialog too) moves with them (slice 7) |
| `Toast` + `pushToast` | Quasar's `Notify` plugin | `pushToast`'s signature kept; the `Toast` host goes (Notify mounts its own) |
| `LuFeatureChip`'s popover | `QMenu` | it opens inside modals, where Quasar's focus trap would close a Reka popover (slice 7) |
| the remaining Reka menus — `LuModelCatalog`'s row menu, JustVoice's row menus (`SpeechEnginesTab`, `StudioScript`, `PersonasView`, `VoicesView`, two mocks), JustWrite's `StatusSelect` | a new kit `UiMenu` (+ `UiMenuItem`, `UiMenuSeparator`) on `QMenu`; `QSelect` | found in slice 7: the map named the kit's `Ui*` controls only (slice 7b) |

The kit's family pieces built from these controls (the AI settings, the task strip, the model
catalog, the Sync panel, …) convert by themselves, because they use the controls.

## 4 · Blast radius

Taken 2026-10-09 by two read-only surveys (every control file read in full; every selector,
query, test and script that reaches a control's insides, in the kit, the three apps, their e2e
and scripts) plus a grep of the uses. Counts are `<Name` in `.vue` files, JustVoice's `src/mock/`
left out.

**The uses** — every one keeps working unchanged if the control keeps its props, events, slots
and exposes:

| Control | kit | JustWrite | JustVoice | docgen |
|---|---|---|---|---|
| `UiButton` | 185 | 354 | 294 | 28 |
| `UiInput` | 69 | 40 | 56 | 7 |
| `UiSecretInput` · `UiTextarea` · `UiNumber` | 1 · 10 · 1 | 0 · 24 · 8 | 0 · 14 · 4 | 0 · 2 · 0 |
| `UiSelect` · `UiMultiSelect` | 27 · 0 | 17 · 0 | 69 · 1 | 3 · 1 |
| `UiCheckbox` · `UiToggle` | 11 · 3 | 27 · 2 | 26 · 11 | 5 · 2 |
| `UiSlider` · `UiColorPicker` · `UiField` | 2 · 0 · 0 | 0 · 3 · 0 | 15 · 0 · 81 | 0 · 0 · 0 |
| `UiTag` · `UiChip` | 10 · 0 | 18 · 0 | 87 · 23 | 10 · 0 |
| `UiSegmented` · `UiTabStrip` | 2 · 2 | 22 · 0 | 3 · 0 | 0 · 0 |
| `UiTable` · `UiProgress` | 4 · 4 | 4 · 0 | 21 · 1 | 2 · 2 |
| `AppModal` · `AppDialog` · `Toast` | 11 · 2 · 1 | 28 · 0 · 0 | 17 · 0 · 0 | 0 · 0 · 0 |

Services on them: `pushToast` (10 kit files), `confirmDialog` (13), `promptDialog` (1); the hosts
are `<LlmUiHosts />` (Toast + AppDialog), mounted once per app.

**What reaches inside a control** — kept working by keeping each control's `ui-*` classes on the
same element roles, and checked per slice:

- `UiButton` — JustWrite's `Sidebar.vue:1192-1196` (`.ui-btn.<own class>`), `ChaptersView.vue:1841`
  (`.ui-btn.is-active`), `VersionHistoryModal.vue:296` (scoped `button`); the kit's
  `AiTaskStrip.vue:270-271` (`.ui-btn--ghost`); tests that find a `<button>` by its text (JustWrite
  8 unit tests, JustVoice 3 unit tests and 2 scripts, docgen's e2e 18 lines) — `QBtn` renders a
  `<button>` with the label as text, so they hold.
- `UiInput` · `UiTextarea` — the root is the native `<input>`/`<textarea>` today and JustWrite's
  `.nav-filter input` (styles.css:545), JustVoice's `.ui-input:not(.ui-textarea):not([class*="ui-w-"])`
  (styles.css:802), `EffectsChainEditorModal.vue:399`, `VoicesView.vue:916`, the kit's
  `FeatureLab.vue:401`, `SceneNotesPanel.vue:327`, docgen's `ReviewView.vue:97,100` and its e2e
  (`input[placeholder*="en.json"]`) reach it. A `QInput` wraps the native element in its field, so
  `ui-input` moves to the wrapper and these rules are re-pointed in the same slice (the list is
  the slice's to-do).
- `UiSecretInput` — JustWrite's `ProviderForm.keyReveal.test.js:84,101` (`.ui-secret input`,
  `.ui-secret__toggle`).
- `UiSelect` — `[role=combobox]` (docgen's e2e :144), `.ui-select-trigger` (the kit's
  `LuRunnerEngine.vue:470`; JustWrite's probes), `.ui-select-content` (the kit's
  `usePanelDismiss.js:32`, JustVoice's `StudioScriptChapter.vue:485`, JustWrite's
  `chipPopoverStacking.test.js` and `panelDismissAndNoDim.test.js`).
- `UiMultiSelect` — docgen's e2e :476-481 (`.ui-mselect-trigger`, `.ui-mselect-item`).
- `UiCheckbox` — today's root is a `<label>`: JustWrite's scoped `label` rules in
  `RelationsView.vue:690` and `SettingsView.vue:1789` and JustVoice's `TtsProviderForm.vue:315`
  style it by accident; JustVoice's global `input[type="checkbox"]` (styles.css:117,975) reaches
  the hidden input. Each is checked in the slice's side-by-side.
- `UiSlider` — JustVoice's global `input[type="range"]` rules (styles.css:73-111,974) and
  `.jv-knob-grid__row > .ui-slider` (:1239).
- `UiField` — JustVoice's `.jv-field-row > .ui-field` (styles.css:880) and
  `PersonaEditorView.vue:1357` (`.ui-field__hint`).
- `UiTag` — JustVoice's own intent `.ui-tag--violet` (styles.css:910); the kit's
  `LuModelCatalog.vue:1674`.
- `UiChip` — JustVoice's `LinesView.vue:307`, `VoicesView.vue:893,902`.
- `UiSegmented` — JustWrite's `ChaptersView.vue:1512,1517` (`.seg-toggle :deep(button.active)`) and
  `providerScope.test.js:89-90,193-195` (`button` + `.active`).
- `UiTabStrip` — docgen's e2e :370 (`.ui-tabstrip__tab`).
- `UiTable` — the most reached-into: the kit's `AiModelsArea.vue:1051-1056` and
  `LuModelCatalog.vue:1620-1759` (`.ui-table`, `thead th`, `tbody td`, `.ui-table-th-inner`,
  full-width rows' `td`); JustVoice's `.jv-table-look .ui-table …` (styles.css:1061-1139, on 21
  views) and `:deep(.ui-table-row…)` / `:deep(.ui-table-fullrow…)` in `LexiconsView`, `LinesView`,
  `ImportReviewView`, `VoicesView`, `StudioOverview`, `StudioRenderChapter` (also JS
  `tr.jv-row--flag`), `StudioScriptChapter`, `StudioCast`, `StudioRender`; JustWrite's
  `EntityIndex.test.js:67` (`tbody tr`). `QTable` renders a real `<table>` with `thead`/`tbody`/`tr`/`td`,
  so the `ui-table`, `ui-table-row`, `ui-table-fullrow` and `is-sortable`/`is-sorted` classes are
  put on the same elements.
- `UiProgress` — docgen's `.progresscell .ui-progress` (styles.css:105).
- `AppModal` — `[role=dialog]` (the kit's `usePanelDismiss.js:32`; docgen's e2e, 19 lines) —
  `QDialog` renders `role="dialog"`; `.ui-modal` (JustVoice's `StudioScriptChapter.vue:496`),
  `.ui-modal-overlay` (JustVoice's `scripts/smoke.js:75,79`, `smoke_gui.js:57`), `.ui-modal__close`
  (docgen's e2e :213,269); JustWrite's `modalDragAndScrim.test.js` (drag, the scrim, the header —
  19 checks, some on AppModal's source text) and `chipPopoverStacking.test.js` (z-index rule
  text) — rewritten in slice 7 to test the same behaviour on the new file.
- `Toast` — JustWrite's toast look (`styles.css:1351-1393`, `.ui-toaster` and
  `[data-sonner-toast]`), JustVoice's `.ui-toaster` (styles.css:1799), the kit's `AiStatusPanel.vue:60`
  (outside-click exemption), JustVoice's `scripts/verify-no-fakes.js:34`. With Notify these move to
  the kit's theme and the sonner selectors are deleted.

**Not reached from outside at all:** `UiColorPicker`, `UiNumber` (only through `.ui-input`),
`UiToggle`, `AppDialog`.

**Found along the way, not changed by Q3** (each is its own item if it matters): `UiField`'s label
never gets its `for` (`UiField.vue:20` reads `$attrs.for`, but `for` is a declared prop); the kit's
`KnobGrid.vue:328,362` `:deep(input)` and JustWrite's `NotesView.vue:377` `:deep(button)` reach
nothing (the class sits on the input itself, or on a select whose root renders no element);
JustVoice's `QuickSetup.vue:495` scoped `input` can't reach the checkbox's input; JustVoice's
`scripts/verify-dialogs.js` and `scripts/e2e.js:66,87,106` select classes no template has; the
kit's `AppearancePanel.vue:98` accent-hue slider is a hand-rolled native `<input type="range">`,
not `UiSlider` (JustVoice's global `input[type="range"]` rules now reach only it); JustWrite's toast
colours (dark ink, per-kind intents in `styles.css`) never reached a toast — vue-sonner re-declared
its own palette on its list below JustWrite's `.ui-toaster` — so its toasts showed sonner's light
look; slice 7 kept that look and dropped the colour block (the kit's `--ui-toast-*` properties
would recolour them). JustVoice's `.app-modal-*` rules (styles.css, "Modal shell (Reka Dialog)") style
classes no template has.

## 5 · Slices and how each is checked

The order goes from the simplest control to the one with the most behaviour, so the theme and the
wrapper pattern are proven on small pieces first.

0. **The theme** — `theme.css`, `iconSet.js`, `installQuasarTheme()`, ripple off, the guard. No
   control uses Quasar yet, so every screen must stay identical.
1. **Tags and chips** — `UiTag`, `UiChip`.
2. **Buttons** — `UiButton` (the ~860 uses).
3. **Checkbox and switch** — `UiCheckbox`, `UiToggle`.
4. **Text fields** — `UiInput`, `UiSecretInput`, `UiTextarea`, `UiNumber`, `UiField`.
5. **Selects** — `UiSelect`, `UiMultiSelect`.
6. **The rest of the small controls** — `UiSegmented`, `UiTabStrip`, `UiSlider`, `UiProgress`,
   `UiColorPicker`.
7. **Dialogs and toasts** — `AppModal`, `AppDialog`, `Toast`/`pushToast` (and the help drawer and
   the feature chip's popover, which live inside dialogs).
   7b. **The remaining Reka menus** — `LuModelCatalog`'s row menu, JustVoice's four row menus,
   JustWrite's `StatusSelect` (found in slice 7).
8. **The table** — `UiTable`.
9. **Clean-up** — drop the packages nothing uses any more; the rule in `docs/app-structure.md`
   ("nothing hand-rolled that Quasar or the kit ships"); the apps' CLAUDE.md control tables and
   JustVoice's `design-law.md`; RESEARCH.

**Every slice is checked the same way, on all three apps:**

- the kit's lint and the apps' lint, unit tests and `build:spa`;
- **side by side with today** — each app's ten main screens at 1440 × 900 against the build taken
  before Q3 (`q3-base`, on the same data snapshot): the share of pixels that differ, and every
  difference looked at and either fixed or listed;
- **the slice's controls in their states** — hover, focus, checked, open, disabled, invalid, light
  and dark, Appearance knobs (accent, radius, density, label case) — screenshot pairs against
  today's build;
- **their behaviour** — keyboard (Tab, arrows, Enter/Space, Esc), v-model values, events;
- after slices 2, 5, 7 and 8: the end-to-end suites — JustWrite's e2e, docgen's e2e on the real
  project, JustVoice's smoke.

Nothing is committed until its slice's checks pass; each slice is its own commit in the kit (and in
an app only where an app's file had to change).

## 6 · Built

The tools (scratchpad `q3/`, copied here when Q3 closes): `parity.js` (the ten screens per app,
both builds, fresh data snapshots), `states.js` + one scenario per slice (states driven the same
way on both builds: hover, keyboard focus, dark mode, another accent, clicks), `crop.js`.

**Slice 0 — the theme.** Kit ef45921; JustWrite b9710e7, JustVoice 17d5172, docgen 1c45f24. All
30 screens identical to the build before it (live values only).

**Slice 1 — `UiTag` on `QBadge`, `UiChip` on `QChip`.** What the side-by-side taught:

- **No theme rule may win by order.** In a built app the kit's CSS chunk can load before Quasar's
  (JustVoice: the kit's `api-*.css`, then `index-*.css` with Quasar and the app's own sheets), so
  every theme rule outranks Quasar's by specificity — two classes (`.q-badge.ui-tag`), or `html`
  in front of a rule for every Quasar component. That also outranks an app's one-class additions,
  so a tag's intent sets variables (`--ui-tag-bg`, `--ui-tag-ink`, `--ui-tag-border`) and
  JustVoice's own `.ui-tag--violet` now sets them too.
- **Today's look is what's on screen, not what the old rule said.** The chip's rest colour was
  `ink-2` in `common/styles.css`, but the chips were native buttons and the kit's
  `button:not(.ui-btn) { color: inherit }` outranked it, so they showed their surroundings'
  colour; the theme keeps that (and `ink-2` for the link/plain chips that never were buttons).
  A button also had the browser's `letter-spacing`/`text-transform` resets; a tag (a span)
  inherited its surroundings' letter-spacing.
- **A positioned chip loses sub-pixel text on a page with an animation.** QChip is
  `position: relative`; on JustVoice's Captures (animated recording bars) Chrome composited the
  chips ("Overlap") and drew their text grey-smoothed. The chip is unpositioned in the theme, as
  the button was.

Checked: lint; the apps' unit tests (594, 183, 3); the 30 screens (JustVoice Captures 0.037 %:
the chips' text, the same glyphs at the same box positions, rasterised differently inside a
`<div>` than inside a `<button>` — invisible at 4×; everything else live values); 13 states
(chips at rest, hover, keyboard focus, dark, another accent; tags in JustVoice's voice table and
JustWrite's chapter list, light and dark, another accent) — 0 pixels differ in each.

**Slice 2 — `UiButton` on `QBtn`, Quasar's stylesheet in a layer, Quasar in the unit tests.**

- **The layer** (§2): with slice 1's two-class rules, a kit rule tied an app's own two-class rules
  and load order decided; `quasarBaseLayer()` ends that for every slice. The 30 screens stayed as
  they were with it (live values only).
- **The button** keeps `.ui-btn*` from `common/styles.css` as its look; the theme resets QBtn's
  column direction, minimum height, middle alignment, position, shadow pseudo-element and
  content z-index (positioned or z-indexed, a button is composited after an animation and
  loses sub-pixel text — slice 1's finding). Kept from the native element: the native
  `disabled` (QBtn's `disable` class has `opacity: .7 !important`), the label beside a loading
  spinner, and the file pickers — `as="label"` was a `<label>`; QBtn renders only `<button>`
  or `<a>`, so a press opens the hidden file input.
- **Unit tests mount with Quasar**: `createTestApp()` (`@delebash/llm-ui/quasar/install.js`)
  replaces Vue's `createApp` in the 17 tests that mount (JustWrite 12, JustVoice 4, docgen 1).
  Under jsdom a test needs Quasar's browser build; a bare `quasar` resolves to its SSR build in
  Node, which refuses to install outside an SSR app, while the browser build reads `window` as
  it loads — so each app's `vitest.config.js` resolves `quasar` per Vite environment (the
  browser build for the client environment, i.e. jsdom; the SSR build for the rest).
- **Found along the way:** JustWrite's e2e docs (written in Q4) said `npm run build:unpacked`;
  the unpacked app has no server package installed and its shell finds no server — the harness
  needs `npm run build` (corrected in JustWrite's README, CLAUDE.md, `e2e/README.md`, the
  driver and `capture-direct.js`). docgen's suite brings its own server, so `build:unpacked`
  is right there.

Checked: lint; the guard; the apps' unit tests (594, 183, 3); the 30 screens against the build
before Q3 (live values only); 18 button states (primary, secondary, ghost, icon-size and disabled
buttons at rest, hover, keyboard focus, dark, another accent; JustVoice and JustWrite) — 0 pixels
differ in each; behaviour on both builds — Enter and Space press, the tab order, a disabled
button stays disabled and unfocusable, the download links are `<a href download>`, the cover
picker opens a file chooser; JustVoice's smoke (every view, zero JS errors), JustWrite's e2e 7/7
and docgen's e2e 20/20 on the real project.

**Slice 3 — `UiCheckbox` on `QCheckbox`, `UiToggle` on `QToggle`.** What the side-by-side taught:

- **The theme's selectors** (§2, "How a theme rule is written"): slices 1–2 used two-class rules to
  beat Quasar; with Quasar in its layer that tied the apps' own two-class rules (JustVoice's
  scoped style on its disabled Auto-paste checkbox lost to it — its text went a shade darker).
  The sheet was rewritten: the kit's own look at its old selectors, resets in `:where()`.
- **QCheckbox and QToggle end with an empty, focusable refocus `<span>`**: in the flow it took
  the row's gap and widened every label-less control (8px on JustVoice's Personas table, so the
  whole table moved); it is taken out of the flow.
- **Quasar's utility class names meet the apps' own**: QToggle's root carries Quasar's `row`,
  and docgen's global `.row` (a flex row with a 10px gap) now outranks Quasar's inside every
  Quasar component — docgen's rule is `:where(:not([class*="q-"])).row` now (one class, as
  before, never on Quasar's own elements). The other apps have no global rule named like a
  Quasar utility (checked).
- **Layered `!important` utilities**: `cursor-pointer` stays on a disabled QCheckbox/QToggle
  and `no-outline` on their roots — nothing outside the layer outranks them. The disabled
  cursor is restored inside the layer (`.disabled.cursor-pointer`, `dropQuasarDisabledRule()`,
  which also drops the `!important` from Quasar's component-level disabled looks — QBtn,
  QCheckbox, QRadio, QToggle, QField); the switch's focus ring goes round its track (the inner
  element), as it went round the native button.
- **A label must still reach the control**: a `<label>` round a switch or checkbox and its text
  (the kit's warm-on-startup and Sync rows, docgen's Server settings, JustWrite's Relations legend)
  passes a click to its first labelable descendant — the native button or checkbox before; now
  the hidden native checkbox QToggle and QCheckbox render when given a `name` (the wrappers always
  give one), whose click bubbles to Quasar's root and flips the control.
- **The kit's own tick and an empty SVG**: QCheckbox's checked icon is the kit's tick path; the
  unchecked one must still be an SVG path (`M0 0`) — a name that doesn't start with a path command
  is read as a font ligature, rendered as text, and moved the box's baseline (the Personas
  header row lost 1.2px).
- **Kept as it was, found along the way:** docgen's Server settings passes `label="Require a
  token even on localhost"` to UiToggle, which has no `label`; it was an unshown attribute on the
  native button, so the switch never showed its text — QToggle would print it, so UiToggle keeps
  a caller's `label` off the switch (recorded in docgen's TASKS).

Checked: lint; the apps' unit tests (594, 183, 3); the 30 screens (JustWrite's Export 0.122 %: the
checkbox row's background, 1/255 in one channel; the rest live values); 16 states — checkbox at
rest, checked, hover, keyboard focus, disabled, dark, another accent, with a label; switch off,
hover, keyboard focus, dark, on three apps — 0 pixels differ (docgen's two shots differ only in
the test server's port); behaviour on both builds (13 checks the same): click, Space, Enter
(the checkbox ignores it, the switch flips), select-all, a disabled checkbox stays, role and
aria-checked, a click on the label's text and on the control inside a label.

**Slice 4 — `UiInput`, `UiTextarea`, `UiNumber` on `QInput`** (`UiSecretInput` is built on
`UiInput` and follows; `UiField` draws no control and stays a plain layout, as §3 allows).

- **QInput's root is the box.** It carries `.ui-input`, the width cap and the caller's classes,
  scoped styles and inline style — what used to land on the native `<input>` when it was the
  root — so a caller's box rule (border, background, padding, width, flex, margin) still applies.
  Quasar's three wrappers inside are `display: contents`, and the native element takes the box's
  font, colour, alignment and spacing. The box starts from what the browser gives a native input
  (letter-spacing, word-spacing, text-transform, text-indent, text-shadow, text-align) — the page's
  letter-spacing reached JustWrite's sidebar filters and narrowed their text.
- **Height**: a single-line field passes the box's height down to the native input
  (`height: inherit` through the wrappers): Chrome centres an input's text 1px higher when its
  height comes from a flex layout than from a height value (JustWrite's 22px sidebar filters).
  A textarea keeps the padding on the native element, so its resize grip sits in the box's corner,
  and its auto-resize gives the native textarea the old height less the box's border.
- **Events are the native element's own** (`common/composables/useNativeEvents.js`): QInput
  replaces a caller's `input`, `change`, `paste`, `blur` and `focus` with its own (its `change`
  carries a string), so the fields pass Quasar no listeners and listen on the native element;
  a caller's `:value` with its own `@input` (JustWrite's entity search, Worldbuilding, JustVoice's
  MCP URL) still sets the shown value.
- **`$attrs` isn't reactive**: a `computed` over it keeps the first value — UiChip's and
  UiToggle's attribute pass-through (slices 1, 3) are read at render now, as the fields' are.
- **Rules that reached the native element** were re-pointed to the box: JustWrite's
  `.nav-filter input`, JustVoice's `.effects-modal__saveas > input` and
  `.voices-view__bench-field :deep(textarea)`, the kit's `.lu-fw-genprompt textarea`.

Checked: lint; the apps' unit tests (594, 183, 3); the 30 screens (live values; JustWrite's Export
keeps slice 3's 1/255); the states of slices 1, 3 and 4 (fields at rest, hover, keyboard focus,
typed, dark, another accent, the sidebar filters' focus ring, textareas) — 0 pixels differ but the
test servers' ports.

**Slice 5 — `UiSelect` and `UiMultiSelect` on `QSelect`** (Reka UI no longer under either).

- **The control is the box.** QSelect mounts its list's menu inside its `.q-field__control`, and the
  menu lines up with, and is at least as wide as, that element — with the control box-less
  (`display: contents`, as the text fields' wrappers) it measured 0 × 0 and the list opened off
  screen. So the root holds the width and the text, the control is the trigger's box, and the
  menu sits where Reka's did. (A caller's class on a select used to land nowhere — Reka's root
  renders no element — so no app styles the box by class.)
- **The items are the kit's markup** in QSelect's option slot, with state classes where Reka set
  data attributes; values keep their type (QSelect compares deeply), so the string round-trip and
  the empty-string sentinel are gone. QSelect's focus target is a hidden read-only `<input>` with the
  combobox role and the select's id, so a `<label for>` still reaches it; `title` is put on the box.
- **The multi-select keeps its filter at the top of the list** (QSelect's own filter types into
  the trigger): a sticky bar in the menu's `before-options`, arrows and Enter driving QSelect from
  it. QSelect drops `before-options` when the list is empty, so "No matches" is a disabled row —
  the filter stays and keeps its focus. QSelect opens a multiple select scrolled to the first
  chosen option, and its virtual scroll re-anchors once after the first scroll; the list is held
  at the top for its first 400ms, as the old one opened. QSelect's root is a `<label>`: a chip's ✕
  (a span) cancels the label's default, or it would also open the list.
- **Left as it is:** Quasar's menu is placed at fractional pixels where Floating UI rounded (0.2–
  0.3px, anti-aliasing only); typing on a closed select opens the list at the match (QSelect)
  where a native-style select chose it outright.

Checked: lint; the apps' unit tests (594, 183, 3); the 30 screens (live values); 17 states —
selects closed, hovered, keyboard-focused, open, an item hovered, dark, another accent; the
multi-select closed, open, filtered, with no match, dark — the same but for the sub-pixel menu
placement; 16 behaviour checks the same on both builds (click, keyboard open/move/choose,
Escape, outside click, focus after a pick, filter focus and typing, Enter and click ticks, chip
removal, clear all, close by the trigger); JustVoice's smoke, JustWrite's e2e 7/7, docgen's e2e
20/20 on the real project (its Setup create-flow drives the multi-select).

**Slice 6 — `UiSegmented` on `QBtnToggle`, `UiTabStrip` on `QTabs` + `QTab`, `UiSlider` on `QSlider`,
`UiProgress` on `QLinearProgress`, `UiColorPicker`'s popover on `QMenu`** (Floating UI no longer
under the colour picker).

- **Segmented:** QBtnToggle's QBtns are native `<button>`s with the `active` / `is-off` classes, so
  JustWrite's `.seg-toggle :deep(button…)` and its provider-scope test still reach them. Each
  button's content row passes through (`display: contents`), so labels and `#option` content sit
  in the button as before. The kit keeps the radio roles, the roving tabindex, type-ahead and the
  clickable off option (`blocked`); QBtnToggle's value is the option's index, and a click on the
  chosen option reaches its `clear` and is picked again, as before. QBtnToggle's group is
  `position: relative` — it painted over a later card on JustVoice's persona page — so it's static.
- **Tab strip:** QTab is a focusable `<div>` with `role="tab"`, so the strip gets Quasar's tab
  keyboard (one tab stop; arrows, Home and End move; Enter or Space open) and the kit buttons'
  focus ring — a native button had the browser's ring (JustVoice, docgen) or none (JustWrite removes
  it). QTabs scrolls a strip too narrow for its tabs sideways behind arrows; JustVoice's Settings
  has two rows of tabs at 1440px and the last three disappeared behind an arrow, so the strip still
  wraps. Quasar's sliding indicator isn't used: the underline is the tab's border, as before.
- **Slider:** drawn as Chrome drew the native range, measured (RESEARCH): the 8px pill track with
  its 1px edge, the 16px thumb travelling 8px inside each end, the light and dark palettes and their
  hover and pressed colours, the thumb's own hover. QSlider maps a click against its own box, so
  the box is the thumb's travel (UiSlider's widths less 16px, with 8px margins) and the track
  container reaches the 8px back out — clicks, drags and keys land on the same values as the native
  range's. The number box, readout and measured marks are the kit's, unchanged.
- **Progress:** QLinearProgress is the track and its bar the fill (scaled, its round end narrowing
  with the value); an unknown total is the kit's single sweep, as before. The ARIA values stay
  percentages.
- **Colour picker:** QMenu places the popover under the swatch (Quasar now uses CSS anchor
  positioning — 0.03–0.17px from where Floating UI rounded it), opens and closes on the swatch,
  closes on Esc or an outside click, and takes focus while open, so Tab reaches the presets (they
  were unreachable by keyboard — the popover sat at the end of the page) and the swatch gets focus
  back on close.
- **User docs:** the tab-row, choice, slider and colour keys are in JustWrite's and JustVoice's
  `docs/keyboard-shortcuts.md`; docgen has no page for them.

Checked: lint; the apps' unit tests (594, 183, 3); the 30 screens (live values, 1/255 corner
rounding; JustWrite's Export keeps slice 3's 1/255); 39 states — tab strips (one row, two rows,
hovered, keyboard-focused, dark), segmented rows (default, connected, small, with icon slots;
hovered, focused, dark, another accent), sliders (rest, hovered, focused, dark, another accent; the
Generation section; a persona knob), the progress bar (rest, dark, and its sweep paused at four
moments), the colour picker (closed, hovered, open, a preset hovered, dark) — the same but for the
sliders' sub-pixel rasterisation (Chrome pixel-snaps a native input, not a div; ≤ 1px bands), the
popover's sub-pixel placement and the tab's focus ring; 38 behaviour checks the same on both
builds but the tab keyboard and roles and the colour picker's focus, as above.

**Slice 7 — `AppModal` and `AppDialog` on `QDialog` + `QCard`, the help drawer on `QDialog`, the
toasts on `Notify`, the feature chip's popover on `QMenu`** (Reka UI and vue-sonner no longer under
any of them; the `Toast` host is gone).

- **The modal:** QDialog's root is the overlay (`.ui-modal-overlay`, `role="dialog"`,
  `aria-modal`), kept at the old z-index 200 so what opens over a modal still clears it; its backdrop
  blocks the page and takes the outside click and paints nothing. The card is the QCard, placed,
  dragged and animated as before; on close QDialog keeps it for its close animation and `close`
  comes at 0.2s, as before. QDialog's content cap and its `will-change` layer are taken off the card.
  QDialog's focus trap lets Tab leave the page for one press and then lands on the first control
  with a tabindex attribute; the kit's `wrapTab` (`common/composables/useTabWrap.js`) keeps the loop
  the Reka dialogs had. A press on the backdrop keeps the focus where it was.
- **The help drawer** is a QDialog the same way; it closes at once, as before.
- **The feature chip's popover** is a QMenu: inside a modal it opens in the dialog's own layer, so
  the trap lets its fields take focus — under Reka its keyboard use inside a modal closed it, and
  Esc there closed the modal too; now Esc closes the popover only.
- **The toasts:** `pushToast` creates Notify toasts the theme draws as vue-sonner did (its light
  palette with rich colours, the kind icons, the ✕, the action button) — JustVoice's normal and
  warning toasts and JustWrite's restyled ones match to the pixel. The bridge keeps what sonner did
  beyond Notify: the timers pause while a toast is hovered or the window hidden, at most three are up
  (a fourth retires the oldest), `clearToasts` clears them. Every app lists `Notify` in
  `quasar.config.js` (the guard checks it; the template too). Toasts stack in a column; sonner folded
  the older ones behind the newest until hovered.
- **Left as it is:** a modal opens with the focus on itself, not its first control (Reka focused the
  first — in JustWrite's AI modals that also popped the feature chip's tooltip); a toast is
  `role="status"` where sonner made its list `aria-live`.
- **Tests:** JustWrite's `modalDragAndScrim`, `chipPopoverStacking` and `panelDismissAndNoDim` read the
  overlay rules from the kit's theme now and mount through QDialog; the panel-dismiss exemptions
  take `.q-menu` and the toasts' `.q-notification`.

Checked: lint; the guard; the apps' unit tests (590 — four of JustWrite's overlay checks folded into
one — 183, 3); the 30 screens (live values only); 17 states — the Critique modal (open, the ✕
hovered, dark), the help drawer (light, dark), the feature chip's popover in the modal and in the
Ask-the-book panel, the prompt (empty, typed, several fields) and confirm dialogs, the toasts
(JustWrite's plain and with Undo, the ✕ hovered; JustVoice's plain, warning, dark) — the same but
for the opening focus, sub-pixel edges and 1/255 rounding; 32 behaviour checks the same on both
builds but the opening focus, aria-modal, the chip popover's keyboard use and Esc in a modal, and
the toast's role, as above; JustVoice's smoke, docgen's e2e 20/20 on the real project, JustWrite's
e2e 7/7.

**Slice 7b — the remaining Reka menus: a kit `UiMenu` on `QMenu` for the row menus, JustWrite's
`StatusSelect` on `QSelect`** (Reka UI no longer under any of the family's screens).

- **`UiMenu`, `UiMenuItem`, `UiMenuSeparator`** (the kit's, `common/components/`) keep Reka's
  DropdownMenu shape — a trigger, items with `@select` (preventDefault keeps it open), separators
  — and its state attributes (`data-highlighted`, `data-disabled`, the trigger's `data-state`), so
  the hosts' `.ev-menu*` and `.lu-mm*` styles read them unchanged; the seven menus (the kit's model
  catalog, JustVoice's four row menus and two mocks) converted by their own markup. QMenu places,
  closes and gives the focus back; the kit adds the menu keyboard (↓/Enter/Space open on the first
  item, ↑ on the last; arrows, Home/End and typing move; Tab stays) — under Reka the focus stayed on
  the trigger and the keys did little. QMenu toggles on its anchor's click and again on its Enter
  keyup, which closed a menu opened with Enter on a native button, so the trigger toggles itself.
- **Modal like Reka's** (the kit's `useModalPopup`): Reka's DropdownMenu and Select made the page
  take no pointer while open; QMenu doesn't, and a click outside a row's menu also opened the row
  behind. The menus, `UiSelect` and `StatusSelect` hold `pointer-events: none` on `<body>` while
  open (their lists take it back), so the first outside click only closes them and nothing behind
  them hovers. The multi-select was a non-modal Reka popover and stays live.
- **`StatusSelect`** is a QSelect like `UiSelect`: its control the pill, its items the old markup
  with Reka's attributes; QSelect's own letter-spacing and line height on the value are reset.
  Its menu's box now shows — the scoped `.status-menu` rule never reached Reka's teleported list,
  which showed see-through over the page.
- **Left as it is:** the menus open at fractional pixels (QMenu), as the selects already did.

Checked: lint; the apps' unit tests (590, 183, 3); the 30 screens (live values only); 16 states — the
row menu (trigger, hovered, open, open trigger, an item and the danger item hovered, opened from ↓
and from Enter, dark; JustVoice's Voices menu), the status pill (closed, hovered, open) and its list
(open, an item hovered, dark) — the same but for the sub-pixel placement, the keyboard-opened menu
now on its first item, and the status list's box; 21 behaviour checks the same on both builds but the
menu keyboard, as above; slice 5's 16 select checks the same again with the selects modal. The
model catalog's menu (inside the built-in provider's form) wasn't reached by the scripts — it is the
same UiMenu the JustVoice menus checked.

**Slice 8 — `UiTable` on `QTable`** (TanStack Table no longer under it).

- **QTable draws, the kit decides the rows.** QTable's own sort and filter order rows differently
  from TanStack's (RESEARCH: null values first, digits compared as text, every column ascending
  first, every column searched), so the lists would re-order under their users. The filter, the
  sort (TanStack's automatic comparison, first direction, click cycle, ties in data order) and the
  page reset are ported into `common/components/tableRows.js` (MIT, its licence notice kept); QTable
  gets the rows already filtered, sorted and paged, with its own paging off.
- **The same markup inside.** QTable's `header`, `top-row` and `body` slots draw what TanStack's
  table drew — `<table class="ui-table">`, `th.is-sortable`/`.is-sorted` with `.ui-table-th-inner`
  and the sort icon, `tr.ui-table-row` and `tr.ui-table-fullrow`, the empty row — and the pager
  below is the kit's, unchanged; so every rule in §4 that reaches into a table still reaches. QTable
  puts `table-class` on its scrolling wrapper, so the kit adds `ui-table` to the `<table>` itself,
  and takes the wrapper's tabindex off (a Tab stop the table never had).
- **QTable's look is reset** (the theme's "Table"): the card's background, radius, shadow and
  position; the wrapper's scrolling (a `ui-table-sticky` header still pins to the page's scroller);
  the 48px rows, cell padding, positioned cells, hover overlays and separate borders — the kit's
  `.ui-table*` rules draw the table, as before.

Checked: lint; the apps' unit tests (590, 183, 3); the 30 screens (live values only); 20 states —
JustVoice's Personas (header at rest, sorted each way, a header and a row hovered, a row's control
keyboard-focused, dark, dark hovered), Voices (header, sorted), JustWrite's characters index (at
rest, sorted, a row hovered, the pager at rest and a pager button hovered, dark), docgen's dashboard
and runs — 0 pixels differ but the pager tooltip caught mid-fade (identical once shown); the empty
row on three apps, light and dark — 0 pixels; 22 behaviour checks the same on both builds — every
sortable column of Personas, Voices, Effects and JustWrite's characters through three clicks, and
every table on JustVoice's AI page and Settings, docgen's runs (no runs on the snapshot: the header
states only; Lexicons and Studio had no rows), a row click, a row's hover colour,
the search, docgen's filter to its empty row, the pager over 45 rows (next, last, back, first, a
sort going back to page 1), the sticky header on Voices, the Tab stops (the same count; the row
checkboxes are slice 3's focusable `<div>`s); JustVoice's smoke, JustWrite's e2e 7/7, docgen's e2e
20/20 on the real project.
