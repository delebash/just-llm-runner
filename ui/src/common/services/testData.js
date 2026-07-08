// SPDX-License-Identifier: GPL-3.0-or-later
// The Lab test-data source registry (§7.3, 2026-07-08): the HOST app registers
// named sources of real test material — JW: chapters/characters/locations; JV
// later: game lines/podcast segments — and the Lab's Test input offers "Insert
// from <source>" pickers. A source: { id, label, kind, list() → [{id,label}],
// fetch(id) → {variables} }. Empty registry = the Lab's manual fill, unchanged.
// Boot-config seam like configureHelp/configureDialog/configureExternal.

let _sources = [];

export function configureTestData({ sources = [] } = {}) {
  _sources = Array.isArray(sources) ? sources : [];
}

export function testDataSources() {
  return _sources;
}

/** QC-9 (queue §9): can this source fill at least one of the open prompt's
 *  variables? Sources declare `provides: [names]`; a picker renders only when
 *  an exact-name fill exists, or the single-single bridge below would apply
 *  (1 provided name × 1 prompt var). A source with NO provides list is always
 *  offered — hosts that haven't declared stay on the old always-visible path. */
export function sourceCanFill(source, varNames) {
  const provides = source?.provides;
  if (!Array.isArray(provides) || !provides.length) return true;
  const names = (varNames || []).filter(Boolean);
  if (names.some((n) => provides.includes(n))) return true;
  return provides.length === 1 && names.length === 1;
}

/** Merge fetched sample/source variables into the Lab's vars object:
 *  exact-name matches win; and when the payload carries exactly ONE variable
 *  while the prompt exposes exactly ONE, the value bridges regardless of name
 *  (a chapter's {text} fills a prompt's {user_content} — the pragmatic bridge,
 *  recorded in the queue doc §3 B4 record). Returns how many vars were set. */
export function mergeVariables(vars, incoming) {
  const inc = incoming || {};
  const keys = Object.keys(inc);
  let set = 0;
  for (const k of keys) {
    if (k in vars) {
      vars[k] = inc[k];
      set += 1;
    }
  }
  const varNames = Object.keys(vars);
  if (!set && keys.length === 1 && varNames.length === 1) {
    vars[varNames[0]] = inc[keys[0]];
    set = 1;
  }
  return set;
}
