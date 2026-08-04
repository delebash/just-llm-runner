# 2026-07-21 — Built-in provider row: engine-update affordance + warm-load on startup

> ✅ **CLOSED (docs campaign 2026-08-04)** — shipped; NOTE: the Part-2 warm-load described here was re-homed into the kit (ui/src/services/warmBoot.js, 2026-08-04). History/evidence only; live work: `docs/dev/TASKS.md`.

User-driven, this session. Two related asks about the **built-in llama.cpp provider**
now that it's collapsed to a normal list row (reverses QC-39(b), 2026-07-19).

## Part 1 — engine-update button on the built-in row (SHIPPED)

**What & why.** Since the built-in provider became a normal collapsed row, an
available engine update was only visible *after* you Edit the row (the Local-engine
panel inside `ProviderForm`/`LuRunnerEngine`). The user: "since we collapsed the
built in provider user cant see when engine update so add engine update button next
to built in tag, yes i know we will have two on next to tag and one in collapse that
is ok, go." So: surface the update on the row itself, next to the `Built-in` tag.
Intentional redundancy (row + panel) — explicitly okayed.

**Change.** `ui/src/views/AiModelsArea.vue`:
- Extended the existing `useEngine()` destructure (`:35`) to also pull
  `updateInfo` (→ `engineUpdateInfo`), `updateToLatest` (→ `engineUpdateToLatest`),
  and `busy` (→ `engineBusy`). Same module-singleton the panel uses, so the two
  surfaces can never disagree (the composable's own design invariant).
- The user wanted the row affordance to be "the same control … and have the engine
  version next to it as well". First cut copied the panel's markup+strings verbatim —
  but a copy drifts (T3), so instead **extracted ONE shared presentational component**:
  - **NEW** `ui/src/components/LuEngineUpdateButton.vue` — THE "Update to {build}"
    control. Binds the `useEngine()` singleton (`updateInfo`/`updateToLatest`/`busy`)
    and renders `<UiButton intent="info" size="small">Update to {{ latest }}</UiButton>`
    with the shared `:title` ("Update the engine to {latest} (you have {current}) — the
    old build folder is removed after the new one installs"). The **caller** gates
    visibility on `updateInfo?.updateAvailable` (so the panel's `v-else` "Reinstall"
    still pairs); the component is just the button. Label/title/intent/action live here
    ONCE — the two surfaces can never disagree in look OR wording. Matches the "THE one
    download bar" convergence precedent.
  - `LuRunnerEngine.vue:220` — replaced its inline update `<UiButton>` (was `:219-222`)
    with `<LuEngineUpdateButton v-if="updateInfo?.updateAvailable" />`; dropped the now-
    unused `updateToLatest` from its `useEngine()` destructure (`:33`).
  - `AiModelsArea.vue:461` — renders `<LuEngineUpdateButton v-if="isBuiltin(p) &&
    engineUpdateInfo?.updateAvailable" />` right after the `Built-in` tag; its
    `useEngine()` destructure keeps only `updateInfo` (the gate) — the component owns
    the action + busy.

`checkForUpdate()` already runs on this view's mount (`AiModelsArea.vue:363`,
policy-gated: `off` = silent), so `updateInfo` is populated without new wiring.
No new CSS — `.lu-prow-name` is already `flex; gap:8px; align-items:center;
flex-wrap:wrap` (`:661`), so the button sits inline next to the tag.

**Verify.** Reproduce with the update-check mocked to `{updateAvailable:true}`:
the row renders `Built-in provider — llama.cpp · LLM · Built-in · [Update engine]`
and clicking it drives the same `updateToLatest` (pin bump → force reinstall →
old-folder delete) as the panel. With the real server (no update) the button is
hidden. Verified in-container: mocked-update screenshot shows the button next to
the tag; headless smoke `#/ai` Providers tab + provider-form probes = 0 JS errors
(button hidden); `build:vite` compiles clean.

**Reverse.** Revert `AiModelsArea.vue` — the panel's own update button is
untouched, so removing the row button loses nothing but the row-level shortcut.

**Your-box check.** The mocked screenshot proves render + placement, but a REAL
"update available" state (pinned build behind upstream) only happens on your box —
give it one look when llama.cpp next tags a release.

## Part 2 — warm the default local model into VRAM on startup (SHIPPED)

**What & why.** The bundled runner starts cold — the first AI run after launch pays the
full spawn + load-into-VRAM latency. When the built-in provider is the user's default and
its model is already downloaded, warm it early and SHOW it loading. Approved design:
**opt-in, visible, self-gated** — never a silent surprise.

**The persisted setting `warm_default_on_startup` (default "1").** API-surface-only (a
`RunnerSetting` row, like `update_policy`/`preferred_gpu` — NOT part of `RunnerConfig`):
- `llm_runner/llm/seed.py` `DEFAULT_RUNNER_SETTINGS` — added the row (default "1"; the
  fill-empty seeder adds it to existing DBs without clobbering).
- `llm_runner/llm/runner_config_api.py` — `EngineConfig.warmDefaultOnStartup: bool = True`,
  `EngineConfigUpdate.warmDefaultOnStartup: bool | None = None`, a PUT block
  (`"1"/"0"`), and the Protocol `set_setting` key-list docstring.
- `llm_runner/llm/stores.py` `get_config()` — reads the row (absent → "1"/True) and passes
  `warmDefaultOnStartup=` into `EngineConfig(...)`; `reset_to_defaults()` restores it to "1".

**The toggle** — `ui/src/components/LuRunnerEngine.vue`: a `UiToggle` labelled "Load the
default local model into memory on startup", applied-on-flip (`setWarmDefaultOnStartup` →
`PUT {warmDefaultOnStartup}`) exactly like the "Faster downloads" toggle; the draft seeds
from engine-config in `loadDownloadKnobs`. Shared kit → the toggle also appears in
JustVoice's engine settings (harmless; JV has no warm trigger).

**Toggle placement (2026-07-21, user follow-ups).** Three moves. (1) First shipped inside the
`.lu-eng-knobs` group behind the `Details ▾` fold. (2) User "not good place … put it after
running on NVIDIA CUDA … to right of" → moved onto the acceleration-backend row in
`LuRunnerEngine`. (3) User "its buried in edit put it on main local" — that whole
`LuRunnerEngine` panel only renders *inside a provider's Edit form*, so the toggle was still
one click deep. FINAL placement: the warm knob is a GLOBAL engine-config setting (not a
per-provider one), so it MOVED out of the Edit panel entirely onto the **main Local page**.
- Its state was hoisted from `LuRunnerEngine`'s local `ref` into the **`useEngine` singleton**
  (`warmDefaultOnStartup` + `refreshWarm()` + `setWarmDefaultOnStartup()`), so every surface
  binds ONE reactive value — the singleton's stated invariant ("surfaces can never disagree").
- **NEW** `ui/src/components/LuWarmStartupToggle.vue` — THE shared toggle (label + `UiToggle`),
  bound to the singleton, self-seeding via `refreshWarm()` on mount. Same convergence shape as
  `LuEngineUpdateButton`/`LuEngineInstallButton`.
- `AiModelsArea.vue` renders `<LuWarmStartupToggle v-if="isBuiltin(p)" class="lu-warmbar" />`
  INSIDE the built-in provider's card — in `.lu-prow-info`, right under the `.lu-prow-url`
  line (`http://127.0.0.1:8080/v1`) and above the meta line — gated to the built-in row only
  (it's the local engine's own knob). First cut placed it above the card under the segmented
  control; the user corrected: "in the card below http … in card not in edit not above card
  on main local card". `.lu-warmbar { margin: 6px 0 0; }` tucks it under the URL. No Edit
  needed — the knob is visible on the built-in card itself.
- `LuRunnerEngine.vue` dropped its local warm `ref`, its seed in `loadDownloadKnobs`, its
  `setWarmDefaultOnStartup`, the template toggle, and the `.lu-eng-engrow`/`.lu-eng-warm` CSS;
  the acceleration-backend picker is a plain standalone `.lu-eng-backend` block again. The
  toggle now lives in exactly one place (the main page), not redundantly in the Edit form.

**The client warm — REUSE rewrite (2026-07-21, user: "just call the same function as the load
button … delete warmDefault … reuse that loading control … put it below the loading circle on
front page").** The first cut (`services/warmDefault.js`) hand-rolled its own `POST
/v1/llm-runner/load` + `/resident` poll AND resolved the model from
`getRoutingPrefs().defaultModel` — which is EMPTY for the built-in (its chat model lives in the
engine PRESETS, not `routing.default.model`; AiModelsArea resolves it via `currentDefaultId`,
not `defaultModel`). So the `!modelId` gate returned early every boot → **nothing ever loaded**.
Deleted and replaced with reuse:
- **`services/warmStartup.js`** (`startWarmOnBoot`) — no poll loop. Gates: (1) `warmDefaultOnStartup`
  on; (2) `useModelApply().refreshApplied()` → `currentDefaultId` (the SAME resolver the catalog's
  Default badge uses; empty ⇒ default provider isn't the local runner ⇒ no-op); (3) `refreshRunnerModels()`
  then the catalog row is `downloaded` and not already resident (never a boot-time pull). Then it sets
  `warmModelId` and calls **`useRunnerModels().retryLoad(modelId)`** — the SAME `POST /v1/llm-runner/load`
  the catalog's "Load now" runs, which drives the singleton's own load poll + progress.
- **Boot overlay** — `main.js` calls `await startWarmOnBoot()` BEFORE `app.mount` (so App comes up
  with the overlay already showing, a seamless hand-off from the static `index.html` `#app-boot`
  splash). `App.vue` renders a full-screen `.jw-bootwarm` (spinner + "JustWrite", styled to match the
  splash) with the shared **`DownloadBar`** below the circle, bound to `useRunnerModels().taskFor(warmModelId)`
  — the SAME control + live task the engine panel uses. It auto-dismisses when the model goes resident
  (`loaded|sleeping`); a "Continue without waiting" link + the bar's own Cancel/Retry mean a slow or
  failed load never traps the user (the load keeps running in the background either way).
- **New kit exports** (`ui/src/index.js`): `useRunnerModels`, `useModelApply`, `DownloadBar` — promoted
  to the shared surface so the host reuses them instead of forking. Chat model only (embed warms on-demand).

**Verify.** Backend round-trips live (`GET` warmDefaultOnStartup=True seeded; `PUT` false→false,
true→true) and the runner suite is green (645 passed; the 4 `test_lifecycle` fails are
pre-existing/VRAM-in-container, reproduced with these changes stashed). Toggle renders in
the engine panel (screenshot). `build:vite` clean; headless smoke 0 JS errors — the warm
no-ops in-container (engine not installed), proving the CI-safe gate.

**Reverse.** Delete `warmStartup.js` + its `main.js` call + the `App.vue` `.jw-bootwarm` overlay
(client), revert the three kit `index.js` exports, and drop the `warm_default_on_startup` wiring
(server/toggle); an existing DB keeps an inert row.

**Your-box check.** The actual warm (a real load into VRAM + the "Loading your writing
model" task) only happens with the engine installed + the model downloaded + built-in as
default — verify on your box: launch with those true and confirm the model is resident by
first chat, with the task visible during load; toggle it off and confirm a cold start.

## Part 3 — INSTALL button on the built-in row too (SHIPPED)

**What & why.** Part 1 surfaced the *update* affordance on the collapsed built-in row but
left *install* behind — a fresh box (engine not yet installed) still had to open Edit to
find "Install engine". User: "we collapsed the built in but we moved the update button but
not the install button move it now". So: mirror Part 1 exactly for install.

**Change.** Same convergence as `LuEngineUpdateButton` — one shared component, two surfaces:
- **NEW** `ui/src/components/LuEngineInstallButton.vue` — THE "Install engine" control.
  Binds the `useEngine()` singleton (`install`/`busy`), renders `<UiButton intent="primary"
  size="small" :loading="busy">Install engine</UiButton>` with the shared `:title`
  ("Download + install the llama.cpp engine for this machine"). The **caller** gates
  visibility on `statusKnown && !installed && !installing` (the panel's original inline
  gate). Label/title/intent/action live here ONCE — the row and panel can never disagree.
- `LuRunnerEngine.vue` — replaced its inline install `<UiButton>` (the `v-if="statusKnown
  && !installed && !installing"` one) with `<LuEngineInstallButton v-if="statusKnown &&
  !installed && !installing" />`; imported the component. `engInstall`/`engBusy` stay in the
  destructure — still used by Reinstall (`engInstall(true)`), Uninstall, and the backend picker.
- `AiModelsArea.vue` — extended the `useEngine()` destructure to also pull `statusKnown`
  (→ `engineStatusKnown`), `installed` (→ `engineInstalled`), `installing` (→ `engineInstalling`),
  and renders `<LuEngineInstallButton v-if="isBuiltin(p) && engineStatusKnown &&
  !engineInstalled && !engineInstalling" />` right after the update button, next to the
  `Built-in` tag. `checkForUpdate()`/`refreshEngine()` already run on mount, so status is populated.

Install and update are mutually exclusive lifecycle states (can't have an update available
when the engine isn't installed), so at most one of the two row buttons ever shows.

**Note (this pass).** Shipped fast at the user's explicit request — "no rules checker code
and push", "no tests no gate no nothing just code and push". No rules-checker agent, no
build/smoke this round; the change is a mechanical mirror of the already-verified Part 1
convergence (LuEngineInstallButton is LuEngineUpdateButton's twin), committed as trivial.

**Your-box check.** With the engine uninstalled, the built-in row shows "Install engine"
next to the tag; clicking it runs the same install as the panel (shared singleton), and the
in-flight progress bar still lives in the panel (open Edit to watch it) — same as the update
button's behaviour. Give the row a look on a fresh box + confirm `build:vite` compiles.
