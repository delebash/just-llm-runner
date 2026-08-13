# IDEAS — the backlog (just-llm-runner: kit + shared server)

The holding pen for unscheduled ideas about the shared stack — same charter as JW's
`docs/dev/IDEAS.md`. Adding an idea is never starting it. Committed work lives in
`docs/dev/TASKS.md`. Newest at the top; date each one.

---

- **2026-08-04 · Ternary Bonsai / Q2_0 on the 8 GB rung.** When the CUDA Q2_0 PR
  (llama.cpp #25707) merges into a pinnable release, promote to a 2070S Lab A/B vs
  Gemma 26B-A4B (evidence-not-press-release — the catalog law). Watch details:
  `docs/llama-cpp-watch.md` §Watch list.
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

