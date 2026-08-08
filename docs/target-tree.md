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
| `api/<area>_api.py` naming | SKELETON | rename ~10 files (P5: 12 renamed) | ✓ (health.py was the ONE exception — renamed in P6) | new files follow |
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
| biome | one config ×3: docgen's wider includes (`src/**` + `scripts/**` + vite config), CLI exact-pinned (2.5.6 as of P10) with the schema matching it — "2.4.16" was the pre-P10 state's number; lint scripts run `biome check .` so the includes actually gate |
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
| P6 | **DONE 2026-08-08** — *Health*: the base shape was already JW's exact wire and JV carried it too — only docgen moved (`{ok,product}` → `{status,product,version,apiVersion}`); kit `checkServer` proven body-agnostic (reads HTTP status only), Rust `server_health` a pass-through, no renderer reads docgen's body. SCOPE CALLS: JV's legacy snake duplicates (`api_version`) + engine extras left untouched — consumer-facing wire (JW→JV boundary), not this row's mandate; JV `api/health.py`→`health_api.py` renamed here, CORRECTING the §1 naming row's "JV ✓" claim (this one file wasn't). *Seeding call-site*: JV's create_app bundle (effect/render presets · warm-OFF default · legacy prompt/provider migrations · seed_llm · tunable-lift · catalog retirement · registry boot) moved VERBATIM into `database/seed.py::seed_workspace()` with the order contract documented; serve.py calls it; the factory-reset path stays on its own `reseed_shared_llm` bundle (reset semantics, no migrations). docgen's `boot_llm_stack` split: wiring stays, `seed_llm_stack()` (seed_llm + gemma-3 retirement + registry boot) called by serve.py AND the CLI door. THE FLAGGED AUDIT, measured by suite: JV 24 tests in 11 files relied on create_app-time seeds — each now calls `seed_workspace()` explicitly (a test that needs seeds says so — the JW philosophy); docgen 6 tests in test_engine → fixture seeds explicitly. LIVE PROOF: docgen's real serve door on a scratch port returned the family shape AND seeded providers, killed by port. Retired-name sweep: `api/health.py` (JV) — only archive history references it; check 7 holds it. Gates: JV 409 pytest + ruff(pinned) + 28 vitest · docgen 152 + ruff + 3 vitest · JW untouched · guard ZERO. | M |
| P7 | **DONE 2026-08-08** — renderer/tooling commons to the kit; NOTHING deleted or renamed — every app file stays at its path as a thin adapter with its export surface preserved (consumer edits: ZERO; `git diff --diff-filter=DR` empty ×4 repos → the retired-name list is EMPTY, check 7 gains nothing; live-doc mentions swept: JW ARCHITECTURE/ui-kit/CLAUDE + JV CONCEPTS all still literally true — VALID). *helpDocs*: kit `makeDocsHelpAdapter(loaders, toc, {webBase})` (`common/services/helpDocs.js`, on the barrel) absorbs the three hand-copies; what stays app-side is what vite resolves file-relatively — the `import.meta.glob` + toc import ("one-line adapter" honestly = glob + toc + one factory call); JW keeps HELP_TOC/HELP_WEB_BASE/webUrlFor; docgen adopts family semantics (README→index alias + session cache — a no-op today, it has no docs/README.md). *boot-smoke*: kit `test/bootSmoke.js` `registerBootSmoke({boot, routes, ready})` — imports vitest so it must NEVER ride the barrel (subpath import only); the app file keeps the immovables (`@vitest-environment` pragma, the `import("./main.js")` thunk) + its route map + ready probe (JW `__jwBench`, JV/docgen `__bootErr`). *py.js/resolver*: kit `scripts/lib/exec-resolve.mjs` (findChrome/chromeLaunchOptions/findPython/runPython/sleep/isUp/waitReady; JW's better lineage won — signal-aware exit + spawn-error hint, JV/docgen gain both); node scripts don't see the vite alias → FILE-RELATIVE cross-repo imports; per-app facts stay in the doors (JW_CHROME/JW_PYTHON + root `.venv` · JV_CHROME/JV_PYTHON + `server/.venv` · JAID_PYTHON + `server/.venv`). CONSEQUENCE stated, not silent: `test:server` now requires the kit sibling checkout (the renderer always did). SCOPE CALLS: docgen gains NO smoke-common (it has no Playwright scripts); JW `tests/probes/` private lookup copies remain a JW TASKS item; JW smoke-common's stale "19 copies" header corrected in passing. Docs in-change: JV CLAUDE.md one-home section (implementation → kit, the door stays) + app-structure.md's "self-contained" py.js line; JW/docgen py.js + helpDocs doc lines verified still-true. Gates: biome ×4 clean (JV's 2 infos pre-existing in labTestData.js; kit linted via docgen's chain) · vitest JW 566 · JV 28 · docgen 3 · pytest THROUGH the new launcher JW 124 · JV 409 · docgen 152 · kit 769 via JW's new adapter (the known Windows-lspci env failure) · JW Playwright smoke PASSED (its server + browser resolved through the kit) · JV smoke PASSED 15/15 views zero JS errors ×2 on 8741/`JV_BASE` (one cold-start flake against the fresh scratch server preceded them; server killed by port) · guard ZERO (8 advisories, all pre-existing). | M |
| P8 | **DONE 2026-08-08** — the renderer tree matches; **docgen needed ZERO changes** (already conformant on all five items — its gates not run, nothing to gate). *styles/*: tokens.css + styles.css → `src/styles/` in JW + JV (git renames; main.js imports follow; JW `fonts.css` STAYS at src/ root — not in the ratified cell, stated not silent; the one file-reading consumer `panelDismissAndNoDim`'s `readJw("styles.css")` retargeted; JW README tree updated). *HomeView*: JV `OverviewView.vue`→`HomeView.vue`. DISCOVERY that set the scope: JV's nav is fully COUPLED — `goView(id)` pushes `/${id}` and active-state compares `route.name !== id` — so "router name follows" honestly means name + nav id + path move together: route `{path:"/home", name:"home"}`, `/` and the catch-all redirect there, **`/overview` lives on as a legacy redirect** (the `/engines` precedent in the same file); `sidebar.overview` i18n key → `home`; the FUNCTIONAL `HELP_SLUG_BY_VIEW.overview` key → `home` (Home's topbar "?" kept its doc only via fallback); e2e.js VIEWS + warm-up goto → `#home`; six live prose comments naming the dead view fixed; the USER HELP CORPUS named the screen "Overview" twice (`getting-started.md`) — fixed under the docs law; `initialDeepLink` first-run logic verified boolean-only, untouched. *KeyboardCheatsheet*: JW `ShortcutCheatsheet.vue`→`KeyboardCheatsheet.vue` (App.vue import+tag; helpMarkdown.test prose; JV already conformed, docgen has no cheatsheet — feature absent, N/A). *tests placement*: JW's five `__tests__/` dirs flattened — 49 git renames, quoted `../` paths stripped one level by script (comment lines skipped so prose paths survive); REVIEW CAUGHT TWO CASUALTY CLASSES: `loadTaskAdapter`'s `toContain('from "../…"')` assertion strings describe KIT file contents and were wrongly rewritten — reverted; `panelDismissAndNoDim`'s everywhere-walk skipped `__tests__` dirs and would have walked into its own regex after the flatten — the skip became "skip `.test.js` files", the honest equivalent under beside-the-file placement; five stale hop-comments fixed; vitest include (`src/**/*.test.js`) + biome already covered the new placement — zero config changes; 59 files / 566 tests, identical counts, zero losses. *useUiStore*: JV recased `useUIStore`→`useUiStore` (3 files; the `defineStore("ui")` id untouched); the prefs-server-backed half of that row is P9's. GUARD: check 7 gained the P8 names (`__tests__`, `ShortcutCheatsheet`, old css path forms ×2 apps, `OverviewView`, `useUIStore`, the `"overview"` id/name/key forms — `/overview` as a PATH stays legal in the redirect, allowlisted provenance comment); its walker learned two things the new patterns exposed — `models/` dirs are downloaded artifacts (HF BPE vocabs contain the literal token `"overview":`; only tracked models/ entry family-wide is a .gitkeep) and `report/` is committed generated history (stale jscpd capture still naming the pre-rebuild tree). Gates: JW biome + 566 vitest + 124 pytest + build + smoke PASSED · JV biome + 28 vitest + 409 pytest + build + smoke PASSED 15/15 first try (HOME rides the renamed route) · guard ZERO with the new patterns armed · JV e2e.js edit exercised only when the packaged-app check next runs (it is not the quick gate). | M |
| P9 | **DONE 2026-08-08** — the family `/v1/prefs` door exists ×3 with ONE router. *Kit server*: `platform/prefs_api.py` `make_prefs_router(read_all, write_many, clear)` — JV's donor contract verbatim (GET whole doc · PATCH wholesale-per-key, returns merged · DELETE 204), storage a host seam (the make_data_router pattern), SQLAlchemy-free so the lazy platform `__init__` stays safe; contract pinned by kit `tests/test_prefs_api.py` over dict hooks. *JV*: `api/prefs_api.py` keeps its path/wire, internals = kit router + hooks over the `prefs` table; hooks LATE-BIND the session (`database.session` module-attr — JV's `SessionLocal` starts None and is REBOUND on init and on a test's re-init, the exact P5 server_auth dormant-bug class, caught in-piece); the pre-existing `test_prefs.py` passes unchanged over the kit router = the wire pin. *JW ("maps its ui doc")*: its `/v1/settings` always WAS the renderer document (its own docstring), mixed with operator rows (auth/cors/D3b) — new `api/prefs_api.py` maps the SAME rows onto the family door; DELETE = the D3b-aware clear (PRESERVED_FOLDER_KEYS imported from settings_api — one source of truth); new `test_prefs.py` pins same-document + wholesale + D3b survival. SCOPE CALL stated: the deeper JW split (operator rows → a typed /v1/settings; renderer sections only here) is recorded FUTURE work, not this mapping; JW's renderer stays on settings.js (already server-backed — the row's mandate was the door). *docgen*: prefs = `pref.*` JSON rows in `app_settings` (appmeta) — NOT a loose file, so they ride app.db's existing /v1/data backup/restore/reset; DELETE drops only `pref.*` (the reviewer row is operator config and stays — pinned by its new `test_prefs.py`); the renderer's ui store LEFT localStorage (appearance wrapper-doc shape preserved, flags become real booleans; old `jaid.*` values silently ignored — the no-migrations rule, user resets); main.js awaits `bootPrefs()` inside the boot IIFE before the store's first init, theme still applied pre-mount under the static plate; the dead-server path never needs prefs (ConnectionError branch precedes). *Kit UI*: `ui/src/services/prefs.js` (JV's client verbatim — reactive cache, debounced PATCH, unload flush) on the barrel; JV's `services/prefs.js` is now the door (kit re-export + its domain `ensureActiveProjectDefault`), consumers untouched; boot-smoke `/v1/prefs` stubs normalized to `{}` (the document IS the top-level object). CHECK 7 CAUGHT ONE IN-PIECE: docgen's e2e asserted persistence via `localStorage.getItem('jaid.appearance')` — converted to a node-side GET of `/v1/prefs` asserting the wrapper on the server. Retired names armed: `jaid.(appearance|aiOfferShown|keepServerRunning)`. LIVE PROOFS: JV's serve door on 8741 and docgen's on 8799 each round-tripped a PATCH→GET through the kit router (killed by port). Gates: kit 773 pytest (+4; known lspci env failure) · JW 128 (+4) + 566 vitest + build + smoke PASSED · JV 409 + 28 + build + smoke PASSED (wire pin green) · docgen 155 (+3) + 3 vitest (boot smoke now exercises bootPrefs) + build · biome ×4 clean · guard ZERO. | L |
| P10 | **DONE 2026-08-08** — the config layer converges. *Ports*: docgen left JW's pair for its own — vite 1450 + HMR 1451, tauri devUrl in lock-step; THE CASCADE the adversarial pass forced: the kit resolver's `devPorts`, the server's CSRF `app_origins` ×2 (missing it = every dev POST 403s), CLAUDE/README dev-loop lines — and check 7 then caught the last two live refs the sweep missed (`test_app`/`test_csrf` asserting `localhost:1420` is an ACCEPTED origin). *biome*: ONE config byte-identical ×3 (docgen's wider includes adopted: `src/**` + `scripts/**` + vite config) — but the ratified "schema 2.4.16" was the OLD state's number: with the 2.5.x CLIs, `biome check .` nags the mismatch forever, so the piece's own lesson applied — CLI EXACT-PINNED `2.5.6` ×3 (carets died), configs `biome migrate`d to the matching schema; AND the includes were dead theater until the lint SCRIPTS moved off `biome check src` to `biome check .` (adversarial catch — a path arg overrides includes). New-surface fallout: ~38 findings across JW+JV scripts, every auto-fix diff REVIEWED line-by-line (template/`node:`-protocol conversions, all behavior-identical, JV's two old labTestData infos died in the same pass), 3 suspicious-class errors hand-fixed (`??=`/`||=`-in-expression ×2, forEach-return); zero findings ×3 after. *vite build*: JW's SHAPE ×3 (per-platform targets chrome105/safari17 · minify-unless-debug · sourcemap-on-debug; JV's `esnext` + always-sourcemap died; docgen had no build block) — EXCEPT minify is a BOOLEAN, found by a real build failure: JV is on **rolldown-vite** where `minify:"esbuild"` is a deprecated path needing a separate esbuild (JW only survived it because esbuild rides in transitively). DISCOVERED DIVERGENCES, recorded not silently ridden: JW+JV vite ^8 (rolldown) vs docgen vite ^6 (classic) — aligning implementations was NOT ratified here and stays an open family decision. `@renderer` ×3 in vite AND vitest configs (JV's extra `@` died with ZERO imports using it; docgen gained the alias). *.gitattributes*: one answer ×4 (`* text=auto` · `.bat/.cmd` CRLF · `.sh` LF); `git add --renormalize .` staged ZERO extra files — all four repos already stored LF; the file makes it a guarantee. *ruff*: the family pin `select=["E4","E7","E9","F"]` lands in JW + docgen + THE KIT (×4 with JV; "one family ruleset" read as family-wide); recorded DOWNGRADE stated: docgen WAS clean under the 0.16 wide defaults (its FLY002 fixture ignore died as dead config) — wide adoption stays open, recorded cost JV's ~504; the pin's E7 caught 2 real E731s in docgen's checks.py (the wide defaults exclude E731!) — fixed as defs. app-structure.md truth-fixes: per-app ports, `biome check .`, the dead ":1420 via the proxy" DoD line, and "dist/ committed" (FALSE — dist is gitignored ×3, verified). Retired names armed: docgen 1420-origin forms + FLY002, `"lint": "biome check src"` + `schemas/2.4.` ×3, JV's `"@":` alias key. Gates: pytest JW 128 · JV 409 · docgen 155 (the two origin-test fixes) · kit 773 (+known lspci) · vitest 566/28/3 · lint zero-info ×3 (kit chain clean) · ruff clean ×4 under the pin · builds ×3 green under boolean minify · JW smoke PASSED · JV smoke PASSED through its OWN lint-fixed smoke.js · guard ZERO. | S |
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
