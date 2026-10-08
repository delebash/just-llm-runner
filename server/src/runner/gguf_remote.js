// SPDX-License-Identifier: MIT
// Read a model's GGUF metadata from its HuggingFace link, BEFORE downloading the multi-GB
// weights (the port of llm_runner/runner/gguf_remote.py;
// docs/plans/2026-07-02-gguf-grounded-model-layer.md).
//
// `fetchGgufMeta(repo, quant)` resolves the model's `.gguf` shard(s) via the HF Hub API
// (reusing `models.selectFiles`), range-reads just the first few MB of the metadata shard,
// and parses it with the SAME parser the local path uses (`gguf.readGgufMetadataFromStream`)
// — one parser, local + remote. Returns [GgufMeta, total weight bytes] (summed shard sizes)
// for the fit estimate.
//
// As in Python, the range reads and generation_config.json carry no HF token (only the
// models.js API calls and downloads do).

import * as http from "../platform/http.js";
import { getLogger } from "../platform/log.js";
import { pySorted, ValueError } from "../platform/py.js";
import { iterBody, raiseForStatus, readTimeout } from "./download.js";
import { _classify, _parseHeader, _tensorSizes, ByteStream, readGgufMetadataFromStream } from "./gguf.js";
import * as models from "./models.js";
import { _entrySize, _HF_BASE } from "./models.js";
import * as self from "./gguf_remote.js";

const log = getLogger("llm_runner.runner.gguf_remote");

// The KV header (arch/general/sampling + tokenizer token & merge arrays) sits at the FRONT of
// the file. 24 MB covers a large-vocab model's header comfortably (Qwen3.6 ~248k-token vocab +
// GLM-4.5-Air both parsed within 16 MB, verified 2026-07-03); a rare bigger header triggers
// the one 4x retry below.
const HEADER_BYTES = 24 * 1024 * 1024;
const TIMEOUT = 60;

/** GET at most the first `n` bytes of `url` via an HTTP Range request.
 *
 * Streams and stops after `n` bytes, so even if the CDN ignores the Range header we never
 * pull the whole multi-GB file. Follows the HF resolve→CDN redirect. `timeout` is
 * requests' (connect, read) pair in seconds. */
export async function _rangeRead(url, n, timeout = TIMEOUT) {
  const rt = readTimeout({ connectS: timeout, readS: timeout });
  try {
    const r = await http.fetch(url, { headers: { Range: `bytes=0-${n - 1}` }, signal: rt.signal });
    rt.touch();
    await raiseForStatus(r, url);
    const parts = [];
    let got = 0;
    for await (const piece of iterBody(r, rt)) {
      parts.push(piece);
      got += piece.length;
      if (got >= n) break;
    }
    return Buffer.concat(parts, got).subarray(0, n);
  } finally {
    rt.done();
  }
}

/**
 * Resolve the `.gguf` for `quant` in HF `repo`, range-read its header, and return
 * [GgufMeta, totalWeightBytes].
 *
 * For a split model the metadata lives in shard `00001`; `totalWeightBytes` is the summed
 * size of every matching shard (the real on-disk model size, fed to fit.js). Throws
 * FileNotFoundError (no shard matches `quant`), network errors, or ValueError (not a GGUF).
 */
export async function fetchGgufMeta(repo, quant, revision = "main", headerBytes = HEADER_BYTES) {
  const [, entries] = await models.selectFiles(repo, quant, null, revision);
  const total = entries.reduce((a, e) => a + _entrySize(e), 0);
  const main = entries.find((e) => e.path.includes("00001")) ?? entries[0];
  const url = `${_HF_BASE}/${repo}/resolve/${revision}/${main.path}`;
  // The WHOLE shard's size (not the prefix): the tensor table sizes each tensor by offset
  // delta, and the last one runs to the end of the file (vram-truth §6.1).
  const mainSize = _entrySize(main) || null;

  let raw = await self._rangeRead(url, headerBytes);
  let meta;
  try {
    meta = readGgufMetadataFromStream(new ByteStream(raw), { fileSize: mainSize });
  } catch (e) {
    if (!(e instanceof ValueError) || !String(e.message).includes("truncated")) throw e;
    log.info(`gguf header exceeded ${headerBytes} bytes for ${repo} — retrying 4x`);
    raw = await self._rangeRead(url, headerBytes * 4);
    // Last resort: a tensor table that STILL runs past the prefix keeps the KV facts
    // (tensorBytesKnown false → the formula fallback), never fails.
    meta = readGgufMetadataFromStream(new ByteStream(raw), { fileSize: mainSize, strictTensors: false });
  }
  if (entries.length > 1 && meta.tensorBytesKnown) await mergeSplitTensorTables(meta, repo, revision, entries);
  return [meta, total];
}

const SHARD_HEADER_BYTES = 4 * 1024 * 1024; // a non-first shard's header: split.* KVs + its tensor infos

/** A split model's exact bytes span EVERY shard: each shard carries its own tensor table,
 * sized against its own file. Range-read each shard's header and merge. Any shard unreadable
 * → `tensorBytesKnown` false (a partial table would be worse than the formula fallback). */
async function mergeSplitTensorTables(meta, repo, revision, entries) {
  try {
    const sized = [];
    for (const e of pySorted(entries, (x) => x.path)) {
      const url = `${_HF_BASE}/${repo}/resolve/${revision}/${e.path}`;
      let raw = await self._rangeRead(url, SHARD_HEADER_BYTES);
      let infos;
      let dataStart;
      try {
        [, infos, dataStart] = _parseHeader(new ByteStream(raw), { wantTensors: true });
      } catch {
        // truncated: one 4x retry, then give up
        raw = await self._rangeRead(url, SHARD_HEADER_BYTES * 4);
        [, infos, dataStart] = _parseHeader(new ByteStream(raw), { wantTensors: true });
      }
      sized.push(..._tensorSizes(infos || [], dataStart, _entrySize(e)));
    }
    _classify(meta, sized);
  } catch {
    // never fail an inspect over the exact-bytes enrichment
    log.info(`split tensor-table merge failed for ${repo} — using the formula fallback`);
    meta.tensorBytesKnown = false;
  }
}

// ── generation_config.json fallback — the ORIGINAL model repo (from the GGUF header's
// `base_model.0.repo_url`) publishes the author-recommended samplers when the GGUF itself did
// not bake `general.sampling.*` in (GLM ships none, Qwen does). generation_config uses HF key
// names; we map to the llama.cpp namespace so header samplers and fallback samplers land as
// ONE key set. ──────────────────────────────────────────────────────────────────────────
const GEN_CFG_TO_LLAMA = { temperature: "temp", repetition_penalty: "penalty_repeat" };
const GEN_CFG_KEYS = ["temperature", "top_p", "top_k", "min_p", "typical_p", "repetition_penalty"];

/** 'https://huggingface.co/Qwen/Qwen3.6-27B' or 'Qwen/Qwen3.6-27B' → 'Qwen/Qwen3.6-27B'. */
export function _repoFromUrl(url) {
  let u = (url || "").trim().replace(/\/+$/, "");
  if (u.startsWith("http")) {
    const at = u.indexOf("huggingface.co/");
    u = at >= 0 ? u.slice(at + "huggingface.co/".length) : "";
  }
  const segs = u.split("/").filter((p) => p);
  return segs.length >= 2 ? segs.slice(0, 2).join("/") : "";
}

/** Fetch `generation_config.json` from the origin repo and extract its sampler keys, mapped
 * to llama.cpp names — the plan's header → generation_config → generic precedence for a
 * model's recommended samplers. Best-effort: {} on any error (missing file, gated/404 repo,
 * bad JSON), never throws. Every value is a Python float (`float(v)`; JS numbers don't mark
 * it — `top_k` 20 was 20.0). */
export async function fetchGenerationConfigSamplers(baseRepoUrl, revision = "main") {
  const repo = _repoFromUrl(baseRepoUrl);
  if (!repo) return {};
  const url = `${_HF_BASE}/${repo}/resolve/${revision}/generation_config.json`;
  let cfg;
  try {
    const r = await http.fetch(url, { timeoutMs: 2 * TIMEOUT * 1000 });
    await raiseForStatus(r, url);
    cfg = await r.json();
  } catch {
    return {}; // advisory fallback; never throw into the caller
  }
  const out = {};
  const isDict = cfg !== null && typeof cfg === "object" && !Array.isArray(cfg);
  for (const k of GEN_CFG_KEYS) {
    const v = isDict ? cfg[k] : undefined;
    if (typeof v === "number") out[GEN_CFG_TO_LLAMA[k] ?? k] = v;
  }
  return out;
}
