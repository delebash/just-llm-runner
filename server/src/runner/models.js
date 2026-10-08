// SPDX-License-Identifier: MIT
// P1.3 — GGUF model acquisition from HuggingFace (the port of llm_runner/runner/models.py).
//
// Resolves the real GGUF filename(s) for a model by matching its `quant` against the repo's
// HF tree (no hardcoded/fabricated filenames), then streams them into the canonical HF cache
// layout so llama.cpp finds them via the standard cache resolver. Self-contained (own
// download + cache-root resolution) so it runs in any host with no app coupling.
//
// HF Hub API (no auth for public repos):
//     GET /api/models/{repo}/revision/{rev}            -> commit sha
//     GET /api/models/{repo}/tree/{rev}?recursive=true -> file listing
//     GET /{repo}/resolve/{rev}/{path}                 -> file bytes
//
// Cache layout written (matches huggingface_hub so its resolver finds files):
//     <hf_cache>/models--<owner>--<name>/
//       refs/<rev>             text: commit_sha
//       blobs/<oid>            actual file (one blob per file)
//       snapshots/<sha>/<path> symlink -> ../../blobs/<oid> (copy fallback)
// The `oid` is the LFS sha256 for weights (most GGUFs) or the git blob oid for small files;
// either is what the standard cache probe expects.
//
// Paths are strings (Python returned Path objects). The network calls are async; the
// on-disk checks (`cachedGgufPath`, `isCached`) stay synchronous, as they were cheap enough
// to run per model when building the catalog.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import * as http from "../platform/http.js";
import { HttpStatusError } from "../platform/http.js";
import { getLogger } from "../platform/log.js";
import { FileNotFoundError, IS_WIN, KeyError, pyInt, pyMin, pySorted } from "../platform/py.js";
import { pyPath } from "./cache_registry.js";
import * as download from "./download.js";
import { DownloadCancelled, raiseForStatus } from "./download.js";
import * as self from "./models.js";

const log = getLogger("llm_runner.runner.models");

export const _HF_BASE = "https://huggingface.co";
const API_TIMEOUT = 30;

// ── helpers (candidates for platform/) ─────────────────────────────────────────────────

/** requests.RequestException: a request that failed in transport or returned bad JSON.
 * (A 4xx/5xx is http.js's HttpStatusError; `isRequestError` takes both.) */
export class RequestException extends Error {
  constructor(m, opts) {
    super(m, opts);
    this.name = "RequestException";
  }
}
export const isRequestError = (e) => e instanceof RequestException || e instanceof HttpStatusError;

/** repr() of a str — single quotes unless the text holds one and no double quote. */
export function pyRepr(s) {
  s = String(s);
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === q) out += `\\${q}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20 || c === 0x7f) out += `\\x${c.toString(16).padStart(2, "0")}`;
    else out += ch;
  }
  return q + out + q;
}

/** str.split(sep, maxsplit) — the remainder stays in the last part (JS's limit drops it). */
export function pySplit(s, sepStr, maxsplit = -1) {
  const parts = s.split(sepStr);
  if (maxsplit < 0 || parts.length <= maxsplit + 1) return parts;
  return [...parts.slice(0, maxsplit), parts.slice(maxsplit).join(sepStr)];
}

/** re.escape for a pattern built into a RegExp. */
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

/** GET a huggingface.co JSON document (requests.get + raise_for_status + .json()).
 * Python's `timeout=30` was 30 s to connect + 30 s per read; a small JSON answer is one read,
 * so the whole request gets connect + read. */
async function hfGetJson(url, params = null) {
  const u = params ? `${url}?${new URLSearchParams(params)}` : url;
  let r;
  try {
    r = await http.fetch(u, { headers: self._hfHeaders(), timeoutMs: 2 * API_TIMEOUT * 1000 });
  } catch (e) {
    throw new RequestException(String(e?.message ?? e), { cause: e });
  }
  await raiseForStatus(r, u);
  try {
    return await r.json();
  } catch (e) {
    throw new RequestException(String(e?.message ?? e), { cause: e });
  }
}

// ── the HF API ─────────────────────────────────────────────────────────────────────────

/** Bearer auth from the standard env convention (HF_TOKEN, or huggingface_hub's older
 * HUGGING_FACE_HUB_TOKEN) — HF's rate-limits doc calls the missing token "the number one
 * reason users get rate limited": anonymous per-IP windows are 3,000 resolver / 500 API
 * requests per 5 min; any free account raises them. Optional — no token still works, at the
 * anonymous limits. Applied to EVERY huggingface.co call here: metadata and downloads. */
export function _hfHeaders() {
  const tok = (process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN || "").trim();
  return tok ? { Authorization: `Bearer ${tok}` } : {};
}

/** HF hub cache root, matching huggingface_hub's resolution order (HF_HUB_CACHE →
 * $HF_HOME/hub → ~/.cache/huggingface/hub) without the library. */
export function hfCacheRoot() {
  const env = process.env.HF_HUB_CACHE;
  if (env) return pyPath(env);
  const home = process.env.HF_HOME;
  if (home) return pyPath(join(home, "hub"));
  return join(homedir(), ".cache", "huggingface", "hub");
}

export async function _revisionSha(repo, revision) {
  const j = await hfGetJson(`${_HF_BASE}/api/models/${repo}/revision/${revision}`);
  if (j === null || typeof j !== "object" || Array.isArray(j) || !Object.hasOwn(j, "sha")) throw new KeyError("'sha'");
  return j.sha;
}

export async function _tree(repo, revision) {
  const j = await hfGetJson(`${_HF_BASE}/api/models/${repo}/tree/${revision}`, { recursive: "true" });
  if (!Array.isArray(j)) throw new TypeError("the tree listing is not a list");
  return j.filter((e) => e?.type === "file");
}

/** True byte size — LFS files expose it via .lfs.size, others via .size. */
export function _entrySize(entry) {
  return pyInt((entry.lfs || {}).size || entry.size || 0);
}

/** Blob id — the LFS sha256 (weights) if present, else the git blob oid. */
export function _entryOid(entry) {
  const lfsOid = (entry.lfs || {}).oid;
  if (lfsOid) return lfsOid;
  if (!Object.hasOwn(entry, "oid")) throw new KeyError("'oid'");
  return entry.oid;
}

/** The commit sha and the file tree, fetched together — the two HF round-trips both key
 * ONLY on `revision`, so they run CONCURRENTLY (2026-07-21: the user's "Getting ready" wait).
 * Same errors as Python: the sha's failure is reported first. */
async function shaAndTree(repo, revision) {
  const [sha, tree] = await Promise.allSettled([self._revisionSha(repo, revision), self._tree(repo, revision)]);
  if (sha.status === "rejected") throw sha.reason;
  if (tree.status === "rejected") throw tree.reason;
  return [sha.value, tree.value];
}

/**
 * Resolve [commitSha, [tree entries]] for the GGUF file(s) of `quant`.
 *
 * Matches `*.gguf` whose path carries `quant` as a WHOLE quant token (case-insensitive,
 * boundary-aware via `_quantMatches` — so "Q2_0" never grabs a "PQ2_0"/"Q2_0_g64" file) —
 * this naturally grabs every shard of a split model (`…-00001-of-00003.gguf`). If `mmproj` is
 * set, also include `*.gguf` whose path contains it (the multimodal-projector sidecar some
 * MoE GGUFs require even for text). Throws FileNotFoundError when nothing matches (bad
 * quant/repo — fail loud, never silently download the wrong thing).
 */
export async function selectFiles(repo, quant, mmproj = null, revision = "main") {
  const [commitSha, entries] = await shaAndTree(repo, revision);
  const selected = entries.filter((e) => e.path.toLowerCase().endsWith(".gguf") && self._quantMatches(quant, e.path));
  if (mmproj) {
    const mp = mmproj.toLowerCase();
    for (const e of entries) {
      const low = e.path.toLowerCase();
      if (low.endsWith(".gguf") && low.includes(mp) && !selected.includes(e)) selected.push(e);
    }
  }
  if (!selected.length) {
    throw new FileNotFoundError(`no .gguf matching quant ${pyRepr(quant)} in ${repo}@${revision}`);
  }
  return [commitSha, selected];
}

/** Resolve [commitSha, [tree entries]] for an EXPLICIT file list — exact repo-relative
 * paths — or the WHOLE repo tree when `files` is null. The generic sibling of `selectFiles`
 * (2026-08-14, the JustVoice speech-cache convergence): speech engines pin named checkpoint
 * files per variant. Any named file missing from the tree throws FileNotFoundError naming
 * it — fail loud, never fetch the wrong thing. */
export async function selectRepoFiles(repo, { revision = "main", files = null } = {}) {
  const [commitSha, entries] = await shaAndTree(repo, revision);
  if (files === null || files === undefined) return [commitSha, entries];
  const byPath = new Map(entries.map((e) => [e.path, e]));
  const missing = files.filter((f) => !byPath.has(f));
  if (missing.length) throw new FileNotFoundError(`files not in ${repo}@${revision}: ${missing.join(", ")}`);
  return [commitSha, files.map((f) => byPath.get(f))];
}

/** Public door to the HF bearer-auth headers for callers that stream `resolve/` URLs with
 * their own `streamDownload` (the JV speech cache). */
export function hfDownloadHeaders() {
  return self._hfHeaders();
}

// Quant token in a GGUF filename: Q4_K_M / IQ4_XS / PQ2_0 / UD-Q4_K_XL / Q4_0 / BF16 / F16…
// Leading `(?<![A-Za-z0-9])` word-boundary so a P-prefixed quant (PQ2_0) is its OWN token,
// not the tail "Q2_0" merged into the Q2_0 row; the Q family is `[IP]?Q` so PQ still
// matches. Case-sensitive.
export const _QUANT_RE = /(?<![A-Za-z0-9])(?:UD-)?(?:[IP]?Q\d[A-Za-z0-9_]*|BF16|F16|F32)/;

/** True when `quant` occurs in `path` as a WHOLE quant token (case-insensitive).
 * Boundary-aware (`[a-z0-9_]` neither side) so quant "Q2_0" matches `…-Q2_0.gguf` but NOT
 * `…-PQ2_0.gguf` (a different quant) nor `…-Q2_0_g64.gguf` (a longer one). The ONE
 * quant-match rule shared by `selectFiles` and `cachedGgufPath`. */
export function _quantMatches(quant, path) {
  const q = reEscape(quant.toLowerCase());
  return new RegExp(`(?<![a-z0-9_])${q}(?![a-z0-9_])`).test(path.toLowerCase());
}

/**
 * Is this quant token at least 4-bit — THE draft-pick floor (2026-07-19)?
 *
 * True for `Q4_*`/`IQ4_*`/`UD-Q4_*` and everything above (Q5/Q6/Q8, BF16/F16/F32); false for
 * Q2/Q3/IQ2/IQ3 (and `PQ2_0`-class, whose leading P does not change the bit-width) and for
 * an unrecognised/empty token.
 *
 * WHY a floor at all: a drafter only affects SPEED — the main model verifies every proposed
 * token, so draft bits can never change output quality, only the ACCEPTANCE rate. Smaller is
 * therefore better by default. But a 2/3-bit draft can degrade acceptance enough to cost more
 * verification passes than the bytes it saves. This predicate is that one guard — shared by
 * BOTH pickers (the tier-C suggestion here and the Add/Edit form's pre-select, via the
 * `q4OrBetter` flag on each draft row). Full precision counts as "at the floor" here, but
 * `_ggufDrafterInRepo` excludes BF16/F16/F32 outright — a BORROWED full-precision file is
 * usually a shard tail or the base model, not a drafter.
 */
export function _q4OrBetter(quant) {
  let q = (quant || "").trim().toUpperCase();
  if (q.startsWith("UD-")) q = q.slice(3);
  if (["BF16", "F16", "F32"].includes(q)) return true;
  const m = /^[IP]?Q(\d)/.exec(q);
  return !!m && Number(m[1]) >= 4;
}

// Architectures our pinned llama.cpp build cannot load. A DENY-set, not an allow-set: we
// can't durably enumerate every arch the engine DOES support (it moves with the build), but
// we CAN record the ones proven to fail. Exhibit: `dspark` (Ternary-Bonsai's own drafter) →
// the loader aborts with "unknown model architecture: 'dspark'". Detected from the FILENAME
// token (the publisher's `-dspark-` convention), which keeps this a PURE, network-free
// classifier.
const ENGINE_UNSUPPORTED_ARCHS = ["dspark"];

/** The engine-unsupported arch token embedded in `path` (case-insensitive), or "" — so a
 * draft row can carry WHY it won't load, not merely that it won't. */
export function _unsupportedArchInName(path) {
  const low = (path || "").toLowerCase();
  return ENGINE_UNSUPPORTED_ARCHS.find((a) => low.includes(a)) ?? "";
}

/**
 * PURE classification of an HF tree listing for the Add/Edit form (Plan B D9): the quant
 * dropdown + MTP-draft detection, one `_tree` call parsed two ways.
 *
 * Returns {quants: [...], drafts: [...]}:
 *   * quants — ONE row per quant token, shards SUMMED ({quant, sizeMb, files, kind, qat,
 *     q4OrBetter}); `kind` = "Q" | "IQ" | "special" (BF16/F16/…); `qat` = the path carries a
 *     QAT marker (a TRAINING property with no GGUF header key — it lives in the name).
 *     mmproj sidecars and files with NO recognizable quant token are skipped.
 *   * drafts — draft files (`MTP/` dir or `-MTP.gguf`; plus `dspark` in the name, the
 *     own-repo drafter convention), each its own row ({path, quant, sizeMb, qat, q4OrBetter,
 *     loadable, unsupportedArch}) since a draft is picked by exact path. `loadable` is false
 *     (with `unsupportedArch` naming the token) when the arch is one our engine can't load —
 *     so the form/tier-C/Lab sweep never pre-pick, offer, or A/B a draft that can only fail.
 */
export function classifyGgufEntries(entries) {
  const quants = new Map();
  const drafts = [];
  for (const e of entries) {
    const path = e.path ?? "";
    const low = path.toLowerCase();
    if (!low.endsWith(".gguf") || low.includes("mmproj")) continue;
    const size = _entrySize(e);
    const sizeMb = size ? Math.trunc(size / (1024 * 1024)) : 0;
    // Search the WHOLE path (not just the basename): split models often carry the quant in
    // a per-quant FOLDER (`UD-Q4_K_XL/model-00001-of-…`).
    const m = _QUANT_RE.exec(path);
    const quant = m ? m[0] : "";
    const qat = low.includes("qat");
    const isDraft = low.endsWith("-mtp.gguf") || low.includes("/mtp/") || low.startsWith("mtp/") || low.includes("dspark");
    if (isDraft) {
      const badArch = _unsupportedArchInName(path);
      drafts.push({
        path,
        quant,
        sizeMb,
        qat,
        q4OrBetter: _q4OrBetter(quant),
        loadable: !badArch,
        unsupportedArch: badArch,
      });
      continue;
    }
    if (!quant) continue; // no recognizable token → free-type territory, not a dropdown row
    const q = quant.toUpperCase();
    const bare = q.startsWith("UD-") ? q.slice(3) : q;
    const kind = bare.startsWith("IQ") ? "IQ" : q.includes("Q") ? "Q" : "special";
    // `q4OrBetter` rides QUANT rows too (fit-redesign §4 0.4): the form's nothing-fits
    // fallback prefers the smallest ≥4-bit quant over the truly smallest — the IQ1 ghost's
    // root was handing an 8 GB box a 1-bit file.
    if (!quants.has(quant)) {
      quants.set(quant, { quant, sizeMb: 0, files: 0, kind, qat, q4OrBetter: _q4OrBetter(quant) });
    }
    const row = quants.get(quant);
    row.sizeMb += sizeMb;
    row.files += 1;
  }
  return { quants: pySorted(quants.values(), (r) => r.sizeMb), drafts };
}

/** ONE `_tree` call → the classified quant/draft listing (the network thin wrapper over
 * `classifyGgufEntries`). Throws on a bad repo. */
export async function listRepoGgufs(repo, revision = "main") {
  return classifyGgufEntries(await self._tree(repo, revision));
}

// ── Tier-C inherited MTP drafter discovery (2026-07-13) ───────────────────────────────
// A model with NO built-in MTP (`nextn_predict_layers==0`) and NO draft in its OWN repo can
// still run speculative-decode MTP by borrowing the OFFICIAL base-family drafter — a small
// "-assistant"/"-MTP" repo that shares the base's vocab + embeddings (verified: gemma4
// 26B-A4B → `google/gemma-4-26B-A4B-it-assistant`). This DISCOVERS one at inspect time:
// derive candidate drafter repos from the base chain, probe HF, and return ONLY a repo that
// actually resolves and carries a .gguf — verified, never guessed. Best-effort: any
// network/parse failure yields null (no suggestion), never an exception into the caller.
const MTP_ARCH_FAMILIES = ["gemma4", "qwen3", "deepseek"]; // arch prefixes that support external MTP drafters
const DRAFTER_SUFFIXES = ["-assistant", "-MTP", "-mtp"]; // official companion-drafter repo naming
const OFFICIAL_ORGS = ["google/", "qwen/", "deepseek-ai/"]; // trust the vendor's own drafter, not a repackage

export async function _modelCard(repo, revision = "main") {
  return hfGetJson(`${_HF_BASE}/api/models/${repo}/revision/${revision}`);
}

/** 'https://huggingface.co/google/gemma-4-26B-A4B-it' | 'google/…' → 'google/…'. */
export function _normRepo(urlOrRepo) {
  let u = (urlOrRepo || "").trim().replace(/\/+$/, "");
  const at = u.indexOf("huggingface.co/");
  if (at >= 0) u = u.slice(at + "huggingface.co/".length);
  const segs = u.split("/").filter((p) => p);
  return segs.length >= 2 ? segs.slice(0, 2).join("/") : "";
}

/** cardData.base_model (str|list) + base_model:* tags, relation namespace stripped. */
export function _declaredBases(card) {
  const out = [];
  const bm = (card.cardData || {}).base_model;
  if (typeof bm === "string") out.push(bm);
  else if (Array.isArray(bm)) out.push(...bm.filter((b) => typeof b === "string"));
  for (const t of card.tags || []) {
    if (t.startsWith("base_model:")) {
      const parts = pySplit(t, ":", 2);
      out.push(parts.length === 3 ? parts[2] : parts[1]);
    }
  }
  const seen = new Set();
  return out.filter((b) => {
    if (!b || seen.has(b)) return false;
    seen.add(b);
    return true;
  });
}

/** Official (vendor-org) base repos to hang a drafter suffix off — walked from the GGUF
 * header's base repo + the HF base_model chain (up to 2 hops). Only vendor-org repos are
 * kept: the drafter must be the AUTHORITATIVE one, not a repackage. */
async function officialBaseCandidates(repo, baseRepoUrl, revision) {
  let frontier = [_normRepo(baseRepoUrl), repo].filter((r) => r);
  const officials = [];
  const seen = new Set();
  for (let hop = 0; hop < 2; hop++) {
    const nxt = [];
    for (const r of frontier) {
      if (!r || seen.has(r)) continue;
      seen.add(r);
      if (OFFICIAL_ORGS.some((o) => r.toLowerCase().startsWith(o))) {
        officials.push(r);
        continue;
      }
      try {
        nxt.push(..._declaredBases(await self._modelCard(r, revision)).map((b) => _normRepo(b)));
      } catch (e) {
        if (!isRequestError(e)) throw e;
      }
    }
    frontier = nxt;
  }
  // De-dup, preserve order.
  const out = [];
  for (const r of officials) if (r && !out.includes(r)) out.push(r);
  return out;
}

export async function _searchModels(query, limit = 15) {
  const j = await hfGetJson(`${_HF_BASE}/api/models`, { search: query, limit: String(limit) });
  return j.map((m) => String(m.id || m.modelId || ""));
}

const SHARD_RE = /-\d+-of-\d+\.gguf$/i; // split-shard tail

// The largest file this probe will ever call a "drafter": real external drafters are
// hundreds of MB (Gemma 26B: 252 MB; 12B: ~150 MB), and a hypothetical ~3B assistant at Q8
// stays under 4 GB — while a full-model MTP-VARIANT repo's smallest sane quant is well past
// it (the live case: 18 GB).
const DRAFTER_MAX_BYTES = 4 * 1024 ** 3;

/**
 * The smallest QUANTIZED single-file .gguf in `repo` at the pick FLOOR, as a drafter
 * {repo, file, quant} — or null (no usable candidate / repo doesn't resolve).
 *
 * Smallest wins because a drafter only affects SPEED: every drafted token re-reads the
 * draft's weights (`spec_n_max` times per cycle) and its weights+KV occupy VRAM the main
 * model's layers would otherwise use. `_q4OrBetter` is the floor under that rule: the
 * smallest candidate AT the floor wins, and only if none clears it does the smallest overall
 * win. Split shards, full-precision (BF16/F16/F32) files, and files whose architecture our
 * engine can't load (e.g. dspark — Fix C) are excluded outright: an fp16 shard tail (the
 * smallest FILE, but not a loadable model) or an unloadable-arch file is exactly the wrong
 * pick. (docs/plans/2026-07-19-draft-fit-floor-and-lab-measure.md)
 */
export async function _ggufDrafterInRepo(repo, revision = "main") {
  let entries;
  try {
    entries = await self._tree(repo, revision);
  } catch (e) {
    if (!isRequestError(e)) throw e;
    return null;
  }
  const candidates = []; // [tree entry, its quant token]
  for (const e of entries) {
    const path = String(e.path ?? "");
    const low = path.toLowerCase();
    if (!low.endsWith(".gguf") || low.includes("mmproj")) continue;
    if (SHARD_RE.test(path)) continue; // split shard — not a standalone loadable drafter
    const m = _QUANT_RE.exec(path);
    if (!m) continue; // no recognizable quant token
    const token = m[0];
    let q = token.toUpperCase();
    if (q.startsWith("UD-")) q = q.slice(3);
    if (!(q.startsWith("IQ") || q.includes("Q"))) continue; // BF16/F16/F32 → full precision, not a quantized drafter
    if (_unsupportedArchInName(path)) continue; // engine can't load this arch (e.g. dspark) — never suggest it (Fix C)
    candidates.push([e, token]);
  }
  if (!candidates.length) return null;
  // The floor first: smallest AT 4-bit-or-better, falling back to smallest overall only
  // when no candidate clears it (a Q2-only repo still gets a suggestion).
  const atFloor = candidates.filter((pair) => _q4OrBetter(pair[1]));
  const [best, quant] = pyMin(atFloor.length ? atFloor : candidates, (pair) => _entrySize(pair[0]));
  // A drafter is a SMALL speed device. A multi-GB "candidate" is a FULL MODEL, not a drafter
  // — caught live 2026-08-13: Qwen publishers ship "<model>-MTP-GGUF" VARIANT repos (MTP
  // heads PRESERVED in the main file, no external drafter at all), and this probe proposed
  // the variant's 18 GB IQ4_XS as a "draft" beside a 21 GB main. Better no suggestion.
  if (_entrySize(best) > DRAFTER_MAX_BYTES) return null;
  return { repo, file: String(best.path ?? ""), quant };
}

/**
 * Best-effort Tier-C: a borrowable drafter for an MTP-family model whose own repo ships
 * none. Walks the base chain to the OFFICIAL family root, finds its companion assistant/MTP
 * repo, and returns a usable GGUF drafter {repo, file, quant} — from the assistant repo
 * itself, or (the common case — official assistants ship safetensors, llama.cpp needs a
 * GGUF) from a community GGUF quant of it, VERIFIED to resolve. null when nothing usable
 * resolves. Never throws — discovery is advisory.
 *
 * (Python kept a base's roots in a `set`, whose iteration order changes per process; JS
 * tries the base itself first, then its "-it" root.)
 */
export async function findInheritedMtpDrafter(repo, architecture, baseRepoUrl = "", revision = "main") {
  const arch = (architecture || "").toLowerCase();
  if (!MTP_ARCH_FAMILIES.some((f) => arch.startsWith(f))) return null;
  let bases;
  try {
    bases = await officialBaseCandidates(repo, baseRepoUrl, revision);
  } catch {
    return null; // discovery is advisory; never break inspect
  }
  for (const base of bases) {
    // Strip a trailing precision/quant descriptor so a "-it-qat-q4_0-unquantized" base still
    // hangs the drafter off the "-it" root the vendor publishes it under.
    const roots = [base];
    const low = base.toLowerCase();
    for (const marker of ["-it-qat", "-it-", "-it"]) {
      if (low.includes(marker)) {
        const root = base.slice(0, low.indexOf(marker) + "-it".length);
        if (!roots.includes(root)) roots.push(root);
        break;
      }
    }
    for (const root of roots) {
      for (const suf of DRAFTER_SUFFIXES) {
        const assistant = root + suf;
        // 1) the official assistant repo itself, IF it ships a GGUF (rare).
        let got = await self._ggufDrafterInRepo(assistant, revision);
        if (got) return got;
        // 2) else a community GGUF QUANT of that exact assistant — search by its basename +
        // "GGUF", keep only hits that carry the basename AND "gguf", and return the first
        // that actually resolves with a .gguf inside.
        const name = assistant.split("/").at(-1);
        let hits;
        try {
          hits = await self._searchModels(`${name}-GGUF`);
        } catch (e) {
          if (!isRequestError(e)) throw e;
          hits = [];
        }
        for (const hit of hits) {
          const hl = hit.toLowerCase();
          if (!hl.includes(name.toLowerCase()) || !hl.includes("gguf")) continue;
          got = await self._ggufDrafterInRepo(hit, revision);
          if (got) return got;
        }
      }
    }
  }
  return null;
}

/** Offline check: is a GGUF for `quant` already in the local cache? A thin wrapper over
 * `cachedGgufPath` (ONE source of the snapshot-path + match rule) — no network call, cheap
 * enough to run per model when building the catalog. */
export function isCached(repo, quant, { cacheRoot, mmproj = null } = {}) {
  return self.cachedGgufPath(repo, quant, { cacheRoot, mmproj }) !== null;
}

/** Every entry under `dir` whose name matches, recursively (pathlib's rglob; the pattern
 * match is case-insensitive on Windows, as pathlib's is). */
function rglobNames(dir, suffix) {
  const out = [];
  const want = IS_WIN ? suffix.toLowerCase() : suffix;
  const walk = (d) => {
    let ents;
    try {
      ents = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      const p = join(d, ent.name);
      if ((IS_WIN ? ent.name.toLowerCase() : ent.name).endsWith(want)) out.push(p);
      if (ent.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
}

/** Path ordering as pathlib sorts it (component-wise; case-folded on Windows). */
const pathKey = (p) => (IS_WIN ? p.toLowerCase() : p).split(sep);

/** The on-disk path of a cached GGUF for `quant`, or null if not cached — the
 * path-returning sibling of `isCached` (SAME match rule, no network call). Lets the router
 * `.ini` emitter reference a downloaded model's file WITHOUT re-downloading it. Returns the
 * first shard of a split model (loading it pulls the rest). */
export function cachedGgufPath(repo, quant, { cacheRoot, mmproj = null } = {}) {
  void mmproj; // accepted for signature symmetry with isCached / acquireModel
  const snapshots = join(String(cacheRoot), `models--${repo.replaceAll("/", "--")}`, "snapshots");
  let isDir = false;
  try {
    isDir = statSync(snapshots).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) return null;
  const cands = pySorted(
    rglobNames(snapshots, ".gguf").filter((p) => _quantMatches(quant, p.split(sep).at(-1))),
    pathKey,
  );
  return cands.length ? cands[0] : null;
}

/**
 * Download the GGUF(s) for `quant` into the HF cache; return the snapshot dir llama.cpp
 * loads from (`…/snapshots/<sha>/`).
 *
 * Writes the canonical HF cache layout (blobs + snapshot symlink/copy + refs). Idempotent: a
 * blob already on disk at the right size is skipped. `onProgress(cumulative, total)` receives
 * cumulative bytes across ALL selected files against the summed grand total (one smooth
 * bar); `cancelCheck` is polled per file and passed to the stream. `segments`/`retries` are
 * the per-file knobs threaded down from `downloadKwargs`; the on-disk blob size is the
 * integrity check.
 *
 * `acquireModel(repo, quant, mmproj, {revision, cacheRoot, onProgress, cancelCheck,
 * segments, retries})`.
 */
export async function acquireModel(
  repo,
  quant,
  mmproj = null,
  { revision = "main", cacheRoot = null, onProgress = null, cancelCheck = null, segments = 1, retries = 3 } = {},
) {
  const [commitSha, files] = await self.selectFiles(repo, quant, mmproj, revision);
  const grandTotal = files.reduce((a, e) => a + _entrySize(e), 0) || null;

  const root = cacheRoot ? String(cacheRoot) : self.hfCacheRoot();
  const repoDir = join(root, `models--${repo.replaceAll("/", "--")}`);
  const blobsDir = join(repoDir, "blobs");
  const snapshotDir = join(repoDir, "snapshots", commitSha);
  const refsDir = join(repoDir, "refs");
  for (const d of [blobsDir, snapshotDir, refsDir]) mkdirSync(d, { recursive: true });

  let cumulative = 0;
  for (const entry of files) {
    if (cancelCheck && cancelCheck()) throw new DownloadCancelled();
    const path = entry.path;
    const oid = _entryOid(entry);
    const size = _entrySize(entry);
    const blob = join(blobsDir, oid);
    const snapshotFile = join(snapshotDir, path);
    mkdirSync(dirname(snapshotFile), { recursive: true });

    if (!existsSync(blob) || statSync(blob).size !== size) {
      // Re-stream over any partial of a different size (truncates dest).
      const fileUrl = `${_HF_BASE}/${repo}/resolve/${revision}/${path}`;
      const base = cumulative;
      log.info(`downloading ${path} (${size} bytes) from ${repo}`);
      await download.streamDownload(fileUrl, blob, {
        onProgress: onProgress ? (n, _t) => onProgress(base + n, grandTotal) : null,
        cancelCheck,
        segments,
        retries,
        headers: self._hfHeaders(),
      });
    }

    // snapshot/<path> -> blob. Relative symlink so the cache dir is movable; copy fallback on
    // Windows without symlink privilege (same as huggingface_hub).
    if (!existsSync(snapshotFile)) {
      try {
        symlinkSync(relative(dirname(snapshotFile), blob), snapshotFile, "file");
      } catch {
        copyFileSync(blob, snapshotFile); // shutil.copy2: the bytes + the times
        const st = statSync(blob);
        utimesSync(snapshotFile, st.atime, st.mtime);
      }
    }

    cumulative += size;
    if (onProgress) onProgress(cumulative, grandTotal);
  }

  // Pin refs/<rev> -> commit_sha so the resolver maps the symbolic ref next time.
  writeFileSync(join(refsDir, revision), commitSha);
  return snapshotDir;
}
