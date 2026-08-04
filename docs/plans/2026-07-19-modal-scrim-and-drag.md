# AppModal — the scrim comes off, the header becomes a drag handle (2026-07-19)

> ✅ **CLOSED (docs campaign 2026-08-04)** — shipped; the drag invariants were lifted to docs/dev/IDEAS.md. History/evidence only; live work: `docs/dev/TASKS.md`.

Build record for two user-ruled changes to the shared modal shell. This is a kit-wide
primitive: every modal in BOTH JustWrite and JustVoice sits on it.

## The user's rulings, recorded verbatim

- **The blur AND the dim both go.** Not one or the other. The overlay ELEMENT stays — it
  still blocks interaction with the page behind it and carries reka's outside-click
  semantics — but it paints nothing.
- **Dragged position RESETS every time a modal opens.** No persistence anywhere: not in
  memory across mounts, not on disk, not per-modal.
- **Draggable is the DEFAULT, with an opt-out prop.** Modals are draggable unless a host
  says otherwise.
- **HelpDrawer opts out** — it is an edge-anchored slide-in panel; dragging it is
  meaningless.
- **VueUse is adopted, not hand-rolled.** `@vueuse/core`'s `useDraggable` supplies the
  handle and bounds behaviour we need, and it was ALREADY physically installed as a
  transitive dependency of reka-ui. Declaring it adds no new weight.

## What changed

### 1. The overlay no longer dims or blurs

`ui/src/common/components/AppModal.vue:199-209` — the `.ui-modal-overlay` rule lost
`backdrop-filter: blur(3px)` entirely and its `background` went from
`var(--scrim, color-mix(in oklab, black 36%, transparent))` to `transparent`.
`position: fixed`, `inset: 0` and `z-index: 200` are untouched, which is what preserves
the element's blocking role. The fade keyframes were KEPT: they animate `opacity` on an
element that is now transparent, so they are visually inert, but removing them would also
remove the `[data-state="closed"]` hook and buy nothing. Separation between the modal and
the page behind it is now carried entirely by the modal's own border and box-shadow
(`.ui-modal`, :214-231).

### 2. Modals drag by the header

- **Prop** — `draggable: { type: Boolean, default: true }` at :42-45.
- **Composable** — `useDraggable` imported at :16, called at :91-130 with `handle` bound to
  a template ref on the `<header>`, `disabled` bound to `computed(() => !props.draggable)`,
  and `preventDefault: true`.
- **Template** — `ref="contentRef"` on `DialogContent` (:151), `ref="headerRef"` on the
  `<header>` (:164), the classes `ui-modal--draggable` / `is-dragged` (:156-157), and
  `:style="contentStyle"` (:159), a computed at :134-143 that merges the pre-existing
  `maxWidth` width with `left`/`top`/`transform: none` once dragged.
- **CSS** — `.ui-modal.is-dragged { transform: none; animation: none; }` (:244) and
  `.ui-modal--draggable .ui-modal__header { cursor: move; }` (:245).

Three design points that are not obvious from the diff:

**The transform collision.** `.ui-modal` is centred with `transform: translate(-50%,-50%)`
and `useDraggable` positions with `left`/`top`. Applying left/top naively makes the modal
jump by half its own size the instant they take over. So `onStart` (:95-108) seeds the
drag position from the element's CURRENT centred `getBoundingClientRect()` and flips
`dragged` true in the same tick, and `.is-dragged` drops the centring transform. `animation:
none` is on that same rule because BOTH keyframes (`ui-modal-in` :233-236, `ui-modal-out`
:237-240) animate that same transform — without it, the close keyframe yanks a dragged
modal back toward the centre on the way out.

**The alternative considered and rejected**, recorded because this is a kit-wide primitive:
the collision could be removed as a CLASS by centring the modal with flexbox on the overlay
instead of `translate(-50%,-50%)`, which would delete both the seeding step and the
`animation: none` workaround. It was not taken because both open/close keyframes are built
on that transform, so the change would mean rewriting the modal's entry/exit animation for
every modal in both apps — a much larger blast radius than the ruling asked for. If the
animation is ever reworked for another reason, fold this in then. **A known consequence of
the current approach:** a modal that has been dragged closes with no fade at all, because
`animation: none` kills the leave keyframe along with the transform. The close still fires
correctly; it is only the visual polish that is lost, and only after a drag.

**Why we clamp by hand instead of passing `containerElement`.** `useDraggable` will
constrain to a container, but its `start()` computes the grab offset as
`e.clientX - (targetRect.left - containerRect.left + container.scrollLeft)`
(`@vueuse/core@14.3.0`, `dist/index.js:2881-2896`). For `document.documentElement` on a
scrolled page, `-containerRect.top` contributes `+scrollY` and `container.scrollTop`
contributes another `+scrollY` — the scroll offset is double-counted and the modal jumps by
twice the scroll distance on grab. Independently of that, `move()` (dist :2906, :2910) then
clamps with `Math.max(0, x)` in DOCUMENT coordinates, which is simply the wrong coordinate
space for a `position: fixed` element. With no container, `move()` reduces to
`e.clientX - pressedDelta.x` — pure viewport coordinates, exactly right here.

The clamp therefore lives in our own `onMove` (:109-129). It keeps `MIN_VISIBLE = 80`px of
the modal on screen at the right and bottom and never lets the header go above `y = 0`. The
LEFT bound is deliberately more generous — `MIN_GRABBABLE = 160` (:89, applied :124) —
because clamping the left edge at 80px would leave only the modal's RIGHT 80px visible, and
that strip is the close button, which `onStart` refuses to start a drag from. The modal
could then be pushed somewhere it could not be pulled back from. **A known limitation:** the
clamp reads `window.innerWidth`/`innerHeight` at move time only, so resizing the window
after a drag can leave a modal outside the viewport until it is reopened.

**Drags never start from a control.** `onStart` returns `false` when the pointer went down
on `button, a, input, select, textarea, [role=button]` (:98), so the close button and
anything a host puts in `#header-extra` still click normally. This is the one escape in the
feature and it carries a test that is PROVEN to fire (see below) — if it silently broke,
vueuse's `start()` would reach `handleEvent(e)` → `preventDefault()` on the header
pointerdown and the X would stop responding.

**Reset on open.** `dragged` and the drag position are plain setup refs, and every call
site mounts AppModal fresh behind a parent `v-if`, so a reopen is a new setup scope and the
reset is automatic. A `watch(visible)` at :132 resets them explicitly as well, covering any
host that keeps AppModal mounted and toggles it instead.

Untouched by design: the focus trap, scroll lock, Esc handling, `closable`, `dismissable`,
and the `emit("close")` timing.

### 3. HelpDrawer needed no change

The ruling says HelpDrawer opts out. On inspection it **does not consume AppModal at all** —
`ui/src/common/components/HelpDrawer.vue:13-20` imports `DialogRoot`/`DialogPortal`/
`DialogOverlay`/`DialogContent`/`DialogTitle`/`DialogClose` straight from `reka-ui` and
builds its own shell. It is therefore already outside the new behaviour and there is
nothing to opt out. The ruling stands; it is simply already satisfied.

Note the consequence: HelpDrawer has its OWN overlay styling, so the scrim/blur removal
above does not apply to it. If the user wants the help panel's backdrop to match, that is a
separate change.

### 4. Dependency declaration

- `ui/package.json:23` — `"@vueuse/core": "^14.3.0"` added to `peerDependencies`.
- `justwrite-app/package.json:53` — same range added to `dependencies`.
- `justwrite-app/vite.config.js:40` and `justwrite-app/vitest.config.js:31` — `@vueuse/core`
  appended to BOTH `resolve.dedupe` lists. The kit has no `node_modules` of its own, so its
  bare `@vueuse/core` import must resolve to the consuming app's copy; the two lists carry
  an explicit in-repo instruction to stay in lock-step, and the vitest one is what lets a
  mounted AppModal resolve the import under test.

Installed version verified at `justwrite-app/node_modules/@vueuse/core/package.json` before
choosing the range. `npm install` reported `up to date, audited 500 packages` and the
lockfile gained exactly one line — the direct declaration. reka-ui's own requirement is
`^14.1.0`, which 14.3.0 satisfies, so there is still one physical copy.

## How to verify

From `justwrite-app`:

- `npm run test:unit` — 38 files, 322 tests green. The new
  `src/renderer/src/components/__tests__/modalDragAndScrim.test.js` contributes 15: the
  overlay carries no `backdrop-filter` and no scrim background; the overlay element itself
  survives; `draggable` defaults on and the opt-out drops the class; `cursor: move` appears
  only under `.ui-modal--draggable`; `.ui-modal.is-dragged` declares both `transform: none`
  and `animation: none` while an undragged `.ui-modal` still centres; and three that
  execute the drag guard — a pointerdown on the close button must NOT start a drag, one on
  the plain title area MUST (the guard must not over-fire), and an opted-out modal never
  drags at all.
- **The guard tests were mutation-checked, not merely observed green.** With the `closest()`
  line at AppModal.vue:98 commented out, `does NOT start a drag from the close button`
  FAILS (`Tests 1 failed | 14 passed`) and the file was then restored. A green test that
  never exercises its path is no test; this one demonstrably exercises it.
- `npm run build:vite` — exits 0. It emits an `INVALID_ANNOTATION` warning about a
  `/* #__PURE__ */` comment position inside `@vueuse/core`'s own dist; that is upstream and
  cosmetic, not a failure.

The test file mixes source-level and mount-level assertions deliberately, and says so in its
own header: jsdom has no layout engine, so no mount can observe a `backdrop-filter` or a
transform taking effect, and `getBoundingClientRect`/`offsetWidth`/`innerWidth` return
zeroes there, so the clamp MATH cannot be exercised honestly in this harness. The guard, by
contrast, rests on `Element.closest()`, which needs no geometry — so it IS mount-tested.
The mount assertions also prove the SFC's script actually executes and `useDraggable`
resolves, which `build:vite` (compiles SFCs without resolving script identifiers) and biome
(does not check `.vue` identifiers) both miss.

**NOT VERIFIED: how the drag actually looks and feels.** No dev server was started and the
headless smoke was not run, by instruction. Someone needs to open a real modal and drag it:
watch for a jump on grab, check the clamp keeps the header reachable at every screen edge,
and confirm a moved modal closes without sliding back to centre.

## What would reverse it

Revert two commits — the kit one and the JustWrite one — or, by hand:

1. In `AppModal.vue`, restore `background: var(--scrim, color-mix(in oklab, black 36%,
   transparent))` and `backdrop-filter: blur(3px)` on `.ui-modal-overlay`; delete the
   `draggable` prop, the `useDraggable` import and block, the `contentStyle` computed, the
   `watch(visible)` reset, the two template refs, the two added classes, and the two CSS
   rules; restore `:style="maxWidth ? { width: ... } : undefined"` on `DialogContent`.
2. Delete `modalDragAndScrim.test.js`.
3. Drop `@vueuse/core` from both `package.json`s and both dedupe lists, then `npm install`.
4. Revert the one `AppModal` line in `justwrite-app/CLAUDE.md`.

Nothing here writes state, migrates data, or changes a wire contract, so a revert is clean
and needs no cleanup step.

## Open for the user

Every other AppModal consumer was enumerated and none is edge-anchored or full-bleed in a
way that makes dragging obviously wrong, so none was opted out. The full list, for the
record: in the kit — `AppDialog`, `AiModelsArea`, `QuickSetup`, `ProviderForm`,
`LuModelCatalog`, `TuneMeasureModal`, `LuClassTunes`, `LuGlobalSwitches`; in JustWrite —
29 `.vue` files, being 26 `*Modal.vue` components plus `ChatPanel`, `ShortcutCheatsheet`
and `AiSetupDialog`. (`AiStatusPanel` names AppModal only in comments and is not a
consumer.) Note the census is a NAME match on the string `AppModal`, not an import trace.
If any of these should not drag, that is a per-modal `:draggable="false"` and a one-line
change.

Also worth a ruling later: JustVoice consumes this same kit and gets both behaviours with
no separate opt-in, and it has no test coverage of its own for them.
