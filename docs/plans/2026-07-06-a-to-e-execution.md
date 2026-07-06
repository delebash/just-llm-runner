# A–E execution batch — the ledger's open build/research items, JustVoice excluded (2026-07-06)

> **MANDATE (user, 2026-07-06): "do a-e do not do just voice go".** This doc is the LIVE tracker for executing
> every open item in sections A, B, C, and E of the twice-verified outstanding master plan
> (`2026-07-06-outstanding-master-plan.md`). Section D is already empty (D1 + D3 decided 2026-07-06, D2 refuted
> earlier); section F (JustVoice) is EXCLUDED by the user's instruction — no JustVoice repo edits in this batch;
> where an item's scope would naturally touch JV (C3 queue adoption, C4 audit findings inside JV), the JV half is
> RECORDED under F1's umbrella and not built. Section G is the user's own box checklist — untouchable from the
> container by nature.
>
> **Method per item (the standing discipline):** ground in code line-by-line + web for any upstream fact → write
> the item's design into this doc BEFORE implementing → implement → verify by running (ruff + pytest; build:vite +
> headless smoke + probes for renderer work) → independent rules-checker on the diff → commit + push immediately →
> update this tracker + the master-plan ledger line. Every item = its own commit(s); nothing rides along
> uncommitted.
>
> **Execution order (quick wins first, then the engine block, then the bigger shared-stack items):**
> B1 → B2 → E1 → A2 → A1 → A3 → A4 → C1 → E2 → C3 → C4 → C2 → E3.
> Rationale: B1/B2/E1 are tiny and clear fast with early pushes; A2 is the small engine item and warms the
> hardware/binary code paths for A1/A3/A4; C1 has a prior plan to honor (#77 "plan ready"); E2 (vitest) lands
> before C3 so new kit/JW logic can get unit coverage; C4 (the audit) runs AFTER the build items so it audits the
> end state, not a moving target; C2 (research) is bounded last among the C's; E3 is the out-of-AI-scope footnote
> and closes the batch.
>
> **Baseline at batch start:** runner `dbca11d` · JW `39449ee` · JV `453462c` (untouched hereafter), all equal to
> origin, working trees clean. Runner gate green at baseline: `ruff check llm_runner/ tests/` clean + `python -m
> pytest` **324 passed**. Environments verified live: `llm_runner` and `justwrite_server` both importable, JW
> `node_modules` present.

---

## Batch interruption record (2026-07-06) — stopped, then RESUMED (cross-session confusion, not a real stop)

Mid-batch the user typed "stop" and then "this is an old session dont code anything" — work halted
immediately after B1 + B2 were implemented and fully verified, with NOTHING committed or pushed. The
user then clarified from Claude Desktop: *"sorry i was using claude desktop and i guess the session was
not in sync with this one, please continue."* A fresh fetch confirmed origin had NOT moved on any repo
(no competing session had pushed), so the batch RESUMED here: B1 + B2 commit as verified, then the
execution order continues from E1. Recorded so the stop/resume in the session log reads correctly.

## LIVE PROGRESS

- **B1 — engine knobs visible before install: ✅ SHIPPED + VERIFIED (2026-07-06).** Design: the
  `v-if="installed"` at `ui/src/components/LuRunnerEngine.vue:173` gated BOTH halves of the resident
  block; the correct split is by NATURE of the content — the two knobs (`modelsMax`,
  `sleepIdleSeconds`) are PERSISTED CONFIG (engine-config PUT, valid before any install; seeding
  verified safe pre-install because `GET /v1/llm-runner/resident` works router-down and always returns
  the knob values — `runner/api.py:204-215`), while the "Loaded models" list + VRAM budget line are
  RUNTIME state that is meaningless without an installed engine. So the outer div now always renders;
  a `<template v-if="installed">` wraps ONLY the head + list/empty half; the knobs + Save + error line
  sit below it unconditionally. The installed-state layout is pixel-identical to the user-approved 4a
  look (no header/copy changes); the not-installed state gains exactly the two self-captioned knobs
  under the existing divider. Verified: `npm run build:vite` clean · full headless smoke PASSED (zero
  JS errors) · `justwrite-app/scripts/resident-panel-probe.mjs` EXTENDED with a second scenario
  (engine/status mocked `installed:false` → asserts the runtime half is hidden, the knobs render and
  seed 3/300 from /resident, and Save still PUTs ONLY `{modelsMax, sleepIdleSeconds}`) — 13/13 checks
  PASS. The probe also gained the same BENIGN console filter the sibling probes already use (the
  container proxy resets the external Google-Fonts fetch; that console error is environmental, not an
  app error — the sibling precedent is `catalog-type-probe.mjs` + `headless-smoke.mjs`).
- **B2 — auto-composed model description at Add time: ✅ SHIPPED + VERIFIED (2026-07-06).** Design: at
  the end of a successful `inspectLink()` in `ui/src/components/LuModelCatalog.vue`, a new
  `composedDescription()` builds the plain-language description in the field's OWN placeholder
  register ("fast 9B for quick chat and drafts" → short " · "-joined facts): params (`e.totalParams`,
  else the MoE `sizeLabel` like "128x2.6B") + kind (embedding model / mixture-of-experts model /
  model) + `<n>k context` from `trainedCtx` + "MTP draft for faster generation" when `mtp OR
  mtpDraftFile` (the same OR-gate as the resolver) + the quant with a "(QAT)" suffix and the file size
  taken from the LISTING's matching quant row. It writes ONLY into an EMPTY field (`!e.description?.
  trim()`) — a hand-typed or previously saved description is never clobbered and the field stays fully
  editable. Verified LIVE against the user's real repo (`unsloth/gemma-4-26B-A4B-it-qat-GGUF`):
  `catalog-type-probe.mjs` extended with checks (e)+(f) — the composed value was exactly
  "128x2.6B mixture-of-experts model · 256k context · MTP draft for faster generation · UD-Q4_K_XL
  (QAT) · 13 GB", and a pre-filled "MY OWN WORDS" survived a full re-read untouched. Probe PASS, zero
  page errors. (Probe-timing note, so it isn't re-learned: the quant/draft checks land with the fast
  LISTING call, but the description lands with the slower header INSPECT — the probe must wait for the
  Read-from-link button to re-enable (`UiButton` `loading` sets `disabled`, `UiButton.vue:37`) before
  reading the field.)
- **E1 — three stale `OpenAICompatClient` comments: ✅ SHIPPED + VERIFIED (2026-07-06).** Precision
  correction found while grounding (the ledger's E1 was slightly imprecise): a repo-wide grep shows only
  TWO files actually name `OpenAICompatClient` (`components/ModelPicker.vue:7`, `services/modelMeta.js:2`);
  the third (`services/embedApi.js:2`) instead referenced the retired gateway ROUTE ("the runner-stack
  replacement for the old /v1/llm/{id}/embeddings proxy") — historical, not a class reference. All three
  were cleaned: ModelPicker's comment now describes the REAL current source (the shared per-provider cache
  `composables/useModelList.js` → the shared `/v1/llm-providers/{id}/models` endpoint returning plain ids,
  with quant badges parsed from the id by `modelMeta.parseQuant`); modelMeta's comment now names its REAL
  current consumers (ModelPicker via parseQuant/entryLabel + the ai store via getModelTier/TIERS — the old
  "Speaker Lab's ModelPicker and Settings → AI providers' Combobox" phrasing was doubly stale, verified by
  grep: no Speaker Lab, no Combobox importer); embedApi's comment simply drops the dead-route aside.
  Comment-only diff (attested trivial); verified `npm run build:vite` clean.
- **A2 — Intel Arc → Vulkan routing:** NOT STARTED.
- **A1 — AMD + Intel VRAM detection:** NOT STARTED.
- **A3 — spawn-time backend retry chain:** NOT STARTED.
- **A4 — Linux CUDA engine install (docker route):** NOT STARTED.
- **C1 — json_schema / GBNF structured output:** NOT STARTED.
- **E2 — vitest harness:** NOT STARTED.
- **C3 — shared AI task queue → kit:** NOT STARTED.
- **C4 — everything-LLM-shared audit:** NOT STARTED.
- **C2 — measured/benchmark re-grounding research:** NOT STARTED.
- **E3 — ODT import: lists:** NOT STARTED.

Per-item design + evidence + verification is appended below as each item starts; the master-plan ledger line is
updated as each item ships.
