# Cancel-abort + ONE progress control across all three surfaces (2026-07-17)

**Status: APPROVED PLAN v2 (2026-07-17) — building.** The v1 plan sections (the old
section 3 "The change" + section 5 ordering) FAILED their 3-lens check and are REPLACED
by the plan below, which passed its own 3-lens panel only after incorporating the
panel's findings (marked with a diamond in the text). The evidence sections (1, 2, 4, 6)
from v1 are preserved verbatim in the appendix — section 4's multi-click investigation
was subsequently RESOLVED (see memory `open-todos-2026-07-17.md` #3 and runner commit
`4c53a08`: the resident-mask fix + load/stop trigger telemetry).

## Context — why

The user's ruling stack (2026-07-17): ONE control on all three surfaces (QuickSetup ·
catalog rows · slot cards/dropdown), QuickSetup's wording — *"we are supposed to do the
integrated ui — load unload download progress bar and terms with quicksetup"*; Cancel
during a VRAM load **genuinely aborts** ("2 abort"); a cancel landing after the child
spawned unloads it silently ("q2"); the VRAM phase shows a **real percentage** ("q1") —
now gated on a probe, see T5.

Foundation already shipped (runner `4c53a08`): `resident()` reports in-flight loads
truthfully; every `load()`/`stop()` logs its trigger at INFO.

User-visible outcome: click Load → the bar appears at once with honest phases
("Getting ready → Downloading the model → Loading it into your graphics card"); click
Cancel → it resolves immediately and the model never stays loaded; click Unload →
"Unloading…" until the router agrees it's gone — no dead-feeling buttons, no flicker,
no second click.

## The design in one paragraph

Server first: kill the phantom "downloading" phase (T1); make cancel a per-load
**token** the load thread honors at checkpoints — never evicting, never blocking the
stop call, silently unloading a late-spawned child (T2); add transient **`cancelling`**
/ **`stopping`** statuses so the wire always says what is happening (T2b); probe-then-
publish a per-model VRAM-load fraction (T5). Then UI: slot cards + rows render from
**task-shaped adapters over the existing `useRunnerModels` singleton** (one poller;
`DownloadBar.vue:15-17` explicitly duck-types its task), with QuickSetup's
`PHASE_WORDS` moved (not copied) to a shared module (T3).

---

## T1 — never announce a download that isn't happening (server)

**Why:** `_run_load` writes `detail="model weights"` unconditionally
(`lifecycle.py:1361`) and `"MTP draft model"` (`:1378`) before checking disk — a cached
model flashes a download bar that lies.

**How:** the phase is set by the download itself: `:1361` → `detail="preparing"`; the
`_progress` callback (`:1349-1351`) — which fires only on real chunks — writes its
leg's detail (`"model weights"`; a wrapped `_progress_draft` writes `"MTP draft model"`
for `:1380-1385`). Cached files fire no progress → no download phase; cached-main +
missing-draft still shows the draft's real download.

**Tests (fires-proof):** cached → never "model weights" (fails today); uncached →
still shows it; cached-main+uncached-draft → draft phase only.

## T2 — cancel is a token the load thread honors (server)

**Why:** today `stop()` on a mid-load model blocks on `_router_lock` (`:878`) behind
the load holding it from `:1410`, and the failed plan's membership-probe fix could
evict an innocent resident model.

**How:**
- `self._cancel_events: dict[str, threading.Event]` (init near `:403`, guarded by
  `self._lock`); `load()`'s fresh-load path arms a **fresh Event** (◆ never
  `setdefault` — a stale set event would self-cancel the next load); the load thread
  clears/pops it on every exit.
- `stop(model_id)` branches on ledger status:
  - **mid-load** (`downloading`/`starting`): set the event, `_touch(status="cancelling")`,
    return immediately — **no `_router_lock`**.
  - **resident** (`running`): write `status="stopping"` BEFORE the lock, unload under
    it, then **confirm-unload**: poll `GET /models` (bounded ~5 s, the `_confirm_load`
    pattern `:1855-1866`) until the id stops reading loaded|sleeping. ◆ The final
    removal is a **compare-and-pop under `self._lock`** — pop ONLY if the entry is
    still the `"stopping"` one stop wrote; a fresher `"downloading"` entry written by a
    concurrent `load()` (e.g. `ensure_model_ready`'s auto-load, `:1099`) is left
    untouched, else that load's thread would abort at `:1416` and its waiter would die
    at the 180 s timeout (the architecture lens's race). ◆ Confirm-unload TIMEOUT
    (router still says loaded after ~5 s — pathological): pop anyway + WARNING log; the
    ledger must not wedge, the next poll shows router truth, the log records it.
- Checkpoints in `_run_load` — ◆ with the complete per-exit cleanup matrix (who pops
  `_resident` / releases the arbiter / clears the event / unloads a child — exactly
  once per path):
  - `:1416` (under the lock): event or membership → **pop + release + clear-event**,
    return. ◆ Not a bare return — under the token design stop() no longer pops for
    mid-load, so a bare return would wedge a permanent "cancelling" entry with the UI
    inert (the lens's stuck-state finding; acute for cached models whose download leg
    is instant).
  - ◆ **A second event check IMMEDIATELY before `_admit` (`:1435`)** — between `:1416`
    and `:1435` sit `sync_pins` (`:1429`) and a `catalog()` DB round-trip (`:1430`);
    a cancel landing in that window previously still evicted an innocent LRU resident
    via `_admit` → `_evict_resident` — the exact killer the first plan died on,
    surviving in a narrower window. Checkpoint adjacency is the fix, and the no-evict
    TEST must inject its cancel from inside a hooked `catalog_fn` (i.e. within the
    window), not before `:1416` — a test injecting earlier passes while the hole lives.
  - **After `_load_via_router` returns (`:1441`)**: event set → silently
    `_router_unload` the just-spawned child (the q2 ruling), pop + release +
    clear-event, return — never reaching reserve/running (`:1444-1446`).
  - Download legs: `cancel_check` (`:1367, :1383`) becomes `event.is_set() or model_id
    not in self._resident` (the membership belt stays — it is the only signal for the
    no-id full-teardown `stop()`, which arms no per-model event; reuse lens confirmed
    disjoint). `DownloadCancelled` handler (`:1448-1453`): pop + release + clear-event.
- Honest contract in docs: the router op itself is not interruptible mid-spawn; cancel
  takes effect at the next checkpoint and the model never stays loaded.

**Tests (fires-proof each):** stop-during-VRAM returns promptly (gated `router_load`;
fails today — blocks); ◆ cancel-inside-the-admit-window evicts nobody (cancel injected
from the hooked `catalog_fn`; assert the seeded resident survives + arbiter untouched);
cancel post-spawn unloads the child (spy `router_unload`) + releases + no resurrect;
◆ the `:1416` cancel leaves NO ledger entry (no stuck "cancelling"); ◆ compare-and-pop:
a concurrent fresh load survives a finishing stop; download-leg cancel still aborts;
double-stop no-op; confirm-unload timeout pops + warns.

## T2b — the wire says "stopping" / "cancelling" (server + api + schema)

**Why:** the user's unload ×3: every click worked; the card said "● loaded" with a live
button through the 2-3 s teardown.

**How:** `resident()`'s overlay (`:1033-1041`) adds `cancelling` to the in-flight set
(overrides an IDLE router listing) and `stopping` **overrides even an ACTIVE listing**
— the one deliberate exception to the `4c53a08` precedence (the child is being torn
down on our order), commented as such; the compare-and-pop above bounds any stale
`stopping` to the confirm window. `api.py:_status_for` (`:121-135`) maps both to wire
`"stopping"`. ◆ `schema.py`: extend the status doc-set/enum surfaces so the new wire
value isn't rejected — `RunnerModelInfo.status` + `ResidentModel` (`CamelModel` is
`extra="forbid"`, `schema.py:21-26`; an undeclared field/value would be dropped — the
grounding lens's catch). ◆ `LuModelCatalog.vue` row status cell (`:885` v-else chain)
gains an explicit `stopping` → "Unloading…" branch (else it renders "Not downloaded").

**Tests:** injected slow `router_unload` → `/resident` + `/models` read `stopping`
during the window (fails today: reads loaded); overlay precedence both directions
(extends the `4c53a08` tests).

## T5 — real VRAM percentage, GATED on a probe (server + shared formatter)

◆ **The grounding lens found the load-bearing claim unproven:** the cited log lines
(`router-20260717-105208.log:54-91`) are `cmd_child_to_router` INTERNAL messages
(fields under `payload`), NOT the `GET /models` HTTP response; the repo's only fixture
shows `status={value,args,preset}` with no `progress`. Building on the assumed shape
could ship a silently-dead feature behind a green mocked test.

**Step 0 — PROBE RUN, 2026-07-17 (isolated llama-server b10034, port 17631, CPU-only
qwen3-embedding-4b at ngl 0): THE BRANCH FIRED — `progress` is ABSENT from the HTTP
response.** Three distinct `GET /models` captures IN the `"loading"` state all carry
status = exactly `{value, args, preset}`; simultaneously the child emitted 4
`cmd_child_to_router:state:{"state":"loading","payload":{stages,current,value}}`
messages — so the data exists inside the router but is NOT exposed over the endpoint
we poll, at this pin. Captures: scratchpad `t5-probe-captures.json` + `t5-probe-router.log`.
**T5 is therefore NOT BUILT: the VRAM phase keeps today's honest indeterminate sweep.
Re-run this probe at the next engine bump** (the llama.cpp README documents a
`status.progress` shape, so a future build may expose it — the fraction plumbing
below stays the design for that day).

*(The original step-0 spec, for the re-probe:)* **the probe (~10 min):** spawn an ISOLATED runner (own port, never
1420/17495) loading the CPU-only embed (`qwen3-embedding-4b`, ngl 0 — zero VRAM
touched), capture the actual `GET /models` JSON mid-load. **Branch on the result:**
progress present → build T5 with the parser + stage-math test pinned to the REAL
captured body. Absent → T5 is unbuildable at this pin; keep today's indeterminate
sweep, record the finding in the plan doc, tell the user (their q1 ruling needs the
router to cooperate; re-probe at the next engine bump).

**If built:** parser keeps the field (`lifecycle.py:200-220`); `_confirm_load`'s poll
(`:1855-1866`) computes the GLOBAL fraction `(stages.index(current)+value)/len(stages)`
(malformed → sweep) → `_touch(model_id, progress=frac)`. ◆ Per-model, not single-model:
`progress` is declared on `ResidentModel` AND `RunnerModelInfo` (`schema.py` —
`extra="forbid"` would reject it undeclared) and filled in `api.py` (`:144-156`) from
the resident row — so co-resident loads each carry their own fraction (the /status
single-model channel stays byte-only; its two-concurrent-loads limitation is
pre-existing and noted, not worsened). ◆ Bar geometry: `DownloadBar` fills from
`task.done/total` (`DownloadBar.vue:31`), so the adapter (and QuickSetup's
`readLoadStatus`, `:348-357`) maps a fraction to `done=round(frac*100), total=100`
with the label from `progressCaption`'s new fraction path (`downloadRate.js`) —
"…graphics card — 42%", never `fmtBytes` (the first panel's "0 MB / 0 MB" catch).

**Tests:** parser keeps progress **against the captured real body** (fails today —
discarded); stage math (2 stages, current=spec_model, value=0.5 → 0.75); no key → no
field → sweep; label fraction path never byte-formats.

## T3 — one control, three surfaces (kit UI)

**How:**
1. **`common/services/loadPhases.js` (new):** `PHASE_WORDS` + `friendlyPhase` MOVE
   verbatim from `QuickSetup.vue:318-332` (◆ the QuickSetup copy is DELETED — import
   only; a source-reading vitest pins no local copy). Gains `preparing: "Getting
   ready"` and `stopping: "Unloading…"`. ◆ Scope honesty: this unifies the three MODEL
   surfaces; the engine bar keeps its separate `friendlyEnginePhase` (`useEngine.js:39`)
   — a pre-existing split, untouched.
2. **`useRunnerModels.taskFor(modelId)`** — a task-shaped adapter over the existing
   singleton (no new poller; sanctioned by `DownloadBar.vue:15-17`):
   state per-model from `models[]` rows + `downloadingId` + `/status.modelId`;
   label/done/total/fraction absorbing `barFor` (`LuModelCatalog.vue:43-45` — ◆ which
   is then DELETED, its only caller is `:879`); `cancel()` → the existing
   `cancelLoad`/`cancelDownload` (`useRunnerModels.js:166-188`); `retry()` re-POSTs
   the failed op. ◆ For a `stopping` model the adapter supplies NO `cancel`, and
   `DownloadBar.vue:27` gains the null-guard `v-if="task.state === 'running' &&
   task.cancel"` — a backward-compatible contract extension (the reuse lens's wrinkle:
   a running task without a callable cancel would render a crashing button).
3. **Slot cards** (`LuModelCatalog.vue:761-810`): active task → the shared
   `DownloadBar` replaces the "↓ working…" word (`:762`); idle/loaded keep the pill +
   buttons; every load/unload affordance `:disabled` while that model is
   stopping/cancelling (enumerated: card Unloads `:770-773, :801-804`, card Load-nows,
   row Load-as-default `:928-937`, `redownload`'s unload-first).
4. **Rows** (`:876-879`): keep the compact `UiProgress` (density rule) driven entirely
   by `taskFor(m)` — same words, fraction, cancel. *(Flagged alternative: full
   DownloadBar in rows; recommendation is compact.)*
5. **QuickSetup:** imports `loadPhases.js`; `readLoadStatus` (`:348-357`) gains the
   fraction branch; otherwise untouched — the reference.

**Tests:** vitest — `taskFor` state mapping per channel incl. stopping; fraction label
never byte-faked; the no-local-PHASE_WORDS source pin (`chipPopoverStacking.test.js`
precedent).

## Order, verification, rollback

1. **T5 step 0 (the probe) first** — its branch decides T5's scope before any code.
2. **T1 → T2 → T2b → T5 (server), separate commits, fires-proofs each.** Full runner
   pytest + ruff per commit. (3 pre-existing Windows-box failures excluded: lspci
   colon-path + 2× ensure_model_ready — proven identical on the unmodified tree by
   stash-run this session; they are container-green.)
3. **T3 (UI), one commit:** `test:unit` + `build:vite` + the JW headless smoke (`/ai`);
   JW server pytest once at the end.
4. **The user LOOKS** (their rule): load phases + % (if probe passed) · instant cancel ·
   "Unloading…" then gone, no flicker · QuickSetup unchanged.
5. ONE rules-checker on the final diff. Tiers revert independently.

**Out of scope (own go each):** #5 stalling thresholds · the respawner hunt (the
`4c53a08` telemetry names the next respawn's trigger) · JV convergence (F1) · the
/status two-concurrent-loads byte-channel limitation (pre-existing, now documented).


---

# APPENDIX — v1 evidence (verbatim; still the ground truth for what existed)

## 1. What exists today (all verified at file:line, 2026-07-16)

**Three channels, three genuinely different jobs** — this is NOT drift and must survive:

| Job | Channel | Status source | Why it differs |
|---|---|---|---|
| Load a chat model | `POST /v1/llm-runner/load` | `/v1/llm-runner/status` | fine — it becomes `_last_id` |
| Load the embed | `POST /v1/llm-runner/ensure-embedding` | same (`load()` promotes it to `_last_id`, `lifecycle.py:811,816`) | resolves the id from routing + **PINS** it + returns `{ok:false}` for cloud/Ollama embeds (`:1019-1035`) |
| Download weights only | `POST /v1/llm-runner/download` | `/v1/llm-runner/download/status` | no VRAM — QuickSetup's embed is deliberately lazy ("loads on first search") |

`ensure_embedding` **delegates to the same `load()`** (`:1034`). Both dropdown paths
therefore do *download-if-needed → load into VRAM*; the user's model of "one dropdown,
two situations" is exactly right, and `load()` already covers both.

**Three progress implementations of one thing:**

| Surface | Uses | Renders |
|---|---|---|
| QuickSetup | `createDownloadTask` + `DownloadBar` (the shared pair, `QuickSetup.vue:367-386,713-715`) | title · phase · bar · rate · Cancel · Retry · Ready ✓ |
| Catalog row | the `useRunnerModels` singleton + a bare `UiProgress` (`LuModelCatalog.vue:878-879`) | phase + bar + Cancel — already tracks download AND VRAM-load via `barFor()` (`:43-45`) |
| Slot card / dropdown | nothing — an `applyingId` spinner (`:161-169`) | the word "↓ working…" (`:762`) |

The hard part (per-row channel choice: download vs load) is **already solved** at
`barFor()`. The slot card's poverty is a missing mount, not a missing capability.

**The shared board.** `useRunnerModels`'s state is module-scope (`useRunnerModels.js:24-30`)
= ONE copy app-wide, with `loadProgress`/`downloadProgress` as **two flat objects, one slot
each** (`:51-65`). That flatness is CORRECT: it mirrors `/v1/llm-runner/status`, documented
as the "back-compat SINGLE-model view: the most-recently-loaded model's state"
(`api.py:220-222`). Do NOT key the board by model — that invents a distinction the server
does not have. Each card gates its bar on `loadingId === my model`, the pattern the row
already proves.

**NEW capability found in the logs (2026-07-16, unused today):** the child reports granular
VRAM-load progress to the router — `cmd_child_to_router:state:{"state":"loading",
"payload":{"stages":["text_model","spec_model"],"current":"text_model","value":0.66}}` —
climbing 0→1 per stage. So "loading into VRAM" can show a TRUE percentage, not a sweep.
Whether our `_confirm_load` reads it is UNVERIFIED (open question, §6).

## 2. The bugs

**B1 — the phantom download phase.** `load()` seeds `{status:"downloading", detail:"queued"}`
(`:814`) and `_run_load` then sets `detail="model weights"` (`:1333`) **before** checking
whether the GGUF is already on disk. An already-downloaded model therefore announces a
download that never happens — the user's "brief download progress bar" in QuickSetup, and
it would corrupt every new bar we add. Fix: check disk first, enter at the VRAM phase.

**B2 — Cancel during the VRAM load does not cancel (the user's "stuck").**
`_run_load` holds `_router_lock` from `:1382` through `_admit` → `detail="loading into VRAM"`
(`:1410`) → `_load_via_router` (`:1412`). `stop()` needs the SAME lock (`:862`). So a cancel
that arrives during the VRAM phase **blocks until the load finishes**, then unloads. The UI
flips to "Cancelled" instantly (`useDownloadTask.js` sets state before the POST), so the
label lies for ~23 s while the model loads anyway. The design is explicit that only the
DOWNLOAD is cancellable — `:1383-1385`: *"A stop() during the (slow, unlocked) download
cancels this load by dropping model_id from _resident. stop() ALSO holds _router_lock…"*.

**NOT a bug (retracted 2026-07-16):** the `/models/unload … 400 "model is not running"`
traceback in `justwrite.log` is a **logged warning, not a crash** — both call sites swallow
it (`:866-869`, `:1600-1603`) and the `_resident.pop` + `_arbiter.release` still run. An
earlier claim that this leaks a VRAM reservation was WRONG.

## 4. OPEN — the multi-click unload/reload (user: "i had to click it multiple times")

**NOT solved. Do not build a fix for it in this plan.** What the evidence shows
(`router-20260716-234004.log:14,105-110,197-202,290-293`): every unload the user clicked DID
reach the router and DID exit cleanly (`unload: stopping model instance` → `exited with
status 0`, ~2 s each), each followed 7-10 s later by a fresh spawn. So commands are not
being lost at the router. Candidate causes, none confirmed:
- (a) B2's lock: a click during a load blocks, the user clicks again.
- (b) the UI's `refresh()` (`LuModelCatalog.vue:126,154,166`) races the poller and re-renders
  the pre-click state, so a SUCCESSFUL unload still looks unchanged → the user re-clicks.
- (c) `sleep-idle-seconds=900`: a SLEEPING child may answer "model is not running".
**Next step (cheap, no build):** one observation with timestamps — click Unload once on a
loaded model, then read `justwrite.log` + the router log for that second. That decides
between (a)/(b)/(c). T2 may fix (a) for free; re-test after T2 before touching the UI.

## 6. Rulings (2026-07-17, the user — "q1 real, q2 silent unload, q3 let me know, go")

- **Q1 = REAL percentage.** VERIFIED reachable, contradicting this plan's first draft: the
  router's documented `GET /models` shape carries, for a LOADING model,
  `status: {value: "loading", progress: {stages:[…], current:"text_model", value: 0.5}}`
  (llama.cpp server README, fetched 2026-07-17) — the same payload the child emits
  (`cmd_child_to_router:state:…`, seen in the user's router log). We already poll that
  endpoint every load; `_parse_router_models` (`lifecycle.py:201-215`) simply DISCARDS
  `status.progress`, keeping only `value`+`meta`. The live router on the user's box
  confirms the negative half: loaded/unloaded entries carry no `progress` key
  (`status keys: [args, preset, value]`), so it appears exactly when it should.
  → **T5 (new):** `_parse_router_models` keeps `progress`; `_confirm_load` (`:1809-1830`)
  writes it into the resident state as the VRAM phase's `downloaded`/`total` (e.g.
  `round(value*100)`/`100`, with `current`/`stages` shaping the detail — "loading the
  model (1 of 2)"); the shared bar then FILLS for real instead of sweeping. Falls back to
  the sweep whenever `progress` is absent (older engines, mmap platforms the README warns
  can misreport) — never a bar that lies.
- **Q2 = SILENT unload.** A cancel that lands after the child is already loaded unloads it
  with no extra message; the state ("not loaded") speaks. Feeds T2's post-`_load_via_router`
  checkpoint.
- **Q3 = REPORT BACK.** Do not fix the multi-click blind. Run §4's single timestamped
  observation after T2 lands, then tell the user which of (a)/(b)/(c) it is and what it
  would cost. No poller change without their word.
