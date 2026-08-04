# Feature ↔ Model system — current state (source of truth)

**Purpose:** ONE grounded reference for how features pick their model/preset, so we
stop re-deciding it and stop working from stale memory. Every claim is cited to the
CURRENT code (`ee0f669`+). When something changes, update THIS doc in the same change.
Origin of the model: `plans/archive/2026-07-15-preset-one-source-rewrite.md` — its
rationale + provenance are distilled into §0 below (docs campaign 2026-08-04).

## 0. Why one-source (the rationale, distilled from the rewrite plan)

- **The pre-rewrite routing was FOUR sources deep and lying to the user**: the
  feature→task→preset chain + an override tier; hidden per-action params on the
  prompt rows blended in by `_effective_spec` with per-field-INCONSISTENT rules
  (temperature/max_tokens fell back; top_p/json/think clobbered) and no editor
  mounted anywhere; a dormant per-action sampler layer; a pins tier write-orphaned
  in JW. Demonstrated failure: the Lab flattening trap — change only Reasoning on
  one action, Update preset, and six of eight judgment actions silently re-tuned.
- **The task tier was pure indirection** (id/label/position consumed only for
  lookup and labels) — deleted with no legacy fallback on the user's word: "the
  main source is that a feature is the base, it has a preset, that is the truth."
  `default_preset_id` relocated to a `RunnerSetting` row (its only prior
  persistence was inside the deleted table).
- **No-preset behavior is DEFINED, not invented**: an action with no ref and an
  empty default dispatches on the provider-default route with NO tunables sent and
  think OFF — params are never invented client- or server-side.
- **Effective think = `preset.think AND NOT (body.jsonMode ?? action.json_mode)`**
  — the guardrail reads two facts, no overlay (llama.cpp drops JSON-schema
  enforcement when thinking is on).
- **The pins tier is KEPT, not deleted — it just never fires in JW**
  (`FeaturePinConfig` / `LLMConfig.feature_pins` are JV-live). Cross-repo fact;
  don't "clean it up".
- **One routing surface**: the separate Presets page is DELETED; "Routing by
  feature" + the Lab's preset bar are the only preset controls; the production verb
  is "Use in production" / "● in production".
- Known seeded quirk: `voiceDrift` seeds `json_mode: True` but its prompt returns
  plain prose and its consumer never parses — carried byte-for-byte on purpose.
- Schema changes ship by drop-and-reseed (pre-release; no migrations) — the same
  family DB policy JW's ARCHITECTURE states.

## 1. How a feature gets its model + params
- A **feature = an action** (e.g. `chat`, `critique`, `writerAI.tighten`). It points at
  ONE **engine preset** via its ref (`feature_preset_refs`); if it has no ref it falls to
  the global **`default_preset_id`**. Resolution: `preset_resolve.py:47-63` (ref → default;
  a dangling ref falls through).
- The **preset owns the model + every tunable** — `provider_id`, `model`, temperature,
  top_p, max_tokens, samplers, think/reasoning (`presets_api.py:39-60` `EnginePresetRow`;
  seeds in JW `seed_presets.py:44-78`). The action's prompt row owns only the prompt text +
  the JSON contract (`prompts.py` `FeaturePromptRow`).
- At run time dispatch resolves the preset and overlays its provider/model/params onto the
  call (`prompts.py:474,534`; `dispatch.py:95-155`).

## 2. Per-feature model switching — SUPPORTED
- Because each preset carries its own `.model`, **different features (via different presets)
  can run different models.** Two chat-ish features can point at different presets with
  different models.
- You change a feature's model by editing **its preset's model** in the Lab (the preset
  model picker, `ConfigColumn` → `LuModelPicker`), or by pointing the feature at a different
  preset (Routing by feature).
- Practical intent: on a one-model / low-VRAM box every feature uses the one default; on
  cloud or big-VRAM you set different models per feature. The machinery does not force one
  model — that's a per-preset choice.

## 3. "The default model" (the model-tab default)
- Set via **Quick Setup** or **"Load as default"** on a catalog row → `modelApply.setAsDefault`.
  This writes the chosen model to TWO places:
  1. the **routing default** — `RoutingDefaults.llmId` + `.model` (`routing_api.py:26-28`),
     the global default provider+model; AND
  2. **every preset's `.model`** that still pointed at the previous default
     (`QuickSetup.vue:15-18`) — each preset keeps its own params/samplers/reasoning; ONLY
     `.model` is rewritten.
- Seed ships **`preset.model = ""`** (empty → Quick Setup fills it; `seed_presets.py`). So a
  fresh box has empty preset models until setup.

## 4. The model dropdown (per provider) — has a bug (#305)
- The picker lists a provider's models via `GET /v1/llm-providers/{id}/models`
  (`api.py:107-116` → `adapter.models()`), cached by `useProviderModels`.
- **Cloud providers:** the provider's own `/models`.
- **Built-in (`local-llamacpp`):** constructed as an **openai-compat** adapter
  (`registry.py:87`), so `adapter.models()` queries the **live llama-server `/v1/models`** =
  only the **resident** model — NOT the downloaded catalog. Verified live: returns
  `{'models': []}` when nothing is loaded. The probe/health path already special-cases the
  catalog (`api.py:132-140`, `_builtin_provider_health` → `[r.id for r in catalog]`); the
  LIST endpoint does not. **⇒ the dropdown shows only the loaded model; a newly downloaded
  model never appears.** Fix (#305): make the built-in `/models` return the catalog.
- Secondary: `useProviderModels.js:55-56` never refetches once it holds a non-empty list, so
  even a corrected endpoint needs a refresh-on-download.

## 5. Reset behavior
- **Per-feature "Reset to default"** (on every feature; `FeatureWorkbench.vue` `resetFeature`
  + `POST /v1/ai/preset-assignments/feature/{key}/reset`, `presets_api.py`): restores the
  feature's SEEDED ref (its OWN default preset, not clear-to-global) + refreshes that
  preset's params to the seed + resets the feature's prompt to seed. Toast, button stays.
- **Model on reset — USER DECISION (2026-07-16), SHIPPED:** a real reset is FULL — preset +
  prompt + **provider/model**, and the model resets to **the default set in the model tab**
  (the routing default `RoutingDefaults.llmId/model`, §3), NOT "kept" and NOT the seed's
  empty model. A fresh box with no default set leaves the seed's empty model (→ needs Quick
  Setup). Verified live: routing default `MY-DEFAULT-MODEL` + a per-feature override → reset
  → `model=MY-DEFAULT-MODEL, provider=local-llamacpp, think, medium`.
- **Reset ALL features** (footer "↺ Reset presets to defaults", `FeatureWorkbench.vue:180-191`
  → `POST /v1/ai/engine-presets/reset`): all built-in presets + seeded refs + default back to
  factory (custom presets kept; this one DOES blank models to the seed).

## 6. Reasoning / hardware cap — has a bug (#303)
- A feature's reasoning **level (ask)** is clamped to the box's **hardware cap** — min wins;
  effective = min(ask, cap) — resolved server-side (`reasoning_map`). Shown as
  "ask X · hardware cap Y · effective Z" (`LuFeatureChip` capLine).
- **Bug:** the reasoning dropdown (`ConfigColumn` `REASONING_OPTIONS`) lets you pick any
  level and doesn't constrain/annotate to the cap. Decide (#303): disable-above-cap vs
  show-the-cap-at-the-picker.

## 7. Per-action JSON output (the "Output as JSON" checkbox)
- **Where it lives:** on the action's **prompt row** (`FeaturePromptRow.json_mode`), NEVER on a
  preset — a preset is shared across actions and must never flip one action's parser. It is
  feature-level and savable.
- **UI (restored 2026-07-16, #300):** ONE savable "Output as JSON" checkbox in the Lab config
  column (`ConfigColumn` `.cc-json`) — the earlier read-only badge + ephemeral "test as JSON"
  toggle are gone. Toggling it: patches the column (the test run + display update now) →
  `save-json` up through `CompareStrip` (which syncs every column of this action, since json
  is per-action) → `FeatureLab.saveJson` PUTs the FULL saved prompt with only `jsonMode`
  changed to `/v1/ai/prompts/{action}` (system/userTemplate are OVERWRITE-on-PUT, only
  jsonMode/jsonSchema/nav are preserve-on-omit — so the full body is required) → `prompt-changed`
  bubbles to `FeatureWorkbench`, which updates its cached row **in place** (an array-replace
  would re-fire FeatureLab's shallow `props.prompt` watch and wipe the user's test inputs).
- **At run time:** the request's `jsonMode` overrides the stored contract for that call
  (`prompts.py:360,419`); the saved value is what every production run uses.

## Known gaps vs this design (open tasks)
- #305 built-in `/models` returns resident, not catalog (§4).
- ~~#301 reset should restore the routing-default model~~ — DONE (§5, shipped + verified).
- #303 reasoning dropdown ignores the hardware cap (§6).
- ~~#300 savable "Output as JSON" per action~~ — DONE (§7; 4-file kit change, build+smoke+PUT-contract verified).
- ~~#302 Lab "Update" → "Save"~~ — DONE.
- ~~#304 run-stats shown inconsistently (ms vs s, total vs output tokens)~~ — DONE: one shared
  formatter `common/services/runStats.js` (fmtSeconds/fmtTokens/fmtTps/fmtWords/fmtCost) used by
  the Lab result readout (ConfigColumn), Compare ranking (CompareStrip), and the task strip +
  status panel (AiTaskStrip/AiStatusPanel), AND the tune-benchmark surfaces (TuneMeasureModal ·
  QuickSetup, folded in on the user's "unify" go) — every tok/s / tokens / time readout in the
  kit now comes from the one formatter.
- #299 model-chooser popover layout — deferred while reasoning is edited in another session
  (the popover lives in LuFeatureChip alongside the reasoning cap line).
- #305 secondary (picker cache refetch after a download) — DONE (useRunnerModels tracks the
  built-in catalog id-set and invalidates the picker cache).
