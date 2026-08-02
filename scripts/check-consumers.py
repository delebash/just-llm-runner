#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Consumer audit — does every `llm_runner` symbol the sibling apps import still exist?

WHY THIS EXISTS (2026-08-01). JustVoice's live `models.py` imported `LLMRolesSettings` and
`LLMRoleTarget` from `llm_runner.llm.schema`. Commit 7232214 deleted both — and nothing
noticed for weeks, because JV's suite wasn't running and no check connected "symbol deleted
here" to "consumer broken there". A shared package whose consumers can rot silently is not
a standard; it is a collection of forks that happen to share a directory.

What it does: AST-parse every live `.py` under each consumer root, collect every
`from llm_runner… import X` / `import llm_runner…`, then RESOLVE each one against the
llm_runner installed in THIS interpreter. A deleted or renamed symbol fails loudly, named
per consumer file. Build artifacts (`build/`, `dist/`), virtualenvs and `__pycache__` are
excluded — a first run of the ad-hoc version reported 4 stale `build/lib` files among its
6 hits, and a checker that cries wolf gets ignored.

Run it with an interpreter that has llm_runner + deps installed (JW's or JV's venv):

    ../justwrite-app/.venv/Scripts/python.exe scripts/check-consumers.py
    # explicit roots:
    ...python.exe scripts/check-consumers.py ../justwrite-app/server ../JustVioce/server

WHEN: at any change to a shared export — `schema.py`, any `__init__.py`, a router factory
signature, a deleted module. Not CI (repo rule) — a script you run, like its siblings.

Exit codes: 0 = every import resolves · 1 = at least one broken · 2 = harness problem.
"""

from __future__ import annotations

import ast
import importlib
import sys
import warnings
from pathlib import Path

# ast.parse compiles consumer files; their stray `\.`-style escapes are the CONSUMER's
# lint problem, not this audit's finding — keep the report readable.
warnings.filterwarnings("ignore", category=SyntaxWarning)

REPO = Path(__file__).resolve().parent.parent

# Default consumer roots: the sibling apps, when they exist. Explicit args override.
DEFAULT_ROOTS = [
    REPO.parent / "justwrite-app" / "server",
    REPO.parent / "JustVioce" / "server",
]

# Directory names that are never live consumer source.
EXCLUDE_DIRS = {"build", "dist", "__pycache__", ".venv", "venv", "node_modules", ".git",
                "legacy-gui", ".pytest_cache", ".ruff_cache", "*.egg-info"}


def _excluded(path: Path) -> bool:
    return any(part in EXCLUDE_DIRS or part.endswith(".egg-info") for part in path.parts)


def collect(root: Path) -> dict[tuple[str, str | None], list[str]]:
    """(module, symbol|None) → [relative file paths] for every llm_runner import."""
    wanted: dict[tuple[str, str | None], list[str]] = {}
    for f in root.rglob("*.py"):
        if _excluded(f.relative_to(root)):
            continue
        try:
            tree = ast.parse(f.read_text(encoding="utf-8"))
        except (SyntaxError, UnicodeDecodeError):
            continue  # not this script's problem to lint the consumer
        rel = str(f.relative_to(root))
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and (node.module or "").startswith("llm_runner"):
                for a in node.names:
                    wanted.setdefault((node.module, a.name), []).append(rel)
            elif isinstance(node, ast.Import):
                for a in node.names:
                    if a.name.startswith("llm_runner"):
                        wanted.setdefault((a.name, None), []).append(rel)
    return wanted


def resolve(wanted: dict[tuple[str, str | None], list[str]]) -> list[tuple[str, str, str, list[str]]]:
    """Try every (module, symbol); return the broken ones as (module, symbol, error, files)."""
    broken = []
    for (mod, name), files in sorted(wanted.items(), key=lambda kv: (kv[0][0], kv[0][1] or "")):
        try:
            m = importlib.import_module(mod)
            if name is not None and name != "*":
                getattr(m, name)
        except BaseException as e:  # noqa: BLE001 — anything unresolvable is a break
            broken.append((mod, name or "", f"{type(e).__name__}: {e}", sorted(set(files))))
    return broken


def main() -> int:
    roots = [Path(a).resolve() for a in sys.argv[1:]] or [r for r in DEFAULT_ROOTS if r.is_dir()]
    if not roots:
        print("no consumer roots found — pass them as arguments", file=sys.stderr)
        return 2
    try:
        importlib.import_module("llm_runner")
    except BaseException as e:  # noqa: BLE001
        print(f"llm_runner not importable in THIS interpreter ({e}) — run with a venv that has it",
              file=sys.stderr)
        return 2

    total_broken = 0
    for root in roots:
        wanted = collect(root)
        broken = resolve(wanted)
        label = root.name if root.name != "server" else root.parent.name
        print(f"{label}: {len(wanted)} distinct llm_runner imports", end="")
        if not broken:
            print(" — all resolve")
            continue
        print(f" — {len(broken)} BROKEN")
        for mod, name, err, files in broken:
            target = f"{mod}.{name}" if name else mod
            print(f"  FAIL {target}")
            print(f"       {err}")
            for fp in files:
                print(f"       <- {fp}")
        total_broken += len(broken)

    print()
    if total_broken:
        print(f"FAILED — {total_broken} import(s) no longer resolve. Either restore the symbol,")
        print("or fix the consumer in the same change; a deleted export is a breaking change")
        print("to every app that imports it, whether or not its tests are running.")
        return 1
    print("PASSED — every consumer's llm_runner import resolves against this checkout.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
