// SPDX-License-Identifier: GPL-3.0-or-later
// Node truth-table for the §10 speed-floor auto-pick (ui/src/common/services/modelPick.js).
// The kit has no JS test runner, and a browser render-smoke can't isolate §10's crux branch
// (a dense+tight EXCLUDED while a moe+tight is KEPT) — CARD_OPTIONS is capped at 24 GB until
// Phase 3, so a card-override probe can't construct the two side-by-side deterministically.
// This does, purely and re-runnably.
//   Run:  node scripts/verify-model-pick.mjs      (exit 0 = all pass, 1 = any fail)
import { pickBestModel } from "../ui/src/common/services/modelPick.js";

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

console.log(`\n§10 truth-table: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
