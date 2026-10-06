<!-- SPDX-License-Identifier: MIT -->
# Research register — what we already know, and where the proof is (just-llm-runner)

**Read the section for your subject before researching anything** — before reading code to
answer a question, before measuring, before briefing an agent. Then grep `docs/plans` for
anything newer. This repo's register holds the shared AI stack's facts (the kit, the shared
server, llama.cpp, the memory arbiter); each app's own register holds its domain:
[JustVoice](../../../JustVioce/docs/dev/RESEARCH.md) ·
[JustWrite](../../../justwrite-app/docs/dev/RESEARCH.md) ·
[docgen](../../../just_ai_i18n_docgen/docs/dev/RESEARCH.md).

## The rule (family-wide, decided 2026-10-04)

The user: *"why do we keep re researching stuff, we need a primary research doc that we point to
so we dont keep duplicating or forgeting what we have done in the past"* — approved "your rec on
all go". JustVoice's register tells the story that prompted it.

- **One register per repo** (`docs/dev/RESEARCH.md`), organised by subject.
- **Before research:** read the subject's section and grep `docs/plans`. An agent's brief
  carries that section and the line *"don't re-derive these; re-check one only if the code it
  cites changed after its date"*.
- **After research:** its facts land in the register in the same change. A research doc with
  no entry is not done. `scripts/check-family.mjs` check 15 fails any `docs/plans/YYYY-MM-DD-*.md`
  dated 2026-10-04 or later that its repo's register does not link, and any register link that
  points nowhere. (It can check the link, not that the facts came with it — that part is the
  rule.)
- **Filled as each subject comes up.** Until then a subject's records are indexed under
  "Records not yet distilled", so they can at least be found.

How it differs from its neighbours: `TASKS.md` says what is OPEN; the distilled records
(`model-research.md`, `serving-design.md`) and `../app-structure.md` say what was DECIDED or
ruled; this page says what is TRUE and where the proof lives. Plan docs stay as the evidence.

## How an entry reads

One fact per bullet, then *how it was checked and when*, then where the proof is.

- **measured** — run on a machine (which one is in the proof) · **code** — read in source ·
  **web** — checked against an upstream page · **git** — read from history · **record** —
  carried from a record and not re-checked since · **agent** — found by a review agent reading
  code and not re-checked by the session that recorded it.
- A fact that turns out wrong is **rewritten**, ending "(was: … until <date>)". Never leave a
  fact standing beside its correction.
- A fact cites code by `file:line`. If that file changed after the fact's date, re-check that
  one fact — don't redo the research.

Subjects: [1 · Memory: the arbiter and the probes](#1--memory-the-arbiter-and-the-probes) ·
[2 · The family stack: Electron, Node, phones](#2--the-family-stack-electron-node-phones) ·
[Records not yet distilled](#records-not-yet-distilled)

---

## 1 · Memory: the arbiter and the probes

**Records:** [`serving-design.md`](serving-design.md) (router, arbiter, cancel — distilled) ·
[`2026-09-19-vram-truth-exact-bytes-units-offload.md`](../plans/2026-09-19-vram-truth-exact-bytes-units-offload.md) ·
[`2026-08-09-fit-redesign.md`](../plans/2026-08-09-fit-redesign.md) and its
[debate ledger](../plans/2026-08-09-fit-redesign-debate.md).
What a speech model costs, measured, is in JustVoice's register §2.

- `make_room(needed, exclude=key)` never evicts the excluded key, and never evicts a kind that
  is protected or busy. So a booking left behind under the key being loaded can only be cleared
  by releasing it — no admission removes it. — *code, 2026-10-04* ·
  `llm_runner/runner/arbiter.py:326-370` (the candidate filter at 362, protected and busy kinds
  at 358).
- `process_tree_device_mem_mb(pid)` measures the dedicated graphics memory of a process **and
  its children** (Windows venv pythons are launcher shims whose child holds the memory). It asks
  nvidia-smi first; on Windows' WDDM driver model, where nvidia-smi answers N/A per process, it
  reads the "GPU Process Memory" counter per pid. None = no per-process reading worked. —
  *code, 2026-10-04* · `llm_runner/runner/hardware.py:719-736`.
- `used_pool_mb()` is the family's one cached reading of used pool memory; `fresh=True` skips
  the cache (the load door must). None = unmeasurable, and callers fall back to the ledger
  rather than guess. — *code, 2026-10-04* · `llm_runner/runner/hardware.py:468-480`.

---

## 2 · The family stack: Electron, Node, phones

**Records:** JustVoice's
[`2026-10-05-electron-node-study.md`](../../../JustVioce/docs/plans/2026-10-05-electron-node-study.md)
(the study — direction decided 2026-10-05: Electron + a Node server, Tauri and Python go, the
whole family; tracked in JustVoice's TASKS). JustVoice's own facts are in its register §6.
Agent findings were checked against code or upstream pages on 2026-10-05 by the agents; the
ones this session re-checked are marked ✓ in the study.

**Electron and Node** (*web + measured, 2026-10-05*):

- Electron 44.5.1 (2026-09-29) ships Chromium 152.0.7977.130 and Node 24.21.0; the latest
  three majors are supported, 45 goes stable 2026-10-20 — about six months of life per major.
  WebView2 on the dev machine is already 154.0.4258.53.
- `ELECTRON_RUN_AS_NODE=1` runs the app's own exe as plain Node (no display), if the `runAsNode`
  fuse is left on — one binary can serve headless.
- `globalShortcut` fires on press only: no key-up, no left/right modifiers, no modifier-only
  chords. `uiohook-napi` compiles in libuiohook, LGPL-3.0-or-later — fails the licence rule.
- System-audio loopback is built in on Windows (`setDisplayMediaRequestHandler`, `audio:
  'loopback'`); macOS has open bug electron#52738 on the custom-handler path; Linux has no
  backend.
- electron-builder (MIT) covers NSIS, AppImage, deb/rpm, dmg; `electron-updater` updates all
  three OSes. Electron Forge has no NSIS or AppImage.
- An Electron NSIS installer of a small Vue app is 111.7 MB, 370 MB installed (*measured*).

**SQLite in Node** (*web + measured*):

- `node:sqlite` is "Release candidate (1.2)" in Node 24 and 26, not Stable. It works with no
  flag in Electron 44.5.1's main process, a `utilityProcess` and under `ELECTRON_RUN_AS_NODE`,
  including `VACUUM INTO` and `ATTACH` (*measured*).
- better-sqlite3 13 is Node-API with prebuilt binaries in the package: 13.0.3 loads unchanged in
  Electron 44.5.1 and Node 26.5.0 — no per-Electron rebuild (*measured*).

**The kit in JavaScript** (*code + measured*, study §3):

- `llm_runner`: 70 files / 25,941 lines, 61 test files / 19,215 lines, 1,019 test functions,
  119 routes, 26 tables; ~100 ORM query sites; the kit's wire format is camelCase
  (`llm/schema.py:11-17`, `runner/schema.py:20-26`).
- **Process trees on Windows**: Node's `child_process` puts children in libuv's kill-on-close
  job, but that job sets SILENT_BREAKAWAY_OK — a **grandchild survived** a hard kill of the
  server; with our own Job Object through `koffi` (MIT) it died too (*measured*). llama-server's
  router mode starts per-model children (`runner/arbiter.py:4`, `process.py:382`), so the kit's
  spawn needs that job (today: ctypes, `runner/process.py:831-907`).
- undici's header and body timeouts default to 300 s; `fetch` ignores `HTTP(S)_PROXY` unless
  `NODE_USE_ENV_PROXY=1`.
- JavaScript's `\w`/`\b` are ASCII-only and it has no `casefold` — a naive regex port gives
  wrong results on non-English text silently.
- The official `openai`, `@anthropic-ai/sdk` and `@google/genai` JS SDKs carry every call the
  kit's adapters use; the MCP SDK mounts in Fastify as an ordinary route.

**The data-dir ladder** (*agent*, study §4.1): the Rust shells and `platform/data_paths.py`
disagree today — the OS fallback folder (Tauri's `%APPDATA%\<id>` vs platformdirs'
`%LOCALAPPDATA%\<App>\<App>`), the `dataroot.txt` pointer (only Rust reads it) and the dev root
(`target/debug` vs the checkout). Tauri also writes `.window-state.json` and `EBWebView` outside
the chosen root.

**Phones** (*web*, study §5):

- Tauri 2's sidecar works on desktop only. iOS apps may not spawn child processes, so the
  kit's runner (download a llama.cpp binary, spawn it) cannot exist on iOS.
- Capacitor (Ionic, MIT, 8.5.2) runs a plain Vue build — Ionic Framework (a UI toolkit) isn't
  needed. Capawesome sells its SQLite and some other plugins (Insiders: $99/month); its
  Capacitor-Electron platform is MIT, v0.1.1, three months old. `@capacitor-community/electron`
  is unmaintained. `@capacitor-community/sqlite` 8.1.1 is MIT.
- CapacitorHttp buffers whole responses and has no SSE; the kit's client streams with
  `res.body.getReader()` (`ui/src/client.js:157-169`). No maintained MIT llama.cpp plugin for
  Capacitor exists.

---

## 3 · AI tasks and the stream frames

- An app endpoint's SSE stream speaks five frames: `{delta}` (tokens), `{progress}` (prompt
  reading, before the first token only), `{step: {name, done, total}}` (a later pass over part
  of the work, counted — added 2026-10-06), `{done, promptTokens, completionTokens, model, …}`
  and `[DONE]`; errors as `{error}`. — *code, 2026-10-06* · `ui/src/client.js` requestStream.
- `runAiEndpointStream` puts a step on the task's count: `stepText(step)` words it,
  `stepHint(step)` is the count's tooltip (the task store's `progress.hint`), `onStep(step)`
  tells the app. Without `stepText` the count reads `done/total`. — *code, 2026-10-06* ·
  `ui/src/services/appTask.js`, `stores/aiTasks.js` `_setProgress`.
- A strip says *stuck* only on a streaming task whose last token is ≥ 25 s old (or 8× its own
  mean gap); only token deltas refresh it — a step or a count does not. — *code, 2026-10-06* ·
  `ui/src/common/services/streamFreshness.js`, `stores/aiTasks.js` `_recordDelta`.

---

## Records not yet distilled

Indexed by subject so they can be found; their facts move into a section above when work next
touches the subject. History in [`../plans/archive/`](../plans/archive/) is not listed.

**llama.cpp — updates, the pin, the stable channel** —
[`2026-09-19-engine-update-safety-and-stable-channel.md`](../plans/2026-09-19-engine-update-safety-and-stable-channel.md) ·
[`../llama-cpp-watch.md`](../llama-cpp-watch.md) (the upstream review ledger).

**Speed** — [`2026-09-19-speed-truth-and-calibrated-pick.md`](../plans/2026-09-19-speed-truth-and-calibrated-pick.md).

**The CPU-only band** — [`2026-07-19-cpu-only-band-test.md`](../plans/2026-07-19-cpu-only-band-test.md).

**Jobs across the three apps** — [`2026-08-14-three-app-job-matrix.md`](../plans/2026-08-14-three-app-job-matrix.md).

**Models** — [`model-research.md`](model-research.md) (distilled verdicts, licensing laws).

**Features and routing** — [`../feature-model-system.md`](../feature-model-system.md).

**Family structure** — [`../app-structure.md`](../app-structure.md) (the standard) ·
[`../family-structure-audit.md`](../family-structure-audit.md) ·
[`../target-tree.md`](../target-tree.md).

**Installing the stack** — [`install-runbook.md`](install-runbook.md).
