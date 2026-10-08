// SPDX-License-Identifier: MIT
// Interim stand-ins for modules a later slice ports (build sheet rule 23: import them anyway
// and mock them in tests). Measured under vitest 4.1.11: a mock of a file that does NOT
// exist is keyed by its raw specifier, so a test registers the specifier the src/ module
// imports with —
//
//   vi.mock("./identity.js", async () => (await import("./fixtures/wave-stubs.js")).stub("llm/identity.js"));
//
// — and it catches `import * as identity from "./identity.js"` in src/llm/stores.js only
// while src/llm/identity.js is missing. Once the file lands, the import resolves to it and
// the stand-in no longer applies: the tests switch to the real code with no edit.
//
// Delete this file and the tests' vi.mock lines once llm/switch_resolve.js and
// llm/identity.js (wave 2) exist.

const STUBS = {
  // switch_resolve.py's two backend predicates (unwired context: "" → every row applies).
  "llm/switch_resolve.js": {
    activeBackend: () => "",
    tuneRowApplies: (rowBackend, active = null) => {
      const act = active ?? "";
      if (!act) return true;
      return ((rowBackend || "").trim() || "cuda") === act;
    },
  },
  "llm/identity.js": {
    computedRowNumbers: () => {
      throw new Error("identity.js is not ported yet (wave 2) — this test reached computedRowNumbers");
    },
  },
};

/** The stand-in for `src/<rel>`. */
export function stub(rel) {
  if (!STUBS[rel]) throw new Error(`no stand-in for ${rel}`);
  return STUBS[rel];
}
