# Server model-management — implementation brief (the CORRECTED scope) — 2026-06-24

> **Pickup doc.** The `/deep-research` run was **mis-scoped by me** (anchored on 6 GB;
> researched GENERIC llama.cpp facts). The REAL question (user, 2026-06-24): **how do
> WE implement our server's model management across the FULL hardware spectrum, and how
> do we switch models for different tasks?** This brief captures the corrected scope +
> the verified CODE grounding + the verified MECHANISMS so the next session produces the
> **implementation design**, not another generic summary. Read this + the two research
> docs + `MORNING_RECAP.md` before acting. **User is frustrated by repeated rework —
> verify code + web before every claim; do the WHOLE spectrum, not one tier.**

## 0. The corrections that triggered this
- **8 GB VRAM is our MINIMUM GPU spec.** 6 GB was the *video's example*, not our floor.
  Spectrum to design for: **CPU-only → 8 → 12 → 16 → 24 GB+ VRAM**, crossed with
  **low RAM (16 GB) → high RAM (32 GB+)**.
- The deliverable is an **implementation design for OUR server(s)** — *how we load /
  unload / switch / coordinate* models per tier — NOT a list of llama.cpp flags.

## 1. Deliverable to produce next session
A concrete design doc covering:
1. **Tier matrix** — for each (VRAM tier × RAM tier, + CPU-only): which models (fast-chat
   / careful-extraction / embedding), how loaded (full-VRAM vs `--n-cpu-moe` offload to
   RAM), how many resident, how switching happens.
2. **Server implementation** — router mode vs our current spawn-per-model; the cross-kind
   (TTS + LLM + embedding) VRAM coordinator (JV); hardware-detect → auto-strategy; the
   API + settings knobs; for **BOTH** apps (JW = LLM-only; JV = TTS + LLM).
3. **Why** — reasoning + rejected alternatives, per RULE #7 (read both sides, cited).

## 1.5 STEP 1 = the CORRECT deep research — ⏳ RUNNING (run `wf_41866140-cef`, 2026-06-24)
The accurate design needs research scoped to the FULL spectrum + our implementation
(the FIRST run `wf_11fa0bf3-5ad` was mis-scoped to 6-8 GB + generic facts). The corrected
run is launched; full question in the workflow script `deep-research-wf_41866140-cef.js`.
The five angles:
1. **Per-tier MEASURED strategy** — CPU-only / NVIDIA 8(min)/12/16/24 GB+ / **Apple Silicon
   unified memory** × 16/32+ GB RAM → model + offload + co-residence + tok/s & VRAM, per task.
2. **Serving/switching architecture + ADOPT-vs-BUILD** — router vs spawn vs llama-swap (measured
   latency); how Ollama / LM Studio / GPUStack / Jan / KoboldCpp / oobabooga / vLLM IMPLEMENT
   per-hardware auto-config + switching/keep-alive/eviction; what's adoptable.
3. **TTS + LLM + embedding VRAM coordination** on one GPU (cross-type eviction / budget / TTL).
4. **Per-task model recs by BENCHMARK** (extraction / RAG / prose-EQBench / chat / embeddings-MTEB)
   per tier, cited.
5. **MoE-vs-dense extraction QUALITY** (is single-MoE-for-both viable?) + quant level + context
   budget + structured output (`--json-schema`/GBNF).

**WHEN IT LANDS → write §4 (verified tier matrix, 8 GB min) + §5 (server design decisions),
then drive #27 (architecture) / #11 (QuickSetup recipe) / #20 (tuning) / #25 (recommended_models)
/ #18 (structured output).** The §4 matrix below stays an UNVERIFIED hypothesis until then.

## 2. CODE grounding — verified this session (do NOT re-derive)
### Shared runner (`just-llm-runner/llm_runner/runner/`)
- `lifecycle.py` **`RunnerService`** — process-wide singleton; spawns **ONE single-model
  `llama-server` subprocess** (`start_runner` → `Popen`, waits `/health`); `stop()` to
  switch; `load(model_id, overrides)` (#19 plumbed `Overrides` through). One model at a
  time; loading a new one replaces the running one.
- **llama.cpp ROUTER MODE exists but we DON'T use it yet.** Native: `--models-dir` /
  `--models-preset` / `--models-max` (default 4; **LRU-evicts** via `unload_lru()` in
  `server-models.cpp`); per-model settings in a startup-fixed INI; each model = its own
  **child process**. (Corrected earlier "no auto-evict" error — see research doc.)
- `hardware.py` **`detect()`** → GPU via `nvidia-smi` (name, `vram_mb`, driver), RAM via
  `psutil`, `platform`, `cpu_cores`. This is the hardware signal a per-tier auto-strategy
  would branch on. (`fit.py`/`process.py` already compute `n_gpu_layers`/`n_cpu_moe` from it.)
- `api.py` — `/v1/llm-runner/{manifest,hardware,models,load,status,stop}`; `models?vram_mb=`
  re-scores Fit for a chosen card.
### JustVoice (`server/justvoice/engines/`)
- **`EngineManager` (`manager.py:943`)** — **per-KIND slots** `{tts, llm, embedding}` →
  `EngineProcess`. `load()` (manager.py:~1176-1235): unloads the **same-kind** prior
  occupant only (other kinds stay resident — deliberate, "LLM+TTS resident for speaker
  attribution"), then **`EngineProcess(m).spawn()`** + `proc.post("/load", …)`.
  `unload(kind|None)`.
  - ⚠️ **JV engines run as SUBPROCESSES** (each `EngineProcess` = its own process + port;
    `proc.post(...)`), each with its own VRAM allocation — **NOT in-process**. (The JV
    `CLAUDE.md` "PyTorch engines run in-process" line is imprecise — verify + fix.)
    This matters: a cross-kind VRAM coordinator must account for N subprocess allocations
    (TTS engine + LLM engine + embedding + possibly the llama-server), not one heap.
  - On LLM load → `register_local_adapter()` (manager.py:1228) registers the loaded LLM as
    a provider in the **shared `llm_runner.llm` dispatch** registry.
  - Engines: `isolation` ∈ shared (shared venv) | venv (isolated venv, needs Install).
- **JV's local LLM = transformers** (`engines/qwen3_llm/engine.py`:
  `AutoModelForCausalLM.from_pretrained`), **NOT llama.cpp.** JV imports the shared
  `llm_runner.llm` DISPATCH (`extraction/pipeline.py`, `engines/llm/config.py`) but does
  **NOT** mount the llama.cpp RUNNER (that's the pending **U5**).
### JustWrite (`justwrite-app/server/`)
- Uses the shared dispatch (`/v1/ai/*`). #19 plumbed `Overrides` through `/load`. **TO
  VERIFY next session:** does JW actually mount/run the llama.cpp runner, or only the
  dispatch + cloud/Ollama providers? (grep `llm_runner.runner` / `/v1/llm-runner` in JW.)

## 3. MECHANISMS — verified (full cited detail in the two docs, don't re-search)
- **`2026-06-24-small-vram-multimodel-research.md`** (the deep-research report) +
  **`2026-06-24-llamacpp-switches.md`** (per-switch + lifecycle).
- VRAM levers: **KV-quant `-ctk/-ctv q8_0` + `-fa on`** (≈ −47% KV); **`--n-cpu-moe`**
  (MoE experts → system RAM) fits a 35B-A3B on a small card **but needs ~24–32 GB RAM**
  (low-RAM machines CAN'T do this → forced to small dense).
- Switching: router **LRU-evict at `--models-max`** (`--models-max 1` = one-resident);
  **llama-swap** (any OpenAI backend, per-model `ttl`). Already-loaded route **<100 ms**;
  cold swap **2–10 s**.
- Embeddings: tiny (~0.5–0.8 GB) → **keep resident or run CPU-only**, don't swap.
- Quality/throughput: 35B-A3B MoE ≈ 3.6B-active compute, ≈35B-dense quality; ~24 tok/s
  CPU-only on ~22 GB RAM; ~30 @ 8 GB(extrapolated from 6 GB blog); ~33–36 @ 12 GB.

## 4. Tier matrix — ⚠️ UNVERIFIED HYPOTHESIS — do NOT implement from this
**This is my synthesis from EXTRAPOLATED numbers + quick searches, NOT verified research
(the user's challenge is correct — it can't be accurate until §1.5 confirms it per tier
with MEASURED data). Treat every cell as a hypothesis the correct research must confirm
or refute; it exists only to seed that research.** Models per the per-job table in
`justwrite-app/.../2026-06-24-local-model-recommendations.md`; RAM gates MoE offload,
VRAM gates dense / resident count.

| Tier | Hard tasks (attribution/extraction) | Fast-chat | Switch / residency strategy |
|---|---|---|---|
| **CPU-only** (≥24 GB RAM) | 35B-A3B MoE (CPU hero, ~24 tok/s) | 4–8B dense | one model; embeddings CPU |
| **8 GB VRAM + 16 GB RAM** (low RAM) | dense 8–14B Q4 (no MoE offload — RAM too small) | 7–8B dense | `--models-max 1` swap; embed CPU-only |
| **8 GB VRAM + 32 GB RAM** | **35B-A3B via `--n-cpu-moe`** OR dense 14B | 7–8B dense | single-MoE for both (no swap) OR dual + swap; embed CPU/resident |
| **12 GB + 32 GB** | 35B-A3B (mostly GPU) / dense 14B | 8–9B | `--models-max` 1–2; embed resident |
| **16 GB + 32 GB** | dense 14B / Mistral-Small-24B / 35B-A3B | 14B | 2 co-resident; embed resident |
| **24 GB+ + 32 GB+** | dense 27–32B (Qwen3.6-27B/DeepSeek-R1-32B) or 35B-A3B full | 14B | `--models-max` 2–4 co-resident; embed resident |

## 4B. SERVER ARCHITECTURE — DESIGN (run-2 informed, 2026-06-25)
Architecture is now well-grounded (research run 2 = `2026-06-25-serving-architecture-research.md`).
The per-tier MODEL picks + measured tok/s/VRAM are STILL open (filled by the cited recs doc +
the user's own Compare on real hardware). **One ADOPT-vs-BUILD fork to confirm before coding.**

**The shape — 3 layers:**
1. **Detection** (extend `runner/hardware.py`, today NVIDIA-only): adopt **llmfit's per-vendor
   shell-out PATTERN** (nvidia-smi / rocm-smi / Intel sysfs / **Apple `system_profiler`**) → report
   VRAM + RAM + platform. Apple budget = ~66 % (<64 GB) / ~75 % (≥64 GB) of UNIFIED RAM.
2. **VRAM-budget planner (BUILD — the ONE piece NO tool provides; all are count-based/operator-declared):**
   estimate per-model VRAM → per tier decide: model set + `--n-cpu-moe` offload (NVIDIA only;
   **pointless on Apple unified memory** — no PCIe) + co-residence (keep embedding + one chat
   resident; evict on budget) + idle-TTL → emit the switching config.
   ⚠️ **CORRECTED 2026-06-25 (user-caught):** an earlier version said "adopt **`gguf-parser`** —
   it **replaces our hand-rolled `fit.py`/`compute_fit`**." **WRONG** — `fit.py` ALREADY does the
   VRAM-fit math (oobabooga's fitted GGUF formula over ~19,500 measurements + a coarse pre-download
   band; verified `fit.py:1-17,108-160`), and `process.py`'s OOM probe-and-back-off is the safety
   net. **KEEP `fit.py` — do NOT replace it.** gguf-parser's only *possible* future role is reading
   GGUF METADATA (layer count / embedding dim / KV heads) to FEED `fit.py` more precisely — that's
   an additive question deferred to #29, NOT a replacement of our fit math.
3. **Switching / coordination engine — the FORK (RE-EVALUATED 2026-06-25 after a wrong claim):**
   ⚠️ **CORRECTION:** an earlier version said "adopt llama-swap because it natively coordinates
   JV's TTS+LLM+embedding." **WRONG** — verified: llama-swap only manages **OpenAI/Anthropic-
   compatible** upstreams (routes `/v1/audio/*` by the `model` field), and **JV's TTS engines are
   custom `EngineProcess` servers (`/load`, `/voices`), NOT OpenAI `/v1/audio/speech`** — so
   llama-swap would NOT manage our TTS as-is. The TTS advantage collapses.
   - **Cross-kind TTS↔LLM VRAM coordination is OURS to BUILD regardless** — no tool does
     cross-subsystem VRAM arbitration. The planner must orchestrate TWO subsystems under one
     budget: the LLM(+embedding) server(s) **and JV's existing `EngineManager`** (which already
     spawns/terminates TTS engines). This is inherent, not adoptable.
   - **LLM(+embedding) swap mechanism:** **router mode (native, no Go sidecar) is likely
     sufficient** for our llama.cpp stack. **llama-swap** only earns its keep if we later want
     **backend-agnostic** LLM serving (front vLLM/tabbyAPI/etc.) — its TTS/audio routing is
     **moot for our custom TTS**.
   - **Rejected:** rewriting every JV TTS engine as an OpenAI-`/v1/audio/speech` server so
     llama-swap could unify them — JV's voice params / instruct / effects don't map to the thin
     OpenAI audio API; not worth the rework.
   - **Corrected recommendation:** **router mode for LLM+embedding + BUILD the VRAM-budget
     planner that coordinates the LLM runner ⟷ JV `EngineManager` under one budget** (gguf-parser
     for fit). llama-swap = optional, only for backend-agnostic LLM serving. (Confirm with user.)

**Per-app:**
- **JW (LLM-only):** planner + (llama-swap or router) over LLM + embedding. Simpler.
- **JV (LLM + TTS + embedding):** the win case for llama-swap — keep the TTS model resident while
  swapping LLMs under one budget; replaces the EngineManager-per-kind-slots + separate-runner
  split with ONE coordinated budget. (If TTS stays a JV subprocess, the planner reserves its VRAM
  as a fixed block.)
- **Apple Silicon:** unified-memory budget; **no `--n-cpu-moe` benefit**; pick models that fit the
  unified budget directly; TG is bandwidth-bound (set expectations by chip tier).

**Auto-config + override:** detect → planner proposes per-tier config → user overrides in
QuickSetup (#11) / tuning UI (#20) → **Compare (#21) measures on the user's real hardware** —
this is how the MISSING measured numbers get filled (maintainer can't test broadly).

**Still BUILD (confirmed):** the VRAM-budget planner (per-tier policy + config emit, **using the
existing `fit.py` math — NOT gguf-parser-replaces-fit**, see §4B.2 correction); detection extension
(AMD/Intel/Apple); structured output (#18) for extraction.

## 5. Open design questions (decide next session)
1. **Router mode vs spawn-per-model** for production serving? Research favors **router**
   (native LRU at `--models-max`, per-model INI, multi-process isolation). #19's
   spawn-with-overrides stays for switch-VALUE tuning. → task #27.
   **✅ EMPIRICALLY CONFIRMED (2026-06-25 local test, full detail in
   `2026-06-24-llamacpp-switches.md` §Lifecycle):** the user's exact question —
   *hot-swap two models with DIFFERENT switches, in the INI, WITHOUT restarting?* —
   ran on real `llama-server` b9786: started with no `-m` + `--models-preset` +
   `--models-max 2`; hitting `modelA` then `modelB` spawned **two child processes
   (PPID = constant router PID 7375)** each carrying **its own** INI switches
   (`modelA`: ctx 2048 / KV q8_0 / fa on; `modelB`: ctx 333 / KV f16 / parallel 2);
   router never restarted. So **router mode IS capable** of per-task model swapping
   with per-model switches. ⚠️ **This proves CAPABILITY, not the decision** — whether
   to adopt router mode vs keep spawn-per-model (or hybrid: router for serving + #19
   spawn for switch-VALUE tuning) is the **USER's call** (decisions-are-the-user's
   rule); present router-vs-spawn with receipts + counter-case, don't switch the
   runner unilaterally.
2. **Cross-kind VRAM coordinator (JV):** budget-aware eviction across tts/llm/embedding +
   a **"Low-VRAM mode" (1-at-a-time) toggle** + idle-TTL, unifying EngineManager slots
   with the runner's `--models-max`. Is TTS+LLM ever truly concurrent or only sequential
   (Cast→attribute→render)? If sequential, simpler "unload other kind on load".
3. **Per-tier auto-strategy:** `detect()` hardware → auto-pick model set + `--models-max`
   + offload, with manual override (QuickSetup #11 + tuning UI #20).
4. **JW vs JV convergence:** same runner architecture both apps? (JV must adopt the
   llama.cpp runner — U5 — or stay on transformers `qwen3_llm`?)
5. **8 GB-exact recommendation** — research numbers were extrapolated from 6/12/24 GB;
   verify a real 8 GB config.
6. **JW: does it run the llama.cpp runner today?** Verify (grep `llm_runner.runner`).

## 6. Where everything is saved (the index)
- This brief (corrected scope + grounding + matrix + open Qs).
- `2026-06-24-small-vram-multimodel-research.md` — deep-research report (cited).
- `2026-06-24-llamacpp-switches.md` — per-switch + lifecycle (router/Ollama/llama-swap).
- `justwrite-app/docs/plans/2026-06-24-local-model-recommendations.md` — per-job model table.
- `justwrite-app/docs/plans/2026-06-20-shared-ai-stack-plan.md` — Decisions 21/22/23.
- Tasks #11, #18, #19(done), #20–27 in the task list. #27 = this architecture dive.
