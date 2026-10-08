// SPDX-License-Identifier: MIT
// Port of tests/test_download.py — the chunk-queue downloader (`streamDownload`) against a
// REAL in-process HTTP server on 127.0.0.1 (offline, deterministic). Covers the contract:
// chunked (work-stealing) output is bytes-identical · single-stream fallback when the server
// has no Range support · segments=1 is a plain browser-style GET · the unlink-first guard ·
// cancel → DownloadCancelled · resume of a cancelled chunked download from its completed
// chunks · a chunk that exhausts retries → RuntimeError · the `downloadKwargs` shape +
// clamps · rate limiting (the 2026-07-24 StyleTune 429) · headers (the HF bearer token) ride
// every request · chunk COUNT is bounded. All 17 Python tests are ported.
//
// Chunk-path tests pass a SMALL `chunkSize` so the ~2 MB payload genuinely chunks (the
// production default is 8 MB, which would make this payload a single chunk).
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { sleep } from "../src/platform/asyncutil.js";
import { RuntimeError } from "../src/platform/py.js";
import { MAX_DOWNLOAD_SEGMENT_COUNT, MAX_DOWNLOAD_SEGMENT_RETRIES } from "../src/runner/config.js";
import * as dl from "../src/runner/download.js";
import { DownloadCancelled, downloadKwargs, streamDownload } from "../src/runner/download.js";

// ~2 MB + an odd tail so segment splits don't land on round boundaries.
const PAYLOAD = Buffer.alloc(2 * 1024 * 1024 + 137);
for (let i = 0; i < PAYLOAD.length; i++) PAYLOAD[i] = (i * 31 + (i >> 8)) % 256;

const CHUNK = 256 * 1024; // small test chunk so the ~2 MB payload genuinely chunks

let server;
let tmpPath;

/** The Python fixture's server, with the same knobs. */
function startServer() {
  const srv = {
    rangesEnabled: true,
    requests: [],
    failOnceEnds: new Set(),
    alwaysFailEnds: new Set(),
    bytesServed: 0,
    chunkDelay: 0.0,
    authHeaders: [],
    rateLimitNext: 0, // 429 the next N requests (after rateLimitSkip pass through)
    rateLimitSkip: 0, // let this many requests through before rate limiting
    rateLimitAll: false, // 429 EVERY request — the persistent limiter
    rateLimitHeaders: { "Retry-After": "1" },
  };

  /** Write `data` in 64 KB steps, honouring the throttle; a client that closed early (a
   * cancel) just ends the write. */
  const write = async (res, data) => {
    const step = 65536;
    for (let i = 0; i < data.length; i += step) {
      if (res.destroyed || res.writableEnded) return;
      const chunk = data.subarray(i, i + step);
      const ok = res.write(chunk);
      srv.bytesServed += chunk.length;
      if (!ok) {
        await new Promise((r) => {
          if (res.destroyed) return r();
          const done = () => {
            res.off("drain", done);
            res.off("close", done);
            r();
          };
          res.on("drain", done);
          res.on("close", done);
        });
      }
      if (srv.chunkDelay) await sleep(srv.chunkDelay * 1000);
    }
  };

  srv.http = createServer(async (req, res) => {
    res.on("error", () => {});
    const rng = req.headers.range;
    srv.requests.push(rng ?? null);
    srv.authHeaders.push(req.headers.authorization ?? null);
    let rateLimited = false;
    if (srv.rateLimitAll) rateLimited = true;
    else if (srv.rateLimitSkip > 0) srv.rateLimitSkip -= 1;
    else if (srv.rateLimitNext > 0) {
      srv.rateLimitNext -= 1;
      rateLimited = true;
    }
    if (rateLimited) {
      res.writeHead(429, { ...srv.rateLimitHeaders, "Content-Length": "0" });
      res.end();
      return;
    }
    if (rng && srv.rangesEnabled) {
      const m = /bytes=(\d+)-(\d+)/.exec(rng);
      const a = Number(m[1]);
      const b = Number(m[2]);
      const body = PAYLOAD.subarray(a, b + 1);
      res.writeHead(206, {
        "Content-Range": `bytes ${a}-${b}/${PAYLOAD.length}`,
        "Content-Length": String(body.length),
        "Accept-Ranges": "bytes",
        ETag: '"abc"',
      });
      // A configured failure: serve HALF the body then drop the connection — the worker
      // retries; when the fault is permanent (alwaysFailEnds), the whole file fails.
      let fail = false;
      if (srv.failOnceEnds.has(b)) {
        srv.failOnceEnds.delete(b);
        fail = true;
      } else if (srv.alwaysFailEnds.has(b)) {
        fail = true;
      }
      if (fail) {
        await write(res, body.subarray(0, Math.max(1, Math.floor(body.length / 2))));
        req.socket.destroy();
        return;
      }
      await write(res, body);
      res.end();
    } else {
      res.writeHead(200, { "Content-Length": String(PAYLOAD.length), ETag: '"abc"' });
      await write(res, PAYLOAD);
      res.end();
    }
  });
  return new Promise((resolve) => srv.http.listen(0, "127.0.0.1", () => resolve(srv)));
}

beforeEach(async () => {
  // A dev container may set HTTP(S)_PROXY to an agent proxy; these tests hit 127.0.0.1.
  vi.stubEnv("NO_PROXY", "127.0.0.1,localhost");
  vi.stubEnv("no_proxy", "127.0.0.1,localhost");
  tmpPath = mkdtempSync(join(tmpdir(), "kit-dl-"));
  server = await startServer();
});

afterEach(async () => {
  server.http.closeAllConnections?.();
  await new Promise((r) => server.http.close(r));
});

const url = (srv) => `http://127.0.0.1:${srv.http.address().port}/file.bin`;
const rangeGets = (srv) => srv.requests.filter((r) => r);

// ── chunked output ≡ the payload ─────────────────────────────────────────────────────

test("chunked_matches_payload", async () => {
  const dest = join(tmpPath, "seg.bin");
  await streamDownload(url(server), dest, { segments: 4, chunkSize: CHUNK, pollInterval: 0.02 });
  expect(readFileSync(dest).equals(PAYLOAD)).toBe(true);
  const nchunks = Math.floor((PAYLOAD.length + CHUNK - 1) / CHUNK);
  expect(rangeGets(server).length).toBe(1 + nchunks); // the probe + one GET per chunk
  // the .part file + the progress json are cleaned up on success.
  expect(readdirSync(tmpPath).filter((n) => n.startsWith("seg.bin."))).toEqual([]);
});

test("chunked_progress_reaches_total", async () => {
  const seen = [];
  await streamDownload(url(server), join(tmpPath, "p.bin"), {
    segments: 4,
    chunkSize: CHUNK,
    pollInterval: 0.02,
    onProgress: (d, t) => seen.push([d, t]),
  });
  expect(seen.length).toBeGreaterThan(0); // onProgress fired
  const last = seen.at(-1);
  expect(last[0]).toBe(last[1]); // the final tick reports 100 %
  expect(last[1]).toBe(PAYLOAD.length); // the probe's total is exact
});

// ── single-stream fallback / segments=1 ──────────────────────────────────────────────

test("falls_back_without_range_support", async () => {
  server.rangesEnabled = false;
  await streamDownload(url(server), join(tmpPath, "f.bin"), { segments: 4, pollInterval: 0.02 });
  expect(readFileSync(join(tmpPath, "f.bin")).equals(PAYLOAD)).toBe(true); // correct bytes via the single stream
});

test("segments_one_is_single_stream", async () => {
  // segments=1 is a plain full-file GET, no Range fan-out.
  await streamDownload(url(server), join(tmpPath, "one.bin"), { segments: 1, pollInterval: 0.02 });
  expect(readFileSync(join(tmpPath, "one.bin")).equals(PAYLOAD)).toBe(true);
  expect(rangeGets(server)).toEqual([]); // no multi-range fetch
});

// ── the unlink-first guard (BUG-A): a stale dest is NOT blessed as done ──────────────

test("unlink_first_overwrites_stale_dest", async () => {
  const dest = join(tmpPath, "stale.bin");
  writeFileSync(dest, Buffer.from("STALE".repeat(1000))); // wrong content + wrong size
  await streamDownload(url(server), dest, { segments: 1, pollInterval: 0.02 });
  expect(readFileSync(dest).equals(PAYLOAD)).toBe(true); // fresh download won, not the stale file
});

// ── cancel → DownloadCancelled ───────────────────────────────────────────────────────

test("cancel_raises_download_cancelled", async () => {
  server.chunkDelay = 0.01; // slow enough to catch mid-flight
  await expect(
    streamDownload(url(server), join(tmpPath, "c.bin"), { segments: 4, pollInterval: 0.01, cancelCheck: () => true }),
  ).rejects.toThrow(DownloadCancelled);
});

// ── resume a cancelled multisegment download from its part-files ─────────────────────

test("resume_after_cancel", async () => {
  const dest = join(tmpPath, "r.bin");
  const rchunk = 128 * 1024; // 17 chunks over 4 workers
  server.chunkDelay = 0.02; // stretch the transfer so cancel lands mid-flight
  const threshold = Math.floor(PAYLOAD.length / 2); // cancel at ~50 % served — several chunks are
  //                                                   certainly COMPLETED (and persisted) by then

  await expect(
    streamDownload(url(server), dest, {
      segments: 4,
      chunkSize: rchunk,
      pollInterval: 0.01,
      cancelCheck: () => server.bytesServed >= threshold,
    }),
  ).rejects.toThrow(DownloadCancelled);

  expect(existsSync(join(tmpPath, "r.bin.json"))).toBe(true); // the progress file survives the cancel
  expect(existsSync(dest)).toBe(false); // no final file yet (only r.bin.part)
  expect(server.bytesServed).toBeGreaterThan(0);

  server.chunkDelay = 0.0;
  await sleep(100); // let the cancelled responses' writers notice the closed sockets
  server.bytesServed = 0;
  server.requests = [];
  // SAME chunkSize — the resume validator matches (etag + chunkSize + total) and the completed
  // chunks are skipped, so the server serves strictly less than the whole file.
  await streamDownload(url(server), dest, { segments: 4, chunkSize: rchunk, pollInterval: 0.01 });
  expect(readFileSync(dest).equals(PAYLOAD)).toBe(true); // correct final bytes
  expect(server.bytesServed).toBeLessThan(PAYLOAD.length); // resumed → fewer bytes than a full fetch
});

// ── a chunk that exhausts its retries → RuntimeError, not Cancelled ──────────────────

test("a_genuine_failure_raises_runtimeerror", async () => {
  // The chunk containing the LAST byte always dies mid-body: that chunk exhausts its retries
  // and fails the download with RuntimeError (never DownloadCancelled — the user-cancel path).
  server.alwaysFailEnds = new Set([PAYLOAD.length - 1]);
  const err = await streamDownload(url(server), join(tmpPath, "x.bin"), {
    segments: 4,
    chunkSize: CHUNK,
    retries: 1,
    pollInterval: 0.02,
  }).catch((e) => e);
  expect(err).toBeInstanceOf(RuntimeError);
  expect(err).not.toBeInstanceOf(DownloadCancelled);
});

// ── rate limiting (429) — the 2026-07-24 StyleTune failure class ─────────────────────

/** Shrink rate-limit waits so the suite stays fast — `_rateLimitWait`'s PARSING is covered by
 * its own unit test below; these tests cover the control flow around it. */
const fastRl = () => vi.spyOn(dl, "_rateLimitWait").mockReturnValue(0.05);

test("probe_429_does_not_downgrade_to_single_stream", async () => {
  // THE StyleTune loss: a probe that swallowed a 429 into [0, ""] → single stream (slower,
  // non-resumable). The probe waits and re-probes, and the download stays chunked.
  fastRl();
  server.rateLimitNext = 1; // the probe's bytes=0-0 GET gets 429'd
  const dest = join(tmpPath, "rl.bin");
  await streamDownload(url(server), dest, { segments: 4, chunkSize: CHUNK, pollInterval: 0.02 });
  expect(readFileSync(dest).equals(PAYLOAD)).toBe(true);
  expect(rangeGets(server).length).toBeGreaterThan(2); // probe (429 + retry) + per-chunk GETs — chunked
});

test("chunk_429_waits_and_completes", async () => {
  fastRl();
  server.rateLimitSkip = 1; // the probe passes
  server.rateLimitNext = 2; // two chunk GETs each eat one 429
  const dest = join(tmpPath, "rl2.bin");
  await streamDownload(url(server), dest, { segments: 4, chunkSize: CHUNK, pollInterval: 0.02 });
  expect(readFileSync(dest).equals(PAYLOAD)).toBe(true); // both rate-limited chunks recovered
});

test("single_stream_429_recovers", async () => {
  fastRl();
  server.rateLimitNext = 1;
  await streamDownload(url(server), join(tmpPath, "s.bin"), { segments: 1, pollInterval: 0.02 });
  expect(readFileSync(join(tmpPath, "s.bin")).equals(PAYLOAD)).toBe(true);
});

test("persistent_429_fails_loudly_not_forever", async () => {
  fastRl();
  server.rateLimitAll = true;
  const err = await streamDownload(url(server), join(tmpPath, "x.bin"), {
    segments: 4,
    chunkSize: CHUNK,
    retries: 1,
    pollInterval: 0.02,
  }).catch((e) => e);
  expect(err).toBeInstanceOf(RuntimeError);
  expect(err.message).toContain("rate limited"); // the strike-out message, incl. HF_TOKEN hint
  expect(err).not.toBeInstanceOf(DownloadCancelled);
});

test("rate_limit_wait_parses_server_declared_waits", () => {
  // HF's IETF-draft RateLimit header (t= seconds until the window resets) wins…
  expect(dl._rateLimitWait({ RateLimit: '"resolvers";r=0;t=42' }, 1)).toBe(42.0);
  // …then a delta-seconds Retry-After…
  expect(dl._rateLimitWait({ "Retry-After": "7" }, 1)).toBe(7.0);
  // …an HTTP-date Retry-After falls through to the exponential backoff…
  expect(dl._rateLimitWait({ "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" }, 1)).toBe(15.0);
  expect(dl._rateLimitWait({}, 3)).toBe(60.0); // 15 × 2^(3-1)
  // …and everything caps at the 5-minute window.
  expect(dl._rateLimitWait({ RateLimit: '"resolvers";r=0;t=9999' }, 1)).toBe(300.0);
});

// ── headers ride every request (the HF bearer token path) ────────────────────────────

test("headers_ride_every_request", async () => {
  await streamDownload(url(server), join(tmpPath, "h.bin"), {
    segments: 4,
    chunkSize: CHUNK,
    pollInterval: 0.02,
    headers: { Authorization: "Bearer sekrit" },
  });
  expect(new Set(server.authHeaders)).toEqual(new Set(["Bearer sekrit"])); // the probe AND every chunk carried it
});

// ── request-count discipline — chunk count bounded (HF limits REQUESTS/window) ───────

test("chunk_count_is_bounded_by_request_discipline", async () => {
  // A pathologically small chunkSize would cost hundreds of requests; the scaling floor keeps
  // a file ≤ segments × 4 requests.
  await streamDownload(url(server), join(tmpPath, "b.bin"), { segments: 2, chunkSize: 4096, pollInterval: 0.02 });
  expect(readFileSync(join(tmpPath, "b.bin")).equals(PAYLOAD)).toBe(true);
  expect(rangeGets(server).length).toBeLessThanOrEqual(1 + 2 * 4); // the probe + at most segments×4 chunk GETs
});

// ── downloadKwargs — the {segments, retries} shape + the clamps (MODEL path) ─────────

test("download_kwargs_shape_and_collapse", () => {
  const c = { downloadSegmentsEnabled: true, downloadSegmentCount: 6, downloadSegmentRetries: 2 };
  expect(downloadKwargs(c)).toEqual({ segments: 6, retries: 2 }); // min_bytes is RETIRED — gone from the shape
  c.downloadSegmentsEnabled = false;
  expect(downloadKwargs(c).segments).toBe(1); // off → the single stream
});

test("download_kwargs_clamps_count_and_retries", () => {
  const over = { downloadSegmentsEnabled: true, downloadSegmentCount: 200, downloadSegmentRetries: 99 };
  const kw = downloadKwargs(over);
  expect(kw.segments).toBe(MAX_DOWNLOAD_SEGMENT_COUNT); // 200 → the ceiling
  expect(kw.retries).toBe(MAX_DOWNLOAD_SEGMENT_RETRIES);
  expect("segmentMinBytes" in kw || "segment_min_bytes" in kw).toBe(false); // the retired knob leaks nowhere
  const under = { downloadSegmentsEnabled: true, downloadSegmentCount: 0, downloadSegmentRetries: -5 };
  const kw2 = downloadKwargs(under);
  expect(kw2.segments === 1 && kw2.retries === 0).toBe(true); // floor: single stream, no negative retries
});
