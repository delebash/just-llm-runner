# Plan — GGUF-grounded model layer (JustWrite AI)

> **⛔ STATUS: APPROVED 2026-07-02 (user), implementation NOT STARTED.** Persisted from plan mode + a 3-checker rules panel; ready to build Phase 1 first on a fresh session. Scope: shared `just-llm-runner` (runner + `ui` kit), consumed by JustWrite. **JustVoice is out** (build/verify JW only; JV inherits the shared changes). Branch `claude/admiring-galileo-il3q0o`. No PR unless asked. Items **1–5**; item 6 (QuickSetup `/v1/ai/jobs`→taskKind, #100) deferred.
>
> **Validated by a 3-checker rules panel (architecture-fit · reuse/convergence · grounding).** All three FAILs are folded below and marked 【panel】: the HF-vs-range-read grounding fix (T2), the coarse-map + hardware-band definition (T1), the `tasks[0]` mount/providerId fix (T1), the orphaned-mtp-preset removal (T3), docstrings-in-their-phase (T11), the stale `:447` copy (T5), and the `embed` data source (T5).

## Context — why this change
Walking the model/tune surface, the user hit a chain of problems that all trace to **one root cause: model facts are hand-typed, not read from the file.**
- `mtp` is a hand-typed seed flag (`seed.py:116` `"mtp": True`) — nothing detects it, even though the GGUF **binary header** exposes it (`{arch}.nextn_predict_layers`). Our `identity.py:8-10` comment + the UI copy `LuModelCatalog.vue:447` both wrongly claim it's undetectable.
- Fit + params + quant + context are all hand-typed (`seed.py:97-140`). But **the GGUF header is readable from the HF link with zero weight download** — we already read it locally (`gguf.py:96-98`) and drop most of it. (Live-checked this session: the HF **API** exposes `context_length`/`architecture`/**real file size** but NOT the per-arch hyperparameters; `mtp`/`type` come from a **range-read of the binary header** — see Phase 1.)
- The **MoE+MTP resolve rule** (`switch_resolve.py:53`) blanket-skips MTP for every MoE model. This was an **intentional §6.5 choice** (`switch_resolve.py:9-12`) that our **own later research superseded** (`2026-06-27-model-catalog-research-and-recommendations.md:89`: "MTP is machine-dependent — measure, don't dogmatize"). It's now wrong for the flagship MoE+MTP case — proven in-repo by our own `qwen3.6-35b-a3b-mtp` (`seed.py:121-124`, `mtp:True, type:moe`), whose MTP is silently disabled.
- The **catalog↔recommendations** surface is two hand-curated places that overlap; the recommendation picks (chat=small, the per-tier matrix) were a reviewer-panel + user judgment, **never measured** (#28 open).
- **Tune & measure is a dead end** — you tune switches, measure, then must re-type them in the Lab to keep them.

**Outcome:** the model *file* becomes the source of truth (read from the link, pre-download), fit is *live* everywhere (nothing estimated), MTP is detected + honestly measurable, the recommendation surface becomes a **per-hardware grid** computed from real fit, and Tune & measure hands its tuned switches straight into a task's Lab column.

## ⛔ LIVE STATUS — where this stands (kept current)
Branch `claude/admiring-galileo-il3q0o`; JW-only; verify per phase (runner ruff+pytest · build:vite · headless-smoke 0 JS errors · Playwright probe · rules-checker). Plan panel-reviewed (3 checkers) + folded. **APPROVED — build not started.**
- **Phase 1 — GGUF metadata from the link:** NOT STARTED — *(start here; the real .gguf to range-read for the key-name check is `unsloth/Qwen3.6-27B-MTP-GGUF` → `Qwen3.6-27B-Q4_K_M.gguf`, resolve URL `https://huggingface.co/unsloth/Qwen3.6-27B-MTP-GGUF/resolve/main/Qwen3.6-27B-Q4_K_M.gguf`.)*
- **Phase 2 — Auto-derive catalog fields (incl. mtp):** NOT STARTED
- **Phase 3 — MTP detect + default-off + measurable / MoE+MTP fix:** NOT STARTED
- **Phase 4 — Per-hardware recommendation grid:** NOT STARTED
- **Phase 5 — Tune & measure → Tasks Lab handoff:** NOT STARTED
- **Phase 6 — Docs + final verify:** NOT STARTED

---

## Phase 1 — Read GGUF metadata from the link, pre-download (foundation)
**Why:** everything downstream needs the file's facts *before* a multi-GB download.
**Grounding (corrected 【panel T2】):** two sources, different coverage —
- **HF API** `GET https://huggingface.co/api/models/{repo}` → `gguf` block gives `context_length`, `architecture`, **`total` = real file size** (+ file listing). Live-verified this session on Qwen3.6-27B-MTP / DeepSeek-V3 / GLM-4.5-Air — it does **NOT** expose `nextn_predict_layers`/`expert_count`.
- **Range-read of the GGUF binary header** (HTTP `Range` on the first ~1–2 MB of the `.gguf`) → the FULL per-arch KV incl. `nextn_predict_layers` (MTP), `expert_count` (MoE), `expert_used_count`, `block_count`, heads, `context_length`. This is the **primary** source for `mtp`/`type`/experts.

- **Extend the reader we already have** — `llm_runner/runner/gguf.py`. `read_gguf_metadata` already loads the whole KV header into `kv` (`:96-98`) but `GgufMeta` (`:41-47`) surfaces 6 fields. Add + populate in the `return` (`:106-113`): `context_length`, `nextn_predict_layers` (0 default → MTP signal), `expert_used_count`, `file_type`. **Verify each key name against a real MTP GGUF header before wiring** (the identity.py lesson — do not assume a key).
- **New remote fetch** — a small `gguf_remote.py`: `fetch_gguf_meta(hf_repo, quant) -> (GgufMeta, size_bytes)`. HF API for `context_length`/`architecture`/`total`; **range-read the header bytes into `io.BytesIO` and parse with the EXISTING `read_gguf_metadata`/`_read_value`** (one parser, local + remote). 【panel T4】 Options-considered: `huggingface_hub`/`gguf` PyPI can parse remote GGUF, but reusing our own `_read_value` adds **no new dependency** and keeps one parser — chosen for that reason.
- **Feed `fit.py` with real numbers (keep it — #29)** 【panel B-minor】: `coarse_fit` (`fit.py:75`) is params/quant-based → feed it the **real params** from the header; the **real file `total` size** (HF API) feeds the precise VRAM path (`weights_mb`/estimate), replacing the hand-typed `min_vram`/`min_ram` guess. No new fit math.

**Files:** `llm_runner/runner/gguf.py`, new `llm_runner/runner/gguf_remote.py`, touch-point into `fit.py` (inputs only).

## Phase 2 — Auto-derive catalog fields; the file is the source of truth
**Why:** kill the hand-typed drift. Two-phase, mirroring how `type` already works: **seed = pre-download guess; the header overwrites at add + download.**

- **`db.py` `ModelCatalog`** (`:70-90`): add `trained_ctx` (Integer, nullable = header `context_length`). Keep `mtp`/`type` (already columns, `:83`/`:87`). Drop+reseed (no migration).
- **`identity.py`** — extend `detect_and_store_model_type` (`:24-33`) → also set `mtp` (`nextn_predict_layers>0`) + `trained_ctx`. Add `store.set_derived(...)`. **In THIS phase 【panel T11】: fix the `identity.py:8-10` docstring** ("mtp NOT inferred / no signal" → now inferred from the header).
- **Hydrate on ADD (pre-download)** — the add-a-model flow (`LuModelCatalog.vue` `startAdd`/`saveModel`): a new `POST /v1/ai/model-catalog/inspect?repo=&quant=` calls Phase-1 `fetch_gguf_meta` → fills `type`/`mtp`/`trainedCtx`/params/real-size **before** download. `identify_fn` (wired `install.py:151-157`, called `lifecycle.py:438`) re-confirms from the local file at download.
- **Wire through** — `model_catalog_api.py` `CatalogRow` (`:34-49`): add `trainedCtx`. `stores.py` both directions (`_catalog_to_wire` `:342`, upsert `:372`).
- **`LuModelCatalog.vue` Edit form** (`:421-448`): file-derived fields (`type`, `mtp`, `trainedCtx`, params, quant) → **read-only "auto-detected from the model" + "revert to file"**; hand-editable = curation/policy only (name, repo/quant, `useLimited`, license). **In THIS phase 【panel T5】: fix the stale copy `:447`** ("Speculative decode (MTP) — not GGUF-detectable" → detected from the header). Reuse kit `UiCheckbox`/`UiInput`/`UiField` + the `.lu-mm-adv` disclosure.

**Files:** `db.py`, `identity.py`, `stores.py`, `model_catalog_api.py`, `LuModelCatalog.vue`; tests `tests/test_identity*.py`.

## Phase 3 — MTP: detect + default-OFF + measurable (fixes MoE+MTP)
**Why:** MTP is machine-dependent — offload +16% / full-GPU RTX 3090 *slower* (research `:89`); Metal net-loss at every config (web #23752/#23184, not in the doc cite). So detect the capability from the file (Phase 2), **never auto-enable**, surface it as a measurable switch. Removing the auto-apply also cleanly deletes the (intentional-but-superseded) MoE-skip.

- **`switch_resolve.py` `resolve_model_switches`** (`:47-54`): **drop the auto-`mtp` layer** — apply `base → type(moe|dense) → per-hardware` only. Kills the `mtp != "moe"` skip (`:53`) + honors default-OFF. **In THIS phase 【panel T11】: update the `switch_resolve.py:8-14` module docstring + the stale `install.py:143` `switches_fn` comment** (both still describe base→type→mtp→hardware).
- **Remove the now-orphaned `mtp` switch-preset** 【panel T3】: `seed.py:157-158` was the SOLE consumer of `applies_to="mtp"`; once resolve drops it, it's dead. Delete it. The **MTP profile values live once in `knob_catalog`** — the `spec_type` enum (`seed.py:260-262`, `none|draft-mtp|ngram-mod`, default `none`) + a `spec_n_max` knob (default `3`, add if absent). The opt-in reads those defaults → **one source, no hardcoded duplicate**.
- **Surface the switch** — in `ConfigColumn.vue` (Lab) + the Tune grid (`LuModelCatalog.vue`), when the model is **MTP-capable** (`mtp` flag), show the `spec_type` switch (hint: "this model supports MTP — measure it") default `none`; enabling writes `draft-mtp`+`spec_n_max` into the preset (rides `engine_presets` — no new storage/dispatch).
- **Tests** — `tests/test_switch_resolve.py`: MTP no longer auto-applied; a MoE model can carry `spec_type=draft-mtp` when set.

**Files:** `switch_resolve.py`, `seed.py`, `install.py` (comment), `ConfigColumn.vue`, `LuModelCatalog.vue`, `tests/test_switch_resolve.py`.

## Phase 4 — Per-hardware recommendation grid
**Why:** with live fit we can show, per hardware tier, which model serves each function — the per-job×per-tier matrix the research already built (`model-catalog-research-and-recommendations.md:71`, a research finding to seed the initial content, confirmed later by #28), now *live*.

- **Function mapping — one model 【panel T1】:** a shared seeded map `taskKind → function` (`chat` ← chat.grounded/chat.inVoice · `prose` ← prose.generate/prose.edit/ideation · `extract` ← extract.structured/summary.grounded/creative.structured · `analysis` ← judge.scored) **plus an explicit `other` bucket for any unmapped taskKind** (custom tasks / JV's future `attribution`) so nothing silently vanishes, **plus `embed`** (the RAG role). The grid's columns = the functions **present in the app's task catalog** (`/v1/ai/task-kinds`) mapped through this table + `other` + `embed` → genuinely per-app, no orphans. Map lives once in runner `seed.py`/config, not a component.
- **Hardware-tier bands — define them 【panel T1】:** seed a `DEFAULT_HARDWARE_TIERS` table `[(label, vram_mb, ram_mb)]` (the research columns: CPU-only·8+32·12·16·24·32·64GB-RAM·96GB-RAM·128GB). These are the grid ROWS; `coarse_fit(model, tier.vram, tier.ram)` per cell. The detected box is highlighted.
- **`embed` data source 【panel T5】:** seed **embedding recommendation rows** (nomic-embed under function-key `embed`) into `DEFAULT_RECOMMENDATIONS` — reuse the one `model_recommendations` table, not a parallel source.
- **Grid resolver (backend, NOT client 【panel A-note】)** — `GET /v1/ai/recommendation-grid` (new small router beside `recommendations_api.py`): for each function × tier, the `RecommendationRow`s (mapped taskKind) that **fit** (`coarse_fit`, real metadata), ranked; mark **quality** (best-that-fits) vs **faster** (a lighter one that also fits, computed). Recommendations keep `(modelId, taskKind, rank, why)` (`recommendations_api.py:36`) — no schema change; the grid is a *view* (one fit-truth; the client already consumes server `m.fit`, `LuModelCatalog.vue:106`).
- **Grid UI (kit)** — upgrade the **Recommendations** tab (`AiModelsArea.vue:233-234`): rows = tiers, columns = functions+embed, cell = model(s) that fit + quality/faster + **Download** + cited `why`. Keep `RecommendationsEditor.vue` reachable as the advanced raw editor. Reuse `UiTable`/kit + `request()`.
- **Chat default → best-that-fits** — update the chat recommendation ranking + `justwrite-app/server/justwrite_server/seed_presets.py:52-54` (`p_chat` off the 9B); the 9B becomes chat's "faster" cell.
- **"Quality vs faster" = display only** — two picks per cell; **NOT** a revived Fast/Balanced/Best dial (D3 stays dead). **Additive** — grid is the new discovery/download surface; the catalog stays for load/unload/tune; removing the flat-list overlap is a deferred follow-up (the grid's Download is a second entry point meanwhile — acceptable).

**Files:** new `recommendation_grid_api.py` + `DEFAULT_HARDWARE_TIERS` + the function-map (runner `seed.py`), embed rows in `DEFAULT_RECOMMENDATIONS`, new grid component in `ui/src/views/` (+ mount `AiModelsArea.vue`), `RecommendationsEditor.vue` (demote), JW `seed_presets.py`, tests.

## Phase 5 — Tune & measure → Tasks Lab handoff
**Why:** close the loop — tuned switches (incl. custom) shouldn't die in the measure modal. No active *feature* in the Tune context → hand off to a **task** (a task owns its preset — Plan A).

- **Shared handoff channel (kit)** — a module-level ref `labHandoff` (`ui/src/common/labHandoff.js`, matching the `dialog.js`/`toastBridge.js` singleton pattern): **`{ providerId, model, switches }`** — 【panel T1b】 includes `providerId` (the local llama.cpp provider) because a ConfigColumn pin is `{providerId, model}` (`ConfigColumn.vue:81-83`).
- **Tune modal (`LuModelCatalog.vue:459-499`)** — a **"Send to Tasks Lab"** action + make the `:472-474` "Measuring only…" note a **link** that (a) writes `{providerId, model, tuneRows}` (incl. custom rows) to `labHandoff`, (b) sets the AI tab to `tasks` (local ref `AiModelsArea.vue:33` — expose a shared `activeAiTab` setter). Copy ladder: model-level (here) → **Tasks** → "for per-feature fine-tuning, use Routing by feature".
- **Landing = a new Compare column under the first task (user's call), made robust 【panel T1b】.** `TaskKinds.vue:103` already auto-selects `tasks[0]`; it **imports** `FeatureLab` at `:17` but **mounts it guarded** at `:296` (`v-if="testPrompt"`, `:289` needs a member feature). Since switch-tuning + Save-as-preset **don't need a test prompt**, the handoff must render/seed a Compare column even when `tasks[0]` has no members (relax the guard for the handoff column, or show a tuning-only column with an "assign a member to test the prompt" hint). On a pending `labHandoff`, `FeatureLab`/`CompareStrip.addColumn(seed)` (`:40-42`) adds a column seeded with `{providerId, model, switches}` tagged **`switchesSource:'user'`** (the guard from `ConfigColumn.vue:120-143`) — **alongside** the task's preset column (compare, not clobber) → **Save as the task's preset** (existing path, `FeatureLab.vue:81`).
- **Reuse:** `switchesSource` guard, `CompareStrip` column model, `FeatureLab` Save-as-preset, the tab ref. `labHandoff` is a new tiny singleton (no existing channel to reuse).

**Files:** new `ui/src/common/labHandoff.js`, `LuModelCatalog.vue`, `AiModelsArea.vue`, `TaskKinds.vue`, `FeatureLab.vue`, `CompareStrip.vue`.

## Phase 6 — Docs + final verification
- **This plan is persisted here** (`just-llm-runner/docs/plans/2026-07-02-gguf-grounded-model-layer.md`); keep the LIVE STATUS current as phases ship; note in both `MORNING_RECAP.md`.
- **Doc cleanups:** fix `model-catalog-research-and-recommendations.md` `:66` "4 jobs" vs `:71` 5-row matrix (5th = **Attribution, JV**); add the honest note that the routing picks (chat=small, the matrix) were reviewer-panel + user call, **not measured** (#28), grounded going forward by Tune & measure; cross-check the `:71` matrix against `2026-06-28-MASTER-PLAN.md` (both research docs are bannered "historical background").
- *(Code-adjacent docstrings — `identity.py`, `switch_resolve.py`, `install.py` comment — are updated in Phases 2/3, not here 【panel T11】.)*

## Verification (JW only — no JV)
- **Runner:** `ruff check llm_runner/ tests/` + `python -m pytest` (new: gguf range-read parse, identity mtp/ctx detect, switch_resolve no-auto-mtp + MoE+MTP-can-set-spec, grid resolver + tier bands + function map incl. `other`/`embed`).
- **Live pre-download probe (in a test):** `fetch_gguf_meta` on a real MTP repo → header range-read yields `nextn_predict_layers`>0 (mtp) + `expert_count` (type) with zero weight bytes; HF API yields `context_length`/size.
- **Renderer:** `npm run build:vite`; boot `python -m justwrite_server.cli serve --port 17495` + `npm run dev:vite`; `node scripts/headless-smoke.mjs` = **0 JS errors**.
- **Playwright probes** (reuse `findChrome()`): Edit form shows `type`/`mtp`/`ctx` as auto/read-only; add-from-link hydrates; the grid renders per-tier w/ live fit + quality/faster + download + `embed`/`other` columns; MTP-capable model shows `spec_type` default-off; **Tune → link → Tasks → a new Compare column appears seeded (incl. a custom switch)** even when tasks[0] has no members.
- **Per-phase rules-checker** on each diff; commit per phase; push. Docs (Phase 6) ride the series.

## Decisions (settled with the user this round)
1. Everything live from the file; nothing estimated. Keep `fit.py`; the file feeds it (#29).
2. File = source of truth; hand-editable = curation/policy only.
3. **MTP: detect (range-read), default OFF, measurable** — remove auto-apply + the orphaned mtp preset; `spec_type` opt-in from knob defaults.
4. **Grid = per-app functions (mapped from the 9 tasks, `other`+`embed` buckets) × seeded hardware tiers**; routing stays 9; chat = best-that-fits; quality/faster = display; JV adds attribution via `other` later.
5. Additive: grid is the new discovery surface; catalog stays for load/unload/tune; flat-list removal deferred.
6. Tune→Tasks handoff lands as a new Compare column under `tasks[0]` (robust to empty members), `labHandoff={providerId,model,switches}` tagged `'user'`.

## Out of scope (flagged)
Item 6 — QuickSetup `/v1/ai/jobs`→taskKind (#100) · full UI unification (removing the flat catalog) · JV **attribution** task+recs · Decision 4 (switch-presets router removal) · **#28 measured benchmarks** (the grid *enables* measurement; it doesn't run the suite).

## Panel record (for the resume)
3 independent rules-checkers (Opus) reviewed this plan pre-build; all folded:
- **Reuse/convergence:** T3 PASS (no forks/duplication — one parser local+remote, fit.py kept+fed, recommendations store reused, switchesSource/CompareStrip reused). Its FAIL was the T2 HF/MTP grounding (folded) + soft notes (embed data source, T4 second-option) — folded.
- **Architecture-fit:** FAIL T1 (coarse-map contradiction + undefined hardware bands), T1 (tasks[0] guarded mount + missing providerId), T3 (orphaned mtp preset), T11 (docstring timing) — all folded. NOTES: backend grid-resolver is correct (don't compute client-side); labHandoff singleton sound; "additive" coherent.
- **Grounding:** citations "unusually accurate"; one FAIL = the HF/MTP overclaim (folded, re-verified live: HF API `gguf` block = context_length/architecture/total only, no nextn/expert). Watch-items folded: use our own `qwen3.6-35b-a3b-mtp` as the MoE+MTP proof (not GLM, whose seed row has mtp unset); attribute "Metal net-loss" to web (#23752), not research `:89`; reframe `switch_resolve.py:53` as intentional-but-superseded, not an accident.
