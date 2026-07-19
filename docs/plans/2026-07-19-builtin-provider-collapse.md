# 2026-07-19 — The built-in provider collapses into the Local list

A build record. Five questions: what changed · why · where · how to verify · what reverses it.

## The user's rulings (verbatim in substance, recorded as given)

1. The built-in provider becomes a **normal row** in the Local list, behaving exactly like
   every other provider: an inline **Edit** that expands its ProviderForm in place.
2. The **Quick Setup band is lifted out** of that card and sits at the **top of the Local
   tab**, in its own right — visible on the Local scope **only**, never on Online.
3. Quick Setup's copy must make **unmistakably clear it configures only the built-in
   llama.cpp provider**. Detaching it from the built-in card removes the geometry that used
   to convey that, so the **words** must carry it.
4. The **"(your machine)" title tail is deleted**.
5. The built-in row carries a **"Built-in" tag**, alongside the existing "Default ✓" /
   "Set as default" button, which stays exactly as it is.

## What changed

**This REVERSES the QC-39 (b) promotion decision.** That decision pulled the built-in
provider out of the provider list into a permanent card at the top of the Providers & models
tab, because the built-in is the one provider almost every user actually configures and
burying it in an accordion made it hard to find. The reason that promotion existed is now
served by something else: the **Local | Online tab strip** (kit `fa34291`) means the Local
tab contains only local providers, and the built-in is sorted first within it. Findability
no longer needs a special-cased card, and the special case was costing a second, divergent
rendering of one provider — its own header markup, its own default button, a `permanent`
ProviderForm variant with different chrome. One row template now renders every provider.

`ui/src/views/AiModelsArea.vue`:

- **Deleted** the promoted `.lu-builtin` section (was ~:416-436): the `.lu-builtin-qs`
  wrapper, `.lu-builtin-head`, the `<h3>` title with the `(your machine)` tail, the cap
  spans, the spacer, the Set-as-default button, and `<ProviderForm :provider="builtinProvider"
  permanent />`. Its dead CSS (`.lu-builtin`, `-qs`, `-head`, `-title`, `-spacer`) is removed
  with it; nothing else in the kit referenced those classes (grepped).
- **Mounted Quick Setup on its own** at the top of the providers tab, above the
  "Providers · N configured · Add provider" header (AiModelsArea.vue:414-416), in a
  `.lu-qs-band` wrapper gated by **`v-show="providerScope === 'local'"`**.
- **`localProviders` now includes the built-in and sorts it first** (AiModelsArea.vue:77-80)
  — was `.filter((p) => p.local && p.providerType !== "local-llamacpp")`, now
  `.filter((p) => p.local).sort(...)` keyed on the new `isBuiltin(p)` helper.
  `.filter()` returns a fresh array, so the in-place `.sort()` cannot mutate
  `providers.value`.
- **The row** (the `Built-in` badge at AiModelsArea.vue:451, the one meta line at
  :462-466) gained a `Built-in` badge reusing the existing
  `.lu-cap` class (no new badge style), and an honest meta line: the built-in **omits the
  key clause** — `hasApiKey` is false for a provider that needs no key, so "no key" read as
  a missing setting rather than a fact. That stayed **ONE** `.lu-prow-meta` template rather
  than a built-in copy (the first cut of this change forked it; the rules-checker caught the
  duplicate): the key clause is behind `v-if="!isBuiltin(p)"` and every separator **leads**
  its clause instead of trailing it, so dropping a clause can't strand a dangling "·" and a
  future field is added in exactly one place. Test/Edit/Set-as-default
  are unchanged for all rows, and Edit on the built-in flows through the existing
  `editingId === p.id` branch, so it expands a normal ProviderForm — with card chrome and a
  Cancel, both of which the old `permanent` mode suppressed.
- The `builtinProvider` computed is **deleted**. An earlier cut of this change kept it on
  the belief that the set-as-default dialog resolved it; a rules-checker pass proved that
  false — the dialog works off `setDefaultFor` and its `sdIsBuiltin`/`sdModel`/`sdEmbedModel`
  derivations, and a repo-wide grep found no other reader. The row template's `isBuiltin(p)`
  predicate is now the one way this file asks "is this the built-in?".
- Stale comments corrected: the engine-panel note in the script header (the panel is now
  reached by Edit, not by a promoted section) and the `onMounted` nextTick note, which
  described `qsRef` as living inside `v-if="builtinProvider"` — no longer true.

`ui/src/views/ProviderForm.vue` — **the `permanent` mode is deleted with its only caller.**
The promoted card was the sole consumer of `permanent` (at their **pre-deletion** positions:
the prop at :30, the `lu-pform--bare` class binding at :243, the Cancel suppression at :376,
the `.lu-pform--bare` rule at :388, plus two comments describing that surface). Leaving it behind would have left
kit API that nothing exercises and a second, silently-diverging presentation of the same
form. Every provider's Edit now renders the one card-chromed, cancellable form. (Caught by
the rules-checker — the first cut deleted the caller and orphaned the mode.) The dead
`.lu-qs-wrap` rule in AiModelsArea.vue went the same way.

`ui/src/views/QuickSetup.vue`:

- The inline band's `lu-qs-barefor` line now reads **"Sets up the built-in llama.cpp
  provider only"** (was "For the Local built-in provider"). The sub-caption and the modal
  title are unchanged — the modal already says "for the Local built-in provider only".

**Why `v-show` and not `v-if` on the band, emphatically.** `qsRef` is reached by two openers
that live *outside* the band: the hardware-change toast's "Run Quick Setup" action
(`checkHardwareChange`, AiModelsArea.vue:~344) and the `?quicksetup=1` auto-open deep link
(`onMounted`). A `v-if` unmounts QuickSetup whenever the user stands on the Online tab, and
both call sites are optional-chained (`qsRef.value?.openWizard?.()`) — so they degrade into
*silent* no-ops with no error anywhere. Kit `fa34291` fixed exactly this bug and pinned it
with a test; that pin survives here, repointed at `.lu-qs-band`.

`justwrite-app/docs/models.md`: the two passages that asserted the built-in's control panel
is "always on the page (no Edit click)" (~:13) and that the catalog is on the page with
"nothing to open" (~:129) now say the built-in is the first row on the Local tab and its
panel/catalog opens via Edit. A third line (:252), which sent the reader to "the Built-in
provider **section**" for the class-defaults library, was corrected the same way — a
rules-checker pass found it after the first two. The remaining "Built-in provider" mentions
(:15, :129, :329, and the engine-install note at :315) are still true of a provider you Edit,
so they were left alone; the doc's structure is untouched.

## How to verify

`npm run test:unit` from `justwrite-app` — 329 tests pass, of which 13 are
`src/renderer/src/components/__tests__/providerScope.test.js` (extended, not forked):
the promoted `.lu-builtin` card is gone while a built-in **row** exists; the built-in is the
**first** row; it carries the **Built-in** tag and a plain local row does not; its meta omits
"no key" while the plain local row keeps it; it is absent from the Online scope; the string
`(your machine)` appears nowhere in the rendered output; **Edit on the built-in row expands
a non-bare ProviderForm carrying a Cancel** (the pin that keeps the `permanent` deletion
honest); the Quick-Setup band shows on Local
and hides on Online; and — the regression pin — the band stays **in the DOM** when hidden, so
`qsRef` survives. `npm run build:vite` compiles clean. Biome is clean on the changed JW file.

**Not verified: the look.** This is a GUI change that has not been rendered or screenshotted
— the user has live servers on :1420/:17495 that this work was told not to touch, so the
headless smoke was not run. The seating of `.lu-qs-band` (14px padding + rule + 14px margin,
carried over from the old `.lu-builtin-qs`) and the built-in row's density with the extra tag
are unconfirmed by eye.

## What reverses it

Revert the kit commit's changes to `AiModelsArea.vue`, `ProviderForm.vue` and
`QuickSetup.vue`; the deleted
markup and CSS are recoverable verbatim from the parent of the kit commit. Restoring the
promotion means restoring the `.lu-builtin` block **and** ProviderForm's `permanent` mode,
re-excluding `local-llamacpp` from `localProviders`, and dropping the `Built-in` tag + the
meta line's `!isBuiltin` guard. The
providerScope test's `built-in provider is a normal row in the Local list` describe block
would go with it — but keep the qsRef mount pin under whichever container Quick Setup ends
up in, since that bug predates and outlives this change.
