# Model catalog research + recommendations (2026-06-27)

Shared LLM stack (JW + JV). Decides which local GGUF models to seed into
`DEFAULT_CATALOG` / `DEFAULT_RECOMMENDATIONS` (`just-llm-runner/llm_runner/llm/seed.py`)
and how to route each job, across **8–32 GB VRAM** tiers. Extends the 2026-06-24
research (`local-model-recommendations.md`, `small-vram-multimodel-research.md`).

> **NOTHING IS BUILT YET.** This is the research + recommendation for review. Per
> the user (2026-06-27): finalize the plan from this before any `seed.py` edit.

## How this was produced (provenance + honesty)
- **Deep-research run** `wf_7fbb7f99` (104 agents · 22 sources · 107 claims → 25
  adversarially verified → **17 confirmed / 8 killed**). The harness's final
  *synthesis* step stubbed to placeholder output (a bug); the real findings were
  recovered from the saved agent transcripts → `scratchpad/research_evidence.md`
  (17 confirmed / 8 killed / 82 unverified / 22 sources).
- **3-reviewer consensus panel** (independent Opus agents, distinct lenses):
  (A) hardware-fit realist, (B) per-job benchmark grounding, (C) family/license/risk.
  All three reasoned from the same evidence file; this doc is their reconciled
  consensus, with the one disagreement (GLM) resolved.
- A second deep-research run on **speaker attribution** was still running at write
  time; its deeper output is deferred to the JV audiobook research
  (`JustVoice/docs/plans/2026-06-27-audiobook-tools-research-todo.md`). Attribution
  here is covered as the hard case of the *extraction* job.
- **Confidence discipline:** every quant size / tok-s figure needs a confirm at
  implementation time (several primary HF pages 403'd the fetcher; some numbers are
  search-snippet paraphrase). The CONFIRMED claims + the 4 anchor repos below are
  high-confidence.

---

## TL;DR — the consensus recommendation
**Final catalog = 6 rows: keep 4 Qwen anchors + add 2 non-Qwen families. Net change
is 2 adds + 2 drops (not a rewrite).** Qwen stays the backbone — it genuinely wins
chat (9B latency), the MoE-offload trick, and analysis-at-tier; the two adds each
buy something Qwen can't at our tiers, both **Apache-2.0** (GPL-3.0-ship-safe).

- **ADD `mistral-small-3.2-24b`** — a *dense, no-thinking-mode* instruct model for **strict-JSON extraction / speaker attribution**. Sidesteps the confirmed llama.cpp "JSON-schema breaks when thinking is on" bug that hits exactly our MoE Qwen. (16 GB tier.)
- **ADD `gemma-4-12b`** — a **second family at the 8–12 GB tier** so a user whose text Qwen handles poorly has a real alternative. (Gemma **4** only — see the license trap.)
- **DROP `qwen3.5-9b-q4_k_s`** and **`qwen3-14b-q3_k_m`** — redundant second quants of models already in the catalog (operator-knob noise, not diversity; Q3 is also the wrong quant for tool-calling JSON).
- **FIX** the `qwen3.6-35b-a3b` MoE row: `min_ram_mb` 24000 → **32000** (RAM is the real gate; 24 GB is a hard floor, 32 GB is the working spec) and stop advertising it as a 6 GB-VRAM throughput hero (that figure was **killed**; the measured data is a 12 GB 3060).
- **PROSE ROUTES TO CLOUD.** The best *local* prose model at our tiers tops out ~59 on EQ-Bench Longform vs **78–83 for Claude/GPT**; the best open prose model (Qwen3-235B) needs ~132–180 GB and doesn't fit. Be honest in the UI: local prose is draft-grade; Claude is the quality pick.
- **REJECT** Llama 4, GLM, DeepSeek, Kimi, Qwen3-235B (no fit / unconfirmed repo / worse license), and **any Gemma ≤ 3** (license trap).

---

## Per-job × per-tier routing matrix (consensus)
Bold = primary pick. "+RAM" = MoE, gated by **system RAM** (≥32 GB recommended), not VRAM. Extraction/attribution rows assume **thinking-OFF** when enforcing a JSON schema.

| Job | 8 GB (MIN) | 12 GB | 16 GB | 24 GB | 32 GB | Cloud |
|---|---|---|---|---|---|---|
| **Chat** (fast, grounded) | **Qwen3.5-9B Q4_K_M** (54–58 t/s) | Qwen3.5-9B / Gemma-4-12B | Qwen3-14B | Qwen3.6-27B (overkill) | Qwen3.6-27B | not needed |
| **Prose** (quality) | drafts only | Qwen3-14B (~draft) | Mistral/Qwen3-14B | Qwen3.6-27B (local ceiling) | Qwen3.6-27B | **★ Claude — the quality pick** |
| **Extraction** (JSON) | Qwen3.5-9B (flat schemas) | Qwen3-14B / 35B-A3B+RAM | **Mistral-Small-3.2** (dense, no-thinking) | Mistral / 35B-A3B (think-off) | 35B-A3B | cloud for deep nesting |
| **Attribution** (reason+JSON) | *8B fails — route up/cloud* | 35B-A3B+RAM (2-pass) | **Mistral / 35B-A3B** (think→emit) | 35B-A3B / 27B | 35B-A3B | ★ cloud for hard multi-speaker |
| **Analysis** (reasoning) | Qwen3.5-9B | **35B-A3B+RAM** (think-on) | 35B-A3B | **Qwen3.6-27B** | Qwen3.6-27B | cloud for >50 K-tok coherence |

Notes: attribution at 8 GB is intentionally "no" — the user's own data is that dense 8B does poorly; the honest floor for *usable* attribution is 14 B+ (24 GB for quality). MTP variants are a **speed** knob (~1.4–2.2× dense, ~1.15–1.25× MoE, no accuracy change), never a quality differentiator.

---

## Proposed `DEFAULT_CATALOG` (6 rows)
All Apache-2.0. Sizes are conservative; verify at implementation.

| id | HF GGUF repo | quant | total/active | ctx | VRAM / RAM | tier | best job(s) | conf |
|---|---|---|---|---|---|---|---|---|
| `qwen3.5-9b-q4_k_m` | `unsloth/Qwen3.5-9B-GGUF` | Q4_K_M | 9B dense | 256K | ~7 / 8 GB | mid | chat (8 GB), analysis floor | High |
| `gemma-4-12b-q4_k_m` *(NEW)* | `unsloth/gemma-4-12b-it-GGUF` | Q4_K_M | 12B dense | 256K | ~7 / 10 GB | mid | chat/analysis, 2nd family | Med — **verify repo 200** |
| `qwen3-14b-q4_k_m` | `unsloth/Qwen3-14B-GGUF` | Q4_K_M | 14B dense | 128K | ~10 / 12 GB | mid | analysis, extraction | High |
| `mistral-small-3.2-24b-q4_k_m` *(NEW)* | `unsloth/Mistral-Small-3.2-24B-Instruct-2506-GGUF` | Q4_K_M | 23.6B dense | 128K | ~14 / 16 GB | high | **extraction / attribution** | High |
| `qwen3.6-27b-mtp-q4_k_m` | `unsloth/Qwen3.6-27B-MTP-GGUF` | Q4_K_M | 27B dense (MTP) | 256K | ~18 / 20 GB | high | analysis (top dense) | High |
| `qwen3.6-35b-a3b-mtp` | `unsloth/Qwen3.6-35B-A3B-MTP-GGUF` | UD-Q4_K_XL | 35B / ~3.6B (MoE, MTP) | 256K | ~7 GB GPU (offload) / **32 GB RAM** | low-vram-moe | analysis + extraction (think-off) | High |

**Dropped:** `qwen3.5-9b-q4_k_s`, `qwen3-14b-q3_k_m` (redundant quants).
**Changed:** `qwen3.6-35b-a3b` `min_ram_mb` 24000 → 32000.

### Proposed `DEFAULT_RECOMMENDATIONS` additions
- `mistral-small-3.2-24b-q4_k_m` → **extraction** rank ~5: *"Dense 24B, robust function-calling template (84.78% instruction-following); no thinking mode, so it sidesteps the llama.cpp JSON-schema-vs-thinking bug — the safe strict-JSON pick at 16 GB."*
- `gemma-4-12b-q4_k_m` → **chat** rank ~15 (*"2nd family at the 8 GB tier; Apache-2.0"*) and **analysis** rank ~25.
- Reword existing rows that overstate the 35B-A3B as a "6 GB" pick → "runs on a small GPU via CPU expert offload, needs ~32 GB RAM."

---

## Key decisions + WHY (with the reconciliation)
1. **Add exactly two families, not more (all three reviewers).** The "smallest justified catalog" wins: Mistral (extraction/no-thinking) and Gemma 4 (8 GB 2nd family) each cover a real gap; everything else duplicates a Qwen point or fails a gate.
2. **GLM-4.5-Air — the one disagreement, resolved as REJECT (for now).** Reviewer B wanted it (it's the BFCL function-calling *leader*, ~76–78%). Reviewers A + C rejected it: **no GLM GGUF repo was confirmed** in any of the 22 sources (availability gate), it's a large MoE that would **duplicate the 35B-A3B RAM-offload slot**, and the win over Qwen3-32B is ~2 pts (not a capability class). → Don't seed an unconfirmed repo. **Re-research GLM repo-first** if we later want a third extraction option.
3. **Mistral is justified on the model card, NOT on a BFCL ranking.** B correctly flagged that "Mistral Small = best JSON" is **not** board-supported (and the BFCL-V4 ranking claim was *killed*). C kept it anyway because its *confirmed* strengths — instruction-following, function-call template, halved repetition, and crucially **no thinking mode** — make it the safe dense JSON pick given the llama.cpp bug. We seed it with the honest justification.
4. **Prose is a cloud job at our tiers.** Local ceiling ~59 (24 GB-only) vs cloud 78–83; the best open prose model doesn't fit. Don't chase a local prose model that doesn't exist — route prose to the Claude/OpenAI/Gemini providers already seeded.
5. **Keep all 4 Qwen anchors; cut only the 2 redundant quant rows.** No family replacement is warranted — "don't change for its own sake" holds.

---

## Critical caveats / traps (carry into implementation)
1. **GEMMA LICENSE TRAP (highest-value finding).** Gemma **≤ 3** ships under the "Gemma Terms of Use" (prohibited-use policy + downstream flow-down + Google's unilateral remote-restriction right) — **NOT Apache, NOT GPL-3.0-compatible for bundling.** Only **Gemma 4** is Apache-2.0 (a deliberate 2026 relicense). The evidence file scores `gemma-3-27b-it` on prose — a naive pick would poison our GPL ship. **Never seed any Gemma ≤ 3.**
2. **JSON-schema vs thinking (confirmed llama.cpp bug).** Grammar/JSON-schema enforcement is inactive when `enable_thinking:true`, reproduced on **Qwen3.5-35B-A3B** — exactly the MoE we route extraction to. → Seed the MoE/extraction switch presets to force **thinking-off for the extraction job**; for attribution that needs reasoning, do **two passes** (reason think-on → emit JSON think-off). This is *the* functional reason Mistral (no thinking mode) is valuable.
3. **Schema-complexity collapse (confirmed).** Deep/recursive schemas break *every* constrained-decoding engine (llama.cpp → 39% on hard nesting). → Author **flat/shallow** extraction + attribution schemas; don't trust the engine on deep nesting.
4. **MoE is RAM-gated, not VRAM-gated.** The 35B-A3B needs ~32 GB system RAM (experts live in RAM); an 8 GB-GPU/16 GB-RAM machine *cannot* run it (spills to SSD). Fit-filtering must gate MoE on RAM first; the tier label must surface the RAM precondition.
5. **`-ncmoe` only helps MoE, not dense.** There is no dense middle option at 8 GB — the 8 GB story is binary: Qwen3.5-9B dense (safe) OR 35B-A3B MoE (only with big RAM).
6. **Verify-before-seed.** `unsloth/gemma-4-12b-it-GGUF` was corroborated (HF tree/discussions/collection) but the page 403'd the fetcher — confirm HTTP 200 before seeding; fallback `unsloth/gemma-4-12B-it-qat-GGUF`. For the 9B, confirm Unsloth-vs-bartowski quant quality + pull the **text-only** GGUF (avoid vision-encoder VRAM bloat).

## Rejected candidates (the adversarial cut)
| Candidate | Why rejected |
|---|---|
| Llama-4-Scout (109B/17B MoE) | Q4 ~55 GB; smallest dynamic ~33 GB needs 24 GB VRAM + huge RAM — no tier fits; Llama Community License (not OSI/GPL-safe); worse than the 35B-A3B already seeded. |
| Llama-4-Maverick (400B), DeepSeek V3/V4 (671B), Kimi-K2 (~1T) | Datacenter-only; no desktop GGUF at our tiers. DeepSeek V4 repo unconfirmed. |
| Qwen3-235B-A22B | Best *open* prose (~80) but ~132–180 GB — killed as unfittable. Prose = cloud. |
| GLM-4.5 / GLM-4.5-Air | Best BFCL extraction, but **no confirmed GGUF repo** + large-MoE near-duplicate of the 35B-A3B slot. Re-research repo-first later. |
| Gemma 4 26B-A4B MoE | "Could not be confirmed as a real GGUF build" — unconfirmed-repo trap. |
| Gemma ≤ 3 (any) | License trap (see caveat 1). |
| Qwen3.5-27B (prose), Qwen3-32B (extraction), Phi-4 14B (analysis) | Considered; not added — prose=cloud, and the extraction/analysis slots are covered by Mistral + 35B-A3B + 27B without near-duplicate Qwen rows. Qwen3-32B is the first candidate if we want a stronger 24 GB extraction Qwen later. |

## Open questions / verify at implementation
1. Confirm `unsloth/gemma-4-12b-it-GGUF` resolves (HTTP 200); else use the QAT sibling.
2. 35B-A3B real throughput at 8 GB (vs the measured 12 GB 3060 ~33–36 t/s) — the 8 GB figure is extrapolated.
3. Does the CPU-offloaded MoE actually match a dense model on **attribution quality** (not just throughput)? Open since the 2026-06-24 run.
4. Qwen3.5-9B: Unsloth vs bartowski quant quality + text-only build.
5. GLM GGUF availability (for a future extraction option).

## Sources (22, from the run)
EQ-Bench Creative Writing v3 + Longform (eqbench.com) · lechmazur/writing · llm-stats.com · Berkeley Function-Calling Leaderboard (gorilla.cs.berkeley.edu) · JSONSchemaBench (arxiv 2501.10868) · llama.cpp issue #20345 (JSON+thinking) · Doctor-Shotgun llama.cpp MoE-offload guide + gist · unsloth.ai/docs/models/qwen3.6 · HF repos: unsloth/Qwen3.6-35B-A3B-GGUF, Qwen3.6-27B-GGUF, Qwen3.5-9B-GGUF, Mistral-Small-3.2-24B-Instruct-2506-GGUF, Llama-4-Scout-17B-16E-Instruct-GGUF, gemma-4-12b-it-GGUF, Qwen3-235B-A22B-Instruct-2507-GGUF · promptquorum, codersera, insiderllm, inferencerig, localllm.in (secondary/blog). Full claim-level evidence (confirmed/killed): `scratchpad/research_evidence.md` (to be committed alongside if we keep raw evidence in-repo).
