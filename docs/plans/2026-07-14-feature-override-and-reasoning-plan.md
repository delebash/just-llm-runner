# Plan — Restore per-feature preset override (Unit 1) + the thinking/reasoning system (Unit 2)

## ⛔ LIVE STATUS (kept current; single source of truth)

Branch (all repos): `claude/admiring-galileo-il3q0o`. Base: runner `9940a97`, JW `67f204a`.

- **APPROVED 2026-07-14** — user: *"i agree to your 5 recs go"* — after a 3-lens rules-checker
  panel (architecture-fit · reuse/convergence · grounding) found five real findings, all
  folded in, then a confirmatory re-check returned **VERDICT: PASS** (all T1–T12). The five
  folds: the missing `_plane2_extra` producer wire; `gemini.py:131`'s second word→number map
  slated to die; the `reasoning_map` made generation-aware (word + tokens columns) so ALL
  values incl. Anthropic-legacy/Gemini numbers are editable data and no adapter keeps a
  table; the C2 decision now carries the user's verbatim quote; a stale toast citation fixed.
- **The five flagged leans are LOCKED** (user approved all): (1) chat's migrated level =
  Medium; (2) local seeds 1024/4096/8192/16384 + Max=cap, global default cap = 8192;
  (3) map grain = per provider instance; (4) doorway editable on the two ChatPanel chips
  first, others navigate-only; (5) downmaps Ollama xhigh→max, OpenAI-family xhigh/max→high,
  Gemini keeps 2048/8192/24576 + extends.
- **Execution:** Unit 1 (T0→T10) ships first as one verdict-gated commit set, then Unit 2
  (T1 engine-bump + key-grep first). Progress recorded here per unit as it ships.

---

## Context — why this change

Two intertwined problems, both verified in code this session (2026-07-14; full discussion
record: `just-llm-runner/docs/plans/2026-07-14-thinking-budget-design-discussion.md`):

1. **Reasoning is broken end-to-end.** The built-in local provider discards the per-task
   Reasoning level (`openai_compat.py:117-119` — on/off only). Worse, the preset overlay
   **derives** think from the level — `think=bool(preset.reasoningEffort)`
   (`prompts.py:479`) — and NO seeded preset carries a level (`seed_presets.py:54-79`), so
   **nothing thinks locally today**: the seeded `chat` think=1 (`feature_prompts`, seeded at
   `seed_feature_prompts.py:945`) is clobbered whenever its task preset resolves (always —
   `chat`→`chat.grounded`→`p_chat`, `seed_presets.py:136,162`). The Anthropic adapter emits
   `budget_tokens` (`anthropic.py:80-93`) — deprecated on Claude 4.6, **400-rejected** on
   Opus 4.7/4.8, Sonnet 5, Fable 5 (verified 2026-07-14 at
   platform.claude.com/docs/en/build-with-claude/effort + /adaptive-thinking).
2. **The preset grain regressed.** Plan A (2026-07-02, commit `46cf11a`) removed the
   per-feature preset override tier. The user never knowingly approved losing fine-grain
   control (the headline "the task owns the preset" was true in BOTH models; the removal
   was buried — user 2026-07-14: "it was always intended for feature to be fine grain
   control"). User ruling: reversing a recorded decision is fine when it's the correct
   path. **Restore the 3-tier cascade.**

## User decisions (2026-07-14 — build to these, do not re-litigate)

- **C2**: task level = the ask; hardware value = the un-bypassable bound; LOCAL effective
  = `min(ask, cap)` computed at request time; the clamp ALWAYS displayed, from ONE source
  (the resolved-route payload). **User verbatim (2026-07-14, in-conversation AFTER the
  discussion doc's save point): "c2 agreed and label honest everytwhere should not be a
  problem it is same control same api that shows model, correct."** (The committed
  discussion doc still reads "B vs C open" — it predates this; updating it to DECIDED is
  U1-T10/U2-T10 work. Panel note: the grounding checker correctly flagged the doc
  contradiction; this quote is the resolution.)
- **Vocabulary**: Off / Low / Medium / High / **XHigh / Max** ("i want xhigh and max, we
  should have all of the correct settings for each provider, do it right").
- **Per-provider mapping = an editable DB table** (level→value per provider; protocol
  mechanics stay in adapter code).
- **Cap = option A**: a global default cap (editable, seeded sane) overridden by the
  tested per-(model, hardware-class) value where present (the Gemma 1024, `seed.py:397`).
- **Engine bump to latest.**
- **`think` = a stored field** (derivation dies); action-grain reasoning fields retire
  from the preset path.
- **Anthropic recs accepted**: model-aware adapter (adaptive + `output_config.effort` on
  new models / `budget_tokens` on old), drop sampler params the newest models 400-reject,
  honest display where thinking can't be turned off (Fable 5 / Mythos 5).
- **Chip doorway**: the read-only "runs on" chip becomes an editable doorway to the one
  preset — durable edit, same API (reverses QC-26 + part of B5-1; user: "its ok to change
  any decision if it is the correct path"; durable matches their Claude-web mental model).
- **Restore the feature-override tier** (reverses Plan A) — user: "go with your rec".
- **1:1 preset names align to task labels**; the shared "Interactive chat" preset keeps
  its role-neutral name (it serves BOTH chat tasks — `seed_presets.py:136-137`).
- **Grain-honest copy** on both routing surfaces; identical move-toast wording.

**Flagged leans (approve or strike with the plan):**
- Chat's migrated level = **Medium**. Seeded local numbers: low 1024 / medium 4096 /
  high 8192 / xhigh 16384 / max = unlimited (⇒ runs at the cap). Global default cap seed
  = **8192**. Map grain = per provider **instance**, seeded from type defaults.
- Doorway popover edits the **task preset** with an explicit "changes the <task> task —
  every feature in it" caption (a per-feature-override switch inside the popover is a
  later add if wanted). Editable-chip surfaces: the two ChatPanel mounts
  (`ChatPanel.vue:366-367`) first; the other ~19 mounts stay navigate-only.
- xhigh/max downmap where a provider lacks them (Ollama xhigh→"max"; OpenAI-family
  words xhigh/max→"high") — all as editable map DATA, not code.
- **(Panel-revised)** every level→value row — words AND numbers, including Anthropic
  legacy-model numbers and Gemini numbers — lives in the ONE editable map (two value
  columns per row; see U2-T2). No adapter keeps a level table. Gemini's xhigh/max number
  seeds extend its existing 2048/8192/24576 progression [flag: exact seeds yours to tune].
- Path convention: this plan spans TWO `seed.py` files — `just-llm-runner/llm_runner/llm/
  seed.py` (the runner/mechanism side; task labels, seeders) vs JW's app seeds
  (`justwrite-app/server/justwrite_server/seed_presets.py` / `seed_feature_prompts.py`).
  Unprefixed `seed.py` below = the RUNNER file.

---

# UNIT 1 — Restore the per-feature preset override (ship first, own verdict-gated commit set)

**WHY first:** it restores the grain the user designed, and Unit 2's reasoning fields then
land on the cascade the user actually wants. Every removed piece was recovered verbatim
from `46cf11a^` (the pre-removal tree) — this is a mapped re-add, not archaeology.

**U1-T0 — Fresh 2-tier consumer audit.** Don't trust the 12-day-old removal map: grep both
repos for `resolve_task_preset` / "2-tier" / `preset-assignments` consumers and diff
against the touch-list below; anything extra gets a row in the build record.
Known consumers today: `preset_resolve.py:21-33`, `prompts.py:452-464`,
`install.py:153-157`, `presets_api.py:88-90,148-155`, `FeatureWorkbench.vue:38,186-216`,
`TaskKinds.vue:226-237,373-395`, tests `test_presets.py:85-99`; read-only/additive-safe
but audit anyway (panel finding): `modelApply.js:61,99,132`, `TuneMeasureModal.vue:177`,
`chip-probe.mjs`/`rag-probe.mjs`/`b29-probe.mjs`, `resolvedRoute.test.js:69`,
`modelApply.test.js:27`.

**U1-T1 — db.py: re-add `FeaturePresetRef`.** Near `EnginePreset` (`db.py:578`): the
recovered model — table `feature_preset_refs`: `key` String PK (the ACTION id) +
`preset_id` FK engine_presets.id ondelete CASCADE NOT NULL. Old DBs still HAVE this exact
table (Plan A never dropped it — "orphan table inert", `preset-model-a-resets.md:22`);
fresh DBs get it via `create_all` (`db.py:703-707`). New TABLE ⇒ no `_ADDED_COLUMNS` entry.

**U1-T2 — stores.py: re-add `FeaturePresetRefStore`** (recovered verbatim: `list() ->
dict[str,str]`; `set(key, preset_id)` with "" ⇒ delete ⇒ re-inherit) + module singleton +
`get_feature_preset_ref_store()`. Place near `TaskKindPresetStore`.

**U1-T3 — preset_resolve.py: restore the 3-tier cascade.** Restore
`resolve_feature_preset(feature_key, task_kind="")` (recovered): `refs.get(feature_key)
or tks.get(task_kind) or tks.get("")`. KEEP `resolve_task_preset` (`:21-33`) — the Tasks
page + reset paths are legitimately task-grain. Module docstring → 3-tier, dated, citing
the user's 2026-07-14 reversal.

**U1-T4 — presets_api.py: re-add the override surface** (recovered): `FeatureAssignment`,
`FeatureClearRequest`, the store Protocol, `AssignmentsResponse.features: dict[str,str]`
(`:88-90`), the `get_refs` router param, `features=get_refs().list()` in `_assignments()`
(`:115-119`), routes `PUT /preset-assignments/feature` +
`POST /preset-assignments/clear-features`.

**U1-T5 — Wiring.** `install.py:153-157`: pass `stores.get_feature_preset_ref_store`.
`prompts.py:452-464` `_resolve_preset`: `resolve_feature_preset(key, task_kind)` — the
ACTION key is the ref key (same grain as the old tier; `writerAI.continue` and
`.tighten` can override independently). Docstring updated.

**U1-T6 — resolved-route provenance.** `ResolvedRouteResponse` (`prompts.py:307-322`) +=
`presetSource: str` ("feature" | "task" | "default" | ""); `resolved_route` (`:654-677`)
reports which tier won. Unit 2 extends this same payload — one source for every chip.

**U1-T7 — Reset story.** `reset_routing_to_factory` (`seed.py:945-964`): re-add the
clear-refs step (the Plan-A-dropped line). The Workbench per-feature ↺ becomes: clear
this feature's OVERRIDE (U1-T4 route) + the existing task-map clear
(`FeatureWorkbench.vue:234-242`), tooltip restored to the old wording ("Reset this
feature to its default task + preset"). Per-task Reset (`seed.py:967-1014`) unchanged.

**U1-T8 — FeatureWorkbench UI: genuine per-feature control.** Restore, modernized:
- A per-feature **Preset** dropdown replacing the read-only line (`:294-297`): options =
  the preset library + a "— inherit from task (<label>) —" sentinel; selecting writes
  `PUT /preset-assignments/feature`; an active override shows the clear-↺. Follow the
  QC-36 undo precedent (`TaskKinds.vue:226-237` setTaskPreset records an inverse) for the
  override write.
- Provenance goes 3-tier (rewrite `featurePresetLabel` `:186-197`, old 3-tier shape
  recovered): "**feature override**: <preset>" / "<preset> — from task <X>" /
  "<preset> · default". Restore the nav-card override dot (old `:258` markup) and DEFINE
  `.lu-fw-dot` in `common/styles.css` this time (it never had CSS — a recovered bug).
- The Lab's "Use for this task" button (`ConfigColumn.vue:454-457` emit →
  `FeatureWorkbench.vue:207-216`) STAYS task-grain with its explicit label + toast.
  presetAssign init/load (`:38,:153`) regains `features: {}`.
- **Grain-honest copy law:** every preset-writing affordance names its blast radius in
  the control itself, not only a toast. Task-move feedback becomes consistent across the
  two surfaces under the QC-37 toast law (the Tasks page deliberately has NO move toast —
  the row visibly moves, `TaskKinds.vue:216-217`; the Workbench shows an inline "Task
  reassigned." message, `FeatureWorkbench.vue:228`): same policy + same words on both,
  exact mechanics settled at build against the toast law.

**U1-T9 — 1:1 preset name alignment.** `seed_presets.py:54-79`: rename `p_prose_voiced`→
"Generate prose", `p_prose_edit`→"Edit prose", `p_digest`→"Grounded summary", `p_judge`→
"Judgment & scoring" (exact task labels, `seed.py:441-450`); `p_chat` "Interactive chat"
unchanged (shared). Existing DBs: a name-refresh in `seed_default_engine_presets`
(`seed.py:845-866`) — rename a built-in row ONLY if its current name equals the OLD
default (B2-1 precedent; user renames survive). The #48 equal-name collapse
(`FeatureWorkbench.vue:186-197` normName) then absorbs the display.

**U1-T10 — Tests + gates + docs (Unit-1 ship).** `test_presets.py`: extend
`test_resolve_cascade` (`:85-99`) to 3-tier (override wins; "" re-inherits; dangling
override falls through to task); route tests (feature PUT + clear-features); reset clears
refs; name-refresh honors user renames. Probes: `switch-probe.mjs` asserts Routing-by-
feature content (×2) — repoint findings-first; chip/b4/b5/qc-quintet/qc35 re-run. Gates:
runner ruff+pytest · JW server pytest+ruff · build:vite · FULL headless smoke · probe
fleet · rules-checker verdict. Docs SAME commits (T11): `justwrite-app/docs/tasks.md`
(three grains + reset levels) · this plan copied verbatim to
`just-llm-runner/docs/plans/2026-07-14-feature-override-and-reasoning-plan.md` · the
design-discussion doc updated to DECIDED + the corrections-log lesson (decision questions
must state the delta in BOTH directions — what's gained AND what stops existing) · recap
pointers.

---

# UNIT 2 — The thinking/reasoning system

**U2-T1 — Engine bump + THE KEY GREP (gates T5).** `runner/config.py:39`
`DEFAULT_PINNED_BUILD` "b9899" → the latest tag at build time (b9993 at the 2026-07-14
review; re-check). URLs re-derive (`:69-77`); VERIFY every `DEFAULT_BINARIES` filename
against the new release's real asset list (`:72-75` caveat; linux/cuda stays docker-only).
Existing boxes update via the in-app disk-resolving Update (QC-25) — no code. **Grep the
pinned llama.cpp source for the per-request budget key** (candidates from b9982/PR #23116,
#20297, #23434; three web summaries disagreed on the spelling — the key comes from SOURCE,
never a summary). Record key + launch-vs-request precedence in
`docs/llama-cpp-watch.md` (new baseline row) + the plan doc. Container check: download the
linux CPU build, run `llama-server --help`, confirm the flag/key; full-model load = box
test (user's word).

**U2-T2 — Data model (all additive; the `_ADDED_COLUMNS` seam, db.py:680-700).**
- `EnginePreset` (`db.py:578-603`): + `think` Boolean NOT NULL DEFAULT 0 →
  `_ADDED_COLUMNS += ("engine_presets","think","BOOLEAN NOT NULL DEFAULT 0")`. Widen the
  `reasoning_effort` comment to `"" | low | medium | high | xhigh | max`.
- Wire round-trip: `EnginePresetRow` (`presets_api.py:39-59`) + `think: bool = False`;
  `_engine_preset_to_wire` (`stores.py:580-587`) + `EnginePresetStore.save` (`:619-644`).
  QuickSetup's non-clobber writer is spread-safe (`modelApply.js:136-142` PUTs `{...p,
  providerId, model}` — new fields ride through once the GET returns them).
- NEW table `reasoning_map` **(panel-revised: generation-aware, TWO value columns)**:
  `provider_id` PK-part · `level` PK-part (low/medium/high/xhigh/max) · `word` String
  ("" = n/a) · `tokens` Int nullable ("" = n/a; the number form) · `built_in` Bool. The
  RESOLVER picks the column the resolved backend/model-generation speaks (mechanics in
  code); ALL values — words and numbers — are editable data. Store +
  `GET/PUT /v1/ai/reasoning-map/{provider}` (the model_pricing CRUD precedent, #75 —
  `pricing_api.py` is the template). Seeds per provider TYPE (fill-if-missing per
  instance, on provider create + at seed):
  · local-llamacpp: tokens 1024/4096/8192/16384/NULL (NULL = unlimited ⇒ runs at cap)
  · anthropic: word low/medium/high/xhigh/max AND tokens 1024/4096/8192/16384/32768
    (the legacy-model numbers — editable, per the user's decision; `claude-haiku-4-5`,
    the adapter default at `anthropic.py:28`, is a legacy-branch model and MUST get its
    numbers from here, not code)
  · openai/openai-compat/deepseek/openrouter: word low/medium/high + xhigh→"high",
    max→"high"
  · ollama: word low/medium/high + xhigh→"max", max→"max"
  · gemini: tokens 2048/8192/24576 (preserving `gemini.py:131`'s current behavior) +
    xhigh/max extending the progression [flagged seeds].
  Type ids source: `ProviderForm.vue:57-65` + `LOCAL_RUNNER_ID` (`modelApply.js:18`) +
  `ONLINE_ONLY_TYPES` (`useProviderConnect.js:30`).
- Global default cap: `DEFAULT_RUNNER_SETTINGS` (`seed.py:457-469`) += additive
  `{"key":"reasoning_cap_default","value":"8192"}`; surfaced beside the existing launch-
  defaults editors (the `.lu-pf-libs` popups, `ProviderForm.vue:236-240`).
- `ModelCatalog` (`db.py:70-163`): + `thinking` Boolean NOT NULL DEFAULT 0 (+
  `_ADDED_COLUMNS`) — the mtp/embedding precedent (`:89,:127`). Seeds: Gemma True; embed
  rows False; the rest per model cards verified at build (else False, editable in the
  model form). Read-from-link parity: `thinking` is a chat-template property, NOT a GGUF
  header field — a documented DECREE-#143 exception unless template-sniffing proves out.

**U2-T3 — One resolver, no derivation.**
- `_effective_spec` (`prompts.py:467-484`): `think=preset.think` — the `:479` derivation
  dies. `_effective_think` (`:441-449`) keeps ONLY the JSON guardrail + body override.
- Retire action-grain reasoning from the preset path: `seed_feature_prompts.py` drops
  `"think": True` from chat (`:945`, comment `:938-944` rewritten); its intent MIGRATES to
  `p_chat` (`seed_presets.py:64-66` gains `think=True, reasoning_effort="medium"`
  [flagged lean]) — a one-shot, logged, fill-if-missing preset-seed step (the prompt
  seeder is insert-only + heal-only (`seed.py:1128-1156`), so existing DBs need exactly
  this migration). `feature_prompts.think/reasoning_effort` columns stay physically
  (SQLite drop avoided) as the LEGACY no-preset fallback only — docstrings at
  `db.py:539,550` say so; `PromptOut`/`PromptUpdate` keep the fields (the Lab reads them)
  but ConfigColumn stops writing them to prompt rows [U2-T7].
- NEW `llm/reasoning.py` — `resolve_reasoning(preset, provider, model_id) ->
  ReasoningPlan{think, level, ask, cap, effective, capSource}`: level+think from the
  resolved preset (3-tier); ask = reasoning_map[provider][level]; LOCAL: cap = ClassTune
  `reasoning_budget` for (resolved model, current class_key) — the same rows
  `switch_resolve.py:92-97` reads — else `reasoning_cap_default`; effective =
  min(ask, cap); Max/NULL ask ⇒ cap; think off ⇒ 0. Cloud: effective = the map value the
  resolved model's generation speaks (word OR tokens — e.g. old-Anthropic gets the tokens
  column), no cap. THE one level→value home — `anthropic.py:80` AND `gemini.py:131` both
  die COMPLETELY (no adapter keeps a level table); resolved-route reports the exact value
  that will be emitted, so the display stays honest on legacy models too. Called by the
  run path and by resolved-route (the `dispatch.py:182` mirror law). Missing-map-row
  fallbacks live HERE (the seeded type defaults, one constant) — adapters stop defaulting
  (`openai_compat.py:125`'s `effort or "medium"` and `anthropic.py:90`'s
  `.get(effort, 4096)` die with it).
- **Close the second write path (panel finding):** the prompt PUT surface stops accepting
  reasoning fields — `upsert_prompt`'s preserve-on-omit for `reasoningEffort`
  (`prompts.py:223`) and any `think` write die; `PromptOut` keeps the fields READ-ONLY
  (legacy display) with a deprecation note. With ConfigColumn no longer writing them
  [U2-T7], the action-grain fields have NO live writer — a dormant fallback, not a second
  source.
- **THE PRODUCER (panel fix — the wire that makes it real):** `_plane2_extra`
  (`prompts.py:371-438`, which already receives `preset`) calls `resolve_reasoning` and,
  gated by `_effective_think`, injects into `extra` BOTH the resolved level word (for
  word-speaking adapters) AND the computed-budget sibling key (for the local/number
  paths) — replacing today's raw-level injection at `prompts.py:417-420`. Without this
  task the base.py pop would pop a key nothing puts and the chip would display a clamp
  the engine never receives.

**U2-T4 — Launch flag retired (decision 1a).** `process.py:118-136` `_VALUE_FLAGS`:
remove `("reasoning_budget","--reasoning-budget")` + the `_message` row — the engine
launches at its default (-1) and EVERY request carries the resolved number (pre-b9982's
"request key honored only when launch = -1" gate is satisfied by construction; post-b9982
request wins anyway). The class-tune `reasoning_budget` VALUE stays as DATA (the cap
source). knob_catalog row (`seed.py:529-532`) relabels: "Thinking cap — per-request bound
on this hardware (no longer a launch flag)". Raw runner API load fields
(`runner/schema.py:255-256`, `runner/api.py:186-187`) stay — only OUR launch profile stops
emitting. `lifecycle.py:239` int-cast entry stays (typed data read).

**U2-T5 — Adapters (mechanics in code; values from the map).**
- `openai_compat.py` local branch (`:117-119`): keep `enable_thinking` BOTH ways + add the
  per-request budget key (U2-T1's grepped name) = effective; think off ⇒ 0 (belt+braces —
  the layers-compose behavior box-verified 2026-07-06). Cloud branch (`:125`): emit the
  MAP word. Rewrite the stale docstring (`:103-116`).
- `anthropic.py`: model-aware `_apply_reasoning` at the body seam (`:126-138`): NEW
  models (explicit id-prefix list + tests: opus-4-6+, sonnet-4-6+, sonnet-5, opus-4-7/4-8,
  fable-5, mythos-5) → `thinking:{type:"adaptive"}` + `output_config:{effort:<map word>}`;
  think off → omit thinking (Sonnet 5: explicit disabled); Fable/Mythos 5 can't disable →
  send no thinking config + the resolver marks `capSource:"model-always-thinks"` for the
  honest UI note; drop temperature/top_p/top_k where 400-rejected. OLD models (incl. the
  adapter default `claude-haiku-4-5`, `anthropic.py:28`): today's budget_tokens +
  max_tokens bump (`:82-93`) — the NUMBER comes from the map's tokens column via the
  resolver; `_THINK_BUDGET` (`:80`) is deleted, not relocated. Matrix source: the two
  platform.claude.com pages (2026-07-14); re-verify at build (sonnet-5/mythos-5 ids are
  not yet in `models()` `:229-236` — extend the list there too).
- `ollama.py:92-95` + `gemini.py`: emit the map value (word or number). **`gemini.py:131`'s
  own `_THINK_BUDGET = {low:2048, medium:8192, high:24576}` dies** (panel finding — a
  second live word→number map; its current values become gemini's reasoning_map seeds so
  behavior is preserved, then the constant is deleted). Same law as `anthropic.py:80`:
  after this plan, NO adapter holds a word→value table — the only surviving legacy piece
  is the Anthropic legacy-model PROTOCOL PATH (emits `budget_tokens`; the number is
  supplied by the resolver from the map's tokens column — no table in the adapter).
- Reserved-key plumbing: `pop_reasoning_effort` (`base.py:60-68`) gains a sibling pop for
  the computed budget (internal `extra` key, e.g. `reasoning_budget_tokens`) so
  `dispatch.py:239-247,296-304` stays pass-through-shaped.

**U2-T6 — resolved-route carries the whole truth.** `ResolvedRouteResponse`
(`prompts.py:307-322`) += `think, level, ask, cap, effective, capSource` (+ U1-T6's
`presetSource`); `resolved_route` (`:654-677`) fills them via U2-T3's resolver. Chip wire
shape comment (`useResolvedRoute.js:10-12`) updated.

**U2-T7 — UI.**
- `ConfigColumn.vue`: REASONING_OPTIONS (`:50-57`) → Off/Low/Medium/High/XHigh/Max;
  buildBody (`:340-342`) writes the STORED pair `{think: sel!=="", reasoningEffort: sel}` —
  the derivation dies with it; the picker (`:500-502`) renders stored state. Kill the
  lossy seed at `FeatureLab.vue:201-210` (`d.think ? (d.reasoningEffort || "medium") : ""`)
  — the column seeds from the PRESET's stored think+level
  (`CompareStrip.vue:95-108` presetToConfig gains think). Muted cap hint on local routes
  ("hardware cap N · Max runs at the cap" — the blank=def hint pattern); the
  always-thinks cloud note on Off.
- `ProviderForm.vue`: a "Reasoning levels" table (level → value) mounted after the model
  slots (~`:228`, the `.lu-fgrid` row precedent) over the U2-T2 endpoint.
- Chip doorway: `LuFeatureChip.vue` (77 lines, presentational — QC-26 deleted the old
  popover) gains an OPT-IN edit popover (`editable` prop, default false): provider+model
  (LuModelPicker on useProviderModels) + the reasoning dropdown + the cap/effective line;
  writes the TASK preset via `PUT /v1/ai/engine-presets/{id}` (the same writer as the
  Tasks tab — `FeatureLab.vue:95-100`); caption names the blast radius ("changes the
  <task label> task — every feature in it"); QC-43 any-write invalidation
  (`client.js:54-58` → `useResolvedRoute.js:37`) refreshes every chip. JW: `AiFeatureChip.vue`
  passes `editable` on the two ChatPanel mounts (`ChatPanel.vue:366-367`); all other
  mounts stay navigate-only.
- Model form + catalog row: the `thinking` capability checkbox; the reasoning picker
  shows a "this model can't reason" hint when the resolved local model has thinking=False.
- Clamp display: chips + ConfigColumn read ask/cap/effective from resolved-route — no
  client math, no stored copies (the drift law).

**U2-T8 — Stale comment/doc sweep** (same commits as the code they describe):
`openai_compat.py:103-116` · `seed_feature_prompts.py:938-944` · `seed_presets.py:42-53`
(BOTH wrong halves: the request-layer claim + the base-bundle location) ·
`seed.py:345-352` note · `lifecycle.py:746` · knob help (`seed.py:529-532`) ·
`db.py:539,550` legacy-fallback note · `preset_resolve.py` docstring (U1-T3) ·
`useResolvedRoute.js:10-12`.

**U2-T9 — Tests.** Runner pytest — the matrix: local clamp (level×cap: min wins; Max→cap;
no class row→default cap; think off→budget 0 + enable_thinking false; JSON guardrail
still forces off) · anthropic old (budget_tokens+bump) vs new (adaptive+output_config,
temperature dropped, Sonnet-5 explicit disabled, Fable no-off marker) · ollama/gemini/
openai-compat map values + downmaps · map-edit honored end-to-end · map seeds
fill-if-missing · 3-tier + stored-think overlay (extend `test_presets.py:85-99`,
`test_prompts.py:224,303`, `test_adapter_extra.py:52-99`, `test_plane2_params.py`) ·
the p_chat migration one-shot (fires once; a user-edited p_chat untouched) · launch
profile emits no `--reasoning-budget` · resolved-route fields. JW vitest: extend
`resolvedRoute.test.js` (new fields ride the cache) + a chip-popover write test; the kit
has NO vitest (`just-llm-runner/ui` — none exists), so component behavior rides the
probes: extend the routing probe (set High on chat → resolved-route shows ask/cap/
effective; reload → picker still shows the stored state — the save-erases-think
regression pin) + repoint `switch-probe.mjs`/others touching changed markup.

**U2-T10 — Docs + ship.** models.md/tasks.md reasoning section (the dial, the cap, the
map table, per-provider truth incl. always-thinks models) · the design-discussion doc →
DECIDED + build record · llama-cpp-watch baseline row · recap GO paragraph. Gates per
commit: runner ruff+pytest · JW server pytest+ruff · JW vitest · build:vite · FULL
headless smoke · probe fleet · rules-checker verdict. Push both repos on
`claude/admiring-galileo-il3q0o` on the user's word.

---

## Execution order
Unit 1 (T0→T10, one verdict-gated ship) → Unit 2 (T1 FIRST — the grepped key name gates
T5's local emission — then T2→T10). The user executes on Opus after approval; the FIRST
execution act is copying this plan verbatim into `docs/plans/` (T8).

## Verification (all runnable in this container)
- Runner: `python -m pytest` + `ruff check llm_runner/ tests/` (449+ today).
- JW server: `cd server && python -m pytest && ruff check` (80 today). JW vitest.
- Renderer: `npm run build:vite`; boot server :17495 + `npm run dev:vite`; `node
  scripts/headless-smoke.mjs` (zero JS errors); the probe fleet + the new reasoning legs.
- Live curls: `GET /v1/ai/resolved-route?feature=chat` → think/level/ask/cap/effective/
  presetSource; `PUT /preset-assignments/feature` → `presetSource:"feature"`;
  reasoning-map PUT → the next run's body reflects it (dispatch test adapter); reseed a
  COPY of the dev DB → the chat migration fires exactly once; renamed presets honor user
  edits.
- Box (user): engine Update to the new build; one local High chat run (watch the stop at
  the cap); one new-Anthropic run (words on the wire, no 400).

## Out of scope
Per-chat ephemeral override tier (only if the durable doorway disappoints in use) ·
JustVoice adoption (mounts none of these routers — re-verify with a grep guard at ship) ·
json_schema/GBNF (#77) · a per-model cloud level-availability matrix (honest error
passthrough is v1).
