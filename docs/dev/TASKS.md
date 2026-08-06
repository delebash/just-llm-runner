# TASKS — the live open-work tracker (just-llm-runner: kit + shared server)

> **THIS is the live tracker for the shared stack** — created 2026-08-04 by the docs
> campaign (`just_ai_i18n_docgen/docs/plans/2026-08-04-docs-cleanup-campaign.md`),
> per the family convention (`docs/app-structure.md` §13). One line per open item +
> a pointer to its detail doc. **Close = delete** — git and the plan docs keep
> history. **An item lives where the code that closes it lives** — kit/shared-server
> work HERE; app work in `../justwrite-app/docs/dev/TASKS.md` /
> `../JustVioce/docs/dev/TASKS.md`. A tracker line is a claim, not evidence.
> Items extracted from plan docs are marked **[verified]** (code-checked at
> extraction) or **[attributed]** (the plan doc's claim, not re-verified).

- **test_hardware.py::test_pci_gpus_linux_lspci_name_match fails with OSError
  on this box (2026-08-05 late), on clean HEAD too** — environmental (the
  Linux lspci path under Windows), not code; the same suite was green earlier
  the same night. Diagnose or mark it skip-on-windows.

## Found by the 2026-08-05 family audit [spot-verified by hand]

- **`GET /v1/ai/knob-catalog` silently strips `backends`** — stores serves it per
  knob row for "friendly KnobGrid metadata" (`stores.py:1449-1466`) but the wire
  model `KnobMeta` (`knob_catalog_api.py:23-32`) doesn't declare the field, so
  Pydantic drops it — the exact silently-dropped-field class this repo already
  documented at `model_catalog_api.py:140-148`; the UI can never gray out
  backend-inapplicable knobs. Its test asserts the stores dict, not the HTTP
  shape — which is why it stays green.
- **"llm/ must not import runner/" is violated five ways** (`seed.py:18`,
  `identity.py:21-22`, `reasoning.py:89-93`, `stores.py:831,1492`,
  `cache_api.py:25` — all module-level) while `dispatch.py:37-38` and
  `switch_resolve.py:48-50` still state the invariant; either fix the imports or
  fix the claim.
- **Promptless run-route test gaps (the 2026-08-04 change is SOUND; pin it):**
  `/v1/ai/stream` promptless parity untested; promptless + `jsonMode:true`
  (`_response_format(None,…)` → json_object) unpinned; `_effective_think(None,…)`
  unpinned; `RunRequest.history`/`_history_messages` has ZERO tests on either
  endpoint; the feature_key fallback's ledger/route side-effects unasserted.
  Wire limitation recorded: promptless can never get schema-enforced JSON
  (RunRequest carries jsonMode but no jsonSchema).
- **Adapter drift set:** ollama comment claims think-blocks are stripped, code
  returns content verbatim (`ollama.py:147-149`); the legacy `/api/embeddings`
  fallback posts OUTSIDE the try so transport errors escape the RuntimeError
  contract (`ollama.py:236-243`); `adapter_http_error` claims one D10 format
  while openai_compat + ollama hand-build the same strings in three places;
  anthropic's legacy budget enforces only the max_tokens half; openai_sdk's
  stream ignores `response.incomplete` (truncated stream ends silently with
  zero token counts, unlike the non-stream `finish="length"`).
- **Stale class-key format in five places** (README:23, db.py:401,425-427,
  class_tunes_api.py:8-9, switch_resolve.py:17, install.py:57-58) — the real
  format since 2026-07-22 is `dgpu-vram<V>|ram<R>` / `igpu-mem<M>` /
  `unified-mem<M>`; `parse_class_key` knows no `cpu|` form.
- **`tokenize` vs `measure` residency-authority split** — measure got the
  2026-07-21 router-authority fallback; tokenize still refuses on the stale
  internal ledger (`lifecycle.py:1327-1343` vs `:1287-1305`).
- **Docstring drift set:** RunRequest temp/think comments predate the preset
  tier; reasoningEffort vocabulary missing xhigh|max; schema.py points at a
  nonexistent `prompts._resolve_preset`; lifecycle names `start_runner` as the
  seam (it's `start_router`); `Overrides.reasoning_budget` still documents the
  retired launch flag; arbiter's `remaining_mb` cites the reverted §5c consumer;
  `reset_feature_ref`'s docstring contradicts its own inline ruling.
- **Promptless-mode retirement (kit half)** — rides docgen's
  template-convergence item (decided 2026-08-05 s2; the item lives in
  docgen's TASKS): FeatureLab's promptless machinery, the Workbench preview
  plumbing + zero-actions drop (FeatureWorkbench.vue:59-60), §11's
  two-kinds section rewritten to ONE kind; `dataLinks` KEPT. (The shared
  hard gate is DONE 2026-08-05 s3: render() was silent-empty and now FAILS
  LOUD — MissingTemplateVariables naming every key, both run routes → 400,
  union across system+user via _render_pair; five incomplete-variables
  tests fixed in runner+JW that the silence had been hiding.)
- **Half-built surfaces with no caller anywhere** (decisions, not deletions):
  the `/v1/ai/model-list-rules` editor trio; test-samples PUT/DELETE;
  switch-presets DELETE; preset-assignments/clear-features; the pre-router
  `Runner`/`start_runner` spawn API; `LoadRequest.job_id`; arbiter snapshot
  reservations nobody reads.
- **README staleness:** frames the family as two apps while docgen is the
  standard's reference implementation; the "not yet proven from a non-JustWrite
  host" caveat is stale (docgen booted the stack live 2026-08-02/03);
  app-structure §11's FeatureWorkbench line number drifted (235→238).

## Now / near-term

- **Engine-cache `replaceBuild` deletion guard [verified live 2026-08-03/04]** — with
  a SHARED family cache, the update path's build-folder cleanup would delete builds
  under ANOTHER app's directory; guard deletion to the app's OWN cache root.
- **Silent update-check failure [verified]** — a failed GitHub check on AI-page mount
  is swallowed (no error state, unauthenticated call every mount); surface it (kit).
- **Set-as-default embeddings note shows in no-embeddings apps [verified]** —
  gate the "Search embeddings keep their current provider…" note
  (`ui/src/views/AiModelsArea.vue:573`) on `llmUiCapabilities().embeddings`.
- **Class-tune seed noise [verified live]** — shared seed ships JW class tunes into
  apps that suppressed the JW catalog ("class tunes for 'gemma-4-12b-qat' match no
  model" on every docgen boot); gate default class-tune seeding on the catalog
  actually containing the model.
- **Phase 5 — residency knobs BEFORE engine install [verified]** —
  `ui/src/components/LuRunnerEngine.vue:275` still gates `modelsMax`/idle-sleep
  behind `v-if="installed"`. Plan: `docs/plans/archive/2026-07-05-model-surface-build.md`.
- **Phase-4 remainder — auto-composed model description [attributed:
  2026-07-05-model-surface-build.md]** — never built.
- **SVM remainder — CORRECTED (docs campaign): P4 is NOT open.** The design doc's
  header ("P4 NEXT, needs a fresh go") was stale — the implementation doc records
  **4a SHIPPED + VERIFIED** and **4b CLOSED-DROPPED** ("not deferred"). What
  genuinely remains: the two on-box checks (P3 §3d end-to-end · P1g router-flag
  confirm). Design distilled: `docs/dev/serving-design.md`.
- **Multi-click unload/reload — observe once, REPORT BACK, don't fix blind** (the
  load-cancel plan's own Q3 ruling): one timestamped observation decides between
  (a) the router lock, (b) UI refresh racing the poller, (c) idle-sleep timing.
- **`DEFAULT_MODEL_CLASS_PICKS` points at `qwen3.6-35b-a3b-mtp` — a model no longer
  in `DEFAULT_CATALOG`** [verified], and its refill source (ledger C9) is
  user-ruled NOT DOING. Decide: retire the seed row or repoint it.
- **Stopping a host server can ORPHAN its router child on Windows** (holds :8080;
  the on-box A/B incident) — candidate fix: Job-Object/process-group teardown in
  the spawn path.
- **T5 — real VRAM-load percentage [attributed:
  2026-07-17-load-cancel-and-one-progress-control.md:149 "NOT BUILT"]** — the load
  bar's model-load leg has no true progress source.
- **I2 — cloud prompt caching: research pass, then the user's build/skip call**
  [verified 2026-07-26: the Anthropic + Gemini adapters send no caching hints].
  Output = a recommendation with numbers. Ledger §I2. (Moved from JW's tracker.)
- **Big-batch triage DONE (docs campaign 2026-08-04)** — the 510 KB doc's header
  was stale: B2-9, DL-2, B5-4, the QC clusters and E2 all shipped per its own build
  records; batches 4-6 have nothing open. The genuinely-live extractions became
  lines here and in JW's tracker (§7.1 sub-questions, I1 follow-ups, the doorway
  label, the box checks); the doc is banner'd + archived.
- **llama.cpp adoption review is stale** — `docs/llama-cpp-watch.md` last reviewed
  2026-07-14 (b9993); the CUDA Q2_0 watch item (#25707) has never been re-checked.
  Trigger phrase: "check llama.cpp since our last update".
- **Known-bad test tracked nowhere until now [verified]** —
  `tests/test_hardware.py::test_pci_gpus_linux_lspci_name_match` fails on Windows
  (Linux `lspci` path). Mark it `skipif` non-Linux or accept the standing "one
  failure is expected" note (CLAUDE.md records it; a real skip is cleaner).

## Box-gated / parked (wakes on a trigger)

- **CPU-only band box test** — `docs/plans/2026-07-19-cpu-only-band-test.md` is a
  RECIPE with an empty results table; needs the 2070S/32 GB box. A band product
  decision is blocked behind it.
- **Upstream WATCH: `--fit` silently kills Gemma-4 MTP drafts** (llama.cpp #24350;
  `--fit off` is the verified cure; our fit-by-omission placement walks into it) —
  re-test on a build newer than b10107. (Moved from JW's tracker.)
- **Model watchlist:** Harrier-27B (MIT, no GGUF yet) · KaLM-Gemma3-12B embed trial
  when the 32 GB card arrives. (Moved from JW's tracker; Ternary Bonsai lives in
  IDEAS with its trigger.)
- **D5 — remote curated model catalog** — PARKED by the user's word, shape recorded
  (ledger §D5). · **D6 — in-app HF "Discover" surface** (ledger §D6). ·
  **I3 — Apple-Silicon fit/tune refinements** (needs a Mac; ledger §I3).
- **LICENCE flag** — Gemma-ToU propagation matters only if weights are ever BUNDLED;
  the user's call then. · **Provider SDK pivot re-opens only if funded keys appear**
  (OpenAI/xAI/Mistral ship wired, live-unverified — "close 3 i dont have keys").
