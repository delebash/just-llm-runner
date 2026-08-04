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
  behind `v-if="installed"`. Plan: `docs/plans/2026-07-05-model-surface-build.md`.
- **Phase-4 remainder — auto-composed model description [attributed:
  2026-07-05-model-surface-build.md]** — never built.
- **SVM P4 — resident-set + TTL UI [attributed: 2026-07-04-serving-vram-manager.md
  :11 "NEXT (needs a fresh go)"]** — plus its two pending on-box checks (P3 §3d
  end-to-end; P1g router-flag confirm).
- **T5 — real VRAM-load percentage [attributed:
  2026-07-17-load-cancel-and-one-progress-control.md:149 "NOT BUILT"]** — the load
  bar's model-load leg has no true progress source.
- **I2 — cloud prompt caching: research pass, then the user's build/skip call**
  [verified 2026-07-26: the Anthropic + Gemini adapters send no caching hints].
  Output = a recommendation with numbers. Ledger §I2. (Moved from JW's tracker.)
- **Big-batch tail triage [attributed]** — `docs/plans/2026-07-08-big-batch-queue.md`
  header claims batches 4–6 carry a standing go (§8) and "B2-9 NOT covered"; extract
  what is genuinely still open from the 510 KB doc, line-item it here, then banner
  the doc. Until then the doc is an implicit backlog nothing reads.
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
