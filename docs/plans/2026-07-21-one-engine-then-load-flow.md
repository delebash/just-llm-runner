# One workflow: every model-load runs the engine check (2026-07-21)

**The user's ruling (verbatim):** *"whatever it is, when you click apply in quicksetup it must
do engine check, then install or not and download, then load model. so the load model buttons —
regular load buttons on model AND the dropdown — now all they have to do is call the same engine
check. we already use the same progress mechanism for everything."* Also: *"we dont load embed,
that is lazy load"* — embed is OUT. *"you dont need to write really new code, no major decisions,
this is very easy."*

**So this is NOT new machinery — it's making the ONE shared load function do the engine check
first, and pointing every model-load button/dropdown at it.** The progress mechanism is already
consolidated (`createDownloadTask` + `DownloadBar`, 2026-07-15); QuickSetup already does
engine-check → install-with-bar → load-with-bar. We move that check into the shared load path so
the buttons inherit it. Executor: **Opus**, on the user's "go".

## The one insight
`useRunnerModels.retryLoad(modelId)` (`ui/src/composables/useRunnerModels.js:221-223`) is THE
shared load — the row Retry (:266) and warm-boot (`warmStartup.js:48`) already call it. The other
model-load buttons each do their OWN bare `POST /v1/llm-runner/load` instead of calling it. Fix:
put the engine check IN `retryLoad`, and route the other buttons through `retryLoad`. Done.

Load sites verified (all `POST /v1/llm-runner/load`, all need the engine):
- `retryLoad` (:223) — shared; row Retry + warm-boot. **← the check goes here.**
- `LuModelCatalog.makeDefault` (:122) — the row "Make default & load" (:1002).
- `LuModelCatalog.loadAssigned(m,false)` (:162) — the strip card "Load now" (:820).
- The **General-model dropdown** (:797 `pickSlot($event,false)`) — "changing it assigns + loads
  through the same writers as the rows" (:792). Routes to the chat writer; inherits the fix.

Embed sites (`POST /v1/llm-runner/ensure-embedding` — DIFFERENT endpoint, so the load-path check
never touches them; **leave all as-is**, D-embed): `makeEmbedding` (:150),
`loadAssigned(m,true)` (:161), the embed dropdown (:832 `pickSlot(_,true)`), `embedApi.js` (lazy).

## Decisions (all closed by the user's ruling — no open decisions)
- **D1** — the engine check lives in `retryLoad` (the one shared load). Every model-load trigger
  routes through it. Same workflow everywhere.
- **D2** — REUSE only. The engine install-and-wait reuses `createDownloadTask(engineInstallChannel())`
  — the exact task QuickSetup's `engineTask` uses (`useDownloadTask.js:207` + `:42`). Its
  `await task.start()` resolves when the install reaches a terminal state (that's why we can
  await it; the bare `useEngine.install()` only fires-and-polls). No new poller, no new bar.
- **D3** — embed OUT (lazy). It uses `ensure-embedding`, a separate endpoint, so it's excluded
  for free; touch nothing embed.
- **D4** — server unchanged. `_run_load`'s fail-fast (`lifecycle.py:1671-1677`) stays as the
  belt for a raw API load / a check-then-vanish race.
- **D5** — QuickSetup untouched. It already does the check via its own `engineTask`
  (`QuickSetup.vue:352,359-364,439-441`) over the SAME channel; no change needed. (A later dedupe
  to share one helper is optional, not this change.)

## Tasks (executor: read each site in full before editing)

**T1 — the check goes in `retryLoad`.** `ui/src/composables/useRunnerModels.js`.
Import `createDownloadTask, engineInstallChannel` from `./useDownloadTask.js` (verify no import
cycle: `useDownloadTask` imports `useEngine` + `client` + `downloadRate` + `loadPhases`, NOT
`useRunnerModels` — so this is safe). Add a module ref `const engineGateTask = ref(null)`.
Rewrite `retryLoad`:
```
export async function retryLoad(modelId) {
  try {
    const es = await request("/v1/llm-runner/engine/status").catch(() => ({ installed: true }));
    if (!es.installed) {
      const t = createDownloadTask(engineInstallChannel());
      engineGateTask.value = t;
      try { await t.start(); if (t.state !== "done") { loadErr.value = t.error || "The engine didn't install."; return; } }
      finally { engineGateTask.value = null; }
    }
    await request("/v1/llm-runner/load", { method: "POST", body: { modelId } });
    await refresh();
  } catch (e) { loadErr.value = e.message || "Load failed"; }
}
```
(Keep the existing catch/`loadErr` shape — verify the current field names at :221-227.) Add
`engineGateTask` to the `useRunnerModels()` return object (:280-285). The LOAD progress still
renders on rows via the existing `taskFor`/`/status` poller — unchanged; only the ENGINE leg is
added. Acceptance: `retryLoad` with the engine present behaves exactly as today; with it absent,
it installs (awaiting completion) then loads; install fail/cancel → `loadErr` set, no load POST.

**T2 — route the other model-load buttons through `retryLoad`.** `ui/src/components/LuModelCatalog.vue`.
Add `retryLoad` to the `useRunnerModels()` destructure (:36-40). Replace the bare load POST with
`await retryLoad(m.id)` in: `makeDefault` (:122) and `loadAssigned` chat leg (:162). Verify
`pickSlot($event, false)` (:797) routes its load through `makeDefault` (then it inherits) — if it
has its own load POST, route that too. Leave `applyingId` spinner cosmetics as-is. **Do NOT touch
the embed legs** (`makeEmbedding`, `loadAssigned` embed, `pickSlot(_,true)`). Acceptance: with the
engine uninstalled, the row "Make default", the card "Load now", the row Retry, and the General
dropdown each install the engine then load — zero dead-end `engine-not-installed`.

**T3 — boot is just "call the same function", not a fancy warm module.** (User: *"it is
simply, on start call the engine install — it either installs or passes — then call load model.
same thing. run existing function 1 2 3, no new fancy warm boot function."*)
`justwrite-app/src/renderer/src/services/warmStartup.js` strips to the minimum — it holds NO load
logic of its own, because the engine check/install-or-pass and the load both live inside
`retryLoad` now (T1):
- KEEP: (1) read the `warmDefaultOnStartup` toggle (a real user setting), (2) resolve the default
  LOCAL model id via `useModelApply().currentDefaultId` (empty ⇒ default isn't local ⇒ no-op),
  (3) `useRunnerModels().retryLoad(modelId)`, (4) export `warmModelId` for the splash overlay.
- DROP the "fancy": the skip-if-not-downloaded gate (:41) and any early resolve/status dance —
  boot runs the SAME 1-2-3 as a button (retryLoad installs-or-passes the engine, downloads if
  needed, loads). Optional one-line guard: skip if the model is already resident (a fresh boot
  never is, so it's cosmetic).
`justwrite-app/src/renderer/src/App.vue` (:34, :158-163): destructure `engineGateTask` from
`useRunnerModels()`; above the existing model `DownloadBar` (:161) add
`<DownloadBar v-if="engineGateTask?.value && engineGateTask.value.state === 'running'"
:task="engineGateTask.value" title="Setting up the AI engine" />`. Keep the spinner, the model
bar, and "Continue without waiting". Acceptance: a restart with no engine shows the engine bar,
then the model bar, then lands in the app — the SAME sequence as clicking Load, no stuck screen,
no bespoke boot path.

**T4 — tests + docs.** vitest (JW house harness — the existing
`src/renderer/src/services/__tests__/loadTaskAdapter.test.js` already imports from
`useRunnerModels.js`, so the alias resolves): a `retryLoad` suite with an injected `fetch`/request
— engine present → one `/load` POST, no install; engine absent → install task runs to `done`
then `/load`; install `error` → no `/load`, `loadErr` set. Update `loadTaskAdapter.test.js` only if
`retryLoad`'s return/behavior it relies on changed. Gates: `npm run test:unit`, `npm run build:vite`;
headless smoke ONLY if :1420/:17495 are free (never drive the user's live app), else report skipped.
Docs: one line in JW `CLAUDE.md` (the load path now engine-checks first) + append a §EXECUTION
record here (what changed · file:line · verify · reverse).

## §EXECUTION (2026-07-21, on the user's "go")

**What shipped.** The engine check is now IN the one shared load; every model-load button + the
dropdown + boot warm route through it; embed and the server are untouched.
- `just-llm-runner/ui/src/composables/useRunnerModels.js` — `retryLoad` now GETs
  `/v1/llm-runner/engine/status`; if `!installed`, runs+awaits `createDownloadTask(engineInstallChannel())`
  (the SAME task QuickSetup uses) and loads only on `state==="done"` (else `loadErr`); the in-flight
  install is a new module ref `engineGateTask`, exported from `useRunnerModels()`. (+import of
  `createDownloadTask, engineInstallChannel`.)
- `just-llm-runner/ui/src/components/LuModelCatalog.vue` — `makeDefault` (:122) and `loadAssigned`
  chat leg (:162) call `retryLoad(m.id)`; `retryLoad` added to the `useRunnerModels()` destructure.
  The General dropdown inherits via `pickSlot(id,false)→makeDefault` (:577). Embed legs untouched.
- `justwrite-app/src/renderer/src/services/warmStartup.js` — stripped to 1-2-3 (toggle → resolve
  default LOCAL model → `retryLoad`); dropped the skip-if-not-downloaded gate + the `refreshRunnerModels`/
  `READY` machinery. Only fires when a local model is the default (cloud-default ⇒ no-op).
- `justwrite-app/src/renderer/src/App.vue` — boot overlay shows the shared `DownloadBar` for
  `engineGateTask` during install (`title="Setting up the AI engine"`), then the model bar.

**Why.** The user's ruling: one workflow (engine check → install-or-pass → load) for every load
trigger, reusing existing functions; no bespoke warm-boot; embed is lazy.

**Verify.** `npm run test:unit` = 417 passed (incl. the new `engineGateLoad.test.js`: engine
present → load only; missing → install-then-load; install fail → no load + loadErr).
`npm run build:vite` green (the pre-existing INEFFECTIVE_DYNAMIC_IMPORT warning is unrelated —
useEngine's dynamic import of useRunnerModels + its existing static importers). **Headless smoke
NOT run** — the user's app is live on :1420/:17495 and the recap forbids touching it; the renderer
change is a computed + one template conditional over the existing DownloadBar.

**Reverse.** Revert the four files above + delete `engineGateLoad.test.js`.

## Out of scope (named, not silently absorbed)
- **Embed** — lazy, untouched (D3).
- **`TuneMeasureModal.vue` loads** (:204, :390) — a measurement flow, not a "regular load
  button"; it needs the engine too but the user scoped this to the load buttons + dropdown.
  Optional follow-up: route its load through `retryLoad`.
- **Server auto-install / QuickSetup refactor** — D4/D5.
