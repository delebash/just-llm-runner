# 2026-07-21 — Built-in provider row: engine-update affordance + warm-load on startup

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

## Part 2 — warm the default local model into VRAM on startup (PENDING)

Approved design (opt-in, visible, cancellable — see the session's recommendation):
warm only when the routing default is the built-in provider with a chat model AND a
persisted `warm_default_on_startup` setting is on (default: on-when-built-in-is-default);
client-driven on app boot, reusing `createDownloadTask(modelLoadChannel(...))` +
`DownloadBar` / the AI-task panel for visibility; chat model only (embed already warms
on-demand via `ensureEmbeddingReady`). Server pieces already exist
(`RunnerService.ensure_model_ready` — `lifecycle.py:1240`; the default signal via the
routing default row / `default_llm_id_fn` — `install.py:345`); the net-new work is the
persisted toggle + the startup warm trigger + the boot-load progress surface. Touch-list
to be filled in when built.
