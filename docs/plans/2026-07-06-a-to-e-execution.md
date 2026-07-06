# A–E execution batch — the ledger's open build/research items, JustVoice excluded (2026-07-06)

> **MANDATE (user, 2026-07-06): "do a-e do not do just voice go".** This doc is the LIVE tracker for executing
> every open item in sections A, B, C, and E of the twice-verified outstanding master plan
> (`2026-07-06-outstanding-master-plan.md`). Section D is already empty (D1 + D3 decided 2026-07-06, D2 refuted
> earlier); section F (JustVoice) is EXCLUDED by the user's instruction — no JustVoice repo edits in this batch;
> where an item's scope would naturally touch JV (C3 queue adoption, C4 audit findings inside JV), the JV half is
> RECORDED under F1's umbrella and not built. Section G is the user's own box checklist — untouchable from the
> container by nature.
>
> **Method per item (the standing discipline):** ground in code line-by-line + web for any upstream fact → write
> the item's design into this doc BEFORE implementing → implement → verify by running (ruff + pytest; build:vite +
> headless smoke + probes for renderer work) → independent rules-checker on the diff → commit + push immediately →
> update this tracker + the master-plan ledger line. Every item = its own commit(s); nothing rides along
> uncommitted.
>
> **Execution order (quick wins first, then the engine block, then the bigger shared-stack items):**
> B1 → B2 → E1 → A2 → A1 → A3 → A4 → C1 → E2 → C3 → C4 → C2 → E3.
> Rationale: B1/B2/E1 are tiny and clear fast with early pushes; A2 is the small engine item and warms the
> hardware/binary code paths for A1/A3/A4; C1 has a prior plan to honor (#77 "plan ready"); E2 (vitest) lands
> before C3 so new kit/JW logic can get unit coverage; C4 (the audit) runs AFTER the build items so it audits the
> end state, not a moving target; C2 (research) is bounded last among the C's; E3 is the out-of-AI-scope footnote
> and closes the batch.
>
> **Baseline at batch start:** runner `dbca11d` · JW `39449ee` · JV `453462c` (untouched hereafter), all equal to
> origin, working trees clean. Runner gate green at baseline: `ruff check llm_runner/ tests/` clean + `python -m
> pytest` **324 passed**. Environments verified live: `llm_runner` and `justwrite_server` both importable, JW
> `node_modules` present.

---

## Batch interruption record (2026-07-06) — stopped, then RESUMED (cross-session confusion, not a real stop)

Mid-batch the user typed "stop" and then "this is an old session dont code anything" — work halted
immediately after B1 + B2 were implemented and fully verified, with NOTHING committed or pushed. The
user then clarified from Claude Desktop: *"sorry i was using claude desktop and i guess the session was
not in sync with this one, please continue."* A fresh fetch confirmed origin had NOT moved on any repo
(no competing session had pushed), so the batch RESUMED here: B1 + B2 commit as verified, then the
execution order continues from E1. Recorded so the stop/resume in the session log reads correctly.

## LIVE PROGRESS

- **B1 — engine knobs visible before install: ✅ SHIPPED + VERIFIED (2026-07-06).** Design: the
  `v-if="installed"` at `ui/src/components/LuRunnerEngine.vue:173` gated BOTH halves of the resident
  block; the correct split is by NATURE of the content — the two knobs (`modelsMax`,
  `sleepIdleSeconds`) are PERSISTED CONFIG (engine-config PUT, valid before any install; seeding
  verified safe pre-install because `GET /v1/llm-runner/resident` works router-down and always returns
  the knob values — `runner/api.py:204-215`), while the "Loaded models" list + VRAM budget line are
  RUNTIME state that is meaningless without an installed engine. So the outer div now always renders;
  a `<template v-if="installed">` wraps ONLY the head + list/empty half; the knobs + Save + error line
  sit below it unconditionally. The installed-state layout is pixel-identical to the user-approved 4a
  look (no header/copy changes); the not-installed state gains exactly the two self-captioned knobs
  under the existing divider. Verified: `npm run build:vite` clean · full headless smoke PASSED (zero
  JS errors) · `justwrite-app/scripts/resident-panel-probe.mjs` EXTENDED with a second scenario
  (engine/status mocked `installed:false` → asserts the runtime half is hidden, the knobs render and
  seed 3/300 from /resident, and Save still PUTs ONLY `{modelsMax, sleepIdleSeconds}`) — 13/13 checks
  PASS. The probe also gained the same BENIGN console filter the sibling probes already use (the
  container proxy resets the external Google-Fonts fetch; that console error is environmental, not an
  app error — the sibling precedent is `catalog-type-probe.mjs` + `headless-smoke.mjs`).
- **B2 — auto-composed model description at Add time: ✅ SHIPPED + VERIFIED (2026-07-06).** Design: at
  the end of a successful `inspectLink()` in `ui/src/components/LuModelCatalog.vue`, a new
  `composedDescription()` builds the plain-language description in the field's OWN placeholder
  register ("fast 9B for quick chat and drafts" → short " · "-joined facts): params (`e.totalParams`,
  else the MoE `sizeLabel` like "128x2.6B") + kind (embedding model / mixture-of-experts model /
  model) + `<n>k context` from `trainedCtx` + "MTP draft for faster generation" when `mtp OR
  mtpDraftFile` (the same OR-gate as the resolver) + the quant with a "(QAT)" suffix and the file size
  taken from the LISTING's matching quant row. It writes ONLY into an EMPTY field (`!e.description?.
  trim()`) — a hand-typed or previously saved description is never clobbered and the field stays fully
  editable. Verified LIVE against the user's real repo (`unsloth/gemma-4-26B-A4B-it-qat-GGUF`):
  `catalog-type-probe.mjs` extended with checks (e)+(f) — the composed value was exactly
  "128x2.6B mixture-of-experts model · 256k context · MTP draft for faster generation · UD-Q4_K_XL
  (QAT) · 13 GB", and a pre-filled "MY OWN WORDS" survived a full re-read untouched. Probe PASS, zero
  page errors. (Probe-timing note, so it isn't re-learned: the quant/draft checks land with the fast
  LISTING call, but the description lands with the slower header INSPECT — the probe must wait for the
  Read-from-link button to re-enable (`UiButton` `loading` sets `disabled`, `UiButton.vue:37`) before
  reading the field.)
- **E1 — three stale `OpenAICompatClient` comments: ✅ SHIPPED + VERIFIED (2026-07-06).** Precision
  correction found while grounding (the ledger's E1 was slightly imprecise): a repo-wide grep shows only
  TWO files actually name `OpenAICompatClient` (`components/ModelPicker.vue:7`, `services/modelMeta.js:2`);
  the third (`services/embedApi.js:2`) instead referenced the retired gateway ROUTE ("the runner-stack
  replacement for the old /v1/llm/{id}/embeddings proxy") — historical, not a class reference. All three
  were cleaned: ModelPicker's comment now describes the REAL current source (the shared per-provider cache
  `composables/useModelList.js` → the shared `/v1/llm-providers/{id}/models` endpoint returning plain ids,
  with quant badges parsed from the id by `modelMeta.parseQuant`); modelMeta's comment now names its REAL
  current consumers (ModelPicker via parseQuant/entryLabel + the ai store via getModelTier/TIERS — the old
  "Speaker Lab's ModelPicker and Settings → AI providers' Combobox" phrasing was doubly stale, verified by
  grep: no Speaker Lab, no Combobox importer); embedApi's comment simply drops the dead-route aside.
  Comment-only diff (attested trivial); verified `npm run build:vite` clean.
- **A2 — Intel Arc → Vulkan routing: ✅ SHIPPED + VERIFIED (2026-07-06; design below, implemented as
  designed).** `detect()`'s non-NVIDIA branch now routes `vulkan` when the scan finds an Intel row whose
  name matches the ARC-discrete pattern (`\barc\b|dg1|dg2|battlemage`, case-insensitive); iGPU-only Intel
  boxes deliberately stay CPU (recorded scope = Arc discrete). `binary.py` needed zero changes — the
  vulkan preference row already existed. Verified: `tests/test_hardware.py` grew from 5 to 12 tests
  (Arc→vulkan · Iris-Xe→CPU · AMD-beats-Arc precedence · legacy empty-scan fallback all covered), full
  suite 324 → **331 passed**, ruff clean, and a LIVE container run (`_pci_gpus_linux()` on real sysfs →
  `[]`, `detect()` → cpu-only, machine_key `cpu|4c|15g`) proved the scan never raises on a GPU-less box.
- **A1 — AMD + Intel VRAM detection: ✅ SHIPPED + VERIFIED (2026-07-06; design below, implemented as
  designed).** `hw.gpus` now gets REAL rows on AMD/Intel boxes: Linux via the kernel sysfs scan
  (`_pci_gpus_linux` — vendor from `device/vendor`, AMD VRAM byte-exact from amdgpu
  `mem_info_vram_total`, names from one `lspci -mm` pass matched by PCI address with generic fallback;
  Intel VRAM honestly None, no stable ABI) and Windows via the display-class registry
  (`_registry_gpus_windows` — `DriverDesc` + 64-bit `qwMemorySize` through stdlib `winreg`, REG_QWORD and
  REG_BINARY both decoded by the pure `_qw_to_mb`; AdapterRAM's uint32 4-GB cap never touched). So Fit
  (`max_vram_mb`) and the per-machine tune key (`machine_key`) now work on AMD boxes + Windows-Intel
  boxes. NVIDIA fast-path byte-identical (scan only runs when no NVIDIA GPU); empty scan falls back to
  the legacy `_amd_gpu_present()` name-sniff (runtime-only) so no environment detects less than before.
  Verified: the 7 new tests above (incl. the symlinked-device lspci name-match + qw decode), 331 total,
  ruff clean, live GPU-less sanity. The Windows registry walk itself is desktop-gated → added to the
  G-section box checks (G6, master plan).

### A2 + A1 design (written before implementation; they share the detection layer)

**Grounding, our side (read in full):** `runner/hardware.py` (all 191 lines) — `_nvidia_gpus()` is the only
`GpuInfo` constructor; `_amd_gpu_present()` returns a bare bool (lspci name-sniff on Linux, HIP_PATH/wmic on
Windows); `detect()` (:169-191) branches nvidia → amd → macos and NEVER creates a GPU row for AMD/Intel — so on
an AMD/Intel box `hw.gpus` is empty, `max_vram_mb()` is 0 (every Fit reads unknown), and `machine_key()`
degrades to the `cpu|cores|ram` form. `runner/binary.py` (all 165 lines) — `_gpu_preference()` maps only
runtimes `detect()` sets (metal → cudaNN → rocm → vulkan → cpu), so once `detect()` sets `vulkan` for Intel,
selection needs NO binary.py change (the vulkan asset rows already exist in the engine config — the
"AMD/Intel" wording at binary.py:46 finally becomes true). Test style precedent: `tests/test_hardware.py`
monkeypatches the module-level probes (`hw._nvidia_gpus`, `hw._amd_gpu_present`) — the new probes follow it.

**Grounding, platform facts (web-verified this session, per the upstream hard rule):**
- AMD Linux VRAM: the amdgpu kernel driver exposes `mem_info_vram_total` (total VRAM in BYTES) under
  `/sys/class/drm/card*/device/` — kernel-documented sysfs ABI
  (https://www.kernel.org/doc/html/v5.18/gpu/amdgpu/driver-misc.html). Vendor identification for a card comes
  from the standard PCI sysfs attribute `device/vendor` (`0x1002` AMD · `0x8086` Intel · `0x10de` NVIDIA).
- Windows VRAM (vendor-agnostic): `Win32_VideoController.AdapterRAM` is uint32 and caps at 4 GB
  (https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-videocontroller;
  https://forums.developer.nvidia.com/t/how-to-query-adapter-ram-for-cards-with-more-than-4-gb-c/69955), so the
  correct source is the display-class registry key
  `HKLM\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\00NN` with `DriverDesc`
  (the adapter name) + `HardwareInformation.qwMemorySize` (64-bit byte count) — the widely-documented
  workaround (https://github.com/glpi-project/glpi-agent/issues/199;
  https://www.tenforums.com/graphic-cards/164242-can-anyone-make-script-show-correct-ram-video-card.html).
  Read via Python's stdlib `winreg` — no subprocess, no wmic (deprecated on Win11).
- Intel Linux VRAM: there is NO stable merged sysfs ABI for discrete-Intel local memory — `lmem_total_bytes`
  exists only as an unmerged RFC (https://www.mail-archive.com/intel-gfx@lists.freedesktop.org/msg360558.html),
  and the xe driver's sysfs layout differs from i915 with no equivalent documented file
  (https://wiki.archlinux.org/title/Intel_graphics). HONEST behavior: Linux Intel rows carry `vram_mb=None`
  (the row now EXISTS, so vendor/name/routing work; Fit stays "unknown" rather than fabricated).

**Design:**
1. `_pci_gpus_linux()` — enumerate `/sys/class/drm/cardN` (top-level cards only, `^card\d+$`; connectors like
   `card0-DP-1` and `renderD*` skipped), read `device/vendor`; keep `0x1002`→AMD and `0x8086`→Intel rows
   (NVIDIA is skipped — `nvidia-smi` remains its single authority, same as today where no nvidia-smi = no
   NVIDIA row). AMD rows read `device/mem_info_vram_total` → MiB; Intel rows get `vram_mb=None` (RFC-only ABI,
   above). Names come from one `lspci -mm` pass matched by the card's PCI address (the `device` symlink's
   basename, e.g. `0000:03:00.0`); if lspci is absent/unmatched the row falls back to "AMD GPU"/"Intel GPU".
   The sysfs root is a parameter (default `/sys/class/drm`) so tests drive it with a tmp tree.
2. `_registry_gpus_windows()` — `winreg` enumerate the display-class key's `00NN` subkeys; each row's name =
   `DriverDesc`, `vram_mb` = `HardwareInformation.qwMemorySize` (accept REG_QWORD int or 8-byte REG_BINARY
   little-endian; absent → None); vendor by name (amd/radeon → AMD, intel → Intel, nvidia/geforce → skipped,
   same authority rule). Never raises; returns [] off-Windows or on any registry error. The value-decode is a
   pure helper (`_qw_to_mb`) unit-tested cross-platform; the registry walk itself is desktop-gated
   (stated honestly — G-section box check).
3. `detect()` restructure (behavior-preserving on NVIDIA/macOS boxes): the NVIDIA fast-path is UNCHANGED
   (scan runs only when no NVIDIA GPU was found — zero new cost and zero row/UI churn on NVIDIA boxes, and the
   ledger's target is exactly the AMD/Intel-only box). In the non-NVIDIA branch: run the platform scan; AMD
   rows present → `rocm` if `_rocm_available()` else `vulkan` if available (exact same preference as today);
   else Intel rows present AND at least one is DISCRETE ARC (name matches `\barc\b|dg1|dg2|battlemage`,
   case-insensitive — Windows `DriverDesc` is "Intel(R) Arc(TM) …", Linux lspci names carry "Arc"/"DG2") →
   `vulkan` if available (THE A2 ITEM — scoped to Arc per the ledger's own wording; iGPU-only Intel boxes keep
   today's CPU behavior, deliberately conservative, widen later if the user asks). The scanned rows land in
   `hw.gpus`, which is THE A1 ITEM: `max_vram_mb()` now feeds Fit real numbers on AMD boxes (+ Windows Intel),
   and `machine_key()` produces the proper `gpu|vram|cores|ram` key on those boxes (correct per Plan B's D2
   design — no production tunes exist yet, so no key migration concern). If the scan returns NOTHING, the old
   `_amd_gpu_present()` name-sniff still runs as the last-resort fallback (runtime-only, no row) — today's
   worst case is preserved exactly, never regressed.
4. `binary.py`: NO change needed (grounded above).

**Tests (new, in test_hardware.py style):** fake-sysfs tree → AMD row with correct MiB + Intel row with None +
connector/render nodes skipped + NVIDIA vendor skipped; `_qw_to_mb` decodes QWORD-int and 8-byte binary;
detect() monkeypatched matrix — AMD scan row → rocm-else-vulkan; Arc row → vulkan; Intel iGPU row (Iris Xe
name) → NO gpu runtime; AMD+Arc together → AMD branch wins (elif chain, unchanged precedence); empty scan +
legacy `_amd_gpu_present()` True → today's runtime-only behavior; NVIDIA fast-path untouched (existing tests
keep passing); machine_key over a scanned AMD row.
- **A3 — spawn-time backend retry chain: ✅ SHIPPED + VERIFIED (2026-07-06; design below including the
  mid-implementation runtimes amendment, implemented as designed).** What shipped: per-variant binary
  layout (`variant_dir` `<build>/<gpu>/`; legacy build-root installs still found, attributed ONLY to the
  selected asset — the user's existing RTX 2070 install keeps working untouched);
  `acquire_binary(gpu=…)` variant override; `acquired_server_exes` (installed builds in preference
  order); the engine install plants the safety net (selected + cpu, + vulkan when the pick is rocm —
  extras BEST-EFFORT, never fail the install); `_spawn_router_with_fallback` walks installed candidates
  on `RunnerStartError`, remembers the PROVEN exe (`_active_server_exe`), and aggregates every backend's
  reason (each already carrying exit code + log tail from the P1 spawn diagnostics) when all fail;
  bounces/backoffs reuse the proven exe so a broken preferred build is never re-tried mid-session; the
  AMD detect arm now records BOTH rocm+vulkan capability facts (selection unchanged — see the amendment).
  Verified: ruff clean · 9 new tests (4 binary layout/probe + 3 chain incl. the bounce-reuses-proven-exe
  and all-fail-aggregation paths + 2 install-extras incl. best-effort failure) · full suite 331 → **340
  passed** · all 77 pre-existing lifecycle/binary tests untouched and green (back-compat held). The
  chain's REAL rescue on a broken-CUDA box is a your-box check (G3 companion — the next failing load
  self-reports AND, after a re-install plants the cpu fallback, auto-rescues to CPU).

### A3 design (written before implementation)

**Grounding (read this session):** the origin intent is recorded in
`2026-07-01-engine-binaries-download-fix.md:178-181` — *"a spawn-fail → next-candidate loop in
`lifecycle._run_load` would harden the tail"* (ROCm-first/Vulkan-fallback exists only at DETECTION time).
The current spawn path, read line-by-line: `_run_load` probes the engine (`_acquired_exe`, hard-require,
`lifecycle.py:754-760` — decision A from the 2026-07-02 portable-root plan: a LOAD never installs) →
`_load_via_router` (`:991-1000`) emits the `.ini` and calls `_spawn_router` (`:956-968`, via the
INJECTABLE `self._start_router`, constructor `:317`) → a binary that cannot LAUNCH (bad driver/runtime —
the A3 scenario, e.g. the user's RTX 2070 case) raises `RunnerStartError` (`process.py:43`) out of the
spawn, through `_run_load`'s except → error state. `_router_load_with_backoff` (`:1027-1070`) only
handles CHILD-load failures (the CUDA-OOM ngl shed) — it never switches binaries. So the chain's correct
insertion point is the INITIAL router spawn, not the backoff.

**The two load-bearing discoveries that shape the design:**
1. **Today only ONE build variant can exist on disk.** `acquire_binary` unpacks every asset into the
   SHARED `binary_dir(cache_root, pinned_build)` (`binary.py:132`) — a second variant would overwrite the
   first, and `acquired_server_exe` (`:88-94`) rglobs that one dir. A chain with nothing to chain TO is
   pointless — so the layout gains PER-VARIANT SUBDIRS: new installs unpack into
   `<build>/<gpu>/` (`variant_dir`), while every probe checks the variant dir FIRST and then the LEGACY
   build root — attributed ONLY to the selected/best asset — so the user's EXISTING install (their RTX
   2070 box has one; the cudart evidence) keeps working untouched, exactly as today.
2. **The chain must respect decision A (a load NEVER downloads an engine).** So fallback candidates are
   only builds ALREADY on disk — which means the INSTALL step is what plants the safety net:
   `_run_install` now installs the SELECTED build + the CPU build (the universal last resort, a
   tens-of-MB zip next to the multi-hundred-MB cudart companion), and ADDITIONALLY the Vulkan build when
   the selected one is ROCm (giving the ledger's literal ROCm → Vulkan → CPU chain on AMD boxes). The
   extra builds are BEST-EFFORT: a failed extra download logs + never fails the install (the selected
   build failing stays fatal). Force-reinstall already rmtree's the whole build root — correct for all
   variants, unchanged.

**Design:**
- `binary.py`: `variant_dir(cache_root, build, gpu)`; `acquire_binary(..., gpu: str | None = None)` — an
  explicit variant override (None = today's best-pick), unpacking into its variant dir;
  `acquired_server_exe` probes variant-then-legacy-root for the selected asset (back-compat); NEW
  `acquired_server_exes(cache_root, config, hardware) -> list[(gpu_key, exe)]` — every INSTALLED build in
  `_gpu_preference` order (the legacy root counted only for the selected asset, never double-attributed).
- `lifecycle.py`: new injectable `acquired_exes` (default the new probe, tests inject);
  `_spawn_router_with_fallback(server_exe, config)` — walk the installed candidates starting at the
  preferred exe; per-candidate `RunnerStartError` → log + next; success remembers
  `self._active_server_exe` (the PROVEN binary) and logs a WARNING when it isn't the preferred one; all
  candidates failing raises ONE `RunnerStartError` aggregating each backend's reason (each already
  carries its own log tail + exit code from the P1 spawn-diagnostics work). `_load_via_router` uses the
  fallback spawn on a fresh router, and hands the REMEMBERED proven exe (not the preferred one) to
  `_bounce_router`/`_router_load_with_backoff` once a fallback was taken — otherwise a later `.ini`-change
  bounce would knock a WORKING vulkan router just to re-fail on the broken cuda build, killing every
  resident. Bounce/backoff failures do NOT re-enter the chain (the binary already proved it launches —
  a failure there is a different disease and must surface, not be masked by a backend switch).
- Engine status is UNCHANGED (installed = the selected build present — the extras are a bonus, their
  absence never flips the panel).
- **Mid-implementation design amendment (recorded 2026-07-06, found by walking the chain end-to-end):**
  `detect()`'s AMD arm used to set `rocm` OR `vulkan` EXCLUSIVELY — but `_gpu_preference` is
  runtime-gated, so on a ROCm box the chain would never list an installed Vulkan build (the literal
  rocm→vulkan→cpu chain could not exist). Fix: the AMD arm now records BOTH capability facts
  (`rocm` and `vulkan`, each when actually present) — `runtimes` is a statement of what the box can do,
  not a selection. SELECTION is untouched: `_gpu_preference` orders rocm before vulkan, so the chosen
  build on a ROCm box is identical to before — the recorded 2026-07-01 "prefer ROCm/HIP when present,
  else Vulkan" decision is a PREFERENCE and stays honored; only the fallback chain gains the truthful
  vulkan candidate. (`test_detect_amd_rocm_first` updates from "vulkan absent" to "selection still
  prefers rocm" — the old assertion pinned exclusivity, which was never the decision's meaning.)

**Tests:** binary — `acquired_server_exes` ordering + variant dirs + legacy-root single-attribution +
`acquire_binary(gpu=…)` unpacking into the variant dir; lifecycle — chain success on the second candidate
(injected `start_router` fails exe A with `RunnerStartError`, succeeds exe B; assert router up, the
remembered exe is B, and a subsequent ini-change bounce uses B), all-candidates-fail aggregates per-backend
reasons into the error state, single-candidate behavior identical to today; install — `_run_install` call
list = selected(+vulkan when rocm)+cpu with extras best-effort (a failing extra leaves status installed).
- **A4 — Linux CUDA engine install (docker route): DESIGNED (below) — with a load-bearing upstream
  discovery that RE-SCOPES it; implementing the re-scoped form; the scope change is SURFACED to the user
  in the batch report (rule: never silently override a recorded item).**

### A4 design (written before implementation)

**Grounding — our side:** the linux/cuda12 config row is `source: "docker"` with
`image: ghcr.io/ggml-org/llama.cpp:server-cuda12-<build>` (`config.py:81-84`); `acquire_binary` refuses
docker sources with `NotImplementedError` (`binary.py`, corroborated by the test asserting the raise).
TODAY'S REAL FAILURE: a Linux + NVIDIA box selects that docker row (preference `cuda12` first) → install
raises → the box gets NO engine at all — not even the CPU build — because the selected build gates the
install. The user's own boxes are Windows; this path serves future Linux users.

**Grounding — upstream (web-verified live this session, registry probes through the proxy):**
1. The official docs (`docs/docker.md`, master) list SERVER images `ghcr.io/ggml-org/llama.cpp:server-cuda`
   and `:server-cuda13` (+ vulkan/intel/musa/rocm variants), `--gpus all`, nvidia-container-toolkit
   required, entrypoint = llama-server (args append).
2. ghcr manifest probes (anonymous pull token): the ROLLING tags exist (`server-cuda` → 200,
   `server-cuda13` → 200); the per-build tag scheme that USED to exist (`server-cuda-b4721`,
   `server-cuda-b4726`, `server-cuda-b4729` — visible in the registry's own tags/list) was DISCONTINUED:
   every probe across the pinned build's range 404s (`server-cuda-b9600`/`-b9643`/`-b9644`/`-b9645`/
   `-b9650`/`-b9700`, plus `server-cuda12-b9644` and `server-cuda13-b9644`). **There is NO pin-faithful
   b9644 container image, and our config's `server-cuda12-b9644` tag NEVER existed** (the 2026-07-01
   config verification covered release ASSETS, not ghcr tags — this row's tag was never checked until
   now).

**The consequence (why the item re-scopes):** the b9644 PIN is a central recorded decision — every
switch/preset/tune fact is grounded against that exact build (the `.ini` parser semantics were verified
at b9644 source). Wiring the docker route on a ROLLING tag would hand Linux-CUDA users an engine that
silently tracks master — the exact drift this project's pin exists to prevent. Pinning by DIGEST is the
correct container mechanism, but no b9644 digest is discoverable today (the rolling tag points at
current master; the b9644-era digest is not enumerable without its deleted tag). So the pin-faithful
container path is IMPOSSIBLE for the current pin, not merely unbuilt.

**Re-scoped A4 (what ships now):**
1. `detect()` also records the `vulkan` capability fact on Linux NVIDIA boxes (same facts-not-selection
   principle as the AMD amendment) so the preference chain there reads cuda → vulkan → cpu.
2. `select_binary` skips assets whose source is not installable today (`source == "docker"`) — a Linux +
   NVIDIA box now selects the REAL, PINNED `linux/vulkan` b9644 archive (Vulkan runs on NVIDIA drivers)
   with cpu below it, instead of dead-ending. Windows/macOS selection is untouched (all their rows are
   github assets).
3. The docker arm's `NotImplementedError` message becomes the truthful current state (no pin-faithful
   image published for this build; Linux NVIDIA uses the Vulkan build; the container route returns when
   a digest-pinned image can be captured).
4. The config row STAYS as the future seam but its fabricated tag is corrected to the rolling name with
   a comment carrying this evidence (an editable-panel user can see what it would be).
5. **Recorded procedure for the NEXT pin bump (the future A4-full):** at bump time, while the rolling
   tag still points at the new pin's build, resolve + record `server-cuda@sha256:<digest>` into the
   config row — THEN the container spawn path (docker run --rm --gpus all --network host, same-path
   volume mount of the cache root so `.ini` paths stay valid, argv-prefix spawn through the same
   start_router seam) becomes buildable pin-faithfully. That build happens then, not now.

**Tests:** linux+NVIDIA(+vulkan loader) detect fact; selection lands on `linux/vulkan` (docker row
skipped) and on `cpu` when no vulkan loader; the docker raise still fires with the new message when a
docker asset is FORCED (gpu override); Windows selection unchanged.
- **C1 — json_schema / GBNF structured output:** NOT STARTED.
- **E2 — vitest harness:** NOT STARTED.
- **C3 — shared AI task queue → kit:** NOT STARTED.
- **C4 — everything-LLM-shared audit:** NOT STARTED.
- **C2 — measured/benchmark re-grounding research:** NOT STARTED.
- **E3 — ODT import: lists:** NOT STARTED.

Per-item design + evidence + verification is appended below as each item starts; the master-plan ledger line is
updated as each item ships.
