# Plan — Serving / VRAM manager (router mode + a thin budget arbiter)

> ⛔ **LIVE STATUS (2026-07-04): DESIGN IN PROGRESS · user-approved DIRECTION, sub-decisions + one runtime verification still OPEN · NO CODE.** The user opened this workstream while resolving the model-setup embedding gap and decided (2026-07-04): **(b) design this manager FIRST — the model-surface build (`2026-07-03-model-setup-simplification.md`, tasks #104–112) waits/couples to it**; **adopt llama.cpp router mode**; **DB stays the source of truth, the `.ini` is a generated artifact written only when needed.** This doc captures the research + the approved direction + the still-open decisions/verifications. It is a DESIGN doc, not yet the finalized task-based implementation plan (that comes after the open items close + the runtime verification + an explicit "go"). Anchor task: **#29** (was "Build VRAM-budget planner using existing fit.py" — now this manager).

---

## 1 · Why this exists (the problem)

The app runs MULTIPLE model servers that contend for the same VRAM, and nothing arbitrates them:
- **JustWrite:** the shared LLM (chat/prose/extraction/analysis) **+ a small embedding model** (RAG index + Chat-with-book + semantic search).
- **JustVoice:** the shared LLM (speaker attribution etc. — JV's own `qwen3_llm` engine is being replaced by the shared `just-llm-runner`, per both CLAUDE.mds "only TTS and each app's feature catalog differ") **+ its own TTS/STT engines** (kokoro, chatterbox, dia, moss_tts, luxtts, whisper — JV-local, NOT shared). The user's framing: JV runs "TTS and LLM but not at the same time," and the TTS server is a different kind of server. **VERIFIED 2026-07-04 (grep of the JV codebase): JV uses NO embeddings** — zero embed call sites (`embedTexts` / `/v1/ai/embeddings` / `.embed(` / `embed_texts` → none anywhere; `extraction/` has no "embed"); the LLM does **speaker extraction** (`extraction/` pipeline: identify/segmentation/anchors/prompts) + **refinement / rewriting** (`refinement.py`) only. So the two apps have DIFFERENT co-residence profiles: **JW = shared LLM (big) + a tiny embed (co-resident), NO TTS; JV = shared LLM (big) XOR TTS (some GB), NO embed.**

Three concrete pains, all one root problem:
1. **The embedding gap** (`2026-07-03-model-setup-simplification.md` §12): the bundled runner is stop-to-switch, one model at a time, launched WITHOUT `--embeddings`, and its local provider has no embed model set — so RAG's "Build index" fails with *"Provider … has no embedding model set"* (`IndexBuildModal.vue:77`). Locally, embeddings simply don't work unless a separate provider (Ollama/cloud) supplies them.
2. **Per-task / future-routing model swap:** switching the loaded model is a full kill+respawn+reload (slow for a big model — see §4), so per-task models thrash; a box with enough VRAM should keep several loaded instead.
3. **JV TTS ↔ LLM co-residence / swap:** the shared LLM runner and JV's own TTS engine manager don't know about each other's VRAM, so on one GPU they can collide (OOM) or must blindly swap.

Our own 2026-06-25 deep-research already concluded the fix (`2026-06-25-serving-architecture-research.md` §"The one thing NO tool does — we must build it"): **true VRAM-budget arbitration** — no existing tool does it (all are count-based or operator-declared). The user re-derived this same conclusion on 2026-07-04 ("we might really need a manager that stops and starts servers as needed to manage VRAM, and that may change how we calculate fit").

## 2 · The decision (user-approved 2026-07-04)

- **(b) Design this manager FIRST.** The model-surface build (#104–112) is **coupled** to it and waits — the user chose (b) over the alternative of shipping the model-surface LLM half in parallel. (For the record: the LLM half is *technically* independent of the manager — the speed-floor pick, visible catalog, Set-as-default, and Add flow all work on today's single-model runner — but the user's call is to design the manager first so we don't build the embedding half or the fit math twice.)
- **Adopt llama.cpp ROUTER MODE** for the bundled runner (native multi-model + idle-unload + `.ini` presets), rather than build a bespoke multi-process supervisor or adopt llama-swap.
- **DB = single source of truth; the `.ini` is a generated artifact** — written from the DB only when needed (router (re)start / config change), never hand-edited, never read back. This matches the runner's existing principle: the config is "built from the DB … never read from a file" (`schema.py:117-118`). One source of truth, the `.ini` derived from it (the T3 rule — a copy drifts).

## 3 · Research findings (web-refreshed 2026-07-04 — upstream moved since our 2026-06-25 run)

Verified via the llama.cpp **server README** (primary) + corroborating 2026 write-ups. Router mode matured substantially in ~a week; this is exactly why the hard rule mandates re-verifying upstream capabilities rather than recalling them.

**llama.cpp router mode (adopt):**
- Launch `llama-server` WITHOUT `-m` → **router mode**; forwards each request to the right model instance by the **`model` field** in the request body.
- **Per-model config is an `.ini` preset** — `--models-preset ./my-models.ini`. Each model entry accepts per-model keys and **"any CLI arg without leading dashes"** (e.g. `n-gpu-layers`/`ngl`, `c` for ctx, `chat-template`, and — critically — `embeddings`/pooling). This is what makes one entry a chat server and another an embed server. **This confirms the user's "ini file" intuition exactly.**
- **`--models-max N`** (default 4) keeps multiple models resident simultaneously — the write-ups state explicitly this includes "**both chat and embedding models**."
- **`--sleep-idle-seconds SECONDS`** = native idle-unload / keep-alive (the Ollama-timeout idea, built in; PR #18228, works single- and multi-model). Plus `/models/load`, `/models/unload`, `--models-dir`.
- **Eviction is count-based (`--models-max`), NOT VRAM-aware** — the residual gap the arbiter (§5b) must fill (loading a 2nd big model can OOM rather than evict).
- Manages **only llama.cpp models** — NOT JV's custom TTS EngineProcess servers.

**HIGH-CONFIDENCE but NOT runtime-verified (env-blocked here — see §8):** that POST **`/v1/embeddings` specifically** dispatches by `model` name to a co-loaded embed entry (the README nails router-by-model for chat/completions/infill and per-model `.ini` flags incl. embeddings; the embeddings endpoint dispatch is strongly implied by corroboration but not stated in the primary source). **This is the one gating runtime check before we bank on "router mode solves embeddings."**

**llama-swap (rejected as the manager):** real co-residence primitives (groups `swap:false`, `evict_cost`, per-model `ttl`, YAML `cmd`), BUT it manages only OpenAI/Anthropic-compatible upstreams → it **cannot manage JV's custom TTS** (`/load`, `/voices`, not `/v1/audio/speech`). Its value would only duplicate what native router mode now gives for the llama.cpp side. Its `ttl`/`evict_cost`/groups are still worth studying as arbiter-policy references.

**Ollama (pattern, not adopted):** idle-TTL keep-alive, "must fully fit VRAM before a concurrent load," **queue-not-OOM**, tracks RAM vs VRAM separately, `OLLAMA_MAX_LOADED_MODELS`. Adopt the pattern in our arbiter.

**GPUStack v0.x (precedent):** a working "TTS + LLM + embedding sharing one GPU" coordinator (llama-box + vox-box). Study, don't lift.

Sources: [llama.cpp server README](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md) · [New in llama.cpp: Model Management (HF)](https://huggingface.co/blog/ggml-org/model-management-in-llamacpp) · [router-mode write-up (glukhov)](https://www.glukhov.org/llm-hosting/llama-cpp/llama-server-router-mode/) · [llama-swap config](https://github.com/mostlygeek/llama-swap/blob/main/docs/configuration.md) · [llama.cpp embeddings](https://software.land/working-with-llama-cpp-embeddings/) · prior research `2026-06-25-serving-architecture-research.md`.

## 4 · Verified current state (code, file:line — the baseline we change)

- **Shared runner = stop-to-switch, ONE model.** `RunnerService` "owns the single live llama-server" (`runner/lifecycle.py:172-176`); `load()` spawns a fresh server on a thread (`:285-298`), `stop()` kills it (`:300-309`). No warm pool. Switching models = kill + respawn + **reload the target's full weights into VRAM**. Swap cost (estimates, unmeasured — #28): tiny model (nomic 137 MB / bge 440 MB) ~1–3 s; big chat model (32B ≈ 20 GB) ~10–60 s cold. → per-use hot-swap of a BIG model is unacceptable for interleaved work (Chat-with-book embeds a query then generates every turn); a TINY embed model is cheap to keep co-resident. This is the core argument for router-mode co-residence over swap.
- **Embeddings go through the provider adapter, separate from chat dispatch.** `POST /v1/ai/embeddings` → `adapter.embed(input, model)` (`llm/api.py:117-135`). Only Ollama (`ollama.py:195`) and OpenAI-compat (`openai_compat.py:235-246`) implement `embed()`; `base.py:112` is a stub.
- **`local-llamacpp` IS the OpenAI-compat adapter** pointed at the local server (`openai_compat.py:44,106`; `registry.py:87`; `seed.py:70-71` → `http://127.0.0.1:8080/v1`, `default_model: ""`). So local embeds `POST 127.0.0.1:8080/v1/embeddings` — but today the server runs one chat model, no `--embeddings`, no embed model set → the gap.
- **JW RAG:** `IndexBuildModal.vue:77` blocks the build if `!ai.embeddingModelFor(provider)`; `indexer.js:45` / `chat.js:145` / `characterChat.js:155` resolve provider+model and call `embedApi.js` → `/v1/ai/embeddings`. Embeddings fire in a **burst at index build** and **once per question** in Chat-with-book (interleaved with generation).
- **JV** has its own `engines/manager.py` + `engines/base.py` + `engines/registry.py` managing its TTS/STT/LLM engines — independent of the shared runner (no shared VRAM view).
- **Two planes today:** **switches** (Plane-1 launch flags) resolve DB `switch_presets`/`engine_presets` → `Overrides` → `process.py` composes the llama-server command; **samplers** (Plane-2) ride the per-request `/chat/completions` body.

## 5 · The design

### 5a · Bundled runner → router mode; the manager renders the `.ini` from the DB
Run `llama-server` in **router mode** (`--models-dir` at the hf cache + `--models-preset <emitted.ini>` + `--models-max <N>` + `--sleep-idle-seconds <ttl>`). The manager **renders the `.ini` from the DB** (the catalog + `switch_presets`/`engine_presets` → one `[model]` section per model, each carrying its resolved launch flags; the embed model's section carries `embeddings`/pooling). Requests route by `model` id: `/v1/chat/completions` → the chat model, `/v1/embeddings` → the embed model. `RunnerService` evolves from "own one llama-server" to "own the router + emit its `.ini` + drive load/unload"; the OpenAI-compat `local-llamacpp` adapter is unchanged (it already speaks the same `:8080/v1` surface).

### 5b · The thin VRAM-budget arbiter (task #29) — the part no tool does
A small module (uses `fit.py`, does NOT replace it) that:
- Detects the VRAM/RAM budget (`hardware.py` + `fit.py`).
- Tracks what is loaded/committed across **both** the shared LLM router **and** JV's `engines/manager.py` (the cross-subsystem ledger — the novel part).
- Applies policy: **co-reside when it fits** the budget (keep the tiny embed + chat both resident; on a big card keep 2 chat models or TTS+LLM), **else swap** (stop-to-switch) with an idle TTL so a swapped-in model stays warm briefly. Sets `--models-max` and which models are `load-on-startup` vs allowed to sleep, per the budget — filling router mode's count-based-not-VRAM-aware gap.
- **VERIFIED router-mode architecture (2026-07-04, from the user's box log):** the router is a **supervisor that spawns one `llama-server` CHILD PROCESS per model** (log: `srv load: spawning server instance with name=chat on port 55469`) and proxies by model id — so co-residence = N child processes, and `--models-max` caps the child COUNT (confirming count-based, not VRAM-aware). Each child fits its model INDEPENDENTLY, so **the `.ini` we emit must set a FITTING `ngl`/offload per model from `fit.py`, NEVER a blanket `ngl=999`.** Verified failure mode: on the 8 GB RTX 2070 SUPER the 35B-A3B with `ngl=999` aborted (`common_fit_params: failed to fit params to free device memory: n_gpu_layers already set by user to 999, abort`) — a MoE on a small card needs `--n-cpu-moe` + partial `ngl`. This is exactly why the arbiter (not a hardcoded default) owns the per-model launch flags in the emitted `.ini`.

### 5c · Fit becomes budget-aware (the user's "may change how we calculate fit")
`coarse_fit` gains a **remaining-budget** input: `fit(X)` = does X fit the VRAM left after the committed-resident set, not the whole GPU (today `api.py:41-49` passes the whole detected VRAM). The **math in `fit.py` is unchanged**; the BUDGET fed to it changes, and the arbiter owns "what's committed." For a tiny co-resident embed the effect on the speed-floor LLM auto-pick (model-setup §10) is negligible; for JV TTS+LLM it is material.

### 5d · Switches vs samplers (answering the user's worry precisely)
- **Switches (Plane-1 launch flags) MOVE to the emitted `.ini`** — but only the *last mile*. The switches UI is UNCHANGED and keeps writing to the DB; the manager renders `DB → .ini → router`. `process.py`'s direct spawn-compose is replaced by the `.ini` emission. (This is a consequence of adopting router mode; with a bespoke process.py manager they wouldn't move — but router mode is chosen for the native multi-model/TTL/embeddings it buys.)
- **Samplers (Plane-2) are UNAFFECTED** — they ride the per-request body; the router just proxies. No change.

### 5e · Embeddings resolved (closes model-setup §12)
With a co-resident embed entry in the router, the model-setup plan's embedding half becomes real: the QuickSetup **embed dropdown** and **"Set as embedding"** write the embedding model id that the router serves at `/v1/embeddings`; RAG's `IndexBuildModal` guard passes because the local provider now has an embed model. **Gated on the §8 runtime confirm** that `/v1/embeddings` routes to the embed entry.

## 6 · What this unifies (one move, many fixes)
Embedding gap (co-residence) · per-task model swap (router hot-swap + co-res on big cards) · JV TTS↔LLM (arbiter budget) · the Ollama-timeout idea (native `--sleep-idle-seconds`) · budget-aware fit · and it keeps the DB as the source of truth with a derived `.ini`.

## 7 · Decisions (2026-07-04 — the user took the agent's recommendation)
1. **Co-residence policy.** Unifying rule: **pin the tiny always-needed model resident; TTL-warm the active big model; co-reside additional big models only if `fit.py`'s remaining budget allows, else swap the LRU.** Concretely — **JW:** pin the embed model (nomic ~137 MB / bge ~440 MB — negligible; avoids swap thrash for Chat-with-book's interleaved embed+generate); keep the default chat model warm with an idle TTL (`--sleep-idle-seconds`, default ~300 s à la Ollama); per-task / future-routing extra models load on demand only if the remaining budget holds them, else swap LRU. **JV:** LLM XOR TTS — the arbiter swaps the two big consumers (LLM for extraction/rewrite → unload → TTS for narration); on a big card keep whichever is active-in-session warm with a TTL; no embed model.
2. **JV coordination = an in-process VRAM-budget arbiter (no IPC).** Both apps mount the runner router INSIDE their FastAPI process (`JustVoice/server/justvoice/app.py:190`; runner `api.py` "both apps mount this"), and JV's TTS engines run **in-process** (PyTorch / sherpa-onnx, per JV CLAUDE.md). So the arbiter is a **module in `just-llm-runner`**, consulted before any load: the LLM router asks it before loading a model; JV's `engines/manager.py` asks it before loading a TTS engine. One in-process committed-VRAM ledger tracks both the llama-server child (the router) and the in-process TTS models — no cross-process IPC needed within an app. (JW has no TTS, so its arbiter just governs the router's chat + embed.)
3. **The arbiter lives in `just-llm-runner`** (shared, both apps consume) — confirmed by #2.
4. **`.ini` emission mapping** (build detail, pin at implementation): the exact `switch_presets` / `engine_presets` → per-model `.ini` key mapping (short vs long flag forms; how `embeddings` / pooling is set on the embed entry). Verify each key against `llama-server --help` on the pinned build.

## 8 · Open verifications (runtime / build-time — NOT closable in this container)
1. **✅ CONFIRMED (2026-07-04, on the user's Windows box / RTX 2070 SUPER): `/v1/embeddings` routes to a co-loaded embed entry in router mode.** The runtime confirm was env-blocked in the dev container (GitHub egress denied — the API, `/releases/latest`, and the `b9644` asset all 403; `/root/.ccr/README.md` forbids routing around a policy 403; HF downloads work, only the binary was blocked — a prior session's CPU run was under a more-permissive policy), so the user ran the 5-minute recipe on their own box. **RESULT:** `llama-server --models-preset models.ini --models-max 2` over a `[chat]` entry (Qwen3.6-35B-A3B) + an `[embed]` entry (nomic, `embeddings=true`); startup reported "2 models loaded from ini"; `POST /v1/embeddings {"model":"embed","input":"hello world"}` returned a real ~768-dim embedding vector (`data[0].embedding`), routed by the `model` id to the embed entry — NOT the chat model. **KEY DETAIL: the model id = the `.ini` section name** (`[embed]`→`"embed"`, `[chat]`→`"chat"`), so the DB→`.ini` emission sets exactly the ids clients request. **CONSEQUENCE: the primary design branch — router-mode co-residence — is VALIDATED. The embedding gap is solved by co-residence, and the §11 second-embed-process fallback is NOT needed.** (Minor nicety still to eyeball: a `GET /models` snapshot confirming both entries stay resident simultaneously — already indicated by `--models-max 2` + the "2 models loaded" startup line.)
2. **Swap-speed measurement (#28)** — real reload times per model on the user's box (informs co-reside-vs-swap thresholds).
3. **Per-model `--embeddings`/pooling accepted in the `.ini`** (part of #1).

## 9 · Impact on the model-surface plan (`2026-07-03-model-setup-simplification.md`)
- The **embedding half** (§12 gap; §14 items 2/5/6 + the embed fit numbers) is **subsumed here** — it resolves via router-mode co-residence, not a bolt-on.
- The **LLM half** (speed-floor pick, visible catalog, Set-as-default, Add flow) is technically independent, but per the user's **(b)** choice the whole model-surface build **waits/couples** to this manager design. Recorded as the coupling; revisit if the user later decouples.

## 10 · Build order (LATER — after §7/§8 close + an explicit "go"; NOT the finalized task plan)
Indicative phases, to be turned into a rules-checked task plan when we finalize: (1) runner → router mode + `.ini` emission from the DB (the switch last-mile move); (2) the arbiter + budget-aware `fit`; (3) embeddings wired (co-resident entry; model-setup embed dropdown / Set-as-embedding become real); (4) JV coordination (shared budget ledger with `engines/manager.py`); (5) UI (engine panel shows resident set + TTL; model-setup embed surfaces); (6) verify (runtime embed-routing on a real box, swap-speed, ruff/pytest/build/smoke, JV import) + rules-checker. Then the model-surface build resumes on top.

## 11 · Options considered / rejected (T4)
- **llama-swap** — rejected as the manager: can't manage JV's custom TTS; duplicates native router mode for the llama.cpp side. (Study its `ttl`/`evict_cost`/groups as policy references.)
- **Bespoke process.py multi-process supervisor** — rejected: reinvents multi-model + idle-TTL + config that router mode now gives natively; would keep switches in `process.py` (a minor upside) at the cost of building/maintaining all the swapping ourselves.
- **Second dedicated embed-server process** (our own, alongside the chat server) — kept as the **fallback** if §8.1 fails (router can't route `/v1/embeddings` to a dedicated entry). Tiny embed models make a resident second server cheap.
- **Ollama / cloud-only embeddings** — the current de-facto path; kept as a fallback / for users who prefer it, but does not deliver "fully local, one-app."
- **Chosen:** llama.cpp router mode (native multi-model + `.ini` + TTL) + a thin VRAM-budget arbiter (fit.py-driven, cross-subsystem) with DB→`.ini` emission.

## 12 · Cross-refs
`2026-07-03-model-setup-simplification.md` (§10 speed-floor pick, §12 embedding gap — this manager resolves it) · `2026-06-25-serving-architecture-research.md` (the adopt-vs-build research; router/llama-swap/Ollama/GPUStack) · `2026-06-24-small-vram-multimodel-research.md` (low-level mechanisms) · task **#29** (anchor) · #28 (measured swap-speed/benchmarks).
