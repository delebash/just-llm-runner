#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""MANUAL tool — run it yourself, it never runs automatically (user, 2026-07-06:
"keep it in seed i can run manually"): restores the author box's measured tunes after
a data reset. NOT part of any product seed (tunes are measurements owned by each
(model, machine) pair; the product paths are the optimize sweep + the Tune modal).

Uses the same PUT the Tune modal uses (/v1/ai/model-tunes) — the SERVER stamps the
fingerprint of the machine that runs this, so on the author's 2070 SUPER these land as
that box's tune; run on any other machine they'd become THAT machine's tune (so don't).

Values (measured 2026-07-06 on the 8 GB / 32 GB box): ncmoe 21 = the 32k floor with the
CPU embed co-resident (20 OOMs) · batch/ubatch 512/512 = the TTFT winner (64/32 was
8.6x slower) · ctx 32768 · threads 8 (this CPU) · the 0.6B embed on CPU (frees 684 MB
VRAM; query latency unchanged).

    python3 scripts/dev-seed-tunes.py       # server at 127.0.0.1:17495 (JW_API to override)
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request

API = os.environ.get("JW_API", "http://127.0.0.1:17495")

TUNES = [
    {"modelId": "gemma-4-26b-a4b-qat", "switches": [
        {"flagName": "n_gpu_layers", "flagValue": "99"},
        {"flagName": "n_cpu_moe", "flagValue": "21"},
        {"flagName": "ctx_len", "flagValue": "32768"},
        {"flagName": "batch_size", "flagValue": "512"},
        {"flagName": "ubatch_size", "flagValue": "512"},
        {"flagName": "threads", "flagValue": "8"},
    ]},
    {"modelId": "qwen3-embedding-0.6b", "switches": [
        {"flagName": "n_gpu_layers", "flagValue": "0"},
    ]},
]


def main() -> int:
    for t in TUNES:
        req = urllib.request.Request(
            f"{API}/v1/ai/model-tunes", data=json.dumps(t).encode(),
            headers={"Content-Type": "application/json"}, method="PUT",
        )
        with urllib.request.urlopen(req, timeout=15) as r:
            out = json.load(r)
        print(f"{t['modelId']}: {len(out.get('rows', []))} flags saved under {out.get('hwKey', '?')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
