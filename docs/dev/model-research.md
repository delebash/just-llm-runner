# Model research — the distilled verdicts (shared catalog)

Distilled 2026-08-04 by the docs campaign from the June/July research runs, all now
in `../plans/archive/` (model-catalog-research-and-recommendations + evidence ·
small-vram-multimodel-research · cpu-inference-research · model-per-hardware-plan ·
speaker-attribution-llm-research). **The June per-tier picks were a reviewer panel,
not benchmarks, and the catalog has since been re-anchored on Gemma 4** — today's
truth is `llm_runner/llm/seed.py` `DEFAULT_CATALOG`; this doc keeps the durable
laws, measured numbers, and the why.

## Laws that survived every rewrite

- **Gemma ≤ 3 is NOT permissively licensed** (Gemma ToU) — only **Gemma 4 is
  Apache-2.0** (HF-API verified). Never seed Gemma ≤ 3. Llama carries the
  "Llama Community" flag; Mistral Large is research-non-commercial.
- **llama.cpp drops JSON-schema enforcement when thinking is on** (reproduced) →
  extraction runs think-off; attribution = 2-pass (reason → emit). **Deep schemas
  break every constrained-decode engine** → keep extraction schemas FLAT.
- **MoE is RAM-gated**: a small-active MoE runs at the 32 GB-RAM floor and cannot
  below it. **`--n-cpu-moe` counts from layer 0** (the "counts backwards" lore was
  refuted 0-3).
- **KV-quant lever**: `-ctk/-ctv` q8_0 ≈ −47% KV, q4_0 ≈ −72%; pairs with `-fa on`
  — near-mandatory together on dGPU (but fa OFF on Intel Arc iGPU — see JW's
  measured-performance doc).
- **Availability ≠ recommendation** (the 70B/GLM precedent): a row may exist
  untested; a band recommendation may not. Community fine-tunes never seed as
  defaults without maker reputation + verified license + a measured win.
- **Models are a facts list; switches are layered derivation** — catalog rows carry
  NO launch switches; launch config = base bundle → type bundle → mtp bundle →
  computed fit knobs → measured per-(model, machine) tunes. One launch profile per
  model (the user's "lock 1 profile"; A/B evidence in JW's measured-performance doc).
  A user's machine tunes stay machine-keyed, never universal.
- **`--fit` disables itself when the caller sets `-ngl`/`--tensor-split`** — our
  computed placement used to suppress the upstream fitter; untuned models now omit
  placement knobs so the engine fits (the 4-tier doctrine, README).
- **Nobody else measures**: every runtime in the field estimates fit; the tune sweep
  (measure + strict-winner save) has no equivalent in Ollama/LM Studio/koboldcpp —
  the moat is measured tunes.

## Measured numbers worth keeping (2070S 8 GB / 32 GB RAM era)

- Router-mode reference points: already-loaded switch <100 ms · hot-swap ~2-10 s ·
  cold load ~5-30 s (large >60 s) · reload penalty ≈ 19-21 s.
- 35B-A3B MoE with expert offload: ~33-36 tok/s @ ~7 GB on a 12 GB 3060; prefill
  131.6 t/s vs the dense 9B's 1220 t/s fully-resident (the "1.5 t/s prefill" scare
  was a cold-load artifact).
- Dense spill cliff: **~43 tok/s full-GPU vs ~2.9 spilled — ~15×.** Dense 14B pure
  CPU: 1-3 tok/s typical desktops. **CPU prefill is 16-53× slower than GPU** —
  prefill, not generation, is the CPU constraint; batch 2048 gives 2-3× prefill;
  **flash-attn on CPU is ~26% SLOWER**.
- The right CPU shape is a small-active MoE (12-15 tok/s on 32 GB boxes; ~2B-class
  hits ~26) — viable for short-context features only; context-heavy features
  (book-chat, sweeps) are not viable pure-CPU. The 2070S box test agreed: cold
  first-token 27-67 s (JW measured-performance §CPU band).
- Embeds co-residence: ~0.5-0.8 GB models are TIGHT beside a 5.5 GB chat model on
  8 GB, don't fit 6 GB → CPU embeds below 8 GB (later generalized: embed placement
  subtracts the chat default's est_vram claim).
- MTP/spec decode: +16% on a budget GPU, slower on a full-GPU 3090 — worth it
  exactly where VRAM is tight (JW later measured ~2× app-path vs bare-GGUF with
  config deltas included).
- Qwen3.6-27B beat Gemma-4-31B 76.8 vs 76.4 on a 500-prompt creative test (external).

## Speaker attribution (JV F2's research base)

LLM-first, zero-shot CoT over whole chunks (~4096 tokens, 1024 stride, roster up
front, numbered quotes, one JSON pass) beats pipelines: +12/+9 pts over BookNLP+ on
PDNC1/2; BookNLP+ is 98.6% on explicit but ~69% on non-explicit (which is ~66% of
PDNC); an 8B only matches pipelines, a 70B is near-perfect (99.8%). Cost ~1
GPU-hour/novel. Tier shortlist was low-confidence and mostly retired with the
catalog re-anchor — only `glm-4.5-air` survives in today's seed; re-shortlist
against the current catalog when F2 wakes.

## Known stale seed pointer (tracked)

`DEFAULT_MODEL_CLASS_PICKS` still names `qwen3.6-35b-a3b-mtp`, which is no longer
in `DEFAULT_CATALOG` (its refill source, ledger C9, is user-ruled NOT DOING).
