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

## Per-job × per-tier routing matrix — COMPLETE (no blank cells)
Reconciled from a 3-reviewer panel (quality-max · fit/license · end-user-sensible). **Every cell has a pick** — a bigger tier either upgrades the model or repeats the best one that fits ("(same)"), never "nothing". `+RAM` = MoE, RAM-gated (runs on a small card via `--n-cpu-moe`). Extraction/attribution = **thinking-OFF** when emitting JSON.

| Job | CPU-only (32 GB RAM) | 8 GB+32 GB (floor) | 12 GB | 16 GB | 24 GB | 32 GB | 64 GB RAM | 96 GB RAM | 128 GB+ workstation |
|---|---|---|---|---|---|---|---|---|---|
| **Chat** | Qwen3.5-9B (fast) · *35B-A3B = smarter* | **Qwen3.5-9B** (~55 t/s, re-askable) · *35B-A3B+RAM = "smarter chat" toggle* | Gemma-4-12B | Qwen3-14B | Qwen3.6-27B | Qwen3.6-27B | Qwen3.6-27B (same) | Qwen3.6-27B (same) | Qwen3.6-27B (same) |
| **Prose** | 35B-A3B+RAM | **35B-A3B+RAM** · *9B = fast drafts* | Qwen3-14B | Qwen3-14B | **Qwen3.6-27B** (local ceiling) | Gemma-4-31B | Gemma-4-31B | **★ Qwen3-235B+RAM** (cloud-class) | Qwen3-235B+RAM (GLM-4.6 opt) |
| **Extraction** (think-off) | 35B-A3B+RAM | 35B-A3B+RAM | Qwen3-14B / 35B-A3B+RAM | **Mistral-3.2-24B** | Mistral-3.2-24B | 35B-A3B+RAM / Mistral | **GLM-4.5-Air+RAM** (BFCL leader) | GLM-4.5-Air+RAM | GLM-4.5-Air+RAM |
| **Attribution** (14B+ floor, CoT) | 35B-A3B+RAM (2-pass) | **35B-A3B+RAM** (8B fails → MoE) | 35B-A3B+RAM | Mistral-3.2-24B / 35B-A3B | Mistral / 35B-A3B | 35B-A3B+RAM | GLM-4.5-Air+RAM | Qwen3-235B+RAM / GLM-Air | GLM-4.5-Air+RAM |
| **Analysis** (think-on ok) | 35B-A3B+RAM | **35B-A3B+RAM** | 35B-A3B+RAM | 35B-A3B+RAM | **Qwen3.6-27B** | Qwen3.6-27B / 35B-A3B | GLM-4.5-Air+RAM | **★ Qwen3-235B+RAM** | Qwen3-235B+RAM |

**Panel reconciliation + the floor-default fix (user, 2026-06-27):**
- **At the floor (8 GB + 32 GB), the 35B-A3B MoE is the DEFAULT workhorse for the four quality/accuracy jobs — prose, extraction, attribution, analysis.** It runs ~17–20 t/s via `--n-cpu-moe` (fast enough for these batch/semi-batch jobs) at ~32B-class quality, far better than the weak 9B (which the attribution research shows *fails* on implicit quotes — it's disqualified on accuracy, not speed).
- **Chat is the deliberate exception: it defaults to the fast Qwen3.5-9B (~55 t/s), with the 35B-A3B offered as a "smarter chat" toggle.** Why: chat is interactive, short (~150–400 tok), and re-askable, so the 9B's ~3× speed is a *felt* win and the accuracy bar is lower; the per-task analysis (2026-06-27) showed speed only bites on interactive+short output, which is chat. The 9B is also the fallback for **< 32 GB-RAM** machines that can't run the MoE. *(User can flip chat to 35B-A3B-default anytime.)*
- **Chat tops out at the fast dense Qwen3.6-27B** on bigger rigs and repeats it — don't put a 235B in chat (latency); spend the big RAM on prose/analysis. Never blank — "(same)".
- **Fit corrections:** Qwen3.6-27B (~18 GB) needs **24 GB** → 16 GB = Qwen3-14B; Mistral-3.2-24B (~14 GB) needs **16 GB** → 12 GB = Qwen3-14B / 35B-A3B; **Qwen3-235B needs ~96 GB RAM** → 64 GB tier = GLM-4.5-Air.
- **GLM-4.5-Air (MIT)** = high-RAM extraction/general; **Qwen3-235B (Apache)** = high-RAM prose/analysis; **Llama-4-Scout** (Llama Community License) listed, never a default (dominated by license-clean MoEs).
- Cloud stays an optional ceiling, **not required** — a 96 GB rig runs Qwen3-235B locally for prose.
- **`--spec-type` / MTP on the A3B MoE is MACHINE-DEPENDENT — measure, don't dogmatize.** The budget-GPU video gained ~**+16% (17 → 19.7 t/s)** adding `--spec-type` with the MTP-GGUF, but a full-GPU RTX 3090 benchmark found every spec variant *slower*. The offload vs full-GPU bottleneck differs. So we expose the switch and let the **tuning UI's tok/s readout (#20)** settle it per machine — that's exactly what it's for. (Corrects this doc's earlier flat "spec OFF for MoE".)

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

## Switch sets per model TYPE (the recommendation — folded in)
The catalog stores a model's `type` (dense | moe) and `mtp` flag; the resolver
layers the matching seeded **switch preset** (`seed.py DEFAULT_SWITCH_PRESETS`)
onto every load. The recommended Plane-1 sets:

**DENSE** (Qwen3.5-9B, Qwen3-14B, Qwen3.6-27B, Mistral-3.2-24B, Gemma-4-12B/31B):
```
-ngl 999 --flash-attn on --cache-type-k q8_0 --cache-type-v q8_0 --mlock --ctx-size <task>
# + MTP speed (~+40%) when the GGUF is an MTP build AND dense:
--spec-type draft-mtp --spec-draft-n-max 3
```
= the `base` preset (+ `mtp` preset when `mtp=true`).

**MoE** (Qwen3.6-35B-A3B, Llama-4-Scout/Maverick, GLM-4.5-Air, Qwen3-235B):
```
-ngl 999 --n-cpu-moe <fit> --no-mmap --mlock --flash-attn on --cache-type-k q8_0 --cache-type-v q8_0 --ctx-size <task>
# NO spec decoding — it SLOWS the A3B-class MoE in llama.cpp (verified)
```
= `base` + `moe` preset + a computed `n_cpu_moe` (raised until it fits VRAM; the
gate then becomes RAM). `--no-mmap --mlock` keep the offloaded experts resident.

**Per-JOB Plane-2** (per-request sampling, the FeatureSampler rows — NOT load flags):
- **extraction / attribution:** temperature ≈ 0, **thinking-OFF** under a JSON schema (llama.cpp bug), **flat** schema, `json-schema` response_format.
- **prose:** temperature ~0.8–1.0 + repetition penalties.
- **chat:** moderate temp. **analysis:** moderate temp, thinking-ON allowed (cap with `reasoning-budget`).

Every Plane-1 flag above is already typed in `Overrides`/`LoadRequest`
(`process.py:60-80`, `runner/schema.py:167-188`) and composes via
`_apply_engine_overrides`; anything new rides `extra_flags`. So all of these are
**choosable in code today** — the missing piece is the friendly UI (#20 below).

## Tuning UI (#20) — build plan
**Goal:** let the user find the fastest switch split on THEIR machine and SEE it.
- **Where:** a collapsible "Tune & measure" panel on each model card (AI ▸ Providers & models / model-manager).
- **What (Plane-1, via the existing generic `KnobGrid` + a known-knob catalog for labels/defaults/dense-MoE hints):** number inputs `n_cpu_moe` · `n_gpu_layers` · `ctx`; toggles `flash-attn` · `no-mmap` · `mlock` · `no-kv-offload` · `cont-batching`; selects `cache-type-k/v` · `spec-type`(+`n-max`); numbers `batch`/`ubatch` · `threads`/`threads-batch` · `parallel` · `cache-reuse`; **advanced (collapsed)** RoPE/YaRN + multi-GPU split → `extra_flags`.
- **Defaults:** pre-fill from the model's type-preset (MoE → the offload set; dense → MTP). The "Reset to model default" path already exists.
- **Measure:** "Load & measure" → `POST /v1/llm-runner/load` with the `Overrides` (already plumbed, #19) → run a fixed probe prompt → show **tok/s + VRAM used + RAM used**. "Save as this model's switches" persists to the model's switch rows.
- **In-container vs GPU-gated:** the panel + the load-with-overrides call + render are build/smoke-verifiable here; the **real tok/s + VRAM/RAM numbers are measured on the user's box** (GPU-gated) — the smoke checks the panel renders + the request shape is right.
- **Reuses:** `KnobGrid` (generic editor) · the `/load` endpoint (#19) · `DEFAULT_SWITCH_PRESETS` for pre-fill · a new tok/s probe endpoint. Compare (#21) then A/Bs two switch sets side by side.

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
