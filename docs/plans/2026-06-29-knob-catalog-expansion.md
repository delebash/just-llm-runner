# Knob-catalog expansion + Common/Advanced tiers (2026-06-29)

> **Relationship to the other plans:** this is a focused sub-plan of the AI-lab work. The lab/preset
> MODEL + the sampler/switch CHECKLIST UI are in `2026-06-29-ai-lab-preset-model.md` (Trial-4 #5). The
> master remains `2026-06-28-MASTER-PLAN.md`. This doc covers ONLY the knob INVENTORY expansion + the
> Common/Advanced tiering + the bool On/Off fix. Written BEFORE coding (real-plan artifact, user rule:
> docs ship with — here, before — the feature; full prose, cited).

## Why
The user (no sampling/hardware experience) asked, after seeing SillyTavern's larger sampler set: what
else does llama.cpp support, and what do WE need — "we dont want to overwhelm the user but we do want to
be able to fine tune, not just params but hardware switches as well." Research (this session) against the
current llama.cpp **`tools/server/README.md`** + the **smcleod sampling guide**
(`https://smcleod.net/2025/04/llm-sampling-parameters-guide/`) + **llama-param-pal** established:
- The 2026 practical consensus: most use needs only **temperature + min_p** (local) or **temperature +
  top_p** (cloud); everything else is fine-tuning. So our existing two-tier UI (the params row = everyday;
  the "Advanced samplers / Engine switches" disclosures = fine-tune) is the right shape — the task is to
  CURATE what goes in the disclosures and TIER it, not to dump all ~30 params.
- ST's **Top A**, **TFS (tail-free)**, **Repetition-penalty slope** are KoboldCpp/text-gen samplers
  llama.cpp does NOT have (TFS was removed upstream; Top A never existed) — so they are excluded.

**User decisions (AskUserQuestion, 2026-06-29):** "Full set + Common/Advanced split" for the catalog, and
"Add the free hardware switches + better help text."

## The decision (locked)
1. **Add a `tier` field** to `knob_catalog` (`common` | `advanced`). The checklist renders Common rows,
   then an "Advanced ▸" expander (collapsed) for the rest — so opening a disclosure shows ~5 rows, not ~20.
2. **Add the curated knobs** (below), all **off by default**, with per-value defaults cited from the README.
3. **Better help text** on existing switches (novice-friendly: what it does + when to touch it).
4. **Bool On/Off upgrade** to the checklist (see "The bool fix"): required so the default-ON switches
   (`cont_batching`, `mlock`) can be set OFF, not only present-at-"true".
5. **No runner code** for the 4 hardware switches — they are already typed `Overrides` fields
   (`process.py` `Overrides` + `_VALUE_FLAGS` + `_parse_switch`); samplers ride the per-request `extra`
   passthrough (`prompts.py _plane2_extra`). Verified this session.

## The new knobs — defaults CITED from llama.cpp `tools/server/README.md` (fetched 2026-06-29)
Source for every number below: `https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md`
(re-fetched 2026-06-29; quoted defaults).

### Samplers (plane 2) — NEW rows
| flag_name | kind | default (README) | tier | note |
|---|---|---|---|---|
| `repeat_last_n` | int | `64` (0=disabled, -1=ctx) | **common** | range for `repeat_penalty` (= ST "Rep Pen Range") |
| `mirostat_tau` | float | `5.00` | advanced | target entropy for `mirostat` |
| `mirostat_eta` | float | `0.10` | advanced | learning rate for `mirostat` |
| `dry_base` | float | `1.75` | advanced | DRY base |
| `dry_allowed_length` | int | `2` | advanced | DRY allowed length |
| `dry_penalty_last_n` | int | `-1` (0=off, -1=ctx) | advanced | DRY scan window |
| `xtc_threshold` | float | `0.10` (1.0=disabled) | advanced | XTC threshold |
| `dynatemp_range` | float | `0.00` (0.0=disabled) | advanced | dynamic-temperature range |
| `dynatemp_exponent` | float | `1.00` | advanced | dynamic-temperature exponent |
| `top_n_sigma` | float | `-1.00` (-1=disabled) | advanced | top-n-sigma sampling |
| `min_keep` | int | `0` | advanced | force ≥N candidates through filters |

### Switches (plane 1) — NEW rows (already plumbed in the runner → no runner code)
| flag_name | kind | default (README) | tier | note |
|---|---|---|---|---|
| `ubatch_size` | int | `512` | advanced | physical batch (`--ubatch-size`) |
| `threads_batch` | int | (same as `threads`) | advanced | prompt-processing threads (`--threads-batch`) |
| `cache_reuse` | int | `0` | advanced | KV prefix reuse (`--cache-reuse`) |
| `cont_batching` | bool | `enabled`/on | advanced | continuous batching; on by default — rarely changed |

### Tier assignment for EXISTING knobs
- **Samplers common:** `top_k`, `min_p`, `repeat_penalty`, `seed` (+ the new `repeat_last_n`). `temperature`
  + `top_p` stay in the catalog but are **excluded from the checklist** (the per-call params row owns them).
- **Samplers advanced:** `presence_penalty`, `frequency_penalty`, `typical_p`, `dry_multiplier`,
  `xtc_probability`, `mirostat` (+ all the new advanced rows above).
- **Switches common:** `ctx_len`, `flash_attn`, `cache_type_k`, `cache_type_v`. (`n_cpu_moe` stays excluded
  — it is the hardware-FIT knob edited in the Hardware-fit row.)
- **Switches advanced:** `mlock`, `no_mmap`, `no_kv_offload`, `batch_size`, `threads`, `parallel`,
  `spec_type`, `spec_n_max` (+ the new advanced rows above).

So an opened checklist shows ~5 common sampler rows / ~4 common switch rows, with the rest behind "Advanced".

## The bool fix (required, in-scope)
The checklist currently renders a bool knob as static "on/off" text with no value control: enabling stores
`"true"`, disabling removes the row. So a **default-ON** flag — `cont_batching` (default on) and `mlock`
(seeded `"true"`, set by the base MoE preset) — can only be present-at-"true" or absent; there is **no way
to store `"false"`** to emit `--no-cont-batching` or to drop `--mlock`. Verified: no view sets these
elsewhere (grep), so the checklist is the only path. `_parse_switch` already reads `"false"` correctly
(`lifecycle.py`). **Fix:** when a bool knob is enabled, render an **On/Off `UiSelect`** (`true`/`false`)
instead of checkbox-only; enabling seeds the knob's default; disabling removes the row. This closes the gap
for cont_batching AND mlock. Confined to the checklist branch — the add-row consumers (`LuModelCatalog`,
`RoutingByJob`) are untouched. Bool rows now also participate in `isChanged`/`resetOne`/`resetAll` (the ↺
reset), since they have a meaningful value that can differ from the default.

## Schema bump / reseed (the upgrade story)
Adding the non-null `tier` column (default `"common"`) is a **schema change**. `create_all` never ALTERs an
existing table and JW's `migrate_schema` is projects-only, so:
- **Dev (this container):** stop the server → drop `knob_catalog` + `knob_option` (the only writer is the
  seeder, so no user data is lost) → restart; `create_all` recreates them WITH `tier`, `seed_workspace`
  repopulates. (Equivalent to `data_admin._reset()`.)
- **Shipped installs (v0.1, pre-1.0):** this follows the project's established **drop+reseed policy** for
  schema changes — existing users **Reset workspace** to pick up the new column + rows + tiers. (A
  per-column migration was rejected as over-engineering against the stated policy AND because the seeder is
  idempotent-by-existence, so it would not retro-assign tiers to pre-existing rows anyway.)

## Wire + files
- `db.py` — `KnobCatalog.tier` column.
- `seed.py` — `tier` on every `DEFAULT_KNOBS` row, the new rows above, improved switch help, common-first order.
- `knob_catalog_api.py` — `KnobMeta.tier`; `stores.py list_knob_catalog` — emit `tier`.
- `KnobGrid.vue` (checklist branch only) — partition `visibleCatalog` (POST-exclude, so excluded knobs never
  leak into Advanced) into common + advanced; an "Advanced ▸ (N)" expander; the bool On/Off control; bool in reset.

## Verification plan
Renderer (from the JustWrite host app `/home/user/justwrite-app` — the shared kit has no standalone
renderer host): `npm run build:vite` + `node scripts/headless-smoke.mjs` (0 JS errors, all AI sub-tabs incl.
LuModelCatalog legacy grid) + a Playwright check (new rows present; Common vs Advanced split; bool On/Off;
reset covers bool). Backend (in `just-llm-runner`): `ruff check` + `pytest` — incl. `tests/test_knob_catalog.py`
`test_knob_tiers_and_expanded_set` asserting the `tier` values + the expanded set's cited defaults. Reseed
the dev DB first. Then a diff rules-check → commit + push.

## Status — LIVE TRACKER — DONE (2026-06-29)
- [x] db.py `tier` column on `KnobCatalog`.
- [x] seed.py — `tier` on every row, the 15 new rows (11 samplers + 4 switches) with cited defaults,
  improved switch help, common-first order; `seed_default_knobs` writes `tier`.
- [x] knob_catalog_api.py `KnobMeta.tier` + stores.py `list_knob_catalog` emits `tier`.
- [x] KnobGrid.vue (checklist branch) — Common rows + an "▸ Advanced (N)" expander (partition computed
  from `visibleCatalog`, POST-exclude); the bool On/Off `UiSelect` (so cont_batching/mlock can be set off);
  bool now included in `isChanged`/`resetOne`/`resetAll` (the ↺ reset). Single-sourced row markup via a
  `displayRows` list. Add-row branch + the other consumers (LuModelCatalog/RoutingByJob) untouched.
- [x] Reseed dev DB: stopped the server, dropped `knob_catalog` + `knob_option` (FK-safe), restarted →
  `create_all` recreated them with `tier`, `seed_workspace` repopulated. Verified the live
  `/v1/ai/knob-catalog` returns **40 knobs** (plane1 17, plane2 23) with correct kind/default/tier.
- [x] Verified: `ruff` clean; `pytest` 179 passed; `npm run build:vite` 0; `node scripts/headless-smoke.mjs`
  0 JS errors across all AI sub-tabs (LuModelCatalog legacy grid intact); a dedicated Playwright check —
  10/10 green: Common shown / Advanced hidden until expanded / excludes hold (temperature·top_p·n_cpu_moe) /
  expander reveals the new rows (mirostat_tau, dry_base, top_n_sigma, ubatch_size, cont_batching) / enabling
  a bool switch shows an On/Off select defaulting to On.
- [x] Docs: this tracker → done; recap pointer added.
- [ ] diff rules-check + commit + push (in progress this turn).

**Shipped-install reminder (unchanged from above):** this is a schema bump — existing users **Reset
workspace** to pick up the `tier` column + the new rows (the drop+reseed policy). New installs get it on
first seed.

## Follow-ups (2026-06-29, after the user's review)
- **Double-"Advanced" fixed.** The samplers `<details>` was titled **"Advanced samplers"** AND now carries an
  inner **"▾ Advanced (N)"** tier expander — two "Advanced". Renamed the section **"Advanced samplers" →
  "Samplers"** (it now leads with the common rows), so each section reads `Samplers › Advanced (N)` /
  `Engine switches › Advanced (N)` — one "Advanced" each. `ConfigColumn.vue` summary only. Build + smoke clean.
- **Params vs switches — reload semantics (verified in code, for the record).** The runner holds ONE
  `llama-server` at a time (`lifecycle.py` `load()`/`stop()` + a single `self._runner`).
  - **Params (Plane 2 — samplers, temp, top_p, max tokens, reasoning, JSON):** sent per request in the API
    body (`_plane2_extra` → `extra`); **no reload** — effective next call; local + cloud.
  - **Engine switches (Plane 1 — ctx, KV-type, flash-attn, n_cpu_moe, -ngl, mlock, batch/ubatch, threads,
    cont-batching, cache-reuse, spec):** baked into the `llama-server` launch flags; **require a model reload**
    (stop + respawn the local process); **local only**. `n_cpu_moe` is one of these (a hardware-fit switch).
  - Changing the **model** also reloads (new GGUF). There is **no separate "server restart"** tier — the
    per-model `llama-server` IS what respawns; the host Python app stays up.
- **Endpoint: we use CHAT completion, not text completion** (verified). `openai_compat.py` POSTs
  `/chat/completions` (our bundled llama-server speaks OpenAI-compat, + cloud); `ollama.py` POSTs `/api/chat`
  (chosen so `think:true` works). The server applies the chat template; samplers ride as body fields
  (`body.update(extra)`).
- **Sampler ORDER on the chat endpoint — EMPIRICALLY VERIFIED (2026-06-29), not just doc-read.** Spun the stock
  `llama-server` (b9786, qwen2.5-0.5b) in `scratchpad/router-test` and tested `/v1/chat/completions`:
  (A) a valid `"samplers":[…]` array → HTTP 200; (B) `/completion` echoed back the EXACT array sent
  (`generation_settings.samplers == ["min_p","temperature"]`, not the default chain) → the build parses+applies
  it; (C) **behavioral discriminator on the chat path** — identical params (`top_k:1, temperature:5.0, seed:7`),
  the only difference the `samplers` array: `["temperature"]` (top_k excluded) → garbage
  (`"(Input Pump🐠 SOAP periodic forex…"`), `["top_k","temperature"]` (top_k included → greedy) → clean
  (`"Hello! How can I assist you today?"`). Output flipped on order alone ⇒ **`/v1/chat/completions` HONORS the
  per-request `samplers` order.** So Google AI's "you must hardcode `--samplers` at startup, globally locked" is
  FALSE for current llama.cpp. **Consequence:** per-feature sampler ORDER is feasible as a per-request body
  field (no `--samplers` startup switch, no model reload) — the same path as our other samplers. If we build a
  sampler-order UI, it's a reorderable list writing a `samplers` array into the feature's params, NOT a Plane-1
  switch. (Still not built — surfaced for the user's decision.)

## DECISION — engine + serving model (2026-06-29, user-confirmed)
After fact-checking the KoboldCpp / TabbyAPI / Aphrodite pitch (mostly outdated or wrong vs current llama.cpp;
see the prior follow-ups + the 2026-06-24 research docs, now bannered), the user confirmed:
- **Stay on stock `ggml-org/llama.cpp`** (release binaries) + **spawn-per-model** (one `llama-server` at a time,
  respawn to switch). **Router mode deferred** — the low-VRAM trap (evict/reload pause OR RAM spill) + the
  1-model common case make it not worth it now; revisit only if multi-model co-residency / Compare-across-models
  becomes a priority. **Kobold/Tabby/Aphrodite rejected:** Kobold = end-user/RP features we don't use + its
  context-shift/KV-quant/per-request-sampler claims are already in llama.cpp (verified); Tabby/ExLlamaV2 =
  GPU-only, **no CPU offload** → worse for low-VRAM-that-can't-fit + NVIDIA-only (no Mac); Aphrodite =
  server-scale overkill. **Task #27 resolved by this.**

## DONE this turn (Parts 1 + 2)
- **Part 1 — decision recorded** (this section + banners on the three 2026-06-24 router-leaning docs + recap).
- **Part 2 — snappy-edit defaults SHIPPED.** llama.cpp's prefix reuse (`cache_prompt`) is already on by default;
  added the two that were off: a new **`context_shift`** Plane-1 switch (bool, default on, advanced tier) +
  **`cache_reuse`** — both now default-ON via the **`base` switch preset** (`context_shift:"true"`,
  `cache_reuse:"256"`), applied at model load. Wired `context_shift` through `Overrides` +
  `_apply_engine_overrides` (emits `--context-shift` / `--no-context-shift`) + `_parse_switch` (bool). **SWA-safe:**
  llama.cpp auto-disables context-shift on sliding-window models (Gemma) with a warning, no crash (verified
  upstream). Both flags **empirically spawn-tested** (stock llama-server b9786 + qwen2.5-0.5b → healthy with
  `--context-shift --cache-reuse 256`). Verified: ruff + 180 pytest (incl. an updated `test_unknown_model_empty`
  asserting the new base defaults) + build:vite + headless smoke (0 errors) + live reseed (41 knobs;
  base preset carries the two defaults).

## Part 3 — BLOCKED by a verified dispatch gap (do this FIRST, then the order UI)
The sampler-ORDER UI cannot be a real (non-stub) feature until **samplers reach production dispatch**, which they
do not today:
- **`_effective_spec` (prompts.py) does NOT apply the resolved preset's samplers** — its own docstring says
  *"its long-tail samplers are wired in a follow-up."* So a feature's preset samplers never hit the body.
- **The UI only GETs `/feature-samplers`, never PUTs** — so the checklist samplers aren't persisted to the one
  store `_plane2_extra` actually dispatches (feature-stored + per-call). That's why the in-lab **Run** test
  applies them (it sends `body.samplers` ad-hoc) but a real feature call does not.
**Prerequisite (the real Part 3 step 1):** wire the resolved preset's (and/or feature's) samplers into dispatch
(merge them in `_plane2_extra`/`_effective_spec`) + persist the checklist samplers from the UI. THEN the
sampler-order is one more entry (`{name:"samplers", value:"dry,top_k,…"}` with a comma→array split in
`_plane2_extra`) + a small reorderable list. **Not built — surfaced; this also makes the whole knob-catalog
expansion actually take effect in production, so it's worth doing regardless of the order UI.**
