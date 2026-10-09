// SPDX-License-Identifier: MIT
// UiTable's row rules — the global filter, the sort and its click cycle — kept exactly as the
// table had them under TanStack Table (Q3 slice 8, docs/plans/2026-10-09-kit-controls-on-quasar.md:
// QTable renders the rows, these decide them, so no table re-orders under its users).
//
// The sorting functions, the automatic choice of one, the first direction and the click cycle are
// ported from TanStack Table's table-core 8 (sortingFns.js, features/RowSorting.js,
// utils/getSortedRowModel.js, features/GlobalFiltering.js), under its licence:
//
//   MIT License
//
//   Copyright (c) 2016 Tanner Linsley
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy
//   of this software and associated documentation files (the "Software"), to deal
//   in the Software without restriction, including without limitation the rights
//   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
//   copies of the Software, and to permit persons to whom the Software is
//   furnished to do so, subject to the following conditions:
//
//   The above copyright notice and this permission notice shall be included in all
//   copies or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
//   SOFTWARE.

const reSplitAlphaNumeric = /([0-9]+)/gm;

function toText(a) {
  if (typeof a === "number") return Number.isNaN(a) || a === Number.POSITIVE_INFINITY || a === Number.NEGATIVE_INFINITY ? "" : String(a);
  return typeof a === "string" ? a : "";
}
function compareBasic(a, b) {
  return a === b ? 0 : a > b ? 1 : -1;
}
function compareAlphanumeric(aStr, bStr) {
  const a = aStr.split(reSplitAlphaNumeric).filter(Boolean);
  const b = bStr.split(reSplitAlphaNumeric).filter(Boolean);
  while (a.length && b.length) {
    const aa = a.shift();
    const bb = b.shift();
    const an = Number.parseInt(aa, 10);
    const bn = Number.parseInt(bb, 10);
    const combo = [an, bn].sort();
    if (Number.isNaN(combo[0])) {
      if (aa > bb) return 1;
      if (bb > aa) return -1;
      continue;
    }
    if (Number.isNaN(combo[1])) return Number.isNaN(an) ? -1 : 1;
    if (an > bn) return 1;
    if (bn > an) return -1;
  }
  return a.length - b.length;
}
const SORTING = {
  alphanumeric: (a, b) => compareAlphanumeric(toText(a).toLowerCase(), toText(b).toLowerCase()),
  text: (a, b) => compareBasic(toText(a).toLowerCase(), toText(b).toLowerCase()),
  datetime: (a, b) => (a > b ? 1 : a < b ? -1 : 0),
  basic: (a, b) => compareBasic(a, b),
};

// TanStack's "auto" sorting function, from the filtered rows' values (it looks at the rows from
// the tenth on — its own slice(10)).
function autoSortingFn(values) {
  let isString = false;
  for (const value of values.slice(10)) {
    if (Object.prototype.toString.call(value) === "[object Date]") return SORTING.datetime;
    if (typeof value === "string") {
      isString = true;
      if (value.split(reSplitAlphaNumeric).length > 1) return SORTING.alphanumeric;
    }
  }
  return isString ? SORTING.text : SORTING.basic;
}

// The direction a first click sorts in: a column whose first (filtered) value is a string sorts
// ascending, any other descending.
export function firstSortDir(firstValue) {
  return typeof firstValue === "string" ? "asc" : "desc";
}

// The next state of a column's sort on a click: its first direction, then the other, then —
// unless removal is off — no sort.
export function nextSortingOrder(isSorted, firstDir, removal) {
  if (!isSorted) return firstDir;
  if (isSorted !== firstDir && removal) return false;
  return isSorted === "desc" ? "asc" : "desc";
}

// `rows` sorted by one column (values from `valueOf(row)`): undefined values after the others
// ascending and before them descending (TanStack's sortUndefined: 1), ties in data order
// (`indexOf(row)`).
export function sortRows(rows, valueOf, desc, indexOf) {
  const fn = autoSortingFn(rows.map(valueOf));
  return [...rows].sort((rowA, rowB) => {
    const a = valueOf(rowA);
    const b = valueOf(rowB);
    let sortInt = 0;
    const aUndefined = a === undefined;
    const bUndefined = b === undefined;
    if (aUndefined || bUndefined) sortInt = aUndefined && bUndefined ? 0 : aUndefined ? 1 : -1;
    if (sortInt === 0) sortInt = fn(a, b);
    if (sortInt !== 0) return desc ? -sortInt : sortInt;
    return indexOf(rowA) - indexOf(rowB);
  });
}

// Whether a column takes part in the global filter: TanStack's default asks whether the FIRST
// data row's value there is a string or a number.
export function canGlobalFilter(firstValue) {
  return typeof firstValue === "string" || typeof firstValue === "number";
}
