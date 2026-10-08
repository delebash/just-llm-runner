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


APPS = {"docgen": docgen, "justwrite": justwrite}

if __name__ == "__main__":
    app = APPS[sys.argv[1]]()
    rows = []
    for path, ops in app.openapi()["paths"].items():
        for m, op in ops.items():
            params = [{"name": p["name"], "in": p["in"], "required": bool(p.get("required"))} for p in op.get("parameters", [])]
            rows.append({"method": m.upper(), "path": path, "operationId": op.get("operationId", ""), "params": params})
    rows.sort(key=lambda r: (r["path"], r["method"]))
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(rows, indent=1))
