# SPDX-License-Identifier: MIT
"""Capture a SQLAlchemy declarative base's schema as a JavaScript module.

The family's databases keep today's schema exactly (the Electron move's ruling 5; plan
§10 Q8): a new database must come out with the SAME `sqlite_master` text Python's
`create_all` writes. So the DDL is not re-typed by hand — it is read back from a fresh
database Python just built, table by table in creation order, with each table's indexes.

Beside the DDL it writes the column map the JavaScript store layer needs, because two
things SQLAlchemy does live in Python, not in the database:
  - type conversion on the way in and out — DateTime as "YYYY-MM-DD HH:MM:SS.ffffff",
    Boolean as 0/1 (`kind`);
  - Python-side column defaults (`default=False`, `default=_now`, …), which never reach
    the DDL — an insert that leaves a column out gets them from here (`default`,
    `defaultFn`, `onupdateFn`).

Usage (run with an interpreter that has the base's package installed):
    python capture-schema.py <module:Base> <out.js> [--migrate <module:function>]
e.g. python capture-schema.py llm_runner.llm.db:LlmBase src/llm/db_schema.js \\
         --migrate llm_runner.llm.db:create_all
`--migrate` builds the fresh database with that function (so additive ALTERs, if any
ran on a fresh database, are included) instead of plain `metadata.create_all`.

The output is generated — re-run this when a Python table changes, never edit by hand,
until the Python server is deleted (then the file becomes the source).
"""

from __future__ import annotations

import argparse
import importlib
import json
import os
import sys
import tempfile

import sqlalchemy as sa


def _load(ref: str):
    mod, _, attr = ref.partition(":")
    return getattr(importlib.import_module(mod), attr)


def _kind(col: sa.Column) -> str:
    t = col.type
    if isinstance(t, sa.Boolean):
        return "bool"
    if isinstance(t, sa.DateTime):
        return "datetime"
    if isinstance(t, sa.Date):
        return "date"
    if isinstance(t, (sa.Float, sa.Numeric)) and not isinstance(t, sa.Integer):
        return "float"
    if isinstance(t, sa.Integer):
        return "int"
    if isinstance(t, sa.JSON):
        return "json"
    if isinstance(t, sa.LargeBinary):
        return "blob"
    return "text"


def _fn_name(fn) -> str:
    inner = getattr(fn, "__wrapped__", fn)
    mod = getattr(inner, "__module__", "") or ""
    name = getattr(inner, "__qualname__", repr(inner))
    return f"{mod}.{name}"


def _default(d):
    if d is None:
        return None
    if getattr(d, "is_scalar", False):
        v = d.arg
        if isinstance(v, (bool, int, float, str)) or v is None:
            return {"value": v}
        return {"value": repr(v), "unsupported": True}
    if getattr(d, "is_callable", False):
        return {"fn": _fn_name(d.arg)}
    if getattr(d, "is_sequence", False):
        return {"sequence": True}
    return {"unsupported": repr(d)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("base")
    ap.add_argument("out")
    ap.add_argument("--migrate", default="")
    a = ap.parse_args()

    base = _load(a.base)
    md = base.metadata
    tmp = tempfile.mkdtemp(prefix="schema-capture-")
    path = os.path.join(tmp, "fresh.db")
    eng = sa.create_engine(f"sqlite:///{path}")
    if a.migrate:
        _load(a.migrate)(eng)
    else:
        md.create_all(eng)
    with eng.connect() as c:
        rows = c.exec_driver_sql(
            "select type, name, tbl_name, sql from sqlite_master "
            "where sql is not null order by rowid"
        ).fetchall()
    eng.dispose()

    tables = []
    by_name = {}
    for typ, name, tbl, sql in rows:
        if typ == "table":
            t = {"name": name, "ddl": sql, "indexes": [], "columns": {}}
            tables.append(t)
            by_name[name] = t
        elif typ == "index":
            by_name[tbl]["indexes"].append(sql)
        else:
            by_name.setdefault(tbl, {"indexes": []})["indexes"].append(sql)

    for t in tables:
        tab = md.tables.get(t["name"])
        if tab is None:
            continue
        for col in tab.columns:
            entry = {"kind": _kind(col)}
            if col.primary_key:
                entry["pk"] = True
            if not col.nullable:
                entry["notNull"] = True
            d = _default(col.default)
            if d:
                if "value" in d and not d.get("unsupported"):
                    entry["default"] = d["value"]
                elif "fn" in d:
                    entry["defaultFn"] = d["fn"]
                else:
                    entry["defaultUnsupported"] = d
            u = _default(col.onupdate)
            if u:
                if "fn" in u:
                    entry["onupdateFn"] = u["fn"]
                elif "value" in u:
                    entry["onupdate"] = u["value"]
            t["columns"][col.name] = entry

    body = json.dumps(tables, indent=2, ensure_ascii=False)
    header = (
        "// SPDX-License-Identifier: MIT\n"
        f"// GENERATED by scripts/capture-schema.py from {a.base} — do not edit by hand.\n"
        "// Each table's DDL is the exact text Python's create_all writes to sqlite_master;\n"
        "// `columns` carries what lives in Python, not the database: the conversion kind and\n"
        "// the Python-side defaults. Re-generate when a Python table changes.\n"
    )
    with open(a.out, "w", encoding="utf-8", newline="\n") as f:
        f.write(header)
        f.write(f"export const TABLES = {body};\n")
    fns = sorted({c.get("defaultFn") or c.get("onupdateFn") for t in tables for c in t["columns"].values()} - {None})
    bad = [(t["name"], n) for t in tables for n, c in t["columns"].items() if "defaultUnsupported" in c]
    print(f"{len(tables)} tables -> {a.out}")
    if fns:
        print("callable defaults:", ", ".join(fns))
    if bad:
        print("UNSUPPORTED defaults:", bad)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
