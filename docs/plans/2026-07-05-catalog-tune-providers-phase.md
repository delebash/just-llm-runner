# Plan / design — Catalog + Tune "providers" phase (the model-catalog edit form, the per-model Tune SAVE, MTP draft-file + reasoning switches, storage-card wording, logs)

> ⛔ **STATUS (2026-07-05): DISCUSSED with the user, NOT STARTED (no code — rule #10). Sequenced AFTER Phase 3b-ii-b of the model-surface build, which is DONE + pushed (runner `498ad2f` / JW `1fda0a1`).** This doc is the SSOT for a NEW body of work the user raised on 2026-07-05 while testing the Providers tab. The LOAD-BEARING open item is **the per-model Tune SAVE design** (§ below) — it touches design §6.5 (switch layering) and CANNOT be built until the user settles the persistence question. Everything here is grounded file:line against the real code this session (rule #7); do NOT re-derive — read this doc.
>
> This is captured pre-compaction at the user's request ("save everything in detail include session info about tune we discussed"). Nothing here is decided beyond what is explicitly marked "USER DECISION" — the rest is options + grounded findings awaiting the user (rules #6, #9).

## Why this exists — the user's asks (verbatim intent, 2026-07-05)

While testing the **Providers & models** tab the user raised a batch of changes. Grouped, with the user's own words preserved:

1. **Storage card:** *"storage -- Type Portable — beside the app if there is no other type then remove this wording."* → If the "Type" label only ever shows one value, drop the "Type" wording.
2. **Logs:** *"logs need to be esier to read and a clear or delete button and should store day and delete all logs button."* → readability + a Clear/Delete button + per-day storage + a Delete-all-logs button.
3. **Model catalog (grid + edit form):**
   - *"provider--model catalog remove params"* — later CLARIFIED by the user: *"remove params i meant from displaying on the grid the params count is in name and description it is taking up space i would rather use for type or leave it and add type."* → remove the **Params COLUMN** from the grid (redundant with the model name + description), and use that space for a **Type** column (or keep Params AND add Type — user leans "replace").
   - *"we need a type for the models moe mtp emebedd checkox for what model support"* → type/mtp/embedding as **checkboxes** (what the model supports).
   - *"lable identify if qant or iq or anything special all this should be available on hf"* → a label to identify the quant kind (Q vs IQ vs special), sourced from HF.
   - *"replace the type read only with the type checkboxes put them above fit estimate"* → the edit form's read-only Type becomes editable checkboxes, positioned ABOVE the fit estimate.
4. **Tune (the Tune & measure modal):**
   - *"tune- is this data store with model?"* — a direct question (ANSWERED below: NO).
   - *"instead of just send to task lab we should have apply or save that applies switches and params without fine tuning in lab, we should have default switches."* → add an Apply/Save that persists the tuned switches directly (not only "Send to Tasks Lab"); and default switches.
5. **Model info / MTP / quant:**
   - *"info about model, for mtp gemma has separate mtp file and quant, qwen is one model with built in mtp we need this model info and a field for mtp file and specifiy quant"* → MTP handling differs per model: **Gemma has a SEPARATE MTP draft file + its own quant; Qwen has built-in MTP (one model).** Need a catalog field for the MTP draft file + its quant.
   - *"als we have quant info avalaibel we should have this as a dropdown and type in the box, taht way if user does not know quant we list them but default to recommended quant for system."* → quant = a **dropdown of available quants** (from HF) + free-type, defaulting to the recommended quant for the system.
6. **The concrete switch set the user wants exposed in "quick tune"** (a real gemma-4-26B-A4B config from the user's box — verbatim):
   ```
   model = …/gemma-4-26B-A4B-it-qat-GGUF/…/gemma-4-26B-A4B-it-qat-UD-Q4_K_XL.gguf
   model-draft = …/gemma-4-26B-A4B-it-qat-GGUF/…/MTP/gemma-4-26B-A4B-it-Q4_0-MTP.gguf
   spec-type = draft-mtp
   spec-draft-n-max = 2            # Verified sweet spot for maximum tokens/sec
   n-gpu-layers = 99
   n-cpu-moe = 37
   ctx-size = 32768
   cache-type-k = q8_0
   cache-type-v = q8_0
   no-mmap = true
   mlock = true
   cont-batching = true
   batch-size = 64                 # maybe faster but slower initial prompt; maybe 1
   ubatch-size = 32
   threads = 8
   reasoning-budget = 1024
   reasoning-budget-message = "Taking user constraints into account, I will now output the solution."
   ```
   Note the **`model-draft`** (a SEPARATE MTP draft `.gguf` at a different quant, in an `MTP/` subfolder) and **`reasoning-budget` / `reasoning-budget-message`** — see the backend-gaps section.

## The user's framing + the conflict concern (recorded)

The user opened with *"we are working on providers here… lets discuss what we have for 3b-ii-b and this new info"* and then flagged: *"this is related sorta off to 3b modelApply.setAsDefault/setAsEmbedding, kit i just dont want to have conflicting issues."* → The user wants this catalog/tune work to NOT collide with the in-flight 3b-ii-b `modelApply` kit changes. The sequencing decision (below) + the "keep tune-save off modelApply" recommendation both come from this concern.

**USER DECISION (sequencing, 2026-07-05):** *"3b-ii-b the per model tune save design"* + *"we will discuss my recommendation, to keep it off the modelApply kit surface on tune save design after you complete 3b."* → **Finish 3b-ii-b FIRST (done), THEN this phase, opening with the per-model Tune-save design discussion.** The per-model tune-save must be kept OFF the `modelApply` kit surface (user recommendation, to be discussed/confirmed).

## Grounded current state (verified file:line, 2026-07-05 — the design docs were stale on some of this)

### Catalog DATA model — most of the "type/mtp/embedding/quant" fields ALREADY EXIST
`ModelCatalog` (`just-llm-runner/llm_runner/llm/db.py:69`): `id`, `name`, `hf_repo` (:78), **`quant`** (String, :79), `mmproj` (:80, multimodal projector), `total_params`/`active_params` (:81-82), **`mtp`** (Boolean, :83), **`type`** (dense|moe, editable, :87 — "Editable capability type… drives which switch_presets row applies, design §6.5"), `trained_ctx` (:90, GGUF header-derived), `min_vram_mb`/`min_ram_mb` (:91-92), `tier` (:93), `license` (:98), `use_limited` (:102), **`embedding`** (Boolean, editable, :107), `pooling` (:112), `quality_rank` (:113, lower=better). Mirror on the wire = `CatalogRow` (`model_catalog_api.py:29`): same fields camelCased + `samplers` (:44, file-derived recommended, read-only). `InspectResponse` (`model_catalog_api.py:62`) auto-detects `architecture`/`type`/`mtp`/`trainedCtx`/`experts`/`sizeLabel`/`totalParams` from the GGUF header PRE-download (via `POST /model-catalog/inspect`).
- **Gap for the user's asks:** `mtp` is a bare boolean — there is **NO field for a SEPARATE MTP draft-file repo/path/quant** (the Gemma case). `quant` is a single String — there is **NO dropdown-of-available-quants** (the user wants a picker + Q/IQ label). Both are net-new.

### Catalog EDIT FORM (`LuModelCatalog.vue`) — what to change
- Table columns (`:274`): `Model | Params | License | Fit | Status`; `Params` renders `35B · 3.6B active` (`paramsDisplay`, `:114-116`). **User: replace the Params COLUMN with a Type column** (compact `Dense`/`MoE` · `MTP` · `Embed` tags — same `type`/`mtp`/`embedding` data as the edit-form checkboxes).
- Quant is a free-text `UiInput` (`:349`, placeholder "Q4_K_M"). **User: → dropdown of available quants + free-type + a Q/IQ/special label** (this is ALREADY Phase-4 Smart-Add scope in `2026-07-05-model-surface-build.md:30`; can be pulled forward).
- Type is a READ-ONLY auto-row (`:358`, from `/inspect`); `mtp` read-only (`:360`); **`embedding` is ALREADY a `UiCheckbox` (`:379`)**. **User: replace the read-only type + mtp with editable CHECKBOXES [MoE][MTP][Embedding] ABOVE the fit-estimate note (`:367`).** Semantics wrinkle to confirm: MoE = the exclusive `type` (dense↔moe), so "MoE checkbox" sets `type`; MTP/Embedding are independent bools.
- Total/Active params are editable inputs (`:369-370`). **Keep these in the FORM** (they feed the fit estimate + size sort) — only the GRID display is removed.

### Tune modal (`TuneMeasureModal.vue`) — "is tune stored with the model?" → NO
- The modal is **measure-only BY DESIGN** (`:8-9` verbatim: *"Measure-only: to persist a config, tune it in the Lab and Save it as a preset for a Task — there is no per-model save here."*).
- It pre-fills from `resolveModelDefaults(id)` (`modelDefaults.js:16` → `GET /v1/ai/model-catalog/resolved-defaults` → `resolve_model_switches`), lets the user tweak the `KnobGrid`, `POST /v1/llm-runner/load {switches}` + `/measure` for tok/s.
- The ONLY keep-path today = **`sendToTasksLab`** (`labHandoff.js` — stashes `{providerId, model, switches}` + flips the AI subnav to the Tasks tab, where the Lab seeds a Compare column you Save as a Task preset). It surfaces an MTP hint when `mtpCapable` (`:143`) but **cannot point at a separate draft file** (no `--model-draft`).

### Where the modal's pre-filled switches COME FROM (the user asked "is it seeded default for all models?")
`resolve_model_switches` (`switch_resolve.py:36`) LAYERS three sources, later wins: **base (`all`, every model) → the model's TYPE preset (`moe`|`dense`) → per-hardware (`HardwareSwitch`, keyed by GPU `hw_key`)**. Seed (`seed.py:173-183`, `DEFAULT_SWITCH_PRESETS`):
- **`base` (`applies_to=all`):** `flash_attn=on`, `cache_type_k=q8_0`, `cache_type_v=q8_0`, `mlock=true`, `context_shift=true`, `cache_reuse=256` — applied to EVERY model.
- **`moe` (`applies_to=moe`):** `no_mmap=true` (the ONLY genuinely-MoE switch; `n_cpu_moe` is auto-fit, `spec_type` defaults to `none` in the knob catalog, not duplicated here).
- **NO `mtp` preset** (removed 2026-07-03; MTP is opt-in/measurable — `spec_type` stays `none` unless the user sets it per-Task in the Lab or per-machine via a `HardwareSwitch`; `switch_resolve.py:12-18`).
- So for a MoE model, the modal shows **6 base switches + `no_mmap` (moe layer)**; a DENSE model shows the same 6 WITHOUT `no_mmap`. **Nothing is per-model.** The third layer — `HardwareSwitch` (`db.py:226`, columns `hw_key`/`flag_name`/`flag_value`, keyed by GPU only) — is the **only per-machine persistence today**, and it applies to ALL models on that GPU (empty unless a machine tune was saved). `SwitchPreset` (`db.py:159`, `applies_to`=all|moe|dense) holds the base/type bundles; `PresetSwitch` holds the flag rows; **`EnginePresetSwitch`** (`seed.py:424-425`) holds a TASK preset's own switches (where the Lab-tuned config lands today).

### Runner SWITCH surface (`process.py` / `schema.py`) — what's supported vs the user's example
- **Supported + rendered:** `n_cpu_moe` (→ `--n-cpu-moe`), `cache_type_k`/`cache_type_v`, `no_mmap` (→ `--no-mmap`), `mlock`, `batch_size`, `ubatch_size`, `threads`, `threads_batch`, `cont_batching` (→ `--no-cont-batching` when false), `spec_type` ("none"|"draft-mtp"|"ngram-mod", `schema.py:231`/`process.py:84,153-154`), `spec_n_max` (→ `--spec-draft-n-max` or `--spec-ngram-mod-n-max`, `process.py:155-157`), plus the fit knobs `n_gpu_layers`/`ctx`. So `spec-type=draft-mtp` + `spec-draft-n-max=2` from the user's example ARE handled (works for Qwen's built-in MTP).
- **MISSING (net-new backend work):**
  1. **`--model-draft`** — a SEPARATE draft-model `.gguf` path (Gemma's external MTP file). The runner emits the `draft-mtp` MODE but has no way to point at a separate draft file → Gemma-style MTP does not work today. Needs: a catalog field(s) for the MTP draft repo/file/quant + a `model_draft` override in `schema.py`/`process.py` that renders `--model-draft <path>` (+ resolving the draft GGUF path like the main model's).
  2. **`reasoning-budget` / `reasoning-budget-message`** — absent from `schema.py`/`process.py` entirely. Net-new override fields + `knob_catalog` rows.
- The `knob_catalog` (`knob_catalog_api.py`) provides friendly `{label, help, options, kind, plane(1=switch/2=sampler), appliesTo(all|moe|dense), tier(common|advanced)}` metadata driving the shared `KnobGrid` — any new switch needs a knob-catalog row to render nicely (an unknown key still works as a raw row).

### Storage card (`justwrite-app/src/renderer/src/views/SettingsView.vue:1162`)
Renders **"Portable — beside the app"** OR **"User folder"** (`storageRoot.portable ? … : …`) — there ARE two states (portable beside-exe vs OS user-data fallback), so by the user's own condition (*"if there is no other type then remove this wording"*) the "Type" label is meaningful and STAYS; on the user's box it always resolves Portable. This is the portable-data-root feature (`docs/plans/2026-07-02-portable-data-root-and-engine-install.md`), separate from the model surface. A minor reword is possible but it is NOT a removal.

### Logs (`justwrite-app/src/renderer/src/views/SettingsView.vue:1260`)
Rendered by the shared kit **`LogsPanel`** (`@delebash/llm-ui`). The user's asks (readability, a Clear/Delete button, per-day storage, a Delete-all button) are **kit `LogsPanel` enhancements** (shared → both apps) and likely need a backend log-store change for per-day rotation + delete. Read `LogsPanel` + its log endpoint before scoping.

## ⛔ THE LOAD-BEARING DECISION — the per-model Tune SAVE (design §6.5)

**The tension:** the user wants an **Apply/Save** in the Tune modal that persists a model's tuned switches directly (skip the Lab). But the current design (§6.5) DELIBERATELY has **no per-model switch layer** — switches layer base→type→hardware (`switch_resolve.py:20-21`: *"There is no per-job/per-feature switch layer — engine config is owned by the taskKind → preset cascade"*). The user's own example (`n_cpu_moe=37`, `spec-draft-n-max=2`) is **model AND hardware specific**. So a "save this model's switches" is a **design-doc change** and cannot be made unilaterally (rule #6). **Options surfaced to the user (the user must pick):**
- **(A) A new per-model switch layer** — a `ModelSwitch(model_id, flag_name, flag_value)` table (mirrors `PresetSwitch`/`HardwareSwitch`), inserted into `resolve_model_switches` as base→type→**model**→hardware. Simplest match to *"I tuned this model, remember it."* Loses hardware-portability (a different GPU wants a different `n_cpu_moe`) — user can re-tune.
- **(B) A per-(model, hardware) layer** — key on `(model_id, hw_key)`. Most CORRECT for the `n_cpu_moe` case (model+GPU specific). More complex (composite key + a UI that is honest about "this box").
- **(C) Save onto the Task preset** — write the tuned switches to `EnginePresetSwitch` for the relevant Task preset (the existing "keep a config" home). But that is per-TASK, not per-model, and this is where `modelApply` also writes the preset's `.model`/`.providerId` → the ONE place the two axes could collide (see orthogonality below).
- **(D) Save to `HardwareSwitch`** — REJECTED: it is per-GPU-ALL-models, so a model-specific `n_cpu_moe` would wrongly apply to every model on that GPU.
- **(E) Status quo** — Send-to-Tasks-Lab → Save as a Task preset. The user explicitly wants to AVOID this detour.

**USER RECOMMENDATION (recorded, to open the discussion): keep the tune-save OFF the `modelApply` kit surface.** Rationale (agreed this session): tune-save is a **switch-layer concern**, `modelApply` is a **which-model concern** — they are orthogonal axes on different tables (`modelApply` → `engine_presets.model`/`.providerId` + `routing.embeddingModel`; switches → `switch_presets`/`hardware_switches`/`engine_preset_switches`). Keeping per-model-save on a switch layer (A or B) — NOT routed through `modelApply`/`engine_presets` — means the two never write the same rows and never conflict (the user's stated goal: *"i just dont want to have conflicting issues"*). Option (C) is the one that WOULD touch `engine_presets`, so it is the option the user's recommendation steers AWAY from. **This is the first thing to settle next session; NO code until the user picks A/B/(C) and confirms.**

### Orthogonality / conflict analysis (why 3b-ii-b and tune-save don't collide)
- `modelApply.setAsDefault`/`setAsEmbedding` (the 3b-ii-b + 3b-ii-a surface) writes `engine_presets.model`/`.providerId` + `routing.embeddingModel` — WHICH model.
- Tune/switches read+write `switch_presets` + `hardware_switches` (+ `EnginePresetSwitch` via the Lab) — the FLAGS. `TuneMeasureModal` doesn't even import `modelApply` (it uses `labHandoff` + `/load` + `/measure`).
- File overlap is minimal: 3b-ii-b touched `QuickSetup.vue` + a read-only use of `modelApply`; the catalog/tune work touches `LuModelCatalog.vue` + `TuneMeasureModal.vue` + backend switch tables — different files. The ONLY collision risk is option (C) writing `engine_presets` — which the "keep it off modelApply" recommendation avoids.

## Sequencing + open decisions

**Sequence (USER-locked):** 3b-ii-b (DONE, pushed) → THIS phase, opening with the per-model Tune-save design decision.

**Open decisions the user still owes (rules #6/#9 — surfaced, not decided):**
1. **Per-model tune SAVE persistence — (A) per-model layer / (B) per-(model,hardware) layer / (C) Task-preset (the one the "off modelApply" rec steers away from).** LOAD-BEARING; gates the whole Tune Apply/Save. Keep OFF `modelApply` per the user's recommendation.
2. **"remove params"** — confirmed = drop the GRID `Params` column, replace with a `Type` column; KEEP Total/Active params in the edit FORM (they feed fit). (User leaned "replace" over "keep both".)
3. **Type checkboxes** — `[MoE]` (sets `type` dense↔moe) + `[MTP]` + `[Embedding]` above the fit estimate; confirm the MoE-as-`type` semantics.
4. **MTP separate-draft-file support** — add catalog fields (`mtp_draft_repo`/`mtp_draft_file`/`mtp_draft_quant` or similar) + a runner `--model-draft` override? (Gemma-style external MTP.) Yes/no.
5. **`reasoning-budget` / `reasoning-budget-message`** — add to the Overrides surface + knob catalog? Yes/no.
6. **Quant dropdown + Q/IQ label** — pull forward from Phase-4 Smart-Add (the quant picker + per-quant HF sizes) into the edit form? 
7. **Storage "Type" wording** — leave (two states exist) or minor reword?
8. **Logs** — scope the `LogsPanel` clear/per-day/delete-all (kit + backend log-store).

## Verification approach (when built — for reference)
Per the model-surface discipline: pre-build rules-checker (PANEL for the per-model-save design decision — it is load-bearing/architecture) → build → runner `ruff`+`pytest` (any switch-table/schema change; drop+reseed is free pre-prod) → JW `build:vite` + `node scripts/headless-smoke.mjs` (0 JS errors) + a Playwright probe for the catalog/tune surface → JV `ruff`+`pytest` + `import` + a grep for removed symbols (JV renders its own surfaces; confirm no kit consumer breaks) → live curl of the touched endpoints → diff rules-checker → commit + push per sub-piece. NO PR unless asked.

## Out of scope (record)
The 3b-ii-b work (DONE). Phase 4 Smart-Add + Phase 5 4a-knobs of the model-surface plan (unless the quant-dropdown is pulled forward here). JV shared-LLM convergence. #28/#25 benchmarks/recs. The remote-fetched-catalog future.
