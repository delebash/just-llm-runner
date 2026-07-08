# Segmented (multithreaded) downloads — THE PLAN (DL-2)

**STATUS: PLAN ONLY — the user approves before any build** (queue doc
`2026-07-08-big-batch-queue.md` §8 DL-2: *"plan 2"*). Nothing in this document is
implemented.

## Why (the user's evidence, verbatim)

> "i have highspeed 1gb connection sometimes download is fast sometimes very slow"

That is the classic single-connection pattern: one TCP stream to one CDN edge rides
whatever that one path gives you — a slow edge or a congested hop caps the whole
download, while the line itself sits mostly idle. Splitting one file into N byte
ranges downloaded in parallel multiplies the paths and fills the pipe. "Multithreaded
download" = segmented / parallel-range downloading of ONE file.

## Verified facts (2026-07-08 — live web + live probes, nothing from memory)

1. **Hugging Face's own tooling exists because of this exact problem.**
   [hf-transfer](https://pypi.org/project/hf-transfer/) is the official Rust library
   that "divides individual files into multiple chunks to download in multiple
   threads"; the newer Xet backend uses adaptive parallel streams
   ([Hub docs](https://huggingface.co/docs/hub/models-downloading),
   [huggingface_hub#1831](https://github.com/huggingface/huggingface_hub/issues/1831)).
   Community reports corroborate that a single assigned CDN edge can be slow
   ([HF forum](https://discuss.huggingface.co/t/download-speed-way-too-slow/169824)).
2. **The HF CDN honors Range requests** — probed live from this container against
   `Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/Qwen3-Embedding-0.6B-Q8_0.gguf`
   (the seeded embed model; Content-Length 639,150,592 exactly matches our seeded
   size fact): the final CloudFront hop answers `accept-ranges: bytes`, and
   `Range: bytes=0-1023` returned **206 Partial Content with exactly 1024 bytes**.
3. **Parallel ranges aggregate and reassemble exactly** — timed in this container
   (through the agent proxy): the same 32 MB as 1 stream = **2.10 s (≈15.2 MiB/s)**;
   as 4 parallel 8 MB ranges = **1.40 s (≈22.9 MiB/s aggregate)**; the four parts
   concatenated were **byte-for-byte identical** to the single-stream bytes.
   Honest caveats: this measures the CONTAINER's proxied link, not the user's box
   (DL-1's new speed display is what measures the box); 8 MB segments barely
   amortize TCP ramp-up — real segments are hundreds of MB, where the win grows.
4. **Today's downloader is ONE connection** — `llm_runner/runner/download.py:21-61`
   `stream_download`: a single `requests.get(stream=True, timeout=600)`, 64 KB
   chunks, sha256 hashed INLINE as bytes arrive, `on_progress(downloaded, total)`
   throttled to ~1/MB, cancel polled per chunk, partial file left for the caller.
   Both consumers ride it: engine binaries (`binary.py`) and model GGUFs.

## The design

ONE function grows a segmented mode; both consumers get it for free. No new files
on disk beyond the destination (segments write into the SAME preallocated file at
their offsets — no part-files to join, no double disk usage).

1. **Settings — DB-backed, user-editable (the user's explicit requirement:**
   *"usually we have settings for this like number of threads ect"*), seeded rows
   in the existing settings surface, reachable via the engine/downloads area of the
   Built-in provider Edit view:
   - `downloadSegmentsEnabled` — on/off (proposed default: **on**).
   - `downloadSegmentCount` — parallel connections (proposed default: **4**;
     hf_transfer-class tools default 4–8; more mostly adds CDN load, not speed).
   - `downloadSegmentMinBytes` — files smaller than this stay single-stream
     (proposed default: **64 MB** — below that, ramp-up eats the win).
   - `downloadSegmentRetries` — per-segment retry count (proposed default: **3**).
2. **Capability probe, then fall back safely.** A HEAD (or the first GET's
   headers) must yield `accept-ranges: bytes` AND a known Content-Length AND
   size ≥ min-bytes AND segments enabled — else the EXISTING single-stream path
   runs unchanged (chunked responses, small files, odd mirrors: today's behavior).
3. **Preallocate + N workers at offsets.** Truncate `dest` to the full size once;
   each worker GETs `Range: bytes=a-b` and writes at its offset (its own file
   handle + seek — no shared-handle locking); segment boundaries = equal N-way
   split of the length.
4. **Per-segment retry + resume.** A worker that errors retries ITS range from
   the bytes it already wrote (`Range: bytes=(a+written)-b`), up to the retry
   setting; a segment that exhausts retries fails the download with the real
   error (partial file left for the caller's existing cleanup, as today).
5. **Cancel across workers.** The existing `cancel_check` is polled per chunk in
   every worker; first True stops them all; `DownloadCancelled` raised as today.
6. **sha256 moves AFTER assembly.** Inline hashing only works on an in-order
   stream; segmented writes are out of order — so hash the finished file in one
   sequential read pass (~1–2 s/GB on NVMe, negligible next to the download) and
   return the same hex digest. Single-stream path keeps its inline hash. Same
   return contract either way — callers unchanged.
7. **Progress aggregation into the SAME seam.** `on_progress(sum-of-segment
   counters, total)` at the same ~1/MB throttle — the status endpoints, both
   progress bars, and DL-1's speed+ETA display work UNCHANGED (the byte counter
   just climbs faster).
8. **Scope: both downloads** (model GGUFs + engine binaries) since both call
   `stream_download`. Multi-SHARD models still download shards sequentially —
   segmentation is per file (parallel shards would multiply connections × shards;
   not this plan).

## Verification plan (at build, after the user's go)

- Unit tests (pytest): segment boundary math (exact cover, no overlap, last-byte
  inclusive) · fallback matrix (no accept-ranges / no length / small file /
  disabled → single stream) · per-segment retry resume math · post-assembly
  sha256 equals the single-stream digest for the same bytes · cancel stops all
  workers.
- Container check: download a real small GGUF through the app path with
  segments on; assert the file's sha256 + the progress bar behavior live.
- Box check (the user, via DL-1's display): the same model download before/after —
  the speed number on the bar IS the measurement; if the 1 Gbit line's slow days
  don't improve, the segment count setting is the first knob to try.

## Rollout

Settings rows are additive seeds (no reset — the settings store fill-empty
precedent). No schema change. No UI beyond the settings rows (the bars already
show everything). If anything misbehaves on the box, `downloadSegmentsEnabled=off`
IS the rollback — the single-stream path stays intact underneath.
