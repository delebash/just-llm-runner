#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Seed-facts audit — verify the seeded model catalogs against live Hugging Face facts.

Per seeded catalog row (model-per-hardware plan §Phase 5 + amendment A4):
  1. EXISTS  — the row's `hf_repo` resolves on the HF model API (HTTP 200).
  2. LICENSE — the seeded `license` matches the repo's `license:` tag
               (case/SPDX-normalized; the "Llama-Community" display label accepts
               Meta's per-version community tags — see LICENSE_ALIASES).
  3. BASE    — A4 de-circularization: when the repo declares a `base_model`
               (cardData or tags), the seeded license must match the BASE repo's
               tag too — a repackager mislabel FLAGS instead of self-confirming.
               One hop, per the amendment.
  4. QUANT   — the row's `quant` appears in the repo file tree (siblings) and,
               when the row carries `mtp_draft_file`, that exact file is present —
               in `mtp_draft_repo` when set (a BORROWED cross-repo drafter), else
               the model's own tree.

Sources walked:
  - runner:    llm_runner/llm/seed.py                       :: DEFAULT_CATALOG
  - JustWrite: seed_presets.py (--jw-seed / JW_SEED_PRESETS / the sibling-checkout
               default)                                      :: DEFAULT_MODEL_CATALOG_EXTRA

Both symbols are extracted by AST literal parse — NO import of llm_runner or
justwrite_server. Deliberate: the auditor runs with a bare python3 anywhere and
must not depend on the package whose data it audits. (llm_runner.runner.models
does carry HF code — requests + the revision/tree endpoints, models.py:60,65 —
but no license/base_model fetch, and importing it drags the package __init__.)

Exit codes: 0 = every row passes · 1 = at least one FACTS mismatch ·
2 = network failure (run aborted — a red network run is never a facts verdict).
NOT CI-gated (network). Run at any seed change and in sessions:

    python3 scripts/seed-facts-audit.py
    # dev container: SSL_CERT_FILE=/root/.ccr/ca-bundle.crt (egress-proxy CA)
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import re
import ssl
import sys
import urllib.error
import urllib.request
from pathlib import Path

HF_API = "https://huggingface.co/api/models/"
REPO_ROOT = Path(__file__).resolve().parent.parent
RUNNER_SEED = REPO_ROOT / "llm_runner" / "llm" / "seed.py"
# JustWrite checks out as a SIBLING of this repo (its Vite alias
# ../just-llm-runner/ui/src depends on that layout), so the sibling path is a
# safe default; override with --jw-seed or JW_SEED_PRESETS.
JW_SEED_SIBLING = (
    REPO_ROOT.parent / "justwrite-app" / "server" / "justwrite_server" / "seed_presets.py"
)

# Our seed stores display labels; HF tags the specific license version. The ONLY
# sanctioned fan-out: "Llama-Community" covers Meta's per-version community
# tags. Everything else must match after normalization ("Apache-2.0" ==
# "apache-2.0"). The table prints both raw values either way.
LICENSE_ALIASES: dict[str, set[str]] = {
    "llama-community": {"llama2", "llama3", "llama3.1", "llama3.2", "llama3.3", "llama4"},
}


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9.]+", "-", (s or "").strip().lower()).strip("-")


def license_ok(seeded: str, actual: str) -> bool:
    s, a = _norm(seeded), _norm(actual)
    return a == s or a in LICENSE_ALIASES.get(s, set())


def load_literal(path: Path, symbol: str):
    """Extract a module-level literal assignment by name — no import, no venv."""
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    for node in tree.body:
        if isinstance(node, ast.Assign):
            names = [t.id for t in node.targets if isinstance(t, ast.Name)]
            value = node.value
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            names, value = [node.target.id], node.value
        else:
            continue
        if symbol in names and value is not None:
            try:
                return ast.literal_eval(value)
            except ValueError as e:
                raise SystemExit(
                    f"error: {symbol} in {path} is no longer a pure literal ({e}) — "
                    f"the audit reads seeds without importing; keep the rows literal"
                ) from e
    raise SystemExit(f"error: {symbol} not found as a module-level literal in {path}")


class Net:
    """One cached GET per unique repo; network failure aborts the run (exit 2)."""

    def __init__(self) -> None:
        self._ctx = ssl.create_default_context()  # honors SSL_CERT_FILE
        self._cache: dict[str, tuple[int, dict | None]] = {}

    def model_info(self, repo: str) -> tuple[int, dict | None]:
        if repo in self._cache:
            return self._cache[repo]
        req = urllib.request.Request(
            HF_API + repo, headers={"User-Agent": "seed-facts-audit (just-llm-runner)"}
        )
        try:
            with urllib.request.urlopen(req, timeout=30, context=self._ctx) as r:
                out = (r.status, json.load(r))
        except urllib.error.HTTPError as e:
            out = (e.code, None)
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            print(f"NETWORK ERROR fetching {repo}: {e}", file=sys.stderr)
            print("aborting — a network failure is not a facts verdict", file=sys.stderr)
            raise SystemExit(2) from e
        self._cache[repo] = out
        return out


def hf_license(info: dict) -> str:
    for t in info.get("tags") or []:
        if t.startswith("license:"):
            return t[len("license:") :]
    return str((info.get("cardData") or {}).get("license") or "")


def declared_bases(info: dict) -> list[str]:
    """cardData.base_model (str|list) + base_model:* tags; relation namespaces
    like "base_model:quantized:org/repo" stripped; order-preserving de-dup."""
    out: list[str] = []
    bm = (info.get("cardData") or {}).get("base_model")
    if isinstance(bm, str):
        out.append(bm)
    elif isinstance(bm, list):
        out.extend(b for b in bm if isinstance(b, str))
    for t in info.get("tags") or []:
        if t.startswith("base_model:"):
            parts = t.split(":", 2)
            out.append(parts[2] if len(parts) == 3 else parts[1])
    seen: set[str] = set()
    return [b for b in out if b and not (b in seen or seen.add(b))]


def _load_header_deriver():
    """Optional live GGUF-header deriver — returns a `derive(repo, quant) -> facts` fn
    when `llm_runner` is importable, else None. The audit still RUNS bare (None → header
    checks are skipped); when the package is present it grounds the seed's HEADER facts
    (mtp_builtin / type / experts / size / trained_ctx) against the real file, closing
    the gap the license/quant checks left — the seed's `mtp` was never header-verified
    before (2026-07-13), which is exactly how the Gemma grid-vs-checkbox drift slipped in."""
    try:
        from llm_runner.llm.identity import derived_fields_from_meta
        from llm_runner.runner.gguf_remote import fetch_gguf_meta
    except Exception:  # noqa: BLE001 — bare-python run: header checks simply don't run
        return None

    def _derive(repo: str, quant: str) -> dict:
        meta, total = fetch_gguf_meta(repo, quant)
        f = derived_fields_from_meta(meta)
        return {
            "mtp_builtin": bool(f["mtp_builtin"]), "type": f["type"],
            "experts": int(meta.expert_count or 0), "architecture": meta.architecture or "",
            "trained_ctx": f["trained_ctx"], "size_label": meta.size_label or "",
            "size_bytes": int(total),
        }

    return _derive


def _norm_header(field: str, v):
    """Effective-default normalize (mirrors refresh-seed-facts._norm) so an OMITTED seed
    field the row builder defaults correctly isn't flagged as a spurious header mismatch."""
    if field == "mtp_builtin":
        return bool(v)
    if field == "type":
        return v or "dense"
    if field == "experts":
        return int(v or 0)
    if field in ("architecture", "size_label"):
        return v or ""
    return v  # trained_ctx / size_bytes: None means "not filled yet"


_HEADER_FIELDS = ("mtp_builtin", "type", "experts", "architecture", "trained_ctx",
                  "size_label", "size_bytes")


def audit_row(source: str, row: dict, net: Net, header=None) -> dict:
    repo = str(row.get("hf_repo") or "")
    res: dict = {
        "source": source,
        "id": str(row.get("id") or "?"),
        "repo": repo,
        "seeded": str(row.get("license") or ""),
        "hf": "",
        "bases": [],
        "quant": str(row.get("quant") or ""),
        "problems": [],
    }
    if not repo:
        res["problems"].append("row has no hf_repo")
        return res
    status, info = net.model_info(repo)
    if status != 200 or info is None:
        res["problems"].append(f"repo HTTP {status}")
        return res

    res["hf"] = hf_license(info)
    if not license_ok(res["seeded"], res["hf"]):
        res["problems"].append(f"license: seeded {res['seeded']!r} vs HF {res['hf']!r}")

    # A row may carry `license_reviewed` — a human-recorded note that the repo's own
    # license tag genuinely differs from its base's (e.g. a repackager declaring
    # gemma-terms over an apache-2.0 base). The seeded license must STILL match the
    # repo's own tag; only the base-hop mismatch downgrades from FAIL to a printed
    # note (the discrepancy stays visible, it just stops re-flagging what a human
    # already ruled on).
    reviewed = str(row.get("license_reviewed") or "")
    for base in declared_bases(info):
        bstatus, binfo = net.model_info(base)
        if bstatus != 200 or binfo is None:
            res["problems"].append(f"base {base}: HTTP {bstatus}")
            continue
        blic = hf_license(binfo)
        res["bases"].append(f"{base}={blic}")
        if not license_ok(res["seeded"], blic):
            if reviewed:
                res["bases"].append(f"(base differs — reviewed: {reviewed})")
            else:
                res["problems"].append(
                    f"base {base}: license {blic!r} vs seeded {res['seeded']!r}"
                )

    siblings = [str(s.get("rfilename") or "") for s in info.get("siblings") or []]
    if res["quant"] and not any(res["quant"].lower() in f.lower() for f in siblings):
        res["problems"].append(f"quant {res['quant']} not found in the repo tree")
    draft = str(row.get("mtp_draft_file") or "")
    draft_repo = str(row.get("mtp_draft_repo") or "")
    res["draft_checked"] = bool(draft)
    if draft and draft_repo:
        # A BORROWED cross-repo drafter (tier-C inherited assistant) lives in its OWN
        # repo, not the model's tree — verify it there (gryphe-styletune-v2 borrows the
        # official Gemma assistant drafter).
        dstatus, dinfo = net.model_info(draft_repo)
        dsibs = [str(x.get("rfilename") or "") for x in (dinfo or {}).get("siblings") or []]
        if dstatus != 200 or dinfo is None:
            res["problems"].append(f"mtp draft repo {draft_repo}: HTTP {dstatus}")
        elif draft not in dsibs:
            res["problems"].append(f"mtp draft {draft} not found in {draft_repo}")
    elif draft and draft not in siblings:
        res["problems"].append(f"mtp draft {draft} not found in the repo tree")

    # HEADER facts (optional, 2026-07-13): range-read the pinned quant's GGUF header and
    # diff the seed's file-derived scalars against it — so a hand-typed mtp/size/type/ctx
    # that drifts from the file FAILS loudly (the generator keeps them in sync; this
    # keeps them honest). Skipped when llm_runner isn't importable (bare-python run).
    if header is not None and res["quant"]:
        try:
            live = header(res["repo"], res["quant"])
        except Exception as e:  # noqa: BLE001 — a header read failure is not a facts verdict
            res["header_note"] = f"header read failed: {type(e).__name__}"
        else:
            res["header_checked"] = True
            for field in _HEADER_FIELDS:
                seeded = _norm_header(field, row.get(field))
                fresh = _norm_header(field, live[field])
                if seeded != fresh:
                    res["problems"].append(f"header {field}: seed {seeded!r} vs HF {fresh!r}")
    return res


def print_table(results: list[dict]) -> None:
    if not results:
        print("no rows to audit")
        return
    wid = max(len(r["id"]) for r in results)
    wrepo = max(len(r["repo"]) for r in results)
    for r in results:
        verdict = "FAIL" if r["problems"] else "OK"
        lic = f"{r['seeded']}→{r['hf'] or '?'}"
        draft = " +mtp-draft" if r.get("draft_checked") else ""
        hdr = " +hdr" if r.get("header_checked") else ""
        print(
            f"{verdict:<4} [{r['source']:<6}] {r['id']:<{wid}}  {r['repo']:<{wrepo}}  "
            f"{lic}  quant {r['quant'] or '-'}{draft}{hdr}"
        )
        for b in r["bases"]:
            print(f"       base {b}")
        if not r["bases"] and r["hf"]:
            print("       base (none declared — the A4 hop has nothing to check)")
        if r.get("header_note"):
            print(f"       ~ {r['header_note']}")
        for p in r["problems"]:
            print(f"       ✗ {p}")


def main() -> int:
    p = argparse.ArgumentParser(description="Audit seeded model catalogs against HF facts.")
    p.add_argument(
        "--jw-seed",
        default=os.environ.get("JW_SEED_PRESETS", ""),
        help="path to JustWrite's seed_presets.py (default: env JW_SEED_PRESETS, "
        "else the sibling checkout)",
    )
    args = p.parse_args()

    rows: list[tuple[str, dict]] = [
        ("runner", r) for r in load_literal(RUNNER_SEED, "DEFAULT_CATALOG")
    ]
    jw_path = Path(args.jw_seed) if args.jw_seed else JW_SEED_SIBLING
    if jw_path.is_file():
        rows += [("jw", r) for r in load_literal(jw_path, "DEFAULT_MODEL_CATALOG_EXTRA")]
    else:
        print(
            f"note: JW seed not found at {jw_path} — auditing the runner catalog only "
            f"(pass --jw-seed or set JW_SEED_PRESETS)"
        )

    try:  # Windows consoles default to cp1252 — the table uses ·/✗.
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

    net = Net()
    header = _load_header_deriver()
    if header is None:
        print("note: llm_runner not importable — HEADER facts (mtp_builtin/type/size/ctx) "
              "NOT checked this run; license/quant/draft only. Run from the package to header-verify.")
    results = [audit_row(source, row, net, header) for source, row in rows]
    print_table(results)
    failed = sum(1 for r in results if r["problems"])
    checked_hdr = sum(1 for r in results if r.get("header_checked"))
    print(f"\n{len(results)} rows audited · {len(results) - failed} OK · {failed} FAIL"
          f" · {checked_hdr} header-verified")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
