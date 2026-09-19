# VRAM truth — exact bytes, one unit, real full offload

**Date:** 2026-09-19 · **Status:** PLANNED — Step 0 (measure, no code) first
**Executor:** Opus, against THIS document (user: *"write this plan up for opus to
execute, once plan is written in detail i will have opus run it"*).
**Self-contained:** every fact below was verified on 2026-09-19 (kit code reads,
llama.cpp source at the exact tags, the user's live DB and engine log). No
session transcript is needed. When a line number has drifted, the anchor is the
quoted identifier or comment, never the number.
**Origin:** the speed-truth spike (`2026-09-19-speed-truth-and-calibrated-pick.md`
§11.4) found `expert_byte_share()` returning 0 for a Granite MoE; Opus's
follow-up check found the 26B's on-card weights under-counted; a Fable review
of that check found the check itself mixed units, and found three more defects.
This plan is the reviewed result.

---

## §0 What this is

After this work the kit answers "how many MiB of this model land on the
graphics card for this launch" from the **file's own tensor table, sorted by
the engine's own placement rules, in one unit** — and every changed number is
validated against the **engine's own accounting**, never against our own
arithmetic. Four defects die:

1. **The byte model is a formula that is wrong for whole model families.**
   `GgufMeta.expert_byte_share()` (header dims only) returns **0** for
   Mixtral-style MoEs (Granite, Mixtral, DBRX… — the per-expert FFN lives in
   `feed_forward_length`, `expert_feed_forward_length` is absent), so they are
   priced as dense; it ignores every non-layer tensor (Gemma's 415 MB vocab
   table, which llama.cpp duplicates onto the GPU as the output head); and it
   assumes uniform quantization, which Unsloth "UD" quants break by design
   (experts at fewer bits than attention).
2. **Two units are mixed.** Weights, KV and the draft are computed in DECIMAL
   MB (`/ 1e6`) and compared against budgets and measurements in MiB
   (`// (1024*1024)`): every weight/KV figure is over-stated by 4.86 %
   (~930 MiB on a 20 GB model).
3. **Explicit-placement launches are one layer short of full offload.** A
   tuned "ngl 99" is clamped to `block_count` and rendered as `-ngl <n>`; in
   llama.cpp `-ngl n` means *output layer + the last n−1 blocks* — block 0
   stays on the CPU. (Untuned launches omit the flag and the engine places
   tensors itself — unaffected.)
4. **Split (multi-part) models are sized by their first part at load**
   (`compute_fit(meta, gguf.stat().st_size, …)` on shard 00001).

**User-visible result:** Fit badges, "Needs X GB VRAM" lines and computed
splits become right for every MoE family and for big models; tuned models may
generate faster (measured in Step 0 before anything changes). No new UI.

**The discipline this plan enforces** (the root cause of both this and the
stale 0.40 speed factor): *predict, then measure against the engine.* Step 0
writes predictions down BEFORE running the engine's estimator, and no fit
number changes until they agree.

---

## §1 Decision record (verbatim)

- 2026-09-19, user: *"your rec go"* → Opus's read-only check of the expert
  share (recorded in `docs/dev/TASKS.md`; its numbers are CORRECTED in §2.4).
- 2026-09-19, user: *"fable think on what opus found wrong and the solution"*
  → the review. Its recommendation, as shown to the user and approved by the
  next message:

  > **The fix I'd recommend, in order**
  > 1. **Measure first, no code.** It takes about 10 minutes and needs the GPU
  >    free. Launch the 26B with your exact flags and the engine's log turned
  >    up. The engine prints its own "CUDA0 model buffer size". The prediction
  >    to beat is **4,968 MiB**. Repeat with one dense model. Run the 30-vs-31
  >    layer A/B. Try `llama-fit-params.exe`, the engine's own estimator, which
  >    ships in your build. It may serve as a check that needs no GPU.
  > 2. **Fix the launch** so "all layers" means n_layers + 1, but only if the
  >    A/B shows a gain.
  > 3. **Store exact block sizes as new facts.** Read the sizes from the
  >    file's block offsets, so no table of quantization types is needed. Sort
  >    the blocks with the engine's own pattern, and handle multi-part files.
  >    Convert to MiB in the VRAM path. Keep the old share as the fallback.
  >    Existing databases fill the new fields on their own, with no migration.
  > 4. **Pin the tests to the engine's own numbers from step 1**, not to the
  >    formula's output. Stamp the overhead rows with the build on disk plus a
  >    physics version.

- 2026-09-19, user: *"write this plan up for opus to execute, once plan is
  written in detail i will have opus run it"* → this document.

**One correction made while writing this plan** (told to the user in the same
reply): the review said "every launch is one layer short". Verified narrower:
only launches with EXPLICIT placement (§2.3). The plan below is written to the
verified fact.

**Rulings the executor must ASK for, at the point each arises (never default):**

| # | Question | Recommendation |
|---|---|---|
| R1 | Step 0c's A/B lands between +0.5 % and +2 % (ambiguous) — adopt Step 1? | Adopt only on a clear gain (≥ 2 % on the 26B no-draft pair, or a gain larger than the spread on the dense pair). |
| R2 | Stamp `__overhead__` rows with the build ON DISK instead of the PIN? | Yes — the pin is b9993 while the engine actually running is b10437 (shared cache); "what is installed is a fact of the disk" is the kit's own QC-13 principle, and the new `__machine_moe_bw__` label already uses the disk build. |
| R3 | A re-pin of `test_fit_acceptance.py`'s measured band (26B → ncmoe ∈ [21, 23]) would be needed. | STOP and ask — the band is a MEASUREMENT (ncmoe 21 fits on the real card). Never widen it to make new physics pass. |

**R1–R3 DECIDED 2026-09-19 — user: *"opus execute plan r1-r3 your rec"*** — all
three recommendations above, as written: R1 adopt Step 1 only on a clear gain
(≥ 2 % on the 26B no-draft pair, or a dense-pair gain larger than its spread) ·
R2 stamp `__overhead__` with the build ON DISK · R3 never widen a measured band
— stop and ask instead.

---

## §2 Ground truth (all verified 2026-09-19)

### 2.1 llama.cpp's placement rules — identical in the PINNED b9993 and the ON-DISK b10437

`src/llama-model.cpp` (b10437 lines; b9993 has the same two lines at 1293-1294 and 1308):

```cpp
1347: const int i_gpu_start = std::max(n_layer_all + 1 - n_gpu_layers, 0);
1348: const int act_gpu_layers = devices.empty() ? 0 : std::min(n_gpu_layers, n_layer_all + 1);
1351: if (il < i_gpu_start || (il - i_gpu_start) >= act_gpu_layers) { … return {cpu_dev, …}; }
1362: // there is very little benefit to offloading the input layer, so always keep it on the CPU
1363: pimpl->dev_input = { cpu_dev, &pimpl->cpu_buft_list };
1372: pimpl->dev_output = get_layer_buft_list(n_layer_all);
```

Read: with flag value `k` on an `n`-block model, the GPU gets the **output
layer first** (any `k ≥ 1`), then the **last `k−1` blocks**; `k = n` leaves
**block 0 on the CPU**; only `k ≥ n+1` is full offload. The engine's own log
agrees (`:1656-1668`): `offloading output layer to GPU` · `offloading %d
repeating layers` · `offloaded %d/%d layers` with a max of `n_layer_all + 1`.
The input embedding table is ALWAYS on the CPU.

`src/models/gemma4.cpp:44-47` — no `output.weight` in the file →
`output = create_tensor(tn(LLM_TENSOR_TOKEN_EMBD, "weight"), …, TENSOR_DUPLICATED)`:
the vocab table is **duplicated onto the output device**. This tied-head
pattern (`TENSOR_NOT_REQUIRED` output, else duplicate `token_embd`) is the
common llama.cpp idiom for tied-embedding architectures.

`--n-cpu-moe N` keeps the expert tensors of the FIRST `N` blocks on the CPU by
tensor-name regex. **The regex is build-dependent** — b10437
`common/common.h:1113`:

```cpp
const char * const LLM_FFN_EXPS_REGEX = "\\.ffn_(up|down|gate|gate_up)_(ch|)exps";
```

(the b6895-era README still shows it WITHOUT `gate_up`). Source URLs:
`https://raw.githubusercontent.com/ggml-org/llama.cpp/<tag>/src/llama-model.cpp`,
`…/src/models/gemma4.cpp`, `…/common/common.h`.

### 2.2 The engine ships its own estimator — the validation oracle

The installed build dir (`<cache>/llamacpp/b10437/cuda12/`) contains
`llama-fit-params.exe`, `llama-completion.exe`, `llama-bench.exe` (listing
taken 2026-09-19). From b10437 `tools/fit-params/fit-params.cpp` +
`common/arg.cpp:2837`:

- `-fitp on` (`--fit-print`): *"printing estimated memory in MiB to stdout
  (device, model, context, compute)"* via `common_fit_print()` — a no-alloc
  dry run for the GIVEN params (it reads `-ngl`, `--n-cpu-moe`, `-c`, cache
  types). Related: `-fit on|off`, `-fitt MiB` (target margin, default 1024),
  `-fitc N`.
- A real load prints at clean exit (tool README):
  `llama_memory_breakdown_print: | memory breakdown [MiB] | total free self model context compute unaccounted |`
  with one row per device — MEASURED model / context / compute MiB.
- Log verbosity: `-lv N` (`arg.cpp:3872`; levels `common/log.h:24-29`: ERROR 1 ·
  WARN 2 · INFO 3 · TRACE 4 · DEBUG 5). The app's log prints
  `verbosity = 3 (adjust with the -lv N CLI arg)`. **Unverified:** the
  `LLAMA_LOG_INFO` lines `load_tensors: … model buffer size = … MiB`
  (`llama-model.cpp:1674`) did NOT appear at verbosity 3 in either log read
  today — Step 0 finds the level that shows them.

This is an ORACLE for validation, never a runtime dependency: the
pre-download badge has no local file to hand it (§3).

### 2.3 The kit's code paths

- **Load path** — `compute_fit(meta, total_weight_bytes, hardware, overrides, …)`
  (`runner/process.py:354`) takes a **GgufMeta object**: it has the local
  file. Expert share: `:454-455` `share_fn = getattr(meta, "expert_byte_share", None)`.
  Booking: `:576-584` `fit.moe_gpu_size_share(…)` → `fit.physics_vram_mb(size_mb=total_weight_bytes / 1e6, …)`.
  Joint solve: `:509-514` → `fit.moe_joint_split` (`fit.py:451-493`, pins
  `gpu_layers = n_layers`). Dense full offload: `:529` `n_gpu = n_layers`.
  **The clamp:** `:516` `n_gpu = max(0, min(n_layers, ov.n_gpu_layers))` — a
  tune's "99" becomes `n_layers`.
- **Fit-by-omission** — `lifecycle.py:2344-2351` (also `:2938`, `:3255`):
  `n_gpu_layers=fit.n_gpu_layers if fit.ngl_explicit else None` — UNTUNED
  launches omit `n-gpu-layers`/`n-cpu-moe` and the child's default `--fit`
  places tensors; only tune/preset/request-explicit knobs render. Pinned by
  `tests/test_lifecycle.py:2698-2726` (a "99" tune renders `n-gpu-layers = 24`
  on the 24-layer harness model — "the pre-existing compute_fit clamp").
  **So the one-short defect hits exactly the explicit launches** (class
  configs, autotune results, hand tunes, OOM-retry re-emits) — e.g. this box's
  26B: the live log's child argv has `--n-gpu-layers 30 --n-cpu-moe 21`.
- **The render point** — `process.py:215-216`
  `pairs.append(("n-gpu-layers", str(n_gpu_layers)))` inside
  `overrides_to_pairs` (argv AND models.ini). The load FINGERPRINT uses the
  kit's value, not the rendered flag: `lifecycle.py:2511`
  `sw = {"n_gpu_layers": str(f.n_gpu_layers), …}` — so changing the render
  does not orphan measured rows.
- **Facts path (pre-download)** — `llm/identity.py:113-150`
  `computed_row_numbers(facts, size_bytes, …)` (`size_mb = size_bytes / 1e6`,
  `share = facts["expert_byte_share"]`) → min_vram / min_ram / est;
  `runner/api.py:86-103` `_speed_facts` (per-token bytes via
  `fit.active_bytes_per_pass_mb`). Facts are built by
  `identity.physics_facts_from_meta` (`:64`), persisted as `model_catalog`
  columns, listed in THREE key tuples: `stores.py:209 _PHYSICS_FACT_KEYS`,
  `seed.py:795 _SEED_FACT_KEYS`, `scripts/refresh-seed-facts.py:60-67
  _SCALAR_FIELDS`. Additive columns go in `llm/db.py:714 _ADDED_COLUMNS`
  ("Additive only — never a drop/rename"). **The seed touch-up is gated:**
  `seed.py:801-811 _fill_physics_facts` returns early when the row already has
  `block_count` — new fact columns need their OWN gate or existing rows never
  fill.
- **The reader** — `runner/gguf.py:315-336 read_gguf_metadata_from_stream`
  reads `_tensor_count` (unused), walks every KV (arrays skipped except two
  per-layer ones), and STOPS — the stream is then positioned exactly at the
  tensor-info section. Remote: `runner/gguf_remote.py:54-79 fetch_gguf_meta`
  range-reads 24 MB of shard 00001 (one 4× retry on "truncated") and already
  holds the full shard list (`entries`, sizes via `_entry_size`). The kit's
  reader is dependency-free by design ("NO new dependency").
- **Units** — decimal: `process.py:488, 510, 520, 533, 584`,
  `lifecycle.py:1487`, `identity.py` (`size_bytes / 1e6`), KV `fit.py:311`,
  `:325` and `gguf.py:187` (the `kv_mb_from_facts` docstring SAYS MiB but
  divides by 1e6). MiB: every measurement and budget (`hardware.py`, all
  `// (1024 * 1024)`); `PHYSICS_OVERHEAD_MB` is documented "(MiB)"
  (`fit.py:275`). The SPEED path (`api.py:94`) is decimal MB against decimal
  GB/s — self-consistent, NOT part of this defect.
- **Learned overhead** — written `lifecycle.py:2537-2549`
  (`observed = trued_mb − (f.vram_mb − seed)`, label
  `f"physics-overhead {build}"`, `build = config.llamacpp.pinned_build`); read
  `lifecycle.py:1559-1570` (`str(label).endswith(build)`, same pin). Test pin:
  `tests/test_lifecycle.py:3680-3682` (`label.startswith("physics-overhead ")`).
- **Split models at load** — `lifecycle.py:1935` `return cands[0]  # first
  shard of a split model loads the rest`, then `:2340`
  `compute_fit(meta, gguf.stat().st_size, …)` — shard 1's size only. JW seeds a
  split MoE (`glm-4.5-air`), so this is in scope.

### 2.4 The numbers — this box's 26B, its real launch (`-ngl 30 --n-cpu-moe 21`, ctx 32768, KV q8_0, MTP draft)

Exact tensor bytes (tensor table, 2026-09-19; reproduce with Appendix A):

| | decimal MB | MiB |
|---|---|---|
| blocks 1–29 non-expert (block 0 is on the CPU) | 940.6 | 897.0 |
| experts of blocks 21–29 | 3,853.9 | 3,675.4 |
| output head = duplicated `token_embd` (2816 × 262144, Q4_0) | 415.2 | 396.0 |
| **exact weights on the card** | **5,209.7** | **≈ 4,968** |
| the kit's physics today (share 0.9389) | 4,884 | *(used as if MiB)* |

- Bytes-vs-bytes the formula is 326 MB (311 MiB) low; **as actually used**
  (the numeral 4,884 compared against MiB) the kit is **≈ 84 MiB low** — the
  unit over-statement (+4.86 %) nearly cancels the formula's miss on this model
  by accident.
- Measured footprint (3 load rows): 6,783 / 6,714 / 6,762 MiB. In ONE unit:
  6,762 − 4,968 − KV 420 (440.4 MB) − draft file 240 (251,937,728 B) =
  **≈ 1,134 MiB true engine overhead**; the kit's learned `__overhead__` rows
  are 1,058–1,127 — about right.
- **Opus's tracker numbers are therefore wrong and superseded:** "under-counts
  by 325 MB", "real overhead ~860", "every other model over-booked ~325 MB"
  all came from subtracting decimal MB from MiB.
- **Shipping exact bytes WITHOUT the unit fix makes this model worse**: the
  numeral becomes 5,210 against a truth of 4,968 MiB → +241 MiB over-booked →
  a computed split would push one more layer of experts to RAM.
- Whole-file facts: tensors total 14,233 MB; routed experts 12,846.4 MB (exact
  byte share **0.9026** vs the formula's 0.9389); per-kind non-expert bytes:
  attn_output 227.1 · attn_q 227.1 · ffn_down/gate/up 100.4 each · attn_k 89.2 ·
  attn_v 81.1 · ffn_gate_inp 43.6 · token_embd 415.2.
- Other configs to predict in Step 0 (same tensor table): flag 31 / ncmoe 21 →
  +block-0 non-expert (≈ 32.4 MB) ≈ **4,999 MiB**; flag 31 / ncmoe 30 (all
  experts in RAM) ≈ **1,324 MiB**; flag 31 / ncmoe 0 ≈ **13,575 MiB**.
- The exact per-token bytes are ALREADY validated on the speed side:
  1,387 MB device + 802.9 MB host predicted 39.5 ms/token with the speed
  check's bandwidth; pass C measured 37.65 (speed-truth plan §11.4).
- An older validation improves in the right unit: the fit redesign's "0.446
  GB/layer physics vs 0.41 measured, 9 % off" is 0.415 GiB vs 0.41 — 1.3 %.

### 2.5 The Mixtral-style bug, by evidence

`granite-3.1-1b-a400m-instruct-Q4_K_M.gguf` header: `architecture granitemoe`,
`block_count 24`, `embedding_length 1024`, `expert_count 32`,
`expert_used_count 8`, `feed_forward_length 512`,
**`expert_feed_forward_length` ABSENT**, heads 16/8. `gguf.py:137` returns 0.0
unless `expert_feed_forward_length > 0` → `active_bytes_per_pass_mb` →
(821.8, 0.0): priced as dense. Exact: 242 tensors, 820.1 MB, `*_exps` 731.4 MB
(share 0.8918), active experts 182.8 MB/token, blk.0 tensor kinds:
`attn_k attn_norm attn_output attn_q attn_v ffn_down_exps ffn_gate_exps
ffn_gate_inp ffn_norm ffn_up_exps`.

### 2.6 Seeds carrying the old share (5 rows, 2 apps)

```
JW seed_presets.py:113  gemma-4-26b-a4b-qat            share=0.9388753056
JW seed_presets.py:652  glm-4.5-air                    share=0.9283856552   (split GGUF; leading dense block)
JW seed_presets.py:701  gryphe-styletune-v2            share=0.9388753056
JW seed_presets.py:730  gemma-4-26b-a4b-uncensored-ez  share=0.9388753056
JV seed_presets.py:58   gemma-4-26b-a4b-qat            share=0.9388753056
```

docgen: `server/just_ai_i18n_docgen/app.py` matched `model_catalog_extra|hf_repo`
— the executor checks whether it seeds any rows with facts.
`seed.py:833 STALE_SEED_VALUES` (the in-place heal) is EMPTY and only serves the
kit's default-catalog path; app rows arrive through `seed_extra_catalog`,
fill-empty only — which is why this plan ADDS facts instead of redefining one.

---

## §3 NOT — rejected, with reasons (stays rejected)

- **Exact bytes without the unit fix** — flips this box's 26B from −84 MiB to
  +241 MiB (§2.4). The two ship together or not at all.
- **Redefining `expert_byte_share` in place** — 5 seed rows in 2 apps plus
  every existing DB would silently keep the old value (fill-empty, §2.6).
  New facts fill themselves; the old share stays as the fallback.
- **Patching the header formula per architecture as THE fix** — a moving
  taxonomy (which arches use `feed_forward_length` for experts), blind to the
  vocab table and to mixed-precision quants. (A 3-line Mixtral-style patch to
  the FALLBACK formula is still in scope — §6.1 — so the fallback is less
  wrong.)
- **Opus's acceptance test ("prediction = 5,210", "overhead drops to ~860")** —
  both are arithmetic on the same measured number; they pass whether or not the
  placement rules are right, and 860 is a unit error.
- **The engine's estimator as a runtime dependency for badges** — it needs a
  local file; the pre-download badge has none. Oracle only.
- **The PyPI `gguf` package inside the kit** — the kit's reader is
  dependency-free by design. It IS used in Step 0 as an INDEPENDENT reference
  the kit's own reader must later reproduce.
- **Touching** the RAM floor rule (`min_ram = whole file + headroom`), the speed
  model's canonical all-experts-in-RAM placement, `bw_eff_host_probe`, or the
  untuned fit-by-omission design — out of scope.

---

## §4 Step 0 — measure first (NO CODE). Predictions are written down BEFORE each oracle run.

**Precondition — the GPU must be free.** Ask the user to close JustVoice /
JustWrite (or unload the model). Verify: `nvidia-smi --query-gpu=memory.used
--format=csv,noheader` under ~1 GB and no `llama-server` process. Never kill by
image name; never touch a process you did not start.

Paths on this box:
- `EXE = E:\Dev\Web\justwrite-app\src-tauri\target\debug\data\ai-cache\llamacpp\b10437\cuda12\`
- `M26 = …\ai-cache\hf\models--unsloth--gemma-4-26B-A4B-it-qat-GGUF\snapshots\7b92b5b28818151e8669af2e45e88d6086f490dd\gemma-4-26B-A4B-it-qat-UD-Q4_K_XL.gguf`
- `MTP = (same snapshot)\MTP\mtp-gemma-4-26B-A4B-it-Q4_0.gguf`
- `M12 =` the downloaded 12B — locate: `find <ai-cache>/hf -iname "*gemma-4-12B*UD-Q4_K_XL*.gguf" -not -path "*/blobs/*"`
- `GRN = …\ai-cache\calib\3a2ec1c2a78cb29d901e29bbf5162dcd03381e13803d2cbdcff838d4d08142eb.gguf`

**0a — predictions.** Run Appendix A on M26, M12 and GRN; record in this
document's execution section the predicted on-card weight MiB for:
M26 × {(30, 21), (31, 21), (31, 30), (31, 0)} · M12 × {(48, 0), (49, 0)} ·
GRN × {(24, 0), (25, 0), (25, 24)} — pairs are (ngl FLAG, n-cpu-moe).
Expected for M26 from §2.4: ≈ 4,968 / 4,999 / 1,324 / 13,575 MiB.

**0b — the engine's estimate (no VRAM needed).** For each config:

```
llama-fit-params.exe -m <file> -ngl <k> --n-cpu-moe <c> -c 32768 -ctk q8_0 -ctv q8_0 -fa on -b 512 -ub 512 -fitp on
```

(start minimal; if the tool rejects a flag, drop it and note which). Record the
printed `(device, model, context, compute)` MiB rows. **Acceptance: our
predicted model-MiB within 1.0 % of the engine's on EVERY config.** A miss =
the placement rules in §2.1 are misread → STOP, report the numbers, change
nothing.

**0c — the measured breakdown (one real load each).** `llama-completion.exe`
exits by itself and should print `llama_memory_breakdown_print` at exit:

```
llama-completion.exe -m <M26> -ngl 30 --n-cpu-moe 21 -c 32768 -ctk q8_0 -ctv q8_0 -fa on -b 512 -ub 512 --no-mmap -n 16 -p "Hello" -no-cnv -lv 4
```

Record model / context / compute per device. If the breakdown does not print,
try `-lv 5`, then fall back to `llama-server` with the same flags and read the
`model buffer size` lines; record WHICH verbosity shows them (closes §2.2's
unverified item). Repeat with the draft flags (`--model-draft <MTP>
--spec-type draft-mtp --spec-draft-n-max 2`) if the tool accepts them —
this yields the draft's true cost and the real compute-buffer size (today both
hide inside "overhead").

**0d — the layer A/B** (Appendix B harness; per-token ms from the response
`timings`, never wall clock; 1 warm-up + 5 × 160 tokens, `ignore_eos`):
- M26, the app's exact flags WITHOUT the draft: `-ngl 30` vs `-ngl 31`
  (both `--n-cpu-moe 21`). This is the decision pair.
- M26 WITH the draft flags: same two arms (reported, not decisive — MTP
  acceptance adds noise).
- GRN dense-like: `-ngl 24` vs `-ngl 25`, `--n-cpu-moe 0` (24 blocks; block 0
  is ~1/24 of the weights, so the effect is large if real).
Record medians, spreads, and the VRAM delta (`nvidia-smi`) per arm.

**Step 0 is done when** 0b passes on every config, 0c's numbers are recorded,
and 0d has a verdict (adopt / skip / R1).

---

## §5 Step 1 — real full offload (ONLY if 0d shows a gain; else skip, physics still models the truth)

**Semantics:** the kit's `n_gpu_layers` keeps meaning "repeating blocks on the
GPU" (0…block_count) — fingerprints, tunes, the OOM shed and the UI are
untouched. Only the RENDERED flag changes, and only for the full-offload case:
partial tuned values were MEASURED under today's rendering and keep it.

1. `runner/process.py` — new helper beside `overrides_to_pairs`:

   ```python
   def engine_ngl_flag(n_gpu: int, block_count: int) -> int:
       """The `-ngl` value to EMIT. llama.cpp counts the output layer: `-ngl n`
       is output + the last n-1 blocks, block 0 on the CPU (llama-model.cpp
       i_gpu_start = n_layer + 1 - ngl). 'All blocks' therefore renders n + 1."""
       return block_count + 1 if block_count > 0 and n_gpu >= block_count else n_gpu
   ```
2. Apply it at the THREE `ModelIniEntry` construction sites
   (`lifecycle.py:2348`, `:2938`, `:3255` — `n_gpu_layers=engine_ngl_flag(fit.n_gpu_layers, fit.block_count) if fit.ngl_explicit else None`)
   and the single-model path (`process.py:965`). `FitPlan.block_count` already
   exists (`process.py:604`).
3. If Step 1 is SKIPPED, still add the helper returning `n_gpu` unchanged with
   the same docstring — §6's physics calls it either way (one source for
   "what flag do we emit").
4. Tests: `tests/test_lifecycle.py:2723` `"n-gpu-layers = 24"` → `25` (intended;
   cite 0d). Partial pins (`= 12`, `= 20`, `= 0`) must NOT move. Add a pure
   test for `engine_ngl_flag` (n → n+1; n−1 → n−1; 0 → 0; 99-clamped → n+1).
5. After deploy the user's 26B launches with `--n-gpu-layers 31`; expected
   VRAM +≈31 MiB (block-0 non-expert) + block-0 KV.

---

## §6 Step 2 — exact bytes, one unit (ships as ONE change)

### 6.1 The reader — `runner/gguf.py`

- After the KV loop, read `tensor_count` tensor infos: `name` (gguf string),
  `n_dims` (u32), `dims` (u64 × n_dims), `type` (u32), `offset` (u64).
  `alignment = kv.get("general.alignment") or 32`;
  `data_start = align_up(f.tell(), alignment)`; offsets are relative to it.
- **Sizes by offset delta** (no quant-type table to maintain): sort by offset;
  `size_i = offset_{i+1} − offset_i`; last = `(file_size − data_start) −
  offset_last`. Includes ≤ alignment−1 bytes of padding per tensor
  (negligible). `file_size` is a NEW optional parameter of
  `read_gguf_metadata_from_stream(f, *, file_size=None)`; `read_gguf_metadata(path)`
  passes `path.stat().st_size`. No `file_size` → `tensor_bytes_known = False`.
- **Classify by name:** `blk.<i>.…` → block `i`; expert iff
  `re.search(EXPS_REGEX, name)` with
  `EXPS_REGEX = r"\.ffn_(up|down|gate|gate_up)_(ch|)exps"` — ONE constant,
  commented "llama.cpp b10437 common/common.h:1113 LLM_FFN_EXPS_REGEX —
  re-verify on every pin bump (docs/llama-cpp-watch.md)". Non-block names
  starting with `output` → output side; every other non-block tensor → input
  side (CPU). **Tied head:** no `output.weight` tensor → add
  `bytes(token_embd.weight)` to the output side as a DUPLICATE (do not
  subtract it from the input side).
- **New `GgufMeta` fields:** `tensor_bytes_known: bool = False`,
  `layer_nonexp_bytes: list[int]`, `layer_exps_bytes: list[int]` (length
  `block_count`), `output_bytes: int`, `input_bytes: int`; properties
  `exps_bytes`, `layers_nonexp_bytes` (sums).
- **Truncation:** a truncated tensor-info section raises the SAME
  `ValueError("truncated …")` so `fetch_gguf_meta`'s 4× retry engages; if the
  retry still truncates, parse KV-only (`tensor_bytes_known = False`) rather
  than failing the inspect.
- **Split models:** each shard has its own header + tensor infos (non-first
  shards carry only `split.*` KVs — tiny). Remote: `fetch_gguf_meta`
  range-reads EVERY entry's header (small prefix, e.g. 4 MB, same retry) and
  merges the tables, each shard sized with its own `_entry_size`. Local: a new
  `read_gguf_metadata(path)` branch globs sibling
  `-0000N-of-0000M.gguf` files. Any shard unreadable → `tensor_bytes_known =
  False` (fall back; never a partial table).
- **The fallback formula gets the Mixtral-style convention:** in
  `expert_byte_share()`, when `expert_count > 0` and
  `expert_feed_forward_length <= 0` and `feed_forward_length > 0` → per-expert
  FFN = `feed_forward_length`, dense FFN = 0. (Granite header → ≈ 0.941.)

### 6.2 Stored facts — three additive columns

`exps_bytes`, `layers_nonexp_bytes`, `output_bytes` — all
`INTEGER NOT NULL DEFAULT 0`. Every site, in order:
1. `llm/db.py` — the `ModelCatalog` columns + three `_ADDED_COLUMNS` rows.
2. `llm/identity.py physics_facts_from_meta` — emit them when
   `meta.tensor_bytes_known` (else 0).
3. `llm/stores.py:209 _PHYSICS_FACT_KEYS`, `llm/seed.py:795 _SEED_FACT_KEYS`,
   `seed.py _catalog_row` kwargs, `scripts/refresh-seed-facts.py:60-67
   _SCALAR_FIELDS`.
4. `seed.py _fill_physics_facts` — a SECOND gate: when the row's
   `layers_nonexp_bytes` is 0 and the seed dict carries it, fill exactly the
   three new keys (the existing all-or-nothing `block_count` gate stays as is).
5. Seeds: extend + run `python scripts/refresh-seed-facts.py --write` — JW (all
   rows; `glm-4.5-air` proves the split path) and JV. Check docgen (§2.6).
   A reset is NOT required: fill-empty heals existing DBs at next boot, and
   download/inspect writes file truth.

### 6.3 Physics — `runner/fit.py`

```python
MIB = 1024 * 1024
PHYSICS_VERSION = "p2"          # bump when the byte model changes (overhead rows re-learn)

def engine_gpu_blocks(block_count: int, ngl_flag: int) -> range:
    """Block indices llama.cpp puts on the GPU for an EMITTED -ngl value
    (llama-model.cpp: i_gpu_start = n + 1 - ngl; the output layer goes first)."""
    start = max(block_count + 1 - max(0, ngl_flag), 0)
    return range(min(start, block_count), block_count) if ngl_flag > 0 else range(0)

def placed_weight_mib(*, layer_nonexp: list[int], layer_exps: list[int],
                      output_bytes: int, ngl_flag: int, n_cpu_moe: int) -> float:
    """Exact device-resident weight MiB: the output side (any ngl >= 1) + every
    GPU block's non-expert bytes + the expert bytes of GPU blocks >= n_cpu_moe."""
```

- `compute_fit` (load path): when `meta.tensor_bytes_known`, the weight term is
  `placed_weight_mib(…, ngl_flag=engine_ngl_flag(n_gpu, n_layers), …)` — it
  replaces `size × moe_gpu_size_share × g/n` at `process.py:519-527` (the
  full-offload check), `:576-584` (the booking) and inside the joint solve
  (`moe_joint_split` gains an optional `weights_fn(g, nc) -> MiB`; absent →
  today's share math). Unknown → today's path, in MiB. This path never reads
  `st_size`, so split models are right by construction; the FALLBACK must sum
  sibling shards (`lifecycle.py:2340` and the three other
  `gguf.stat().st_size` sites: `:1462`, `:1509`, `:2932`).
- Facts path (`identity.computed_row_numbers`), when `layers_nonexp_bytes > 0`:
  `min_vram = (layers_nonexp + output)/MIB + KV(floor_ctx) + overhead`;
  `est = (layers_nonexp + exps + output)/MIB + KV(est_ctx) + overhead`. Else
  the share path.
- Speed path (`api.py _speed_facts`), when the facts exist: non-expert per
  token = `(layers_nonexp + output) / 1e6`, active experts =
  `exps × used/total / 1e6` — **stays decimal MB** (decimal GB/s bandwidths;
  §2.3). This moves the 26B's split from 871 + 836 to ≈ 1,387 + 803 — the
  numbers pass C already validated.

### 6.4 One unit in the VRAM path

Replace `/ 1e6` with `/ MIB` at: `process.py:488, 510, 520, 533, 584`;
`lifecycle.py:1487`; `identity.py computed_row_numbers` (incl. `min_ram`);
KV `fit.py:311`, `:325`; `gguf.py:187`. Check `fit.py:72`'s callers and convert
it if it feeds a VRAM figure. **Web-verify before touching the regression**
(`estimate_vram_mb` / `max_gpu_layers`): oobabooga's blog
(`https://oobabooga.github.io/blog/posts/gguf-vram-formula/`) — confirm its
`size_in_mb` is bytes / 1024² (then MiB is the CORRECT input and the CI oracle
test keeps agreeing because both sides scale together); quote the line in the
execution record. Do NOT convert `api.py:94` (speed).

### 6.5 The learned overhead

Label `f"physics-overhead {build} {PHYSICS_VERSION}"` at the writer
(`lifecycle.py:~2548`); the reader (`:~1566`) matches
`endswith(f"{build} {PHYSICS_VERSION}")`. Old rows stop matching → the seed
overhead applies until the next measured load re-learns (self-healing; keep-K
prunes the old rows). R2 decides whether `build` becomes the disk build
(`self._installed_build(config)`) in BOTH places.

### 6.6 Tests

- NEW `tests/test_gguf_tensor_table.py` — a tiny in-memory GGUF builder
  (header + KVs + tensor infos + zero data): offset-delta sizing incl. the last
  tensor and alignment; tied vs untied head; the regex (`ffn_up_exps`,
  `ffn_gate_up_exps`, `ffn_down_chexps` match; `ffn_gate_inp` does not); a
  leading dense block (no exps in blk.0); split merge; truncated → KV-only
  fallback; the Mixtral-style formula fallback (Granite header values → > 0).
- `tests/test_fit.py` — `engine_gpu_blocks` truth table
  (n=30: flag 30 → blocks 1..29; 31 → 0..29; 1 → none + output; 0 → nothing);
  `placed_weight_mib` pinned to **Step 0b's engine numbers** for M26's four
  configs (fixtures = per-layer byte arrays dumped by Appendix A) — never to
  this plan's own arithmetic.
- Re-pins, each citing Step 0 in the execution record: `test_fit.py:218, 278,
  292, 306, 321-326, 350-381` · `test_bandwidth.py:40, 85-86` ·
  `test_fit_acceptance.py:9, 45, 55` (fixtures gain the exact arrays; the
  measured bands stay — R3) · `test_lifecycle.py:3680-3682` (label) · the JW
  `slotOptions`/model tests if a displayed number is pinned.
- After the kit's reader lands: a one-off cross-check (execution record, not a
  unit test) that it reproduces Appendix A's totals on M26, M12 and GRN
  byte-for-byte within padding (< 0.01 %).

---

## §7 Step 3 — gates · docs · the on-box check

- **Gates:** kit `ruff check .` + full pytest · `node scripts/verify-model-pick.mjs`
  · `node scripts/check-family.mjs` · JW `npm run test:fast` · JV `npm run
  test:unit`, `build:vite`, server pytest, and the smoke with
  `--data-dir src-tauri/target/debug/data` **with the user's app closed** (the
  gate server warm-loads the default model).
- **Docs (same change):** kit `docs/dev/serving-design.md` fit section (exact
  tensor bytes; MiB; the engine oracle; the ngl render rule) ·
  `docs/llama-cpp-watch.md` gains the pin-bump checklist: re-verify the
  placement lines (§2.1), `LLM_FFN_EXPS_REGEX`, the fit-params flags · JW
  `docs/models.md` / JV `docs/ai-features.md` only if a sentence about HOW the
  needs/fit numbers are computed changes (grep "needs ~", "physics").
- **On-box check after deploy:** the user loads the 26B once → a new
  `__overhead__` row labelled `… p2` lands; record it next to Step 0c's
  measured compute+context numbers. Catalog rows: the 26B's "Needs … VRAM"
  line and a Granite/Mixtral row read by link (must now show MoE numbers, not
  dense).

---

## §8 Blast radius (pasted greps, 2026-09-19)

| What changes | Pasted grep |
|---|---|
| Expert-share consumers | `identity.py:97`, `:136` · `runner/api.py:97` · `fit.py:348-354` · `process.py:454` · `gguf.py:120` · `seed.py:787`, `:796` · `stores.py:209` · `db.py:176`, `:723` |
| Decimal-MB sites (VRAM path) | `process.py:488, 510, 520, 533, 584` (`total_weight_bytes / 1e6`) · `lifecycle.py:1487` · `identity.py` `size_bytes / 1e6` · KV `fit.py:311, :325` · `gguf.py:187` — speed path `api.py:94` deliberately NOT changed |
| The one-short launch | `process.py:516` `max(0, min(n_layers, ov.n_gpu_layers))` · `:529` `n_gpu = n_layers` · `fit.py:469-477` (joint solve pins `gpu_layers=n_layers`) · render `process.py:215-216` · entry sites `lifecycle.py:2348, 2938, 3255` · `process.py:965` |
| Consumers of the KIT's layer value (must NOT see the +1) | `lifecycle.py:1469` (preview) · `:1559`, `:2537` (overhead gates) · `:2511` (fingerprint) · `:3179-3255` (OOM shed) |
| Tests pinning rendered flags | `test_lifecycle.py:502, 518, 678, 714, 736, 2707, 2723, 2747, 3134` (only `:2723` moves) · `test_calibrate.py:123-135` (bare speed-check argv — unaffected) |
| Tests pinning old byte numbers | `test_fit.py:218, 278, 292, 306, 321-326, 350-381` · `test_bandwidth.py:40, 85-86` · `test_fit_acceptance.py:9, 45, 55, 104-146` |
| Seeded old values | JW `seed_presets.py:113, 652, 701, 730` · JV `seed_presets.py:58` · docgen `app.py` to check |
| Existing heal path / exceptions | `seed.py:833 STALE_SEED_VALUES` (empty; default-catalog only) · `seed.py:801-811` fill gate · fit-by-omission `lifecycle.py:2344-2351` · overhead label pin `lifecycle.py:1559-1570`, `:2537-2549`, test `test_lifecycle.py:3680-3682` |
| Producers deleted/overwritten | none — columns additive, old share kept as fallback; old `__overhead__` rows are ignored by label, never deleted |

---

## §9 Execution order · stop conditions

Step 0 (user frees the GPU) → Step 1 (if 0d says so) → Step 2 (one change) →
Step 3. Each step's go is given in the executing session.
**STOP and report, change nothing further, when:** 0b misses 1 % on any config ·
the kit's reader disagrees with Appendix A · a measured band would need
widening (R3) · the regression's unit cannot be confirmed on the web.
Record everything (predictions, engine outputs, deviations, gates) in a §10
"Execution record" appended to this file as it happens — not at the end.

---

## Appendix A — the reference tensor table (scratchpad only)

```bash
python -m pip install -q --target ./pylib gguf      # NEVER into a project venv
```

```python
# tensor_table.py — usage: python tensor_table.py <gguf> [<gguf shard 2> …] -- <flag,ncmoe> [<flag,ncmoe> …]
import re, sys
sys.path.insert(0, "pylib")
from gguf import GGUFReader

EXPS = re.compile(r"\.ffn_(up|down|gate|gate_up)_(ch|)exps")   # llama.cpp b10437 common/common.h:1113
args = sys.argv[1:]; cut = args.index("--"); files, cfgs = args[:cut], args[cut + 1:]
nonexp, exps, inp, out, has_output_weight, embd = {}, {}, 0, 0, False, 0
for path in files:
    for t in GGUFReader(path).tensors:
        b, n = int(t.n_bytes), t.name
        if n.startswith("blk."):
            il = int(n.split(".")[1])
            (exps if EXPS.search(n) else nonexp).__setitem__(il, (exps if EXPS.search(n) else nonexp).get(il, 0) + b)
        elif n.startswith("output"):
            out += b; has_output_weight |= (n == "output.weight")
        else:
            inp += b
            if n == "token_embd.weight": embd = b
if not has_output_weight: out += embd              # tied head: duplicated onto the output device
N = 1 + max(list(nonexp) + list(exps))
MIB = 1024 * 1024
print(f"blocks={N} layers_nonexp={sum(nonexp.values())} exps={sum(exps.values())} output={out} input={inp} tied={not has_output_weight}")
print("layer_nonexp =", [nonexp.get(i, 0) for i in range(N)])
print("layer_exps   =", [exps.get(i, 0) for i in range(N)])
for cfg in cfgs:
    flag, ncmoe = map(int, cfg.split(","))
    start = max(N + 1 - flag, 0)
    gpu = [i for i in range(N) if i >= start and (i - start) < min(flag, N + 1)]
    w = (out if flag >= 1 else 0) + sum(nonexp.get(i, 0) for i in gpu) + sum(exps.get(i, 0) for i in gpu if i >= ncmoe)
    print(f"ngl_flag={flag} n_cpu_moe={ncmoe}: gpu blocks {gpu[:1]}..{gpu[-1:]} -> {w / MIB:,.1f} MiB on the card")
```

## Appendix B — the A/B timing harness (scratchpad only)

```python
# ab.py — edit EXE / MODEL / COMMON / ARMS; prints median ms/token per arm from llama.cpp's own timings.
import json, socket, statistics, subprocess, time, urllib.request
from pathlib import Path
EXE = r"<EXE>\llama-server.exe"; MODEL = r"<M26>"
COMMON = ["--n-cpu-moe", "21", "-c", "32768", "-ctk", "q8_0", "-ctv", "q8_0", "-fa", "on",
          "-b", "512", "-ub", "512", "--no-mmap", "--threads", "8"]
ARMS = [("ngl30", ["-ngl", "30"]), ("ngl31", ["-ngl", "31"])]
RUNS, TOKENS = 5, 160

def post(url, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as r: return json.loads(r.read())

for name, extra in ARMS:
    with socket.socket() as s: s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]
    log = open(Path(__file__).with_name(f"ab-{name}.log"), "w")
    proc = subprocess.Popen([EXE, "-m", MODEL, "--host", "127.0.0.1", "--port", str(port), *COMMON, *extra],
                            stdout=log, stderr=subprocess.STDOUT)
    base = f"http://127.0.0.1:{port}"
    try:
        t0 = time.monotonic()
        while True:
            try:
                if urllib.request.urlopen(base + "/health", timeout=2).status == 200: break
            except Exception: pass
            if proc.poll() is not None: raise SystemExit(f"{name}: server exited — see ab-{name}.log")
            if time.monotonic() - t0 > 600: raise SystemExit(f"{name}: health timeout")
            time.sleep(0.5)
        body = {"messages": [{"role": "user", "content": "Write a long, detailed story about a lighthouse keeper."}],
                "max_tokens": TOKENS, "stream": False, "temperature": 0.7, "ignore_eos": True}
        post(base + "/v1/chat/completions", body)                      # warm-up, discarded
        ms = []
        for _ in range(RUNS):
            t = post(base + "/v1/chat/completions", body)["timings"]
            ms.append(t["predicted_ms"] / t["predicted_n"])
        med = statistics.median(ms)
        print(f"{name}: median {med:.3f} ms/token ({1000/med:.1f} tok/s) spread {max(abs(x-med)/med for x in ms)*100:.1f}%  runs {[round(x,3) for x in ms]}")
    finally:
        proc.terminate()
        try: proc.wait(timeout=20)
        except subprocess.TimeoutExpired: proc.kill()
        log.close()
```

For the draft pair append `"--model-draft", r"<MTP>", "--spec-type", "draft-mtp",
"--spec-draft-n-max", "2"` to `COMMON`; for the dense-like pair set
`MODEL = r"<GRN>"`, `COMMON = ["--n-cpu-moe", "0", "-c", "2048"]`,
`ARMS = [("ngl24", ["-ngl", "24"]), ("ngl25", ["-ngl", "25"])]`.

---

## §10 Execution record (appended as it happens)

### 10.0 Rulings + precondition (2026-09-19)
Go: *"opus execute plan r1-r3 your rec"* — R1–R3 as recommended (§1). GPU at
start: 724 MiB used of 8192, no llama-server / JustVoice / JustWrite process.

### 10.1 Step 0a — predictions (written BEFORE any engine run)
Reference reader: PyPI `gguf` in the scratchpad (`vram/tensor_table.py` =
Appendix A). On-card WEIGHT MiB per (ngl FLAG, n-cpu-moe):

| model | tensor facts | predictions |
|---|---|---|
| 26B UD-Q4_K_XL (30 blocks, tied) | layers_nonexp 971,591,800 B · exps 12,846,382,080 B · output 415,247,360 B | (30,21) **4,968.4** · (31,21) **4,998.0** · (31,30) **1,322.6** · (31,0) **13,573.9** |
| 12B UD-Q4_K_XL (48 blocks, dense, tied) | layers_nonexp 6,134,284,480 B · output 566,246,400 B | (48,0) **6,269.8** · (49,0) **6,390.1** |
| Granite 1B-A400M Q4_K_M (24 blocks, tied) | layers_nonexp 47,431,680 B · exps 731,381,760 B · output 41,294,296 B | (24,0) **749.0** · (25,0) **782.1** · (25,24) **84.6** |

### 10.2 Step 0b — the engine's estimator: **PASS on all 11 configs**
`llama-fit-params.exe` (b10437, installed build dir) `-fitp on` — stdout rows
are `<device> <model MiB> <context MiB> <compute MiB>`. 26B/12B flags:
`-c 32768 -ctk q8_0 -ctv q8_0 -fa on -b 512 -ub 512`.

| config (flag, ncmoe) | predicted | engine model | engine context · compute (CUDA0) | Host model |
|---|---|---|---|---|
| 26B (30,21) — THE APP'S LAUNCH | 4,968.4 | **4,968** | 493 · 537 | 9,001 |
| 26B (31,21) | 4,998.0 | **4,998** | 499 · 527 | 8,971 |
| 26B (31,30) | 1,322.6 | **1,322** | 499 · 527 | 12,647 |
| 26B (31,0) | 13,573.9 | **13,573** | 499 · 527 | 396 |
| 12B (48,0) | 6,269.8 | **6,269** | 520 · 527 | 660 |
| 12B (49,0) | 6,390.1 | **6,390** | 527 · 527 | 540 |
| Granite (24,0) | 749.0 | **749** | 5,888 · 392 | 72 |
| Granite (25,0) | 782.1 | **782** | 6,144 · 158 | 39 |
| Granite (25,24) | 84.6 | **84** | 6,144 · 171 | 736 |

Every engine figure is within 1 MiB of the prediction (< 0.2 %; bar 1.0 %).
Confirmed by the engine: the placement rules of §2.1 (block 0 on CPU at flag
= n; the output layer + the duplicated vocab table on the card), the regex,
and the Mixtral-style Granite (the old formula's "dense" read is wrong; its
experts are separable exactly as the tensor table says). Host "model" at
flag 31 = 396 MiB = the input vocab copy, which stays on the CPU.
Notes: (1) Granite + `-ctk/-ctv q8_0 -fa on -c 2048` aborts the estimator
(`ggml-impl.h:318: fatal error`) — an engine limitation with that
combination; its rows above use the engine defaults (no ctx/cache flags), so
its context column is at the model's default ctx and not comparable — only
the model column is the check. (2) The engine's context for the 26B at the
app's flags (493 MiB) exceeds the kit's KV figure (440.4 decimal MB = 420
MiB): recorded for Step 0c — do not act on it here.

### 10.3 Step 0c — the engine's MEASURED breakdown (real loads)
**26B, app flags, no draft** (`llama-completion.exe … -ngl 30 --n-cpu-moe 21 -c 32768
-ctk q8_0 -ctv q8_0 -fa on -b 512 -ub 512 --no-mmap -lv 4`): `offloaded 30/31
layers to GPU` (block 0 on the CPU — confirmed) · `CUDA0 model buffer size =
4968.43 MiB` (prediction 4,968.4) · `CUDA_Host model buffer size = 9001.48` ·
KV CUDA0 340 + 153 = 493 MiB + CPU 6.38 (block 0) · compute CUDA0 537.32 ·
`memory breakdown … self 5998 = 4968 + 493 + 537`.

**26B, the app's EXACT argv via llama-server** (copied from the app's router
log; `server_load.py`; `llama-completion` rejects `--model-draft`):
main model 4,968.43 · main KV CUDA0 340 + **459** = **799** MiB (+ CPU 19.12) ·
main compute 466.74 · **MTP draft model 225.21** MiB on the card (+144.00 on
the host) · draft compute 208.78 · **card-used delta 6,789 MiB** vs the app's
measured load rows 6,714 / 6,762 / 6,783 — the replica is faithful.

**Log verbosity (closes §2.2's unverified item):** `-lv 3` (the app's default)
prints ZERO `model buffer size` lines; `-lv 4` prints them (checked on
llama-completion, same model, same flags otherwise).

**FINDING, out of this plan's scope (recorded, NOT acted on):** under
llama-server the KV is **799 MiB**, not the single-sequence 493 — the server's
default parallel slots (4, unified KV) scale the windowed-layer cache
(153 → 459 MiB). The kit's KV figure for this launch (440.4 decimal MB ≈ 420
MiB) models neither. Today the learned `__overhead__` absorbs it. → a
follow-up tracker item (slot-aware KV), not this plan.

### 10.4 Step 0d — the layer A/B (llama-server, app flags, A-B-A-B, 1 warm-up + 5 × 160 tokens per arm, engine `timings`)

| pair | `-ngl n` (block 0 on CPU) | `-ngl n+1` (full) | gain | VRAM delta |
|---|---|---|---|---|
| **26B, no draft (THE DECISION PAIR)** | 28.758 ms/tok · **34.77 tok/s** · spread 4.7 % | 27.146 ms/tok · **36.84 tok/s** · spread 1.1 % | **+5.94 %** | +49…58 MiB |
| 26B + MTP draft | 27.812 · 35.96 tok/s · spread 5.3 % · acceptance 0.58 | 24.867 · 40.21 tok/s · spread 14.3 % · acceptance 0.62 | +11.84 % (noisy) | +38…58 MiB |
| Granite 1B-A400M, ncmoe 0, ctx 2048 | 2.900 · 344.8 tok/s · 1.4 % | 2.839 · 352.3 tok/s · 4.0 % | +2.16 % | +24 MiB |

Round-by-round the 26B pair never overlaps (round 1: 29.59 → 27.22 ms median,
round 2: 28.70 → 27.10). **R1 verdict: ADOPT Step 1** — the decision pair is
+5.94 %, three times the 2 % bar. (Granite's +2.16 % is inside its arm spread —
reported, not decisive.) Side fact: the 26B's real un-sped speed at the app's
launch is ~35 tok/s — the catalog chip's "~7.9 tok/s" estimate is the
speed-truth plan's subject, not this one.

### 10.5 Step 0 — DONE. Proceeding to Step 1 (adopted) then Step 2.

### 10.6 Step 1 — BUILT (R1: adopted on +5.94 %)
- `process.py`: `engine_ngl_flag(n_gpu, block_count)` beside `ModelIniEntry`;
  `ModelIniEntry` gains `block_count: int = 0` (trailing, defaulted — the
  positional test constructions are unaffected; 0 = render unchanged);
  `emit_models_ini` and `compose_flags(…, block_count=0)` render through it —
  the ONE render point for both the router `.ini` and the single-model argv;
  `start_runner` passes `fit.block_count`.
- `lifecycle.py`: all four `ModelIniEntry(` constructions pass
  `block_count=fit.block_count` (the load entry, the ini rebuild, the
  explicit-placement retry, the OOM-shed rebuild). The kit's own value — tunes,
  fingerprints (`_fit_config_switches`), the shed arithmetic
  (`ngl = fit.n_gpu_layers`) — never sees the +1.
- Tests: `test_lifecycle.py::test_tuned_model_ini_renders_explicit_knobs`
  `"n-gpu-layers = 24"` → **25** (the one predicted pin; the partial pins
  `= 12`, `= 20`, `= 0` held); NEW `test_runner.py`
  `test_engine_ngl_flag_renders_full_offload_as_n_plus_one` +
  `test_ini_and_argv_render_the_same_full_offload_flag`. lifecycle + runner:
  **255 passed**.

### 10.7 Step 2 — BUILT (exact bytes + one unit, one change)
**§6.1 reader (`runner/gguf.py`):** `_parse_header` reads the tensor infos after
the KV section; `_tensor_sizes` = OFFSET DELTA (last tensor runs to the file's
end; alignment from `general.alignment`, default 32); `_classify` sorts by
`EXPS_REGEX` (the b10437 `LLM_FFN_EXPS_REGEX`), the output side (+ a tied head's
duplicated `token_embd`), the input side. New `GgufMeta` fields
`tensor_bytes_known`, `layer_nonexp_bytes`, `layer_exps_bytes`, `output_bytes`,
`input_bytes` (+ `exps_bytes` / `layers_nonexp_bytes` properties).
`read_gguf_metadata_from_stream(f, *, file_size=None, strict_tensors=True)`;
`read_gguf_metadata(path)` merges every split shard (`split_siblings`) and
returns UNKNOWN (never a partial table) when a shard is missing;
`gguf_total_bytes(path)` sums the shards (oobabooga's own rule). The fallback
formula reads the Mixtral-style convention (Granite → 0.9412, was 0).
**Two deviations, both forced by what the code did:** (1) a header with ZERO
tensors first came back "known, 0 bytes" — `_classify` now leaves it unknown
(the exact path would otherwise book no weights); (2) a split model with a
missing shard first kept shard 1's table as "known" — now unknown, per §6.1.
**Remote (`gguf_remote.py`):** passes the shard's real size; a still-truncated
retry keeps the KV facts (`strict_tensors=False`); `_merge_split_tensor_tables`
range-reads every shard's header (4 MB, one 4× retry). Live check: the 26B read
from HF's 24 MB prefix = the local file's bytes exactly.
**Cross-check (the plan's must):** the kit reader vs the independent PyPI
reader on 26B / 12B / Granite — every total within alignment padding
(≤ 1,344 B, < 0.0001 %).

**§6.2 facts:** `exps_bytes`, `layers_nonexp_bytes`, `output_bytes` —
`db.py` columns + `_ADDED_COLUMNS`; `identity.physics_facts_from_meta`;
`stores._PHYSICS_FACT_KEYS` (every writer iterates it — inspect, download
identify, the form save); `seed._SEED_FACT_KEYS` + `_SEED_BYTES_KEYS` +
`_catalog_row`; `_fill_physics_facts` gains its OWN gate for the three (the
nine-fact gate returns early on every existing row); `refresh-seed-facts.py`
fields + int normaliser. **Seeds refreshed from HF** (`--write`): JW 11 rows,
JV 3 — incl. `glm-4.5-air` (split: 62.3 GB experts, 4.57 GB non-expert — the
merge path, live). Every `est_vram_mb` drops ~4 % (MiB). **Pre-existing
script bug fixed:** the report compared floats at full precision while `_fmt`
writes `round(v, 10)`, so written rows could never report clean — it now
compares at the writer's precision; the re-report is clean (0 differences).

**§6.3 physics (`runner/fit.py` + `process.compute_fit`):** `MIB`,
`PHYSICS_VERSION = "p2"`, `engine_gpu_blocks`, `placed_weight_mib`;
`moe_joint_split(…, need_fn=None)`; `compute_fit`'s `_need_mib(g, nc)` = exact
placement for the EMITTED flag (`engine_ngl_flag`) + KV prorated by the
blocks actually on the GPU + overhead, else the share path in MiB — used by
the joint solve, the full-offload check and the booking. Facts path
(`identity.computed_row_numbers`): exact floors when `layers_nonexp_bytes > 0`.
Speed path (`api._speed_facts`): exact per-token bytes, DECIMAL MB — the 26B
reads 1,387 + 803 MB, the split pass C validated.
**§6.4 units:** the VRAM path is MiB end to end — `process.py` (5 sites + the
draft), `identity.py` (floors, RAM floor, the regression's size),
`lifecycle.py` (the RAM claim), `fit.weights_mb`, KV
(`kv_exact_mb` / `kv_mb_from_facts` gain `unit=`, default MiB; the three SPEED
callers pass `unit=1e6`: `api.py` `_speed`, `bandwidth.py` ×2),
`GgufMeta.kv_mb_at_ctx`. **Web-verified before touching the regression:**
text-generation-webui `modules/models_settings.py:337-352`
`get_model_size_mb` returns `total_size / (1024 ** 2)` and sums multipart
files — the regression's `size_in_mb` IS MiB. Split models at load: the four
`compute_fit(meta, gguf.stat().st_size, …)` sites + the draft size use
`gguf_total_bytes`.
**§6.5 overhead:** writer and reader both stamp/match `"<disk build>
<PHYSICS_VERSION>"` (R2) — old `physics-overhead b9993` rows stop matching →
the seed applies until the next measured load re-learns.

**§6.6 tests** — first full run after the code: 9 failures, every one traced:
- 1 REAL BUG of mine: `identity.est_vram_mb_from_meta` — a trailing comment
  swallowed `n_layers=` / `n_kv_heads=` on the same line → TypeError. Fixed.
- 8 intended unit re-pins (each now `/ (1024 * 1024)` with a dated note):
  `test_fit.py` KV ×3 (+ an explicit `unit=1e6` speed assertion) ·
  `test_gguf.py` iSWA KV · `test_identity.py` RAM floor + the KV parity test
  (now compares the REAL stored-facts path, not an inline formula copy) ·
  `test_uncurated_path.py` RAM floor · `test_runner.py` booking 6553 → 6319
  (= (6553 − 1517) ÷ 1.048576 + 1517 — same split).
- NEW: `tests/fixtures/vram_truth_tensor_bytes.json` (the three real files'
  per-block bytes + the ENGINE's model-MiB) · `test_fit.py`
  `engine_gpu_blocks` truth table + `placed_weight_mib` vs the engine on all
  9 fixture configs (< 1 MiB) · `test_fit_acceptance.py` the 26B row with EXACT
  bytes → **ngl 30 / ncmoe 22, inside the measured [21, 23] band — R3 held,
  nothing widened** · NEW `tests/test_gguf_tensor_table.py` (11: sizing, tied
  / untied head, the regex, a leading dense block, split merge, missing shard,
  truncation both ways, no file size, zero tensors, the Mixtral-style
  fallback) · the `__overhead__` label pins the physics-version suffix.

### 10.8 Step 3 — gates · docs · the on-box check (all 2026-09-19)
**Gates (final tree):** kit `ruff check .` clean · kit pytest **942 passed /
10 skipped / 0 failed** · `verify-model-pick.mjs` 59/59 · `check-family` **no
violations** · JW `test:fast`: vitest 579/579, build, JW server **128 passed** ·
JV `test:unit` 67/67 · JV `build:vite` · JV server **741 passed** · JV smoke
with `--data-dir src-tauri/target/debug/data` (apps closed) — all views, zero
JS errors.
**Docs:** kit `docs/dev/serving-design.md` (a fit-section bullet: tensor-table
bytes, MiB, the engine oracle, the ngl render rule, the overhead stamp; the
next bullet's "same plan" → "speed-truth plan", which my insertion had made
ambiguous) · `docs/llama-cpp-watch.md` (a pin-bump checklist entry: the
placement lines, the tied-head idiom, `LLM_FFN_EXPS_REGEX`, the `-fitp`
oracle + re-running Step 0b) · `gguf.py` module docstring · JV
`docs/whats-new.md` (v0.1.0: full offload really full, +6 % on the 26B; exact
memory figures; Granite/Mixtral no longer read as dense). JW / JV user-doc
explanations ("the model file's own physics", "how many bytes each generated
word touches") stay true — unchanged. **OPEN — JW `docs/whats-new.md` has only
RELEASED version sections (v1.3.0 — 2026-07 is the top); no open section to
add to, and inventing a version heading is the user's call.**
**On-box (the gate server's warm-load on the real data dir, 16:44):** router
log child argv `--n-cpu-moe 21 --n-gpu-layers 31` (Step 1 live in the real
path) · new load row **6,789 MiB** = Step 0c's replica exactly · new
`__overhead__` row labelled **`physics-overhead b10437 p2`** (R2 + the physics
version; learned 1,055 MiB) · the load fingerprint still records
`n_gpu_layers '30'` (the kit's value — as designed) · catalog: 26B min-VRAM
3,119 MiB, min-RAM 17,685 MiB (MiB now); the 12B stays "tight"
(8,291 vs the 8,192 card). **Side effect, recorded not verified:** E4B's
predicted speed 25.9 → 37.6 tok/s — the exact per-token bytes leave out its
large input-side tables (looked up, not streamed), which the old whole-file
count charged every token; no measured E4B run exists to confirm it.

### 10.9 DONE — all of Steps 0-3. Nothing committed (the user's word).
Follow-up recorded in the kit tracker (out of scope here): slot-aware KV —
llama-server's default 4 parallel slots scale the windowed KV (26B: 799 MiB
live vs the kit's ~420).
