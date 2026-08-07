# The family structure audit — three apps against THE FAMILY APP STANDARD

**Started 2026-08-07.** The user's ruling that opened it: *"all 3 apps should have
same folder structure same file names, api, the way they load things, llm runner etc
except domain specific stuff… this comes first before anything else."*

**This is an audit, not a design.** The standard already exists —
`docs/app-structure.md`, 547 lines, titled *"THE FAMILY APP STANDARD — every Tauri +
Vue + Python app, identical by construction."* Its §11 already carries the user's
principle as law:

> *Same function ⇒ same kit surface and mechanism, in every app — including
> JustWrite.* … **No escape valves:** … if a kit surface can't host an app's need,
> THE KIT GROWS until it can.

So the job is not to decide what the structure should be. It is to measure the three
apps against a written standard, and — a finding of round one — to measure the
standard against the code, because parts of it have gone stale.

**Scope, per the user: everything.** All three apps, renderer and server, and the kit
itself.

## Status

**Round 1 (structure) — DONE.** File-tree inventory of `justwrite-app`, `JustVioce`,
`just_ai_i18n_docgen` and `just-llm-runner/ui`, renderer and server.

**Round 2 (contents) — NOT STARTED.** Same-named files have not been diffed.
`stores/ui.js` exists in all three apps; nobody has checked whether they agree.

Nothing has been changed in any repo. No decisions have been made. Every finding
below cites a file, and findings that were not code-verified say so.

---

## A · Apps measured against the standard

### A1 · Global AI progress — JustVoice runs a private task system (§11)

The standard: *"Global AI progress + cancel — kit `AiStatusButton` → `AiStatusPanel`
in the TitleBar, PLUS a sidebar nav row 'AI tasks' toggling the same panel."*

JustVoice mounts the kit's button and nav row **and** its own parallel system:

| `JustVioce/src/App.vue` | reads |
|---|---|
| sidebar "AI tasks" row + badge (438–447) | kit `aiTasks` store |
| `<AiStatusButton />` (552) | kit `aiTasks` store |
| topbar pill "N in flight" (541–548) | local `renderTasks` |
| `<TaskStrip>` / `<TaskStatusPanel>` (567, 591) | local `renderTasks` |

`runAiFeature` has **zero** hits in JustVoice, so nothing ever writes the kit store —
the sidebar row and status button are wired to a store that is always empty. The three
local files (`components/TaskStrip.vue`, `components/TaskStatusPanel.vue`,
`stores/renderTasks.js`) each name JustWrite as their donor in their own headers.

**The correct design is already in production — in docgen.** This audit initially
concluded the kit's queue was too LLM-shaped to carry a TTS render and that the kit
needed a domain-neutral rewrite. **That was wrong**, and the code says so.

docgen's translation runs are server-side jobs, not chat streams: its own
`POST /v1/jobs` endpoint, SSE-watched, with its own server-side cancel. Structurally
identical to a JustVoice render. `src/stores/jobs.js` puts them in the kit's queue:

```js
const handle = tasks.start({ feature: "translate", label: `Translating ${…}`, meta: { lang } });
handle.markStreaming();                          // leaves "connecting"
handle.signal.addEventListener("abort", () => {  // panel Cancel → the app's server
  post("/v1/jobs/cancel", {});
});
…
this._task?.setProgress(this.job.done, this.job.total);   // renders "n / m"
```

Its header comment states the outcome plainly:

> *"…one task per language, `setProgress` renders 'n/m' in the strip and the AI-tasks
> panel, and the panel's Cancel aborts through the shared controller into
> `POST /v1/jobs/cancel`. This is what makes translate runs visible (and cancellable)
> from the same window as model downloads — **one task surface, no bespoke strip
> (JobStrip died 2026-08-03)**."*

**docgen had exactly JustVoice's fork — `JobStrip` — and deleted it on 2026-08-03.**
Token fields are simply left unset; the strip degrades to label, elapsed, progress and
Cancel. No kit change was needed.

So the answer is a swap, not a merge: JustVoice adopts the kit queue the way docgen
did, and its three local files are deleted.

**One genuine gap remains.** JustVoice's auto-dismiss lifecycle (completed 5 s ·
cancelled 3 s · failed never) fixed a 2026-06-09 complaint that tasks *"flash and
disappear."* The kit archives on finish, so **JustWrite and docgen both have that bug
today.** Under §11's growth rule that behaviour moves INTO the kit and all three gain
it — a small addition, not the redesign this section first proposed.

Also noted: `markStreaming()` is what moves a task out of "connecting". Any registration
that omits it leaves the task in the connecting state for its whole life.

### A2 · The Lab adapter seam never registers its task (kit defect)

`ui/src/components/ConfigColumn.vue` has three Run paths. The generic one registers
the run in the task panel, with this comment:

> *"One-shot path through the shared feature wrapper so every Lab run REGISTERS in the
> global AI task panel (#36 — 'no ai progress bar no task')."*

`runViaAdapter` (line 483) does not. The strip is gated on a registered task carrying
the column id (`myTask`, line 446; `<AiTaskStrip v-if="myTask">`, line 731), so an app
that supplies its own pipeline through the documented `labAdapters` seam runs, returns,
renders its result — and shows no progress bar at all.

Bug #36 was fixed on one branch and not its sibling. A second comment at line 50 shows
the same complaint has surfaced before: *"QC-23 ('what happend to the shared ai
progress bar?')"*.

JustVoice is the only app registering adapters today (JustWrite and docgen pass none,
verified), so it is the only place the hole is visible — but the defect is in shared
code on a path any app reaches the moment it uses the seam, which §11 documents as
standard practice.

A fix was written and **reverted unratified on 2026-08-07**, pending this audit's view
on where that code should live.

### A3 · `serve.py` — two of three apps don't have one (§6)

The standard's server layout requires `<snake_name>/serve.py` with
`main()`, and console scripts of the form `<kebab-name>-server = "<snake>.serve:main"`.

| App | Entry module | Conforms |
|---|---|---|
| docgen | `serve.py` | ✓ |
| JustVoice | `cli.py` | ✗ |
| JustWrite | `cli.py` | ✗ |

JustVoice's is a **known grandfathered deviation** (recorded in its tracker).
JustWrite's was not recorded anywhere I have read.

Its npm `server` script therefore also deviates from §2's contract, which specifies
`-m <snake_name>.serve serve`; JustVoice runs `-m justvoice.cli serve`.

### A4 · Server package naming — three conventions (§6/§7)

| App | Package | Standard shape |
|---|---|---|
| JustVoice | `justvoice` | ✓ app name |
| docgen | `just_ai_i18n_docgen` | ✓ app name |
| JustWrite | `justwrite_server` | ✗ carries the `-server` suffix |

§6 puts the `-server` suffix on the **console script**, not the package —
`<kebab-name>-server = "<snake>.serve:main"`. JustWrite appears to have moved it into
the package name. **Not verified:** I have not read JustWrite's `pyproject.toml`
console-script entry, so I cannot yet say whether the suffix is duplicated or moved.

### A5 · `installLlmUi` call shape (§4)

§4's worked example passes `devPorts` + `fallbackBase`. docgen matches it exactly.
JustWrite and JustVoice both pass `resolveBase` instead — an alternative the function's
own JSDoc allows (*"supply a resolver instead of devPorts/fallbackBase"*) but which the
standard's example does not show.

All three end up calling the same kit helper, `makeOriginAwareResolver`; they differ
only in who types the call:

- JustWrite — `services/serverApi.js:17`, then hands the result back. The file's own
  comment calls its exports *"back-compat … new code should use the kit transport
  instead."* Two callers remain (`main.js:93`, `SettingsView.vue:79`).
- JustVoice — `config.js:15`, then **wraps** it to layer a `jt:server` localStorage
  override so a thin client can point at a remote host. Real extra behaviour.
- docgen — declares the two values, kit does the rest.

**Consequence worth ruling on:** all three servers run headless, so all three could be
pointed at a remote host — but only JustVoice can, and not by decision. That override
belongs in the kit under §11's growth rule.

### A6 · Where the API client lives — three answers

| App | Home |
|---|---|
| JustWrite | `services/serverApi.js` |
| JustVoice | `stores/api.js` (a reactive façade over the kit transport) |
| docgen | none — stores import `get`/`post`/`put`/`del`/`safeRequest` from the kit directly |

docgen is the cleanest: it has no `config.js` and no `serverApi.js` because it adopted
the kit transport completely.

### A7 · Style files — all three deviate, three different ways (§4)

§4 specifies **`src/styles/tokens.css`** and **`src/styles/styles.css`**.

| App | Actual |
|---|---|
| JustWrite | `src/tokens.css`, `src/styles.css`, plus `src/fonts.css` |
| JustVoice | `src/tokens.css`, `src/styles.css` |
| docgen | **neither file exists** |

When every app deviates identically, the standard is usually the thing that is wrong —
so the `src/styles/` subdirectory is a candidate for correcting in the document rather
than in three repos. docgen having neither file is a separate question: it is the only
app with no local token layer at all.

### A8 · Same concept, different filename

| Concept | JustWrite | JustVoice | docgen |
|---|---|---|---|
| Home screen | `HomeView.vue` | `OverviewView.vue` | `HomeView.vue` |
| Keyboard help | `ShortcutCheatsheet.vue` | `KeyboardCheatsheet.vue` | — |
| Project store | `project.js` | `projects.js` + `activeProject.js` | `project.js` |

### A9 · Test-file parity

- `boot.smoke.test.js` — all three ✓
- `settingsSections.js` — all three ✓
- `settingsCanon.test.js` — JustVoice ✓, docgen ✓, **JustWrite missing**

### A10 · Dead structure

`justwrite-app/server/justwrite_server/llm/` contains nothing but `__pycache__`. Its
contents moved to the shared runner (JustWrite imports `llm_runner` in `app.py:25,44,171`
and `data_admin.py:13-14`); the empty directory was never deleted.

---

## B · The standard measured against the code

### B1 · TitleBar — the standard names a donor the kit has since absorbed

§4 and §11 both name **JustWrite's `components/TitleBar.vue`** as the canonical
implementation. The kit now ships `ui/src/common/components/TitleBar.vue` and exports
it, and JustVoice adopted it on a QC ruling (2026-08-06).

Current reality:

| App | Renders | Verdict |
|---|---|---|
| JustVoice | the kit's, directly (`App.vue:18,473`) | ✓ |
| docgen | a thin local wrapper that **imports the kit's** (`components/TitleBar.vue:8`) and fills its right-side slot with the mode cycler + `AiStatusButton` | ✓ — the intended pattern |
| JustWrite | a local implementation; imports only `{ Icon, AiStatusButton }`, **not** the kit's TitleBar (`components/TitleBar.vue:7`) | ✗ the only fork |

*(Corrected 2026-08-07: an earlier pass called docgen's a fork on the strength of the
filename alone. It isn't — it wraps the kit component. Judging by filename is the exact
error this audit exists to avoid; only opening the file settled it.)*

So the app the standard treats as the donor is the only one that hasn't adopted the
shared component, and **the standard still points at the pre-kit donor.** Both the
document and JustWrite need updating; which direction is a ruling, not a cleanup.

### B2 · There are TWO standards, in two repos, with no stated precedence

| Document | Repo | Lines |
|---|---|---|
| `docs/app-structure.md` | just-llm-runner | 547 |
| `docs/dev/ARCHITECTURE.md` | justwrite-app | 489 |
| `docs/dev/architecture-notes.md` | justwrite-app | 261 |

JustWrite's two are deliberately split and cross-reference each other — ARCHITECTURE is
the "why it's built this way" narrative, architecture-notes is the detail behind
CLAUDE.md's invariants. That pair is coherent.

The problem is that **JustVoice, docgen and the kit have neither**, while much of what
those documents hold is family-wide, not JustWrite-specific:

- **The storage ruling** (`ARCHITECTURE.md:61`) — "drop and reseed, no migrations",
  every datum a real SQL resource behind a typed `/v1/*` API. It reasons explicitly
  about the other apps: *"JustVoice has one for its DSP stack… the shared runner mounts
  in-process in both."* A family law living in one app's dev docs.
- **The headless rationale** (`:26`) — why there is a Python server at all.
- **The AI task panel** (`:162`) — the shared queue's design.
- **The IPC bridge and store persistence** (`architecture-notes.md:16,50`).
- **Quote Attribution / Speaker Lab** (`:217`) — a **JustVoice feature**, documented in
  JustWrite's architecture doc, in a section that itself says *"attribution moved to
  JustVoice long ago."*

Nothing states which document wins where they overlap. Until that is ruled, this audit
cannot measure the apps against "the standard" — there are two.

### B3 · JustWrite's AI-task-panel section is stale — four verified errors

`ARCHITECTURE.md:162-215` documents the shared task queue. Each claim was checked:

| Claim | Reality |
|---|---|
| *"`useAiTasksStore` (`stores/aiTasks.js`)"* | **No such file in JustWrite** — the store lives in the kit (`ui/src/stores/aiTasks.js`) |
| *"Inline progress strip … lives in `StudioTaskStrip.vue` — copy that pattern for other views"* | **File does not exist.** The advice also contradicts §4's kit-first / NAME-YOUR-DONOR rule: the answer is `AiTaskStrip`, not a copy |
| *"pass `task: { label, meta }` … to `runAiStream`"* | **No such function.** Three stale references survive, all in comments (`IndexBuildModal.vue:27`, `VariationsModal.vue:24,38`). The kit's are `runAiFeature` / `runAiFeatureStream` |
| *"`< 3s` live · `3–10s` stalling · `> 10s` stuck"* | **Deliberately replaced 2026-07-17.** The kit's `streamFreshness.js` uses rate-relative floors (8 s / 25 s, scaled to the stream's own pace); its comment records that the absolutes *"MISLABELLED a legitimately-slow LOCAL model"* — a 2.6 tok/s local run sat on "stalling" for its whole life |

A document that tells the next reader to copy a deleted file and call a deleted function
is worse than no document, because it reads as authoritative.

### B4 · A cross-repo pointer this session broke

`ARCHITECTURE.md:227-231` — the tier-cleanup section, correctly dated 2026-08-07 —
sends readers to *"decision text in `../../../JustVioce/docs/dev/TASKS.md`."*

That text was **deleted from JustVoice's tracker the same day** by the tracker-truth
sweep, under close-=-delete (it survives in JustVoice commits `ac00291` and `754784d`).
The pointer now resolves to a file that no longer contains what it promises.

Recorded rather than quietly patched, because it exposes a rule gap: close-=-delete is a
JustVoice **tracker** policy, and **another repo's permanent documentation was linking
into it.** Either trackers are not link targets, or close-=-delete needs an exception for
referenced text. That is a ruling, and not JustVoice's alone to make.

---

## C · Divergences the standard does not cover

Generic UI helpers, with no rule about who owns them:

| Helper | Kit | JustWrite | JustVoice |
|---|---|---|---|
| `useRovingTabindex` | ✓ (**not exported**) | – | ✓ — **drifted: 99 lines vs the kit's 93** |
| `useRovingTabindexMap` | ✗ | ✓ | ✓ |
| `usePanelDismiss` | ✓ (**not exported**) | – | hand-rolled Escape handling in ≥4 components |
| `usePoll` | ✓ **exported** (`index.js:99`) | – | hand-rolled `setInterval` at `TrainView.vue:194-213` and `App.vue:358` |

Two of these are blocked by the **kit not exporting what it already has**, which is a
kit-side defect rather than app carelessness. `useRovingTabindexMap` exists in two apps
and in neither the kit nor the standard — nobody ever shared it.

`services/snapshot.js` (JustVoice) — "views paint instantly from the last visit's data",
sessionStorage-backed. Domain-free, no kit equivalent, a promotion candidate rather than
a violation.

Two Tauri apps use two different Tauri opener plugins for the same click: docgen
`@tauri-apps/plugin-opener` (which §4 names), JustVoice `@tauri-apps/plugin-shell`.

---

## D · Why this happened

The evidence is in the code's own comments: the kit was extracted from JustWrite in
batches, each batch scoped to some apps and not others, and every divergence sits where
a batch stopped.

- `warmBoot.js` — *"2026-08-04 ruling: the loading-model surface is SHARED — both
  consumers carried private copies of this file and they had already drifted."*
- docgen's Quick Setup — *"the surgery 2026-08-04: the 359-line fork died."*
- The kit transport — *"Supersedes the per-app services/serverApi.js (JV's full
  transport; JW's resolver-only stub + its ~17 scattered hand-rolled fetch helpers)."*
- The shared task queue — its ledger entry says JustVoice's half was *"excluded from
  this batch by the no-JustVoice mandate."*

And nothing checks. There is no lint rule, test or CI gate asserting that an app may
not define what the kit exports, or that the three call sites must agree. A skipped
batch stays skipped, silently.

**That guard was already specified** — JustVoice's tracker carried *"Layer C
anti-divergence guard + parity sweep — a lint/CI check that fails on a new hand-rolled
fetch / forked primitive / second `init_db` copy"* — and it was deleted, unbuilt, on
2026-08-07 during a tracker cleanup. It is the single item that would have caught every
finding in this document.

---

## E · Not yet done

- **Round 2: contents.** No same-named file has been diffed across apps. `stores/ui.js`,
  `services/appearance.js`, `services/helpDocs.js`, `views/settingsSections.js` and
  `App.vue` all exist in all three and are unexamined.
- **The kit's own structure.** `ui/src/components` vs `ui/src/views` vs
  `ui/src/common/components` — no stated rule for which a component belongs to.
- **The rest of JustWrite's two architecture documents.** Only the AI-task-panel,
  storage, and attribution sections were read. `ARCHITECTURE.md`'s release system, E2E
  harness, Ollama routing and marketing/docs-flow sections, and all of
  `architecture-notes.md` beyond its layout and IPC sections, are unexamined — and B3
  shows the staleness rate in the parts that were checked was four errors in one section.
- **The Tauri shells.** `src-tauri/` was not inventoried in any app.
- **§3, §5, §8–§10, §12** of the standard were not audited.
- **A4's console-script question** — JustWrite's `pyproject.toml` not read.

## F · Nothing is decided

Every item above is a finding. None carries a recommendation, and no code has moved.
Each divergence needs its own ruling: which version wins, does it move to the kit, or
is it renamed in place — and separately, where the standard itself is the thing that
should change.
