# SPDX-License-Identifier: MIT
"""Dump the Python kit's full route table — every route a host gets from llm_runner — as
JSON: the checklist the JavaScript port and the route diff are measured against.

Builds a bare FastAPI app the way a host does (install_llm + the runner router + the
platform routers) on a throwaway database, then lists method, path and handler. Run with
an interpreter that has llm_runner installed (JustWrite's venv):
    python scripts/route-table.py > scripts/route-table.json
"""

from __future__ import annotations

import json
import os
import sys
import tempfile

os.environ.setdefault("JUST_AI_HOME", tempfile.mkdtemp(prefix="route-table-home-"))

from fastapi import FastAPI  # noqa: E402
from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402


def main() -> int:
    tmp = tempfile.mkdtemp(prefix="route-table-")
    eng = create_engine(f"sqlite:///{os.path.join(tmp, 'kit.db')}")
    sf = sessionmaker(bind=eng)
    app = FastAPI()
    from llm_runner import router as runner_router
    from llm_runner.llm.install import install_llm
    from llm_runner.platform import make_data_router, make_disk_router, make_logs_router, make_prefs_router

    install_llm(app, engine=eng, session_factory=sf, data_dir=tmp, product="route-table")
    app.include_router(runner_router)
    for make, kw in (
        (make_logs_router, {}),
        (make_disk_router, {"data_dir": tmp}),
        (make_prefs_router, {"read_all": lambda: {}, "write_many": lambda d: None, "clear": lambda: None}),
        (make_data_router, {"get_db_path": lambda: os.path.join(tmp, "kit.db"), "metadata": [],
                            "run_reset": lambda: None}),
    ):
        try:
            app.include_router(make(**kw))
        except TypeError as e:  # a factory's signature differs — say so, don't guess
            print(f"skipped {make.__name__}: {e}", file=sys.stderr)
    # FastAPI 0.139 keeps included routers behind a lazy wrapper, so `app.routes` doesn't
    # list them — the OpenAPI document does, with every prefix applied.
    rows = []
    for path, ops in app.openapi()["paths"].items():
        for m, op in ops.items():
            params = [{"name": p["name"], "in": p["in"], "required": bool(p.get("required"))}
                      for p in op.get("parameters", [])]
            rows.append({"method": m.upper(), "path": path, "operationId": op.get("operationId", ""),
                         "tags": op.get("tags", []), "params": params})
    rows.sort(key=lambda x: (x["path"], x["method"]))
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(rows, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
