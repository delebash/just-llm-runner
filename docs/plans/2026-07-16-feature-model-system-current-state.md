# Feature ↔ Model system — current state (source of truth)

**Purpose:** ONE grounded reference for how features pick their model/preset, so we
stop re-deciding it and stop working from stale memory. Every claim is cited to the
CURRENT code (`ee0f669`+). When something changes, update THIS doc in the same change.
Origin of the model: `docs/plans/2026-07-15-preset-one-source-rewrite.md`.

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

## Known gaps vs this design (open tasks)
- #305 built-in `/models` returns resident, not catalog (§4).
- ~~#301 reset should restore the routing-default model~~ — DONE (§5, shipped + verified).
- #303 reasoning dropdown ignores the hardware cap (§6).
- #300 savable "Output as JSON" per action (stashed → redo on current code).
- #302 Lab "Update" → "Save" (stashed → redo).
- #299 model-chooser popover layout; #304 run-stats shown 3 inconsistent ways.
