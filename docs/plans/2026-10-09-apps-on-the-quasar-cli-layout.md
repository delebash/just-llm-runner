<!-- SPDX-License-Identifier: MIT -->
# The apps on the layout Quasar's CLI creates (plan, 2026-10-09)

Decided 2026-10-09 — this repo's `docs/dev/TASKS.md`, "The apps move to the layout Quasar's CLI
creates, on the latest dependencies" (the user: "whatever the layout that the quassar cli crete for
new project is what we use when using quasar"; "just fix it all do it right use the latest quasar
update the deps … go"; "make sure you also update all deps to latest for your template prouject").

## 1 · What it is

Each family app's renderer laid out the way `npm init quasar` lays out a new project, and built the
way Quasar's guides build one:

- **`App.vue` is a bare `<router-view />`.** What the app shows is decided by routes, not by
  branches in the root: the app's pages inside its layout; the connection-error screen and
  JustVoice's dictation window as routes of their own, outside it.
- **`src/layouts/MainLayout.vue` is the app's chrome, on Quasar's layout components** — `q-layout`,
  `q-header` (the family title bar), `q-drawer` (the app's sidebar), `q-page-container`. It replaces
  the hand-made grid shells (`AppShell.vue`). The drawer is what the phone uses below its breakpoint
  (an overlay with a backdrop and an edge swipe), so the phone's screens get Quasar's mobile drawer
  for free instead of a second shell.
- **`src/pages/<Name>Page.vue`, one per route, each rooted in `q-page`.** Quasar's `QPage` renders
  the page's `<main>` landmark, and its documented `style-fn` gives every page exactly the height
  under the header, so each page keeps its own scroller (the family's one-scroller-per-area rule)
  without `100vh`.
- **`src/css/`** holds the app's stylesheets (`tokens.css`, `app.scss` — the old `styles/styles.css`
  — and `quasar.variables.scss`), listed in `quasar.config.js > css` as the CLI's config lists them.
- **`src/components/`** takes the non-page `.vue` files that sat in `views/`; the non-page modules
  (`studioSteps.js`, `settingsSections.js`, …) go beside what uses them, in `services/`.
- **On the latest dependencies** — the template's and the apps', every package to its newest
  release that the family's checks pass on.

**What it isn't:** a redesign. Every desktop screen looks and works as today (checked side by side
against the build before this change); the servers are untouched; the kit's own `ui/src/views/` is
the library's folder, not an app's (the standard exempts the kit from §Q).

## 2 · The target — what the CLI creates (create-quasar 5.0.32, generated 2026-10-09)

`npm init quasar@5.0.32 <dir> -- --template app --preset sass --preset pinia [--preset i18n]`:

```
src/App.vue                 <template><router-view /></template>
src/boot/  (i18n.js with the i18n preset — createI18n + app.use)
src/components/
src/css/app.scss · quasar.variables.scss
src/i18n/index.js · en-US/index.js   (i18n preset)
src/layouts/MainLayout.vue  q-layout > q-header + q-drawer + q-page-container > router-view
src/pages/IndexPage.vue · SecondPage.vue (q-page roots) · ErrorNotFound.vue
src/router/index.js (defineRouter) · routes.js   { path: '/', component: MainLayout, children: […] },
                                                 { path: '/:catchAll(.*)*', component: ErrorNotFound }
src/stores/index.js (defineStore → createPinia) · <name>.js
```

The template (`template/`) is this output already; the family's additions (the server package, the
kit's shell, the CSP, Biome, `allowScripts`) are its README's list.

**Kept from the apps, not in the CLI's output** (Quasar's guides don't forbid them, and the CLI's
`boot/`, `components/` and `stores/` already set the "folder per kind" pattern): `services/`,
`composables/`, `i18n/` message files in the app's own format (JustWrite's `locales/*.json`, which
docgen's translation runs and `i18n:report` read), JustWrite's `phone/`.

## 3 · Each app, mapped

### JustWrite

| Today | Becomes |
|---|---|
| `App.vue` (ConnectionError or AppShell) | `App.vue` = `<router-view />`; `pages/ConnectionErrorPage.vue` at `/offline`, outside the layout; the boot redirects there when the server is down |
| `AppShell.vue` (`.app-stage` grid: 38px title row; sidebar column 280px / user width / 56px collapsed rail; `<main class="main">`; the onboarding shell when no book is open; the boot plate; the overlays) | `layouts/MainLayout.vue`: `q-layout view="hHh Lpr fff"`; `q-header` = `TitleBar`; `q-drawer` = `Sidebar` (`:width` = the user's width, or 56 collapsed; `show-if-above`; phone breakpoint) only while a book is open; `q-page-container` > `router-view`; the onboarding header when no book is open; the boot plate and overlays (chat panel, help drawer, palette, modals) as today |
| `views/<Name>View.vue` ×30 | `pages/<Name>Page.vue`, each rooted in `q-page` with the shared full-height `style-fn` |
| `views/settingsSections.js` (+ its test) | `services/settingsSections.js` |
| `styles/tokens.css` · `styles/styles.css` · `fonts.css` | `css/tokens.css` · `css/app.scss` · `css/fonts.css`, in `quasar.config.js > css` (fonts first, as the boot imported them) |
| `components/OnboardingShell.vue` | stays a component, used by the layout |
| — | no catch-all: JustWrite has none today (the CLI's own comment: "you can also remove it") |

### JustVoice

| Today | Becomes |
|---|---|
| `App.vue` (DictateWindow · ConnectionError · AppShell) | `App.vue` = `<router-view />`; `pages/DictatePage.vue` at `/dictate` and `pages/ConnectionErrorPage.vue` at `/offline`, both outside the layout; the boot redirects |
| `AppShell.vue` (full-height sidebar `.jv-sidebar`, title bar inside `.jv-main`, `<KeepAlive>` around the routed view, the overlays) | `layouts/MainLayout.vue`: `q-layout view="lHh Lpr lFf"` (the drawer full height, the header beside it — the CLI's default view); `q-drawer` = the sidebar; `q-header` = the title bar; `q-page-container` > `router-view` + `KeepAlive` as today |
| `views/<Name>View.vue` ×14 routed | `pages/<Name>Page.vue` (`q-page` roots) |
| `views/AudioChannelsView.vue` · `CacheView.vue` · `WebhooksView.vue` (Settings sections) · `ImportModal.vue` | `components/` (sections renamed `…Section.vue`) |
| `views/studioSteps.js` · `studioStatus.js` · `scriptReview.js` · `studioLexicon.js` · `lexiconUsage.js` · `settingsSections.js` (+ tests) | `services/` |
| `mock/*View.vue` · `mock/*.vue` · mock data · `mock/routes.js` | `pages/mock/` (pages) · `components/mock/` (pieces) · `services/mock/` (data) · `router/mockRoutes.js` (dev only, the `import.meta.env.DEV` branch as today) |
| `styles/tokens.css` · `styles/styles.css` | `css/tokens.css` · `css/app.scss` |

### docgen

| Today | Becomes |
|---|---|
| `App.vue` (ConnectionError or AppShell) | `App.vue` = `<router-view />`; `pages/ConnectionErrorPage.vue` at `/offline` |
| `AppShell.vue` (`.shell`: TitleBar over `.shell__body` = nav + `<main class="shell__main">`; overlays; boot splash) | `layouts/MainLayout.vue`: `q-layout view="hHh Lpr fff"`; `q-header` = TitleBar; `q-drawer` = the nav; `q-page-container` > `router-view` |
| `views/<Name>View.vue` ×7 | `pages/<Name>Page.vue` |
| `views/settingsSections.js` (+ test) | `services/settingsSections.js` |
| `styles/` | `css/` |

### The template

Already the CLI's output; its dependencies go to latest (the user's word), and it gains nothing
else.

## 4 · Dependencies (npm, 2026-10-09)

Quasar is current: `quasar` 2.35.0, `@quasar/app-vite` 3.10.2, `@quasar/extras` 2.1.0,
`create-quasar` 5.0.32, `@quasar/cli` 5.0.9. Electron 44.7.0, electron-builder 26.15.3 and
Capacitor 8.5.3 are current. Behind (every repo and package — `npm outdated` in each):

- **Majors:** `pinia` 3.0.4 → 4.0.3 (ESM only; `@vue/devtools-api` installed beside it — its
  release notes), `vitest` 4 → 5.0.3 (Vite ≥ 6.4, Node ≥ 22.12; `clearMocks` on by default;
  `vi.mock` only at the top level; unawaited async assertions fail; `toHaveTextContent` exact —
  its migration guide), `@vueuse/core` 14 → 15.0.0 (drops `templateRef`, the timer options and
  Node 20; `useThrottleFn` trails by default — its release notes; the family uses only
  `useDraggable`, in `AppModal`), `jsdom` 29 → 30 (JustWrite; JustVoice is on 30).
- **Minors and patches:** `vue` 3.5.43, `vue-router` 5.4.0, `vue-i18n` 11.4.13, `@biomejs/biome`
  2.5.15 (exact pin, as the family pins it), TipTap 3.31.4 (JustWrite's renderer and server),
  `marked` 18.1.0, `@floating-ui/dom` 1.8.0, `playwright` 1.64.0, `@anthropic-ai/sdk` 0.132.1 and
  `openai` 7.31.0 (the kit's server), `@modelcontextprotocol/sdk` 1.32.1 and `@fastify/multipart`
  10.1.3 (JustVoice), `happy-dom`, `docx`, `mammoth`, `jszip`, `esbuild`, `eslint`, `jscpd`,
  `pseudo-localization`.
- The kit's `ui/package.json` peer ranges follow (`pinia` ^4, `vue-router` ^5, `@vueuse/core` ^15).

Done first, per repo, on today's layout, so a failure is the update's and not the port's.

## 5 · Blast radius (greps, 2026-10-09)

Every reference to a moved file, outside the routes files (which are rewritten whole):

```
JustWrite
src/boot/jw.js:11,29,30                  import fonts.css, styles/tokens.css, styles/styles.css
src/App.vue:9,25                         AppShell
src/boot.smoke.test.js:22                imports App.vue (the boot smoke)
src/i18n/characterFieldKeys.test.js:28   reads ../views/CharactersView.vue
src/components/panelDismissAndNoDim.test.js:104   reads styles/styles.css
src/services/search.test.js:114          reads ../AppShell.vue (the ⌘F capture handler)
src/views/settingsCanon.test.js          imports ./settingsSections.js
comments naming AppShell.vue / views/…:  TitleBar.vue:29, OnboardingShell.vue:4, bootState.js:3,
  native.js:90, search.test.js:109-120, project.js:743, ui.js:350, SearchView.vue:78,
  SettingsView.vue:95, WelcomeView.vue:12, useSyncPanel.js:3
docs: CLAUDE.md:72, README.md:293-297, docs/dev/architecture-notes.md:9, ARCHITECTURE.md:122,
  ai-features-roadmap.md:60,84,166 (history — kept), TASKS.md:34-35,116 (records — kept)
quasar.config.js:43                      comment naming src/fonts.css
CSS on the shell's elements (styles.css): .app-stage :67, .titlebar :76-120, .app/.app.collapsed/
  html.sidebar-resizing .app :124-134, .sidebar :136…, .main :586

JustVoice
src/components/StudioDiscover.vue:60 · StudioOverview.vue:43,51,52 · StudioRenderChapter.vue:40 ·
  StudioScriptChapter.vue:46 · mock/MockStudioView.vue:13,14   import ../views/<module>
src/views/SettingsView.vue               imports AudioChannelsView, CacheView, WebhooksView
src/views/LinesView.vue · ProjectsView.vue   import ImportModal
src/views/*.test.js                      import their modules (./studioSteps.js, …)
src/router/routes.js:7                   import mockRoutes from ../mock/routes.js
quasar.config.js:25-29                   css: ['../styles/tokens.css', '../styles/styles.css']
scripts/smoke.js:75,79,88                .ui-modal-overlay, App.vue's .splash
src/App.vue:9,27 · boot/jv.js:5,169,178,217   AppShell / the root's three branches
comments naming AppShell.vue / views/…:  AudioKeepAlive.vue:12, DictateWindow.vue:4,
  EngineTermsDialog.vue:4, KeyboardCheatsheet.vue:15, usePageCrumbs.js:11, mock/routes.js:10,
  router/routes.js:3, bootState.js:2, activeProject.js:7, onboarding.js:6, uiContext.js:6,
  AiView.vue:52, ProjectsView.vue:164, SettingsView.vue:50,465, StudioView.vue:533,
  VoicesView.vue:565, PersonaBlendMaker.vue:14, mock/Mock*.vue:6-8, electron-main.js:45
docs: CLAUDE.md:75-76 (+ the mock rule's src/mock/ paths), README.md:91, docs/dev/code-map.md:949,970,
  docs/dev/RESEARCH.md:778-779,1390,1441, ue-integration-design.md:120, .claude/settings.local.json:6
  (a read permission naming JustWrite's src/views — kept, it's JustWrite's path history)

docgen
e2e/tests/contract.test.js:21,53,59      reads src/AppShell.vue, src/views/SettingsView.vue,
                                          src/views/settingsSections.js
quasar.config.js:24-26                   css: ['../styles/tokens.css', '../styles/styles.css']
src/App.vue:9,25 · boot/docgen.js:3,6,60 · boot.smoke.test.js:20 · bootState.js:2
comments: HomeView.vue:115,135, ReviewView.vue:4,72 (the original app's App.vue — history),
  SettingsView.vue:181
docs: CLAUDE.md:94
```

The kit: `docs/app-structure.md` §Q.1 (the open deviation), §14's renderer lanes (`views/`,
`styles/`, `views/HomeView.vue`); `scripts/check-family.js` (§14 lanes — today advisory only);
`family-rules.md` if it names a folder. JustWrite's e2e and docgen's e2e select by class (`.ui-*`,
the apps' own classes) — the classes stay; the shell classes the scripts read are kept on the new
elements.

## 6 · Checks (every app, before its commit)

- lint; unit tests; `build:spa`; the guard.
- **Side by side** — the ten screens per app (`2026-10-09-kit-controls-on-quasar-tools/parity.js`)
  against the build before the port, on the same data snapshot; every difference fixed or listed.
- **The shell's states, both builds:** sidebar resize (drag), collapse to the rail and back, the
  title bar's controls, the drawer hidden with no book (JustWrite's onboarding), the chat panel, the
  AI-tasks panel, the help drawer, a modal, the boot plate, the connection-error screen (server
  stopped), JustVoice's dictation window (`?view=dictate`), dark mode, the window at 1024 and 1920.
- The end-to-end suites — JustWrite's e2e, docgen's e2e on the real project, JustVoice's smoke.
- The phone: the drawer at 390px in the in-app-server build (the phone plan's slice 5 builds on it).

## 7 · Order

1. Dependencies: the template, the kit (server, ui peers), just-sqlite-sync, JustWrite, JustVoice,
   docgen — each checked, each its own commit.
2. JustWrite ported (the reference), checked, committed.
3. JustVoice, then docgen, the same way.
4. The standard: §Q.1's open deviation closed, §14's lanes rewritten, the guard checks the layout
   (`src/layouts/MainLayout.vue`, `src/pages/`, `src/css/`; no `src/views/`, `src/styles/`,
   `src/AppShell.vue`; `App.vue` a bare `router-view`).
5. Then the phone plan's slice 5 on the layout's drawer.

## 8 · Built

**Dependencies** — kit 4b42ae5 (the template, the kit's server and UI peers, the plan), a2f99cc
(biome.json schemas); just-sqlite-sync 2fd899f; JustWrite bed0fdc; JustVoice 616a209; docgen
04484f3. Found on the way: happy-dom 20.14.6 serialises a style as browsers do and the phone's
linkedom doesn't — JustWrite's phone scene HTML now matches (its RESEARCH); the kit's PostCSS step
parsed without `from` (Vite warned).

**JustWrite** — what the side-by-side taught:

- **The cascade order is declared, not incidental.** The stylesheets moved from the boot file into
  `quasar.config.js > css`, which the entry imports before any module — so the kit's stylesheet,
  which had loaded first (the boot's modules imported the kit before the boot imported styles.css),
  came after JustWrite's and won ties (`button:not(.ui-btn)` over `.titlebar-right button`: the
  title bar's icons darkened). The `css` list names the kit's three stylesheets (`~@delebash/llm-ui/…`)
  before `app.scss`.
- **The layout's root is fixed to the window and clips** (as the grid shell's was; now the kit's
  theme, for every app: `#q-app > .q-layout`): Chrome then paints the whole app, the fixed overlays
  included, in one opaque layer whose text keeps sub-pixel smoothing; with the document as the
  scroller the chat panel, the help drawer and the palette were layers of their own and their text
  turned grey-smoothed (DevTools LayerTree: "OverflowScrolling", "Overlap").
- **A page's height is a percentage, not pixels.** The appearance engine zooms `<html>` for the UI
  size while Quasar measures the window in unzoomed pixels: a pixel `style-fn` height, and
  QLayout's own inline min-height (the window's height), came out 135px past the window at zoom
  1.15. `pageFill` is `height: 100%` of the page container, which the theme makes fill the layout;
  the layout's min-height is overridden (`!important`, the one way past an inline style).
- **`view="hhh lpr fff"`** (header and drawer not fixed): the window never scrolls; a fixed drawer
  was a compositing layer of its own whose icons antialiased differently (up to 49/255).
- **The collapsed rail is QDrawer's mini mode** (`#mini` slot, Sidebar's `rail` prop) — the phone's
  mobile drawer has no mini mode, so it always shows the full sidebar. A width change applies at
  once; the mini toggle animates (Quasar's 0.12s; the grid's column transition was 0.22s).
- The connection-error screen is the route `/offline?from=…` (a guard in the boot file); Retry
  returns to `from`. vue-i18n is `boot/i18n.js`, as the CLI's i18n preset wires it.

Checked: lint; unit 590 (the boot smoke runs both boot files); build:spa; the installer build;
e2e 7/7; zoom 0.9, 1 and 1.15 — the page ends at the window's bottom, 0 pixels apart; the ten screens against the pre-port build (≤ 0.007%, 1/255 only; the AI page's live
memory); the shell's states (rest, collapse, expand, drag-resize to 338px, dark, the chat panel,
the help drawer, the palette, 1024 and 1920 windows) — 0 pixels but 88 at 1/255; onboarding with
no book (`/`, `/welcome`, `/ai`, `/help`, `/sync`, `/chapters` → welcome) — 0 pixels, same
redirects; the connection-error screen (the same but the port in its URL) and its way back to the
page; the phone build at 390px — the page full width, the ☰ opening Quasar's drawer over a
backdrop, closing on navigation.

**JustVoice** — what the side-by-side taught:

- **The layout is imported, not lazy-loaded** (both apps now): lazily, its components' styles (the
  kit TitleBar's scoped rule) moved into a later chunk and won ties with JustVoice's own (the title
  bar's gap went from 16px to 6px); every screen needs the layout anyway.
- **The layout's root is opaque** (the kit's rule paints `var(--bg)`): fixed but transparent, it was
  a layer Chrome draws grey-smoothed text on — all of JustVoice's text changed (JustWrite's root
  paints its own colour). Chrome's overlays now paint into it, so the help drawer's and the AI-tasks
  panel's text is sub-pixel smoothed where it was grey before — as JustWrite's always was. Listed.
- **Pages flow in the content scroller** (`pageFlow`): JustVoice's area scroller holds the boot
  banner, the page's lede and the page, so each page's own root became its q-page (classes kept,
  `.jv-fill` still fills) with no height of its own.
- **The rail is content-sized**: QDrawer takes pixels, so the layout measures the rail's computed
  width (`width: max-content`; a ResizeObserver follows locale and kind changes) — layout pixels, the
  unit the drawer's width is applied in under the UI zoom.
- **Lines** is two files: `components/LinesBoard.vue` (Studio embeds it) and `pages/LinesPage.vue`.
  The Settings sections, the import modal and a mock piece are components; the view helpers and their
  tests are `services/`; the mocks are `pages/mock/`, `components/mock/`, `services/mock/` and
  `router/mockRoutes.js`. The dictation window is `/dictate`, the connection-error page `/offline`.
- **Left as it is:** at a UI zoom other than 100% the content sits up to a pixel off where it was —
  Quasar pads the page container by the header's height in whole pixels (`offsetHeight`), and the
  title bar's height is fractional there (at 100% it is a whole 73px: nothing moves).

Checked: lint; unit 183; build:spa; the smoke gate (every view, zero JS errors; the shell check);
the ten screens against the pre-port build (live values and ≤ 8/255 only); the states (zoom 0.9 and
1.15, dark, the scrolled Voices list and its sticky header, keep-alive across a navigation, the help
drawer and the AI-tasks panel, 1024 and 1920 windows) — the same but the listed two; the dictation
window; the connection-error page and its way back.

**docgen** (2cac01c) — the same shape: the title bar in `q-header`, the nav in a `q-drawer` that
keeps desktop behaviour at every width (`behavior="desktop"` — docgen has no phone), the one main
scroller in `q-page-container`. What the side-by-side taught:

- The layout's root paints docgen's page colour (`.shell`, `--surface-2`): docgen's tokens have no
  `--bg`, so the kit's rule alone left it unpainted.
- Home is three alternative roots (`v-if`), so its q-page wraps them, with `pageFill` — with
  `pageFlow` its card stopped filling the window. Every other page flows (`pageFlow`).
- The e2e contract test scanned `src/views` by a `path.join` the greps missed; it scans
  `src/pages`. The same form was swept in every repo.

Checked: lint; unit 3 and server 161; build:spa; e2e 20/20; the ten screens and the shell's states
against the pre-port build — the same but the help drawer's and the AI-tasks panel's text, sub-pixel
smoothed now (as JustVoice's).

**The standard** — `app-structure.md` §Q.1 describes the layout as the apps have it (pages,
`pageFill`/`pageFlow`, the screens outside the chrome), §Q.4 the routing guards, the imported
layout and the fixed root, §14 the renderer lanes; the open deviation is gone. The guard
(`check-family.js`, Quasar check) fails an app without `src/layouts/MainLayout.vue` or pages in
`src/pages/`, with `src/views/`, `src/styles/` or `src/AppShell.vue`, or whose `App.vue` template
isn't a bare `<router-view />` — bite-tested (a `src/views/` in docgen).
