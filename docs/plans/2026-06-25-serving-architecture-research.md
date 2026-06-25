# Serving / switching architecture + adopt-vs-build — deep-research report (2026-06-25)

Output of the corrected `/deep-research` (run `wf_41866140-cef`; 106 agents, 24 sources →
112 claims → 25 verified, **21 confirmed / 4 killed**). Companion to run 1
(`2026-06-24-small-vram-multimodel-research.md`, the low-level mechanisms). Saved here
because the harness output is in ephemeral `/tmp`. **Honest scope:** this run answered the
ARCHITECTURE + ADOPT-vs-build question with primary-source confidence; it did **NOT**
surface measured per-tier tok/s/VRAM or per-task model-by-benchmark picks (those angles
returned no verified claims — see §Gaps; they need a dedicated follow-up + the user's own
Compare on real hardware).

## The architecture answer (high-confidence, primary-sourced)

### Switching engines — three real options
1. **llama.cpp router mode** — multi-process supervisor (each model its own child process,
   crash isolation), LRU eviction capped by `--models-max` (default **4** — too high for
   8 GB; lower per tier), on-demand cold load + kept-warm, explicit `POST /models/load` +
   `/models/unload` (manual VRAM free). ⚠️ **COUNT-based, NOT VRAM-aware** (#19425, #18939:
   second big model = OOM, not auto-evicted); TOCTOU race under concurrency (#20137);
   `GET /metrics?model=` re-triggers autoload + resets idle timer (#23096). **Only manages
   llama.cpp models — NOT an external TTS engine.**
   [HF model-management blog](https://huggingface.co/blog/ggml-org/model-management-in-llamacpp).
2. **Spawn one llama-server per model** — what our `RunnerService` does today (singleton,
   stop-to-switch). Simplest; no co-residence.
3. **llama-swap** — backend-agnostic Go proxy (OpenAI **+** Anthropic compatible) that
   routes **LLM + embedding + audio/TTS** (`v1/audio/speech`) endpoints by the `model` field.
   ⚠️ **CAVEAT (corrected 2026-06-25, user-caught):** it only manages **OpenAI/Anthropic-
   compatible upstreams** and does NO inference itself. **JV's TTS engines are custom
   `EngineProcess` servers (`/load`, `/voices`), NOT OpenAI `/v1/audio/speech`** — so
   llama-swap would NOT manage OUR TTS as-is. Its value for us is **LLM + embedding swapping
   only** (where llama.cpp router mode is the native alternative); the "unifies TTS+LLM+embed"
   claim was wrong. Verified primitives (useful for the LLM/embed side):
   - **matrix DSL** `(g|q|m)&v` → keeps TTS model `v` resident while swapping LLMs g/q/m
     (exactly the keep-TTS-resident-while-switching-LLM pattern we need).
   - **`evict_cost`** per model (default 1; bias toward keeping expensive-to-reload models
     resident) — switch = minimize summed evict_cost of models that'd be unloaded.
   - group **`swap:false`** = keep all members co-resident (embedding + LLM stay loaded);
     group **`exclusive:true`** = unload other groups when this runs (cross-group eviction).
   - per-model **`ttl`** = inactivity idle-eviction (keep-alive reset per request).
   - Default = one-model-at-a-time; co-residence is explicitly configured.
   [repo](https://github.com/mostlygeek/llama-swap) ·
   [config](https://github.com/mostlygeek/llama-swap/blob/main/docs/configuration.md) (pin a
   release — v229 current; Groups-V2 supersedes legacy `groups`).

### The pattern reference — Ollama
5-min idle TTL (`keep_alive`; per-request overrides `OLLAMA_KEEP_ALIVE`), **LRU idle
eviction that QUEUES rather than OOMs**, hard rule "**a new model must COMPLETELY FIT in
VRAM** before a concurrent GPU load," pre-flight memory-fit check tracking **system RAM vs
VRAM separately**, `OLLAMA_MAX_LOADED_MODELS`=3×GPU, `OLLAMA_NUM_PARALLEL`=1. Adoptable
*pattern*; governs only its own models (not an external TTS process).
[FAQ](https://docs.ollama.com/faq) + `server/sched.go`.

### The production precedent — GPUStack v0.x
Same stack (**llama-box** = bundled llama.cpp + stable-diffusion.cpp; **vox-box** = audio:
Whisper STT + CosyVoice TTS), same hardware matrix (Metal/CUDA/ROCm/CPU, macOS/Linux/Win),
coordinates **multiple model TYPES on one server** (LLM + VLM + embedding + reranker + image
+ audio) — a working "TTS + LLM + embedding sharing one GPU" implementation. Uses
**`gguf-parser`** for VRAM estimation. **Use v0.x as the reference** (v2 dropped
llama-box/Metal for vLLM/Linux-only; llama-box archived Nov 2025). Study, don't lift turnkey.
[gpustack](https://github.com/gpustack/gpustack) · [llama-box](https://github.com/gpustack/llama-box) · [vox-box](https://github.com/gpustack/vox-box).

### Hardware detection — llmfit (pattern only)
Cross-platform DETECTION via per-vendor shell-outs (NVIDIA `nvidia-smi`, AMD `rocm-smi`,
Intel Arc sysfs, **Apple `system_profiler`**, Ascend `npu-smi`) — language-agnostic, reusable
to extend our `hardware.py` (today NVIDIA-only) to AMD/Intel/Apple. ⚠️ Its fit/quant-selection
**algorithm did NOT survive verification (0-3)** — adopt the detection commands, **build** the
decision logic. [llmfit](https://github.com/AlexsJones/llmfit).

### Apple Silicon is fundamentally different (high-confidence)
- Usable GPU memory = a fraction of **unified RAM**: ~**75%** on ≥64 GB, ~**66%** on <64 GB
  (≈21–22 GB on a 32 GB Mac, not 24); raise via `sudo sysctl iogpu.wired_limit_mb`.
- Text-gen throughput is **memory-bandwidth-bound**, sub-linear (~1.5× per 2× bandwidth):
  7B-Q4 ~36–38 tok/s @200 GB/s (Pro) → ~61–66 @400 (Max) → ~92–94 @800 (Ultra).
- **No PCIe expert-transfer penalty** → the `--n-cpu-moe` calculus differs fundamentally
  (offload is far cheaper) — but **no measured Apple-Silicon MoE-offload numbers were found.**
  [llama.cpp #4167](https://github.com/ggml-org/llama.cpp/discussions/4167).

## ⭐ The one thing NO tool does — we must build it
**None** of router mode / llama-swap / Ollama / GPUStack does **true VRAM-budget
arbitration** — all are **count-based or operator-declared**. So the runner must build a thin
**VRAM-budget planner**: detect hardware → estimate per-model VRAM → decide
co-residence/eviction/offload per tier → emit the switching config (llama-swap groups
+ evict_cost + ttl, or router `--models-max` + manual unload).

> ⚠️ **CORRECTED 2026-06-25 (user-caught):** the original line here said "estimate per-model VRAM
> (adopt `gguf-parser` … this replaces our `fit.py`/`compute_fit`)." **WRONG** — our `fit.py`
> ALREADY implements the VRAM-fit math (oobabooga's fitted GGUF formula; `fit.py:1-17,108-160`),
> with `process.py`'s OOM back-off as the net. **KEEP `fit.py`.** gguf-parser at most ADDS GGUF
> metadata parsing to feed `fit.py` (deferred #29) — it does not replace the fit math. GPUStack's
> use of gguf-parser is a precedent for *metadata extraction*, not a reason to drop our formula.

## Gaps — NOT answered (need a follow-up pass + the user's Compare)
- **No measured per-tier tok/s + VRAM** (8 GB floor, quant tradeoffs, `--n-cpu-moe`
  throughput/RAM-floor, Apple MoE). The only measured data = Apple 7B-Q4 TG-vs-bandwidth.
- **No per-task model-by-benchmark picks** (EQ-Bench, MTEB, extraction boards) — our existing
  `2026-06-24-local-model-recommendations.md` has board-cited picks but they weren't
  re-verified here; verify in a follow-up + on the user's hardware via Compare (#21).
- **MoE-vs-dense extraction QUALITY** ("one MoE for both chat + extraction") = **UNVALIDATED**.
- **structured-output** (`--json-schema`/GBNF) quality/latency cost = no verified claims.

## Refuted (don't repeat)
- "llama-swap co-residence is matrix-DSL-only / fully manual" — **0-3** (groups + evict_cost
  + ttl give real policy primitives; default is exclusive single-model).
- llmfit's fit ALGORITHM / quant hierarchy / "emits commands" / "is a library" — **0-3** (it's
  a Rust CLI; only its detection pattern is adoptable).
- GPUStack named auto-config mechanisms — **1-2** (precedent, not documented turnkey).
