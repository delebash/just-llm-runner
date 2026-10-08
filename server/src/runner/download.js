// SPDX-License-Identifier: MIT
// File downloads (engine binaries + model GGUFs) — the industry-standard CHUNK-QUEUE design
// (the port of llm_runner/runner/download.py).
//
// HOW PROFESSIONAL DOWNLOADERS WORK (IDM "dynamic segmentation", aria2, Steam, hf_transfer):
// the file is split into many FIXED-SIZE CHUNKS on a work queue, and N connections PULL
// chunks as they finish. No connection is pinned to a fixed 1/N slice, so a slow connection
// only delays the ONE chunk it holds while the fast connections keep pulling — aggregate
// speed is the SUM of the connections, never hostage to the slowest. (Static segmentation —
// each connection owning a fixed 1/N — was the engine-download crawl: GitHub's CDN hands out
// fast and slow connections unpredictably; measured on the user's box: static 8-segment ran
// at 1–4 MB/s while a single connection ran 20–26 MB/s.)
//
// Concurrency at BOTH levels:
//   * per FILE — `segments` worker connections pulling chunks off the queue (default 8, from
//     the config via `downloadKwargs`);
//   * across FILES — each model download runs as its own task with its own `streamDownload`
//     call (lifecycle, up to `download_max_concurrent` at once).
//
// Also standard: per-chunk RETRIES on a fresh connection (a stalled connection hits the read
// timeout, errors, and its chunk re-queues — stall recovery comes free), RESUME from
// completed chunks (`<dest>.json` records them, etag-validated; the partial rides in
// `<dest>.part`), cancel via `cancelCheck` (partials kept for resume), a single-stream
// fallback when the server has no Range support (or the file fits in one chunk), and
// `segments=1` = a plain browser-style GET. Transport: `platform/http.js` `fetch` (it honours
// HTTP(S)_PROXY / NO_PROXY).
//
// In JS a Python worker THREAD is an async task; writes are positioned (`FileHandle.write`
// at the chunk's offset), so chunks never overlap. The resume file is written synchronously
// (it is tiny) so two workers finishing together can't interleave its tmp + rename.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { dirname } from "node:path";
import { AsyncEvent, sleep, TimeoutError } from "../platform/asyncutil.js";
import * as http from "../platform/http.js";
import { HttpStatusError } from "../platform/http.js";
import { getLogger } from "../platform/log.js";
import { floorDiv, pyFloatParse, pyInt, pyRound, pySorted, RuntimeError, truthy, ValueError } from "../platform/py.js";
import { pyJson } from "../platform/pyjson.js";
import { MAX_DOWNLOAD_SEGMENT_COUNT, MAX_DOWNLOAD_SEGMENT_RETRIES } from "./config.js";
import * as self from "./download.js";

const log = getLogger("llm_runner.runner.download");

export const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024; // floor — see the request-count scaling in streamDownload
const CONNECT_TIMEOUT = 15.0;
const READ_TIMEOUT = 60.0; // a dead connection errors here → the chunk retries fresh

// REQUEST-COUNT DISCIPLINE (2026-07-24, the StyleTune 429). Every chunk is one HTTP request,
// and HuggingFace rate-limits by REQUEST COUNT per 5-minute window (anonymous: 3,000 resolver
// hits/IP — https://huggingface.co/docs/hub/rate-limits). At a fixed 8 MB chunk a 14 GB GGUF
// cost ~1,775 requests; two concurrent models busted the window on their own. So the chunk
// size SCALES with the file: a download never spends more than `segments × 4` requests (~32
// at the default 8), keeping work-stealing granularity (4 chunks per connection).
const CHUNKS_PER_WORKER = 4;

// Rate-limit semantics (same doc): a 429 carries the IETF draft-ietf-httpapi-ratelimit-headers
// `RateLimit` header (`"resolvers";r=0;t=<seconds until the window resets>`) — the correct
// client waits exactly `t`, which is what huggingface_hub 1.2+ does and what we mirror here.
// `Retry-After` is honoured as the second source; a bare 429/503 backs off exponentially.
// Rate-limit waits are NOT transport failures: they never consume a chunk's `retries` budget
// and instead share a per-download strike cap so a persistent limiter fails loudly, late.
const RATE_LIMIT_STATUSES = [429, 503];
const RATE_LIMIT_MAX_WAIT = 300.0; // ceiling per wait — the HF window is 5 minutes
const RATE_LIMIT_STRIKES = 6; // shared per download; then RuntimeError, loudly

/** Raised when `cancelCheck()` returns true mid-download (the chunked partial stays on disk
 * so a re-download resumes past the completed chunks). Not a RuntimeError. */
export class DownloadCancelled extends Error {
  constructor(m = "") {
    super(m);
    this.name = "DownloadCancelled";
  }
}

/** A download that kept hitting 429/503 past the shared strike cap — the loud terminal
 * failure, distinct from transport retry exhaustion. */
export class RateLimitExceeded extends RuntimeError {
  constructor(m) {
    super(m);
    this.name = "RateLimitExceeded";
  }
}

const monotonic = () => performance.now() / 1000;

// ── small HTTP helpers (candidates for platform/http.js) ────────────────────────────────

/** A header from a Fetch `Headers` or a plain object, case-insensitive; "" when absent. */
export function headerGet(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return headers.get(name) ?? "";
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === want) return v ?? "";
  return "";
}

/** requests' raise_for_status: a 4xx/5xx throws HttpStatusError (candidate for platform/). */
export async function raiseForStatus(r, url) {
  if (r.status >= 400) {
    const body = await r.text().catch(() => "");
    throw new HttpStatusError(r.status, url, body);
  }
}

/** Drop a response body we won't read, so its connection is released. */
export async function discard(r) {
  try {
    await r.body?.cancel();
  } catch {
    /* already closed */
  }
}

/**
 * requests' `timeout=(connect, read)` for one request (candidate for platform/http.js):
 * `signal` aborts when the response headers take longer than connect + read seconds, or —
 * after `touch()` — when the body goes `read` seconds without a byte. `outer` (a cancel
 * signal) aborts it too. Call `done()` when the request is over.
 */
export function readTimeout({ connectS = CONNECT_TIMEOUT, readS = READ_TIMEOUT, outer = null } = {}) {
  const ctl = new AbortController();
  let t = null;
  const arm = (s) => {
    clearTimeout(t);
    t = setTimeout(() => ctl.abort(new TimeoutError(`read timed out (${s} s)`)), s * 1000);
  };
  arm(connectS + readS);
  const onOuter = () => ctl.abort(outer.reason);
  if (outer) {
    if (outer.aborted) ctl.abort(outer.reason);
    else outer.addEventListener("abort", onOuter, { once: true });
  }
  return {
    signal: ctl.signal,
    touch: () => arm(readS),
    done: () => {
      clearTimeout(t);
      outer?.removeEventListener("abort", onOuter);
    },
  };
}

/** The response body as chunks (requests' iter_content), refreshing the read timeout on each
 * one; leaving the loop early cancels the body (the connection closes, as `with` did). */
export async function* iterBody(r, rt) {
  if (!r.body) return;
  const reader = r.body.getReader();
  let finished = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        return;
      }
      rt?.touch();
      if (value?.length) yield value;
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock?.();
  }
}

const errStr = (e) => (e == null ? "None" : (e.message ?? String(e)));

// ── rate limiting ───────────────────────────────────────────────────────────────────────

/** Seconds to wait for a 429/503: the `RateLimit` header's `t=` (HF's IETF-draft field,
 * seconds until the window resets) → `Retry-After` (delta-seconds) → exponential fallback.
 * Always at least 1 s, capped at the 5-minute window. (`headers`: Fetch Headers or an
 * object.) Python's max/min keep their first argument on a tie or a NaN — mirrored. */
export function _rateLimitWait(headers, strikes) {
  const pyMinMax = (v) => {
    const lo = v > 1.0 ? v : 1.0; // max(1.0, v)
    return lo < RATE_LIMIT_MAX_WAIT ? lo : RATE_LIMIT_MAX_WAIT; // min(MAX, lo)
  };
  const m = /[;\s]t=(\d+(?:\.\d+)?)/.exec(headerGet(headers, "RateLimit") || "");
  if (m) return pyMinMax(Number(m[1]));
  const ra = String(headerGet(headers, "Retry-After") || "").trim();
  try {
    return pyMinMax(pyFloatParse(ra));
  } catch (e) {
    if (!(e instanceof ValueError)) throw e; // an HTTP-date Retry-After falls to the backoff
  }
  return Math.min(RATE_LIMIT_MAX_WAIT, 15.0 * 2.0 ** Math.max(0, strikes - 1));
}

/** ONE gate per download: the first worker that sees a 429 sets the deadline and EVERY
 * connection (probe, single-stream, all chunk workers) parks until it passes — per-worker
 * sleeps would let the other connections keep hammering and extend the window. */
export class RateGate {
  constructor() {
    this.until = 0.0;
    this.strikes = 0;
  }

  /** Record one rate-limit hit; throws RateLimitExceeded past the shared cap. */
  strike(headers) {
    this.strikes += 1;
    if (this.strikes > RATE_LIMIT_STRIKES) {
      throw new RateLimitExceeded(
        `rate limited ${this.strikes} times (HTTP 429/503) — server window not ` +
          "clearing; set HF_TOKEN (raises the per-IP limit) or retry later",
      );
    }
    const wait = self._rateLimitWait(headers, this.strikes);
    this.until = Math.max(this.until, monotonic() + wait);
    log.warning(`rate limited (strike ${this.strikes}/${RATE_LIMIT_STRIKES}) — waiting ${pyRound(wait)} s`);
  }

  /** Park until the deadline passes; cancel stays instant (0.25 s poll). */
  async wait(cancelCheck) {
    while (true) {
      const remaining = this.until - monotonic();
      if (remaining <= 0) return;
      if (cancelCheck && cancelCheck()) throw new DownloadCancelled();
      await sleep(Math.min(0.25, remaining) * 1000);
    }
  }
}

/** Per-download options from a RunnerConfig — ONE place that collapses the `enabled` flag
 * into the connection count (off → 1 → a plain single stream), clamped to the config
 * ceilings (#10). Used by BOTH the engine archive and the model GGUFs. Spread it into
 * `streamDownload`'s options. `downloadSegmentMinBytes` is RETIRED (the downloader falls back
 * to a single stream by itself); the DB field stays inert for back-compat. */
export function downloadKwargs(config) {
  const attr = (k, d) => (config != null && k in config ? config[k] : d);
  const enabled = truthy(attr("downloadSegmentsEnabled", true));
  const rawCount = attr("downloadSegmentCount", 8);
  const count = Math.max(1, Math.min(MAX_DOWNLOAD_SEGMENT_COUNT, pyInt(truthy(rawCount) ? rawCount : 1)));
  const retries = Math.max(0, Math.min(MAX_DOWNLOAD_SEGMENT_RETRIES, pyInt(attr("downloadSegmentRetries", 3))));
  return { segments: enabled ? count : 1, retries };
}

/** Range-probe: [total size, etag] when the server honours byte ranges, else [0, ""]. A
 * 1-byte ranged GET (not HEAD — some CDNs answer HEAD without range headers).
 *
 * A 429/503 here WAITS on the gate and re-probes (up to the shared strike cap) instead of
 * falling through — a silent [0, ""] on a rate limit downgraded the download to the single
 * stream, which is slower AND cannot resume: exactly the 2026-07-24 StyleTune loss. */
async function probe(url, gate, cancelCheck, headers) {
  while (true) {
    const rt = readTimeout();
    try {
      const r = await http.fetch(url, { headers: { ...headers, Range: "bytes=0-0" }, signal: rt.signal });
      await discard(r);
      if (RATE_LIMIT_STATUSES.includes(r.status)) {
        gate.strike(r.headers); // throws RateLimitExceeded past the cap
        await gate.wait(cancelCheck);
        continue;
      }
      if (r.status === 206) {
        const cr = r.headers.get("Content-Range") ?? "";
        let total;
        try {
          total = pyInt(cr.slice(cr.lastIndexOf("/") + 1));
        } catch {
          total = 0;
        }
        if (total > 0) return [total, r.headers.get("ETag") ?? ""];
      }
    } catch (e) {
      if (e instanceof RateLimitExceeded || e instanceof DownloadCancelled) throw e;
      // a transport error: the download attempt itself will surface a real network problem
    } finally {
      rt.done();
    }
    return [0, ""];
  }
}

/** A plain browser-style GET — `segments=1`, no Range support, or a one-chunk file. A
 * 429/503 waits on the shared gate (never consuming a transport retry); genuine transport
 * errors keep the short-backoff retry budget. */
async function singleStream(url, dest, onProgress, cancelCheck, retries, gate, headers) {
  const part = `${dest}.part`;
  let last = null;
  let attempt = 0;
  while (attempt <= retries) {
    try {
      let done = 0;
      let total = null;
      const rt = readTimeout();
      try {
        const r = await http.fetch(url, { headers, signal: rt.signal });
        rt.touch();
        if (RATE_LIMIT_STATUSES.includes(r.status)) {
          await discard(r);
          gate.strike(r.headers); // throws RateLimitExceeded past the cap
          await gate.wait(cancelCheck);
          continue; // not a transport failure — attempt unchanged
        }
        await raiseForStatus(r, url);
        total = pyInt(r.headers.get("Content-Length") || 0) || null;
        const fh = await fsp.open(part, "w");
        try {
          for await (const piece of iterBody(r, rt)) {
            if (cancelCheck && cancelCheck()) throw new DownloadCancelled();
            await fh.write(piece, 0, piece.length);
            done += piece.length;
            if (onProgress) onProgress(done, total);
          }
        } finally {
          await fh.close();
        }
      } finally {
        rt.done();
      }
      renameSync(part, dest);
      if (onProgress) onProgress(done, total || done);
      return;
    } catch (e) {
      if (e instanceof DownloadCancelled) {
        rmSync(part, { force: true }); // no chunk map here → a partial single stream can't resume
        throw e;
      }
      if (e instanceof RateLimitExceeded) throw e; // the loud strike-out — never swallowed by the retry loop
      last = e; // every transport error retries, then surfaces below
      attempt += 1;
      await sleep(Math.min(2.0, 0.5 * attempt) * 1000);
    }
  }
  throw new RuntimeError(`download failed for ${url} after ${retries} retries: ${errStr(last)}`);
}

/** The completed-chunk set from a previous run — honoured only when the validator matches
 * (same etag/chunking/size), else the resume starts clean. */
function loadDoneChunks(pfile, etag, chunkSize, total) {
  try {
    const d = JSON.parse(readFileSync(pfile, "utf8"));
    if (etag && d && typeof d === "object" && d.etag === etag && d.chunkSize === chunkSize && d.total === total) {
      return new Set((d.done ?? []).map((i) => pyInt(i)));
    }
  } catch {
    /* OSError / ValueError → start clean */
  }
  return new Set();
}

/** The chunk-queue download: N worker tasks pull chunk indexes off a shared queue and write
 * each chunk at its offset into the preallocated `<dest>.part`. */
async function chunked(url, dest, onProgress, cancelCheck, workers, retries, chunkSize, total, etag, pollInterval, gate, headers) {
  const part = `${dest}.part`;
  const pfile = `${dest}.json`;
  const nchunks = floorDiv(total + chunkSize - 1, chunkSize);

  let done = loadDoneChunks(pfile, etag, chunkSize, total);
  if (!existsSync(part) || statSync(part).size !== total) {
    done = new Set();
    const fh = await fsp.open(part, "w");
    try {
      await fh.truncate(total); // sparse preallocate — chunks land at their offsets
    } finally {
      await fh.close();
    }
  }

  let bytes = 0;
  for (const i of done) bytes += Math.min(chunkSize, total - i * chunkSize);
  const state = { bytes, err: null };
  const cancelEvt = new AsyncEvent();
  const failEvt = new AsyncEvent();
  const cancelCtl = new AbortController(); // a cancel also aborts the requests in flight
  const todo = [];
  for (let i = 0; i < nchunks; i++) if (!done.has(i)) todo.push(i);

  const persist = () => {
    // Atomic (tmp + replace) so a kill mid-write can't leave a torn resume file.
    const tmp = `${pfile}.tmp`;
    writeFileSync(tmp, pyJson({ etag, chunkSize, total, done: pySorted(done) }));
    renameSync(tmp, pfile);
  };
  persist(); // record the validator up front — a cancel before any chunk still resumes cleanly

  const fetchChunk = async (i) => {
    const start = i * chunkSize;
    const end = Math.min(total, start + chunkSize) - 1;
    const want = end - start + 1;
    let last = null;
    let attempt = 0;
    while (attempt <= retries) {
      if (cancelEvt.isSet() || failEvt.isSet()) return false;
      let got = 0;
      try {
        const rt = readTimeout({ outer: cancelCtl.signal });
        try {
          const r = await http.fetch(url, {
            headers: { ...headers, Range: `bytes=${start}-${end}` },
            signal: rt.signal,
          });
          rt.touch();
          if (RATE_LIMIT_STATUSES.includes(r.status)) {
            await discard(r);
            gate.strike(r.headers); // throws RateLimitExceeded past the cap
            await gate.wait(() => cancelEvt.isSet());
            continue; // not a transport failure — attempt unchanged
          }
          if (r.status !== 206) {
            await discard(r);
            throw new Error(`expected 206 for chunk ${i}, got ${r.status}`);
          }
          const fh = await fsp.open(part, "r+"); // own handle per chunk; offsets never overlap
          try {
            for await (const piece of iterBody(r, rt)) {
              if (cancelEvt.isSet()) return false;
              await fh.write(piece, 0, piece.length, start + got);
              got += piece.length;
              state.bytes += piece.length;
            }
          } finally {
            await fh.close();
          }
        } finally {
          rt.done();
        }
        if (got !== want) throw new Error(`chunk ${i}: short read ${got}/${want}`);
        return true;
      } catch (e) {
        if (e instanceof DownloadCancelled) return false; // gate.wait saw cancelEvt — a cancel, not an error
        if (e instanceof RateLimitExceeded) {
          last = e; // the shared strike-out fails the download loudly
          break;
        }
        if (cancelEvt.isSet()) return false; // the cancel aborted this request
        state.bytes -= got; // the partial chunk re-downloads — keep the counter honest
        last = e; // any transport error re-queues this chunk
        attempt += 1;
        await sleep(Math.min(2.0, 0.5 * attempt) * 1000);
      }
    }
    state.err = last;
    failEvt.set();
    return false;
  };

  const worker = async () => {
    while (!cancelEvt.isSet() && !failEvt.isSet()) {
      const i = todo.shift();
      if (i === undefined) return;
      if (await fetchChunk(i)) {
        done.add(i);
        persist();
      }
    }
  };

  // A worker that dies on an unexpected error ends (as a Python thread did); the count check
  // below then fails the download.
  const tasks = Array.from({ length: Math.min(workers, nchunks) }, () =>
    worker().catch((e) => log.warning(`download worker failed: ${errStr(e)}`, e)),
  );
  let running = true;
  const all = Promise.all(tasks).then(() => {
    running = false;
  });
  while (running) {
    if (cancelCheck && cancelCheck() && !cancelEvt.isSet()) {
      cancelEvt.set();
      cancelCtl.abort(new DownloadCancelled());
    }
    if (onProgress) onProgress(state.bytes, total);
    await Promise.race([sleep(pollInterval * 1000), all]);
  }

  if (cancelEvt.isSet()) throw new DownloadCancelled(); // part + json stay → the next run resumes past `done`
  if (failEvt.isSet() || done.size !== nchunks) {
    throw new RuntimeError(`download failed for ${url} after ${retries} retries: ${errStr(state.err)}`);
  }
  renameSync(part, dest);
  rmSync(pfile, { force: true });
  if (onProgress) onProgress(total, total);
}

/**
 * Download `url` into `dest`. `segments` worker connections pull `chunkSize` chunks off a
 * queue (the module header); `segments=1`, a server without Range support, or a one-chunk
 * file runs a plain browser-style GET. `onProgress(downloaded, total)` gets cumulative bytes
 * (`total` null when unknown); `cancelCheck` polled every `pollInterval` s →
 * DownloadCancelled (chunked partials are kept for resume). Per-chunk failures retry on fresh
 * connections; a chunk that exhausts `retries` fails the download with RuntimeError. A
 * 429/503 parks EVERY connection on one shared gate for the server-declared wait without
 * spending transport retries. `headers` ride every request (the HF bearer token enters here).
 *
 * `chunkSize` is a FLOOR: it scales up so the whole file costs at most
 * `segments × CHUNKS_PER_WORKER` requests — request COUNT is what HF rate-limits. (A resume
 * across that change restarts clean: the resume validator records chunkSize.)
 *
 * Options mirror Python's keywords: `{onProgress, cancelCheck, segments, retries, chunkSize,
 * pollInterval (seconds), headers}` — `streamDownload(url, dest, {onProgress, cancelCheck,
 * ...downloadKwargs(cfg)})`.
 */
export async function streamDownload(
  url,
  dest,
  {
    onProgress = null,
    cancelCheck = null,
    segments = 8,
    retries = 3,
    chunkSize = DEFAULT_CHUNK_SIZE,
    pollInterval = 0.3,
    headers = null,
  } = {},
) {
  dest = String(dest);
  mkdirSync(dirname(dest), { recursive: true });
  // The caller only reaches here when a (re)download is WANTED — never bless a leftover dest.
  rmSync(dest, { force: true });

  const gate = new RateGate();
  const hdrs = { ...(headers || {}) };
  const segs = pyInt(segments);
  const tries = pyInt(retries);
  if (segs <= 1) {
    await singleStream(url, dest, onProgress, cancelCheck, tries, gate, hdrs);
    return;
  }
  const [total, etag] = await probe(url, gate, cancelCheck, hdrs);
  let cs = chunkSize;
  if (total) {
    const maxRequests = Math.max(1, segs) * CHUNKS_PER_WORKER;
    const floor = floorDiv(total + maxRequests - 1, maxRequests);
    if (floor > pyInt(cs)) cs = floor;
  }
  const nchunks = total ? floorDiv(total + cs - 1, cs) : 0;
  if (nchunks <= 1) {
    // no Range support, unknown size, or the file fits in one chunk
    await singleStream(url, dest, onProgress, cancelCheck, tries, gate, hdrs);
    return;
  }
  await chunked(url, dest, onProgress, cancelCheck, segs, tries, pyInt(cs), total, etag, pollInterval, gate, hdrs);
}
