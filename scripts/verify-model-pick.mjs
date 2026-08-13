// SPDX-License-Identifier: MIT
// Node truth-table for the §10 speed-floor auto-pick (ui/src/common/services/modelPick.js).
// The kit has no JS test runner, and a browser render-smoke can't isolate §10's crux branch
// (a dense+tight EXCLUDED while a moe+tight is KEPT) — CARD_OPTIONS is capped at 24 GB until
// Phase 3, so a card-override probe can't construct the two side-by-side deterministically.
// This does, purely and re-runnably.
//   Run:  node scripts/verify-model-pick.mjs      (exit 0 = all pass, 1 = any fail)
import { FIT_GPU, catalogState, pickBestEmbedId, pickBestModel, pickByClassConfig, pickLowestQuality, recommendedModelId } from "../ui/src/common/services/modelPick.js";

// A tiny test model. fit ∈ ok|tight|cpu|no|unknown; type ∈ dense|moe.
const M = (id, fit, type, quality, extra = {}) =>
  ({ id, fit, type, quality, embed: false, useLimited: false, ...extra });

// Bind the pure rule's accessors to the test-model fields — the same shape QuickSetup binds
// to the catalog-join maps (typeById / qualityById / embeddingById / useLimitedById).
const pick = (models) => pickBestModel(models, {
  typeOf: (m) => m.type,
  qualityOf: (m) => m.quality,
  isEmbed: (m) => m.embed,
  isUseLimited: (m) => m.useLimited,
});

let pass = 0;
let fail = 0;
function check(name, got, want) {
  if (got === want) { pass++; console.log(`  ok    ${name}  → "${got}"`); }
  else { fail++; console.log(`  FAIL  ${name}  → got "${got}", want "${want}"`); }
}

// 1. Dense fully on GPU is fast-enough → picked.
check("dense+ok picked", pick([M("d-ok", "ok", "dense", 30)]), "d-ok");

// 2. Dense+tight ALONE → not fast-enough, but the only runnable → fallback picks it.
check("dense+tight lone → fallback", pick([M("d-tight", "tight", "dense", 30)]), "d-tight");

// 3. THE CRUX: dense+tight (BETTER quality) vs moe+tight → the moe wins, because dense+tight
//    is excluded from fast-enough even though its quality_rank is lower/better.
check("moe+tight beats dense+tight (crux)",
  pick([M("d-tight", "tight", "dense", 10), M("m-tight", "tight", "moe", 40)]), "m-tight");

// 4. Moe fully on GPU → fast-enough.
check("moe+ok picked", pick([M("m-ok", "ok", "moe", 20)]), "m-ok");

// 5. Moe+tight is fast-enough, beats a non-fast dense+tight.
check("moe+tight fast-enough",
  pick([M("m-tight", "tight", "moe", 20), M("d-tight", "tight", "dense", 15)]), "m-tight");

// 6. Moe+cpu → runnable but NOT fast-enough (cpu ∉ {ok,tight}) → fallback.
check("moe+cpu → fallback", pick([M("m-cpu", "cpu", "moe", 20)]), "m-cpu");

// 7. Dense+cpu → runnable, not fast-enough → fallback.
check("dense+cpu → fallback", pick([M("d-cpu", "cpu", "dense", 20)]), "d-cpu");

// 8. Flagged embedding (bge-m3-style: dense-shaped, best quality, no "embed" in id) is
//    excluded by the flag → the LLM is picked. (Guards the real Phase-0 leak.)
check("flagged embed excluded",
  pick([M("bge-m3", "ok", "dense", 5, { embed: true }), M("d-ok", "ok", "dense", 30)]), "d-ok");

// 9. Use-limited (Llama-3.3-70B-style: dense+ok, best quality) excluded — never an auto-default.
check("use-limited excluded",
  pick([M("llama-70b", "ok", "dense", 11, { useLimited: true }), M("qwen-32b", "ok", "dense", 14)]),
  "qwen-32b");

// 10. Multiple fast-enough → LOWEST quality_rank wins.
check("lowest quality among fast-enough",
  pick([M("d-ok-30", "ok", "dense", 30), M("d-ok-14", "ok", "dense", 14), M("d-ok-25", "ok", "dense", 25)]),
  "d-ok-14");

// 11. Tie-break: equal quality_rank → the better fit wins (the FIT_RANK secondary sort). Both
//     moe so both fast-enough; ok beats tight.
check("tie-break: better fit wins",
  pick([M("m-tight", "tight", "moe", 20), M("m-ok", "ok", "moe", 20)]), "m-ok");

// 12. Nothing runnable (all `no`) → "".
check("no runnable → empty", pick([M("d-no", "no", "dense", 10), M("m-no", "no", "moe", 5)]), "");

// 13. Fallback ranks by quality then fit: no fast-enough (dense+tight + dense+cpu), equal
//     quality → tight beats cpu.
check("fallback ranks by quality then fit",
  pick([M("d-cpu", "cpu", "dense", 20), M("d-tight", "tight", "dense", 20)]), "d-tight");

// 14. Empty input → "".
check("empty input → empty", pick([]), "");

// 15. Adversarial crux guard: a moe+cpu with BETTER (lower) quality must LOSE to a dense+ok,
//     because moe+cpu is NOT fast-enough (cpu ∉ {ok,tight}) — catches a future regression that
//     wrongly counts a MoE runnable-but-not-on-GPU as fast-enough.
check("moe+cpu (better quality) loses to dense+ok",
  pick([M("m-cpu", "cpu", "moe", 5), M("d-ok", "ok", "dense", 30)]), "d-ok");

// ── Direct pickLowestQuality checks — the shared comparator QuickSetup's bestEmbedId reuses
//    for the embedding pick (lowest quality_rank, tie-break to the better fit). ──
const lq = (list) => pickLowestQuality(list, { qualityOf: (m) => m.quality });
check("lowestQuality: lowest rank wins", lq([M("a", "ok", "dense", 30), M("b", "ok", "dense", 10), M("c", "ok", "dense", 20)]), "b");
check("lowestQuality: tie → better fit", lq([M("t", "tight", "dense", 20), M("o", "ok", "dense", 20)]), "o");
check("lowestQuality: empty → ''", lq([]), "");

// ── §9 (2026-07-22): pickByClassConfig — the visible class-config library IS the
//    recommendation (replaces the deleted hidden class→model pick table). A model
//    with a config for THIS box's class wins, ranked by the shared comparator and
//    guarded by the §10 candidate rules; no config for the class → "" (§10 decides). ──
const REFS = [
  { modelId: "cfg-a", classKey: "vram8|ram32" },
  { modelId: "cfg-b", classKey: "vram8|ram32" },
  { modelId: "cfg-x", classKey: "vram24|ram64" },
];
const cc = (refs, myKey, models, fitSet) => pickByClassConfig(refs, myKey, models, {
  fitSet,
  qualityOf: (m) => m.quality,
  isEmbed: (m) => m.embed,
  isUseLimited: (m) => m.useLimited,
});
check("classConfig: my class's configs win, lowest quality among them",
  cc(REFS, "vram8|ram32", [M("cfg-a", "ok", "moe", 20), M("cfg-b", "ok", "dense", 10), M("other", "ok", "dense", 1)]), "cfg-b");
check("classConfig: another class's config does not apply",
  cc(REFS, "vram16|ram64", [M("cfg-a", "ok", "moe", 20)]), "");
check("classConfig: unknown class ('') → ''",
  cc(REFS, "", [M("cfg-a", "ok", "moe", 20)]), "");
check("classConfig: ref model not runnable (fit no) → ''",
  cc(REFS, "vram8|ram32", [M("cfg-a", "no", "moe", 20)]), "");
check("classConfig: ref model absent from the list → ''",
  cc(REFS, "vram8|ram32", [M("other", "ok", "dense", 1)]), "");
check("classConfig: embed + use-limited refs are never auto-picked (§10 guards)",
  cc(REFS, "vram8|ram32", [M("cfg-a", "ok", "dense", 5, { embed: true }), M("cfg-b", "ok", "dense", 9, { useLimited: true })]), "");
check("classConfig: a narrowed fitSet applies (FIT_GPU drops a cpu-fit config)",
  cc(REFS, "vram8|ram32", [M("cfg-a", "cpu", "moe", 20)], FIT_GPU), "");
check("classConfig: empty refs → ''", cc([], "vram8|ram32", [M("cfg-a", "ok", "moe", 20)]), "");

// ── §7.4-as-ranking (fit-redesign Phase 7): THIS-box evidence beats the estimate's
//    veto. `ranHere` = the server saw a persisted measurement/tune/load-footprint
//    row for this machine_key — the box PROVABLY ran the model, so a "no" estimate
//    may not exclude it from the recommendation. Without evidence the estimate
//    still filters (the seeded class config alone proves nothing — extrapolations). ──
check("classConfig §7.4: a ranHere model survives a 'no' estimate",
  cc(REFS, "vram8|ram32", [M("cfg-a", "no", "moe", 20, { ranHere: true })]), "cfg-a");
check("classConfig §7.4: no evidence → the 'no' estimate still filters (unchanged)",
  cc(REFS, "vram8|ram32", [M("cfg-a", "no", "moe", 20)]), "");
check("classConfig §7.4: evidence bypasses a narrowed fitSet too (FIT_GPU + cpu-fit)",
  cc(REFS, "vram8|ram32", [M("cfg-a", "cpu", "moe", 20, { ranHere: true })], FIT_GPU), "cfg-a");
check("classConfig §7.4: quality still ranks among mixed evidence/estimate candidates",
  cc(REFS, "vram8|ram32",
    [M("cfg-a", "no", "moe", 20, { ranHere: true }), M("cfg-b", "ok", "dense", 10)]), "cfg-b");
check("classConfig §7.4: evidence never rescues embed/use-limited (the §10 guards hold)",
  cc(REFS, "vram8|ram32", [M("cfg-a", "no", "dense", 5, { embed: true, ranHere: true })]), "");

// The composed rule (recommendedModelId): a class-config hit for MY class wins; no
// config for my class falls through to the §10 pick. Providers-surface redesign item 2
// (2026-07-06; re-based §9 2026-07-22) — QuickSetup's pick AND the catalog's
// "Recommended for this PC" badge both call THIS.
{
  const models = [M("champ", "ok", "dense", 10), M("mapped", "tight", "moe", 20)];
  const acc = {
    typeOf: (m) => m.type, qualityOf: (m) => m.quality,
    isEmbed: (m) => m.embed, isUseLimited: (m) => m.useLimited,
  };
  check("recommended: a config for MY class wins over §10",
    recommendedModelId(models, { classTuneRefs: [{ modelId: "mapped", classKey: "vram8|ram32" }], myClassKey: "vram8|ram32", ...acc }), "mapped");
  check("recommended: no refs at all → the §10 pick",
    recommendedModelId(models, { classTuneRefs: [], myClassKey: "vram8|ram32", ...acc }), "champ");
  check("recommended: config for another class only → the §10 pick",
    recommendedModelId(models, { classTuneRefs: [{ modelId: "mapped", classKey: "vram24|ram64" }], myClassKey: "vram8|ram32", ...acc }), "champ");
}

// ── #274: pickBestEmbedId — the leftover-VRAM embed rule. The embed CO-RESIDES with
//    the chat model, so eligibility is tier "cpu" (always) OR minVram <= the card's
//    LEFTOVER after the chat pick — never the raw card (the 8GB/8B bug). ──
const E = (id, fit, quality, minVram, tier) =>
  ({ id, fit, type: "dense", quality, embed: true, useLimited: false, minVram, tier });
const pe = (list, leftoverMb) => pickBestEmbedId(list, {
  leftoverMb,
  qualityOf: (m) => m.quality,
  isEmbed: (m) => m.embed,
  minVramOf: (m) => m.minVram,
  tierOf: (m) => m.tier,
});
// The SEEDED ladder shape (seed.py): 8B 50/7000/high · 4B 55/4500/mid ·
// 0.6B 58/1500/cpu · bge-m3 60/1500/cpu · nomic 70/1000/cpu.
const LADDER = [
  E("e8b", "ok", 50, 7000, "high"), E("e4b", "ok", 55, 4500, "mid"),
  E("e06b", "ok", 58, 1500, "cpu"), E("bge", "ok", 60, 1500, "cpu"),
  E("nomic", "ok", 70, 1000, "cpu"),
];
check("THE #274 BUG: 8GB card, 7000-need chat (leftover 1192) → 0.6B, never the 8B",
  pe(LADDER, 1192), "e06b");
check("the reporter's box shape: leftover 4192 (8GB − the 4000-floor MoE) → 0.6B (4B needs 4500)",
  pe(LADDER, 4192), "e06b");
check("mid card: leftover 5000 → the 4B rung", pe(LADDER, 5000), "e4b");
check("big card: leftover 7000 → the 8B", pe(LADDER, 7000), "e8b");
check("CPU-only box (leftover 0): the CPU band always qualifies; 0.6B (58) beats bge (60)",
  pe(LADDER, 0), "e06b");
check("non-embeds are never candidates (a chat row can't win the embed pick)",
  pe([...LADDER, M("chat", "ok", "dense", 1)], 99999), "e8b");
check("no CPU band + nothing clears the leftover → least-minVram fallback (never empty)",
  pe([E("big", "ok", 50, 7000, "high"), E("mid", "ok", 55, 4500, "mid")], 1000), "mid");
check("unrunnable embeds (fit \"no\") are excluded even with the best rank",
  pe([E("dead", "no", 1, 100, "cpu"), E("ok6", "cpu", 58, 1500, "cpu")], 0), "ok6");
check("no embeds at all → ''", pe([M("chat", "ok", "dense", 1)], 5000), "");
check("empty input → ''", pe([], 5000), "");

// ── catalogState (decision ④, 2026-08-05): the wizard's confirm branch. An app that
//    seeds NO chat rows (the shared DEFAULT_CATALOG is empty now) must see the
//    "empty" state — the no-fit copy would blame the machine for an empty list. ──
const cs = (models) => catalogState(models, { isEmbed: (m) => m.embed });
check("catalogState: no rows at all → empty", cs([]), "empty");
check("catalogState: only embed rows → empty (no CHAT rows)",
  cs([M("e", "ok", "dense", 50, { embed: true })]), "empty");
check("catalogState: chat rows, none fit → none-fit",
  cs([M("d-no", "no", "dense", 10), M("d-cpu", "cpu", "dense", 20)]), "none-fit");
check("catalogState: a fitting chat row → ok",
  cs([M("d-no", "no", "dense", 10), M("m-tight", "tight", "moe", 20)]), "ok");

console.log(`\n§10 + class-config + composed-pick + #274-embed + catalog-state truth-table: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);

