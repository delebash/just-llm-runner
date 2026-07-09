// SPDX-License-Identifier: GPL-3.0-or-later
// The Lab test-data registry (§7.3, 2026-07-08; rebuilt per QC-35, 2026-07-09):
// the HOST app registers (a) named SOURCES of listable book material — JW:
// chapters/characters; JV later: game lines/podcast segments — and (b) a
// per-ACTION affordance declaration map derived from each action's own prompt
// contract. The Lab renders ONLY what the open action declares; there is no
// generic name-matching and no single-variable bridge (both deleted — QC-35's
// locked mechanism supersedes the B4-4 gate).
//
// A source:      { id, label, kind, list() → [{id, label}] }
// A declaration: {
//   pickers: [{ source: <source id>, fill(id) → Promise<{variables}> }],
//   compose: { label?, run() → Promise<{variables}> },   // "From this book"
//   samples: [<sample labels>],   // which DB samples fit this action's contract
// }
// Every field is optional; an UNDECLARED action gets no pickers and no compose
// button, and Sample cycles the whole taskKind — the freeform default and the
// fallback for hosts that haven't declared. Boot-config seam like
// configureHelp/configureDialog/configureExternal.

let _sources = [];
let _actions = {};

export function configureTestData({ sources = [], actions = {} } = {}) {
  _sources = Array.isArray(sources) ? sources : [];
  _actions = actions && typeof actions === "object" ? actions : {};
}

export function testDataSources() {
  return _sources;
}

/** The affordance declaration for one action key (null = undeclared). */
export function testDataAction(actionKey) {
  return _actions[actionKey] || null;
}

/** Merge fetched sample/picker variables into the Lab's vars object —
 *  EXACT-NAME matches only (QC-35: declarations and samples emit the very
 *  names each prompt exposes, so the old 1×1 any-name bridge is gone).
 *  Returns how many vars were set. */
export function mergeVariables(vars, incoming) {
  const inc = incoming || {};
  let set = 0;
  for (const k of Object.keys(inc)) {
    if (k in vars) {
      vars[k] = inc[k];
      set += 1;
    }
  }
  return set;
}
