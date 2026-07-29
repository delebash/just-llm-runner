// SPDX-License-Identifier: MIT
// check-shared-pickers — the STRUCTURAL "use the shared component, don't hand-code
// it each time" gate (jobs design §17.1).
//
// WHY THIS, NOT (only) a behavior test: the recommendations-dropdown bug was NOT
// really "stale data" — it was a hardcoded job list copy-pasted instead of reusing
// ONE component. A behavior test catches a *stale* copy; it does NOT catch a
// *fresh hand-coded* copy (a new <select v-for="j in jobs"> with live data passes
// a liveness test while still violating reuse). This SOURCE check enforces the
// real rule: a job picker may exist in exactly ONE place — LuJobSelect. A hardcoded
// job list, or a hand-rolled <select>/<option> over jobs anywhere else, fails the
// build. Extend RULES as more shared pickers are converged (#32: providers, models).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

// The seeded job ids (seed.DEFAULT_JOBS + the old SUGGESTED_JOBS extras). An array
// literal that lists two or more of these is a hardcoded job list — the bug.
const CANON_JOBS = ["chat", "prose", "extraction", "analysis", "attribution", "embedding"];

const RULES = [
  {
    name: "hardcoded job list",
    appliesTo: /\.(vue|js|mjs)$/,
    allow: [], // NO file may hardcode the job list — it must read /v1/ai/jobs
    hint: "Use <LuJobSelect/> (it reads /v1/ai/jobs). Never hardcode the job names.",
    find(src) {
      for (const arr of src.match(/\[[^\]]*\]/g) || []) {
        const hits = CANON_JOBS.filter((j) => new RegExp(`["']${j}["']`).test(arr));
        if (hits.length >= 2) return `array literal lists job ids [${hits.join(", ")}]`;
      }
      return null;
    },
  },
  {
    name: "hand-rolled job dropdown",
    appliesTo: /\.vue$/,
    allow: ["LuJobSelect.vue"], // the ONE allowed home (it renders via UiSelect)
    hint: 'Use <LuJobSelect :jobs="jobs"/> instead of a native <select>/<option> over jobs.',
    find(src) {
      if (/<option[^>]*v-for="[^"]*\bin\s+jobs\b/.test(src)) return "native <option v-for in jobs>";
      return null;
    },
  },
];

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const files = walk(SRC);
const violations = [];
for (const f of files) {
  const name = basename(f);
  let src = null;
  for (const rule of RULES) {
    if (!rule.appliesTo.test(f) || rule.allow.includes(name)) continue;
    src ??= readFileSync(f, "utf8");
    const why = rule.find(src);
    if (why) violations.push({ file: f.slice(SRC.length + 1), rule: rule.name, why, hint: rule.hint });
  }
}

if (violations.length) {
  console.error(`✗ shared-picker check: ${violations.length} hand-rolled picker(s) — reuse the shared component:`);
  for (const v of violations) console.error(`    ${v.file}: ${v.rule} (${v.why})\n      → ${v.hint}`);
  process.exit(1);
}
console.log(`✓ shared-picker check: ${files.length} kit files scanned — the job picker lives only in LuJobSelect`);
process.exit(0);
