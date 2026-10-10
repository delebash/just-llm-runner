# just-llm-runner

The family's shared kit — **JustWrite**, **JustVoice**, **just-ai-i18n-docgen** and any new app
built from `template/`.

Detects hardware → manages/recommends GGUF models → downloads the right
prebuilt **llama.cpp** (CUDA runtime bundled — *no toolkit install*) →
spawns **`llama-server`** (OpenAI-compatible). One implementation, used by
every app, so detection/recommendation/flags never drift. Around it: the LLM
stack (providers, routing, presets, prompts, usage), the server's platform
pieces (Hono, errors, the spawn door, the data folder, backup, logs, ZIP), the
desktop shell, and the shared Vue UI.

**Internal library — NOT published to npm.** An app consumes the server package as
`"@delebash/llm-runner": "file:../just-llm-runner/server"` and the UI through a Vite source
alias to `ui/` (`@delebash/llm-ui`); electron-builder packs them. The end user never installs
it. Plain JavaScript (`"type": "module"`) on Node 24 — the Python core this repo began with was
ported (`docs/plans/2026-10-07-kit-in-javascript.md`) and removed with the family's move to
Electron and a Node server (2026-10-08).

## How a model's launch config derives (the 4-tier doctrine, 2026-07-06)

**Which model QuickSetup picks (§9 final ruled shape, 2026-07-22):** a model with a
**PC class config for THIS box's class** wins — the visible PC-class-config library IS the
recommendation (the distinct `(model, class)` pairs ride `GET /v1/ai/model-catalog`
as `classTuneRefs` + `myClassKey`; candidates pass the §10 guards and rank by the
shared quality comparator). No config for the class → the §10 speed-floor rule (most
capable model that still streams fast). The box's class is `vram<GB>|ram<GB>`,
detection overridable via `classKeyOverride` on `/v1/ai/engine-config` ("detection
proposes, never dictates"). The old hidden `model_class_picks` table is deleted —
one visible table answers both "which model" and "which launch config".

Every local llama-server launch resolves its flags in four tiers, strongest last:

1. **Our estimate — admission only, never emitted.** `computeFit` (`runner/fit.js`) projects VRAM for the
   arbiter's reservation and the Fit badges; when a placement knob is not explicit, the
   estimate is NOT written into the launch (see tier 3).
2. **Upstream engine fit — placement by omission.** An UNTUNED model's section/argv omits
   `n-gpu-layers`/`n-cpu-moe`, so llama-server's own `--fit` (default-on at the pinned
   build) places tensors dense-priority at our pinned context. `ctx-size` is ALWAYS
   emitted — context is a product decision (`min(trained ctx, kv_affordable)` when no one
   set it): the engine's fit would reduce context before offloading experts, the wrong
   preference for a writing app.
3. **User-set values — presets / per-request overrides.** Anything set explicitly renders
   exactly, which per upstream semantics disables engine fitting for that arg.
4. **Measured tunes — per (model, machine), always win.** Saved by the Tune modal or the
   auto-tune sweep. The sweep compares explicit candidates against the model's CURRENT
   launch (baseline) and saves only a STRICT winner beyond the 5% tie band — a tie never
   overwrites the baseline, so an untuned box keeps the engine's fit and a tuned box
   keeps its tune. If a fit-placed launch fails for any reason, the runner retries once
   with the explicit computed placement before the ordinary failure handling.

## What's here

- **`server/` — `@delebash/llm-runner`**, the server kit: `installLlm` (the whole LLM stack in
  one call), the runner (`runner/` — hardware, binary, download, models, gguf, lifecycle, the
  router), the platform (`platform/` — the Hono server and its guards, errors, the spawn door,
  the data-folder ladder, SQLite, backup, logs, ZIP, `serve.js` for the desktop and headless
  paths, the phone's worker runtime) and the desktop shell (`shell/` — `runDesktopApp`, the
  preload bridge). How to consume and check it: [`server/README.md`](server/README.md).
- **`ui/` — `@delebash/llm-ui`**, the shared Vue UI (below).
- **`template/`** — the reference app every family app is shaped like (`docs/app-structure.md`
  §Q): a Quasar app whose Electron mode is the desktop app and Capacitor mode the phone app, with
  its server as its own package.
- **`scripts/check-family.js`** — the family guard: every app's layout, dependencies and rules
  (`node scripts/check-family.js` from any family repo). `scripts/verify-model-pick.js` — the §10
  speed-floor pick's truth table.
- **`docs/`** — the family rules (`family-rules.md`), the app layout (`app-structure.md`), the
  research register (`dev/RESEARCH.md`), the tracker (`dev/TASKS.md`) and the plans.

The shared Vue GUI lives here too: **`ui/` (`@delebash/llm-ui`)** — plain-JS Vue
SFCs the apps consume via a Vite source alias (peer deps: vue, quasar, pinia,
marked, …; see `ui/package.json`). It ships the LLM views (providers /
models / prompts / usage), the `Ui*` primitive + shell layer (`ui/src/common/`,
built on Quasar's components — `docs/plans/2026-10-09-kit-controls-on-quasar.md`),
and the shared AI task queue — the `useAiTasksStore` in-flight registry (Pinia),
the `runAiFeature`/`runAiFeatureStream` wrappers over `/v1/ai/run`+`/v1/ai/stream`,
`friendlyAiError`, and the `AiTaskStrip`/`AiStatusPanel`/`AiStatusButton` surfaces.
The model-picker family (C5) adds `useProviderModels` (THE per-provider model-list
cache — one cache + one endpoint accessor kit-wide), the presentational
`LuFeatureChip` routing chip (host owns state), and the embeddings client
`embedTexts`/`ensureEmbeddingReady`.

## Consume it

```js
import { installLlm, router as runnerRouter } from "@delebash/llm-runner";

app.route("/", runnerRouter());                  // /v1/llm-runner/* — the runner's process API
await installLlm(app, { db, dataDir, product: "My App" /* , featureCatalog, enginePresets, … */ });
```

`installLlm(app, { db, dataDir })` is a complete call — **the minimal contract**: an app with no
per-action AI features is a first-class consumer. You get provider CRUD + registry, dispatch with
per-feature routing, engine presets, the model catalog, tunes + autotune, the knob catalog, the
usage ledger, and the bundled runner wired to the database's catalog. `app = null` is the
headless boot (every store, seed and seam wired, nothing mounted). The full server shape:
[`server/README.md`](server/README.md) and `template/server/`.

**Always pass `dataDir`.** Without it the engine and every downloaded GGUF land outside the app's
data folder, so uninstalling the app strands the weights and a backup silently misses them.

## Status

Live in JustWrite, JustVoice and docgen. Open work: `docs/dev/TASKS.md` (this repo's tracker);
per-task history in `docs/plans/`. The server suite: `cd server && npm test` — 1,136 passed,
2 expected failures, 12 skipped (2026-10-09).

SPDX-License-Identifier: MIT
