# Panel dismissal + the end of backdrop dimming — build record (2026-07-19)

Status: **shipped**. This is the record of a completed change, not a proposal.

## The user's rulings, verbatim

> "i want it to all look and feel the same, no blur background"

> "off focus should close it, same with click on nav like how chat works to open close"

> "panels only, modals keep their locked backdrop"

Those three sentences are the whole specification, and the third one is a fence,
not a footnote. **Panels** get outside-click dismissal, Esc dismissal, and a nav
trigger that closes as well as opens. **Modals do not.** `AppModal`'s
`dismissable: false` default (`ui/src/common/components/AppModal.vue:35-37`,
whose own comment says it "prevents accidental data loss") was deliberately NOT
touched by this change: no outside-close was added to `AppModal`, and no
`AppModal` consumer's dismissal behaviour changed. A modal is where a user has
half-finished work on screen; a stray click must not throw it away. A panel is a
peek at something, and a stray click should get you out of it.

## What changed, and why

### 1. Every remaining backdrop dim and blur is gone

The dim was doing a job that the panels' own borders and shadows already do, and
doing it inconsistently — some surfaces dimmed, some didn't, so the app felt like
several apps. `AppModal`'s overlay had already been made transparent in an earlier
pass; these were the four stragglers.

| Surface | file:line | Was | Now |
|---|---|---|---|
| Help drawer | `just-llm-runner/ui/src/common/components/HelpDrawer.vue:130-140` (`.help-drawer-overlay`) | `background: color-mix(in oklab, black 28%, transparent)` | `background: transparent` |
| Command palette | `justwrite-app/src/renderer/src/components/CommandPalette.vue:297-306` (`.cp-overlay`) | `color-mix(in oklab, black 35%, transparent)` | `transparent` |
| Scene links | `justwrite-app/src/renderer/src/components/SceneLinks.vue:248-255` (`.links-overlay`) | `color-mix(in oklab, var(--ink), transparent 55%)` | `transparent` |
| Legacy modal shell | `justwrite-app/src/renderer/src/styles.css:660-663` (`.modal-overlay`) | `background: var(--scrim); backdrop-filter: blur(4px)` | **rule deleted** |

In the first three cases the overlay **element** stays. That matters: the help
drawer's overlay is what Reka hangs its outside-click dismissal on, and the
command palette's overlay is both the `@click.self` catcher (`CommandPalette.vue:252`)
and the flex-centering container. Removing the element would have removed
behaviour; only the paint needed to go. Each edit carries a short comment saying
so, so the next person doesn't "restore" the dim or delete the element.

The fourth case is a deletion rather than a de-dim. `.modal-overlay` was a
hand-rolled modal shell from before the kit's `AppModal` existed. An unfiltered
grep across every file type under `justwrite-app/src` (`.js`, `.ts`, `.vue`,
`.css`, `.html`, plus any runtime-built class string) found **zero** consumers —
the only other matches in the repo were the unrelated kit class `.ui-modal-overlay`
and a compiled Rust `.rlib` binary. Dead code that declared the exact blur the
user just banned had no reason to survive, so the whole rule went, with a
tombstone comment in its place.

### 2. One panel-dismiss composable instead of three near-copies

`ChatPanel.vue` already implemented precisely the behaviour the user asked for,
and it had earned three non-obvious edge cases the hard way. `AiStatusPanel.vue`
had independently grown a second, slightly different implementation of the same
thing. That is exactly the drift R3 warns about: two copies of one behaviour,
diverging quietly, so a fix to one silently doesn't reach the other.

**New:** `just-llm-runner/ui/src/common/composables/usePanelDismiss.js`, exported
from the kit (`ui/src/common/index.js:79-80`) alongside `useRovingTabindex`.
Signature: `usePanelDismiss(isOpen, panelEl, close, { exempt })`. ChatPanel's
reasoning moved across **verbatim**, because the reasoning is the valuable part:

- **It listens on `mousedown`, not `click`.** Reka's Select removes dropdown
  content from the DOM synchronously on selection, so by the time a `click`
  bubbles to `document`, `target.closest()` is walking a detached tree and
  returns `null` — the panel would close whenever you picked a model. `mousedown`
  fires before Reka's handler, so `closest()` still walks an intact tree.
- **`[data-panel-toggle]` is exempt.** Without it, clicking a trigger while its
  panel is open closes the panel on mousedown and the trigger's own click handler
  immediately re-opens it. The toggle looks dead. This is the single most
  load-bearing line in the file, and it is the one the mutation check targets.
- **`[role="dialog"]`, `[role="listbox"]`, `.ui-select-content`,
  `[data-reka-popper-content-wrapper]` are exempt.** Portaled modals and Reka
  popovers render outside the panel element but are visually inside it; a click
  in them is not a click "outside".

Consumers:

- `justwrite-app/src/renderer/src/components/ChatPanel.vue:288` — local
  implementation **deleted**, replaced by one `usePanelDismiss(open, panelRef, close)`
  call. If a copy had survived here the extraction would have been pointless, so a
  test pins its absence.
- `just-llm-runner/ui/src/components/AiStatusPanel.vue:37-45` — its own copy
  deleted too. It keeps one genuinely panel-specific exemption via the `exempt`
  option: sonner toasts, because a completion toast's "View" action calls
  `openPanel` and the same click would otherwise bubble out and close the panel it
  just opened. It also switched from `click` to `mousedown` and from a `.aip`
  class check to a proper template ref, inheriting the Reka fix it never had.
- `HelpDrawer.vue` — **deliberately NOT a consumer.** It is a Reka `DialogRoot` /
  `DialogContent`, which already provides Esc and outside-click dismissal. Wiring
  the composable in as well would mean two mechanisms racing for one behaviour.
  It needed only one thing Reka cannot know about — the toggle exemption — so
  that is expressed in Reka's own hook (`@pointer-down-outside` →
  `onPointerDownOutside`, `HelpDrawer.vue:80-89`), reusing the composable's
  exported `PANEL_TOGGLE_ATTR` constant so the two can't drift apart.

### 3. One toggle vocabulary, and triggers that close

Two attribute names existed for one idea: `data-chat-toggle` and
`data-ai-status-toggle`. Both were renamed to **`data-panel-toggle`** — 16
occurrences across 12 files, plus the new `HelpTrigger`. One name, one meaning,
one selector in the composable.

`Sidebar.vue` needed more than a rename: it had the two old attributes on the
same element, and after renaming, two bindings of the same name is a Vue
"Duplicate attribute" **compile error** (caught by `build:vite`, not by the unit
tests — worth noting, because it is the kind of thing a green test run will
happily lie about). They collapsed into one `panelToggleAttr(n)` helper
(`Sidebar.vue:211-219`, used at `:855` and `:1090`).

Trigger toggling:

- **Chat** already toggled (`ui.toggleChatPanel`); unchanged apart from the rename.
- **AI tasks** already toggled too (`AiStatusButton.vue:25` → `tasks.togglePanel()`);
  it only needed the renamed attribute.
- **Help** did not. `HelpTrigger` called `openHelp` unconditionally, so a second
  click did nothing. New `toggleHelp(slug, anchor)` in
  `ui/src/common/services/help.js:67-83`, exported from the kit, and
  `HelpTrigger.vue:32-40` now calls it. **One judgement call worth flagging:**
  clicking the *same* trigger closes the drawer, but clicking a *different* "?"
  while the drawer is open navigates to that article instead of closing. Closing
  on a different trigger would make the second click feel broken. If the user
  wants strict close-on-any-trigger, that is a one-line change in `toggleHelp`.

### The mechanism decision, and the house rule it contradicted

`justwrite-app/AGENTS.md` §5 told agents *not* to use document-level
click-outside handlers — use a transparent inline backdrop with z-index
hit-testing instead (reference shipper: `AiFeatureChip.vue`) — and it explicitly
named `ChatPanel.vue` a "**Known exception**" with the instruction: "If you touch
it, don't add more exemption selectors — migrate to the backdrop pattern."

This change touched `ChatPanel.vue` and did the opposite: it promoted the
exception into the kit-wide mechanism for every panel in both repos. That was
caught by the rules-checker, not by the original build, because the precedent had
not been read first. Recording it here rather than quietly leaving it:

**Why the document handler is right for panels, and the backdrop pattern is not.**
A full-inset backdrop **swallows** the click that dismisses. For a dropdown that
is the desired behaviour — you click away, the menu closes, nothing else happens.
For a panel it is wrong: with the chat panel open, clicking a nav item must both
close the panel *and* navigate, in one click. A backdrop closes the panel and
eats the navigation. Panels are also non-blocking by design — you keep working
behind them — which a full-page click-interceptor directly contradicts. The
backdrop pattern's premise (the surface owns the whole screen until dismissed) is
a modal/dropdown premise, not a panel one.

`AGENTS.md` §5 has been narrowed accordingly: it now governs dropdowns and
popovers, and points panels at `usePanelDismiss`. The "known exception" paragraph
was also factually stale — it described a document handler and selectors
(`data-chat-toggle`, `.jw-select-content`) that no longer exist.

**This is a mechanism decision the user did not rule on.** The user ruled the
*behaviour* ("off focus should close it, same with click on nav like how chat
works"); they did not adjudicate document-handler vs backdrop, and amending a
house rule is not a thing an executor should decide alone. It is called out in
the delivery report for the user to confirm or reverse. Reversing costs the two
panels' call sites plus this section — the composable would become a backdrop
component instead.

**RULED 2026-07-20 (user): BLESSED — the amendment stands, no code change.** The user
confirmed the shipped behaviour on their box (Ask-the-book open → click a nav tab → panel
closes AND navigation lands, one click) and blessed the §5 rewrite. A backdrop revert is
the only thing that would break it, so it is off the table. Closed.

### A consequence of one shared vocabulary, stated plainly

Because every panel trigger now carries the same `[data-panel-toggle]` attribute
and the composable exempts them all, **clicking one panel's trigger no longer
closes a different open panel.** Before the rename, clicking the AI-tasks chip
while the chat panel was open would close chat. It now leaves chat open. This
follows directly from the "one vocabulary covers every panel" instruction and is
not obviously wrong — but it is a real behaviour change that nobody explicitly
ruled on, and it is the sharpest open question in this change. If it should
revert, the fix is a per-panel toggle value (`data-panel-toggle="chat"`) plus a
`toggle` option on the composable.

**RULED 2026-07-20 (user): WON'T DO — close it.** The user's call: it effectively works
because the scenario (two panels open at once, where opening one should close the other)
doesn't arise in practice today. Left as-is; revisit only if that scenario appears. The
per-panel-toggle fix above is the recorded path if it ever needs reverting.

## How to verify

Automated, from `justwrite-app`:

```
npm run test:unit     # 39 files, 356 tests — green
npm run build:vite    # green (this is what catches the duplicate-attribute class of bug)
```

The new tests are `justwrite-app/src/renderer/src/components/__tests__/panelDismissAndNoDim.test.js`
(27 tests). Two kinds, on purpose, following the precedent set by
`modalDragAndScrim.test.js` and `chipPopoverStacking.test.js` next door:

- **Source-level** for the CSS invariants — jsdom has no layout engine and paints
  nothing, so no mount can observe a background or a `backdrop-filter` taking
  effect. Asserted **per surface**, not as one blanket grep, because a blanket
  grep starts passing for the wrong reason the moment a selector is renamed. Each
  surface also has a "parses the rule it asserts on" test so a rename fails loudly
  instead of silently passing.
- **Behavioural** for the composable — it is all `Element.closest()` and
  `Node.contains()`, neither of which needs geometry, so jsdom runs them
  faithfully. These are real tests of real dismissal: closes on outside mousedown,
  does not close inside the panel, does not close on `[data-panel-toggle]`, does
  not close for `[role="dialog"]` or Reka popover content, ignores events while
  closed, ignores `click` (proving the mousedown choice), closes on Esc, ignores
  Esc while closed, ignores other keys.

**Mutation check** (a test that never fires is not a test). Removing
`PANEL_TOGGLE_ATTR` from the composable's exempt selector turned the toggle test
**RED** — `1 failed | 26 passed`, failing at the `expect(close).not.toHaveBeenCalled()`
on the toggle. Restoring it returned **GREEN** — `27 passed`. The exemption is
genuinely load-bearing and genuinely covered.

`biome check` on the changed JW files reports 3 infos
(`useNodejsImportProtocol` on `fs`/`path`/`url` imports in the test file) — byte-for-byte
the same 3 infos the existing `modalDragAndScrim.test.js` produces, so this
matches repo precedent rather than introducing drift.

**Not verified, and it needs human eyes.** This is a visual and behavioural
change that has not been looked at in a running app. The headless smoke was
deliberately not run because the user has live servers on :1420 and :17495. A
human should:

1. Open and close each panel from its own nav trigger **twice** — Ask the book,
   AI tasks, Help "?" — confirming the second click closes rather than no-ops.
2. Click outside each panel; it should close.
3. Press Esc in each panel; it should close.
4. Confirm **no page dimming anywhere** — panels, command palette (Ctrl/⌘+P),
   scene links.
5. Confirm modals still do **not** close on an outside click.
6. Inside the chat panel, open the character/model Select and pick an option —
   the panel must stay open (this is the Reka mousedown case).

## What reverses it

- **The dim**: restore the four `background` declarations in the table above, and
  restore the `.modal-overlay` rule from git history at
  `justwrite-app/src/renderer/src/styles.css:663`.
- **The extraction**: `git revert` the two commits. The composable is additive —
  deleting `usePanelDismiss.js`, its two export lines, and restoring the two local
  implementations from history returns the previous behaviour exactly.
- **The rename**: a global `data-panel-toggle` → `data-chat-toggle` /
  `data-ai-status-toggle` reversal, plus restoring `Sidebar.vue`'s two separate
  bindings.
- **Help toggling**: revert `HelpTrigger.vue` to call `openHelp` instead of
  `toggleHelp`; `toggleHelp` can stay unused or be deleted.
- **Not reversible because never done**: `AppModal`'s `dismissable: false`
  default. It was not touched.
