# Shared component architecture — stop reinventing UI across apps

**Status:** proposed (2026-06-23). Decision owner: user. Nothing built yet.

## The problem (grounded)

The same UI is written 2–3× across `justwrite-app`, `JustVoice`, and
`just-llm-runner/ui` (`@delebash/llm-ui`). Verified by listing the dirs:

**A. General primitives — triplicated** (`components/ui` in each app + `Lu*` in llm-ui):

| Primitive | JustWrite | JustVoice | llm-ui |
|---|:--:|:--:|:--:|
| Button, Checkbox, Input, Segmented, Textarea | Jw | Jv | Lu |
| Select | Jw | Jv | (Lu Combobox) |
| Tag | Jw | Jv | — |
| app-only | Table, Number, ColorPicker | Field, Toggle | ModelCatalog, ModelPicker |

The only per-app difference is **styling**, and all three sets are already
**token-driven** — so styling is data (`tokens.css`), not a reason to fork code.

**B. LLM-feature UI — reinvented per app, not yet shared:**
- AI task/batch **status**: JW `AiTaskStrip` + `AiStatusPanel` + `AiStatusButton` + `StatusRow`
  ↔ JV `TaskStrip` + `TaskStatusPanel`. Same concept, two implementations.
- **Streaming / AI progress**: open-coded in JW's feature modals (`EntitySweepModal`,
  `VariationsModal`, `WriterLabBase`, `CharacterAuditModal`, …) and JV equivalents.
- **Provider/setup views**: JV has its *own* `ProviderForm` + `QuickSetup` while
  llm-ui already ships both → convergence half-done.
- **Inline preset bar** (load · Save as · Use as production · badge): JW
  `FeatureWorkbench` ↔ JV `SpeakerLabView` `.splab__presets`.
- **Provider row**: duplicated inside one file already (`AiModelsArea.vue:159-175` ≡ `:185-201`).

## Target architecture (two layers, one home for now)

```
@delebash/ui   (eventual standalone repo — general primitives for ALL Vue apps)
      ▲ depends on
@delebash/llm-ui   (LLM-specific components + views; this repo)
      ▲ imported by
JustWrite · JustVoice · future LLM apps   (only app-specific surfaces stay local)
```

**For now** both layers live in `just-llm-runner/ui/src/`, split into two folders so
the `common` layer is *extraction-ready* (self-contained, zero llm imports) and can
be lifted to its own repo later with no rewrite:

```
ui/src/
  common/                 ← the future @delebash/ui (general, app-agnostic)
    components/           Button, Input, Checkbox, Textarea, Segmented, Select,
                          Tag, Number, Dialog (confirm/prompt) …
    tokens.contract.css   the REQUIRED CSS-var names every host app must define
    index.js              exports only the common kit (no llm deps)
  llm/                    ← stays @delebash/llm-ui (depends on ../common)
    components/           AiStatusPanel, AiTaskStrip, AiProgressBar, ModelPicker,
                          ModelCatalog, ProviderRow, PresetBar …
    views/                AiModelsArea, FeatureWorkbench, ProviderForm,
                          QuickSetup, PromptLab, RoutingPresets
    index.js
  index.js                re-exports common + llm for convenience
```

The package keeps exporting from `@delebash/llm-ui`; the eventual split just moves
`common/` out and points llm-ui's import at `@delebash/ui` — callers barely change.

## Load-bearing decisions

1. **One component API = `intent`.** JW + Lu already use a single `intent` prop
   (role+style in one); JV uses `variant`. Canonical = `intent`; JV migrates
   `variant`→`intent`. Button knobs (radius/density/case) keep riding tokens.
2. **Token contract.** `common/tokens.contract.css` documents the var names the
   primitives consume (`--accent`, `--accent-soft`, `--accent-ink`, `--ink`,
   `--ink-2`, `--muted`, `--surface`, `--surface-2/3`, `--border`, `--danger`,
   `--success`, `--gold*`, `--r-*`, `--font-mono`). Each app defines them in its
   own `tokens.css` → same component, app-correct look.
3. **Naming.** Keep `Lu*` while in llm-ui; rename to neutral (`Button`, `Input`)
   when `common/` is extracted to `@delebash/ui`. (Rename is a mechanical, single
   pass at extraction time — don't churn twice.)
4. **App-specific stays local.** Genuinely one-app components (JwTable, JV audio
   players) stay in the app until a 2nd app needs them — then they move up. The
   rule is "2+ apps need it → it moves to the shared layer," not "share everything."
5. **No copy-paste-and-tweak.** When a shared component is *almost* right for an
   app, extend it (prop/slot/intent) — never fork it. Divergence requires a cited
   reason the same code can't serve both (RULE #7).

## Phased migration (each phase ships independently; apps stay working)

- **P1 — Stand up `common/`.** Move llm-ui `Lu*` → `common/components/`; reconcile
  to `intent`; write `tokens.contract.css` + `common/index.js`. Pure structure, no
  app changes. Gate: llm-ui builds + smoke green in both apps.
- **P2 — Lift the LLM-feature components into `llm/`.** Per component, do a
  file-by-file diff of the JW vs JV versions (RULE #3) FIRST, then write ONE:
  start with **AiStatusPanel/AiTaskStrip** ("status + batches"), then
  **AiProgressBar** (streaming), then **PresetBar**, **ProviderRow**. Compose on
  `common/`.
- **P3 — Migrate JustWrite.** Swap `Jw*` → `common`, and JW's AI status/modals →
  `llm/` components; delete the `Jw*` + JW-dup AI UI as replaced. Per-view or
  when-touched; smoke after each.
- **P4 — Migrate JustVoice.** `variant`→`intent`; `Jv*` → `common`; JV
  TaskStrip/ProviderForm/QuickSetup/SpeakerLab presets → `llm/`; delete `Jv*` +
  JV-dup. Smoke after each.
- **P5 — Extract `common/` → `@delebash/ui` repo.** Neutralize names, point llm-ui
  at it, both apps depend on both. New apps consume from day one.

## First slice (proof of pattern, low risk)

Within P1+P3: extract **Button** (the clearest 3× dup) into `common/`, migrate
JustWrite's `JwButton` call sites to it, delete `JwButton`, smoke. One vertical
slice proves the token-styling + `intent` API across the boundary before we
commit to the full sweep.

## Open question for the user

- Confirm **`intent`** as the canonical API (JV's `variant` migrates), and that
  `common/` lives in `just-llm-runner/ui/src/common/` for now (extract to
  `@delebash/ui` at P5).
