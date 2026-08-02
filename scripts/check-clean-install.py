#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Clean-install audit — does this package work for an app that is NOT JustWrite?

WHY THIS EXISTS (2026-08-01). `pyproject.toml` was missing `sqlalchemy` for the repo's
entire life and nothing noticed, because nothing could: JustWrite and JustVoice each declare
`sqlalchemy>=2.0` in their OWN dependency lists, and this repo has no venv — the suite runs
on JustWrite's interpreter (CLAUDE.md), where every host dependency is already present. The
one environment the library actually claims to support, "a fresh app that pip-installs it",
was the one environment never tested. Measured cost of the gap: `llm_runner.llm` and
`llm_runner.platform` both failed to import, taking 11,773 of 19,720 lines with them.

A missing dependency is invisible to a test suite that runs where the dependency exists. So
this does the only thing that can see it — builds a throwaway venv, installs the package with
ONLY its declared dependencies, and imports every module inside it.

Three checks, and each must bite:
  1. FULL     — with the declared dependencies installed, EVERY module imports. This is the
                one that fails if a dependency is missing from pyproject.toml.
  2. STORAGE-FREE — with SQLAlchemy deliberately REMOVED, the storage-free core still
                imports (runner, adapters, dispatch, registry, tiers, schema, and the two
                stdlib platform routers). This is the one that fails if a package `__init__`
                regresses to an eager `from .db import ...` — the exact shape of the original
                defect, which made one optional-feeling import fatal for the whole package.
  3. STRANGER'S APP — runs BEFORE check 2 removes SQLAlchemy: the bare minimal call,
                `install_llm(app, engine=…, session_factory=…, data_dir=…)` with NO feature
                data, on a bare FastAPI + file-backed SQLite, then seed_llm and the
                representative endpoints. `tests/test_install_llm.py` runs the same call in
                the family venv, where an accidental import of some package the venv happens
                to carry passes silently — the exact blind-spot class that hid the missing
                sqlalchemy for the repo's whole life. THIS run holds only the declared
                dependencies, so it is the one that proves the minimal contract for an app
                that is not JustWrite. Each of the three consumption modes has its check:
                declared deps → 1, library mode → 2, the install_llm standard → 3.

NO CI (repo rule): this is a script a human runs, like `seed-facts-audit.py`. Run it after
touching pyproject.toml, any package `__init__.py`, or any module's import block.

    python scripts/check-clean-install.py            # ~40 s, needs network for the deps
    python scripts/check-clean-install.py --keep     # leave the venv for inspection

Exit codes: 0 = both checks pass · 1 = a check failed · 2 = the harness itself broke.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# The storage-free core: every one of these must import with SQLAlchemy ABSENT. `llm.db`,
# `llm.stores`, `llm.seed`, `llm.install` and `platform.data_api` are deliberately NOT here —
# they ARE the storage layer and are expected to need the ORM.
STORAGE_FREE = [
    "llm_runner",
    "llm_runner.runner.api",
    "llm_runner.runner.hardware",
    "llm_runner.runner.process",
    "llm_runner.runner.lifecycle",
    "llm_runner.llm",
    "llm_runner.llm.dispatch",
    "llm_runner.llm.registry",
    "llm_runner.llm.tiers",
    "llm_runner.llm.schema",
    "llm_runner.llm.base",
    "llm_runner.llm.anthropic",
    "llm_runner.llm.gemini",
    "llm_runner.llm.openai_sdk",
    "llm_runner.llm.openai_compat",
    "llm_runner.llm.ollama",
    "llm_runner.platform",
    "llm_runner.platform.logs_api",
    "llm_runner.platform.disk_api",
]

# Imported by NAME (not walked) so the check states its intent: these are the headline
# entry points the README tells a host app to call.
ENTRY_POINTS = [
    ("llm_runner", "router"),
    ("llm_runner", "RunnerService"),
    ("llm_runner.llm", "install_llm"),
    ("llm_runner.platform", "make_logs_router"),
]

# Runs INSIDE the throwaway venv. Walks every module and reports as JSON on one line.
CENSUS = r"""
import importlib, json, pkgutil, sys
import llm_runner
ok, bad = [], {}
for m in pkgutil.walk_packages(llm_runner.__path__, "llm_runner."):
    try:
        importlib.import_module(m.name)
        ok.append(m.name)
    except BaseException as e:
        bad[m.name] = f"{type(e).__name__}: {e}"
print("__RESULT__" + json.dumps({"ok": sorted(ok), "bad": bad}))
"""

SUBSET = r"""
import importlib, json, sys
names = json.loads(sys.argv[1])
entries = json.loads(sys.argv[2])
bad = {}
for n in names:
    try:
        importlib.import_module(n)
    except BaseException as e:
        bad[n] = f"{type(e).__name__}: {e}"
for mod, attr in entries:
    try:
        getattr(importlib.import_module(mod), attr)
    except BaseException as e:
        bad[f"{mod}.{attr}"] = f"{type(e).__name__}: {e}"
print("__RESULT__" + json.dumps({"bad": bad}))
"""

# Check 3 — the stranger's app, executed where only the declared contract exists.
# argv[1] is a scratch dir for the SQLite file and the runner cache root.
STRANGER = r"""
import json, sys
from pathlib import Path
out = {"bad": {}}
try:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    import llm_runner
    from llm_runner.llm.install import install_llm
    from llm_runner.llm.seed import seed_llm

    scratch = Path(sys.argv[1])
    engine = create_engine(f"sqlite:///{scratch / 'app.db'}")
    SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)

    app = FastAPI()
    app.include_router(llm_runner.router)   # the host's line
    install_llm(app, engine=engine, session_factory=SessionLocal, data_dir=scratch)
    seed_llm()

    client = TestClient(app)
    checks = {
        "providers seeded": lambda: len(client.get("/v1/llm-providers").json()["providers"]) > 0,
        "routing answers": lambda: client.get("/v1/ai/routing").status_code == 200,
        "usage ledger wired": lambda: client.get("/v1/ai-usage").status_code == 200,
        "runner catalog wired": lambda: client.get("/v1/llm-runner/models").json()["catalogWired"] is True,
        "catalog non-empty": lambda: len(client.get("/v1/llm-runner/models").json()["models"]) > 0,
    }
    for label, fn in checks.items():
        try:
            if not fn():
                out["bad"][label] = "assertion returned false"
        except BaseException as e:
            out["bad"][label] = f"{type(e).__name__}: {e}"
except BaseException as e:
    out["bad"]["install_llm bare call"] = f"{type(e).__name__}: {e}"
print("__RESULT__" + json.dumps(out))
"""


def run(*cmd: str, **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def payload(proc: subprocess.CompletedProcess) -> dict:
    """Pull the JSON line out; anything else on stdout/stderr is noise (warnings, pip)."""
    for line in proc.stdout.splitlines():
        if line.startswith("__RESULT__"):
            return json.loads(line[len("__RESULT__"):])
    raise RuntimeError(
        f"probe produced no result line (exit {proc.returncode})\n"
        f"--- stdout ---\n{proc.stdout[-2000:]}\n--- stderr ---\n{proc.stderr[-2000:]}"
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--keep", action="store_true", help="do not delete the throwaway venv")
    args = ap.parse_args()

    tmp = Path(tempfile.mkdtemp(prefix="llm-runner-cleaninstall-"))
    py = tmp / ("Scripts" if sys.platform == "win32" else "bin") / ("python.exe" if sys.platform == "win32" else "python")
    failures: list[str] = []
    try:
        print(f"venv: {tmp}")
        r = run(sys.executable, "-m", "venv", str(tmp))
        if r.returncode != 0:
            print(f"FATAL: venv creation failed\n{r.stderr}", file=sys.stderr)
            return 2

        print(f"installing {REPO} with its DECLARED dependencies only …")
        r = run(str(py), "-m", "pip", "install", "-q", "-e", str(REPO))
        if r.returncode != 0:
            print(f"FATAL: pip install failed\n{r.stdout[-3000:]}\n{r.stderr[-3000:]}", file=sys.stderr)
            return 2

        # ── check 1: with the declared deps, EVERYTHING must import ──────────────
        print("\n[1/3] full import census (declared dependencies present)")
        res = payload(run(str(py), "-c", CENSUS))
        print(f"      {len(res['ok'])} modules imported, {len(res['bad'])} failed")
        for name, err in sorted(res["bad"].items()):
            print(f"      FAIL {name}\n           {err}")
            failures.append(f"[declared-deps] {name}: {err}")
        entry = payload(run(str(py), "-c", SUBSET, "[]", json.dumps(ENTRY_POINTS)))
        for name, err in sorted(entry["bad"].items()):
            print(f"      FAIL entry point {name}\n           {err}")
            failures.append(f"[entry-point] {name}: {err}")
        if not res["bad"] and not entry["bad"]:
            print("      OK — every module and every documented entry point imports")

        # ── check 3 (RUN SECOND — before sqlalchemy is removed): the stranger's app ──
        print("\n[2/3] the stranger's app — bare install_llm + seed + endpoints")
        scratch = tmp / "stranger-scratch"
        scratch.mkdir()
        res = payload(run(str(py), "-c", STRANGER, str(scratch)))
        for name, err in sorted(res["bad"].items()):
            print(f"      FAIL {name}\n           {err}")
            failures.append(f"[stranger-app] {name}: {err}")
        if not res["bad"]:
            print("      OK — the bare minimal call yields a working stack on declared deps only")

        # ── check 2: without SQLAlchemy, the storage-free core must survive ──────
        print("\n[3/3] storage-free core (SQLAlchemy deliberately removed)")
        r = run(str(py), "-m", "pip", "uninstall", "-y", "-q", "sqlalchemy")
        if r.returncode != 0:
            print(f"FATAL: could not uninstall sqlalchemy\n{r.stderr}", file=sys.stderr)
            return 2
        res = payload(run(str(py), "-c", SUBSET, json.dumps(STORAGE_FREE), "[]"))
        for name, err in sorted(res["bad"].items()):
            print(f"      FAIL {name}\n           {err}")
            failures.append(f"[storage-free] {name}: {err}")
        if not res["bad"]:
            print(f"      OK — all {len(STORAGE_FREE)} storage-free modules import without the ORM")
    finally:
        if args.keep:
            print(f"\nvenv kept at {tmp}")
        else:
            shutil.rmtree(tmp, ignore_errors=True)

    print()
    if failures:
        print(f"FAILED — {len(failures)} problem(s):")
        for f in failures:
            print(f"  · {f}")
        print("\nA [declared-deps] failure means pyproject.toml is missing a dependency.")
        print("A [stranger-app] failure means the minimal install_llm contract broke —")
        print("the bare call every non-family app makes (see llm/install.py's docstring).")
        print("A [storage-free] failure means a package __init__ regressed to an eager")
        print("storage import — see the note at the top of llm_runner/llm/__init__.py.")
        return 1
    print("PASSED — the package works for an app that is not JustWrite.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
