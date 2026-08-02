# The family app structure — the standard for every app, current and future

Ruled 2026-08-02 after the layout question came up for the third time. This is the ONE
place the answer lives; JW, JV and just-ai-i18n-docgen comply, and a future app copies
this shape without re-deriving it.

## The shape

```
<app-repo>/                     kebab-or-whatever repo name (justwrite-app, JustVioce, just_ai_i18n_docgen)
├── index.html                  ┐
├── package.json                │  the UNTOUCHED create-tauri-app scaffold:
├── vite.config.js              │  Vite + Vue at the root, Rust shell in src-tauri/.
├── public/                     │  NEVER src/renderer/ — that was an Electron habit
├── src/                        │  that cost two apps a restructure to unwind.
├── src-tauri/                  ┘
└── server/                     the Python FastAPI server (create-tauri-app knows nothing
    ├── pyproject.toml          about this — it is OUR addition, one folder, self-contained)
    ├── <package_name>/         the import package: snake_case, flat layout
    │   ├── __init__.py
    │   └── app.py              create_app(data_dir) factory
    ├── tests/                  pytest; testpaths = ["tests"]
    └── .venv/                  gitignored; per-app
```

Current packages: `server/justwrite_server/` · `server/justvoice/` ·
`server/just_ai_i18n_docgen/`. Ports: JW 17495 · JV 8741 · i18n-docgen 8742 — a new app
claims a fresh port here.

## Why the Python package repeats the app's name (the JS-vs-Python trap)

This came up because in JavaScript the right layout IS `server/src/` with no name
anywhere — Node imports by FILE PATH (`import "./src/foo.js"`), and the name lives only
in package.json. Anyone coming from JS correctly expects that.

**Python imports by NAME, not path.** The package folder's name IS the import name, the
console-script target, and what pip installs:

```python
from justvoice.models import ...          # because the folder is justvoice/
console script: justwrite_server.cli:main # because the folder is justwrite_server/
```

Name the folder `src` and the app's import name is literally `src` — and since EVERY app
would then be `import src`, no two family apps could ever share a venv (they do today:
llm-runner's suite runs in JW's venv). This is why every Python project on earth repeats
its name one level down: `fastapi/fastapi/`, `django/django/`, `just-llm-runner/llm_runner/`.

**The authority** (PyPA, packaging.python.org, "src layout vs flat layout" — verified
2026-08-02): there are exactly TWO standard layouts, and the package directory carries
the project name in BOTH:

- **flat**: `server/<package_name>/` — ours.
- **src-layout**: `server/src/<package_name>/` — the name still appears; `src/` is only
  a wrapper. Its stated advantages (import-parity during testing) matter for PUBLISHED
  libraries; these servers are never published.

Bare `server/src/` with modules directly inside is **not a layout PyPA describes as
valid** and is not used here.

**The family ruling: flat — the USER's explicit decision, 2026-08-02**, made with both
options and their full costs surfaced (src-layout everywhere was offered as a ~1-hour
4-repo migration and declined). Not a session's assumption. The reasoning: all four repos
already comply; src-layout's advantages target published libraries and none of these are
ever published (the servers are PyInstaller-frozen applications; llm-runner is
deliberately git-consumed, never on PyPI); and the ecosystem itself is split at the top
tier (pip/Poetry/Flask are src; FastAPI/Django/NumPy are flat), so neither choice is
"more professional" — consistency is the value, and flat is where the family already is.

## The server's non-negotiables (established elsewhere, indexed here)

- `create_app(data_dir)` factory; data dir from `platformdirs`; console script
  `<name>-server` (the `-server` suffix stops Windows spawning the Tauri binary).
- The LLM stack is the shared standard — three lines, never à la carte
  (README "Consume it"): mount `llm_runner.router`, `install_llm(...)`, `seed_llm()`,
  registry from the DB store. `data_dir` ALWAYS passed.
- llm-runner is an editable install in dev, pinned tag in the bundle extra
  (JW's pyproject pattern, reasons in its comment).
- Wire shapes are camelCase (the shared `CamelModel` contract).
- Frontend consumes `@delebash/llm-ui` via the Vite source alias to the sibling clone.
- Vue side: hash router, per-domain Pinia stores, `tokens.css` + `styles.css`,
  origin-aware serverApi, Biome.
