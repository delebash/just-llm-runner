# IDEAS — the backlog (just-llm-runner: kit + shared server)

The holding pen for unscheduled ideas about the shared stack — same charter as JW's
`docs/dev/IDEAS.md`. Adding an idea is never starting it. Committed work lives in
`docs/dev/TASKS.md`. Newest at the top; date each one.

---

- **2026-08-04 · Ternary Bonsai / Q2_0 on the 8 GB rung.** When the CUDA Q2_0 PR
  (llama.cpp #25707) merges into a pinnable release, promote to a 2070S Lab A/B vs
  Gemma 26B-A4B (evidence-not-press-release — the catalog law). Watch details:
  `docs/llama-cpp-watch.md` §Watch list.
  **TRIGGER MET [verified 2026-09-19]:** #25707 merged 2026-07-30; first build
  `b10192`; `Ternary-Bonsai-27B-Q2_g64.gguf` (the mainline g64 form) is already in
  the shared cache, and the pin is now `b10750` — past b10192 — so BONSAI 1 is
  runnable today.
  **A/B RUN 2026-09-19 (user: "run it") — VERDICT: NOT a contender on the 8 GB rung.
  Do not add it to the catalog.** Measured on the 2070S at the app's own flags
  (ctx 32768, q8_0 KV, fa on, engine placing tensors):

  | | Bonsai 1 (ternary 27B) | Gemma 26B-A4B |
  |---|---|---|
  | file | 7.06 GB | 13.27 GB |
  | engine placed | 38/65 layers · 4,120 MiB card + 3,103 MiB host | 31/31 · 4,968 MiB card |
  | **tok/s** | **2.65** | **46.35** (draft) / 38.10 (none) |

  WHY, and it is structural, not a tuning miss: Bonsai 1 is **DENSE** (`expert_count 0`
  — our reader says `is_moe False`). Every token touches all 7 GB, and 3.1 GB of it
  sits on the host, so 27 of 65 layers are read over PCIe per token. Gemma is MoE:
  only ~4B params activate, so its 21 host-resident expert blocks are nearly free.
  "27B-class quality at 6.7 GB" is true about the FILE and says nothing about speed
  on a card that cannot hold it — exactly what the evidence-not-press-release law is
  for. At 2.65 tok/s the catalog's own bands would label it *slow*, a third of the
  8 tok/s reading-speed line.
  Also observed, NOT explained: a `/v1/chat/completions` turn returned empty content.
  The GGUF does carry a chat template and the server logs `thinking = 1`, so the
  likely cause is the 120-token budget being spent entirely on reasoning — plausible,
  unverified, and irrelevant to the speed verdict above.
- **2026-09-19 · Bonsai 2 27B — BLOCKED, fork-only. Do not plan around it.**
  `prism-ml/Ternary-Bonsai-2-27B-gguf` (Apache-2.0, from Qwen3.8-27B, 851 tensors,
  arch `qwen35`, 5.95 GB PTQ1_0 / 7.21 GB PQ2_0, with an optional Q8_0 vision
  mmproj). Its own card: *"Low-bit kernels: llama.cpp fork (CUDA + Metal)"*. VERIFIED
  FROM THE FILES, not the card — a 64 MB range read of each GGUF header shows 402 of
  851 tensors carry ggml type id **143** (PTQ1_0) / **142** (PQ2_0), and
  `general.file_type` 143 / 141. Stock llama.cpp's type enum ends at 39
  (`GGML_TYPE_MXFP4`) at our pin, and a grep of its ENTIRE commit history finds no
  mention of PQ2_0, PTQ1_0, prism or bonsai. So the engine we ship cannot even map
  the weights, let alone run them — this is not a pin bump away. Unlike Bonsai 1,
  whose Q2_0 did reach mainline (#25707), nothing here is upstream.
  **Watch for:** these packings landing in mainline llama.cpp. Until then the only
  path is their fork, which we do not ship (standing rule).
- **2026-08-04 · Unadopted llama.cpp adoption candidates** from the 2026-07-14
  review (`docs/llama-cpp-watch.md` review log): b9986 reasoning-leak fix · b9974
  CUDA no-free-VRAM query · b9905 quantized KV for DeepSeek-V4 · b9967 null
  sampling params · b9910/b9964 spec-decode fixes. None forces a change; adopt
  opportunistically at the next pin bump.
- **2026-08-04 · The labeling law (lift into the kit's design contract):** a row in
  a switches surface must be a real engine switch or SAY it isn't. Ruled in
  `docs/plans/archive/2026-07-16-reasoning-budget-house-layering.md:631`; currently lives
  only in that plan doc.
- **2026-08-04 · Dismissal + drag invariants (kit-wide, lift from build records):**
  panels get outside-click/Esc dismissal, modals never do
  (`archive/2026-07-19-panel-dismiss-and-no-dim.md`); modals are draggable by default, the
  dragged position resets every open, HelpDrawer opts out
  (`2026-07-19-modal-scrim-and-drag.md`). Candidates for a §-invariants block in
  `docs/app-structure.md` §4 or the kit README.
- **2026-08-04 · `_ENGINE_UNSUPPORTED_ARCHS` is an append-list ritual**
  (`llm_runner/runner/models.py:190-197`) — "add a line when a new unsupported arch
  surfaces" has no reminder anywhere; consider a check that flags catalog rows whose
  arch the pinned engine can't load.

- **2026-08-13 · The MTP-variant repo steer** — from the fit checkpoint: when an
  inspected repo's header carries NO MTP heads but the SAME publisher ships a
  `<name>-MTP-GGUF` sibling whose files do (the unsloth two-variant convention,
  verified by header walks), the Add form should SAY SO and offer the sibling
  repo — "this repo ships MTP-stripped files; the same publisher ships an
  MTP-preserved variant" — instead of the tier-C borrow treating the sibling as
  a drafter source (now size-guarded to prevent the 18 GB-draft footgun). Needs
  one extra header probe at inspect + a panel line + the swap affordance.

