# Speaker / quote attribution as an LLM feature — research + recommendation (2026-06-27)

Shared LLM stack. Drives JustVoice's `speaker_attribution` (audiobook casting:
line → character) — the hard case of the **extraction** job. Output of the
`/deep-research` harness (run `wf_b071ff63`, 101 agents · 19 sources · 94 claims
→ **25 verified, 25 confirmed / 0 killed**). Sources cited per finding;
peer-reviewed where possible. Full evidence: `/tmp` run output (ephemeral) — the
load-bearing findings are captured here (per the save-detail rule).

## TL;DR — recommended approach
**LLM-first, zero-shot Chain-of-Thought, with the whole-chunk recipe + an upstream
character-roster step, sized to a capable model (≥ ~24–32B-class local — our
**Qwen3.6-35B-A3B** qualifies — or a cloud frontier model for hard/unseen text).**
A **hybrid** (BookNLP/BookNLP2 proposes quote spans + candidate speakers → the LLM
resolves the implicit/anaphoric cases) is a sound **cost-saver** since explicit
"said Mary" is already ~98%-solved cheaply; but no head-to-head benchmark of that
exact hybrid was found, so adopt LLM-first now and treat hybrid as an optimization.

## Why our 8B did poorly (the core finding, verified)
- **A zero-shot CoT LLM is the current SOTA** for English literary quote attribution — beats the prior dedicated-pipeline SOTA (BookNLP+) by **~12 pts on PDNC1, ~9 on PDNC2** (NAACL 2025, Michel et al., arXiv:2406.11380; code at github.com/deezer/llms_quotation_attribution).
- **The entire gain is on NON-EXPLICIT (implicit/anaphoric) quotes** — explicit "said X" is near-solved by old pipelines (BookNLP+ 98.6% explicit) but only ~69% non-explicit; the LLM reaches ~89% non-explicit. Non-explicit **dominates** the data (~66% of PDNC). So implicit attribution is the differentiating hard case — exactly where a small 8B falls down.
- **Model SIZE matters for UNSEEN manuscripts:** on a post-cutoff novel (memorization ruled out), an 8B only *matched* BookNLP+ (97.9 vs 98.5); scaling to **70B** hit near-perfect (~99.8%, 3 errors / 1442 quotes). → Our 8B failures are consistent with the literature; **use the largest capable model you can fit** (the 35B-A3B MoE, or cloud for the hardest).
- **Coreference is the dominant bottleneck** — with off-the-shelf neural coref, ~90% of mention clusters can't be resolved to a named character; ~48% of BookNLP quotes get an un-nameable speaker. The hard work is pronoun/epithet → canonical character.

## THE PROMPTING RECIPE (the highest-impact lever — verified verbatim from the paper)
This recipe drove the +9–12 pt gains; implement it in the `speaker_attribution` feature:
1. **Character-to-alias roster up front** — build a `{canonical → [aliases/epithets]}` list and put it in the prompt. *(The paper used a GOLD list; on a fresh manuscript we must add an **upstream character-discovery step** first — see caveats.)*
2. **Chunk** each chapter at **~4096 tokens with a 1024-token stride** (overlap).
3. **Number every quote 1..n** in the chunk.
4. **Attribute the WHOLE chunk in ONE CoT pass** — reason over all quotes sequentially, then **output JSON keyed by quote id** (`{ "1": "Mary", "2": "Tom", ... }`). Whole-chunk beats one-quote-at-a-time.
5. **Incremental (optional, small bump):** feed prior overlapping-chunk predictions back as context so the model can refine (+~1 pt).

Note this is a **reason-then-emit** flow: CoT (thinking) for the reasoning, then the JSON. Pairs with our "extraction = thinking for reasoning, JSON emit" pattern; keep the schema flat.

## Models (per tier — LOW confidence, extrapolated)
No source gave a per-VRAM-tier attribution leaderboard. The evidence supports a **size/reasoning trend**, not specific per-tier picks. So: **use the largest capable model that fits** (matrix's attribution row): floor → 35B-A3B+RAM (think-on reason → JSON); 16–24 GB → Mistral-3.2-24B or 35B-A3B; high-RAM → GLM-4.5-Air / Qwen3-235B; **cloud frontier for the hardest unseen manuscripts**. Validate on real text in the lab (the per-tier pick is an extrapolation, not benchmarked).

## Dedicated pipelines (for the hybrid option)
- **BookNLP** (Bamman lab, UC Berkeley; github.com/booknlp/booknlp) natively does NER + character-name clustering (Tom/Mr. Sawyer → TOM_SAWYER) + coreference + quote-speaker ID; reports B3 speaker-attribution 86.4 (small) / 89.9 (big) in-domain. **BUT end-to-end it's weak on PDNC (~0.40–0.42 accuracy)** — strong on explicit, weak on implicit. Real + open. (BookNLP2 = the newer iteration; confirm license/backbone when we do the JV audiobook research.)
- **SIG** (AAAI 2024, BART backbone) — a fine-tuned *small* generative model matches zero-shot ChatGPT and beats BookNLP — proof a specialized small method can rival a general LLM (a cheaper hybrid building block).

## Benchmarks / datasets (all confirmed real)
**PDNC** (Project Dialogism Novel Corpus, LREC 2022) — the canonical, largest fiction quote-attribution corpus (~36k quotes/22 novels → ~37k/28 in PDNC2), each quote annotated with speaker + addressee + mentions. **LitBank** — has a quotation-attribution layer linked to coref clusters. **RiQuA** — annotation-only corpus (no model benchmark).

## Caveats (bear on the build)
1. **Character discovery is required.** Published numbers used a gold alias list (an upper bound). A fresh manuscript needs an upstream step to discover characters + aliases before attribution (BookNLP's clustering, or an LLM pass).
2. **Cost:** the LLM approach is ~**1 GPU-hour/novel** vs minutes for a pipeline — hence the hybrid (cheap explicit via pipeline; LLM only on implicit).
3. **Per-tier model picks are extrapolated** — validate in the lab.

## Build implications for `speaker_attribution`
- Route to a **capable model** (35B-A3B+RAM local, or cloud) — not an 8B.
- Implement the **whole-chunk numbered-quote CoT → JSON** recipe + a **character-roster** step (discovery → roster → attribute).
- Keep the JSON **flat**; reason with CoT then emit (thinking-for-reasoning, structured emit).
- The deeper audiobook-pipeline/BookNLP2 evaluation is the separate JV task (`JustVoice/docs/plans/2026-06-27-audiobook-tools-research-todo.md`).

## Sources
arXiv:2406.11380 + aclanthology 2025.naacl-short.62 (LLM CoT SOTA) · arXiv:2307.03734 (PDNC coref bottleneck, BookNLP weakness, ACL 2023) · AAAI 2024 / arXiv:2312.14590 (SIG) · aclanthology 2022.lrec-1.628 (PDNC) · github.com/dbamman/litbank · github.com/booknlp/booknlp · aclanthology 2020.lrec-1.104 (RiQuA).
