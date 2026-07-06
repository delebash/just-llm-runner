#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Dev/container-only: add the tiny CPU pipeline-test model to a RUNNING dev server's
catalog — deliberately NOT part of any product seed (user, 2026-07-06: "no the catalog
does not get a tiny cpu loaded model, not in its seed … you can seed that sperately for
your test … add claude container seed file for seed that one thing").

Uses the same user-facing catalog CRUD the Add-model form uses (PUT /v1/ai/model-catalog,
idempotent upsert; the row lands builtIn=false like any user-added model), so a factory
reset removes it — exactly right for a test aid. The model: unsloth/Qwen3-0.6B-GGUF
(apache-2.0, verified live 2026-07-06) — downloads in seconds and loads without a GPU,
so the download→spawn→generate pipeline is exercisable on GPU-less dev boxes/CI. It can
never be auto-picked (rank 99 + the FIT_GPU chat-pick gate excludes CPU-band models).

    python3 scripts/dev-seed-test-model.py            # server at 127.0.0.1:17495
    JW_API=http://127.0.0.1:17495 python3 scripts/dev-seed-test-model.py
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request

API = os.environ.get("JW_API", "http://127.0.0.1:17495")

ROW = {
    "id": "qwen3-0.6b-test",
    "name": "Qwen3 0.6B — pipeline test model (CPU)",
    "hfRepo": "unsloth/Qwen3-0.6B-GGUF",
    "quant": "Q4_K_M",
    "totalParams": "0.6B",
    "type": "dense",
    "minVramMb": 0,
    "minRamMb": 2000,
    "tier": "cpu",
    "license": "Apache-2.0",
    "qualityRank": 99,
    "description": "A tiny model for testing the pipeline — downloads fast and loads even "
                   "without a GPU. Dev/test aid only; never auto-picked.",
    "position": 99,
}


def main() -> int:
    req = urllib.request.Request(
        f"{API}/v1/ai/model-catalog",
        data=json.dumps(ROW).encode(),
        headers={"Content-Type": "application/json"},
        method="PUT",
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        rows = json.load(r).get("rows", [])
    ok = any(row.get("id") == ROW["id"] for row in rows)
    print(f"{'added' if ok else 'FAILED to add'} {ROW['id']} → {API} ({len(rows)} catalog rows)")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
