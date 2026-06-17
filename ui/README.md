# @delebash/llm-ui

Shared **Vue LLM provider/runner UI** for **JustVoice** and **JustWrite** —
the second half of `just-llm-runner` (the Python core is the first half).

The components render against a host-supplied **`ProviderBackend`** adapter and
**never call `fetch` directly**, so the same UI drives JustVoice (REST adapter
over `/v1/llm-providers*`) and JustWrite (Pinia adapter over its
`OpenAICompatClient`). One implementation, both apps, no forks.

**Internal library — NOT published to npm.** Consumed as a git dependency
(pinned tag), built to ESM/UMD with Vue externalized. See
`docs/plans/2026-06-16-thread3-phase2-llm-ui.md` in the JustVoice repo for the
full plan + the locked camelCase shapes.

## What's here
- `src/types.ts` — the shared **camelCase** contract (`Provider`, `FeaturePin`,
  `UsageRow`, `ModelEntry`, `DetectedLocalProvider`, …). LLM + embedding only.
- `src/adapters/ProviderBackend.ts` — the adapter interface each app implements.
- Vue components — TO BUILD (Phase 2, item by item: `LlmProviderForm` first).

## Develop
```bash
cd ui
npm install
npm run typecheck   # tsc --noEmit
npm run build       # vite lib build → dist/ (+ .d.ts)
```

SPDX-License-Identifier: GPL-3.0-or-later
