// SPDX-License-Identifier: GPL-3.0-or-later
// Shared client for the hardware-class tune library (/v1/ai/class-tunes — ROUND 8
// Task C). ONE source for the endpoint paths + the class-key display label, used by
// the Tune modal's "Save for PC class" action, its LuClassTunes drawer, and
// QuickSetup's class-tune-matched check (the modelDefaults.js precedent: a small
// shared module instead of three fetch copies).
import { request } from "./client.js";

// The whole library + the CURRENT box's class key (server-derived, override-aware):
// { classKey, classes: [{classKey, vramGb, ramGb, name, builtIn}],
//   tunes: [{ modelId, classKey, builtIn, rows: [{flagName, flagValue}] }] }
export async function listClassTunes() {
  return request("/v1/ai/class-tunes");
}

// Add/edit a NAMED hardware class (2026-07-22, type-first). The server DERIVES the
// classKey from memType+vramGb+ramGb; `origClassKey` (edit only) lets a change relocate
// the class's configs. `memType` = discrete | integrated | unified (discrete uses
// vramGb+ramGb; the one-pool types use ramGb as the memory). Returns the whole library.
export async function saveHardwareClass({ name = "", memType = "discrete", vramGb, ramGb, origClassKey = "" }) {
  return request("/v1/ai/hardware-class", {
    method: "PUT",
    body: { name, memType, vramGb: Number(vramGb) || 0, ramGb: Number(ramGb) || 0, origClassKey },
  });
}

// Delete a hardware class AND its model-configs. Returns the updated library.
export async function deleteHardwareClass(classKey) {
  return request(`/v1/ai/hardware-class?classKey=${encodeURIComponent(classKey)}`, {
    method: "DELETE",
  });
}

// Replace one (model, class) config wholesale. `classKey` omitted/"" → the current
// box's class (the "Save for PC class" path). `switches` = { name: value }.
export async function putClassTune(modelId, switches, classKey = "") {
  return request("/v1/ai/class-tunes", {
    method: "PUT",
    body: {
      modelId,
      classKey,
      switches: Object.entries(switches || {}).map(([flagName, flagValue]) => ({
        flagName, flagValue: String(flagValue ?? ""),
      })),
    },
  });
}

// ⚠ ONE-KEY WRITERS, READ FIRST: both tune endpoints are wholesale REPLACE, not merge
// (class-tunes deletes every row of the (model, class) pair before inserting,
// stores.py:970-975; model-tunes pinned by test_model_tunes::test_put_replaces_the_whole_set).
// A caller changing ONE key MUST GET the full set and send it all back — a partial PUT
// silently destroys the row's other switches. The shared upsert helpers that guarded this
// (upsertSwitchRows/mergeClassSwitches) were DELETED 2026-07-16 with their only consumer
// (the chip's layer-writing save — superseded by the preset tier); recover them from git
// history before hand-rolling a new partial write.

export async function deleteClassTune(modelId, classKey) {
  const q = `modelId=${encodeURIComponent(modelId)}&classKey=${encodeURIComponent(classKey)}`;
  return request(`/v1/ai/class-tunes?${q}`, { method: "DELETE" });
}

// The user-facing name for a PC class (the 2026-07-26 copy noun; the internal key and
// the /v1/ai/hardware-class route keep the hardware-class vocabulary). A non-blank `name` (the free label,
// 2026-07-22) wins; else the plain-words hardware from the type-first key —
// `dgpu-vram8|ram32` → "8 GB VRAM · 32 GB RAM", `igpu-mem16` → "Integrated GPU · 16 GB",
// `unified-mem192` → "Unified memory · 192 GB". No internal key syntax in copy; an
// unrecognized shape renders verbatim rather than lying. Callers passing only `key`
// keep the plain-words behavior (name defaults blank).
export function classKeyLabel(key, name = "") {
  if (name && name.trim()) return name.trim();
  let m = /^dgpu-vram(\d+)\|ram(\d+)$/.exec(key || "");
  if (m) return `${m[1]} GB VRAM · ${m[2]} GB RAM`;
  m = /^unified-mem(\d+)$/.exec(key || "");
  if (m) return `Unified memory · ${m[1]} GB`;
  m = /^igpu-mem(\d+)$/.exec(key || "");
  if (m) return `Integrated GPU · ${m[1]} GB`;
  return key || "";
}

// ── the BAND ladders — DESCRIBING a key, never computing one ──────────────────
// Copies of `runner/hardware.py:151,177,178` (`_RAM_LADDER`, `_VRAM_BANDS`,
// `_DGPU_RAM_RUNGS`). A discrete class key is COARSE by charter (hardware.py:200):
// VRAM rounds to the nearest GB and then DOWN-snaps `VRAM_BANDS`, while system RAM
// snaps the fine `RAM_LADDER` (OEM-reserve jitter) and then down-snaps
// `DGPU_RAM_RUNGS` — so one key stands for a RANGE of machines, and the short label
// above prints only that range's floor. A 10 GB RTX 3080 keying to `vram8` reads
// "8 GB VRAM", a number BELOW the user's own card; that is what the range label
// below exists to stop.
// Python remains the only place a key is COMPUTED — these numbers merely describe a
// key already computed there, so drift can mislabel but can never misroute. Drift is
// caught in the repo where hardware.py changes: `tests/test_class_label_ladders.py`
// reads THIS file and fails if the three ladders disagree.
export const VRAM_BANDS = [4, 6, 8, 12, 16, 24];
export const DGPU_RAM_RUNGS = [16, 32, 64, 128];
export const RAM_LADDER = [2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024];

// The largest rung <= gb; below the floor the value passes through (hardware.py:181-184).
export function bandOf(gb, ladder) {
  const fits = ladder.filter((v) => v <= gb);
  return fits.length ? Math.max(...fits) : gb;
}

// ── Class MEMBERSHIP — which PC classes can a model run on (2026-07-26) ──────
// The user's model of the whole system, in one sentence: "for the models we ship
// we put them in hardware class so the user at least has an idea of what hardware
// they need to run the model" — and "all models have class, all of them". A model
// BELONGS to every class whose hardware clears its usability floors; TUNED (has
// switch rows there) is a separate axis. The two surfaces both read THIS function —
// the catalog row lists a model's classes, the PC-class-configs library lists a
// class's models — so they can never disagree (before this, the library listed
// EVERY model under EVERY class, which put a 70B under "Integrated GPU · 32 GB"
// as merely "not tested").
//
// The thresholds are the FIT ENGINE's, not new ones (llm_runner/runner/fit.py
// coarse_fit): RAM is a hard gate (fit.py:101 — a MoE offloads experts to RAM, so
// too-little RAM is a no regardless of card); VRAM allows the same 1.5× slack fit
// calls "tight" (fit.py:109 — the 12B at 8.5 GB need on an 8 GB card measured
// 39 tok/s, so tight is genuinely runnable); the TOP VRAM band is open-ended
// ("24 GB and above", vramPhrase below), so a 48 GB card lands in a vram24 class
// and the 70B belongs exactly there; an integrated class is ONE memory pool, so
// both floors must fit inside it.
export function modelBelongsToClass(minVramMb, minRamMb, cls) {
  if (!minVramMb || !minRamMb || !cls) return false; // unknown floors → claim nothing
  const ramMb = (cls.ramGb || 0) * 1024;
  if (cls.memType === "integrated") {
    return minVramMb <= ramMb && minRamMb <= ramMb;
  }
  if (minRamMb > ramMb) return false;
  const topBand = VRAM_BANDS[VRAM_BANDS.length - 1];
  if ((cls.vramGb || 0) >= topBand) return true;
  return minVramMb / ((cls.vramGb || 0) * 1024 || 1) <= 1.5;
}

/** A model's member classes, DISPLAY-ORDERED: discrete first (by VRAM, then RAM),
 *  integrated last (by pool). Input: the `classes` array `listClassTunes()` returns. */
export function memberClassesOf(minVramMb, minRamMb, classes) {
  return (classes || [])
    .filter((c) => modelBelongsToClass(minVramMb, minRamMb, c))
    .sort((a, b) =>
      (a.memType === "integrated") - (b.memType === "integrated")
      || (a.vramGb || 0) - (b.vramGb || 0)
      || (a.ramGb || 0) - (b.ramGb || 0));
}

/** The compact per-row form of a class name — "8|32" (8 GB VRAM · 32 GB RAM) for
 *  discrete, "iGPU 32" for integrated. The catalog row lists up to a dozen classes,
 *  where the full range labels would swamp the line; hovers carry the long form. */
export function shortClassLabel(cls) {
  return cls.memType === "integrated" ? `iGPU ${cls.ramGb}` : `${cls.vramGb}|${cls.ramGb}`;
}

// VRAM: one snap, so the band covers a contiguous run of whole GB — 8 covers 8…11.
function vramPhrase(gb) {
  if (!VRAM_BANDS.includes(gb)) return `${gb} GB VRAM`;   // below the floor — an exact, unbanded key
  const next = VRAM_BANDS.find((v) => v > gb);
  if (next === undefined) return `${gb} GB VRAM and above`;
  return next - gb === 1 ? `${gb} GB VRAM` : `${gb}–${next - 1} GB VRAM`;
}

// RAM: TWO snaps (nearest ladder rung, THEN down-snap), so `ram32` holds both 32 GB
// and 48 GB boxes. Naming the nominal capacities beats printing the raw interval —
// people know their machine as "48 GB", not as "somewhere between 28 and 56"
// (the user's call, 2026-07-26).
function ramPhrase(gb) {
  if (!DGPU_RAM_RUNGS.includes(gb)) return `${gb} GB RAM`;
  const next = DGPU_RAM_RUNGS.find((v) => v > gb);
  if (next === undefined) return `${gb} GB RAM and above`;
  const members = RAM_LADDER.filter((v) => v >= gb && v < next);
  return members.length > 1 ? `${members.join(" or ")} GB RAM` : `${gb} GB RAM`;
}

// The class label that says out loud that a class is a RANGE, for the surfaces where
// the user reasons about classes (the classes panel and its editor). The short
// `classKeyLabel` stays the form for tight spots — a badge, or a running sentence.
//
// i18n NOTE (deliberate, for the kit's later vue-i18n batch — the peer-dep decision in
// justwrite-app/docs/plans/2026-07-26-i18n-phase1-coverage-plan.md:6): each phrase above
// is a COMPLETE sentence per form — "and above" is its own message, never a suffix glued
// onto another one (Ruling 6, that plan :151-158). The two halves are joined by " · " as
// a LIST of two noun phrases, so the conversion is `{vram} · {ram}` taking pre-rendered
// parts — a named choice, not an accident: the alternative is nine whole-label messages
// for every range/top/exact combination, which buys nothing here.
export function classKeyRangeLabel(key, name = "") {
  if (name && name.trim()) return name.trim();
  const m = /^dgpu-vram(\d+)\|ram(\d+)$/.exec(key || "");
  if (m) return `${vramPhrase(Number(m[1]))} · ${ramPhrase(Number(m[2]))}`;
  return classKeyLabel(key);   // igpu/unified are ONE exact pool — never banded (hardware.py:193-196)
}
