# Installing the shared LLM stack — the runbook

> Ruled by the user, 2026-08-08: *"do we have a contract for how to install
> llmrunner both server and client side that a human and ai can understand, so
> in a new project both ai and human can read doc and understand how to
> install."* This is that contract: the SEQUENCE, with every function name and
> argument verified against the code the day it was written. Depth lives in
> `docs/app-structure.md` — each step cites its section. If a step here stops
> matching the code, the code is right and this file has a bug.

The stack has exactly two installers, one per half. Each is ONE call, and each
exists because the à-la-carte version shipped silent breakage (four configure
calls, hand-mounted hosts, a missing attribute — all measured failures,
recorded in `ui/src/installLlmUi.js`'s header).

## The server half — Python

1. **Depend on the package.** Dev machines install it editable ONCE and never
   pin it:

   ```bash
   pip install -e ../just-llm-runner
   ```

   Do NOT make it a hard dependency of your app's `pyproject.toml` — a pin
   there clobbers the editable checkout on every `pip install -e .` (the
   JustVoice F1 lesson, recorded in its pyproject comment). A frozen bundle
   pulls it from git via an extra instead. (app-structure §8)

2. **Call `install_llm` on your FastAPI app** at startup, after your DB is
   ready:

   ```python
   from llm_runner import install_llm

   install_llm(
       app,                          # None = headless boot: stores + seeds, no routes
       engine=engine,                # your SQLAlchemy engine
       session_factory=SessionLocal, # sessions must get their OWN connections
       data_dir=data_dir,            # where the runner keeps its files
       product="yourapp",
   )
   ```

   That is the complete, legal minimal call — enforced by
   `tests/test_install_llm.py` and `scripts/check-clean-install.py`. An app
   with AI features adds `feature_catalog=` (its features/actions),
   `feature_prompts=` (seeded template rows; `{}` = a promptless pipeline app),
   `engine_presets=` / `feature_presets=`, and `prefer_local_features=`. Every
   knob's meaning is in `llm_runner/llm/install.py:250`'s docstring.

   **The storage caveat is load-bearing:** never hand it an in-memory
   StaticPool DB — the backfill daemon thread will silently roll seeds back
   (measured; the docstring carries the numbers). File-backed SQLite always.

3. **What you now have, for free:** every `/v1/ai/*` and `/v1/llm-runner/*`
   route (prompts, presets, routing, usage ledger, model catalog, Quick Setup,
   the run + stream execution paths), the seeds, and the usage sink. Your app's
   own AI endpoints call `run_action` / `stream_action` (import from
   `llm_runner.llm`) — never a provider SDK directly. (app-structure §8)

4. **Tests:** reset `lifecycle._service` and `seed._APP` per test; the
   hermeticity reference is `just-llm-runner/tests/test_install_llm.py`.
   After any shared-export change run `scripts/check-consumers.py`; after any
   dep/`__init__` change, `scripts/check-clean-install.py`.

## The client half — Vue

1. **Consume the kit as SOURCE** via the vite alias — all apps do; kit edits
   are live in every app's dev build immediately (app-structure §3):

   ```js
   // vite.config.js
   resolve: { alias: { "@delebash/llm-ui": fileURLToPath(new URL("../just-llm-runner/ui/src", import.meta.url)) } }
   ```

2. **Call `installLlmUi` in `main.js`** — one call, both transports, all hosts:

   ```js
   import { installLlmUi } from "@delebash/llm-ui";

   installLlmUi(app, {
     devPorts: [1430],            // your vite dev port(s) → origin-aware resolver
     fallbackBase: "http://127.0.0.1:17494",  // the Tauri-webview fallback — REQUIRED
     catalogCopy, quickSetupCopy, // your app's voice (optional)
     capabilities: { embeddings: true },
     labAdapters, sectionedFeatures, featurePanels,  // Lab wiring (optional)
   });
   ```

   The installer feeds ONE resolved base URL to both the app transport
   (`configureServerApi`) and the kit client (`configureLlmUi`) — the invariant
   that, when broken, made every kit view render empty in the production
   webview only. Signature: `ui/src/installLlmUi.js:91`.

3. **Mount the two pieces of chrome** the installer cannot place for you:
   `<LlmUiHosts />` once in the app shell (toasts, dialogs, boot overlay —
   without it `confirmDialog()` never settles), and the `/ai` route rendering
   the kit `AiModelsArea` plus `AiStatusButton` in the title bar and the
   AI-tasks nav row from `useAiTasksNav()`. (app-structure §11)

4. **Call AI the ONE sanctioned way** (app-structure §8, the AI-call
   convention; check-family check 11 enforces it):
   - variables in the renderer's hand → `runAiFeature` / `runAiFeatureStream`;
   - your own server-composed endpoint → `runAiEndpoint` (JSON + usage) or
     `runAiEndpointStream` (family SSE frames);
   - anything long (TTS, installs, batches, polls) → `withAiTask`.
   App code never calls `useAiTasksStore().start()` itself; every AI response
   carries usage; one task indicator per run; trigger buttons disable, never
   spin.

## Done when

Every §12 box in `docs/app-structure.md` checks — including the three AI-call
boxes: no task-store starts outside the runners, tokens visible on a real LLM
run, one indicator per run. `node scripts/check-family.mjs` from this repo is
the machine's version of this page; a clean run plus §12 is "installed".
