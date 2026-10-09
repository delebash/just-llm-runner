# just-llm-runner

The family's shared kit: the local-LLM runner (detects hardware, picks and downloads GGUF models
and the right prebuilt llama.cpp, spawns `llama-server`), the shared AI stack, the platform
pieces every app server uses, and the desktop shell — all in `server/` (`@delebash/llm-runner`,
plain JavaScript). The Vue UI kit is `ui/` (`@delebash/llm-ui`, on Quasar). `template/` is the
reference Quasar app every family app starts from.

**Internal — never published.** Apps consume `server/` as
`"@delebash/llm-runner": "file:../just-llm-runner/server"` and `ui/` as a source alias in their
`quasar.config.js` (app-structure §3) — no build or publish step.

The family rules every family repo follows, this one included: @docs/family-rules.md

> **A change here lands in EVERY app** (JustWrite, JustVoice, docgen). There is no per-app copy
> of any of this — that is the point of the repo.

## Commands

```bash
cd server && npm test          # vitest on Electron's own Node 24 (scripts/node24.js), never PATH's node
cd server && npm run lint      # Biome: src, tests, scripts
cd ui && npm run lint          # Biome: src
cd ui && npm run check:pickers # fails a hand-coded copy of a shared picker
node scripts/check-family.js   # the family guard: the three apps + the template against the kit
```

**After any change to a shared export, build and test every app that uses it** — nothing here
checks the consumers. `tests/process_job.test.js` proves the Windows kill-on-close job for real
only with `KIT_REAL_SPAWN=1`; `tests/realrouter_smoke.test.js` needs `JW_REALROUTER=1` and a real
engine.

## What bites

- **Dependencies stay light — no ML packages.** The three vendor SDKs (openai, anthropic,
  google-genai) were an explicit ruling, not a precedent for adding more.
- **`ui/package.json` `peerDependencies` must list everything the kit imports.** A missing peer
  still resolves through the app's own `node_modules` by luck (`quasar` was missing until
  2026-10-09). The kit's controls take one `intent` prop for role AND style — never add
  `severity` / `outlined` / `text`.
- **A module with a `<name>.phone.js` twin** (`runner/lifecycle.phone.js`) is swapped for it in
  the phone's worker bundle (app-structure §Q.7) — change both.
- **The desktop shell is `server/src/shell/`** (`runDesktopApp`, the preload, the data-root
  ladder). A new shell command goes in main's `COMMANDS` and the preload's list, never in an app.
- **An unwired catalog is not an empty one.** The runner's models response carries
  `catalogWired`; JustVoice once sat for months on "no host wired a catalog" reading as "empty".
- **Always pass `dataDir`** to `installLlm`. Without it the engine and models land in
  `~/.cache/just-llm-runner` (or `LLM_RUNNER_CACHE`), outside the app's data folder — an
  uninstall strands tens of GB and a backup misses them.
- **The cache may be shared; what an app generates never is.** The cache root holds weights and
  llama.cpp builds (content-addressed — two apps can share them); the runtime root holds
  `models.ini` and spawn logs, which each app renders from its own catalog. The family registry
  (`%LOCALAPPDATA%\just-ai\caches.json`) is machine-wide, so it ignores writes inside a vitest
  run unless `JUST_AI_HOME` points somewhere safe.
- **The router port is allocated — nothing may assume 8080.** `findFreePort` starts there; the
  live URL is the service's `routerUrl()`. Health-by-port is not identity: a second app's probe
  once passed against the FIRST app's engine. A `local-llamacpp` provider's stored `baseUrl` is
  a guess — `openai_compat.js` resolves it per request through `setLocalRunnerBaseUrl` and never
  falls back to the configured port when the router is down.
- **The wire is camelCase** (`runner/schema.js` and the `llm/` routes): renaming a field breaks
  every app's screens.
- **Engine defaults are DATA** — the pinned llama.cpp build, binary assets, flag presets and fit
  knobs are `runner/config.js` constants an app seeds into its database (editable there). Prefer
  a row over a code branch.
- **Launch flags resolve in four tiers** (`README.md`, "the 4-tier doctrine"): our estimate never
  reaches the launch; an untuned model leaves GPU placement to llama-server's own `--fit`, but
  `ctx-size` is always emitted; user values render exactly; measured tunes win, and auto-tune
  saves only a strict winner beyond the 5 % tie band.
- **Detection proposes, never dictates.** The box's class is `vram<GB>|ram<GB>`, overridable via
  `classKeyOverride` on `/v1/ai/engine-config`.

## Where to look

**Before researching anything — reading code to answer a question, measuring, briefing an agent —
read the subject's section of `docs/dev/RESEARCH.md`** (the family rule, 2026-10-04, app-structure
§13). Research isn't done until its facts land there.

| For | Read |
|---|---|
| **THE family app structure — every app** | `docs/app-structure.md` (§Q is the layout; `template/` the reference app) |
| Installing the stack in an app | `docs/dev/install-runbook.md` · app-structure §8 · `server/README.md` "Consume it" |
| How launch flags derive | `README.md` "the 4-tier doctrine" |
| Open work — the tracker for this repo (kit + shared server) | `docs/dev/TASKS.md`; unscheduled ideas in `docs/dev/IDEAS.md` |
| Model verdicts, licensing, measured serving numbers | `docs/dev/model-research.md` · `docs/dev/serving-design.md` |
| The routing/preset model | `docs/feature-model-system.md` |
| App-side open work | `../justwrite-app/docs/dev/TASKS.md` · `../JustVioce/docs/dev/TASKS.md` · `../just_ai_i18n_docgen/docs/dev/TASKS.md` |
| Per-task history and evidence | `docs/plans/*`; closed history in `docs/plans/archive/` |

Read branch and working-tree state from git, never from a doc.
