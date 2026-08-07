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

## 4 · Execution pieces (approved one at a time)

| Piece | Scope | Size |
|---|---|---|
| P2 | kit `platform` grows auth/csrf/errors factories + `default_data_dir`; three apps consume; six per-app copies die | M |
| P3 | serve.py in JW+JV; console-script targets; npm `server` scripts; JW cli.py dies — clears all 7 guard violations | S |
| P4 | docgen tree: `api/` package + `app_state.py` + `version.py` | M |
| P5 | JW tree: `database/` package + api `_api` renames + `llm/` dies | M |
| P6 | health one shape ×3; seeding call-site move (with the JV test audit) | M |
| P7 | renderer commons to kit: helpDocs, boot-smoke skeleton, py.js/resolver | M |
| P8 | renderer tree: styles/, HomeView + KeyboardCheatsheet renames, tests placement, useUiStore casing | M |
| P9 | settings/prefs architecture — JV's split is the family shape (`/v1/settings` operator · `/v1/prefs` renderer, kit owns the prefs router); docgen gains the API + leaves localStorage; JW maps its ui doc | L |
| P10 | config layer (ports, biome, vite build, .gitattributes) | S |
| P11 | the guard learns THIS PAGE (skeleton assertion per app) + full family gates + audit/status sync | S |

Every piece: adversarial pass → code → the app's full suite → commit/push →
STOP for the next approval. JW is on `master`; JV pushes check the
workflows-disabled precondition before and after.
