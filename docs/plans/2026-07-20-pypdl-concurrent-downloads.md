# pypdl cutover + concurrent model downloads (2026-07-20)

> ✅ **CLOSED (docs campaign 2026-08-04)** — done - shipped. History/evidence only; live work: `docs/dev/TASKS.md`.

**Status: DONE — shipped.** Two changes land together: (1) the hand-rolled
`requests`+thread-pool file segmenter is replaced by **pypdl**, and (2) model
downloads become **concurrent** (clicking Download on several models runs them in
parallel; the old single channel made a second click a silent no-op).

## Why

- **User-directed.** "Just use pypdl" — a maintained, concurrent, resumable
  downloader — instead of maintaining our own `requests`+threads byte-range
  segmenter (`_segmented_download`/`_preallocate`/`_probe_range_support`). pypdl
  pulls only `aiohttp`/`aiofiles`, so the JustWrite sidecar bundle stays ML-free.
- **Concurrency.** The download-only channel was a SINGLE `_download_state`: a
  second `download()` while one was in flight returned the in-flight state and did
  nothing. The user wants to queue several models and have them download at once.

## The adapter contract (`runner/download.py`)

`stream_download(url, dest, on_progress, cancel_check, *, segments, retries,
poll_interval)` is a thin adapter over `Pypdl`. Same public names as before
(`DownloadCancelled`, `download_kwargs`, `stream_download`). Both callers
(`models.acquire_model` for GGUF shards, `binary.py` for the engine archive) are
unchanged in shape. The subtle bits, each verified against the vendored pypdl
1.5.7 source:

- **Unlink-first.** We `dest.unlink(missing_ok=True)` BEFORE `start()`. pypdl's
  `overwrite=False` (which we need so a cancelled multisegment download RESUMES
  its part-files) ALSO treats an existing FINAL file as already-complete
  (`consumer.py:100` — `if not overwrite and exists(file_path): return success`).
  The caller only invokes `stream_download` when a (re)download is WANTED
  (`acquire_model` calls it only when the blob is absent or the wrong size;
  `binary.py` always wants a fresh archive), so deleting the final file
  neutralizes that footgun. The multisegment PART files live at DIFFERENT paths
  (`<dest>.0…N` + `<dest>.json`), so they survive the unlink and still resume.
- **`is_idle` loop guard.** The poll loop is `while not dl.completed and not
  dl.is_idle`. A pypdl coroutine that CRASHES (a `MainThreadException` sets
  `_interrupt` and drains the loop) never flips `completed`, so a bare `while not
  dl.completed` would spin forever. Success sets `completed` first (the monitor
  thread), then the tasks drain to idle — so the normal path exits on `completed`,
  the crash path on `is_idle`.
- **dest-exists is ground truth.** After the loop, `if dl.failed or not
  dest.exists(): raise RuntimeError(...)`. `combine_files` (multiseg) and the
  single-segment writer both write the final `dest` before the coroutine ends, so
  a present dest with an empty `failed` list is a real success; the message
  carries `dl.failed` so a genuine failure names what died. (pypdl's completion
  `callback` fires only at the very end — useless for a live bar — so we never use
  it; progress comes off the monitor-refreshed `current_size`/`size` attrs.)
- **Proxy passthrough.** aiohttp does NOT honour the `HTTP(S)_PROXY` env vars that
  `requests` did. We resolve `proxy = getproxies().get("https") or
  getproxies().get("http")` and pass it through `start()`'s `**kwargs`. VERIFIED
  from the pypdl source that a task's extra kwargs reach `session.head`/
  `session.get` on every request (producer `_fetch_metadata` → `extract_metadata`;
  consumer `_download` → `downloader.download`), so `proxy=` takes effect for both
  the HEAD probe and the range GETs. (No `no_proxy` handling — real downloads
  target HF/GitHub, which should use the proxy. Tests hit 127.0.0.1 and neutralize
  `getproxies` because an explicit aiohttp `proxy=` ignores `no_proxy`.)
- **sha return dropped.** `stream_download` returned a sha256 hex digest that
  neither caller used; dropping it avoids a full re-read pass over multi-GB
  weights. `acquire_model` never captured it (the on-disk blob size is the
  integrity check), and `binary.py` unpacks the archive regardless.
- **`Pypdl(max_concurrent=1, logger=log)`** — one file per adapter call
  (model-level concurrency lives one layer up, below); `logger=log` sends pypdl's
  own `logger.exception` to the server log, not pypdl's default file handler.

### A known pypdl quirk (cosmetic)

pypdl's reported `size` is the true content-length **∓1 byte** (its producer
zero-inits `task.size = Size(0,0)`, whose `.value` is `1`, and subtracts it). On a
multi-GB bar this is invisible — and `acquire_model` substitutes the TRUE HF total
(it ignores pypdl's `total` arg and passes its own `grand_total`), so the off-by-
one never reaches the model-download UI. The engine bar uses pypdl's total
directly (one byte low, irrelevant). The adapter's final `on_progress` tick forces
`(size, size)` so the bar still ends at a clean 100 %.

## Per-model concurrent downloads (`runner/lifecycle.py`)

The single `_download_state`/`_download_thread`/`_download_cancel` becomes three
maps keyed by model id, all guarded by the existing `self._lock`:

- `_download_states: {modelId: {status, modelId, detail, error, downloaded,
  total}}` — **absent == idle/done**; an `"error"` entry PERSISTS until a fresh
  `download()` replaces it.
- `_download_cancels: {modelId: Event}` and `_download_threads: {modelId:
  Thread}`.
- `_download_gate = threading.Condition(self._lock)` — the admission gate.

**Admission.** A worker `_await_slot`s: it parks on the condition while the number
of RUNNING downloads (entries whose `detail` has moved past `"queued"`) is `>=` the
LIVE limit, re-reading `download_max_concurrent` (clamped `[1, 10]`) each pass so the
knob is tunable without a restart, and re-checking its own cancel token every ~0.2 s
(the `wait` timeout) so a cancel WHILE QUEUED takes effect. On admission it flips its
entry's detail to `"model weights"` UNDER the lock, so the running-count is race-free.
A completing worker `notify_all()`s to wake the next in line.

- `download(id)` — idempotent: a second click while THIS model is
  downloading/queued returns its live state; a prior `"error"` entry is replaced.
- `cancel_download(id | None)` — with an id cancels just that model (queued or
  running); `None` cancels ALL (back-compat for any no-id "cancel everything"
  path). Idempotent.
- `download_status()` → `{"downloads": {id: entry}}`.
- The delete path cancels + joins THIS model's thread only (siblings keep
  downloading).

**Purge covers part-files (verified).** A cancelled download leaves `<blob>.0…N`
+ `<blob>.json` next to the blob under `<hf>/models--<repo>/blobs/`.
`_purge_model_weights` does `shutil.rmtree(repo_dir)` (the whole `models--<repo>`
dir) and `clear_models_cache` does `shutil.rmtree(hf)` — both cover the part-files
by construction; no widening needed.

## Wire-shape change + consumers updated

`GET /v1/llm-runner/download/status` now returns `{"downloads": {modelId:
entry}}` (was one flat entry). `POST /v1/llm-runner/download/cancel` accepts an
optional `{modelId}` (new `DownloadCancelRequest`; missing/null = cancel all).
Consumers updated:

- **`api._status_for`** — reads the per-model map (`downloads.get(id)`) instead of
  a single `dl_id`/`dl_state`; a downloading model → `"loading"`, an errored one →
  `"error"` (so the poll gate `anyLoading` keeps working).
- **`useRunnerModels.js`** — `downloadingId`(ref)/`cancelling`(ref)/`downloadProgress`
  (single) → `downloadingIds`(computed Set)/`cancellingIds`(Set)/a per-model
  `downloadMap` + one rate tracker per model (created/reaped as the status map
  changes). `loadErr` keeps the LOAD-channel error only; per-model download errors
  live in the map and surface via `taskFor(id)`. `cancelDownload(id)` POSTs
  `{modelId}`.
- **`useDownloadTask.js`** — `modelDownloadChannel(getId).read` extracts THIS
  model's entry: `readDownloadStatus((st.downloads || {})[getId()] || {status:
  "idle"})` (absent == the existing done-terminal); its cancel POSTs `{modelId}`.
  This keeps QuickSetup + LuBookSearchSetup working unchanged.
- **`LuModelCatalog.vue`** — the per-row Cancel is `v-if="downloadingIds.has(m.id)"`,
  `:loading="cancellingIds.has(m.id)"`, `@click="cancelDownload(m.id)"`.

## Knobs

- **`download_max_concurrent`** — new, default `4`, clamp `[1, MAX_DOWNLOAD_CONCURRENT
  = 10]`. Threaded through the same layers as the segment knobs: `config.py`
  constants + `RunnerConfig` + seed + stores round-trip + the engine-config API
  (`downloadMaxConcurrent`, clamped on write). Read LIVE at admission.
- **Segment knobs kept** — `download_segments_enabled` / `download_segment_count`
  (clamp 16) / `download_segment_retries` (clamp 10) still drive `download_kwargs`
  (now `{segments, retries}`).
- **`download_segment_min_bytes` RETIRED** — pypdl decides single- vs multi-segment
  itself from the server's `Accept-Ranges` + size, so the floor is inert. The
  constant, DB row, schema field, and config-API field are all KEPT
  accepting-but-inert for back-compat; `download_kwargs` no longer reads it.

## Trade-offs verified from pypdl source

- **Part-file naming** — `utils.create_segment_table` writes a `<dest>.json`
  progress file (`{"url","etag","segments"}`) and one `<dest>.{k}` file per
  segment (`0…N-1`). Resume validates the stored etag against the server's before
  reusing them.
- **`combine_files` disk behavior** — it opens `<dest>` (`"wb"`), and for each
  segment reads `<dest>.k`, appends it, then `aio_os.remove`s that part file
  IMMEDIATELY (inside the loop), finally removing `<dest>.json`. So parts ARE
  deleted as it appends — they don't all linger to the end. **Peak transient disk
  ≈ the full file + ONE segment**: at the instant before deleting segment `k`,
  `dest` holds segments `0…k` and part file `k` still exists (plus `k+1…N-1`) —
  i.e. `full_file + segment_k` (~1.2× the file at 4 segments), not ~2×.
- **Purge covers part-files** — confirmed above (`rmtree` of the repo/hf dir).

## Future work

Shard-level parallelism: `acquire_model` downloads a split model's shards
SEQUENTIALLY (one `stream_download` per shard). pypdl's `start(tasks=[...])` can
run a LIST of files concurrently — a future change could hand pypdl all shards of
one model at once (bounded by its own `max_concurrent`) instead of one at a time.
Out of scope here (this change is model-LEVEL concurrency); noted so the seam is
known.
