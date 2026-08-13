#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""refresh-seed-facts.py — regenerate the seed's HEADER-DERIVED facts from Hugging Face.

Runs the ACTUAL load-from-HF method (`identity.inspect_model_from_link` — the exact
function the Add-a-model "Read from link" form calls, header range-read + sampler
fallback + the tier-C inherited-drafter probe) over every SEEDED catalog row, and
reconciles the file-derived fields so the SEED equals what Read-from-link detects.
This is the "update the seed before we ship again" build step (user, 2026-07-13):
seeded facts are hand-typed, drift silently, and are never re-grounded — mtp most
of all (its header truth + inherited drafter were never verified). No guessing:
every value written here is read live from the file via the very same code path.

Sources (same two the seed-facts audit walks):
  - runner:    llm_runner/llm/seed.py         :: DEFAULT_CATALOG (empty since ④)
  - JustWrite: <sibling>/server/justwrite_server/seed_presets.py :: DEFAULT_MODEL_CATALOG_EXTRA
                                                                  + JW_CURATED_CATALOG

Scalar facts reconciled + (with --write) rewritten IN PLACE, per row:
  mtp_builtin (nextn_predict_layers>0) · type (moe|dense) · experts · architecture ·
  trained_ctx · size_label · size_bytes · est_vram_mb.
Tier-C inherited drafter (CONDITIONAL — a Gemma-style row with no built-in MTP and
no OWN draft): writes the borrowed base-family drafter (mtp_draft_repo/file/quant)
+ enables mtp, matching what Read-from-link configures. A row that ships its own
draft is never touched.
Samplers are REPORTED only (nested dict; the seed already ships the file's set, and
a mismatch there is a curation call, not a mechanical rewrite).

Usage:
    python scripts/refresh-seed-facts.py            # report the seed-vs-HF diff
    python scripts/refresh-seed-facts.py --write    # apply the scalar facts in place
    python scripts/refresh-seed-facts.py --only gemma-4-26b-a4b-qat,glm-4.5-air
    # dev container: SSL_CERT_FILE=/root/.ccr/ca-bundle.crt (egress-proxy CA)

Exit: 0 = no differences (or --write applied) · 1 = differences found in report mode ·
2 = a network/read failure on at least one row (its facts were left untouched).
"""

from __future__ import annotations

import argparse
import ast
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
RUNNER_SEED = REPO_ROOT / "llm_runner" / "llm" / "seed.py"
JW_SEED_SIBLING = (
    REPO_ROOT.parent / "justwrite-app" / "server" / "justwrite_server" / "seed_presets.py"
)
JV_SEED_SIBLING = (
    REPO_ROOT.parent / "JustVioce" / "server" / "justvoice" / "seed_presets.py"
)

# The scalar file-derived fields we reconcile (seed key -> how to pull it from the
# derived-facts dict + the live meta/size). Order = the order we print + insert.
_SCALAR_FIELDS = ("mtp_builtin", "type", "experts", "architecture", "trained_ctx",
                  "size_label", "size_bytes", "est_vram_mb",
                  # Fit-redesign Phase 2 (§13.11) — the nine physics FACTS the
                  # floors/est/badge compute FRESH from (the seed ships facts,
                  # never derived numbers; curated chat floors die with this):
                  "block_count", "n_kv_heads", "head_count", "embedding_length",
                  "expert_used_count", "expert_byte_share",
                  "kv_windowed_bytes_per_token", "kv_global_bytes_per_token",
                  "sliding_window")
# Tier-C inherited-drafter fields (reconciled CONDITIONALLY — borrow-only rows) + the
# mtp enable flag they turn on. Written by _apply alongside the scalars; `mtp` first so
# it becomes the anchor the draft fields cluster around.
_DRAFT_FIELDS = ("mtp", "mtp_draft_repo", "mtp_draft_file", "mtp_draft_quant")
_WRITE_FIELDS = _SCALAR_FIELDS + _DRAFT_FIELDS


def _norm(field: str, v) -> object:
    """Normalize a seed value to its EFFECTIVE default so an OMITTED field that the row
    builder already defaults correctly (type→dense, experts→0, mtp/mtp_builtin→False, the
    string fields→"") isn't flagged as a spurious diff. size_bytes/trained_ctx keep
    None (a genuine "unfilled" the reconcile SHOULD fill from the header)."""
    if field in ("mtp_builtin", "mtp"):
        return bool(v)
    if field == "type":
        return v or "dense"
    if field == "experts":
        return int(v or 0)
    if field in ("architecture", "size_label", "mtp_draft_repo", "mtp_draft_file", "mtp_draft_quant"):
        return v or ""
    if field in ("block_count", "n_kv_heads", "head_count", "embedding_length",
                 "expert_used_count", "sliding_window"):
        return int(v or 0)
    if field in ("expert_byte_share", "kv_windowed_bytes_per_token", "kv_global_bytes_per_token"):
        return float(v or 0.0)
    return v  # trained_ctx, size_bytes, est_vram_mb: None means "not filled yet"


def _load_literal(path: Path, symbol: str):
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    for node in tree.body:
        targets = []
        if isinstance(node, ast.Assign):
            targets = [t.id for t in node.targets if isinstance(t, ast.Name)]
            value = node.value
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            targets, value = [node.target.id], node.value
        else:
            continue
        if symbol in targets and value is not None:
            return ast.literal_eval(value)
    raise SystemExit(f"error: {symbol} not found as a module-level literal in {path}")


def _derive_from_hf(repo: str, quant: str) -> dict:
    """The live facts — literally the method Read-from-link uses (`inspect_model_from_link`:
    header range-read + generation_config sampler fallback + the tier-C inherited-drafter
    probe). Using the SAME function is the whole point: the seed cannot drift from HF for a
    field HF derives. Raises on network/parse."""
    from llm_runner.llm.identity import inspect_model_from_link

    r = inspect_model_from_link(repo, quant)
    return {
        "mtp_builtin": bool(r["mtpBuiltin"]),
        "type": r["type"],
        "experts": int(r["experts"] or 0),
        "architecture": r["architecture"] or "",
        "trained_ctx": r["trainedCtx"],
        "size_label": r["sizeLabel"] or "",
        "size_bytes": int(r["sizeBytes"]),
        "est_vram_mb": r["estVramMb"],
        **{k: v for k, v in (r.get("physicsFacts") or {}).items()},
        "samplers": r["samplers"],
        # Tier-C: the borrowable OFFICIAL base-family drafter (Gemma-style external MTP).
        # Non-empty only when the model has no built-in MTP; the reconcile applies it
        # to the seed's draft fields ONLY for a row that ships no own draft.
        "mtp_inherited_repo": r["mtpInheritedRepo"] or "",
        "mtp_inherited_file": r["mtpInheritedFile"] or "",
        "mtp_inherited_quant": r["mtpInheritedQuant"] or "",
    }


def _fmt(v) -> str:
    """A Python-source literal for a reconciled value (bool/int/float/str/None)."""
    if isinstance(v, bool):
        return "True" if v else "False"
    if v is None:
        return "None"
    if isinstance(v, float):
        return repr(round(v, 10))
    if isinstance(v, int):
        return str(v)
    return json.dumps(str(v))  # a properly-escaped "double-quoted" string


def _row_span(src: str, model_id: str) -> tuple[int, int] | None:
    """(start, end) of the `{...}` dict literal for `"id": "<model_id>"` — brace-matched
    so a nested samplers dict doesn't end it early. None when the row isn't found."""
    key = f'"id": "{model_id}"'
    i = src.find(key)
    if i < 0:
        return None
    start = src.rfind("{", 0, i)
    if start < 0:
        return None
    depth = 0
    in_str = False
    esc = False
    for j in range(start, len(src)):
        c = src[j]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
            continue
        if c == '"':
            in_str = True
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return start, j + 1
    return None


_ANCHOR = re.compile(r'("mtp"\s*:\s*(?:True|False)\s*,)')      # keep new fields next to mtp
_ID_ANCHOR = re.compile(r'("id"\s*:\s*"(?:[^"\\]|\\.)*"\s*,)')  # fallback anchor


def _set_field(rowtext: str, field: str, value_literal: str) -> str:
    """Replace `"field": <val>` in one row's text, or INSERT it (after `"mtp":`, else
    after `"id":`) when absent. Value spans to the next comma / closing brace / newline."""
    field_pat = re.compile(
        r'("%s"\s*:\s*)(?:"(?:[^"\\]|\\.)*"|[^,}\n]+)' % re.escape(field)
    )
    if field_pat.search(rowtext):
        return field_pat.sub(lambda m: m.group(1) + value_literal, rowtext, count=1)
    ins = f' "{field}": {value_literal},'
    m = _ANCHOR.search(rowtext) or _ID_ANCHOR.search(rowtext)
    if not m:
        raise SystemExit(f"error: no anchor to insert {field} into a row (unexpected shape)")
    return rowtext[: m.end()] + ins + rowtext[m.end():]


def _apply(path: Path, updates: dict[str, dict[str, object]]) -> int:
    """Rewrite `path` in place: for each (model_id -> {field: value}) swap/insert the
    scalar literal in that row's span. Re-parses the file after to guarantee it still
    loads. Returns the number of rows touched."""
    src = path.read_text(encoding="utf-8")
    touched = 0
    for model_id, fields in updates.items():
        span = _row_span(src, model_id)
        if span is None:
            print(f"  ! {model_id}: row not found in {path.name} — skipped")
            continue
        start, end = span
        rowtext = src[start:end]
        for field in _WRITE_FIELDS:
            if field in fields:
                rowtext = _set_field(rowtext, field, _fmt(fields[field]))
        src = src[:start] + rowtext + src[end:]
        touched += 1
    # Never leave the file unparseable — verify before writing.
    ast.parse(src, filename=str(path))
    path.write_text(src, encoding="utf-8")
    return touched


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--write", action="store_true", help="apply the reconciled scalar facts in place")
    p.add_argument("--only", default="", help="comma-separated model ids to limit to")
    p.add_argument("--jw-seed", default=str(JW_SEED_SIBLING))
    p.add_argument("--jv-seed", default=str(JV_SEED_SIBLING))
    args = p.parse_args()
    only = {x.strip() for x in args.only.split(",") if x.strip()}
    try:  # Windows consoles default to cp1252 — make our output encoding-safe.
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

    # Decision ④ (2026-08-05): the runner's DEFAULT_CATALOG is empty by design;
    # the curated ladder refreshes from JW's seed (JW_CURATED_CATALOG) now.
    sources: list[tuple[Path, str]] = [(RUNNER_SEED, "DEFAULT_CATALOG")]
    jw_path = Path(args.jw_seed)
    if jw_path.is_file():
        sources.append((jw_path, "DEFAULT_MODEL_CATALOG_EXTRA"))
        sources.append((jw_path, "JW_CURATED_CATALOG"))
    else:
        print(f"note: JW seed not found at {jw_path} — runner catalog only")
    # Fit-redesign Phase 2 B: JustVoice's catalog mirror regenerates in the SAME
    # run (seed == detection holds family-wide, §8.13/§13.11).
    jv_path = Path(args.jv_seed)
    if jv_path.is_file():
        sources.append((jv_path, "JV_MODEL_CATALOG"))
    else:
        print(f"note: JV seed not found at {jv_path} — skipping")

    net_error = False
    any_diff = False
    for path, symbol in sources:
        rows = _load_literal(path, symbol)
        updates: dict[str, dict[str, object]] = {}
        print(f"\n=== {path.name} :: {symbol} ===")
        for row in rows:
            mid = str(row.get("id") or "?")
            if only and mid not in only:
                continue
            repo, quant = str(row.get("hf_repo") or ""), str(row.get("quant") or "")
            if not repo or not quant:
                continue
            try:
                live = _derive_from_hf(repo, quant)
            except Exception as e:  # noqa: BLE001 — a read failure is not a facts verdict
                print(f"  ? {mid}: READ FAILED ({type(e).__name__}: {str(e)[:80]}) — left as-is")
                net_error = True
                continue
            diffs: dict[str, object] = {}
            for field in _SCALAR_FIELDS:
                seeded = _norm(field, row.get(field))
                fresh = _norm(field, live[field])
                if seeded != fresh:
                    diffs[field] = fresh
            # Tier-C inherited drafter (2026-07-13): a Gemma-style row with no built-in
            # MTP AND no OWN draft can BORROW the official base-family assistant drafter —
            # exactly what Read-from-link configures + auto-checks. Sync the seed the same
            # way (draft repo/file/quant + enable mtp), but ONLY when the row ships no own
            # draft — a model with its own draft (e.g. gemma-4-26b-a4b-qat) is never touched.
            own_draft = bool(str(row.get("mtp_draft_file") or "").strip())
            inherited_file = live.get("mtp_inherited_file") or ""
            if inherited_file and not own_draft:
                want = {
                    "mtp": True,
                    "mtp_draft_repo": live.get("mtp_inherited_repo") or "",
                    "mtp_draft_file": inherited_file,
                    "mtp_draft_quant": live.get("mtp_inherited_quant") or "",
                }
                for k, v in want.items():
                    if _norm(k, row.get(k)) != _norm(k, v):
                        diffs[k] = v
            if diffs:
                any_diff = True
                updates[mid] = diffs
                shown = ", ".join(f"{k}: {row.get(k)!r} -> {v!r}" for k, v in diffs.items())
                print(f"  CHG {mid}: {shown}")
            else:
                print(f"  ok  {mid}: up to date")
            # samplers are advisory — report but never auto-write
            if (row.get("samplers") or {}) != (live["samplers"] or {}) and live["samplers"]:
                print(f"      (samplers differ — review manually: seed {row.get('samplers')} vs HF {live['samplers']})")
        if args.write and updates:
            n = _apply(path, updates)
            print(f"  -> wrote {n} row(s) to {path.name}")

    if net_error:
        return 2
    return 0 if (args.write or not any_diff) else 1


if __name__ == "__main__":
    sys.exit(main())
