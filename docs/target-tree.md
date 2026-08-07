# THE TARGET TREE — one skeleton for all three apps (PROPOSED)

**Status: PROPOSED 2026-08-08 — awaiting the user's approval. Nothing moves
until this page is ratified.** Derived from the Round-2 audit
(family-structure-audit.md); execution is pieces P2–P11 below, each gated by
the app's full suite and finished by a guard rule. After ratification this
folds into app-structure.md as the normative server/renderer layout.

Legend per file: **SKELETON** = same name, same place, same pattern in every
app (content per-app) · **KIT** = imported from `llm_runner.platform` (server)
or `@delebash/llm-ui` (renderer) — nothing per-app to drift · **DOMAIN** =
app's own, slotted in the standard place · **N/A(reason)** = deliberately
absent, reason stated on this page, not silently.

## 1 · The server package — `server/<snake_name>/`

| File | Class | JW today → target | JV today → target | docgen today → target |
|---|---|---|---|---|
| `serve.py` | SKELETON | **new** (entry moves out of cli.py); console script `justwrite-server = justwrite_server.serve:main` (NAME unchanged — the CreateProcessW fix) | **new**; `justvoice-server = justvoice.serve:main` (NAME unchanged) | ✓ already conforms |
| `cli.py` | DOMAIN | dies (serve was its only command) | stays (default-settings, self-test) | stays (translate/check/…) |
| `app.py` | SKELETON | stays; middleware block already the family shape | stays | stays |
| `app_state.py` | SKELETON | stays | stays | **new** — thin set_state/get_state holding data_dir + the workspace handle (real state, currently loose in create_app) |
| `auth.py` | KIT | → `llm_runner.platform` factory; per-app settings-read fn + error domain plugged in; the three copies die | same | same |
| `csrf.py` | KIT | → platform factory (origins + optional regex args); the three copies die | same | same |
| `errors.py` | KIT | JW's version WINS (level-scaled `_log_error` + validation handling) → platform; JV's copy dies; docgen finally gets problem+json beyond auth | same | same |
| `paths.py` | SKELETON | keeps domain paths; `default_data_dir()` comes from platform | same | same (its config-relative workspace paths are DOMAIN and stay) |
| `version.py` | SKELETON | stays (PRODUCT/VERSION/API_VERSION) | stays (+DEFAULT_PORT) | **new** (PRODUCT moves out of appmeta) |
| `models.py` (root) | SKELETON-where-needed | freed once ORM moves to database/ (wire shapes live in api files today — introduce only if/when shared shapes appear) | stays — the cross-language wire shapes (its CLAUDE.md law) | N/A (wire shapes inline; introduce as needed) |
| `database/` | SKELETON-where-SQL | **new package**: `database.py`→`database/session.py`, `models.py`→`database/models.py`, `seed.py`→`database/seed.py`, `demo_seed.py`→`database/` | ✓ already conforms | N/A(by design: domain persistence is committed workspace sidecars + the shared runner DB — paths.py's documented layout; no app-owned SQL) |
| `api/` | SKELETON | ✓ exists; files rename to `<area>_api.py` | ✓ already conforms (`<area>_api.py`) | **new package** — routes move out of app.py/workspace.py into `workspace_api.py`, `setup_api.py`, `health_api.py`, … |
| `api/<area>_api.py` naming | SKELETON | rename ~10 files | ✓ | new files follow |
| `health_api.py` shape | SKELETON | one family base shape (camelCase wire: status/product/version/apiVersion) + per-app extras (JW dbReady · JV engines · docgen minimal) | same | same |
| seed files (`seed_presets.py`, `seed_feature_prompts.py`, …) | DOMAIN | stay at package root, same names ×3 where they exist | ✓ | ✓ (its config/ seeds stay) |
| seeding CALL SITE | SKELETON | already serve-time (its pytest-isolation rationale WINS family-wide) | moves create_app→serve.py — **flagged risk**: JV tests may rely on create_app-time preset seeds; the executing piece audits them first | boot_llm_stack split: wiring stays in create_app, data seeding to serve-time (same flag) |
| domain modules | DOMAIN | `book_io.py`, `rag_search.py`, … stay at root | `engines/`, `audio/`, `extraction/`, `storage/`, `mastering.py`, … stay | pipeline modules (`engine.py`, `loop.py`, `checks.py`, …) stay at root |
| dead weight | — | `llm/` (only `__pycache__`) DIES | `justvoice_plugin/` reviewed in its piece | — |

Rule of thumb the table encodes: **open any server and `api/`, `database/`,
`serve.py`, `app.py` mean the same thing; everything infra is a platform
import; only the domain nouns differ.**

## 2 · The renderer — `src/`

| Item | Class | Target |
|---|---|---|
| lanes | SKELETON | `components/ views/ stores/ services/ composables/ router/ styles/` in all three; `i18n/` present where the app localizes (JW full · JV scaffold · docgen none — allowed, stated) |
| `styles/` | SKELETON | tokens.css + styles.css move to `src/styles/` in JW and JV (the standard as written; docgen already conforms) |
| Home view | SKELETON | `HomeView.vue` ×3 — JV renames OverviewView.vue (router name follows) |
| Keyboard help | SKELETON | `KeyboardCheatsheet.vue` — JW renames ShortcutCheatsheet.vue |
| tests placement | SKELETON | beside the file (`X.test.js` next to `X.js`) — the 2-of-3 convention; JW's `__tests__/` dirs flatten (mechanical, ~dozens of files, import paths adjust one level — flagged churn) |
| ui store | SKELETON | `useUiStore` casing ×3 (JV renames); prefs SERVER-backed ×3 (docgen leaves localStorage — depends on P9) |
| helpDocs / boot.smoke / py.js+resolver | KIT | promoted; apps keep one-line adapters |
| kit panels | KIT | JW adopts `AppearancePanel` for the family rows (its manuscript theming stays via extraApply — already its own file's design) |

## 3 · Config layer

| Item | Target |
|---|---|
| dev ports | JW 1420 · JV 1430/1431 · docgen **1450/1451** (off JW's port; tauri.conf devUrl follows) |
| biome | schema 2.4.16 + docgen's wider includes (`src/**` + `scripts/**` + vite config), ×3 |
| vite build | JW's shape (per-platform targets, minify-unless-debug) ×3; alias `@renderer` ×3 (JV's extra `@` dies; docgen gains) |
| `.gitattributes` | one family answer for line endings (the e2e driver "drift" was CRLF/LF) |

## 3b · The alias registry — every alias file, and the sweep scope if we dissolve them

**What an alias is (and is not).** The implementation lives ONCE in the kit;
the app keeps a file at the old import path whose entire content is a
re-export. It is code reuse, not a workaround: there is no logic in the app
file to drift, and the guard holds each alias to exactly its re-export shape.
The alternative — rewriting every consumer to import the kit directly — is
the "sweep": same end state, more churn. Each alias below lists its sweep
scope so the user can order the sweep any time.

| Alias file | Re-exports | Sweep scope (files importing via the alias) |
|---|---|---|
| `justvoice/errors.py` | kit `platform.errors` helpers + ApiError | ~127 files (`grep -rl "from \.\.errors import\|from \.errors import" server/justvoice`) |
| `justwrite_server/errors.py` | same | 1 file |
| docgen | — no alias: nothing imported its errors module | 0 |

NOT aliases (real per-app seams, permanent): each app's `auth.py` holds only
its `read_auth()` settings-read; each app's `paths.py` holds its domain paths.
CSRF has no seam at all — pure kit, parameterized in app.py.

## 4 · Execution pieces (approved one at a time)

| Piece | Scope | Size |
|---|---|---|
| P2 | **DONE 2026-08-08** — kit `platform` grew auth/csrf/errors (JW's errors won: status-scaled logging + the 422 handler, now in all three registrants); per-app copies died to seams (`read_auth`) + aliases (§3b); `default_data_dir` DROPPED from scope on the adversarial pass (JV's resolution is Rust-compat-frozen — sharing 5 lines wasn't worth data-dir risk); docgen's problem+json handler adoption DEFERRED (6 tests assert error bodies — rides a later piece with its own audit). Gates: JW 122 · JV 409 · docgen 152 · kit 769 (1 pre-existing Linux-lspci env failure on Windows) | M |
| P3 | **DONE 2026-08-08** — serve.py in JW+JV (docgen's donor shape; JV keeps settings-derived host/port + cli.py as the domain CLI via `python -m justvoice.cli`, serve command removed — one door per purpose; JW's cli.py died with its test replaced); console scripts → `<snake>.serve:main` with the `-server` NAMES kept; npm `server` scripts + BOTH Rust `-m` fallbacks retargeted; editable reinstalls verified the installed commands run serve:main; JV gained the `screenshots` script (smoke_gui). **The guard reads ZERO violations** — first clean run since it was built. Gates: JW 122 · JV 409. Three grandfather notes closed (JW TASKS, JV TASKS, the standard). | S |
| P4 | **DONE 2026-08-08** — docgen's tree opens like the family: `api/` package (`health_api.py` + `server_auth_api.py` + `setup_api.py` + `workspace_api.py`; server_auth split out on the adversarial pass — the 2-of-3 precedent, JW `api/server_auth.py` · JV `api/server_auth_api.py`; `/reviewer` rides setup_api since the Setup screen owns reviewer identity; jobs + gt-frame stay in workspace_api, coupled to workspace internals), `app_state.py` (family set_state/get_state; `app.state.workspace` died — 5 test reads + 3 make_send monkeypatch targets retargeted), `version.py` (PRODUCT/VERSION/API_VERSION/DEFAULT_PORT; correction: PRODUCT lived in app.py, not appmeta as the §1 cell said). Preview helpers stay in workspace.py — domain prompt-building, test_preview imports them there. Wire shapes byte-identical (health reshape + seeding call-site are P6). Two PRE-EXISTING ruff findings in app.py (fire on HEAD too) fixed in passing. Gates: docgen 152 pytest + 3 vitest + ruff clean; **the guard stays ZERO**. | M |
| P5 | **DONE 2026-08-08** — JW's tree matches: `database/` package (`database.py`→`session.py`; `models.py`/`seed.py`/`demo_seed.py` in; `__init__` re-exports the stable callables and PEP-562-forwards the init_db-REBOUND `SessionLocal`/`engine` — a plain re-export would freeze the pre-boot None; in-package consumers import `database.session` directly, JV data_admin's own form); 12 api files renamed `<area>_api.py` (git renames); dead `llm/` deleted (held only `__pycache__`, zero tracked files); demo_seed's repo-root samples path corrected `parents[2]`→`parents[3]` for the deeper file. **Dormant bug found by the move, fixed**: `server_auth.py` from-imported `SessionLocal` at module-import time (pre-init None) — GET always reported no-auth, PUT always 503'd, and zero tests covered the route; now late-bound via `database.session`, `test_server_auth.py` pins the roundtrip. Gates: JW **124** pytest (+2) · 566 vitest · ruff clean; **the guard stays ZERO**. | M |
| P6 | health one shape ×3; seeding call-site move (with the JV test audit) | M |
| P7 | renderer commons to kit: helpDocs, boot-smoke skeleton, py.js/resolver | M |
| P8 | renderer tree: styles/, HomeView + KeyboardCheatsheet renames, tests placement, useUiStore casing | M |
| P9 | settings/prefs architecture — JV's split is the family shape (`/v1/settings` operator · `/v1/prefs` renderer, kit owns the prefs router); docgen gains the API + leaves localStorage; JW maps its ui doc | L |
| P10 | config layer (ports, biome, vite build, .gitattributes, **ruff policy** — one family lint ruleset: JV pinned `select = ["E4","E7","E9","F"]` 2026-08-08 after ruff 0.16 widened its defaults to 504 overnight findings; decide here whether the family adopts the wider set, and pin JW + docgen the same way either way) | S |
| P11 | the guard learns THIS PAGE (skeleton assertion per app) + full family gates + audit/status sync | S |

Every piece: adversarial pass → code → the app's full suite → commit/push →
STOP for the next approval. JW is on `master`; JV pushes check the
workflows-disabled precondition before and after.

**Definition of done (tightened by the 2026-08-08 backfill, user ruling):** a
piece is complete only when (a) the touched repos' full suites are green, (b)
the guard is at zero INCLUDING check 7 (retired names — fed from the piece's
own `git diff --diff-filter=DR` old-name list), and (c) the receipted
whole-repo sweep for those names (all file types, all four repos; docs/plans +
the two conversion records exempt as history) is recorded in the status row.
Tests are not the end: a move is finished when NOTHING references the old name.

**The 2026-08-08 backfill (P2→P5 sweep receipt).** The pieces above shipped
with sweeps scoped to the server package — the audit had no reference
inventory, so nothing forced completeness. The backfill swept every retired
name from the P2→P5 diffs (+ the task-queue trio) across all four repos and
found: **three behavioral breaks** — JW `scripts/smoke.js` + `bench/harness/
lib/drive.js` still spawned the DELETED `justwrite_server.cli` (the renderer
gate could not boot a server since P3), and JV `__main__.py` (the PyInstaller
sidecar target + `python -m justvoice`) still ran `cli.app`, whose serve
command died in P3 — a frozen sidecar would print help and exit; **one
user-facing doc lying threefold** — JV `docs/run-modes.md` documented the
removed `--no-docs` flag, the utility subcommands on `justvoice-server` (they
moved to `python -m justvoice.cli`), and the then-broken `python -m
justvoice`; **stale live-doc/comment refs** — JW `docs/dev/ARCHITECTURE.md`,
`architecture-notes.md`, `rag-design.md`, `src/stores/ai.js`,
`src/services/analysis/{critique,sweepDraft}.js`, `src/services/rag/
vectorStore.js`, `scripts/py.js`, `tests/test_book_transfer.py`,
`database/models.py` (own comments); docgen root `README.md` + `src/stores/
review.js`; JV `scripts/py.js`; kit `ui/README.md` (still documented the dead
Lu* primitives and PromptLab). All fixed; check 7 now guards every name.
Classified VALID and left: docs/plans/** (history), provenance prose that
DESCRIBES a deletion (test_serve.py, JV cli.py docstring, CONCEPTS.md,
kitTaskQueue.test.js), the audit ledger's point-in-time records. Also
recorded: P4's route tags changed in the OpenAPI doc (workspace → setup/
system grouping) — wire paths and bodies unchanged; stated here because
"byte-identical" overclaimed. Gates after the backfill: JW 124 pytest + 566
vitest + ruff · JV 409 pytest + 28 vitest (`python -m justvoice --help` now
prints the serve usage) · docgen 152 pytest + 3 vitest · kit 769 pytest (the
known Windows-lspci env failure) · guard ZERO with check 7 active. Open,
needs its own go: the repaired JW smoke boots and drives 24/24 route surfaces
with zero JS errors, but 3 interactive probes fail deterministically (boot
splash wait, ai-tab click, sampler-order subnav click) — unrunnable since P3
broke its spawn, failures sit in the chrome the 2026-08-07 TitleBar commit
changed; pre/post attribution needs a pre-P3 checkout run. JV's own `ruff
check .` gate fails on clean HEAD with 504 findings under ruff 0.16.1's
widened defaults (pre-existing; a lint campaign is its own decision).

**Both opens CLOSED same day (the attribution + gate-repair pass):**

- *The smoke's 3 probe failures* — attributed by checkout matrix (JW@HEAD,
  JW@P2, JW@pre-TitleBar × kit@HEAD; JW@pre-TitleBar × kit@pre-batch): the
  SAME 3 failures at every cell → older than the program and the batch. Root
  cause, one line: the 2026-08-04 kit `BootModelLoad` adoption replaced JW's
  splash skip button, the smoke's escape still clicked the dead `.jw-bw-skip`,
  the z-3000 splash overlay never cleared headless (the snapshotted REAL data
  root carries warm-startup on), and every interactive probe timed out under
  it — while hash-navigation route sweeps sailed through, which is why it read
  as "3 odd failures" instead of "the overlay is up". Fixed: the escape clicks
  `.lu-bootload__skip`; App.vue's orphaned `.jw-bw-skip:hover` skin re-hung on
  the kit class; `/jw-bw-skip\b/` added to check 7. **The JW smoke gate is
  fully green** — all routes, all five ai-tabs, sampler-order, provider-form,
  zero JS errors — for the first time since at least the batch window.
- *JV's ruff gate* — evidence-first: HEAD showed 8 findings even under the
  written-against ruleset (5×E402 mid-file feature-section imports in
  voices_api moved to the top block, 3×F401 dead imports removed), then the
  ruleset was PINNED in pyproject (`[tool.ruff.lint] select`) so the gate
  stops changing meaning when a venv upgrades. `ruff check . && pytest` is
  green on JV again (409). The wider-ruleset adoption question is P10's.
