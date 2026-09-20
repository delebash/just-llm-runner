#!/usr/bin/env python
# SPDX-License-Identifier: MIT
"""Does THIS engine build enforce a JSON schema in the form we send?

A dev tool, never shipped — the companion to `check-consumers.py` / `check-clean-install.py`,
and a required step at every engine pin bump (`docs/llama-cpp-watch.md` → Review checklist).

WHY IT EXISTS. llama-server's README documents a FLAT response_format
(`{"type":"json_schema","schema":…}`) and the kit's adapter used to rewrite every request into
it. The server's parser reads a json_schema schema ONLY from the OpenAI-standard NESTED form
(`response_format.json_schema.schema`, `tools/server/server-common.cpp` — identical at b9993,
b10437 and b10964); the flat one is silently read as "any JSON". Observed on b10437, 2026-09-19:
flat = NOT enforced, nested = enforced. The rewrite was deleted (plan
`docs/plans/2026-09-19-engine-update-safety-and-stable-channel.md` Slice 0); this script is how
we keep knowing.

WHAT IT DOES. Spawns the engine on CPU only (`-ngl 0`) with a small model — it must never
contend for VRAM with whatever the user has loaded — waits for /health, then:

  default        three probe requests (flat / nested / json_object+schema) against a schema
                 with two distinctive keys; prints which forms were ENFORCED.
                 EXIT 0 only when the NESTED form (the one we send) is enforced.

  --all-stored   additionally sends EVERY schema the given app databases really hold
                 (`feature_prompts` where json_mode is on and json_schema is non-empty), in the
                 nested form, to prove the engine can CONVERT them to a grammar. A rejection
                 names the action. Any rejection → exit 1.

Run (paths default to JUSTWRITE_DATA_DIR / --data-dir):
  python scripts/check-structured-output.py
  python scripts/check-structured-output.py --all-stored <app.db> [<app2.db> …]
"""
from __future__ import annotations

import argparse
import json
import os
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# Two keys no model would volunteer for the prompt below — so "enforced" cannot be luck.
SCHEMA = {
    "type": "object",
    "properties": {
        "zzq_code": {"type": "integer"},
        "zzq_word": {"type": "string", "enum": ["alpha", "beta"]},
    },
    "required": ["zzq_code", "zzq_word"],
    "additionalProperties": False,
}
PROMPT = "Reply with a JSON object describing today's weather in Paris."
WANT = ["zzq_code", "zzq_word"]

FORMS = {
    "flat   {type:json_schema, schema:S}": {"type": "json_schema", "schema": SCHEMA},
    "nested {type:json_schema, json_schema:{schema:S}}": {
        "type": "json_schema", "json_schema": {"name": "probe", "schema": SCHEMA, "strict": True}},
    "flat   {type:json_object, schema:S}": {"type": "json_object", "schema": SCHEMA},
}
NESTED = "nested {type:json_schema, json_schema:{schema:S}}"


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _post(url: str, body: dict, timeout: float = 180.0) -> tuple[int, str]:
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 — our own localhost child
            return 200, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def _content(raw: str) -> str:
    return ((json.loads(raw).get("choices") or [{}])[0].get("message") or {}).get("content") or ""


def _default_exe(data_dir: Path) -> Path | None:
    root = data_dir / "ai-cache" / "llamacpp"
    if not root.is_dir():
        return None
    builds = sorted((d for d in root.iterdir() if d.is_dir() and d.name != "logs"),
                    key=lambda d: d.name, reverse=True)
    for b in builds:
        for exe in list(b.rglob("llama-server.exe")) + list(b.rglob("llama-server")):
            if exe.is_file():
                return exe
    return None


def _default_gguf(data_dir: Path) -> Path | None:
    calib = data_dir / "ai-cache" / "calib"
    if calib.is_dir():
        files = sorted(calib.glob("*.gguf"), key=lambda p: p.stat().st_size)
        if files:
            return files[0]        # the smallest — this is a parser check, not a quality one
    return None


def _stored_schemas(db_path: Path) -> list[tuple[str, dict]]:
    """(action key, schema) for every feature that really carries one. READ-ONLY."""
    out: list[tuple[str, dict]] = []
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        rows = con.execute(
            "select key, json_schema from feature_prompts "
            "where json_mode = 1 and trim(coalesce(json_schema,'')) != ''").fetchall()
    except sqlite3.Error as e:
        print(f"    ! {db_path.name}: {e}")
        return out
    finally:
        con.close()
    for key, raw in rows:
        try:
            obj = json.loads(raw)
        except ValueError as e:
            print(f"    ! {db_path.name} :: {key}: stored schema is not JSON ({e})")
            continue
        if isinstance(obj, dict) and obj:
            out.append((str(key), obj))
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--exe", type=Path, default=None, help="llama-server (default: newest build in the data dir)")
    ap.add_argument("--gguf", type=Path, default=None, help="a small model (default: the speed-check model)")
    ap.add_argument("--data-dir", type=Path, default=os.environ.get("JUSTWRITE_DATA_DIR", ""),
                    help="app data root holding ai-cache/ (default: $JUSTWRITE_DATA_DIR)")
    ap.add_argument("--all-stored", nargs="*", type=Path, default=None, metavar="DB",
                    help="also send every schema stored in these app databases")
    args = ap.parse_args()

    data_dir = Path(args.data_dir) if args.data_dir else None
    exe = args.exe or (_default_exe(data_dir) if data_dir else None)
    gguf = args.gguf or (_default_gguf(data_dir) if data_dir else None)
    if not exe or not Path(exe).is_file():
        print("no llama-server found — pass --exe or set --data-dir/JUSTWRITE_DATA_DIR")
        return 2
    if not gguf or not Path(gguf).is_file():
        print("no model found — pass --gguf or set --data-dir/JUSTWRITE_DATA_DIR")
        return 2

    port = _free_port()
    base = f"http://127.0.0.1:{port}"
    print(f"engine : {exe}\nmodel  : {gguf}\nport   : {port} (CPU only)\n")
    proc = subprocess.Popen(  # noqa: S603 — a trusted, already-installed release exe
        [str(exe), "-m", str(gguf), "-ngl", "0", "-c", "2048",
         "--host", "127.0.0.1", "--port", str(port)],
        stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    failures: list[str] = []
    try:
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                print(f"the engine exited before it was ready (rc={proc.returncode})")
                return 2
            try:
                with urllib.request.urlopen(base + "/health", timeout=2) as r:  # noqa: S310
                    if r.status == 200:
                        break
            except Exception:  # noqa: BLE001 — still starting
                time.sleep(0.5)
        else:
            print("the engine never became healthy")
            return 2

        for label, rf in FORMS.items():
            code, raw = _post(base + "/v1/chat/completions", {
                "messages": [{"role": "user", "content": PROMPT}],
                "temperature": 0, "max_tokens": 96, "response_format": rf})
            if code != 200:
                print(f"  {label:<52} HTTP {code}: {raw[:120]}")
                if label == NESTED:
                    failures.append("the nested form was rejected outright")
                continue
            text = _content(raw)
            try:
                keys = sorted(json.loads(text).keys())
            except Exception:  # noqa: BLE001
                keys = None
            enforced = keys == WANT
            print(f"  {label:<52} enforced={str(enforced):<5} keys={keys}")
            if label == NESTED and not enforced:
                failures.append("the NESTED form (the one we send) was NOT enforced")

        if args.all_stored is not None:
            print("\nevery schema the apps really store, in the nested form:")
            dbs = [Path(p) for p in args.all_stored] or []
            if not dbs:
                print("  (no databases given)")
            total = 0
            for db in dbs:
                if not db.is_file():
                    print(f"  ! {db} does not exist")
                    failures.append(f"{db} does not exist")
                    continue
                for key, schema in _stored_schemas(db):
                    total += 1
                    code, raw = _post(base + "/v1/chat/completions", {
                        "messages": [{"role": "user", "content": "Reply with JSON."}],
                        "temperature": 0, "max_tokens": 8,
                        "response_format": {"type": "json_schema", "json_schema": {
                            "name": "stored", "schema": schema, "strict": True}}})
                    ok = code == 200
                    print(f"  {db.name} :: {key:<28} {'ok' if ok else f'HTTP {code}: ' + raw[:160]}")
                    if not ok:
                        failures.append(f"{db.name}::{key} was rejected by the engine")
            print(f"  ({total} stored schema(s) checked)")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except Exception:  # noqa: BLE001
            proc.kill()

    if failures:
        print("\nFAILED:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("\nOK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
