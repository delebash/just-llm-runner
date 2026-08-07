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

**STATUS 2026-08-07 — CLOSED, both halves.** The kit half: `f1fa1dd` capabilities ·
`2579d21` family default + finished-state layer + Running/Recent split +
retry-from-history + inline flag + `{done,total}` bar; JW companion `277b50d`; 15
tests in JustVoice's `kitTaskQueue.test.js`, mutation-checked. The linger policy is
FAMILY CANON (`FAMILY_TASK_LINGER`, familyContract.js) — the user's ruling superseded
this section's "opt-in so the siblings keep today's counts" framing. The JustVoice
half shipped the same day (JustVoice `5d6d912`): all 17 sites on kit handles, the
global stack is kit `AiTaskStrip`s over `visibleTasks` minus `inline`, the three fork
files are deleted, and the topbar pill / Overview bar / delete-all-projects guard all
read the kit store. Gated by biome + vitest + build + smoke + this guard + JW 566 +
docgen 3, and verified LIVE (the Routing-by-feature Lab run rendered the kit strip in
the column, exactly once). The approved decision text lived in JustVoice's tracker
and was closed there under close-=-delete — it survives in JustVoice commit
`72f39a3`.

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

A first fix was written and reverted unratified; the ratified fix is COMMITTED —
`947f08c` (registration + `markStreaming`, which the reverted attempt missed) and
`2579d21` (the Lab's tasks are `inline`-flagged so a global stack can't double-show
them).

**STATUS 2026-08-07 — VERIFIED LIVE.** The Routing-by-feature run was driven in the
real renderer against a real server (JustVoice's conversion gate): clicking ▶ Run on
the speaker-attribution Lab rendered the kit strip in the column (status
`streaming` — `markStreaming` doing its job), exactly one strip on the page (the
`inline` flag kept the global stack out), and the failed run badged the ✨ button red
and kept its error in the panel's Recent list. Still true: no *automated* suite
clicks an adapter-backed Run — the check was a scripted live drive, not a committed
test.

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
shared component, and **the standard still points at the pre-kit donor.**

**STATUS 2026-08-07 — CONVERGED.** The merge ran both directions: the kit frame took
JustWrite's two better features (window drag via `-webkit-app-region` with no-drag on
buttons AND slotted content, verified in compiled CSS; disabled-reason tooltips) in
`e7f7b3a`, and JustWrite adopted the frame in `4002cd0`, gaining docgen's post-nav
settle fix its copy lacked. docgen gained window-dragging it never had. The standard's
donor references were updated the same day (§4 + §11 name the kit component now).

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

**STATUS 2026-08-07 — FIXED in place** (justwrite-app `da04b98`): the four claims now
name the kit store, `AiTaskStrip`, `runAiFeature`/`runAiFeatureStream`, and the
rate-relative freshness; the linger behaviour is documented. The rest of JustWrite's
two architecture documents remains unexamined (see E) — this section's 4-errors-in-one
-section rate is the reason E keeps them listed.

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

### B5 · "The JV path" — a finished migration whose TITLE kept it open [CLOSED 2026-08-07]

The user asked why JustVoice would consume llm-runner differently from its siblings.
The audit had no answer, because §9 of the standard was headed *"Adding llm-runner to
an EXISTING Python app (the JV path)"* and that name reads as a standing exception.

It is not. §9 is a six-step **migration checklist** whose step 2 is literally *"adopt
`install_llm`, replacing à-la-carte mounts"*, and it ends *"JustVoice commits
`14b3ea7`/`aa1363f` are the worked example"* — past tense. The job finished
2026-08-05.

Verified in code, all three apps:

| §8 step | JustWrite | JustVoice | docgen |
|---|---|---|---|
| `include_router(llm_runner.router)` before install | ✓ | ✓ | ✓ |
| `install_llm(engine, session_factory, feature_catalog, feature_prompts, engine_presets, feature_presets, default_preset_id)` | ✓ | ✓ | ✓ |
| `product=PRODUCT` (shared AI cache) | `app.py:223` | `app.py:249` | `app.py:299` |
| `seed_llm()` | `seed.py` | `app.py:272` | `app.py:323` |
| `load_from_configs(stores.get_provider_store().list())` | `seed.py:51` | `app.py:283` | `app.py:325` |

That last line is byte-identical in all three. docgen's own comment says it follows
*"JW's exact order."* Only the DATA each passes differs — JustWrite's writing catalog,
JustVoice's voice features, docgen's translation actions — which §11 rules is per-app
BY DESIGN.

**So the Python half of the family is fully converged, and the only defect was the
section's name.** Fixed the same day: §9 is now headed *"Retrofitting an EXISTING
Python app — a COMPLETED migration, not a second path"*, with a status banner and the
recipe kept for the next app that arrives with a server already built.

Worth naming as a lesson, because it cost a session: **a heading describing finished
work must say it is finished.** Two readers — the user and this audit — independently
concluded JustVoice was a special case on the strength of four words in a title, while
the code said otherwise the whole time.

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

---

# ROUND 2 — CONTENTS (run 2026-08-08)

**Method.** Inventory from `git ls-files` in all four repos (tracked truth, not
directory guesses). Scope: `src/`, `server/`, `src-tauri/`, `scripts/`, `e2e/`,
`tests/`, `llm_runner/`, `ui/src/` (normalized to `src/`), and the root configs
(package.json, vite/vitest configs, biome.json, index.html, pyproject.toml).
Excluded: `bench/` (JW's benchmark corpus), docs contents, assets, locks,
generated trees. Every cross-repo pair sharing a normalized path or basename was
byte-hashed and, where not identical, scored by line-set Jaccard (the guard's
measure). **154 pairs compared mechanically: 4 identical · 4 near-copies ·
15 drifted · 19 related · 112 different.** Eyes were then spent only where the
machine found disagreement. Full pair table: generated per run by the comparison
script (re-runnable); every claim below carries its own receipt.

In scope per repo after filtering: JW 347 files · JV 371 · docgen 89 · kit 129.

## R2-0 · Round-1 claims this pass OVERTURNED

Both were judged from listings without opening files — the exact error B1
already recorded once:

- **A7 is wrong about docgen.** It claims docgen has "neither file". docgen has
  BOTH `src/styles/tokens.css` (68 lines) and `src/styles/styles.css` (275) —
  at the STANDARD's `src/styles/` location. docgen is the only conformer; JW and
  JV keep theirs at `src/` root. A7's "correct the standard" lean inverts: one
  app already follows §4 as written.
- **A9 is wrong about JustWrite.** `settingsCanon.test.js` exists in all three —
  JW keeps it at `src/views/__tests__/settingsCanon.test.js`, JV and docgen at
  `src/views/`. A *location* divergence (JW nests `__tests__/` dirs; JV/docgen
  put tests beside the file), not a missing test. Content: three domain variants
  of one shape (0.52–0.65 similar pairwise).

## R2-1 · Branding: JustVoice ships JustWrite's icons byte-identical

Every hash equal (md5 of tracked files): `icon.png`, `icon.ico`, `icon.icns`,
`32x32.png`, `64x64.png`, `128x128.png`, `128x128@2x.png` — JustVoice's entire
`src-tauri/icons/` set IS JustWrite's. The installed JustVoice app carries
JustWrite's icon in the installer, taskbar, and title bar. Only docgen has its
own icon set. (JV also tracks a stray `icons/.gitkeep`.) User-visible, ship-
blocking class.

## R2-2 · Renderer skeletons — same lanes, inverted weight

First-level `src/` shape (tracked files):

| | JW | JV | docgen | kit `ui/src` |
|---|---|---|---|---|
| services | **119** | 11 | 3 | 7 (+54 in `common/`) |
| stores | 6 | **17** | 4 | 1 |
| views | 31 | 27 | 9 | 5 |
| components | 63 | 21 | 1 | 30 |
| composables | 3 | 1 | 0 | 10 |
| i18n | 10 | 2 | 0 | — |

- **Domain logic lives in `services/` in JW and in `stores/` in JV** — an
  architectural inversion, not a file-count accident. JV's CLAUDE.md defends its
  store-heavy shape as scope; no family rule says which lane domain logic
  belongs in. Needs a ruling or an explicit "either is fine" in the standard.
- **Test placement differs**: JW nests `__tests__/` subdirs; JV/docgen put
  `*.test.js` beside sources. (R2-0's A9 correction is one instance.)
- **i18n is two-and-a-half apps**: JW full (10 files, `en.json` 2548 lines),
  JV scaffold (2 files, 75 lines), docgen none — and docgen is the i18n *tool*.
  No standard section says whether renderer i18n is family or per-app.
- JV alone keeps `src/config.js` (the `jt:server` override home — A5); JW alone
  keeps `src/fonts.css` + `assets/` at scale.
- **The kit's own root carries 12 loose modules** (tuneState.js, tokens.js,
  thinkingControl.js, knobCatalog.js, …) beside `common/`+`components/`+
  `views/` — the E-item "no stated rule for the kit's own structure" confirmed
  with numbers.

## R2-3 · Config layer (vite · vitest · biome · index.html)

**Converged for real** (all three apps): the kit source alias
(`../just-llm-runner/ui/src`), the dedupe list + its rationale comment, `fs.allow`
for the sibling kit, per-repo watch-ignores, vitest node-env + per-file jsdom
opt-in (JV and docgen both name JW as donor in their headers).

**Divergent:**

1. **Dev-port collision: docgen uses 1420 — JustWrite's port.** JV's config
   comment documents the exact hazard ("with strictPort:true a collision would
   silently leave the Tauri window pointed at JustWrite's dev server") and JV
   moved to 1430/1431 for it. docgen sits on 1420/1421 with strictPort. Running
   JW dev and docgen dev together reproduces the documented failure. No family
   dev-port allocation exists (server ports ARE allocated: 17494/17495/8742).
2. **Alias conventions**: JW `@renderer` · JV `@` AND `@renderer` · docgen
   neither. Three import styles for "this app's src".
3. **Build sections**: JW has per-platform targets (chrome105/safari17),
   esbuild-minify-unless-debug, version injection via `define`; JV has
   `target: "esnext"`, sourcemaps always; docgen has NO build section. Three
   different production-build stories for the same shell.
4. **biome**: JW = JV byte-identical (schema 2.4.16, lints `src/` only,
   formatter off). docgen runs an OLDER schema (2.4.0) but a WIDER net — it
   also lints `scripts/**` and `vite.config.js`. Neither is strictly better:
   the family wants 2.4.16 + docgen's coverage.
5. **index.html**: the boot-plate pattern is genuinely family (all three carry
   the same-plate-as-Vue-splash design, adopted 2026-08-04/05; per-app brand
   content is by design). But JW+docgen carry the load-bearing CSP comment
   ("CSP is delivered as response headers by tauri.conf.json; a meta tag would
   break IPC") and JV doesn't — whether JV's tauri.conf actually sets a CSP is
   checked in R2-6. JV alone has a favicon link.

## R2-4 · Server infra — one policy, three copies; and a security-posture split

Package top level: JW 20 modules + `api/` + dead `llm/` · JV 24 + eight domain
subpackages · docgen 25, FLAT — **no `api/` package at all** (routes live in
`app.py`/`service.py`). So no app follows §6 whole: JW+JV have `api/` but
`cli.py` entries; docgen has `serve.py` but no `api/`.

**The infra-copy class** (same policy, hand-maintained per app):

- `auth.py` ×3 — deliberately uniform (each header cites the siblings), same
  policy, same lockout escape. The 2026-08-05 lockout fix was applied THREE
  times by hand — the copy cost, already paid once. Genuine per-app parts:
  the settings read (three storage seams) and the problem-URL domain.
  Everything else is a kit-factory candidate — IF the kit's charter grows to
  server infra (a ruling: today `llm_runner` is "the AI stack", not "the app
  platform").
- `errors.py` — JW = JV's shape ("the reference") PLUS `_log_error`
  (level-scaled logging of every handled error, 2026-07-17) and
  RequestValidationError handling. **Neither improvement was back-ported to
  JV**, and docgen has no errors.py at all (its problem+json exists only in
  auth; other errors get the catch-all 500 envelope).
- `app_state.py` — JW is a 28-line copy of JV's set_state/get_state pattern
  (its docstring says "mirroring JustVoice"); contents are domain. docgen uses
  module state instead. Pattern shared, mechanism unshared.
- `version.py` — JW/JV same shape (JV adds DEFAULT_PORT); docgen has none
  (PRODUCT lives in appmeta).

**Security posture — the least-converged layer in the family:**

| | CSRF middleware | CORS |
|---|---|---|
| JW | ✓ `csrf.py` (reject cross-site mutating /v1; reuses CORS allowlist) | settings-driven, else allow-all |
| JV | **none** — `app.py:250` records the cost: "allow_key_reveal stays OFF: JV has no CSRF/origin middleware" (a product feature disabled to compensate) | settings-driven only (defaults carry dev+webview origins) |
| docgen | **none** | **hardcoded allow-all** (`allow_origins=["*"]`), comment defers the lockdown |

All three share the identical threat model (a loopback server any browser tab
can address). JW hardened it 2026-07-15; the sibling ports never happened.

**A latent middleware-order bug in JustVoice.** Starlette runs the LAST-added
middleware OUTERMOST. JW and docgen add auth *then* CORS and their comments
state the rule ("CORS ends up OUTERMOST … answers preflights before auth sees
them; JW's exact ordering"). JV adds CORS *then* auth (`app.py:163→174`) — its
comment claims the same intent ("Auth — after CORS so preflights succeed
without a token") but the code achieves the inversion: **auth runs before
CORS**. Masked today because auth defaults off; bites the moment a headless JV
sets tokens and a cross-origin UI sends a preflight (401 with no CORS headers
→ the browser reports a CORS failure).

**Entry points — docgen's split explains the standard.** docgen's `cli.py` is
its DOMAIN tool (translate/check/escalate…) and `serve.py` the server entry —
exactly §6's shape. JW and JV merged the server entry INTO `cli.py` (typer),
which is what the guard's four §6 violations measure. Also divergent: JV's
serve reads host/port from its settings store (its own no-hardcoded-tunables
law); JW/docgen hardcode CLI defaults. JW seeds in `cli.serve()` (deliberate —
keeps pytest's `create_app(tmp_path)` empty); JV/docgen seed inside
`create_app`. Same test-isolation problem, two answers.

**`/v1/health` — one endpoint, three schemas.** JW hand-written camelCase dict
(+ `dbReady`, `dataDir`; comment calls camelCase "the shared cross-app
convention") · JV a Pydantic model carrying BOTH `apiVersion` AND `api_version`
(dual-case legacy) + engine readiness · docgen a minimal inline route in
app.py (the kit boot-gate contract). The kit's `checkServer()` only needs 200,
so nothing forces convergence — but the "camelCase wire" convention is claimed
in one app and half-followed in another.

**Converged for real, verified:** the app.py middleware SKELETON — all three
carry the identical catch-all error envelope registered before CORS, with the
same verified-the-hard-way comment lineage (JV 2026-06-12 → JW → docgen "JW's
exact ordering") — and the whole install_llm sequence (B5, unchanged).

**Name collisions, not copies:** `paths.py` (JW 15 lines data-dir · JV 85
data-dir+Rust-compat layout · docgen 106 config-relative workspace paths —
three purposes) · `cli.py` (above) · JV `engines/registry.py` vs kit
`llm/registry.py` (TTS vs LLM). The shareable atom inside paths is
`default_data_dir()` via platformdirs (~5 lines each).
## R2-5 · Renderer commons — two patterns working, four copy-classes, one fork left

**Working as designed (the positive controls):**

- `services/appearance.js` ×3 — the family model exactly: kit engine + catalogs,
  per-app brand defaults, JW's manuscript theming via the engine's `extraApply`
  hook. docgen's header literally cites "the JV pattern".
- `views/settingsSections.js` ×3 + its canon test ×3 — the familyContract
  pattern working (canon relative order in the kit, app-own lanes around it,
  contract-tested per app). **The guard's "copy nobody promoted?" advisory is
  wrong for these two** — the shared part already lives in the kit; the per-app
  files are the intended app half.
- `views/AiView.vue` ×3 — three thin hosts of the kit `AiModelsArea`, per-app
  chrome. The intended shape.

**Copy-classes (promotable or convergeable):**

- `services/helpDocs.js` ×3 — three hand-copies of one adapter (JW donor, JV
  lifted with attribution, docgen re-implemented smaller). The kit seam
  (`configureHelp`) already exists; a kit `makeDocsHelpAdapter(glob, toc)`
  would leave each app one line. docgen's copy also lacks the README→index
  alias the other two have.
- `boot.smoke.test.js` ×3 (0.62–0.83 pairwise) — one skeleton, per-app route
  stubs. Promotable as a kit test helper with a stub map.
- `scripts/py.js` — JV↔docgen are the SAME file (diff = env-var name + one
  example line). JW's is different AND better: it wraps `findPython()` from
  its shared resolver (venv-preferred, PATH fallback, with a recorded failure
  story). Three launchers, two lineages; the better one is the unshared one.
- **Browser/executable lookup has TWO "one homes"**: JW `tests/lib/smoke-common.js`
  (findChrome + findPython; its own header records 19 stale copies still inside
  JW) and JV `scripts/lib/smoke-common.js` (findChrome only; JV's CLAUDE.md
  declares it "one place"). Both repos banned intra-repo forks of exactly the
  thing they fork across repos. docgen has neither.

**Real divergences:**

- `stores/ui.js` ×3 — same name, three animals, and **three persistence layers
  for UI prefs**: JW server `/v1/settings` (`ui` section) · JV server
  `/v1/prefs` · docgen `localStorage` (appearance does not survive
  reinstall/machine moves — the only app whose prefs aren't server-backed).
  Also `useUiStore` (JW, docgen) vs `useUIStore` (JV), and THREE homes for the
  family `keepServerRunning` flag (JW ui store · JV server store · docgen ui
  store via localStorage).
- **docgen's quicksetup deep-link fix propagated to JV but not JW.** The
  wizard-reopens-on-Back bug (user-hit 2026-08-03) is fixed one-shot in docgen
  and JV (JV's comment credits docgen); JW still binds
  `:auto-open-quick-setup="route.query.quicksetup === '1'"` directly — the
  exact reopening binding. JW also flings to Home on wizard close, which
  docgen deliberately removed ("disorienting") — divergent UX rulings, each
  documented, never reconciled.
- i18n: JW full (en.json 2548 lines) · JV scaffold (75) · docgen none — and
  docgen is the i18n tool. No family rule on renderer i18n.

## R2-6 · Tauri shells — a real command core, and security by three postures

- **Converged**: `set_keep_server_running` + `storage_get_root` +
  `storage_relocate` exist in all three (the family platform commands);
  `main.rs` is the same thin `*_lib::run()` shape ×3; `build.rs` identical;
  `plugin_dialog` + `plugin_window_state` ×3; JW=docgen share a copied window
  block (1440×900, min 1000×640, `dragDropEnabled: false`).
- **"Open a URL" is solved three ways**: docgen `plugin_opener` (§4's named
  choice) · JV `plugin_shell` · JW a custom `open_external` command. One
  function, three mechanisms — §11's exact target.
- **docgen alone ships no `plugin_http`** — its webview fetches cross-origin
  directly, which is WHY its server needs hardcoded allow-all CORS. The R2-4
  security row and this plugin row are one fact seen from two sides. JW/JV
  route through the CORS-exempt Tauri HTTP plugin.
- **Capabilities**: JW's is the only scoped one (per-URL http allowlist +
  rationale); JV grants six flat `:default`s; docgen is minimal. JW also
  pins the public capability schema URL; JV/docgen point at `../gen/schemas`.
- **`"csp": null` in all three** — meaning the index.html comments in JW and
  docgen ("CSP is delivered as response headers … configured in
  tauri.conf.json") describe headers that are configured to NOT exist. No app
  in the family ships a CSP.
- JV's window block lacks `dragDropEnabled: false` (so HTML5 drag behaves
  differently than its siblings) and its bundle lists only 2 icons (both
  JW's artwork — R2-1) vs the siblings' 5.
- Identifier conventions differ (`com.justwrite.app` · `dev.justvoice.app` ·
  `com.just-ai-i18n-docgen.app`), and **no app has one version truth** — JV
  alone carries tauri.conf 0.1.0 + package.json 0.1.0 + server VERSION 0.0.1;
  JW pairs tauri 1.0.0 with server 0.0.1.

## R2-7 · Scripts, e2e, kit surface

- **e2e**: JW and docgen share the harness (fetch-driver.js IDENTICAL;
  driver.js the same file modulo line endings — the 0.95 score is CRLF/LF
  drift, worth a `.gitattributes` ruling); smoke tests are domain. JV has
  none (deferred by the user's word — recorded in its tracker).
- `scripts/smoke.js` — JW and JV each have a Playwright gate of the same
  concept, different implementations (220 vs 121 lines). Both import their
  own repo's smoke-common (see R2-5's two-homes finding).
- **JW root carries a `just-ai-i18n-docgen/` workspace config** — JustWrite
  uses docgen to translate its own `en.json` (source `../src/i18n/locales/
  en.json` → es). Intentional dogfooding, worth knowing it's there; the kit
  repo also tracks `.idea/` (IDE files), and JV tracks `legacy-gui/` (3
  files) + `testdata/`.
- **Kit export consumption** (the 49 explicit `index.js` exports swept against
  all three apps' src): **5 have zero app consumers** (FeatureWorkbench,
  LuModelPicker, llmUiBase, llmUiCapabilities, llmUiUrl — internal-surface or
  dead, needs kit-side triage before deleting) and **19 are single-app, 17 of
  them JW-only** — including `runAiFeature`/`runAiFeatureStream` themselves:
  JW calls the runner directly, JV enters via labAdapters/aiFeature
  internals, docgen via its jobs store + server-side `engine.make_send`.
  Three doors into one runner. `usePoll`'s only consumer is docgen (the
  guard's four hand-rolled-setInterval advisories are the other side of it).
- **A4 answered** (was an open question): JW's `pyproject.toml` puts the
  `-server` suffix in BOTH the package (`justwrite_server`) and the console
  script (`justwrite-server`); the standard wants it on the script only.
- **Docs-structure convention holds family-wide**: `docs/dev/` with
  TASKS.md + IDEAS.md + README.md exists in all four repos.

## R2-STATUS

**Round 2 (contents) — DONE 2026-08-08** for the cross-app surface: every
same-named/same-purposed pair across the four repos was machine-compared, and
every non-identical pair that matters was read and classified above. Still
deliberately NOT audited: per-app domain internals with no cross-app twin
(JW's 119 services, JV's engines/audio stack, docgen's pipeline modules — no
counterpart to diverge from), full CSS token values (per-app brand by design),
and JW's two architecture docs beyond what B2/B3 already read. The E-section
items "kit's own structure" and "Tauri shells" are now measured (R2-2, R2-6);
"A4's console-script question" is answered (R2-7).
