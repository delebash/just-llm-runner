# Model catalog — research, recommendations, and FINALIZED PLAN (2026-06-27)

Shared LLM stack (JW + JV). Decides which local GGUF models seed
`DEFAULT_CATALOG` / `DEFAULT_RECOMMENDATIONS` (`just-llm-runner/llm_runner/llm/seed.py`)
and how each job routes, **across the full hardware range**. Extends the 2026-06-24
research (`local-model-recommendations.md`, `small-vram-multimodel-research.md`).

> **STATUS (user, 2026-06-27):** adds/drops in the CORE tier are approved; the
> HIGH-END tier below is new (for confirmation). `seed.py` build pending go-ahead.

## Hardware tiers — the floor, and NO upper cap
The catalog serves every rig from the floor up. The only hard number is the floor.
- **CPU-only floor: 32 GB RAM** (no GPU).
- **GPU floor: 8 GB VRAM + 32 GB RAM.**
- **No upper cap** — 12 / 16 / 24 / 32 GB VRAM, then 48 GB / dual-GPU, then high-RAM
  workstations (64 / 96 / 128 GB+ RAM). Bigger hardware unlocks bigger/better models.
- **MoE models are gated by SYSTEM RAM, not VRAM** (experts offload to RAM via
  `--n-cpu-moe`). Because the floor is **32 GB RAM**, the 35B-A3B MoE is runnable
  *at the floor* (8 GB card + 32 GB RAM). Fit-filtering (VRAM **+ RAM**) shows each
  user only what they can run.

## How this was produced (provenance + honesty)
- **Deep-research run** `wf_7fbb7f99` — 104 agents · 22 sources · 107 claims → 25
  verified → **17 confirmed / 8 killed** (final synthesis step stubbed; recovered
  from transcripts → `2026-06-27-model-catalog-research-evidence.md`).
- **3-reviewer consensus panel** (hardware-fit / per-job benchmarks / family-license-risk).
- **Verification passes (web):** (R1) local prose, (R2) GLM, **(R3) the full high-end
  tier** — Llama 4, Qwen3-235B, GLM, etc. (the first synthesis under-served the high
  end; R3 fixes that). Sources in §6.
- **Honesty:** an earlier draft wrongly capped thinking at 32 GB (the user's *current*
  box, not a product limit) and one-lined Llama 4. Corrected here. Confirm exact quant
  sizes at build time (some HF pages 403'd the fetcher).

---

## THE CATALOG — full ladder

### CORE tier (8 GB floor → 32 GB) — APPROVED (4 Qwen anchors + 2 adds, 2 drops)
| id | repo | quant | total/active | ~VRAM / RAM | best job(s) | license |
|---|---|---|---|---|---|---|
| `qwen3.5-9b-q4_k_m` | `unsloth/Qwen3.5-9B-GGUF` | Q4_K_M | 9B dense | 7 / 32* GB | **chat** (8 GB) | Apache-2.0 |
| **`gemma-4-12b-q4_k_m`** ⊕ | `unsloth/gemma-4-12b-it-GGUF` | Q4_K_M | 12B dense | 7 / 32* GB | chat/prose, 2nd family | Apache-2.0 |
| `qwen3-14b-q4_k_m` | `unsloth/Qwen3-14B-GGUF` | Q4_K_M | 14B dense | 10 / 32* GB | analysis, prose | Apache-2.0 |
| **`mistral-small-3.2-24b-q4_k_m`** ⊕ | `unsloth/Mistral-Small-3.2-24B-Instruct-2506-GGUF` | Q4_K_M | 23.6B dense | 14 / 32* GB | **extraction/attribution** (no-thinking) | Apache-2.0 |
| `qwen3.6-27b-mtp-q4_k_m` | `unsloth/Qwen3.6-27B-MTP-GGUF` | Q4_K_M | 27B dense (MTP) | 18 / 32 GB | **analysis + PROSE** (local ceiling) | Apache-2.0 |
| `qwen3.6-35b-a3b-mtp` | `unsloth/Qwen3.6-35B-A3B-MTP-GGUF` | UD-Q4_K_XL | 35B/~3.6B (MoE) | 7 GPU / **32 GB RAM** (runs at floor) | analysis + extraction (think-off) | Apache-2.0 |

*RAM column "32*" = the floor RAM; these dense models need far less but the floor is 32 GB. DROP `qwen3.5-9b-q4_k_s`, `qwen3-14b-q3_k_m` (redundant quants). ⊕ = the 2 approved adds.

### HIGH-END tier (32 GB+ / high-RAM — NEW, for confirmation)
Each fit-gated so only capable rigs see it. Permissive licenses first.
| id | repo | quant | total/active | needs (VRAM + RAM) | best job(s) | license |
|---|---|---|---|---|---|---|
| **`qwen3-235b-a22b`** | `unsloth/Qwen3-235B-A22B-Instruct-2507-GGUF` | UD-Q2_K_XL→Q4 | 235B/22B (MoE) | 24 GB + **96 GB RAM** | **PROSE (best open, cloud-class)**, analysis | Apache-2.0 |
| **`glm-4.5-air`** | `unsloth/GLM-4.5-Air-GGUF` | UD-Q4_K_XL | 106B/12B (MoE) | 24 GB + **64 GB RAM** | **extraction (BFCL leader)**, analysis | MIT |
| `llama-4-scout` | `unsloth/Llama-4-Scout-17B-16E-Instruct-GGUF` | 1.78-bit dyn / Q4 | 109B/17B (MoE) | 24 GB + 48–64 GB RAM | long-context, general | Llama Community* |
| `gemma-4-31b-it` | `unsloth/gemma-4-31b-it-GGUF` (verify) | Q4_K_M | 31B dense | 22 GB + 32 GB | prose (non-Qwen) | Apache-2.0 |

*Llama Community License has use restrictions; the user downloads + accepts it (we list, we don't redistribute weights) — but flag it in the UI.

### WORKSTATION tier (128 GB+ RAM / multi-GPU — document, seed on request)
GLM-4.6 (355B, MIT — 24 GB + 128 GB RAM @ ~5 t/s, or 40 GB GPU + 205 GB RAM) · Llama 4 Maverick (402B — 2×48 GB) · DeepSeek V4-Flash (284B/13B — 128 GB+) · Mistral Large 123B (~75 GB Q4 — Mistral **Research** License, non-commercial, flag) · Llama 3.3 70B (~42 GB Q4). These are real and verified; they're aspirational/heavy, so list them as an opt-in "workstation" group rather than default downloads.

### Embeddings (the RAG layer, separate from the 4 jobs)
`nomic-embed-text` (local default, ~274 MB, CPU-fine, Apache-2.0); bge-m3 / Qwen3-Embedding stronger. Seed when RAG/"Ask the book" lands. (R1 — embeddings need a local default too.)

---

## Per-job × per-tier routing matrix
Bold = primary. "+RAM" = MoE (RAM-gated). Extraction/attribution = **thinking-OFF** under a JSON schema.

| Job | CPU (32 GB RAM) | 8 GB+32 GB (floor) | 12–16 GB | 24 GB | 32–48 GB | high-RAM (64–128 GB) |
|---|---|---|---|---|---|---|
| **Chat** | 35B-A3B+RAM / 9B | **Qwen3.5-9B** | Gemma-4-12B / Qwen3-14B | Qwen3.6-27B | Qwen3.6-27B | any |
| **Prose** | 35B-A3B (drafts) | Qwen3.5-9B (drafts) | Qwen3-14B / Gemma-4-12B | **Qwen3.6-27B** (local ceiling) | Gemma-4-31B / Qwen3.6-27B Q6 | **★ Qwen3-235B (cloud-class)** |
| **Extraction** (think-off) | 35B-A3B+RAM | Qwen3.5-9B (flat) | 35B-A3B+RAM / Qwen3-14B | **Mistral-3.2** / 35B-A3B | 35B-A3B | **GLM-4.5-Air (leader)** |
| **Attribution** | 35B-A3B+RAM (2-pass) | *route up — 8B fails* | 35B-A3B+RAM | **Mistral / 35B-A3B** | 35B-A3B | GLM-4.5-Air / 235B |
| **Analysis** | 35B-A3B+RAM | Qwen3.5-9B | **35B-A3B+RAM** | **Qwen3.6-27B** | 35B-A3B / 27B | Qwen3-235B / GLM-4.5-Air |

Cloud (Claude/GPT) stays an optional ceiling for any job, but is **no longer required** — a high-RAM rig runs Qwen3-235B locally for prose. MTP variants = speed knob, not quality.

---

## Verification (R1 prose / R2 GLM / R3 high-end), 2026-06-27 web
- **R1 — local prose is real.** The deep-research "Qwen3.5-27B" was a version mixup; the real creative 27B is **Qwen3.6-27B** (in our catalog), which **beats Gemma-4-31B on a 500-prompt creative test (76.8 vs 76.4)**, strong NPC dialogue + world-building, Q4_K_M on a 24 GB 4090 (~25.6 t/s, Simon Willison). And at the top, **Qwen3-235B-A22B** is the #3-overall open prose model, runnable on 24 GB + 96 GB RAM. So prose is local at every tier; cloud optional. [aithinkerlab](https://aithinkerlab.com/qwen-3-6-27b-vs-gemma-4-31b-game-dev-benchmark/) · [eqbench](https://eqbench.com/creative_writing.html)
- **R2 — GLM repo EXISTS** (`unsloth/GLM-4.5-Air-GGUF`, **MIT** license — ship-safe), 106B/12B MoE, ~64 GB RAM. The BFCL function-calling leader → seeded as the high-RAM extraction pick. (Corrects reviewer C's "no repo".) [HF](https://huggingface.co/unsloth/GLM-4.5-Air-GGUF)
- **R3 — high-end verified:** Llama 4 Scout = 109B/17B MoE, GGUF real, 1.78-bit ~32 GB on 24 GB VRAM + 48–64 GB RAM (~20 t/s), Q4 ~55 GB (dual-GPU/64 GB unified); Maverick = 402B (2×48 GB). Qwen3-235B = 24 GB + 96 GB RAM. GLM-4.6 = 355B, MIT, 24 GB + 128 GB RAM. [unsloth llama-4](https://unsloth.ai/docs/models/tutorials/llama-4-how-to-run-and-fine-tune) · [botmonster Scout 24 GB](https://botmonster.com/ai/how-to-run-llama-4-on-consumer-gpus-2026/) · [ubergarm Qwen3-235B](https://huggingface.co/ubergarm/Qwen3-235B-A22B-GGUF) · [promptquorum VRAM tiers](https://www.promptquorum.com/local-llms)

---

## Seed-ready spec (when approved)
**`DEFAULT_CATALOG`:** remove `qwen3.5-9b-q4_k_s`, `qwen3-14b-q3_k_m`; the 35B-A3B `min_ram_mb` stays **32000** (= floor, so it's a floor model, not 24000). Add CORE: `gemma-4-12b-q4_k_m` (vram 7000 / ram 32000 / tier mid), `mistral-small-3.2-24b-q4_k_m` (14000 / 32000 / high). Add HIGH-END: `qwen3-235b-a22b` (24000 / **96000** / tier high), `glm-4.5-air` (24000 / **64000** / high), `llama-4-scout` (24000 / 48000 / high), `gemma-4-31b-it` (22000 / 32000 / high). (Catalog `tier` taxonomy may need a new `workstation`/`high-ram` value, or rely on `min_ram_mb` for fit — decide at build.)
**`DEFAULT_RECOMMENDATIONS`:** prose → Qwen3.6-27B rank 10, **Qwen3-235B rank 3** (cloud-class on high-RAM), Gemma-4-31B rank 20; extraction → Mistral rank 5, **GLM-4.5-Air rank 3** (BFCL leader); chat → Gemma-4-12B rank 15. Reword 35B-A3B rows: "runs at the floor (8 GB GPU + 32 GB RAM) via expert offload."
**Switches:** extraction path runs MoE **thinking-off** under JSON schema (confirmed llama.cpp bug); flat schemas. **Tests** auto-adjust to new counts; re-run pytest + ruff.

## Critical caveats
1. 🚨 **Gemma ≤ 3 is NOT permissively licensed** (Gemma Terms of Use) — only **Gemma 4** is Apache-2.0. Never seed Gemma ≤ 3.
2. **llama.cpp drops JSON-schema enforcement when thinking is on** (reproduced on the MoE Qwen) → extraction must run **thinking-off**; attribution = **2-pass** (reason → emit). This is why dense Mistral (no thinking mode) is the safe 16 GB extraction pick.
3. **Deep schemas break every constrained-decode engine** → author **flat** extraction/attribution schemas.
4. **MoE is RAM-gated.** At the 32 GB-RAM floor the 35B-A3B runs; below 32 GB RAM it can't. Fit-filter on RAM.
5. **License flags for the user:** Llama 4 = Community License (use limits), Mistral Large = Research License (non-commercial). We LIST (user downloads), not bundle — but surface the license in the UI.
6. **Verify-before-seed:** confirm HTTP 200 for `gemma-4-12b-it`, `gemma-4-31b-it`, `llama-4-scout`, `qwen3-235b`, `glm-4.5-air` repos; pull text-only 9B GGUF.

## Decisions + why (reconciliation)
- **No upper cap; floor is 8 GB+32 GB / CPU 32 GB.** The catalog spans CPU→workstation; fit shows each user their subset.
- **Prose is local-first** (R1): Qwen3.6-27B at 24 GB, **Qwen3-235B at high-RAM** (cloud-class). Cloud optional.
- **GLM-4.5-Air added** (R2, MIT, extraction leader) for high-RAM; the earlier "reject" was on a wrong "no repo" finding.
- **High-end is in** (R3): Llama 4 Scout, Qwen3-235B, GLM — the catalog is no longer small-card-only.
- **Keep 4 Qwen anchors; cut 2 redundant quants.** Two non-Qwen CORE adds (Mistral no-thinking JSON; Gemma-4 8 GB 2nd family).

## Rejected / deferred
Kimi-K2.6 (~1T, beyond workstation) · DeepSeek V4 full (data-center) · Gemma 4 26B-A4B MoE (unconfirmed GGUF) · Gemma ≤ 3 (license) · Qwen3-32B (covered by Mistral + 35B-A3B; first add if we want a 24 GB extraction Qwen).

## Open questions / verify at build
1. HTTP 200 for the new repos (gemma-4-12b/31b, llama-4-scout, qwen3-235b, glm-4.5-air).
2. 35B-A3B throughput at the 8 GB floor (measured data is a 12 GB 3060 ~33–36 t/s).
3. CPU-offloaded MoE vs dense on **attribution quality** (open since 2026-06-24).
4. Catalog `tier` taxonomy — add a `workstation` value or drive fit purely off `min_ram_mb`?

## Sources (§6)
Run sources (22): eqbench.com (creative v3 + longform) · llm-stats.com · lechmazur/writing · gorilla.cs.berkeley.edu (BFCL) · arxiv 2501.10868 (JSONSchemaBench) · llama.cpp #20345 · Doctor-Shotgun MoE-offload guide · unsloth.ai/docs/models/qwen3.6 · HF: Qwen3.6-35B-A3B, Qwen3.6-27B, Qwen3.5-9B, Qwen3-14B, Mistral-Small-3.2-24B, gemma-4-12b, Llama-4-Scout, Qwen3-235B. Verification adds: aithinkerlab (R1) · unsloth/GLM-4.5-Air-GGUF (R2) · unsloth llama-4 docs, botmonster, apxml, ubergarm/Qwen3-235B, promptquorum local-llms, julsimon "what to buy" (R3). Full claim-level evidence: `2026-06-27-model-catalog-research-evidence.md`.
