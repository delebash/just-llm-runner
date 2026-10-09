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
| `UiColorPicker` | `QColor` in a `QMenu` | the preset swatches kept |
| `UiProgress` | `QLinearProgress` | indeterminate when `max` ≤ 0 |
| `UiTable` | `QTable` | column slots, `head-*` slots, `empty`, `full-row`, `rowClass` (`table-row-class-fn`), global filter (`filter-method`), sorting (`update:sort`), the pager |
| `AppModal`, `AppDialog` | `QDialog` + `QCard` | `closable`/`dismissable` → `no-esc-dismiss`/`no-backdrop-dismiss`; the drag-by-header stays the kit's; `confirmDialog`/`promptDialog` keep their promises |
| `Toast` + `pushToast` | Quasar's `Notify` plugin | `pushToast`'s signature kept |

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
`scripts/verify-dialogs.js` and `scripts/e2e.js:66,87,106` select classes no template has.

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
7. **Dialogs and toasts** — `AppModal`, `AppDialog`, `Toast`/`pushToast`.
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
