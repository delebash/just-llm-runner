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

## ⛔⛔ STOPPING POINT (2026-07-06, pre-compact — user: "we need to compact soon so find a good stopping point") — READ THIS FIRST ON RESUME

**State at the stop: 9 of 13 items SHIPPED + VERIFIED + PUSHED; every repo clean and equal to origin.**
Heads at the stop: runner **`6e52f49`** · justwrite-app **`7a42b11`** · JustVoice **`453462c`** (untouched, as
mandated). Shipped this batch, in order: **B1** (knobs before install) · **B2** (auto-composed description) ·
**E1** (stale-comment cleanup) · **A1** (AMD/Intel GPU rows + VRAM) · **A2** (Arc→Vulkan) · **A3** (spawn
fallback chain + per-variant layout + install plants fallbacks) · **A4** (RESOLVED-RESCOPED — Linux+NVIDIA
now gets the pinned Vulkan build; the docker container path is impossible pin-faithfully today, seam +
digest-capture procedure recorded; the re-scope is SURFACED to the user in the batch report) · **C1**
(json_schema structured output end-to-end + two found-and-fixed #18 bugs: the anthropic response_format leak
and the prompts-PUT wipe) · **E2** (vitest harness, 20 tests). Every shipped item has a full-detail entry
below, a rules-checker verdict (every one ultimately PASS; A4 took one FAIL→fix→re-verify round), and its
own pushed commit(s): runner `2a22bda`(B1+B2) `5ff4a05`(A1+A2) `f69c2b2`(A3) `297e861`(A4) `6e52f49`(C1) ·
JW `7606ec6`(probes) `999138c`(E1) `7e8176d`(C1 seed) `7a42b11`(E2).

**REMAINING (4 of 13), for the post-compact session, in this order:**
> *(Post-compact update, 2026-07-06: item 1 below — C3 — is now ✅ SHIPPED; see its LIVE PROGRESS entry
> and the grounded amendments section. Remaining: C4 → C2 → E3, i.e. 10 of 13 shipped.)*
1. **C3 — shared AI task queue → kit.** FULLY DESIGNED below (§"C3 design" — it IS the recorded Decision 22,
   steps 1–3; step 4 = JV adoption stays excluded → F1). Scoped this session: move JW's five files
   (`stores/aiTasks.js` 231 ln · `components/AiTaskStrip.vue` 151 · `services/aiFeature.js` 150 ·
   `components/AiStatusPanel.vue` 410 · `components/AiStatusButton.vue` 69) into the kit, adapt transport to
   the kit client (`request`/`requestStream`/`llmUiUrl` — `ui/src/client.js:28/79/24`), sweep the measured
   **47 consumer files**, DELETE the JW locals (no shims). Start here on resume.
2. **C4 — the everything-LLM-shared audit** (task #32/#92): runs after C3 so it audits the end state; T6
   strict-diff per unit; JV findings RECORDED under F1, not fixed.
3. **C2 — benchmark re-grounding research** (task #28): web-grounded published-benchmark pass over the
   quality ranks + optionally a bench-harness the user runs on-box; no local GPU measuring in-container.
4. **E3 — ODT import lists** (task #108): GROUNDED this session — `services/import/odt.js` DOM-parses
   content.xml and today just counts+warns on `text:list` (:112-114, the "N lists dropped" warning at
   :127-129). The fix shape: a recursive `renderList()` — `<text:list>`→`<text:list-item>`→`<text:p>`(+nested
   lists) emitted as `<ul>/<ol>` + `<li><p>…</p></li>` (TipTap-friendly); ordered-vs-bullet from the
   content.xml automatic styles (`text:list-style` containing `text:list-level-style-number` → `<ol>`, else
   `<ul>`); drop the warning arm. VERIFY question left open: vitest's node env has no DOMParser — either add
   jsdom + a per-file `@vitest-environment` pragma for a parseOdt unit test, or extend `scripts/book-smoke.mjs`
   (checked: it smokes the book BACKEND round-trip, it does NOT exercise the import pipeline today) — decide
   at implementation; the honest minimum is a unit test with a real ODT-shaped fixture zip (jszip is a dep).

**Resume recipe (the standing drill):** fetch + compare + `--ff-only` pull all three repos (origin is the
truth) → re-read the global rules + the JW recap header + THIS section → continue at C3 (the batch mandate
"do a-e do not do just voice go" still stands; nothing else needs a new go). Dev-harness note: a stale dev DB
500s on the NEW `feature_prompts.json_schema` column — one-time `POST /v1/data/reset` (same drill as Plan B).

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
- **A4 — Linux CUDA engine install (docker route): ✅ SHIPPED IN THE RE-SCOPED FORM (2026-07-06; design
  + the upstream evidence below; the re-scope is SURFACED to the user in the batch report).** What
  shipped: `detect()` records the Vulkan capability fact on NVIDIA boxes with a loader (gpu-gated, same
  principle as the AMD arm); `select_binary` NEVER auto-selects `source="docker"` rows (with the full
  reasoning in its docstring), so a Linux+NVIDIA box now selects the REAL pinned `linux/vulkan` b9644
  archive (cpu below it) instead of dead-ending on `NotImplementedError`; the docker raise (reachable
  only by forcing `gpu=`) now tells the truthful pin story; the config row keeps the seam with the
  corrected ROLLING image name (`server-cuda` — the old `server-cuda12-<build>` tag NEVER existed) and
  the digest-capture procedure for the next pin bump written above it. The A3 install extras compose:
  Linux-NVIDIA installs vulkan+cpu, giving that box a real chain. Verified: ruff clean · rewritten
  `test_select_linux_cuda_never_picks_docker` + `test_acquire_docker_raises` (forced-variant, message
  match) + new `test_detect_nvidia_records_vulkan_fact` · full suite **341 passed**. The FULL container
  wiring is deliberately NOT built now — building it against a rolling tag would break the b9644 pin
  that grounds every switch/tune fact; it returns when a digest-pinned image is captured at a pin bump
  (procedure recorded in `config.py` + here).

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
- **C1 — json_schema / GBNF structured output: ✅ SHIPPED + VERIFIED (2026-07-06; design below,
  implemented as designed + two ADJACENT #18 bugs found-and-fixed while grounding).** What shipped:
  `json_schema` TEXT on `feature_prompts` (action grain; presets stay shape-free by design) → the row/
  wire/store/seed ride exactly like `json_mode`; `_response_format()` in `prompts.py` emits the
  OpenAI-standard NESTED `json_schema` form when the effective json_mode is on and the stored schema
  parses as a non-empty JSON object (invalid → warn + degrade to `json_object`, never a 500); adapter
  translations — the builtin runner (`local-llamacpp`) FLATTENS to the b9644-documented
  `{"type":"json_schema","schema":…}` in chat+stream, Ollama puts the schema OBJECT in `format`,
  Gemini sets `generationConfig.responseSchema` + the JSON mime, Anthropic now STRIPS
  `response_format` entirely (**found bug #1**: `_map_extra` passed unknown keys through, so #18's
  json_object leaked to an API with no such parameter); the shared `PromptLab.vue` gains the
  "JSON output" checkbox + the schema textarea (invalid JSON marks the box + blocks Save); JW seeds
  ONE real end-to-end example — `entitySweep`'s documented three-array shape as `_ENTITY_SCHEMA`.
  **Found bug #2 (the wipe):** the prompts PUT rebuilt the row from bare defaults, so a PromptLab
  text edit silently WIPED the seeded `json_mode`/`max_tokens`/`top_p`/`reasoning_effort` (and would
  have wiped schemas) — the PUT's Plane-2 fields are now PRESERVE-ON-OMIT (None = keep stored;
  PromptLab is the only writer, verified by grep). The think×JSON guardrail (think forced off under
  json_mode) covers the schema path unchanged. Verified: runner ruff + **350 pytest** (9 new: nested
  emission · invalid-degrade · inert-when-mode-off · think-off-with-schema · store round-trip ·
  anthropic strip · builtin-only flatten ·  ollama format=schema · gemini responseSchema) · JW server
  ruff + 77 pytest + the seeded schema validated at import · LIVE on :17495 after `/v1/data/reset`:
  GET `entitySweep` returns the seeded schema; PUT stores a schema; a text-only PUT (the pre-C1
  editor shape) PRESERVES it — the wipe proven dead · `build:vite` + full headless smoke zero JS
  errors. NOTE the runtime semantics (per `_effective_spec`): the MODE can come from the resolved
  preset (preset.jsonMode replaces the action's), while the SHAPE always comes from the action row —
  dataclasses.replace keeps `json_schema` through the overlay; mode-from-preset + shape-from-action
  is the intended split.

### C1 design (written before implementation)

**Recorded intent honored (the "plan ready" of task #77):** the 2026-06-28 MASTER-PLAN §8 —
*"llama.cpp takes both `grammar` (GBNF) and `json_schema`; cloud takes `response_format`. Our #18
`json_mode` is only the weak `json_object` form — upgrade to `json_schema`/`grammar` where the backend
supports it… Structured-output is a sampler-surface member"* — plus its CLI-matrix note that the schema
CONSTRAINS output but is NOT injected into the prompt (the prompt still describes the shape).

**Grounding — our side (read line-by-line):** `json_mode` rides the ACTION grain: `FeaturePromptRow`
(`prompts.py:41-63`) ↔ the `feature_prompts` table (`db.py` :381-region) ↔ the variant table
(`db.py` :361-region, action/name/is_active) ↔ the wire models `PromptOut`/`PromptUpdate` + `_out`
(`prompts.py:97-153`), and `FeaturePreset` + `FeatureSamplerParam` also carry the BOOLEAN (mode) —
`_plane2_extra` (`prompts.py:303-315`) emits `extra["response_format"] = {"type": "json_object"}`; the
openai-compat adapter merges `extra` verbatim into the body (`openai_compat.py:141`) and knows the
builtin runner as `provider_type == "local-llamacpp"` (`:112`); ollama maps response_format→`format`
(`ollama.py:78-80`), gemini maps it similarly (`gemini.py:117-119`); the anthropic adapter's
`_map_extra` (`anthropic.py:97-106`) passes UNKNOWN keys through — meaning today's `response_format`
LEAKS to an API that has no such parameter (a latent #18 gap on anthropic providers, found while
grounding; fixed here by stripping it there). The think×json interaction is already handled: think is
FORCED off under json_mode (`prompts.py:348/:375`) — the schema path rides the same gate.

**Grounding — upstream (web-verified):** llama-server at the PINNED b9644 documents `response_format`
accepting `{"type":"json_object"}`, `{"type":"json_object","schema":{…}}` and
`{"type":"json_schema","schema":{…}}` on the OpenAI-compat endpoint (tools/server README at the tag —
the FLAT `schema` key is the documented contract; the OpenAI-cloud NESTED
`json_schema:{name,schema,strict}` form is NOT documented there), with schemas converted internally to
grammar. So the emission is standard-nested from the dispatch, and the ADAPTER translates: builtin
(`local-llamacpp`) flattens to the pin-documented form; other openai-compat providers get the OpenAI
standard form untouched.

**Design (mirrors `json_mode`'s exact ride, ACTION grain only — presets/sampler-params keep only the
boolean mode; the SHAPE is feature-intrinsic, a preset must stay reusable across shapes):**
1. DB: `json_schema` TEXT ("" = none) on the `feature_prompts` + prompt-variant tables (the two
   action-grain json_mode carriers). Pre-production → drop-and-reseed via `/v1/data/reset`, no
   migration.
2. Row/wire: `FeaturePromptRow.json_schema: str = ""` + `PromptOut/PromptUpdate.jsonSchema` + `_out` +
   upsert + the JW store mappers.
3. `_plane2_extra`: when the effective json_mode is ON — schema present AND parses as a JSON object →
   `extra["response_format"] = {"type":"json_schema","json_schema":{"name":<action>,"schema":<obj>,
   "strict":true}}`; schema absent/invalid → today's `{"type":"json_object"}` (an invalid stored schema
   logs a warning and degrades, NEVER 500s a run).
4. Adapters: openai-compat — builtin(`local-llamacpp`) rewrites nested→flat
   (`{"type":"json_schema","schema":<obj>}`, the b9644-documented shape) in chat+stream; other
   openai-compat providers pass through. ollama — `format = <schema object>` when a schema rides
   (Ollama's structured outputs accept a schema in `format`), else `format="json"` as today. gemini —
   `responseSchema` + JSON mime when a schema rides, else today's json mapping. anthropic —
   `_map_extra` now STRIPS `response_format` entirely (no such API param; the prompt carries the shape;
   also fixes the latent #18 leak).
5. UI (SHIPPED in the kit `PromptLab.vue` — the ACTION editor; the design first named ConfigColumn, but that is the LAB per-run column, wrong grain — corrected at implementation): a "JSON schema
   (optional)" `UiTextarea` shown when jsonMode is on; invalid JSON marks `:invalid` and blocks save
   with the standard error line; empty stays empty (json_object mode). The Lab/compare surfaces
   inherit by running the action — no separate schema UI there.
6. Seed (JW): ONE real end-to-end example — the entity-extraction action's documented JSON shape
   seeded as its `json_schema` (the shape the prompt already describes), proving the whole path.
7. Tests: `_plane2_extra` nested emission + invalid-schema degrade; the builtin flatten; ollama/gemini
   schema mapping; anthropic strip; prompt API round-trip (PATCH jsonSchema → GET); think stays forced
   off with a schema. Live: `/v1/data/reset` → PATCH an action with a schema via curl → GET shows it →
   headless smoke + a probe assertion on the ConfigColumn schema box.
- **E2 — vitest harness: ✅ SHIPPED + VERIFIED (2026-07-06).** JW now has a JS unit harness: `vitest`
  (dev-dep, v4.1.9) + root `vitest.config.js` (node environment — the renderer gate REMAINS the
  Playwright headless smoke; this covers logic the smoke can't reach deterministically; aliases mirror
  `vite.config.js` for `@renderer` + the kit) + `npm run test:unit`. First REAL tests target exactly the
  ledger's named seam: `services/__tests__/embedApi.test.js` (11 tests over the lazy-P3 ensure cache —
  `_resetEnsureCache` the recorded seam; kit transport `vi.mock`ed; covers: cloud no-op · ensure-once
  caching · sleeping accepted · ok:false skips polling · load-failure message + self-heal re-ensure ·
  scalar→array + junk-row filtering · empty-input short-circuit · required-arg errors · REAL-failure
  drops the cache and the next call re-ensures · ABORT does NOT drop it) and
  `services/__tests__/modelMeta.test.js` (9 tests over parseQuant/entryLabel/getModelTier/TIERS).
  Verified: `npx vitest run` → **2 files, 20 tests, all passed** (288 ms). JW `CLAUDE.md`'s tooling
  paragraph gains the vitest line (docs ship with the harness).
- **C3 — shared AI task queue → kit: ✅ SHIPPED + VERIFIED (2026-07-06, post-compact; design + grounded
  amendments below, implemented as amended).** What shipped — kit side: the six files moved into their
  llm-layer homes — `ui/src/stores/aiTasks.js` (the Decision-22 store verbatim; `pushToast` now the
  kit-internal relative import), `ui/src/services/aiFeature.js` (CONSOLIDATED onto the kit client:
  `request` for `/v1/ai/run`, `requestStream` for `/v1/ai/stream` — the old inline SSE loop is gone, one
  SSE reader in the kit, exactly the plan-checker's T3 watch-item), `ui/src/services/aiErrors.js`
  (verbatim), and `ui/src/components/AiTaskStrip.vue` + `AiStatusPanel.vue` + `AiStatusButton.vue`
  (kit-relative imports per the recorded idiom; the fidelity fixes as recorded — the dead
  `:deep(.jw-btn--ghost)` rule now targets `.sts .ui-btn--ghost` so the Details-button accent tint is
  BACK, panel h2 → `var(--font-display, inherit)`, `--shadow-window`/`--font-mono` literal fallbacks,
  the JW-only `.t-eyebrow`/`.t-muted` spots became self-contained scoped styles, SPDX headers).
  `client.js`: `request()` + `requestStream()` gained optional `{signal}` and requestStream's usage
  return is null-until-a-done-frame (zero prior callers, re-verified pre-change). `index.js` exports the
  store + wrappers + `friendlyAiError` + the three components; kit `package.json` gains `pinia: ^3.0`
  (both hosts run `^3.0.4`, verified). Two copy generalizations recorded honestly: the strip's slot-doc
  comment and the panel's empty-state line had named app-specific features ("Start a critique,
  smart-cast, or any AI feature…" — smart-cast doesn't even exist in JW); kit copy is app-neutral
  ("Start any AI feature and you'll see it here with live status."). JW side: all 43 consumers swept
  (66 import lines rewritten to `@delebash/llm-ui`; duplicate kit-import lines merged to one per file
  across 25 files), the six locals DELETED with no shims, `CLAUDE.md` §AI-providers rewritten (aiFeature
  → the kit wrappers; the section's stale E1 "three stale comments" parenthetical — left behind when E1
  shipped — dropped too) + the kit list gains the queue bullet (incl. the host-owned-titlebar-chrome
  note), and the runner `README.md`'s stale "the shared Vue GUI will live here once built" line is
  rewritten to the present truth (the kit + its new public queue surface + peer deps). New unit
  coverage (the plan-checker's T5/T7 recommendation): `services/__tests__/aiFeature.test.js` — 8 tests
  driving the REAL kit modules through the source alias (subpath imports so the node env never parses
  .vue; toastBridge + global fetch mocked; fresh Pinia per test): usage NULL without a done frame ·
  zeros-object (truthy) on a countless done frame · real counts pass through · `(delta,
  accumulatedContent)` onDelta contract · task finish → history entry + completion toast · error frame
  → friendly wrap + error archived · non-stream happy path body/URL · HTTP 429 → the "Rate-limited"
  hint. VERIFIED: `npm run build:vite` clean (4.0s) · vitest **28/28** (the 20 E2 tests untouched) ·
  full headless smoke **PASSED, zero JS errors on every route** (the queue renders from the kit
  app-wide via TitleBar) · residual-reference grep **ZERO** old-path matches · Biome: exactly the 2
  pre-existing warnings (stash-compared against HEAD — untouched files embedApi.js/routingBackend.js) ·
  strict-diff proof: `git diff -U0` over the swept consumers shows **0 changed lines that are not
  import lines**. JV: untouched (mandate); it merely inherits the additive index.js exports and
  resolves `pinia` from its own node_modules; the JV adoption half (delete `renderTasks.js`/
  `TaskStrip.vue` fork, adopt the shared queue, add its own CLAUDE.md kit-note) is RECORDED under
  F1/F4 per Decision 22 step 4 — including the plan-checker's JV-doc suggestion, deliberately NOT done
  here. Plan-grain checker verdict was FAIL on T11 alone (consumer-facing docs) — resolved by the
  CLAUDE.md/README updates in this same series. Diff-grain checker verdict: **PASS, zero failures**
  (independent reads of every moved file + configs + consumers; behavior spot-checks held — usage
  null-until-done at `client.js:97/117`, the `(delta, content)` contract, abort passthrough at
  `aiErrors.js:48`, the cancel/fail double-path safety, all 8 icon names exist in the kit `Icon.vue`,
  and `.sts .ui-btn--ghost` targets a real `UiButton.vue` class; its one out-of-scope catch — the
  master-plan §E1 line still saying the comments "await a code-touching session" — fixed in this same
  commit; its noted non-fail coverage gap, the untested caller-signal→cancel bridge, is recorded here
  honestly: implemented at `aiFeature.js:35-38/72-75`, covered by build+smoke, unit test left to a
  future pass).

### C3 design (written before implementation — it IS the recorded Decision 22, executed steps 1–3)

**The recorded design (2026-06-28 MASTER-PLAN §Decision 22, read in full this session):** the AI
progress+queue is SHARED ("it's the same thing" — user, 2026-06-24): move JW's `stores/aiTasks.js`
(231 ln) + `components/AiTaskStrip.vue` (151) + `services/aiFeature.js` (150) into `@delebash/llm-ui`
(verbatim → adapt imports to the kit client), ALSO share `AiStatusPanel.vue` (410) +
`AiStatusButton.vue` (69); sweep JW's consumers (measured this session: **47 files** reference the
five); DELETE the JW locals (no re-export shims — RULE #8). Step (4) — JV deleting its
`renderTasks.js`/`TaskStrip.vue` copy-paste fork and adopting the shared system — is EXCLUDED by this
batch's no-JustVoice mandate and is exactly F1/F4 territory; recorded there, not silently dropped
(Decision 22 itself notes TTS-render tasks MAY stay JV-local if their shape genuinely diverges — that
call happens at F1 with JV in scope).

**Adaptation points (grounded):** the kit client already has `request`/`requestStream`/`llmUiUrl`
(`ui/src/client.js:28/79/24`) — `aiFeature.js`'s raw-fetch SSE streaming adapts onto the kit transport
per the decision's own note ("adapt JW's `serverUrl` → the kit's `llmUiUrl`/`requestStream`"); the
store stays a Pinia `defineStore` moved verbatim (both apps provide the active Pinia — the kit already
ships Pinia-consuming pieces); the components' JW-local imports (primitives, toasts) swap to their kit
equivalents, which all exist. New kit homes: `ui/src/stores/aiTasks.js` (or `common/` if the kit's
layout keeps stores there — follow the kit's existing store precedent), `ui/src/components/
AiTaskStrip.vue` + `AiStatusPanel.vue` + `AiStatusButton.vue`, `ui/src/common/services/aiFeature.js`
beside the other kit services. JW then imports everything from `@delebash/llm-ui`.

**Verify:** `build:vite` + full headless smoke (the strip/panel render on their routes) + the vitest
suite still green + a grep proving ZERO remaining `@renderer`-local references to the five moved
files + the E2 unit tests (embedApi) untouched. The 47-file sweep is mechanical import rewriting —
each file's diff is import-lines only.

### C3 grounded amendments (recorded 2026-07-06 post-compact, BEFORE implementation — every point
verified in code this session; the Decision-22 architecture itself is unchanged, these are the
implementation-grain findings the design's own "follow the kit's existing precedent" clause calls for)

1. **The consumer measurement is 49 files, not 47.** A repo-wide loose-name grep
   (`aiTasks|aiFeature|AiTaskStrip|AiStatusPanel|AiStatusButton|aiErrors|friendlyAiError`, excluding
   node_modules/dist) matches 49 files = the 6 source files themselves (the five + `aiErrors.js`,
   below) + **43 true consumer files**. The earlier "47" and a first narrow re-measure of 36 both
   missed that `services/analysis/*.js` import via the RELATIVE `"../aiFeature.js"` (no
   `services/` in the string) — the loose pattern is the operative sweep list; each consumer's diff
   stays import-lines only.
2. **`services/aiErrors.js` is a sixth moved file — a discovered hard dependency.**
   `aiFeature.js:15` imports `friendlyAiError` from it; a kit module cannot import from JW, and the
   kit has NO equivalent to converge onto (verified: `useProviderConnect.js` and the whole kit carry
   no provider-error-hint logic). It is pure LLM-domain error humanizing with zero JW-specific
   imports, so per the everything-LLM-shared principle (task #92) it moves to the kit as the one
   source; its 4 external JW consumers (`CritiqueModal.vue`, `rag/chat.js`, `rag/characterChat.js`,
   `rag/indexer.js`) join the sweep and the JW local is deleted like the other five.
3. **Layering correction — the design's proposed `common/services/aiFeature.js` home would break the
   kit's own rule.** `common/index.js:6` records "nothing here may import from ../ (the llm layer)",
   and aiFeature must import the llm-layer `client.js`. So the llm layer gains the two parallel dirs
   the common layer already models: **`ui/src/stores/aiTasks.js`** and **`ui/src/services/aiFeature.js`
   + `aiErrors.js`**; the three components land beside the other llm-layer components
   (`ui/src/components/Ai*.vue`). Kit-internal imports stay RELATIVE (the recorded kit precedent —
   ten components already import `../client.js` relatively); the public surface is `index.js`
   exports: the three components + `useAiTasksStore` + `runAiFeature`/`runAiFeatureStream` +
   `friendlyAiError`.
4. **Pinia correction: this is the kit's FIRST Pinia piece.** The design line "the kit already ships
   Pinia-consuming pieces" was wrong — a kit-wide grep finds zero `pinia` references today. The store
   still moves verbatim as a `defineStore` exactly as Decision 22 records (both hosts create Pinia
   before mount — JW `main.js:117`; the store function is only invoked at component/service runtime,
   never at module import time, so no boot-order hazard). `pinia` is added to the kit
   `package.json` peerDependencies for honesty (source-alias consumption resolves it from each
   host's node_modules; both hosts have it — JV's per-domain stores are the app standard).
5. **Transport adaptation, exactly scoped:** `client.js` `request()` gains an optional `signal`
   option and `requestStream(path, body, onDelta, { signal } = {})` gains signal support + its
   `usage` return switches to **null-until-a-done-frame** (was a zeros-object initialization).
   Contract-change safety verified: `requestStream` has ZERO callers today and is NOT exported from
   `index.js` (its first caller is the moved aiFeature); the null-vs-zeros distinction is
   load-bearing because `runAiFeatureStream` RETURNS `usage` to callers and `rag/chat.js:203`
   forwards it to the UI — the moved wrapper keeps JW's exact semantics (null when no done frame
   arrived; a zeros-object when a done frame arrives without counts). The wrapper accumulates
   `content` itself and forwards `(delta, content)` to both the task handle and the caller's
   `onDelta`, preserving the public aiFeature contract byte-for-byte.
6. **Kit-fidelity fixes riding the move (each restores intent or kit convention, none changes JW's
   rendered look):** (a) `AiTaskStrip.vue`'s closing style rule `:deep(.jw-btn--ghost)` is DEAD
   CSS twice over — the button family has been `ui-btn--*` since the 2026-06-24 convergence, and
   `:deep()` is a scoped-CSS feature inert in this non-scoped block — so the documented "tint the
   inline ghost Details button" intent has been silently broken in JW; the rule becomes
   `.sts .ui-btn--ghost { … }` (the tint comes back — the one visible pixel change, and it's the
   component's own recorded intent). (b) The panel h2's `--font-serif` becomes the kit heading
   convention `var(--font-display, inherit)` (kit precedent: AppModal/HelpDrawer/EmptyState;
   pixel-identical in JW where `tokens.css:72` maps `--font-display: var(--font-serif)`); the
   streaming-preview `pre` keeps serif via `var(--font-serif, Georgia, serif)` — legitimate in a
   kit file because the SHARED appearance engine itself owns that property (`appearance.js:246`).
   (c) `--shadow-window` has zero kit uses → gains a literal fallback per the kit's
   every-token-has-a-fallback idiom. (d) `.t-eyebrow`/`.t-muted` are JW `styles.css` utilities with
   zero kit uses → the two spots using them become self-contained scoped styles so the components
   render correctly in any host. (e) Moved files gain the kit's standard SPDX header.
7. **JV safety (F1 untouched):** all index.js changes are additive exports; JV resolves `pinia`
   from its own node_modules; JV's `renderTasks.js`/`TaskStrip.vue` fork stays as-is — its deletion
   + adoption is F1/F4 exactly as Decision 22 step 4 records.
- **C4 — everything-LLM-shared audit: IN PROGRESS (2026-07-06; design + unit list below, verdicts being
  filled).**

### C4 design (written before executing the verdicts — the T6 strict-diff method for this audit)

**The principle under audit (recorded, tasks #32/#92):** ALL LLM GUI + backend live in the shared stack
(`just-llm-runner` + `@delebash/llm-ui`); only feature SEEDS (and app feature code that merely CALLS the
stack) are per-app. Scope per the batch mandate: JW + kit + runner units get verdicts AND in-scope fixes;
JV units get verdicts RECORDED under F1, never edits. Audit unit = a file; verdict per unit is one of
**SHARED-OK** (lives in the stack, no app leak) · **APP-OK** (legitimately per-app: a seed, a thin host
mount, or app feature code calling the shared wrappers) · **VIOLATION** (LLM-stack logic/UI living
app-side, or app-specific logic inside the shared stack) — each with file:line evidence. Fix policy for
JW/kit violations found: small removals/redirects fix in-batch; anything C3-sized (a multi-file kit
promotion) gets filed as its own ledger item rather than half-done here.

**Enumeration method (run 2026-07-06, all four greps recorded):** (1) JW files with RAW `/v1/ai/` /
`/v1/llm-` endpoint strings (each must justify not riding a kit service) — 8 files, 2 of them the
transport-mocking unit tests; (2) kit files naming an app (`justwrite|justvoice|jw|jv`) — 16 files,
**every hit a comment/provenance note, zero logic leaks** (first-hit-per-file classification recorded in
the session log; e.g. `client.js:5` names the apps only to describe who configures the base URL);
(3) runner python naming an app — 29 files, **every hit a lift-provenance docstring or host-mount
example, zero app-coupled logic** (e.g. `runner/binary.py:5` "no app coupling"); (4) JV renderer LLM
surface (read-only) — the LLM-domain files among the broad kit-import matches: `services/llmBackend.js`,
`components/ProviderForm.vue`, `components/QuickSetup.vue`, `components/RecommendCard.vue`, plus the
feature callers (`SpeakerLabView.vue`, `GenerateView.vue`, `stores/api.js` LLM slices).

**The JW unit table to fill (LLM-domain units; broad `@delebash/llm-ui`-import matches that are mere
Ui-primitive consumers are NOT units — using the shared kit is the point, not a finding):**
| # | Unit | Suspicion going in |
|---|------|--------------------|
| 1 | `services/providerBackend.js` | provider CRUD vs the kit views' own provider CRUD — duplicate? |
| 2 | `services/routingBackend.js` | vs kit `common/composables/useRouting.js` — duplicate? |
| 3 | `services/embedApi.js` | generic embedding transport — kit-promotion candidate? |
| 4 | `services/modelMeta.js` | vs kit `useCatalogMeta`/`modelDefaults` AND runner `llm/tiers.py` (its own docstring: "Ported from JustWrite's modelMeta.js") — triple source? |
| 5 | `composables/useModelList.js` | vs kit `useRunnerModels` / `LuModelPicker` internals |
| 6 | `components/ModelPicker.vue` | vs kit `LuModelPicker.vue` |
| 7 | `components/Combobox.vue` | vs kit `LuCombobox.vue` (kit header: "mirrors JustWrite's Combobox") |
| 8 | `components/WritingAiSettings.vue` | writing-AI settings — app config UI or stack UI? |
| 9 | `components/AiFeatureChip.vue` | per-feature AI affordance — app or stack? |
| 10 | `stores/ai.js` | the JW provider-registry store vs kit provider handling |
| 11 | `services/writerAI.js` | app feature glue over the kit stream wrapper — expect APP-OK |
| 12 | `services/chatApi.js` | unknown — classify |
| 13 | `views/AiView.vue` | thin host mount of kit `AiModelsArea` — expect APP-OK |
| 14 | feature callers: `services/analysis/*` (12) · `services/rag/*` (3+vectorStore) · `resumeBriefing/sensoryResearch/sessionRecap/stuckDiagnostic` | app features calling kit wrappers — expect APP-OK as a class, spot-verified |
| 15 | JW server: `seed_feature_prompts.py` · `seed_presets.py` · `app.py` install_llm wiring | the sanctioned per-app seeds — expect APP-OK |

Verdicts land in the table below as each unit is read; violations get their evidence + the fix-or-file
decision inline.
- **C2 — measured/benchmark re-grounding research:** NOT STARTED.
- **E3 — ODT import: lists:** NOT STARTED.

Per-item design + evidence + verification is appended below as each item starts; the master-plan ledger line is
updated as each item ships.
