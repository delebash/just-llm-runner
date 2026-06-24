# QuickSetup redesign — modal wizard, editable picks, card/VRAM chooser (2026-06-24)

Design record for the shared `ui/src/views/QuickSetup.vue` rework. **JW LLM first**
(JV gets a sibling TTS QuickSetup at adoption time — U5). Saved in full detail
(PRIORITY RULE #2). Consumes the model curation in
`justwrite-app/docs/plans/2026-06-24-local-model-recommendations.md` and the engine
flags in `2026-06-24-llamacpp-switches.md` (same folder).

> ## ⭐ DECISION (locked, user, 2026-06-24)
> QuickSetup is a **modal popup wizard, the same shape as JustVoice's** — NOT the
> current collapsible inline card, and NOT an expanded inline panel. "Popup like
> JV." Everywhere "collapsible" appears below it refers to the CURRENT broken
> component we are REPLACING. (This was already the target in the design; recording
> it as a hard decision so it can never be re-litigated.)

---

## The problem (verified against the current component, not memory)

`ui/src/views/QuickSetup.vue` today (read 2026-06-24, file:line cited):

- **It's a collapsible card, not a wizard** — `lu-qs` div with a "Recommend for my
  hardware ▾" toggle (`QuickSetup.vue:111-120`).
- **You can't select anything.** It auto-derives two read-only picks:
  `quickPick = fitting[0]` = *smallest* model that fits; `accuracyPick` = *largest*
  that fits well (`QuickSetup.vue:36-41`). They render as static rows
  (`QuickSetup.vue:129-141`) — no dropdown, no override. **This is the user's exact
  complaint: "you can't select anything."**
- **It picks by parameter count, not by job.** `fitting` sorts by `paramsNum`
  ascending (`QuickSetup.vue:31-33`); there is zero notion of "good for extraction"
  vs "good for prose." A small dense model that fails attribution can be the "Quick"
  pick.
- **No card/VRAM chooser.** It only reads the detected GPU
  (`request("/v1/llm-runner/hardware")`, `QuickSetup.vue:57-62`). The backend
  already supports a chooser — `GET /v1/llm-runner/models?vram_mb=` re-scores Fit
  for any card (`api.py:77-83`) — but the UI never uses it.
- **No embedding pick.** Apply passes through `r.default?.embeddingId || ""`
  unchanged (`QuickSetup.vue:90`); embeddings aren't part of the flow.
- **No MoE/RAM awareness surfaced.** Fit is shown as a chip, but the doc's key fact
  — that the 35B-A3B MoE runs on 6 GB *if you have ~24 GB RAM* — isn't explained or
  used to steer the pick.
- **Apply** (`QuickSetup.vue:76-105`): merges routing → sets `default.llmId`,
  `quick`, `accuracy` to `local-llamacpp`; downloads+loads the Quick model. (This
  part is sound and largely reused.)

---

## Target — a modal wizard you drive, recommendations you can override

Mirror JV's modal wizard shape (the `AppModal` from the kit), not a collapsible
strip. Flow, top to bottom:

### Step 1 — Hardware (detected + overridable)
- Show detected line (reuse `hwLine`: GPU · VRAM · RAM · OS).
- **Card/VRAM chooser:** a `UiSelect` of common cards (6/8/12/16/24 GB + "CPU only"
  + "This machine"). Changing it re-scores Fit via
  `/v1/llm-runner/models?vram_mb=<n>` (endpoint already exists). Lets a user plan
  for a card they don't have yet, or force CPU-only.
- **Surface RAM as a first-class gate**, because MoE experts live in RAM: show "RAM
  ✓ 32 GB — enough for 35B-A3B offload" or "RAM 16 GB — too low for 35B-A3B (needs
  ~24 GB)". (User has 32 GB.)

### Step 2 — The recommended set (editable)
Four routing slots, each a **combobox** (type-or-pick, like the Default-LLM picker
we already shipped), **pre-filled** with a benchmark-cited recommendation but fully
overridable. Candidate lists are **Fit-filtered (VRAM + RAM, MoE-aware)** and
**ranked by job suitability, not raw size**:

| Slot | Routing target | Default recommendation logic | Notes |
|---|---|---|---|
| **Default chat / "Card"** | `default.llmId` (+ model) | best general model that fits (boards: Qwen3 / Gemma 4 12B tier) | the everyday model. *("Card" = the user's shorthand — confirm naming, see open Qs.)* |
| **Quick** | `quick` role | smallest *capable* model that fits (snappy) | brainstorm / inline / quick drafts |
| **Accuracy** | `accuracy` role | best model for **hard structured tasks** that fits — incl. **35B-A3B MoE via `--n-cpu-moe`** when RAM allows (NOT just "largest") | attribution / extraction / critique |
| **Embedding** | `default.embeddingId` (+ model) | a provider+model embedding pick (Qwen3-Embedding / nomic-embed / bge-m3) | RAG / "Ask the book". Local runner can't embed (chat-only) → provider-backed; see recs doc. |

Each row shows: the pick, its **Fit chip** (Fits / Tight / CPU / Won't fit), a
one-line **why** ("best open prose model at your tier — EQ-Bench"), and an editable
combobox to change it. Reason strings + candidate ranking come from a cited,
in-repo `recommended_models.json` (overlay of EQ-Bench / MTEB / the boards + the
video's "MY GO-TOS" datapoint), refreshed manually — NOT live-fetched, NOT from our
own testing (we can't test broadly).

### Step 3 — Apply + verify on your own text
- **Apply:** PUT `/v1/ai/routing` (default + quick + accuracy + **embedding**),
  then download+load the Default/Quick model (reuse current Apply, extended to set
  embedding). Show per-model download progress (the runner emits it).
- **Then nudge to the Lab/Compare:** "Test these on your book →" deep-links to the
  Features ▸ Compare panel pre-seeded with the recommended models as columns, so the
  user A/Bs them on their real text and **promotes the winner** (the
  "recommend → test on my writing → promote" loop). This is why QuickSetup doesn't
  need to be perfect — it seeds; Compare confirms. (See AI-stack plan Decision 23.)

---

## MoE-aware Fit (the recommendation engine's core rule)
"Best-quality model that runs on your card **including MoE offload**, per job."
- Boards pick the **family** (per job); Fit (**VRAM + RAM**) picks the **variant**.
- A **MoE** candidate (e.g. 35B-A3B) is "Fits" when **VRAM ≥ its small active/KV
  footprint AND RAM ≥ minRamMb (~24 GB)** — even on a 6 GB card. A **dense**
  candidate is "Fits" only when it largely fits VRAM (no `--n-cpu-moe` rescue).
- `coarse_fit` already supports a `min_vram_override` + `min_ram_override`
  (`api.py:33-48`, manifest `recommendedFor.minVramMb` / `minRamMb`) so a MoE entry
  can advertise its real (offload-aware) requirement. The wizard must **show the
  RAM gate**, not just VRAM.

---

## Backend touch-points
- ✅ `GET /v1/llm-runner/models?vram_mb=` — re-score Fit for a chosen card (exists).
- ✅ `GET /v1/llm-runner/hardware` — detected GPU + RAM + OS (exists).
- ✅ `PUT /v1/ai/routing` — set default/quick/accuracy/embedding (exists; extend
  Apply to write embedding).
- ➕ `recommended_models.json` (in `llm_runner/runner/` next to the manifest, or a
  `recommendations` block IN the manifest): per-job ranked candidate ids + cited
  reason strings. Source of the wizard's defaults + "why" lines.
- ➕ (later, for the tuned-load path) `POST /v1/llm-runner/load` to accept
  `Overrides` (n_cpu_moe / n_gpu_layers / ctx / flags) — see switches doc; not
  required for QuickSetup v1 (it loads with computed Fit), but the Compare panel
  needs it.

## Reuse / convergence (RULE #7)
- ONE shared `QuickSetup.vue` in the kit — both apps mount it (JW now; JV at U5).
- It uses the **same** combobox primitive as the Default-LLM picker (don't fork a
  new selector), the **same** Fit chips, the **same** routing endpoints.
- JV's **TTS** QuickSetup is a *separate* wizard (different domain: pick a TTS
  engine + voice), not a fork of this one — the LLM half stays shared.

## Open questions (for the user)
1. ~~Modal vs inline~~ — **DECIDED: modal popup wizard like JV** (see locked
   decision at top).
2. **"Card" naming** — in "Card + Quick + Accuracy + Embedding", is **Card** = the
   Default chat model, or a label for the VRAM/card chooser? (I mapped it to the
   Default chat LLM slot above; confirm.)
3. **Recommendations home** — `recommended_models.json` file vs a `recommendations`
   block inside `runner-manifest.json`? (Rec: separate file — refreshes without
   touching the binary manifest.)
4. **Embedding default** — Qwen3-Embedding (video pick) vs nomic-embed-text (tiny,
   CPU-easy) vs bge-m3 (stronger)? (Rec: nomic default, Qwen3-Embedding offered.)
