> ⛔ **NOT THE CURRENT PLAN.** The ONE current plan is `./2026-06-28-MASTER-PLAN.md` — everything is folded in there (✅ done + ⬜ outstanding, full detail). This doc is kept as **historical background only** (past plan / design / research / evidence). Read it for context; **plan from the master.**
>
> 🔁 **ROUTER DECISION (2026-06-29, user-confirmed):** this doc's lean toward llama.cpp **router mode** was RESOLVED the other way — **stay spawn-per-model + stock llama.cpp; router deferred** (low-VRAM trap + 1-model common case; Kobold/Tabby/Aphrodite evaluated + rejected). Rationale: `2026-06-29-knob-catalog-expansion.md` §DECISION.

# Small-VRAM multi-model serving — deep-research report (2026-06-24)

Output of the `/deep-research` harness (run `wf_11fa0bf3-5ad`; 103 agents, 21 sources
→ 99 claims → 25 adversarially verified, 18 confirmed / 7 killed). Question: *run
multiple task-specific LLMs on a 6–8 GB consumer GPU + ~32 GB RAM with llama.cpp,
minimizing VRAM while keeping load/unload/switch performant (no OOM).* Saved here
because the harness output lived in ephemeral `/tmp`. Sources cited per finding;
mechanics are PRIMARY (llama.cpp source/README, llama-swap repo, Ollama docs),
latency/footprint numbers are secondary/medium.

## Headline recipe (verified)
Two OOM-safe architectures for 6–8 GB VRAM + 32 GB RAM:
- **(A) Dual-dense + resident embed:** a small dense chat model (~3–8B) Q4_K_M kept
  warm (`-fa on -ctk q8_0 -ctv q8_0` to shrink KV) + **nomic-embed-text resident**
  (~0.5–0.8 GB, or CPU-only on 6 GB) + a 2nd careful-extraction model loaded on
  demand and **LRU-evicted by router `--models-max`** or llama-swap `ttl`. Cost: a
  ~2–10 s hot-swap when extraction runs.
- **(B) Single MoE for both tasks (cleanest on 6 GB):** **Qwen3.6-35B-A3B Q4_K_M +
  `--n-cpu-moe`** (32 GB RAM holds the offloaded experts) → ~30 tok/s @ 6 GB,
  ~33–36 @ 12 GB; ONE resident model serves fast-chat AND careful-extraction (raise
  ctx / lower temp for extraction); nomic-embed resident or CPU-only. **No swap
  latency.** Prefer (B) on 6 GB, or (A) with aggressive KV-quant + CPU-only embeds.
Front everything with **router mode** (lazy load, LRU evict, <100 ms route between
resident models) or **llama-swap** (idle `ttl`).

## Verified findings (confidence · sources)
1. **KV-cache quant is the core VRAM lever (HIGH).** `-ctk/-ctv` accept
   f16(default)/q8_0/q4_0/… independently; **q8_0 ≈ −47% KV, q4_0 ≈ −72%**. Pairs
   with **`-fa on`** (flash-attn) — near-mandatory together; makes long context fit
   in VRAM instead of spilling to slow shared memory.
   [README](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md) ·
   [bench repo](https://github.com/thc1006/qwen3.6-speculative-decoding-rtx3090).
2. **MoE expert CPU-offload is THE big-model-on-small-VRAM technique (HIGH).**
   `--cpu-moe` (all experts→CPU) / `--n-cpu-moe N` (first N layers' experts→CPU) /
   `-ot "exps=CPU"`. Keeps attention + dense FFN + shared-expert FFN + KV on GPU,
   routed experts in RAM. **`--n-cpu-moe` counts from layer 0** (the "counts
   backwards" lore is REFUTED 0-3). Per-layer GPU reassignment via a numbered regex,
   first-match-wins. Measured: 35B-A3B Q4_K_M, 64K ctx, `--n-cpu-moe 32` → ~33–36
   tok/s @ ~7 GB on a **12 GB** 3060; ~30 tok/s @ 6 GB (corroborating blog).
   [HF MoE guide](https://huggingface.co/blog/Doctor-Shotgun/llamacpp-moe-offload-guide) ·
   [3060 bench](https://knightli.com/en/2026/05/26/rtx-3060-llama-cpp-n-cpu-moe-local-35b/).
3. **Router mode is native (HIGH).** Launch `llama-server` with **no `-m`** → serves
   many models, lazy-loads on first request, routes on the `model` field, auto-finds
   GGUFs in the cache / `--models-dir`; `/models/load` + `/models/unload` (unload
   frees VRAM). Same-model repeat = instant.
   [README](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md).
4. **⚠️ Router DOES auto-evict via LRU at `--models-max` (HIGH — CORRECTS our prior
   doc).** Models co-reside up to `--models-max` (default **4**, 0=unlimited), each
   in its **own child process** (crash isolation, #20137); source `server-models.cpp`
   `unload_lru()` ("unload least recently used models if the limit is reached") is
   called automatically from `load()`. **Nuance:** eviction triggers on the COUNT
   cap — a model bigger than *remaining* VRAM **errors** rather than evicting (that's
   the #18939 OOM case). So "router never auto-evicts" (what I'd written) is WRONG;
   the true rule is "LRU-evict at the count cap; OOM if an oversized model exceeds
   remaining VRAM first." For one-in-VRAM, **`--models-max 1`** forces evict-before-load.
   [README](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md) ·
   [#20137](https://github.com/ggml-org/llama.cpp/issues/20137).
5. **llama-swap = proxy for ANY OpenAI/Anthropic-compatible backend (HIGH)**
   (llama.cpp, vLLM, tabbyAPI…). Hot-swaps on the `model` field; per-model `ttl`
   idle-unload (globalTTL default 0 = never). Default is NOT single-model-only
   (REFUTED 0-3) — co-residence is VRAM-bounded, not feature-gated. Native router
   makes it largely redundant for a llama.cpp-only stack.
   [repo](https://github.com/mostlygeek/llama-swap).
6. **Swap latency (MEDIUM, secondary source).** Already-loaded switch **<100 ms**
   (routing op, no PCIe); hot-swap (load+unload) **~2–10 s**; cold-load ~5–30 s
   (large >60 s). 24 GB holds ~2–4 small models. → "keep one warm + swap the rest."
7. **Embeddings are tiny → keep RESIDENT (MEDIUM).** nomic-embed-text ~0.5–0.8 GB
   (274 MB weights + CUDA ctx). Co-resides with an 8B Q4_K_M (~5.5 GB) ≈ 6.0–6.3 GB
   — TIGHT on 8 GB, does NOT fit 6 GB → on 6 GB run embeddings **CPU-only**
   (short-burst, CPU-viable). [Ollama](https://ollama.com/library/nomic-embed-text).
8. **Ollama (comparison, HIGH).** keep_alive 5 min default (negative=indefinite,
   0=immediate; `OLLAMA_KEEP_ALIVE`); co-loads only if a model **fully fits VRAM**
   (scheduler policy, NOT a llama.cpp limit); `OLLAMA_MAX_LOADED_MODELS` default
   3×GPU. Don't generalize its "must fully fit" rule to llama.cpp.
   [Ollama FAQ](https://docs.ollama.com/faq).

## Refuted (killed by 2/3+ adversarial votes) — don't repeat these
- "Router never auto-evicts; only `--sleep-idle-seconds` unloads" — **0-3** (LRU evict IS automatic).
- "llama-swap serves one model only by default; concurrency needs `matrix`" — **0-3**.
- "8 GB → hot-swap only; co-residence only at 16 GB+" — **0-3**.
- "`--n-cpu-moe` counts from the highest-numbered layers" — **0-3** (counts from 0).
- "`--n-cpu-moe 32` fits 35B-A3B in *only* ~7 GB on a 3060" — **0-3** (over-narrow; ~7 GB not a reliable floor).
- "Cold-load times by SSD tier (7B 1-3 s NVMe…)" — **1-2** (inconclusive).
- "8 GB → 32K ctx safer than 64K" — **1-2** (inconclusive).

## Caveats
- **6–8 GB numbers are EXTRAPOLATED**, not directly measured — best data is from a
  12 GB 3060 / 24 GB 3090; the 6 GB ~30 tok/s figure is a single blog (magnitude only).
- Mechanics (router/LRU/`--models-max`/MoE/KV flags) are PRIMARY/high-confidence;
  latency + footprint numbers are secondary/medium.
- **Router mode is young** (2026, open TOCTOU race #20137 where the cap can be
  transiently exceeded under concurrent load) — re-verify flag syntax vs master README.

## Open questions (the report couldn't resolve)
1. Measured cold-load (swap-in) latency on a **6–8 GB** card for 7–14B dense + small MoE (NVMe vs page-cache).
2. CPU-only embedding latency vs GPU-resident at the 6 GB tier — when is the ~0.5–0.8 GB worth it?
3. Does a single CPU-offloaded MoE actually match a dedicated dense model on **careful extraction QUALITY** (not just throughput)?
4. In router co-residence on 6–8 GB, can per-model KV/context be capped to prevent a 2nd model's KV from OOMing?

## What this means for US (feeds #27 / #11 / #20)
- **#27 (runner architecture):** strong evidence to move production serving to
  **router mode** (native multi-process, LRU evict at `--models-max`, per-model INI)
  over our current spawn-one-restart-to-switch. `--models-max 1` = low-VRAM
  one-resident; raise it on bigger cards. #19's spawn-with-overrides still fits
  switch-VALUE tuning.
- **#11 (QuickSetup recipe):** offer the two architectures by card — 6 GB → single
  MoE (B) or aggressive KV-quant dual (A) w/ CPU embeds; 12 GB+ → dual-dense warm +
  resident embed. Keep embeddings resident/CPU.
- **#20 (tuning UI):** the switches that matter are confirmed — `n_cpu_moe`, `ctx`,
  `cache-type-k/v` (q8_0), `flash-attn`; expose them with the tok/s readout.
- **JV cross-kind (#27):** the single-MoE option pairs well with a VRAM budget
  coordinator — one LLM + TTS arbitrated against the card; embeddings CPU-only.
