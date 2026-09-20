# Engine update safety + the stable channel — the 2026-09-19 llama.cpp review, as a build plan

**Status:** PLAN WRITTEN 2026-09-19 — **not started**. Executor: Opus. Each slice needs the
user's **go**, naming the slice. Nothing here has been coded.
**Decision on record:** user, 2026-09-19 — *"write the plan for opus, your rec on all make sure
plan is detailed enough so opus does not have to think to much"*. Every ruling in §2 is the
reviewer's recommendation, taken as decided by that sentence — **with one exception: Slice 0 /
R12.** The structured-output defect was found *while this plan was being written*, after that
approval, so the approval cannot cover it. It is **PROPOSED** and needs the user's own word
before it is built. Slices 1–4 do not depend on it.
**Source review:** `docs/llama-cpp-watch.md` → Review log row 2026-09-19 (window `b9993` →
`b11056`, 1,064 commits read + the four stable releases' notes).
**Resume surface:** THIS file. §3 is the evidence (never re-derive it), §4 the slices, §9 the
execution record the executor fills in as they go.

---

## 0. Rules for whoever executes this

These are the user's standing rules. They outrank anything below that seems to conflict.

- Nothing runs until the user says **go**. A go covers only the slice it named.
- A question gets an answer, then stop. A message arriving mid-work gets answered first, alone.
- A gap in this plan (a word, a label, a behaviour it does not name) → **STOP and ask**. Never
  fill a gap with your own choice. §8 lists the gaps already known.
- Re-read the slice's text **before every edit** (`check-plan-before-every-edit`).
- Run and test against the user's **REAL** app and **REAL** data dir — never a scratch config.
  JV's data dir is `src-tauri/target/debug/data`; a bare headless run opens a different,
  empty database (JV `CLAUDE.md`, "The renderer gate").
- **Never push, never destroy, unasked.** Commit only when the user says so.
- `git commit -F - -- <paths>` with every path named. Never `git add -A`, never a bare commit
  (it takes the whole index — it once published another session's staged deletions).
- Kill test servers **by port**, never by image name (`netstat -ano | grep :<port>` →
  `taskkill //F //PID <pid> //T`). The user's real servers must survive.
- No DB migrations — pre-release, the user resets. Seeds only.
- A user-visible change updates the user docs **in the same change**.
- Kit changes are additive by default, and gate **all three** consumer apps.
- Reports: terse and factual — what changed, what the verification showed, what is open.
  Say plainly when something failed, was skipped, or is unverified.

---

## 1. What this is

Five small changes to the kit (`just-llm-runner`). Together they make the **local llama.cpp
engine safe to update again**, and they fix one bug the review found on the way.

What a user will see when it is all in:

1. The **"Update to bNNNN"** button comes back. It has silently never appeared since about
   2026-08-21 (§3.1–3.2). It now follows llama.cpp's **stable** releases — the channel
   upstream itself recommends "for downstream distribution" — instead of whatever commit
   landed last.
2. An engine update can **no longer leave the app unable to load models**. Before the new
   engine replaces the old one, the app asks it whether it accepts the launch flags the app
   uses. If not, the old engine stays and the update reports why (§3.3, §3.5).
3. Updates work for **AMD** users again (upstream renamed their download files, §3.4), and an
   update that cannot be used on this machine's graphics type says so **before** touching
   anything.
4. A **fresh install** gets a current engine (`b10964` = llama.cpp 0.4.1) instead of a
   two-month-old one (`b9993`).
5. A feature that carries a **JSON schema** finally has that schema enforced on the local
   engine. Today it is silently ignored (§3.7). On the user's real databases this affects
   exactly one seeded feature (JustWrite `entitySweep`) plus any schema a user adds.

Nothing else changes. No new settings, no new screens. One tooltip gains a few words.

### The order is the design

```
Slice 0  structured output     independent — can land any time
Slice 1  launch flags by build ┐
Slice 2  download names        ├─ MUST all land before Slice 3
Slice 3  update check          ┘  ← re-opens the door to updating
Slice 4  move the pin          ← needs 1 (b10964 has no --mlock/--no-mmap) and the box test
```

**Why Slice 3 is last of the three.** Today the dead update check is the only thing stopping
a user from updating into an engine that rejects our flags. The installer's existing safety
check runs `--version` only, which passes on any build; the old engine is then deleted
(§3.5). Repair the check first and we hand users a button that breaks their install.

---

## 2. Rulings (all decided: "your rec on all")

| # | Question | Ruling |
|---|---|---|
| R1 | Which upstream channel does the update check follow? | **Stable** (`releases/latest` → its `nightly-tag.txt` → `bNNNN`). Never the newest prerelease build. Upstream's words: `vX.Y.Z` = "stable … recommended for downstream distribution"; `b[NUM]` = "bleeding edge". |
| R2 | How do the two loading switches reach a new engine? | The kit's switches stay **`mlock`** and **`no_mmap`** (DB, seeds, UI, tunes, measurement fingerprints — all unchanged). Only the **emitted flag** changes, by engine build — the `engine_ngl_flag` pattern from the vram-truth plan. |
| R3 | From which build do we emit `--load-mode`? | **`b10145`**. Not `b10105` (first build that has the flag): at `b10105` the value list has no `mmap+mlock` and `mlock` meant something else (§3.3). |
| R4 | What does each switch combination become? | §3.3's table. `mlock` alone → `mmap+mlock` (its pre-refactor meaning, the one the 2026-07-22 A/B proved locks on Windows). |
| R5 | What stops a future flag removal from bricking installs? | A **flag-acceptance probe at install time**: run the staged exe with the flags we would emit, then `--version`. Non-zero exit → discard the staged build, keep the working engine. Observed to work on the real engine (§3.3). |
| R6 | Where are download filenames resolved? | **Server-side, from the target release's own asset list**, by pattern per `(platform, gpu)`. Tag substitution stays only as the offline fallback and for rows that did not resolve. |
| R7 | What if this machine's graphics type has no download at the target build? | The update **refuses before writing anything**, with a plain message. |
| R8 | What if the install fails after the pin was written? | The UI **restores the previous pin and URLs** when the install reaches a terminal state and the on-disk build is not the target. |
| R9 | Does the runner ever write the pin? | **No** — the existing invariant stands (`update_check` docstring: "NOTHING does except the user"). The new endpoint only *returns* resolved names; the UI still does the PUT. |
| R10 | New pin | **`b10964`** (= llama.cpp `v0.4.1`). Moves only if §5's box test passes. |
| R11 | Speed gate for the pin move | Flagship tok/s on `b10964` must be **≥ 97 %** of `b10437` (median of 3 measures each). Worse → the pin stays, Slices 0–3 still ship, report the numbers. |
| R12 | Structured output — **PROPOSED, not yet approved** (found after the approval) | **Stop flattening.** Send llama-server the OpenAI-standard nested form, which it honours at every build checked. Delete the flattening, per *removed means removed*. |
| R13 | The Engine-binaries panel (hand-typed pin) | **Not in this plan.** It keeps tag substitution. Recorded in §7 with the facts. |
| R14 | JustWrite `docs/whats-new.md` | It has only released version sections (top = `v1.3.0 — 2026-07`). **Do not invent a heading.** If the user has not ruled by then, leave it untouched and say so in the report. |

---

## 3. Verified facts — the evidence. Do not re-derive.

Everything here was checked on 2026-09-19 against upstream source at the named tag
(`raw.githubusercontent.com/ggml-org/llama.cpp/<tag>/…`), the GitHub release API, or the
user's real machine. "Observed" means it was run; "source" means it was read.

### 3.1 Upstream changed its release scheme on 2026-08-21

- `b10549` (2026-08-21 09:23Z) is the last `bNNNN` build published as a **normal release**.
  Every later `bNNNN` is flagged **`prerelease: true`**.
- A semver line began the same day: `v0.2.0` (2026-08-21) · `v0.3.0` (08-25) · `v0.4.0`
  (09-04) · `v0.4.1` (09-14). Cadence ≈ every 10 days.
- Each stable release has exactly **one asset**, `nightly-tag.txt` (7 bytes): the `bNNNN` tag
  whose binaries it points at. Read on 2026-09-19:

  | stable | `nightly-tag.txt` |
  |---|---|
  | `v0.2.0` | `b10566` |
  | `v0.3.0` | `b10621` |
  | `v0.4.0` | `b10809` |
  | `v0.4.1` | `b10964` |

  The release body also carries it: `**Nightly build:** [b10964](https://github.com/ggml-org/llama.cpp/releases/tag/b10964)`.
- The binaries still live on the `bNNNN` release (26–33 assets each). The stable release has
  none.
- GitHub's `releases/latest` skips prereleases, so it now answers the `v…` tag.
- Upstream's own statement (v0.2.0 notes): *"tag `vX.Y.Z` - stable, slower release cadence,
  recommended for downstream distribution and casual users · tag `b[NUM]` - bleeding edge"*.
- Latest build at review time: `b11056` (2026-09-19). Master = 11,057 commits; build number =
  commit count.

### 3.2 Our update check is dead — observed with the app's own code

```
the app's own fetch returns : 'v0.4.1'      ← lifecycle._fetch_latest_llamacpp_tag()
build_num(latest)           : 41            ← binary.build_num strips to digits "041"
build_num(current)          : 10437
updateAvailable             : False
```

- `lifecycle.update_check` returns `updateAvailable: build_num(latest) > build_num(current)`.
  `41 > 10437` is false. No error is raised, so nothing looks wrong.
- `LuEngineUpdateButton` is gated on `updateInfo?.updateAvailable` (`LuRunnerEngine.vue`,
  `AiModelsArea.vue`), so the button never renders.
- Latent second hazard in the same parser: a future `v1.10.500` parses to `110500`, which
  **is** greater than any build — it would offer a bogus update whose download 404s.
- The user's `b10437` was published 2026-08-15 — before the scheme change. Their update worked
  because the check still worked then.

### 3.3 The loading flags: three eras, and what each mode really does

**Eras** (source: `common/arg.cpp` at each tag):

| build | `--mlock` / `--mmap` / `--no-mmap` / `--direct-io` | `--load-mode` values |
|---|---|---|
| `b9993` (the pin) | present | **flag does not exist** |
| `b10105` (#20834) | present | `none · mmap · mlock · dio` — **no `mmap+mlock`** |
| `b10145` (#26135) | present, print `DEPRECATED` | `none · mmap · mlock · mmap+mlock · dio` |
| ~`b10369` (#26081) | same | + `auto`, which becomes the default |
| `b10437` (installed) | same | same six |
| **`b10875`** (#28334, 2026-09-09) | **deleted** | same six |
| `b10964` (stable), `b11056` | absent | same six |

- PR #28334 is *titled* "officially deprecate" but the code **removes** the args: grep of
  `arg.cpp` at `b10964` and `b11056` finds only `--load-mode`.
- An unknown flag is fatal: `arg.cpp` `throw std::invalid_argument("error: invalid argument: %s")`.
- An unknown key in our `models.ini` is fatal too: `common/preset.cpp` throws
  `"option '%s' not recognized in preset '%s'"` unless `ignore_unknown_keys` (default `false`;
  only the machine-wide config loader sets it). `mlock` is in our **base** bundle for every
  model, so one stale key stops every load. *Not verified:* whether the whole router exits or
  only that section fails — either way the model cannot load.
- The user's own router log, today, on `b10437`:
  `W DEPRECATED: --mmap and --no-mmap are deprecated. use --load-mode mmap instead`.

**What each mode does** (source, identical at `b10145`, `b10437`, `b10964`, `b11056`;
`b10964`+ also treat `auto` as mmap-on):

```cpp
// src/llama-model-loader.cpp
this->use_mmap = load_mode == LLAMA_LOAD_MODE_MMAP || load_mode == LLAMA_LOAD_MODE_MMAP_MLOCK || load_mode == LLAMA_LOAD_MODE_AUTO;
// src/llama-model.cpp
const bool use_mlock = params.load_mode == LLAMA_LOAD_MODE_MLOCK || params.load_mode == LLAMA_LOAD_MODE_MMAP_MLOCK;
```

| mode | mmap | lock |
|---|---|---|
| `auto` | on, unless a device lacks mmap support (iGPU) | off |
| `none` | off | off |
| `mmap` | on | off |
| `mlock` | **off** | on |
| `mmap+mlock` | on | on |
| `dio` | off (direct I/O) | off |

**The legacy flags silently changed meaning at `b10105`+.** They no longer combine — each one
*assigns* the single mode (source, `b10437` `arg.cpp`):

```cpp
{"--mlock"}              → params.load_mode = LLAMA_LOAD_MODE_MLOCK;          // lock WITHOUT mmap
{"--mmap"},{"--no-mmap"} → params.load_mode = value ? LLAMA_LOAD_MODE_MMAP : LLAMA_LOAD_MODE_NONE;
```

and the engine's own warning says: *"`--load-mode` and `--mlock`/`--mmap`/`--direct-io` should
not be combined; **only the last flag on the command line will take effect**"*.

**MEASURED on the installed `b10437`, 2026-09-19** (execution step 1.0b — the engine prints
its EFFECTIVE mode at `-lv 4`: `load_tensors: … (load_mode = X)`; 821 MB calib model, `-ngl 0`):

| flags passed | effective `load_mode` |
|---|---|
| *(none)* | `mmap` |
| `--mlock` | **`mlock`** — mmap OFF, as the source says |
| `--no-mmap` | `none` |
| **`--mlock --no-mmap`** (the order **we** emit) | **`none`** — the lock is silently LOST |
| `--no-mmap --mlock` (swapped) | `mlock` — last flag wins, confirmed |
| `--load-mode mlock` | `mlock` |
| `--load-mode mmap+mlock` | `mmap+mlock` |
| `--load-mode none` | `none` |
| `--load-mode auto` | `mmap` (resolved, this box) |

Inference replaced by observation: every claim above this table is confirmed. **No case
produced a `VirtualLock` or lock-failure line** — see the gap-2 resolution below.

**GAP 2 RESOLVED (2026-09-19).** The plan predicted
`test_realrouter_smoke::test_mlock_parity_router_vs_standalone` would FAIL at `b10437`. It
**passed** — and that is consistent, not contradictory: the test asserts only
`not any("VirtualLock" in line)`, i.e. the ABSENCE of a failure warning; it never proves a
lock happened. Standalone `--mlock` resolves to mode `mlock` (mmap off + lock on) and locks
that model without complaint on this box. Its sibling
`test_mlock_no_mmap_pair_is_stripped_on_windows` passes for a different reason again — the
strip rule removes `mlock`, leaving `--no-mmap` → `none`, so no lock is ever attempted. The
mapping in this plan stands, unchanged.

Consequences on the installed `b10437`, **today**:

- We emit `mlock` then `no-mmap` (`process.overrides_to_pairs` order). Last wins → `none`. The
  lock is silently lost on **every** platform for every MoE model.
- `--mlock` alone (every dense model) now means `mlock` mode = lock **without** mmap. Before
  the refactor it meant mmap on + lock. The kit's own 2026-07-22 A/B
  (`lifecycle._strip_inert_mlock` docstring) proved that on Windows *"mlock alone locks, the
  pair fails"* (`VirtualLock 998` on the no-mmap heap buffer). So on Windows the seeded
  "mlock on every model" is now inert for dense models too.
- **Predicted, not run:** `tests/test_realrouter_smoke.py::test_mlock_parity_router_vs_standalone`
  asserts `standalone --mlock` locks ("box regression" otherwise). On `b10437` that should now
  fail. Step 1.0 runs it to find out.

**The mapping (R4).** For engine builds ≥ `b10145`:

| `mlock` | `no_mmap` | emit | why |
|---|---|---|---|
| set | — | `load-mode = mmap+mlock` | the pre-refactor meaning of `--mlock` alone; the combination proven to lock on Windows |
| — | set | `load-mode = none` | exactly what `--no-mmap` sets at `b10437` |
| set | set | `load-mode = mlock` | no mmap + lock. Non-Windows only — on Windows `_strip_inert_mlock` has already cleared `mlock`, so this row becomes row 2 |
| — | — | *(nothing)* | engine default (`mmap` before #26081, `auto` after) |

We never emit `auto`, `mmap` or `dio`.

**The install-time probe — observed on the real `b10437` exe** (no model, no GPU; the same
kind of call `_verify_exe_launches` already makes):

```
1. --version alone                           rc=0   version: 0.1.0-dev (build 10437, commit 16d222fc5)
2. valid new flag, then --version            rc=0
3. valid OLD flags, then --version           rc=0   W DEPRECATED: --mlock is deprecated…
4. unknown flag, then --version              rc=1   error: invalid argument: --no-such-flag-xyz
5. bad VALUE, then --version                 rc=1   error while handling argument "--load-mode": invalid value
6. --version FIRST, unknown flag after       rc=0   ← the flag was never looked at
7. our full flag set, then --version         rc=0
```

Args are parsed **in order** and `--version` exits on sight. So: **flags first, `--version`
last** is a real acceptance test; `--version` first tests nothing. (Probe 7's flags:
`-ngl 31 --n-cpu-moe 21 --ctx-size 32768 --cache-type-k q8_0 --cache-type-v q8_0
--flash-attn on --batch-size 512 --ubatch-size 512 --load-mode none --spec-type draft-mtp
--spec-draft-n-max 2`.)

**Every other flag we emit survives.** Present at `b10437`, `b10964` and `b11056`:
`--n-gpu-layers --n-cpu-moe --ctx-size --cache-type-k --cache-type-v --flash-attn --batch-size
--ubatch-size --threads --threads-batch --parallel --cache-reuse --model-draft --no-kv-offload
--no-cont-batching --context-shift --no-context-shift --spec-type --spec-draft-n-max
--spec-ngram-mod-n-max --models-dir --models-preset --models-max --sleep-idle-seconds --host
--port --embedding --pooling`. The eleven `--spec-type` names are identical at `b10437` and
`b10964`. The sampler enum and default chain are identical at `b9993`, `b10437`, `b10964`.
`runner/calibrate.py` passes only `-m --host --port -c -ngl --n-cpu-moe` — all survive.

### 3.4 Upstream renamed download files

Our config builds names by substituting the tag into fixed filenames
(`runner/config.py` `DEFAULT_BINARIES`; UI `engineUrl.js::applyBuildToUrl`).

| our row | `b9993` | `b10437` | `b10964` | `b11056` |
|---|---|---|---|---|
| windows / cuda12 | `win-cuda-12.4` ✓ | ✓ | ✓ | ✓ |
| windows / cuda13 | `win-cuda-13.3` ✓ | ✓ | ✓ | **`win-cuda-13.4`** (+ `cudart…13.4`) |
| windows / rocm | `win-hip-radeon` ✓ | **`win-rocm-7.14`** | **`win-rocm-10.0`** | `win-rocm-10.0` |
| windows / vulkan | ✓ | ✓ | ✓ | ✓ |
| macos / metal | ✓ | ✓ | ✓ | ✓ |
| linux / rocm | `ubuntu-rocm-7.2` ✓ | **no asset at all** | **`ubuntu-rocm-10.0`** | `ubuntu-rocm-10.0` |
| linux / vulkan | ✓ | ✓ | ✓ | ✓ |
| linux / cuda | docker-only | — | — | **new:** `ubuntu-cuda-12.8-x64` (+ a build-tagged `cudart-llama-<b>-bin-ubuntu-cuda-12.8-x64.tar.gz`) |

- The Windows CUDA runtime zips stay unversioned by build
  (`cudart-llama-bin-win-cuda-12.4-x64.zip`), but their CUDA version must **match the asset's**
  (13.3 ↔ 13.3, 13.4 ↔ 13.4).
- Linux ROCm has no asset for roughly `b10398`–`b10581` (CI job disabled #26969, restored
  #27399).
- `useEngine.js::updateToLatest` re-points every stored URL with `applyBuildToUrl(url, latest)`
  — a plain tag substitution — then PUTs `pinnedBuild` + `binaries`, then POSTs the install. A
  renamed asset becomes a 404. The install is staged, so that is a **safe** failure ("Update
  failed") — but the pin and URLs have already been written, and nothing restores them.
- The user is on windows/cuda12, the one row that never moved.
- *Not verified:* whether `ubuntu-rocm-10.0` needs a system ROCm 10 (its size doubled,
  117 → 217 MB, which suggests bundled libraries).

**The four asset lists** (names only) — the unit-test fixture for Slice 2. Create
`tests/fixtures/llamacpp_release_assets.json` with exactly this content:

```json
{
  "b9993": [
    "cudart-llama-bin-win-cuda-12.4-x64.zip", "cudart-llama-bin-win-cuda-13.3-x64.zip",
    "llama-b9993-bin-android-arm64.tar.gz", "llama-b9993-bin-macos-arm64.tar.gz",
    "llama-b9993-bin-macos-x64.tar.gz", "llama-b9993-bin-ubuntu-arm64.tar.gz",
    "llama-b9993-bin-ubuntu-openvino-2026.2.1-x64.tar.gz", "llama-b9993-bin-ubuntu-rocm-7.2-x64.tar.gz",
    "llama-b9993-bin-ubuntu-s390x.tar.gz", "llama-b9993-bin-ubuntu-sycl-fp16-x64.tar.gz",
    "llama-b9993-bin-ubuntu-sycl-fp32-x64.tar.gz", "llama-b9993-bin-ubuntu-vulkan-arm64.tar.gz",
    "llama-b9993-bin-ubuntu-vulkan-x64.tar.gz", "llama-b9993-bin-ubuntu-x64.tar.gz",
    "llama-b9993-bin-win-cpu-arm64.zip", "llama-b9993-bin-win-cpu-x64.zip",
    "llama-b9993-bin-win-cuda-12.4-x64.zip", "llama-b9993-bin-win-cuda-13.3-x64.zip",
    "llama-b9993-bin-win-hip-radeon-x64.zip", "llama-b9993-bin-win-opencl-adreno-arm64.zip",
    "llama-b9993-bin-win-openvino-2026.2.1-x64.zip", "llama-b9993-bin-win-sycl-x64.zip",
    "llama-b9993-bin-win-vulkan-x64.zip", "llama-b9993-ui.tar.gz", "llama-b9993-xcframework.zip"
  ],
  "b10437": [
    "cudart-llama-bin-win-cuda-12.4-x64.zip", "cudart-llama-bin-win-cuda-13.3-x64.zip",
    "cudart-llama-bin-win-cuda-13.4-arm64.zip", "llama-b10437-bin-android-arm64.tar.gz",
    "llama-b10437-bin-macos-arm64.tar.gz", "llama-b10437-bin-macos-x64.tar.gz",
    "llama-b10437-bin-ubuntu-arm64.tar.gz", "llama-b10437-bin-ubuntu-openvino-2026.2.1-x64.tar.gz",
    "llama-b10437-bin-ubuntu-s390x.tar.gz", "llama-b10437-bin-ubuntu-sycl-fp16-x64.tar.gz",
    "llama-b10437-bin-ubuntu-sycl-fp32-x64.tar.gz", "llama-b10437-bin-ubuntu-vulkan-arm64.tar.gz",
    "llama-b10437-bin-ubuntu-vulkan-x64.tar.gz", "llama-b10437-bin-ubuntu-x64.tar.gz",
    "llama-b10437-bin-win-cpu-arm64.zip", "llama-b10437-bin-win-cpu-x64.zip",
    "llama-b10437-bin-win-cuda-12.4-x64.zip", "llama-b10437-bin-win-cuda-13.3-x64.zip",
    "llama-b10437-bin-win-cuda-13.4-arm64.zip", "llama-b10437-bin-win-opencl-adreno-arm64.zip",
    "llama-b10437-bin-win-openvino-2026.2.1-x64.zip", "llama-b10437-bin-win-rocm-7.14-x64.zip",
    "llama-b10437-bin-win-sycl-x64.zip", "llama-b10437-bin-win-vulkan-x64.zip",
    "llama-b10437-ui.tar.gz", "llama-b10437-xcframework.zip"
  ],
  "b10964": [
    "cudart-llama-bin-win-cuda-12.4-x64.zip", "cudart-llama-bin-win-cuda-13.3-x64.zip",
    "cudart-llama-bin-win-cuda-13.4-arm64.zip", "llama-b10964-bin-android-arm64.tar.gz",
    "llama-b10964-bin-macos-arm64.tar.gz", "llama-b10964-bin-macos-x64.tar.gz",
    "llama-b10964-bin-ubuntu-arm64.tar.gz", "llama-b10964-bin-ubuntu-openvino-2026.3.1-x64.tar.gz",
    "llama-b10964-bin-ubuntu-rocm-10.0-x64.tar.gz", "llama-b10964-bin-ubuntu-s390x.tar.gz",
    "llama-b10964-bin-ubuntu-sycl-fp16-x64.tar.gz", "llama-b10964-bin-ubuntu-sycl-fp32-x64.tar.gz",
    "llama-b10964-bin-ubuntu-vulkan-arm64.tar.gz", "llama-b10964-bin-ubuntu-vulkan-x64.tar.gz",
    "llama-b10964-bin-ubuntu-x64.tar.gz", "llama-b10964-bin-win-cpu-arm64.zip",
    "llama-b10964-bin-win-cpu-x64.zip", "llama-b10964-bin-win-cuda-12.4-x64.zip",
    "llama-b10964-bin-win-cuda-13.3-x64.zip", "llama-b10964-bin-win-cuda-13.4-arm64.zip",
    "llama-b10964-bin-win-opencl-adreno-arm64.zip", "llama-b10964-bin-win-openvino-2026.3.1-x64.zip",
    "llama-b10964-bin-win-rocm-10.0-x64.zip", "llama-b10964-bin-win-sycl-x64.zip",
    "llama-b10964-bin-win-vulkan-x64.zip", "llama-b10964-ui.tar.gz", "llama-b10964-xcframework.zip"
  ],
  "b11056": [
    "cudart-llama-b11056-bin-ubuntu-cuda-12.8-x64.tar.gz", "cudart-llama-b11056-bin-ubuntu-cuda-13.3-arm64.tar.gz",
    "cudart-llama-b11056-bin-ubuntu-cuda-13.3-x64.tar.gz", "cudart-llama-bin-win-cuda-12.4-x64.zip",
    "cudart-llama-bin-win-cuda-13.4-arm64.zip", "cudart-llama-bin-win-cuda-13.4-x64.zip",
    "llama-b11056-bin-android-arm64.tar.gz", "llama-b11056-bin-macos-arm64.tar.gz",
    "llama-b11056-bin-macos-x64.tar.gz", "llama-b11056-bin-ubuntu-arm64.tar.gz",
    "llama-b11056-bin-ubuntu-cuda-12.8-x64.tar.gz", "llama-b11056-bin-ubuntu-cuda-13.3-arm64.tar.gz",
    "llama-b11056-bin-ubuntu-cuda-13.3-x64.tar.gz", "llama-b11056-bin-ubuntu-openvino-2026.4-x64.tar.gz",
    "llama-b11056-bin-ubuntu-rocm-10.0-x64.tar.gz", "llama-b11056-bin-ubuntu-s390x.tar.gz",
    "llama-b11056-bin-ubuntu-sycl-fp16-x64.tar.gz", "llama-b11056-bin-ubuntu-sycl-fp32-x64.tar.gz",
    "llama-b11056-bin-ubuntu-vulkan-arm64.tar.gz", "llama-b11056-bin-ubuntu-vulkan-x64.tar.gz",
    "llama-b11056-bin-ubuntu-x64.tar.gz", "llama-b11056-bin-win-cpu-arm64.zip",
    "llama-b11056-bin-win-cpu-x64.zip", "llama-b11056-bin-win-cuda-12.4-x64.zip",
    "llama-b11056-bin-win-cuda-13.4-arm64.zip", "llama-b11056-bin-win-cuda-13.4-x64.zip",
    "llama-b11056-bin-win-opencl-adreno-arm64.zip", "llama-b11056-bin-win-openvino-2026.4-x64.zip",
    "llama-b11056-bin-win-rocm-10.0-x64.zip", "llama-b11056-bin-win-sycl-x64.zip",
    "llama-b11056-bin-win-vulkan-x64.zip", "llama-b11056-ui.tar.gz", "llama-b11056-xcframework.zip"
  ]
}
```

### 3.5 How an install and an update work today (read from the code)

- `binary.acquire_binary(cache_root, config, hardware, on_progress, cancel_check, gpu, force)`
  downloads the stored `asset_url` (+ `runtime_url`) into `<build>/.staging-<gpu>`, unpacks,
  runs **`_verify_exe_launches(exe, platform)`** (`<exe> --version`; catches a missing DLL/.so),
  then **`_swap_into_place(staging, dest)`**. Any exception leaves the live engine untouched.
- `lifecycle._run_install(force, replace_build, gpu)` calls `self._acquire_binary(...)` (an
  injected callable; every test double is `lambda *a, **k`, so a new keyword is safe), then the
  optional Vulkan extra on a ROCm pick, then **deletes every build dir except the pin** (after
  `self.stop()`), carrying a hand-made `models.ini` over first.
- The dest dir is named for `config.llamacpp.pinned_build`.
- `useEngine.js::updateToLatest`: PUT `{pinnedBuild: latest, binaries}` → POST
  `/v1/llm-runner/engine/install {force: true, replaceBuild: previous}`. The POST returns at
  once; the outcome arrives through the 800 ms status poll. `_syncPoll()` has a branch that
  runs once when the install **leaves** `installing` — the hook for R8.
- `lifecycle._installed_build(config)` = `build_of_exe(cache_root, self._acquired_exe(...))` —
  the build actually on disk (QC-13/QC-25). `binary.build_of_exe` reads the folder name under
  `llamacpp/`.
- Seeding is **insert-if-missing** (`seed.seed_default_runner_binaries`, the `pinned_build`
  setting). `DEFAULT_PINNED_BUILD` / `DEFAULT_BINARIES` reach only **fresh** databases and
  "reset to defaults". Existing users keep their pin until they click Update. No migration.

### 3.6 Where the launch flags are rendered — and one trap

- ONE normalised list: `process.overrides_to_pairs(ov, *, n_gpu_layers, n_cpu_moe, ctx_len)` →
  `render_ini` (router `models.ini`) and `render_argv` (direct spawn). The loading pair is
  rendered here:
  ```python
  if ov.mlock:    pairs.append(("mlock", None))
  if ov.no_mmap:  pairs.append(("no-mmap", None))
  ```
- The **live** path is the router: `process.emit_models_ini(entries)`, called from exactly one
  place, `lifecycle._emit_ini`. `_emit_ini` has four call sites, and `server_exe` is in scope
  at every one of them:
  ```
  lifecycle.py  _load_via_router            _, changed = self._emit_ini(override=entry)
  lifecycle.py  _router_load_with_backoff   self._emit_ini(override=entry)   ×3
  ```
- `process.start_runner` → `compose_flags` is the legacy direct-spawn path. Nothing in
  `lifecycle.py` calls it; tests do. Keep it in parity.
- `lifecycle._strip_inert_mlock(ov)` runs before rendering: on Windows, `mlock` beside
  `no_mmap` is cleared. Unchanged by this plan.
- **TRAP — do not derive the engine build from `self._active_server_exe` alone.** It is the
  session's "proven" exe, and it is cleared only in `__init__` and when the cache is
  re-pointed — **not** by `stop()`. After an engine update it still points at the deleted old
  build. Rendering from it would emit old-style flags for the new engine, and the first load
  after an update would fail. Use the exe that is about to be spawned or bounced (§4 Slice 1,
  step 1.4).

### 3.7 Structured output: our adapter breaks the schema — observed

`tools/server/server-common.cpp`, **identical** at `b9993`, `b10437` and `b10964`:

```cpp
if (response_type == "json_object") {
    if (response_format.contains("schema") || json_schema.empty()) {
        json_schema = json_value(response_format, "schema", json::object());   // flat "schema": json_object ONLY
    }
} else if (response_type == "json_schema") {
    auto schema_wrapper = json_value(response_format, "json_schema", json::object());
    json_schema = json_value(schema_wrapper, "schema", json::object());        // NESTED form only
}
```

- `prompts._response_format` emits the correct OpenAI-standard nested form
  (`{"type":"json_schema","json_schema":{"name","schema","strict":true}}`).
- `openai_compat.OpenAICompatAdapter._adapt_response_format` then **rewrites it** to
  `{"type":"json_schema","schema":…}` for `provider_type == "local-llamacpp"`, citing the
  server README. The README does document that form (`tools/server/README.md` at `b10437`,
  the `response_format` paragraph) — but the code reads `response_format["json_schema"]`,
  finds nothing, and ends up with an **empty schema** = "any JSON".
- **Observed 2026-09-19** on the installed `b10437`, CPU only (`-ngl 0`), the speed-check
  model, prompt *"Reply with a JSON object describing today's weather in Paris."*, schema
  requiring exactly `zzq_code` (integer) and `zzq_word` (`alpha`|`beta`):

  | form | enforced | output keys |
  |---|---|---|
  | A — flat `{type:json_schema, schema:S}` (**what we send**) | **no** | `Humidity, Precipitation, Sunrise, Sunset, Temperature, …` |
  | B — nested `{type:json_schema, json_schema:{schema:S}}` | yes | `zzq_code, zzq_word` |
  | C — flat `{type:json_object, schema:S}` | yes | `zzq_code, zzq_word` |

- **Measured impact on the user's real databases:** JustWrite — 39 actions, 21 with
  `json_mode`, **1 with a schema** (`entitySweep`; keywords used: `type`, `properties`,
  `items`, `required` — all basic). JustVoice — 13 actions, 3 `json_mode`, **0 with a schema**.
  The other JSON actions send `{"type":"json_object"}`, which works as designed.
- The ledger's Baseline line ("b9644 — server-side `{"type":"json_schema","schema":…}`
  structured output") is wrong for `b9993`+ and is corrected by the review's ledger edit.
- No schema in any of the three repos' source uses a regex `pattern` (grep, 2026-09-19), so
  upstream's `\-` pattern bug (#29127, fixed only at `b11052`) does not reach us.

### 3.8 Other verified facts the box test relies on

- **Builds to avoid as a pin:** `b10121`–`b10267` (macOS ≤ 15 binaries broken, #26375) ·
  `b10398`–`b10581` (no Linux ROCm asset) · `b10741`–`b10748` (Gemma-4 *assistant* MTP draft
  broken by #28159, fixed by #28183). `b10964` is outside all three.
- **The rules the VRAM fit copies are unchanged** at `b10964`/`b11056`:
  `LLM_FFN_EXPS_REGEX = "\\.ffn_(up|down|gate|gate_up)_(ch|)exps"` ·
  `i_gpu_start = std::max(n_layer_all + 1 - n_gpu_layers, 0)` · the iSWA line
  `size_swa = GGML_PAD(std::min(size_base, hparams.n_swa*(unified ? n_seq_max : 1) + n_ubatch), 256)` ·
  auto slots `params.n_parallel = 4`.
- `b10964` contains a rewrite of JSON-schema handling (`common_schema`, #28736, `b10934`) only
  30 builds before the cut. The box test therefore exercises a real schema (§5).
- **Gains in `b10964` that `b10437` lacks** (upstream's numbers, other hardware — **not
  measured here**): CUDA MoE fusion extended to speculative batches (#27621, "2–22 %") · fused
  MoE expert reduction (#25952) · fast `mm_ids` path (#27978) · CUDA race fixes in `mmid`/`mmf`
  (#28475) · f16 flash-attention barrier fix (#27870) · lower RAM peak while loading (#27483)
  · router LRU-hang fix (#28539) · MTP context KV fix (#28630).
- **After `b10964`, waiting for the next stable:** CUDA graphs for the MTP draft (#28549,
  `b11007`, "+4–5 %") · graceful allocation-failure handling (`b11036`, `b11040`) · the Linux
  CUDA tarballs (`b10969`+).
- `__overhead__` measurement rows are stamped `<build on disk> <PHYSICS_VERSION>`, so an engine
  change re-learns them by construction. Nothing to do.

---

## 4. The slices

Gate commands (kit `CLAUDE.md`; run from `E:\Dev\Web\just-llm-runner`):

```bash
../justwrite-app/.venv/Scripts/python.exe -m pytest -q
../justwrite-app/.venv/Scripts/python.exe -m ruff check .
../justwrite-app/.venv/Scripts/python.exe scripts/check-consumers.py     # after ANY shared-export change
node scripts/check-family.mjs
cd ui && E:\Dev\Web\JustVioce\node_modules\.bin\biome.cmd check src       # kit UI lint (the kit has no biome of its own)
```

Consumer gates, after any kit change (the kit is consumed as source):

```bash
# JustVoice  (E:\Dev\Web\JustVioce)
cd server && ruff check . && pytest ; cd ..
npm run test:unit && npm run build:vite
# the renderer gate — only when a slice touched kit UI (Slice 2 and 3):
justvoice-server serve --host 127.0.0.1 --port 8741 --data-dir src-tauri/target/debug/data   # background
JV_BASE=http://127.0.0.1:8741 npm run smoke          # then kill :8741 BY PORT
# JustWrite  (E:\Dev\Web\justwrite-app — branch is `master`)
npm run test:unit && npm run build:vite
cd server && ../.venv/Scripts/python.exe -m pytest -q
# docgen     (E:\Dev\Web\just_ai_i18n_docgen)
npm run test:unit && npm run build:vite              # if those scripts exist there — read package.json first
```

Known flakes (memory, 2026-08): `test_prefetch_cancel_via_http_endpoint` rarely flakes under
full-suite load and passes alone; `test_llm_dispatch.py::test_think_is_sent…` fails when its
FILE runs alone and passes in the suite. A red run on either is re-run once before it is
reported as a failure — and reported either way.

---

### SLICE 0 — structured output: stop flattening  *(PROPOSED — needs the user's word, see the header)*

**Goal.** llama-server receives the nested `json_schema` form. No build dependency.

**One thing the user should weigh before saying yes.** Turning enforcement *on* can turn a
soft failure into a hard one: a schema the engine cannot convert to a grammar is an HTTP error
at the pin (`b9993`), where today the same schema is silently ignored and the feature "works"
unconstrained. On the author's real databases the only schema is `entitySweep`'s, which uses
just `type` / `properties` / `items` / `required` — basic keywords, but it has **not** been
run through the engine yet (the 2026-09-19 probe used its own test schema). A user-authored
schema (the prompt editor exposes the field) is unknown by definition. Step 0.4's script
therefore has an `--all-stored` mode and step 0.5 runs it: **every** stored schema goes
through the engine once, in the nested form, before this slice is called done.

**0.1 Edit `llm_runner/llm/openai_compat.py`**

- Delete the method `_adapt_response_format` entirely.
- Delete its two call sites — the line `self._adapt_response_format(body)` in `chat()` and the
  same line in the streaming method (grep finds exactly two).
- Leave a 4-line comment where the `chat()` call was:
  ```python
  # response_format passes through UNCHANGED for every provider type. llama-server reads a
  # json_schema schema ONLY from the OpenAI-standard nested form (server-common.cpp, same at
  # b9993/b10437/b10964); the flat form its README documents is silently read as "any JSON"
  # (observed 2026-09-19 — plan 2026-09-19-engine-update-safety-and-stable-channel §3.7).
  ```

**0.2 Edit `llm_runner/llm/prompts.py`** — in `_response_format`'s docstring, the phrase that
says llama.cpp takes the *"b9644-documented {"type":"json_schema","schema":…}"* form is now
false. Replace that clause with: *"llama.cpp reads the same nested OpenAI form (flat is
silently ignored — see openai_compat)"*. Docstring only; no code change.

**0.3 Tests**

- `tests/test_plane2_params.py`: **replace** `test_openai_compat_flattens_schema_for_builtin_only`
  with `test_response_format_reaches_the_wire_unchanged_for_every_provider_type`:
  - build the adapter the way `tests/test_adapter_extra.py` does:
    `OpenAICompatAdapter("p", "local-llamacpp", api_key="")` and
    `OpenAICompatAdapter("p", "openai-compat", api_key="")`;
  - replace `adapter._client` with a fake whose `post(url, json=None, headers=None)` records
    `json` and returns an object with `status_code = 200`, `text = ""` and a `json()` that
    returns a minimal chat completion (`{"choices":[{"message":{"role":"assistant","content":"{}"},
    "finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`
    — read `chat()` and add whatever else it dereferences);
  - call `chat([...], extra={"response_format": NESTED})` where `NESTED` is the dict the old
    test used;
  - assert, for **both** provider types, `recorded["response_format"] == NESTED`.
- Add `assert not hasattr(OpenAICompatAdapter, "_adapt_response_format")` to the same test — a
  guard against the flattening coming back.

**0.4 A permanent engine probe** — new file `scripts/check-structured-output.py` (a dev tool,
like the other `scripts/check-*.py`; never shipped). It is the 2026-09-19 experiment, kept so
every pin bump can re-run it. Behaviour:

- args: `--exe <llama-server>`, `--gguf <small model>`; defaults read from
  `JUSTWRITE_DATA_DIR` the way `tests/test_realrouter_smoke.py` resolves them — the newest
  build dir under `<data>/ai-cache/llamacpp/`, and the speed-check model under
  `<data>/ai-cache/calib/*.gguf`;
- spawn `<exe> -m <gguf> -ngl 0 -c 2048 --host 127.0.0.1 --port <free port>` (CPU only — it
  must never contend for VRAM with whatever the user has loaded); wait for `/health` (120 s);
- POST `/v1/chat/completions` three times with `temperature 0`, `max_tokens 96`, the prompt and
  schema of §3.7, forms A, B and C;
- print one line per form: `enforced: True|False`, the keys;
- **exit 0 only if form B is enforced** (the form we now send); exit 1 otherwise;
- **`--all-stored <sqlite db> [<sqlite db> …]`**: read
  `select key, json_schema from feature_prompts where json_mode = 1 and trim(json_schema) != ''`
  from each database (read-only: open with `sqlite3.connect(f"file:{path}?mode=ro", uri=True)`),
  and POST each schema once in the **nested** form with `max_tokens: 8`. An HTTP error names
  the action key and prints the engine's message; any such error → exit 1. This proves the
  engine can *convert* every schema the apps really hold;
- always terminate the process it started (`terminate()`, then `kill()` after 15 s), in a
  `finally`.

**0.5 Acceptance**

- kit gates green; consumer gates green.
- `scripts/check-structured-output.py` against the user's real data dir → exit 0, and its
  output pasted into §9. Expected on `b10437`: A `False`, B `True`, C `True`.
- `scripts/check-structured-output.py --all-stored` with the real JustWrite and JustVoice
  databases (`…/justwrite-app/src-tauri/target/debug/data/justwrite.db`,
  `…/JustVioce/src-tauri/target/debug/data/justvoice.db`; add docgen's if it has one) → exit 0.
  Expected today: one schema, `entitySweep`. **If any schema is rejected: stop and report** —
  that action would start failing once enforcement is on, and what to do about it is the
  user's call.
- *Not verified by this slice, and say so:* the pin build `b9993` (not on disk). Its parser is
  source-identical for `response_format`, but its schema-to-grammar converter is older. If the
  user wants it checked, `llama-b9993-bin-win-cpu-x64.zip` (17 MB) run the same way on CPU
  settles it — ask first; it is a download.
- *Not required, say so if skipped:* running JustWrite's `entitySweep` through the app.

**0.6 Docs.** No user-facing text describes the wire form. JV `docs/whats-new.md` (open
`v0.1.0` section) gains one bullet: *"A feature that carries a JSON schema now has that schema
enforced on the local engine — it was being sent in a form the engine silently ignored."*
docgen: read its `docs/whats-new.md` and follow its convention. JustWrite: R14.

---

### SLICE 1 — launch flags by engine build, and the install-time flag probe

**Goal.** `mlock` / `no_mmap` render as `--load-mode` for engines ≥ `b10145` and as the legacy
flags below that. A staged engine that rejects any flag we emit never replaces the working one.

**1.0 Baseline first (no edits yet).** With the user's app **closed** (the smoke needs `:8080`
free), run the real-router smoke and paste the result into §9:

```bash
JW_REALROUTER=1 JUSTWRITE_DATA_DIR=E:/Dev/Web/justwrite-app/src-tauri/target/debug/data \
  ../justwrite-app/.venv/Scripts/python.exe -m pytest -m realrouter -n 0 -v
```

Expected on `b10437` if §3.3 is right: `test_mlock_parity_router_vs_standalone` **fails**
(standalone `--mlock` no longer locks). Either outcome is a finding — record it, change
nothing because of it, carry on.

**1.1 `llm_runner/runner/process.py` — constants and the mapping**

Add near `_VALUE_FLAGS` (and `from .binary import build_num` at the top — `binary.py` imports
only `download` and `schema`, so there is no cycle):

```python
# `--load-mode` replaces --mlock / --mmap / --no-mmap / --direct-io (llama.cpp #20834, b10105;
# the legacy args were DELETED at b10875, #28334). We switch at b10145 (#26135), the first build
# whose value list has `mmap+mlock` AND where `mlock` means "lock WITHOUT mmap" — at b10105 the
# list is none|mmap|mlock|dio. Semantics verified identical b10145 → b11056 (plan
# docs/plans/2026-09-19-engine-update-safety-and-stable-channel.md §3.3).
LOAD_MODE_MIN_BUILD = 10145


def load_mode_value(mlock: bool | None, no_mmap: bool | None) -> str | None:
    """The `--load-mode` value for the kit's two loading switches, or None to emit nothing
    (the engine default). `mlock` alone keeps its PRE-refactor meaning (mmap on + lock — the
    combination the 2026-07-22 A/B proved locks on Windows); since b10105 the legacy `--mlock`
    means lock WITHOUT mmap, and beside `--no-mmap` only the LAST flag takes effect."""
    if mlock and no_mmap:
        return "mlock"          # no mmap + lock (Windows never reaches here — _strip_inert_mlock)
    if mlock:
        return "mmap+mlock"
    if no_mmap:
        return "none"
    return None
```

**1.2 `overrides_to_pairs` gains one keyword, defaulted**

Signature: `overrides_to_pairs(ov, *, n_gpu_layers, n_cpu_moe, ctx_len, engine_build: str = "")`.

Replace the two `mlock` / `no-mmap` appends with:

```python
    if build_num(engine_build) >= LOAD_MODE_MIN_BUILD:
        mode = load_mode_value(ov.mlock, ov.no_mmap)
        if mode is not None:
            pairs.append(("load-mode", mode))
    else:
        # Unknown build ("" → -1) or a pre-b10145 engine: the legacy presence flags.
        if ov.mlock:
            pairs.append(("mlock", None))
        if ov.no_mmap:
            pairs.append(("no-mmap", None))
```

Keep the position (after the `_VALUE_FLAGS` loop, before `no-kv-offload`). `engine_build=""`
is today's behaviour, byte for byte — every existing test stays green. Update the docstring's
"presence flags (mlock / no-mmap / …)" sentence to name the rule.

**1.3 Pass it through the two renderers' callers**

- `emit_models_ini(entries, *, engine_build: str = "")` → passes `engine_build=engine_build`
  to `overrides_to_pairs`.
- `compose_flags(..., block_count: int = 0, engine_build: str = "")` → same. (Legacy path,
  parity only. `start_runner` is **not** given a new parameter.)
- `ModelIniEntry` is **not** changed. The engine build is a property of the whole `.ini`, not
  of a model — that is why this is one parameter at one call site instead of four.

**1.4 `llm_runner/runner/lifecycle.py` — `_emit_ini` renders for the exe that will run**

```python
    def _emit_ini(self, override: ModelIniEntry | None = None, *, server_exe=None) -> tuple[Path, bool]:
        ...
        entries = self._resolve_ini_entries(override)
        text = emit_models_ini(entries, engine_build=self._engine_build_of(server_exe))
```

New helper beside `_installed_build`:

```python
    def _engine_build_of(self, server_exe=None) -> str:
        """The build of the exe a render is FOR — flag spellings depend on it (process.
        LOAD_MODE_MIN_BUILD). `server_exe` = the exe about to be spawned or bounced; absent →
        the one `_acquired_exe` would pick. NEVER `_active_server_exe` on its own: it is not
        cleared by stop(), so after an engine update it still names the deleted old build."""
        exe = server_exe or self._acquired_exe(self.cache_root, self._config_fn(), self._hardware_fn())
        return (build_of_exe(self.cache_root, Path(exe)) if exe else None) or ""
```

Call sites:

- `_load_via_router` — compute the effective exe **before** the emit, using the precedence the
  function already applies after it:
  ```python
  router_up = self._router is not None and self._router.is_alive()
  effective_exe = (self._active_server_exe if router_up else None) or server_exe
  _, changed = self._emit_ini(override=entry, server_exe=effective_exe)
  ```
- the three `self._emit_ini(override=entry)` calls in `_router_load_with_backoff` → add
  `server_exe=server_exe` (it is that function's parameter).

Confirm `build_of_exe` and `Path` are imported in `lifecycle.py`; add them if not.

**1.5 The probe argvs — `process.py`**

```python
def probe_argvs(engine_build: str) -> list[list[str]]:
    """Launch-flag ACCEPTANCE probes for an engine build: each list is `<flags…> --version`.
    llama-server parses args IN ORDER and exits on `--version`, so an unknown flag or a bad
    value placed before it exits 1 ("error: invalid argument: …") with no model and no GPU
    (observed on b10437, plan §3.3). Together the lists cover every key `overrides_to_pairs`
    can emit for that build, plus the fit knobs and the router's own flags."""
    common = dict(cache_type_k="q8_0", cache_type_v="q8_0", flash_attn="on", batch_size=512,
                  ubatch_size=512, threads=4, threads_batch=4, parallel=1, cache_reuse=256)
    configs = [
        Overrides(**common, mlock=True, no_kv_offload=True, cont_batching=False,
                  context_shift=True, spec_type="draft-mtp", spec_n_max=2),
        Overrides(no_mmap=True, context_shift=False, spec_type="ngram-mod", spec_n_max=4),
        Overrides(mlock=True, no_mmap=True),
    ]
    out = [render_argv(overrides_to_pairs(ov, n_gpu_layers=31, n_cpu_moe=21, ctx_len=4096,
                                          engine_build=engine_build)) + ["--version"]
           for ov in configs]
    out.append(["--models-dir", ".", "--models-preset", "models.ini", "--models-max", "2",
                "--sleep-idle-seconds", "600", "--host", "127.0.0.1", "--port", "1",
                "--embeddings", "--pooling", "mean", "--version"])
    return out
```

`model_draft` is deliberately absent (it is a path). `--embeddings` (plural) is the spelling
the `.ini` emits (`embeddings = true`); upstream lists it as an alias of `--embedding` at
`b10437`, `b10964` and `b11056`.

**Pre-verified 2026-09-19 on the real `b10437` exe** — these exact lists, hand-rendered, all
exit 0: new-era 1 (`--load-mode mmap+mlock` + every value flag + `draft-mtp`) · new-era 2
(`--load-mode none` + `ngram-mod`) · new-era 3 (`--load-mode mlock`) · legacy 1 (`--mlock` +
every value flag, as rendered for `b9993`) · legacy 3 (`--mlock --no-mmap`) · the router list.
If step 1.9 disagrees, that is a finding — report it; do not swap a value for one that passes
without saying so.

**1.6 `llm_runner/runner/binary.py` — the acceptance check**

```python
def _verify_exe_accepts_flags(exe: Path, argvs, *, run: Callable | None = None) -> None:
    """Confirm a freshly-unpacked llama-server ACCEPTS the launch flags this app emits —
    the check `--version` alone cannot do. Born 2026-09-19: llama.cpp b10875 deleted
    `--mlock`/`--no-mmap`; such a build passes `_verify_exe_launches`, gets swapped in, the old
    build is swept, and every model load then dies on "invalid argument". A non-zero exit
    raises, so the caller discards the staged build and the working engine stays."""
    for argv in argvs or ():
        try:
            proc = run(argv) if run else subprocess.run(  # noqa: S603 — a trusted, just-unpacked release exe
                [str(exe), *argv], capture_output=True, timeout=60)
        except (OSError, subprocess.TimeoutExpired) as e:
            raise RuntimeError(f"engine binary {exe} could not run the flag check: {e}") from e
        rc = int(getattr(proc, "returncode", 0) or 0)
        if rc != 0:
            text = b"".join(x for x in (getattr(proc, "stdout", b""), getattr(proc, "stderr", b"")) if x)
            line = next((ln.strip() for ln in text.decode("utf-8", "replace").splitlines()
                         if "invalid argument" in ln or "error while handling argument" in ln), "")
            raise RuntimeError(
                "this engine build does not accept a launch flag this app uses"
                + (f" ({line})" if line else f" (exit {rc})")
                + " — the installed engine was left in place")
```

`acquire_binary` gains `probe_argvs: Sequence[Sequence[str]] | None = None` (last parameter,
defaulted). Inside the `try`, directly after `_verify_exe_launches(exe, hardware.platform)`
and **before** `_swap_into_place`:

```python
        _verify_exe_accepts_flags(exe, probe_argvs)
```

Extend `acquire_binary`'s docstring ("ATOMIC + VERIFIED") with one sentence naming the check.

**1.7 `lifecycle._run_install` passes the probes**

```python
            from .process import probe_argvs
            probes = probe_argvs(config.llamacpp.pinned_build)
```

and add `probe_argvs=probes` to all three `self._acquire_binary(...)` calls (the `gpu`
backend-add, the main install, the extras loop). The build being installed **is**
`config.llamacpp.pinned_build` (the dest dir is named for it).

**1.8 Tests**

`tests/test_runner.py`

- `test_load_mode_value_table` — the four rows of §3.3.
- `test_overrides_to_pairs_load_mode_by_engine_build` — parametrised over
  `engine_build ∈ {"", "b9993", "b10144"}` → the pairs contain `("mlock", None)` /
  `("no-mmap", None)` exactly as today, and **no** `load-mode`; over
  `{"b10145", "b10437", "b10964", "b11056"}` → `("load-mode", "mmap+mlock")`,
  `("load-mode", "none")`, `("load-mode", "mlock")`, or no loading pair at all; and never a
  `mlock` or `no-mmap` key.
- `test_emit_models_ini_renders_load_mode_for_new_engines` — `engine_build="b10964"` →
  the section contains `load-mode = none`; with no `engine_build` → `no-mmap = true`.
- `test_compose_flags_load_mode_parity` — `render_argv` and `render_ini` agree for a new build.
- `test_probe_argvs_cover_every_emitted_key` — for a legacy build and a new one, the union of
  flags across the argvs contains `--<key>` for every `_VALUE_FLAGS` flag **except**
  `--model-draft`, plus `-ngl`, `--n-cpu-moe`, `--ctx-size`, `--no-kv-offload`,
  `--no-cont-batching`, `--context-shift`, `--no-context-shift`, `--spec-type`,
  `--spec-draft-n-max`, `--spec-ngram-mod-n-max`, and either `--load-mode` (new) or both
  `--mlock` and `--no-mmap` (legacy); and every argv ends with `--version`.

`tests/test_binary.py`

- `test_verify_exe_accepts_flags_names_the_rejected_flag` — `run` returns
  `returncode=1, stderr=b"error: invalid argument: --no-mmap\n"` → `RuntimeError` whose text
  contains `--no-mmap`.
- `test_verify_exe_accepts_flags_passes_on_zero_and_on_no_probes`.
- `test_acquire_discards_a_build_that_rejects_our_flags` — mirror
  `test_acquire_atomic_a_build_that_fails_launch_is_discarded`: the live `dest` still holds the
  old exe afterwards and `.staging-*` is gone.

`tests/test_lifecycle.py`

- `test_emit_ini_renders_for_the_engine_on_disk` — an exe under `llamacpp/b10437/cuda12/` and a
  MoE entry with `no_mmap` → `models.ini` contains `load-mode = none`; the same under
  `llamacpp/b9993/cuda12/` → `no-mmap = true`.
- `test_emit_ini_ignores_a_stale_proven_exe` — set `svc._active_server_exe` to a path under
  `llamacpp/b9993/…`, leave the router down, make `_acquired_exe` return a `b10964` path →
  the render is the **new** spelling. This is §3.6's trap, pinned.
- `test_run_install_hands_the_flag_probes_to_acquire` — a fake `acquire_binary` records its
  kwargs; `probe_argvs` is non-empty and each list ends with `--version`.

`tests/test_realrouter_smoke.py` — the two mlock cases assert on the emitted `.ini` text
(`"no-mmap = true" in section`, `"mlock = " not in section`). Make them build-aware: read the
installed build via `build_of_exe`; at ≥ 10145 expect `load-mode = none` for the Windows pair
and `load-mode = mmap+mlock` for `mlock` alone; keep the old expectations below that.

**1.9 Acceptance — on the user's real engine**

1. Kit and consumer gates green.
2. Real probe — run and paste into §9:
   ```bash
   ../justwrite-app/.venv/Scripts/python.exe - <<'EOF'
   import subprocess
   from llm_runner.runner.process import probe_argvs
   exe = r"E:\Dev\Web\justwrite-app\src-tauri\target\debug\data\ai-cache\llamacpp\b10437\cuda12\llama-server.exe"
   for a in probe_argvs("b10437"):
       p = subprocess.run([exe, *a], capture_output=True, timeout=60)
       print(p.returncode, " ".join(a))
   EOF
   ```
   Every line must start with `0`.
3. Re-run step 1.0's real-router smoke. `test_mlock_parity_router_vs_standalone`'s
   router-side assertion must pass on the new rendering. If its **standalone** half still
   spawns with the legacy `--mlock`, change that one line to `--load-mode mmap+mlock` when the
   installed build is ≥ 10145, and say so in §9.
4. Start the user's real app (or ask the user to), load the flagship, and read the newest
   `ai-runtime/logs/router-*.log`: the argv block shows `--load-mode none`; the
   `DEPRECATED: --mmap and --no-mmap` line is **gone**. Paste both observations.

**1.10 Docs.** No user-visible change (same switches, same labels). `docs/dev/serving-design.md`
gains one bullet under "The shape": *flag spellings follow the engine build
(`process.LOAD_MODE_MIN_BUILD`), and an install is refused if the staged engine rejects any
flag we emit (`binary._verify_exe_accepts_flags`)* — with a pointer to this plan.

---

### SLICE 2 — download names from the release's own asset list

**Goal.** An update resolves each `(platform, gpu)` row's real filename at the target build;
refuses up front when this machine's row has none; restores the pin if the install fails.

**2.1 `llm_runner/runner/binary.py` — the pure resolver**

```python
_UPSTREAM_DL = "https://github.com/ggml-org/llama.cpp/releases/download"

# (platform, gpu) → (asset regex, runtime regex | None). `{b}` = the escaped build tag;
# `{v}` = the CUDA version captured from the chosen asset (12.4 ↔ cudart 12.4). Patterns are
# ANCHORED and end in the arch, so `…-win-cuda-13.4-arm64.zip` never matches an x64 row.
# Names verified against the b9993 / b10437 / b10964 / b11056 asset lists (plan §3.4).
ASSET_PATTERNS: dict[tuple[str, str], tuple[str, str | None]] = {
    ("windows", "cuda12"): (r"^llama-{b}-bin-win-cuda-(12\.\d+)-x64\.zip$", r"^cudart-llama-bin-win-cuda-{v}-x64\.zip$"),
    ("windows", "cuda13"): (r"^llama-{b}-bin-win-cuda-(13\.\d+)-x64\.zip$", r"^cudart-llama-bin-win-cuda-{v}-x64\.zip$"),
    ("windows", "rocm"):   (r"^llama-{b}-bin-win-(?:hip-radeon|rocm-([\d.]+))-x64\.zip$", None),
    ("windows", "vulkan"): (r"^llama-{b}-bin-win-vulkan-x64\.zip$", None),
    ("macos", "metal"):    (r"^llama-{b}-bin-macos-arm64\.tar\.gz$", None),
    ("linux", "rocm"):     (r"^llama-{b}-bin-ubuntu-rocm-([\d.]+)-x64\.tar\.gz$", None),
    ("linux", "vulkan"):   (r"^llama-{b}-bin-ubuntu-vulkan-x64\.tar\.gz$", None),
}


def resolve_release_assets(build: str, rows, assets) -> list[dict]:
    """Map each stored binary row to the file that build ACTUALLY publishes. Pure — `assets`
    is `[{"name": str, "url": str}]` from the release. Per row the result carries
    `resolved`: True (found) · False (this build has no download for it) · None (not ours to
    resolve: a docker row, a row with no pattern, or a hand-edited URL that is not an upstream
    release download). Several matches → the highest version. A row whose asset resolves but
    whose runtime companion does not is `resolved: False`."""
```

Details the body must honour:

- `rows` are `schema.BinaryAsset` objects (`config.llamacpp.binaries` — attributes
  `platform`, `gpu`, `source`, `asset_url`, `runtime_url`); the result rows are **camelCase**
  dicts so the UI can merge them straight into the engine-config `binaries` it PUTs;
- fill the placeholders with `pattern.replace("{b}", re.escape(build))` and
  `.replace("{v}", re.escape(version))` — **not** `str.format`, which would choke on regex
  braces if one is ever added;
- a row is *ours to resolve* only when `source == "github"`, `(platform, gpu)` is in
  `ASSET_PATTERNS`, and `"/ggml-org/llama.cpp/releases/download/"` is in its `asset_url`;
- "highest version" = compare the captured group as a tuple of ints; a match with no captured
  group (e.g. `win-hip-radeon`) ranks lowest;
- the URL is the asset's `url` when present, else `f"{_UPSTREAM_DL}/{build}/{name}"`;
- unresolved and not-ours rows keep their stored URLs untouched in the result;
- each result row: `{"platform","gpu","assetUrl","runtimeUrl","resolved","reason"}` —
  `reason` is `""` or a short phrase such as `"no download for windows/rocm at b10437"`.

**2.2 `llm_runner/runner/lifecycle.py` — fetch + service method**

Beside `_fetch_latest_llamacpp_tag`:

```python
def _fetch_llamacpp_release_assets(build: str) -> list[dict]:
    """The asset list of ONE upstream release (`releases/tags/<build>`). Same reach as the
    update check: injectable in tests, unreachable from the dev container's proxy."""
    r = requests.get(f"https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/{build}",
                     headers={"User-Agent": "just-llm-runner"}, timeout=15)
    r.raise_for_status()
    return [{"name": str(a.get("name") or ""), "url": str(a.get("browser_download_url") or "")}
            for a in (r.json().get("assets") or [])]
```

- `RunnerService.__init__` gains `release_assets_fn=None` →
  `self._release_assets_fn = release_assets_fn or _fetch_llamacpp_release_assets` (mirror the
  existing `latest_build_fn` wiring exactly, including how the constructor documents it).
- New method:
  ```python
  def resolve_build_assets(self, build: str) -> dict:
      """Where an update to `build` would download from, per stored row — resolved from the
      release's OWN asset list (upstream renames files between builds). Read-only: it never
      writes the pin or a URL. A fetch failure reports as `error` — the caller then falls
      back to tag substitution."""
  ```
  Returns `{"build", "binaries": [...], "selected": {"platform","gpu","resolved"} | None, "error": ""}`.
  `selected` is the row `select_binary(config, hardware)` picks for this machine. A `build`
  that fails `re.fullmatch(r"b\d+", build)` → `{"error": "not a build tag", …}` with no network
  call.

**2.3 `llm_runner/runner/api.py`**

```python
@router.get("/v1/llm-runner/engine/resolve-assets", summary="Where an update to a build would download from (read-only)")
async def engine_resolve_assets(build: str) -> dict:
    return get_service().resolve_build_assets(build)
```

Place it directly under `engine_update_check`.

**2.4 Kit UI — `ui/src/common/services/engineUrl.js`** (pure helpers, so they can be unit-tested
without a DOM)

```js
// The binaries to PUT for an update to `build`. A row the server RESOLVED carries the file
// that build really publishes (upstream renames assets — plan 2026-09-19 §3.4); every other
// row keeps the tag substitution. `plan` = GET /engine/resolve-assets, or null when that call
// failed (offline / rate-limited) — then every row is substituted, as before.
export function planBinaries(binaries, plan, build) {
  const byKey = new Map((plan?.binaries || []).map((r) => [`${r.platform}/${r.gpu}`, r]));
  return (binaries || []).map((b) => {
    const r = byKey.get(`${b.platform}/${b.gpu}`);
    if (r && r.resolved === true) return { ...b, assetUrl: r.assetUrl, runtimeUrl: r.runtimeUrl };
    return { ...b, assetUrl: applyBuildToUrl(b.assetUrl, build), runtimeUrl: applyBuildToUrl(b.runtimeUrl, build) };
  });
}

// True when an update that wrote `pending.target` as the pin ended with some OTHER build on
// disk (failed, cancelled, or rejected by the install-time checks) → the pin and URLs must go
// back to `pending.previous`.
export function shouldRollback(pending, status) {
  if (!pending || !status || status.status === "installing") return false;
  return (status.build || "") !== pending.target;
}
```

**2.5 Kit UI — `ui/src/composables/useEngine.js`**

- module state: `let pendingUpdate = null; // { target, previous: { pinnedBuild, binaries } }`
- `updateToLatest()`, in this order:
  1. `let plan = null; try { plan = await request(\`/v1/llm-runner/engine/resolve-assets?build=${encodeURIComponent(latest)}\`); } catch { plan = null; }`
     and treat `plan?.error` as `plan = null`.
  2. If `plan?.selected && plan.selected.resolved === false` → set
     `error.value = \`${latest} has no download for this computer's graphics type (${plan.selected.gpu}). Nothing was changed.\``
     and `return` — **before** any PUT.
  3. `const cfg = await request("/v1/ai/engine-config");`
  4. `pendingUpdate = { target: latest, previous: { pinnedBuild: cfg.pinnedBuild, binaries: cfg.binaries } };`
  5. PUT `{ pinnedBuild: latest, binaries: planBinaries(cfg.binaries, plan, latest) }`.
  6. POST the install exactly as today, then the existing `await refreshEngine()`.
  7. **Close the fast-failure hole.** `_syncPoll()`'s terminal branch only runs if the poll
     timer was started, i.e. if some poll *saw* `installing`. An install that dies inside the
     first 800 ms (an immediate 404) never starts it. So directly after that `refreshEngine()`:
     ```js
     if (pendingUpdate && st.value?.status !== "installing") {
       if (shouldRollback(pendingUpdate, st.value)) await rollbackPendingUpdate();
       else pendingUpdate = null;
     }
     ```
  8. In the existing `catch`: if `pendingUpdate`, `await rollbackPendingUpdate()` before
     setting `error.value`.
- new `async function rollbackPendingUpdate()`: PUT `pendingUpdate.previous` back, clear
  `pendingUpdate`, and **append** to `error.value`:
  ` Your engine was left on ${previous.pinnedBuild}.` A failing PUT is swallowed (the poll
  must never throw).
- `_syncPoll()`, the branch that runs once when the install leaves `installing` — add, before
  the models refresh:
  ```js
  if (pendingUpdate) {
    if (shouldRollback(pendingUpdate, st.value)) rollbackPendingUpdate().catch(() => {});
    else pendingUpdate = null;
  }
  ```
- Fix the now-false comment in `updateToLatest` (*"The acquire path verifies the release's
  asset names"*) — name the resolve step instead.
- Known and accepted: if the app closes mid-update, `pendingUpdate` is lost; the pin stays at
  the target, the old engine stays on disk, and the update is offered again next launch.

**2.6 Tests**

- `tests/test_binary.py` — `test_resolve_release_assets_against_four_real_builds`: load the
  fixture; rows = `DEFAULT_BINARIES` re-pointed at each build; assert exactly:

  | build | windows/cuda12 | windows/cuda13 | windows/rocm | linux/rocm |
  |---|---|---|---|---|
  | `b9993` | `…cuda-12.4…` + `cudart…12.4…` | `…cuda-13.3…` + `cudart…13.3…` | `…win-hip-radeon-x64.zip` | `…ubuntu-rocm-7.2…` |
  | `b10437` | 12.4 | 13.3 | `…win-rocm-7.14-x64.zip` | **`resolved: False`** |
  | `b10964` | 12.4 | 13.3 | `…win-rocm-10.0-x64.zip` | `…ubuntu-rocm-10.0…` |
  | `b11056` | 12.4 | **`…cuda-13.4-x64.zip` + `cudart…13.4-x64.zip`** | `…win-rocm-10.0-x64.zip` | `…ubuntu-rocm-10.0…` |

  and in every build: `windows/vulkan`, `macos/metal`, `linux/vulkan` resolve to their one
  name; the docker row is `resolved: None`; at `b11056` windows/cuda13 must **not** pick the
  `arm64` file.
- `test_resolve_leaves_a_hand_edited_url_alone` — a row whose `asset_url` is a mirror →
  `resolved: None`, URLs unchanged.
- `test_resolve_refuses_an_asset_without_its_runtime` — drop `cudart…13.3…` from a copy of the
  `b10964` list → windows/cuda13 is `resolved: False`.
- `tests/test_lifecycle.py` — `test_resolve_build_assets_marks_this_machines_row`,
  `test_resolve_build_assets_reports_a_fetch_error` (`release_assets_fn` raises → `error` set,
  no exception), `test_resolve_build_assets_rejects_a_non_build_tag` (the fetch is never
  called).
- JustWrite, new `src/components/engineUpdatePlan.test.js` (the precedent for unit-testing kit
  modules from an app: `src/components/classMembership.test.js` imports
  `@delebash/llm-ui/classTunes.js`). Import from
  `@delebash/llm-ui/common/services/engineUrl.js`. Cases: `planBinaries` prefers a resolved
  row; substitutes an unresolved one; substitutes everything when `plan` is `null`;
  `shouldRollback` is false while installing, false when `status.build === target`, true
  otherwise.

**2.7 Acceptance**

1. All gates green, **including the JV renderer gate** (kit UI changed).
2. Real resolver — start JV headless on `:8741` with the real data dir, then:
   ```bash
   curl -s "http://127.0.0.1:8741/v1/llm-runner/engine/resolve-assets?build=b10964" | python -m json.tool
   ```
   Paste it. `selected` must be `windows/cuda12`, `resolved: true`; the windows/rocm row must
   show `win-rocm-10.0`. Repeat with `build=b10437`: linux/rocm must be `resolved: false`.
   Kill `:8741` by port.
3. The refusal and the rollback are covered by the unit tests. *Not run on this box* (it is
   NVIDIA): an AMD machine's update. Say so.

**2.8 Docs** — with Slice 3 (the button is not visible again until then).

---

### SLICE 3 — the update check follows the stable channel

**Only after Slices 1 and 2 are committed.**

**3.1 `llm_runner/runner/binary.py` — a strict `build_num`**

```python
def build_num(tag: str) -> int:
    """Numeric part of a llama.cpp BUILD tag ("b9929" → 9929); -1 for anything else — the
    stable tags ("v0.4.1") included, which the old digit-strip read as 41 and a future
    "v1.10.500" would read as 110500, i.e. "newer than every build"."""
    m = re.fullmatch(r"b(\d+)", str(tag or "").strip())
    return int(m.group(1)) if m else -1
```

Add `import re` to `binary.py` if absent. Sole production caller: `lifecycle.update_check`.

**3.2 `llm_runner/runner/lifecycle.py` — the fetch**

Replace `_fetch_latest_llamacpp_tag`'s body; keep the name as a thin wrapper:

```python
_GH_RELEASES = "https://api.github.com/repos/ggml-org/llama.cpp/releases"
_GH_HEADERS = {"User-Agent": "just-llm-runner"}
_BUILD_TAG = re.compile(r"b\d+")


def _fetch_latest_llamacpp_release() -> tuple[str, str]:
    """(build tag, stable label) of upstream's latest STABLE release. Since 2026-08-21
    llama.cpp publishes semver releases ("v0.4.1") and flags every `bNNNN` build a
    prerelease; a stable release carries ONE asset, `nightly-tag.txt`, naming the build its
    binaries live on. Upstream: vX.Y.Z = "recommended for downstream distribution". Order:
    a bare bNNNN tag (the old scheme) → nightly-tag.txt → the "Nightly build" link in the
    notes. None of those → raises, and `update_check` reports it as an error."""
    r = requests.get(f"{_GH_RELEASES}/latest", headers=_GH_HEADERS, timeout=15)
    r.raise_for_status()
    rel = r.json()
    tag = str(rel.get("tag_name") or "").strip()
    if _BUILD_TAG.fullmatch(tag):
        return tag, ""
    for a in rel.get("assets") or []:
        if a.get("name") == "nightly-tag.txt" and a.get("browser_download_url"):
            t = requests.get(a["browser_download_url"], headers=_GH_HEADERS, timeout=15)
            t.raise_for_status()
            build = t.text.strip()
            if _BUILD_TAG.fullmatch(build):
                return build, tag
    m = re.search(r"/releases/tag/(b\d+)", str(rel.get("body") or ""))
    if m:
        return m.group(1), tag
    raise ValueError(f"the latest llama.cpp release ({tag or 'untagged'}) names no build")


def _fetch_latest_llamacpp_tag() -> str:
    return _fetch_latest_llamacpp_release()[0]
```

- `RunnerService.__init__`: the default becomes
  `self._latest_build_fn = latest_build_fn or _fetch_latest_llamacpp_release`. Injected test
  doubles return a plain `str`; the method accepts both.
- `update_check`:
  ```python
  res = self._latest_build_fn()
  latest, stable = res if isinstance(res, tuple) else (res, "")
  ...
  return {"current": current, "latest": latest, "latestStable": stable,
          "updateAvailable": build_num(latest) > 0 and build_num(latest) > build_num(current),
          "error": ""}
  ```
  and add `"latestStable": ""` to the error-path dict. Extend the docstring: the check follows
  upstream's stable channel.

**3.3 Kit UI**

- `ui/src/components/LuEngineUpdateButton.vue` — the tooltip only:
  ```
  :title="`Update the engine to ${updateInfo?.latest}${updateInfo?.latestStable ? ` — llama.cpp ${updateInfo.latestStable.replace(/^v/, '')}, a stable release` : ''} (you have ${updateInfo?.current}) — the old build folder is removed after the new one installs`"
  ```
  The label stays `Update to {{ updateInfo?.latest }}`. This text is in no app's translation
  feed (grep 2026-09-19), so there is no i18n work.
- `ui/src/composables/useEngine.js` — widen the `updateInfo` shape comment to include
  `latestStable`.

**3.4 Tests** (`tests/test_lifecycle.py`, beside the five `test_update_check_*`)

The five existing tests set `svc._latest_build_fn` to a function returning a plain `str` and
assert **single keys** (`out["updateAvailable"]`, `out["latest"]`, `out["error"]`) — never the
whole dict (checked 2026-09-19). So the new `latestStable` key and the tuple-or-str handling
leave them green untouched.

- `test_update_check_follows_the_stable_channel` — `latest_build_fn=lambda: ("b10964", "v0.4.1")`,
  disk `b10437` → `updateAvailable True`, `latest == "b10964"`, `latestStable == "v0.4.1"`.
- `test_update_check_never_offers_a_non_build_tag` — `latest_build_fn=lambda: "v0.4.1"` →
  `updateAvailable False`; and `lambda: "v1.10.500"` → `False`. (Today's bug and its latent
  twin, pinned.)
- `test_fetch_latest_release_reads_nightly_tag` — monkeypatch `requests.get` in
  `lifecycle`: `/latest` → `{"tag_name": "v0.4.1", "assets": [{"name": "nightly-tag.txt",
  "browser_download_url": "https://x/nt"}], "body": ""}`; `https://x/nt` → text `"b10964\n"` →
  `("b10964", "v0.4.1")`.
- `test_fetch_latest_release_falls_back_to_the_notes_link` — no assets, body contains
  `[b10964](https://github.com/ggml-org/llama.cpp/releases/tag/b10964)`.
- `test_fetch_latest_release_accepts_the_old_scheme` — `tag_name "b10549"` → `("b10549", "")`,
  one request only.
- `test_fetch_latest_release_raises_when_no_build_is_named`.
- `tests/test_binary.py` — `test_build_num_is_strict`: `"b9929"→9929`, `" b10437 "→10437`,
  `"v0.4.1"→-1`, `"v1.10.500"→-1`, `""→-1`, `None→-1`, `"b12x"→-1`. Then confirm the
  `build_num(...) + 30` tests still pass untouched.

**3.5 Acceptance**

1. All gates green, including the JV renderer gate.
2. The §3.2 reproduction, re-run — paste it:
   ```bash
   ../justwrite-app/.venv/Scripts/python.exe -c "from llm_runner.runner.lifecycle import _fetch_latest_llamacpp_release as f; print(f())"
   ```
   Expected today: `('b10964', 'v0.4.1')` (or whatever the newest stable is — record it).
3. JV headless on `:8741` (real data dir):
   `curl -s http://127.0.0.1:8741/v1/llm-runner/engine/update-check` →
   `"current":"b10437"`, `"latest":"b10964"`, `"updateAvailable":true`, `"latestStable":"v0.4.1"`.
   Kill `:8741` by port.
4. **Do not click Update here.** That is Slice 4's box test.

**3.6 Docs** (Slices 2 + 3 together — this is the user-visible change)

- JustWrite `docs/models.md` — the passage that lists **Install engine / Update / Uninstall**
  (search for *"**Update**\nand **Uninstall** once installed"*). Add, in that paragraph's voice:
  - Update appears when llama.cpp publishes a newer **stable** release, and installs the build
    that release names;
  - before the new engine replaces yours, the app checks that it starts **and** that it accepts
    the settings the app launches it with; if it fails either check, your current engine is
    kept and the update says why;
  - if the newer build has no download for your graphics card type, the update tells you and
    changes nothing.
- JustVoice — find the user-facing home first (`docs/ai-features.md` already mentions *Engine
  binaries*); add the same three points there. If there is genuinely no passage about the
  local engine's Install/Update/Uninstall row, say so in the report instead of inventing one.
- docgen — read `docs/ai-providers.md` and its `docs/whats-new.md`; same rule.
- `docs/whats-new.md`: JV's open `v0.1.0` section gets a bullet —
  *"**The engine's Update button is back.** It had stopped appearing because llama.cpp changed
  how it labels releases; it now follows their stable releases, checks a new engine before
  swapping it in, and works again on AMD cards."* JustWrite: R14.
- Kit `docs/dev/serving-design.md` — a short "Engine updates" subsection: the stable channel,
  `nightly-tag.txt`, the resolver, the two install-time checks, the UI rollback. Point here.
- Kit `README.md` — the Linux+NVIDIA sentence near "pinned build (upstream ships rolling tags
  only)" stays true for this plan. Leave it.

---

### SLICE 4 — move the pin to `b10964`, on the box test

**Only after Slices 1–3 are committed, and only if §5 passes.**

**4.1 `llm_runner/runner/config.py`**

- `DEFAULT_PINNED_BUILD = "b10964"`.
- `DEFAULT_BINARIES`, two names (verified against the `b10964` list in §3.4):
  - windows/rocm: `llama-{DEFAULT_PINNED_BUILD}-bin-win-rocm-10.0-x64.zip`
  - linux/rocm: `llama-{DEFAULT_PINNED_BUILD}-bin-ubuntu-rocm-10.0-x64.tar.gz`
  - every other row's name is unchanged at `b10964` — **re-verify all seven against the live
    release before editing** (`gh api repos/ggml-org/llama.cpp/releases/tags/b10964 --jq '.assets[].name'`),
    exactly as the block comment there demands.
- Rewrite the two comments that are now false: *"The cudart-* companion is unversioned (same
  CUDA runtime across builds)"* → it is unversioned **by build** on Windows but tied to the
  asset's CUDA version, and on Linux it is build-tagged; and the `(linux/cuda has no prebuilt
  archive — docker-only …)` note gains *"— true through b10964; upstream ships
  `ubuntu-cuda-*` tarballs from b10969 (tracked: `docs/llama-cpp-watch.md`)"*.

**4.2 Every other hard-coded mention** — the grep (2026-09-19), kit + apps, source and tests:

```
13 llm_runner/runner/config.py          the pin + the rows (4.1)
 4 llm_runner/runner/process.py         history in comments/docstrings — leave, unless a sentence claims b9993 IS the pin
 2 llm_runner/runner/lifecycle.py       same
 1 llm_runner/runner/gguf.py            same
 1 llm_runner/runner/fit.py             same
 2 tests/test_runner_config_store.py    read each: a test of the DEFAULT moves with it; a literal example stays
 1 tests/test_runner.py                 same
 1 tests/test_llm_api.py                same
 1 tests/test_binary.py                 same
 1 JustVioce/server/justvoice/engines/manager.py   read it — it may be a comment
```

Re-run the grep yourself first — never trust this table over the tree:
`grep -rn "b9993\|hip-radeon\|rocm-7\.2" --include=*.py --include=*.js --include=*.vue --include=*.json <each repo's source + tests>`.

**4.3 The ledger's pin-bump checklist** (`docs/llama-cpp-watch.md`, "Review checklist")

- Placement rules: already re-verified at `b10964` (§3.8). Still to do at the bump, because it
  needs the binary: the vram-truth plan's **Step 0b** — predicted vs engine model-MiB < 1 % on
  one MoE and one dense model, via `llama-fit-params -fitp on`
  (`docs/plans/2026-09-19-vram-truth-exact-bytes-units-offload.md` §10.2 has the method). Also
  re-read the tied-head `TENSOR_DUPLICATED` idiom in `src/models/gemma4.cpp` at `b10964`.
- `docs/dev/serving-design.md` says to **re-run the T5 probe at every pin bump**. Already
  known (2026-09-19): at `b10437` and `b11056` the router keeps `meta.progress`
  (`{stages, current, value}`) and broadcasts it on **`GET /models/sse`** as a `status_change`
  event, but `GET /models` still omits it. Record that under T5; building it is not this plan.

**4.4 Docs.** Ledger "Current state" → the new pin, the date, what was verified. JV
`docs/whats-new.md`: *"New installs get a current llama.cpp engine (0.4.1)."* Nothing else is
user-visible.

---

## 5. The box test — acceptance for Slice 4 (the user's real app, real data)

This is the **first real use** of Slices 1–3. It is the test.

**Before**
1. App **closed**. Record the on-disk build (`…/ai-cache/llamacpp/` should hold `b10437`).
2. Start the app (or ask the user to). Load the flagship `gemma-4-26b-a4b-qat` with its MTP
   draft.
3. Measure three times, record `tokensPerSec`:
   `curl -s -X POST "http://127.0.0.1:<app port>/v1/llm-runner/measure?max_tokens=128&model_id=gemma-4-26b-a4b-qat"`
   (find the port in the app's log; do not assume one).

**The update**
4. In the app: Settings → the Built-in provider → **Update to b10964**. Watch it finish.
5. Pass conditions, each pasted into §9:
   - `…/ai-cache/llamacpp/` now holds `b10964` and **not** `b10437`;
   - `GET /v1/ai/engine-config` → `pinnedBuild: "b10964"`, and the windows/cuda12 row's URLs
     name `llama-b10964-bin-win-cuda-12.4-x64.zip` + `cudart-llama-bin-win-cuda-12.4-x64.zip`;
   - the app's server log shows no `flag check` error.

**After**
6. Load the flagship again. Newest `ai-runtime/logs/router-*.log` must show
   `--load-mode none` in the argv block, **no** `DEPRECATED` line, **no**
   `invalid argument`, **no** `not recognized in preset`, and the MTP draft loading
   (`"stages":["text_model","spec_model"]`).
7. Measure three times again. **R11:** `median(after) ≥ 0.97 × median(before)`.
8. Load one **dense** model (mlock-only → `load-mode = mmap+mlock` in `models.ini`) and the
   **embedding** model. Both reach `running`.
9. `scripts/check-structured-output.py` against the new engine → exit 0.
10. One real structured call: JustWrite's entity sweep on any chapter, or — if that cannot be
    driven — say it was not run.
11. The vram-truth Step 0b check (§4.3).

**If step 4 fails or step 7 misses R11:** stop. The kit's checks should have kept `b10437` —
confirm that on disk first. Do **not** move the pin. Report the numbers and the log lines.
Slices 0–3 are unaffected and stay committed.

**If the update leaves the engine unusable:** that is the failure this plan exists to prevent.
Do not repair it by hand before capturing: the directory listing, `engine-config`, the install
log lines, and the router log. Then tell the user.

---

## 6. Blast radius — pasted greps (2026-09-19)

| Change | Every caller / producer / consumer |
|---|---|
| `build_num` becomes strict | production: `lifecycle.py:1128` (`update_check`) — the **only** one. tests: `test_binary.py:349,364,380` · `test_lifecycle.py:2067,2086,3006,3056,3083` (all pass `bNNNN` tags) |
| update check (fetch + `update_check`) | `lifecycle.py:363,365,454,487,1106-1128` · `api.py:567-569` · `ui/src/composables/useEngine.js:203-293` · `ui/src/components/LuEngineUpdateButton.vue:12-25` · `LuRunnerEngine.vue:35,281` · `ui/src/views/AiModelsArea.vue:45,48,752,758` · `tests/test_lifecycle.py:2975-3069`. No app code — grep of `JustVioce/{src,server}` and `justwrite-app/{src,server}` found none |
| `applyBuildToUrl` (kept; joined by `planBinaries`) | `ui/src/common/services/engineUrl.js:9` · `LuRunnerBinaries.vue:16,41,45,46` (**untouched**, R13) · `useEngine.js:17,269,274,275` |
| loading flags | emitters: `runner/process.py` (8 hits) · `runner/lifecycle.py` (11: `bool_fields`, `_strip_inert_mlock`, the fingerprint list, the cpu-band guard) · seeds: `llm/seed.py` (5) · `llm/db.py` (3) · `runner/schema.py` (2) · `runner/api.py` (1) · `ui/src/components/LuModelCatalog.vue` (1) · `justwrite-app/server/justwrite_server/seed_presets.py` (2) · tests: `test_lifecycle.py` (20) · `test_realrouter_smoke.py` (13) · `test_runner.py` (12) · `test_knob_catalog.py` (6) · `test_switch_resolve.py` (5) · `test_switch_presets.py` (2) · `test_model_tunes.py` (2). **Only `process.py`'s renderer and its tests change** — every other hit is the kit's own `mlock` / `no_mmap` switch name, which R2 keeps |
| `_emit_ini` | 4 call sites, all in `lifecycle.py` (`_load_via_router` ×1, `_router_load_with_backoff` ×3); `emit_models_ini` has 1 (`_emit_ini`) |
| `acquire_binary` gains a keyword | production: `lifecycle._run_install` ×3. tests inject `lambda *a, **k` (`test_lifecycle.py:146,2100`) — a new keyword cannot break them |
| response-format flattening removed | `openai_compat.py:165,177,201,261` · `tests/test_plane2_params.py:151-157`. Data that depends on it: `feature_prompts.json_schema` — 1 row in the real JW DB, 0 in JV |
| exceptions already living on these paths | `_strip_inert_mlock` (Windows pair) — kept · QC-25 "current = on-disk build" — kept · the `{…}` placeholder guard in `acquire_binary._fetch` — kept · `source == "docker"` rows never auto-selected — kept, and the resolver skips them |

---

## 7. NOT in this plan — recorded so nobody re-researches

Each is a separate decision needing its own go. The facts are verified unless marked.

- **The Engine-binaries panel's hand-typed pin** (`LuRunnerBinaries.vue::_resolveRowsToPin`)
  keeps substituting the tag on every keystroke. A power user typing a build gets a 404 on a
  renamed row — a safe failure. A "resolve from the release" action would call §4 Slice 2's
  endpoint. Not designed.
- **User-typed raw flags.** `extra_flags` and custom switch rows pass verbatim. A hand-typed
  `--no-mmap` breaks on a new engine; the install probe cannot see it (it is per-model data).
- **A fallback spawn onto a different build.** `_spawn_router_with_fallback` chains across
  installed variants. If two *build* dirs coexist (a sweep that could not delete) and the
  fallback lands on the other one, the `.ini` was rendered for the first. Rare; not handled.
- **Real load progress (tracked as T5).** Unblocked: `GET /models/sse` carries
  `{stages, current, value}` at `b10437`+. Needs a design for consuming SSE inside the load
  thread and its cancel interplay. *Not checked:* whether `b9993` emits it.
- **Linux NVIDIA CUDA builds.** From `b10969`: `llama-<b>-bin-ubuntu-cuda-12.8-x64.tar.gz` plus
  a build-tagged `cudart-llama-<b>-bin-ubuntu-cuda-12.8-x64.tar.gz`. Waits for the next stable.
  It retires the docker seam row.
- **Ternary Bonsai / Q2_0.** CUDA Q2_0 merged 2026-07-30 (#25707), first build `b10192`; the
  installed engine has it; the user already has `Ternary-Bonsai-27B-Q2_g64.gguf` cached. The
  ledger's own next step is a Lab A/B against the Gemma 26B. It cannot join the catalog until
  the pin is ≥ `b10192`.
- **Exact bytes for built-in-MTP rows.** Engines ≥ `b10212` (#26296) skip a model's MTP tensors
  unless `--spec-type draft-mtp` is on; our tensor-table reader always counts them. Two catalog
  rows: `qwen3.6-27b` (65 blocks) and `glm-4.5-air` (47). Safe direction (overstates).
  *Magnitude not measured.* Also: llama.cpp only supports MTP for GLM-4.5-Air from `b10603`
  (#26534), while our catalog flags it `mtp: 1`.
- **`--n-cpu-ffn`** (`b10645`, #26622) — the dense-model analogue of `--n-cpu-moe`. A candidate
  for a measured spike on a dense model that does not fit.
- **The machine-wide llama.cpp config file** (`b10398`, #26118): every llama.cpp program reads
  `%PROGRAMDATA%\llama.cpp\config.ini` and `%APPDATA%\llama.cpp\config.ini` (Linux/macOS:
  `/etc/llama.cpp/config.ini`, `~/.config/llama.cpp/config.ini`) at the lowest precedence.
  **No opt-out exists** (source, `b10437` and `b11056`). Absent on the user's box. On someone
  else's machine an `api-key` line there would 401 every request we make.
- **`--log-jsonl`** (`b10823`) and the **`/metrics` speculative-decoding counters** (`b10282`).
- **Release attestation** (`b10502`, #25933) — upstream now signs release artifacts; we verify
  no hash on the engine download today.
- **JustVoice: TTS inside llama.cpp.** `llama-tts` runs Qwen3-TTS (**Base / clone only**, ten
  languages, `--tts-speaker-file`) from `b10270` and Pocket-TTS from `b10369`. CLI only — no
  server endpoint at `b11056`. Upstream names Chatterbox as a future target. A watch item.
- **Slot-aware KV** — parked in `docs/dev/TASKS.md` today. Nothing upstream changes it; its two
  source lines are identical at `b10964` and `b11056` (§3.8).

**Checked and found not to affect us:** the Windows router log-colour bug (#28747 — the user's
log has 0 ANSI escapes and all 31 state lines handled) · the CUB argsort corruption (#28389 —
GPU-side sampling only, which we never enable) · the BF16 fallback (#28846 — AMD only) ·
`preserve_reasoning` on by default (#28174 — we never send reasoning text back in history) ·
the KV PRs (#27392 DeepSeek/DFlash, #26180 MiniMax, #27496/#28849 only when context is
auto-sized — we always pass `--ctx-size`) · the default-port notice (we always pass `--port`)
· lazy tensor loading (#27794 — `auto` only lazies tensors > 4 GiB, and needs mmap).

---

## 8. Known gaps — STOP and ask rather than choose

1. **R14** — where JustWrite's what's-new note goes.
2. If step 1.0 shows `test_mlock_parity_router_vs_standalone` **passing** on `b10437`, then
   §3.3's reading of `--mlock` is wrong somewhere. Stop; do not build the mapping on it.
3. If any value in `probe_argvs` is rejected by the real `b10437` exe (step 1.9).
4. If `b10964`'s live asset list no longer matches §3.4 (upstream can re-upload).
5. If a newer stable than `v0.4.1` exists when Slice 4 is reached: the plan verified
   **`b10964`** only. A different build needs §3.3's flag table, §3.4's names and §3.8's bad
   ranges re-checked first. Ask.
6. Anything a user would see that this plan does not word.

---

## 9. Execution record — the executor fills this in

One block per step. Command, what it printed (pasted, not paraphrased), what it means.
Failed and skipped steps are recorded as such.

**EXECUTED 2026-09-19** on the user's *"go do it all"*. Slices 0–3 BUILT, gated and
verified on the real engine. **Slice 4 REFUSED BY ITS OWN GATE** — the pin stays `b9993`.

### Slice 1 step 1.0 — baseline, before any edit
`JW_REALROUTER=1 JUSTWRITE_DATA_DIR=…/justwrite-app/…/data pytest -m realrouter -n 0`
→ **2 failed, 6 passed** (175 s). Failures: `test_switch_change_reflected_on_reload`,
`test_stop_stays_stopped` — **pre-existing**, unrelated to this plan (a re-load's ephemeral
ctx, and the stop tombstone); identical before and after every change here. Not
investigated, not touched. `test_mlock_parity_router_vs_standalone` **PASSED**, which the
plan had predicted would fail → gap 2, resolved below.

### Slice 1 step 1.0b — the load-mode measurement (new; resolves gap 2)
The engine prints its EFFECTIVE mode at `-lv 4`. On the real b10437, 821 MB model, `-ngl 0`:
`(none)`→`mmap` · `--mlock`→**`mlock`** · `--no-mmap`→`none` · **`--mlock --no-mmap`
(our order)→`none`** · `--no-mmap --mlock`→`mlock` · `--load-mode mlock`→`mlock` ·
`mmap+mlock`→`mmap+mlock` · `none`→`none` · `auto`→`mmap`. **No `VirtualLock` line in any
case.** So §3.3 was right on every point, and the parity test passes only because it
asserts the ABSENCE of a warning — it never proves a lock. The table is now in §3.3.

### Slice 0 — structured output: BUILT
- `openai_compat._adapt_response_format` DELETED with both call sites; `prompts.py`
  docstring corrected; `tests/test_plane2_params.py` pin replaced with an on-the-wire test
  for BOTH provider types + `assert not hasattr(…, "_adapt_response_format")`.
- New `scripts/check-structured-output.py` (+ `--all-stored`).
- **Real engine, b10437, CPU only:** flat `{type:json_schema,schema:S}` **enforced=False**
  (keys `Humidity, Precipitation, Sunrise, …`) · nested **enforced=True** (`zzq_code,
  zzq_word`) · `{type:json_object,schema:S}` enforced=True. Every stored schema in the real
  DBs converted: `justwrite.db :: entitySweep ok` (1 of 1; JustVoice has none). **exit 0.**
- Deviation: the new test failed in the FULL suite while passing alone — `local-llamacpp`
  resolves its base URL from a module-global another test wires to "". Fixed in the test
  (save/set/restore around the call) so it cannot depend on suite order.

### Slice 1 — flags by build + the install-time probe: BUILT
- `process.py`: `LOAD_MODE_MIN_BUILD = 10145`, `load_mode_value`, `probe_argvs`,
  `engine_build=` on `overrides_to_pairs` / `emit_models_ini` / `compose_flags`.
- `binary.py`: `_verify_exe_accepts_flags`, called between `_verify_exe_launches` and
  `_swap_into_place`; `acquire_binary(… probe_argvs=None)`.
- `lifecycle.py`: `_engine_build_of`, `_emit_ini(…, server_exe=)` at all 4 sites (the
  `_active_server_exe` trap pinned by a test), `_run_install` passes the probes to all 3
  acquires.
- **Real b10437:** every `probe_argvs("b10437")` and `probe_argvs("b9993")` list → rc=0.
- **Real b10964 (the proof this exists):** `probe_argvs("b9993")` → **rc=1 `error: invalid
  argument: --mlock`**, `--no-mmap`, `--mlock`; `probe_argvs("b10964")` → all rc=0; and
  `_verify_exe_accepts_flags` REFUSED the build: *"does not accept a launch flag this app
  uses (error: invalid argument: --mlock) — the installed engine was left in place"*.
  Without Slice 1, clicking Update to b10964 installs an engine that rejects every load.
- Real-router smoke re-run: same 2 pre-existing failures, both mlock cases pass under the
  new spelling (the smoke is now build-aware).
- Deviation: the plan claimed every `acquire_binary` test double tolerated a new keyword.
  FOUR did not (3 × `spy(...)`, 1 × `fake_acquire(...)` with explicit signatures) — widened.

### Slice 2 — download names from the release's asset list: BUILT
- `binary.py`: `ASSET_PATTERNS`, `_fill`, `_version_key`, `resolve_release_assets`.
- `lifecycle.py`: `_fetch_llamacpp_release_assets`, `release_assets_fn=` DI,
  `resolve_build_assets`. `api.py`: `GET /v1/llm-runner/engine/resolve-assets`.
- UI: `engineUrl.js` gains `planBinaries` + `shouldRollback`; `useEngine.js` refuses before
  writing when this box's row is absent, records `pendingUpdate`, and rolls the pin back
  from BOTH terminal paths (the poll's, and a fast failure that never reaches the poll).
- Tests: 4 real asset lists as a fixture (`tests/fixtures/llamacpp_release_assets.json`),
  parametrised over all four builds; hand-edited URL untouched; missing cudart refused;
  highest version wins. JW `src/components/engineUpdatePlan.test.js` (11 cases).
- **Live against real GitHub** (JV headless on :8741, real data dir):
  `resolve-assets?build=b10964` → selected `windows/cuda12 resolved:true`, windows/rocm →
  `…win-rocm-10.0-x64.zip`, linux/rocm → `…ubuntu-rocm-10.0…`, docker row `resolved:null`;
  `build=b10437` → `linux/rocm resolved:false "no download for linux/rocm at b10437"`.

### Slice 3 — the stable channel: BUILT
- `binary.build_num` STRICT; `lifecycle._fetch_latest_llamacpp_release` (build tag, stable
  label) with the bare-tag → nightly-tag.txt → notes-link order; `update_check` gains
  `latestStable` and can never offer a non-build tag; tooltip names the stable release.
- **Live:** `_fetch_latest_llamacpp_release()` → `('b10964', 'v0.4.1')`; through the real
  server, `GET /engine/update-check` →
  `{"current":"b9993","latest":"b10964","latestStable":"v0.4.1","updateAvailable":true,"error":""}`.
  (`current` is b9993 there because the JV data dir holds no engine — the pin is the
  documented fallback; in the real app, which shares JW's cache, it reads b10437.)

### Slice 4 + the box test — **REFUSED: R11 FAILED. The pin was reverted to `b9993`.**
Method: b10964 was installed ALONGSIDE b10437 (`acquire_binary` never sweeps; only
`_run_install` does), so the working engine was never at risk. Flagship
`gemma-4-26b-a4b-qat` + its MTP draft, the app's exact argv from its own router log,
1 warm-up + 3 runs, then the order REVERSED and a no-draft control.

| | b10437 | b10964 | b11056 (head) |
|---|---|---|---|
| no draft | 37.19 | 37.02 | 38.11 |
| **+ MTP draft** | **45.11** | **35.36** | **36.73** |
| draft acceptance | **0.823** (mean len 2.65) | **0.481** (1.95) | — |
| drafted output == greedy output | **YES** | **NO** | **NO** |

- with draft **0.784** of b10437 · no draft **0.995** → the engine is fine; **MTP
  speculative decoding is the regression**. On b10964/b11056 the draft makes it SLOWER
  than no draft at all (35.36 < 37.02; 36.73 < 38.11).
- **Not just slow — not exact.** Speculative decoding must reproduce greedy output. On
  b10437 it does, byte for byte; on b10964 and b11056 it does not. b10964 and b11056
  produced IDENTICAL shas to each other (`4683af3bc3b2` drafted, `f2109c9e5e6f` greedy),
  so the behaviour is stable and unfixed at head.
- Caveat: the probe used the raw `/completion` endpoint with no chat template, so the text
  is poor on every build — NO claim is made about output quality. The exactness comparison
  is within a single build and stands. Cross-build greedy output also differs, which
  numerical/kernel changes can explain; not investigated.
- Suspects, from commit titles only, NOT bisected: #27621 "extend MoE fusion to specdec"
  (b10718) · #28630 "fix MTP context kv cache allocation" (b10907) · #28159/#28183
  gemma4-assistant (the draft here IS a Gemma4Assistant).
- Config reverted: `DEFAULT_PINNED_BUILD = "b9993"` and both AMD names back to b9993's
  (`win-hip-radeon`, `ubuntu-rocm-7.2`); the renaming history is kept in the comments.
- **Machine restored.** Both test builds deleted; `llamacpp/` holds only `b10437` (dated
  2026-08-15, pre-existing) + `logs`; `acquired_server_exe` resolves b10437; the exe still
  reports `build 10437`. ~2.2 GB returned. This mattered: with the pin absent from disk the
  resolver takes the NEWEST folder, so leaving them would have switched the app to b11056.

### The bisect (user: *"go bisect"*, same evening) — culprit found, and a BETTER pin exists
Signal = draft acceptance (bimodal 0.823 / 0.481, never ambiguous), one load per build,
each installed alone and deleted immediately. 8 probes over the 318 releases between the
known-good b10437 and the known-bad b10964:

`b10723 GOOD (47.64 tok/s)` · `b10736 GOOD` · `b10740 GOOD` · `b10749 GOOD` ·
**`b10750 GOOD`** │ **`b10751 BAD`** · `b10775 BAD` · `b10837 BAD`

**First bad build: `b10751` = `cuda: fuse MoE weighted expert reduction` (#25952, merged
2026-09-01).** Its own description: the MoE combine tail now "does weighting and ordered
expert reduction in one CUDA kernel". That reorders floating-point accumulation across
experts, so the target's logits move, the draft's argmax stops matching, acceptance halves
and the drafted output stops equalling greedy. CUDA-only, MoE-only — the flagship exactly.
(b10741–b10748 do not start at all, `0xC0000409` — the gemma4-assistant window broken by
#28159, fixed by #28183 in b10749; the bisect stepped past them.)

**b10750 validated as a pin candidate** — installed, measured, deleted:

| | b10437 (on disk) | **b10750** | b10964 |
|---|---|---|---|
| + MTP draft | 45.11 | **46.35 (1.028×)** | 35.36 |
| no draft | 37.19 | **38.10** | 37.02 |
| drafted == greedy | yes | **yes** | no |
| output sha | `58c64329a49a` | **`58c64329a49a`** — identical | differs |
| every platform row resolves | **no** (no Linux AMD) | **yes** | yes |

So b10750 gives the same answers as b10437, ~2.8 % faster, and unlike b10437 is a viable
DEFAULT pin. It carries #27621 (the specdec MoE fusion behind the gain), #27978, #24124
`--kv-unified-per-slot`, #26622 `--n-cpu-ffn` and the #28183 crash fix; it does NOT carry
the post-b10750 correctness fixes (#28475 mmid/mmf races, #27870 f16 FA barrier, #28389 CUB
argsort) or #27483's lower RAM peak. **Head re-measured after the bisect:** `b11057` (published 23:58, one commit past the
review — `chat : fix gemma4 required tool grammar` #29115) → acceptance **0.48062**,
36.00 tok/s (0.798 × b10437), NOT exact, drafted sha `4683af3bc3b2` identical to b10964 and
b11056. One regression, unchanged, unfixed at head.

**ADOPTED — `DEFAULT_PINNED_BUILD` moved b9993 → b10750** (user: *"go pin b10750"*), with
the two renamed AMD rows (`win-rocm-7.14`, `ubuntu-rocm-7.14`) re-verified against the live
release. The plan's original target b10964 stays rejected. Still open, recorded in the
tracker: the Update button follows the stable channel and will therefore offer b10964.
Superseded note — the pin move needs its own go (the
plan approved b10964, not b10750), and it collides with the stable channel: the newest
stable IS b10964, so a moved pin leaves the Update button offering a known-bad build.

### Observations recorded, not acted on
- **Both app DBs pin `b9993` while `b10437` is on disk** (installed 2026-08-15, the day it
  was published). So **Reinstall** today would fetch b9993 and the sweep would delete
  b10437 — a downgrade. Pre-existing, the QC-25 shape; `current` correctly reports disk.
- The two pre-existing real-router failures above.

### Gates (all after the revert unless noted)
kit **989 passed, 10 skipped** · ruff clean · `check-consumers` PASSED (38/74/26 imports) ·
`check-family` no violations · kit UI biome 125 files clean · JW **589** unit (+11) + 128
server + build · JV **67** unit + **741** server + ruff + build · docgen 3 unit + build ·
**JV renderer smoke: 17/17 views, zero JS errors** (real data dir, killed by port).

### Deviations from this plan, and why
1. Four `acquire_binary` test doubles had strict signatures (§6 said none did) — widened.
2. The Slice 0 test needed the local-runner URL resolver pinned; a module global leaks
   between tests. Fixed in the test, not in production code.
3. `--embeddings` (plural) in `probe_argvs`, matching what the `.ini` emits.
4. Added `--all-stored` to `scripts/check-structured-output.py` so the claim "every real
   schema converts" is measured rather than assumed.
5. Slice 4's box test was run by installing the candidate ALONGSIDE the working engine
   rather than replacing it (plan §5 assumed an in-app Update click). Same evidence, no
   risk, and it let b11056 be tested too.
6. b11056 was tested as well — not in the plan, but it turns the finding from "the stable
   release is broken" into "it is still broken at head", which changes the recommendation.
