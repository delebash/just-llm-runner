// SPDX-License-Identifier: MIT
// Port of tests/test_class_label_ladders.py — the kit's class-label ladders must equal the
// runner's.
//
// `ui/src/classTunes.js` copies two ladders out of `runner/hardware` so it can say what a
// class key COVERS ("8-11 GB VRAM") instead of printing only the band's floor. The server
// stays the only place a key is COMPUTED, so a drifted copy can mislabel but never misroute
// — still, the copy has to be pinned, in the repo where the originals change. Adding a band
// later (a future card class that deserves its own band adds ONE ladder value) therefore
// fails HERE, naming the JS file to update.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { _DGPU_RAM_RUNGS, _VRAM_BANDS } from "../src/runner/hardware.js";

const CLASS_TUNES_JS = fileURLToPath(new URL("../../ui/src/classTunes.js", import.meta.url));

/** Parse `export const NAME = [1, 2, 3];` out of the kit module. */
function jsIntArray(source, name) {
  const m = new RegExp(`export const ${name} = \\[([^\\]]*)\\];`).exec(source);
  expect(m, `${name} not found in ${CLASS_TUNES_JS} — was it renamed or reformatted?`).toBeTruthy();
  const values = [...m[1].matchAll(/\d+/g)].map((x) => Number(x[0]));
  // Vacuity guard: a rename/reformat that made the regex match an EMPTY body would
  // otherwise sail through the equality assert below with two empty lists.
  expect(values.length, `${name} parsed as empty — the guard would compare nothing`).toBeGreaterThan(0);
  return values;
}

test("kit_label_ladders_match_hardware_py", () => {
  expect(existsSync(CLASS_TUNES_JS), `the kit module is missing at ${CLASS_TUNES_JS}`).toBe(true);
  const src = readFileSync(CLASS_TUNES_JS, "utf8");
  expect(jsIntArray(src, "VRAM_BANDS")).toEqual([..._VRAM_BANDS]);
  expect(jsIntArray(src, "DGPU_RAM_RUNGS")).toEqual([..._DGPU_RAM_RUNGS]);
  // RAM_LADDER used to be copied into the kit as well; that label is gone (2026-07-26, the
  // user ruled the floor form) and the JS copy went with it — only the runner still snaps
  // with `_RAM_LADDER`. If a kit label ever needs those capacities again, re-copy the ladder
  // AND restore an assertion here. Match a DECLARATION, not the bare word: the kit's
  // comments still explain why the ladder left.
  expect(/export const RAM_LADDER\s*=/.test(src), "the kit re-declared RAM_LADDER — restore the equality assertion against _RAM_LADDER").toBe(false);
});
