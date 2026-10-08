# SPDX-License-Identifier: MIT
"""Dump an app's FULL route table (its own routes + the kit's) from its Python app's OpenAPI,
for the route diff's app mode. Run with the APP's interpreter:

    <app venv python> app-routes.py docgen > routes.json
"""

from __future__ import annotations

import json
import os
import sys
import tempfile

os.environ.setdefault("JUST_AI_HOME", tempfile.mkdtemp(prefix="app-routes-home-"))


def docgen():
    from just_ai_i18n_docgen.app import create_app

    return create_app(tempfile.mkdtemp(prefix="app-routes-"))


def justwrite():
    from pathlib import Path

    from justwrite_server.app import create_app

    return create_app(Path(tempfile.mkdtemp(prefix="app-routes-")))


def justvoice():
    from pathlib import Path

    from justvoice.app import create_app

    return create_app(Path(tempfile.mkdtemp(prefix="app-routes-")))


def justvoice_modules():
    """(METHOD, path) → the justvoice.api module that serves it — the route diff tells a route a
    later port hasn't reached ("not ported yet") from a real difference by it."""
    import importlib
    import pkgutil

    import justvoice.api as api

    out = {}
    for info in pkgutil.iter_modules(api.__path__):
        mod = importlib.import_module(f"justvoice.api.{info.name}")
        router = getattr(mod, "router", None)
        for r in getattr(router, "routes", []) or []:
            for m in getattr(r, "methods", None) or []:
                out[(m, r.path)] = info.name
    return out


APPS = {"docgen": docgen, "justwrite": justwrite, "justvoice": justvoice}

if __name__ == "__main__":
    app = APPS[sys.argv[1]]()
    modules = justvoice_modules() if sys.argv[1] == "justvoice" else {}
    rows = []
    for path, ops in app.openapi()["paths"].items():
        for m, op in ops.items():
            params = [{"name": p["name"], "in": p["in"], "required": bool(p.get("required"))} for p in op.get("parameters", [])]
            row = {"method": m.upper(), "path": path, "operationId": op.get("operationId", ""), "params": params}
            if modules:
                row["module"] = modules.get((m.upper(), path), "")
            rows.append(row)
    rows.sort(key=lambda r: (r["path"], r["method"]))
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(rows, indent=1))
