# @delebash/llm-ui

Shared **Vue LLM provider/runner UI** for **JustVoice** and **JustWrite** —
the second half of `just-llm-runner` (the Python core is the first half).

The components are **self-contained**: they call the **same server endpoints
both apps mount** (`/v1/ai/*`, `/v1/llm-providers*`, `/v1/ai-usage`) through a
host-configured origin-aware client, and ship their own **token-driven styles**
(the `lu-` class namespace, driven by each app's `tokens.css`). No per-app data
adapter, no host components — one implementation, both apps, no forks. (This
supersedes the earlier `ProviderBackend` adapter design — both apps now expose
identical endpoints, so the UI talks to them directly.)

**Plain JS — no TypeScript, no build step.** Consumed via a Vite alias to
`ui/src` in both apps (each app's own Vite bundles this source directly), so
there's no `dist/`, no `tsc`, no lib build. Current reference:
`docs/feature-model-system.md` + `docs/plans/archive/2026-07-15-preset-one-source-rewrite.md`;
open work in `docs/dev/TASKS.md`. (The old "authoritative" 2026-06-20 shared-ai-stack
plan is history — JW's copy archived, JV's superseded.)

## What's here
- `src/client.js` — origin-aware HTTP client; the host calls
  `configureLlmUi({ baseUrl })` once at boot. The camelCase wire shapes
  (`Provider`, `FeaturePin`, `UsageRow`, …) match the server's pydantic models.
- `src/styles.css` — token-driven primitive + layout styles (`lu-` namespace).
- `src/components/Lu*.vue` — primitives (Button / Input / Textarea / Checkbox).
- `src/views/*.vue` — shared views. `PromptLab` (the per-feature prompt editor)
  is the first; provider form / model picker / features routing / usage follow.

## The host wires it once (both apps)
```js
import { configureLlmUi } from "@delebash/llm-ui";
import { SERVER_BASE } from "./services/serverApi.js";
configureLlmUi({ baseUrl: SERVER_BASE });
```

SPDX-License-Identifier: MIT
