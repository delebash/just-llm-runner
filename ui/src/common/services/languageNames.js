// SPDX-License-Identifier: MIT
// Language CODE → the name a person reads. Shared, because every app in the
// family shows language somewhere: JustVoice lists voices by language,
// JustWrite and docgen carry target languages.
//
// Built on Intl.DisplayNames rather than a hand-kept table — a table of
// language names is a translation job that goes stale, and the runtime
// already ships one that follows the UI locale. `en-US` renders as
// "American English", `zh` as "Chinese".
//
// The codes arriving here are NOT uniform. JustVoice's Kokoro catalog alone
// mixes regioned tags (`en-US`, `en-GB`, `pt-BR`) with bare ones (`zh`, `ja`,
// `hi`, `es`, `it`, `fr`), so this handles both and never assumes a region.
//
//   import { languageName, languageOptionsFrom } from "@delebash/llm-ui";
//   languageName("en-GB")                  // "British English"
//   languageOptionsFrom(["zh", "en-US"])   // [{ label, value }, …] sorted by label

import { computed } from "vue";

import { uiLocale } from "./locale.js";

/** Per-locale memo — a grid asks for the same handful of codes on every row. */
const _cache = new Map();

function _formatter(locale) {
  const key = locale || "";
  if (!_cache.has(key)) {
    let dn = null;
    try {
      dn = new Intl.DisplayNames(locale ? [locale] : undefined, {
        type: "language",
        // A tag we can't name reads better as itself than as "Unknown".
        fallback: "code",
      });
    } catch {
      dn = null; // ancient runtime: every lookup falls through to the raw code
    }
    _cache.set(key, { dn, names: new Map() });
  }
  return _cache.get(key);
}

/**
 * The display name for one language code.
 *
 * Returns the code unchanged when it is empty, structurally invalid, or
 * unknown to the runtime — never "undefined" and never an empty cell.
 *
 * @param {string} code  a BCP-47 tag, regioned or bare ("en-US", "zh")
 * @returns {string}
 */
export function languageName(code) {
  const raw = String(code || "").trim();
  if (!raw) return "";
  const { dn, names } = _formatter(uiLocale.value);
  if (names.has(raw)) return names.get(raw);
  let out = raw;
  if (dn) {
    try {
      out = dn.of(raw) || raw;
    } catch {
      // Intl throws RangeError on a malformed tag. A bad tag is still the
      // most honest thing to show — the alternative hides the data problem.
      out = raw;
    }
  }
  names.set(raw, out);
  return out;
}

/**
 * A UiSelect option list built from the codes actually present in some data,
 * sorted by the name the user reads (not by code — "zh" sorting before
 * "en-US" is a code order, and nobody reads codes).
 *
 * @param {Iterable<string>} codes  may repeat and may contain blanks
 * @param {object} [opts]
 * @param {string} [opts.allLabel]  prepends an "everything" row when given
 * @param {string} [opts.allValue]  the value that row carries (default "all")
 * @param {Map|object} [opts.counts]  code → n, appended as " (n)"
 * @returns {Array<{label: string, value: string}>}
 */
export function languageOptionsFrom(codes, opts = {}) {
  const { allLabel, allValue = "all", counts } = opts;
  const get = (c) =>
    counts instanceof Map ? counts.get(c) : counts ? counts[c] : undefined;

  const seen = new Set();
  for (const c of codes || []) {
    const raw = String(c || "").trim();
    if (raw) seen.add(raw);
  }

  const rows = [...seen]
    .map((value) => {
      const n = get(value);
      const name = languageName(value);
      return { value, name, label: n === undefined ? name : `${name} (${n})` };
    })
    .sort((a, b) => a.name.localeCompare(b.name, uiLocale.value || undefined));

  const out = rows.map(({ label, value }) => ({ label, value }));
  if (allLabel !== undefined) out.unshift({ label: allLabel, value: allValue });
  return out;
}

/**
 * Reactive wrapper for a component that renders names and must re-render when
 * the host switches UI locale (setUiLocale). Plain `languageName` is fine for
 * one-shot formatting; this is for computed properties.
 */
export function useLanguageNames() {
  return computed(() => ({ languageName, locale: uiLocale.value }));
}
