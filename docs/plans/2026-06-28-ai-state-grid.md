# AI / LLM-Stack — State & Decisions Grid (reference snapshot, 2026-06-28)

> **What this is:** a plain reference for the shared AI/LLM stack — for every piece:
> what it **WAS** (the original design/instruction), what it **IS** now (verified in
> code this session), what it's **SUPPOSED to do**, and which calls are still **YOURS**
> to make. This is a working reference to untangle the mess — **NOT** the master plan,
> and it changes no code. Every "IS now" cell was checked by reading the actual file
> on 2026-06-28 (file:line given). Codes are decoded in the **Code Key** at the bottom.

## How to read the Status column
- ✅ = built and matches a decision **you** (or the docs) actually made
- ⚠️ = **OPEN — your call** (I overstepped, or you're disputing it)
- 🐛 = I got it wrong (correction noted)
- 🔒 = GPU-gated (not built yet)

## The menus you actually see (orientation)
The AI area has **5 menus** across the top (verified `ui/src/views/AiModelsArea.vue:141-148`):
**Providers & models** · **Routing by job** · **Routing by feature** · **Recommendations** · **Usage**.
"Compare" is currently a **mode hidden inside "Routing by feature"** — you want it pulled out into its own menu called **"Tuning."**

---

## THE GRID

### Cluster 1 — The Lab / Compare surface

| Item | What it WAS | What it IS now (verified) | Supposed → your call | Status |
|---|---|---|---|---|
| **Compare surface** | Decision 23 (06-24): a MODE in Features. **D11** (06-27): lives in **the lab** as N columns | A MODE inside "Routing by feature" (`CompareStrip.vue`); the separate Compare tab + `Compare.vue` were deleted (commit `820e597`) | You want a **separate "Tuning" menu** | ⚠️ |
| **ConfigColumn** | Decision 23: ONE full config (model + switches + prompt + params + presets/promote + test), used ×1/×N | `ConfigColumn.vue`, reused ×1 (Routing-by-feature) and ×N (Compare) | The single reusable unit — only *where* it shows is open | ✅ |
| **Promote** | Decision 23: sets model/switches/prompt as the action's routing. **D9**: features carry no switches | **C3** (my synthesis): model+prompt+params → the action; switches → the job (`FeatureWorkbench.vue:422-470`) | Mine to un-decide — depends on where switches live | ⚠️ |
| **Scheduler** | Decision 23 (06-24): cloud parallel, local serial | `CompareStrip.vue:57-60` reads each provider's **explicit Local/Cloud flag** (`p.local`) — not a guess; runAll `:66-73` | Correct as-is. My earlier "bad heuristic, I'll fix it" was **wrong** | ✅ / 🐛(my claim) |
| **Per-model "Tune & measure"** | **#20** task = "per-model engine **tuning** UI + tokens/sec readout". **§6.6 / D6**: switch-*editing* moves to the lab | A **"Tune"** button per model (`LuModelCatalog.vue:148-230,358`): edit the model's engine flags → load with them → report **tok/s + VRAM/RAM**. It **tunes AND measures**. It does **not save** per-model (D9 dropped per-model storage, `:152-153`) | It tunes+measures as named. **Open fork:** should a tuned result **save on the model** (reopen D9) or only via the job? | ✅ tunes+measures / ⚠️ per-model-save |

### Cluster 2 — Switches

| Item | What it WAS | What it IS now (verified) | Supposed → your call | Status |
|---|---|---|---|---|
| **Two planes** | Load-time engine switches (need a reload) vs per-request samplers (ride the request) | Built as two planes (load path vs dispatch `extra`) | Keep — you said you want to discuss | ✅ (discuss) |
| **Switch editor** | **D7**: a typed STRING. **D15** (revises D7): the shared **KnobGrid** | `KnobGrid.vue` — one key/value grid for both switches + samplers; used in the Lab (`ConfigColumn`) + Tune & measure (`LuModelCatalog`); `RoutingByJob.vue` deleted (job purge) | KnobGrid (D15) — settled | ✅ |
| **Where switches live** | §6.4: keep per-model + per-feature tables. **D9** (you): drop both, put on the **job** | D9 executed: `model_switches`/`pin_switches` dropped, `job_route_switches` survives (`switch_resolve.py`, `stores.py`) | Per D9 (your ruling) — confirm it still holds | ⚠️ |
| **Switch presets (type defaults)** | base/moe/mtp bundles pre-fill switches by model TYPE | Kept + seeded (`switch_presets`); the **Lab now seeds switches from the model** on pick (2026-07-02, `switchResolve.js` → `ConfigColumn`); `LuSwitchPresets.vue` deleted (orphan) → the baseline is seed/reset/API-only | Settled | ✅ |

### Cluster 3 — Models / routing / cost

| Item | What it WAS | What it IS now (verified) | Supposed → your call | Status |
|---|---|---|---|---|
| **Job / role / Profile** | **#31** (you, 06-25): job REPLACES role. **D12**: UI label "Profile", code stays `job` | job replaced role end-to-end; code uses `job`; "Profile" rename deferred | Per your decisions | ✅ |
| **Fast/Balanced/Best dial** | one 3-stop dial per job → fit-filtered model | Built (`llm_runner/llm/quality.py` + dial in Routing-by-job) | Per the research doc | ✅ |
| **Catalog + Fit** | DB-backed catalog, full hardware range, MoE-aware Fit | Built; `runner-manifest.json` deleted → DB tables | Per the research doc | ✅ |
| **License flag** | list use-limited models, flag them, never a default | A **hardcoded keyword list** in code (`LuModelCatalog.vue:62`: `community/research/non-commercial/llama/gemma/cc-by-nc`) | Flag is right; the list-in-code is my call (**A10**) — move to DB? | ⚠️ |
| **Pricing / cost** | `pricing.py` price list for the Usage ledger — added **06-26, commit `7232214`** (the shared-LLM move) — **NOT mine** | Still a hardcoded dict (`pricing.py:10-28`); my **A4** added `cost` to the run using it; I then **decided** "keep, no DB move" | You dispute it — prices change → DB-seed + editable? My "keep" was my call | ⚠️ |

### Cluster 4 — Per-request + serving

| Item | What it WAS | What it IS now (verified) | Supposed → your call | Status |
|---|---|---|---|---|
| **Reasoning-effort** | per-action Off/Low/Med/High → each provider's native control | Built: all 4 adapters map it natively (`anthropic.py:82-93`, `gemini.py:128-136`, `openai_compat.py:108-116`, ollama); off under JSON | Settled (web-verified) | ✅ |
| **Structured output (JSON)** | per-action JSON mode; later json_schema/grammar | Basic `json_object` only (`prompts.py:312`); schema/grammar upgrade still open | json now; grammar is open | ✅ / ⚠️ |
| **Plane-2 samplers** | the FULL backend-aware sampler set, not 5 | Passthrough shipped (`feature_sampler_params` → dispatch `extra`); sampler grid wired | Settled | ✅ |
| **Token count + budget guard** | preview + token count (heuristic + exact) + a budget guard | Token count built (`tokenize`, `runner/api.py:179`); guard is **SOFT, default 8192** (`ConfigColumn.vue:132`) | Count settled; soft-guard + 8192 default = my call (**A5**) | ✅ / ⚠️ |
| **Router vs spawn / residency** | llama.cpp ROUTER + a VRAM-budget planner | Router DECIDED (you, 06-28); build not started (needs GPU). Single spawn-load kept for the measure path | Router (yours); build later | ✅ / 🔒 |

---

## Key clarifications verified this session (corrections to earlier wrong claims)

- **"Tune & measure" is NOT measure-only.** It edits the model's engine flags (tune) **and** loads + measures tok/s/VRAM (measure) — exactly its name (`LuModelCatalog.vue:148-230,358`). It's the planned **#20** task, not something I invented. The only thing it lacks is a **per-model save** (because **D9** removed per-model switch storage) — whether to add that is the open fork.
- **`isLocal` is NOT a heuristic.** The scheduler reads each provider's explicit Local/Cloud flag set when you add the provider (`CompareStrip.vue:57-60`, `AiModelsArea.vue:43-44`). My earlier "bad guess, I'll fix it" was itself a guess and wrong.
- **`pricing.py` is NOT something I hardcoded.** It was added 06-26 in commit `7232214` and never touched since; my work only *consumed* it (added `cost` to the run). Prices do change, so it may belong in the DB — but that's a pre-existing item, not mine.
- **Save presets were NOT deleted.** In "Routing by feature" the Save-preset / Promote logic is still wired (`FeatureWorkbench.vue` `saveAs`/`useAsProduction`/`delPreset` → `/v1/ai/feature-presets`); my rebuild (`820e597`) **moved** them from a Workbench bar **into** the config column. (Git shows they've been removed-by-mistake and restored before — `05cb06e` "Restore per-action preset bar — it was removed by mistake".) **Open: confirm against the running screen whether they show where you expect.**
- **"Fold tuning into the lab" was an instruction, not my decision.** `§6.6` + the design log already landed "rip switch-editing out of Providers → edit in the lab." I wrongly dressed it up as a conflict I resolved.

---

## Decisions I made and embedded in the master (that should have been yours or flagged)

### Bucket A — §1 "RESOLUTION → X wins": I picked winners between conflicting docs
- **C1** Compare = MODE (Decision 23) vs in the lab as N columns (**D11**) → I picked MODE (overrode D11). *You want a separate tab.*
- **C2** switch editor STRING (D7) vs KnobGrid (**D15**) → I picked KnobGrid. *You're questioning it.*
- **C3** on promote, switches → the action (Decision 23) vs no feature switches (D9) → I synthesized "model+prompt → action; switches → job."
- **C4** keep switch tables (§6.4) vs drop both (**D9**, your ruling) → drop both (already in code).
- **C5** #20 own Providers screen (Decision 23) vs fold into lab (§6.6) → folded into lab. *(This was a clear instruction — shouldn't have been "my" decision.)*
- **C6** does llama.cpp drop JSON-schema when thinking ON — evidence doc says KILLED vs code treats it as a bug → I kept the "think-off under JSON" guard as a safe default + marked the claim unverified.
- **C7** MoE VRAM floor 12000/16000 vs ~24000 → I picked 12000/16000 as the floor.

### Bucket B — §1c: coding calls I made (the genuinely-mine ones)
A1 ConfigColumn emits/parent-owns · A2 config-aware promote · A4 added `cost` (stream cost = 0) · **A5 soft budget guard, default 8192** · A6 the scheduler local/cloud read · A7 CompareStrip as a mode-toggle · A9 license badge as a frontend join · **A10 the license regex** · A12 test-isolation fixture · A13 left an unused ai-store action · A14 the whole PART A/B doc architecture · A15 the verification approach · A16 using subagents.

### Bucket C — I decided things stay hardcoded / don't get built
"Keep, no DB move": **`pricing.py`** (disputed), `openai_compat.PROVIDER_DEFAULTS`, `tiers.py`. "Decided not to build": Locations↔Objects convergence dropped; VRAM-fit stays per-domain; app/UI prefs stay a simple store; connection-profiles/CFG/beam/Author's-Note → reference only.

### Bucket D — contamination: my decisions written INTO the "verbatim" folds
The master stamped my C1 ruling onto the verbatim **D11** entry (and E1) — so a fold of your design doc carries my decision inline. That's why the fold can't be trusted at face value.

---

## OPEN items that need YOUR ruling (the ⚠️ rows)
1. **Compare** = separate "Tuning" menu (D11) vs a mode in Features (Decision 23). *(You've said: separate "Tuning" menu.)*
2. **Switch editor** = KnobGrid (D15) vs string (D7).
3. **Where switches live** = re-confirm D9 (on the job, not per-model).
4. **Per-model "Tune & measure"** = add a per-model save (reopen D9) or keep save-in-the-job only.
5. **Promote** target split (rests on #3).
6. **License flag** keyword list → move to DB? — ✅ **DONE (2026-07-01):** now a DB-seeded per-model `use_limited` boolean (seeded from the license by a one-time helper), editable in the model form; the runtime regex is gone.
7. **Pricing** → move to DB + make editable? — ✅ **DONE (2026-07-01):** now a seeded `model_pricing` DB table (`price_for` reads it live; `DEFAULT_PRICING` is only the seed source + no-DB fallback), edited in a **Cloud pricing** editor in the Usage tab (CRUD `/v1/ai/pricing`).
8. **Budget guard** = the soft 8192 default acceptable, or wire the real per-model window? — ✅ **DONE (2026-07-01, user took the recommendation):** kept SOFT, but the window now derives from the column's own `-c` (ctx_len) switch → the loaded-model ctx → a **labeled "(assumed)"** 8192 (never a silent guess); the field shows its source and stays user-overridable.

---

## Code Key — what every label means
- **`#` numbers** = build-task numbers. **#18** structured-output · **#20** per-model tuning UI · **#22** per-action sampling · **#27** router-vs-spawn · **#29** VRAM-residency planner · **#31** job-replaces-role · **#61** license UI.
- **Decision 23** = *your* big design call (shared-ai-stack doc, **06-24**) covering the lab/Compare — one config column, the scheduler, promote.
- **D1–D17** = the numbered entries in the design doc's **"decision log" (06-27)** — decided during design. On this grid: **D6** rip switch-editing out of Providers → lab · **D7** switches-as-a-string · **D9** drop per-model/per-feature switch tables, switches on the job (*your ruling*) · **D11** Compare lives in the lab · **D12** call it "Profile", code stays `job` · **D14** the full sampler set · **D15** the shared KnobGrid · **D17** switches follow model+hardware, not the job. **§6.6** = the section of the jobs doc that says fold tuning into the lab.
- **C1–C7** = *my* "conflict" labels in the master (the ones to distrust — several are just instructions I dressed up as decisions).
- **R1–R7** = *my* "decision-state" notes (what's decided/built). R1 router decided · R2 reasoning built · R3 tokenizer built · R4 samplers per-action · R5 job lifecycle · R6 manifest→DB · R7 = R1.
- **A1–A16** = decisions *I* made while coding (see Bucket B).

## Where the source docs actually live (so the codes are traceable)
All in the **JustWrite repo** (`justwrite-app/docs/plans/`), not the runner repo:
- `2026-06-20-shared-ai-stack-plan.md` — **Decision 23**
- `2026-06-27-switch-and-preset-architecture.md` — the **D1–D17** decision log (§7)
- `2026-06-25-jobs-architecture-design.md` — **§6.6**, the jobs/role→job design
- `2026-06-27-switch-param-lab.md` — the lab design
- The master plan (the one with C/R/A codes): `just-llm-runner/docs/plans/2026-06-28-MASTER-PLAN.md`
