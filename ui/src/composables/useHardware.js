// SPDX-License-Identifier: MIT
// Shared HARDWARE probe — ONE source for `/v1/llm-runner/hardware` across the AI surfaces
// (2026-07-27). Before this, FIVE independent fetches of the same endpoint lived in four
// files — LuClassTunes, LuModelCatalog, AiModelsArea (twice: the hardware strip and the
// change detector) and QuickSetup — each keeping its own slice of the response, and they
// had already drifted: LuModelCatalog read `gpus[0].vramMb` while the server's own rule is
// the LARGEST GPU (`max_vram_mb`, runner/hardware.py:45, and the class-key builder at
// :212), so on a laptop that enumerates its iGPU first the catalog scored fit against the
// wrong card. That is the extraction-vs-copies shape this codebase keeps paying for.
//
// Modelled on `useCatalogMeta` deliberately (same file, same shape): a module singleton
// with computed by-name accessors and an explicit `refresh()`, NOT a poller — hardware
// does not change while the app runs, except in the one case AiModelsArea checks for on
// purpose, which calls refresh() itself.
//
// `hardware` is exposed RAW as well as through the accessors, because two consumers need
// fields no accessor should guess at: QuickSetup renders the whole probe, and AiModelsArea
// fingerprints a FRESH response (see `largestGpu` below for why that one is pure).
//
// This header used to say AiModelsArea's fingerprint was "deliberately left on gpus[0],
// with a migration question attached". That is no longer true — it was corrected the next
// day (2026-07-27, the user's go), and the accepted cost is one spurious "your graphics
// hardware changed" toast, ONCE, on machines whose first-listed GPU is not their largest.
// Nothing in the kit reads `gpus[0]` any more; a grep that finds it is finding prose.
import { computed, ref } from "vue";

import { request } from "../client.js";

const hardware = ref(null);

/** The raw probe response ({ gpus: [{name, vramMb}], ramMb, … }), or null before the
 *  first successful refresh. Prefer the accessors below; reach in only for a field they
 *  do not cover. */
export const hardwareInfo = hardware;

/** THE rule, as a PURE function over a gpus array: the LARGEST GPU wins, which is the
 *  server's own rule (`max_vram_mb`, hardware.py:45, and the class-key builder at :212).
 *  Never `gpus[0]` — that names the iGPU on laptops that enumerate it first, and every
 *  consumer here that reached for `gpus[0]` meant "this machine's card". null on a
 *  CPU-only box.
 *
 *  Pure, rather than only the computed below, because ONE caller legitimately holds a
 *  response the ref has not been read from yet — AiModelsArea's change detector compares
 *  a FRESH probe against the stored fingerprint. Without this it would re-implement the
 *  max, which is exactly how the three call sites drifted apart in the first place. */
export function largestGpu(gpus) {
	const list = gpus || [];
	if (!list.length) return null;
	return list.reduce((best, g) => ((g.vramMb || 0) > (best.vramMb || 0) ? g : best));
}

/** THE GPU this box serves from, reactively. */
export const mainGpu = computed(() => largestGpu(hardware.value?.gpus));

/** VRAM of that GPU, in MB; 0 when unknown, which every consumer already treats as
 *  "CPU only". */
export const maxVramMb = computed(() => mainGpu.value?.vramMb || 0);

/** System RAM in MB, 0 when unknown. */
export const ramMb = computed(() => hardware.value?.ramMb || 0);

/** THE machine's own specs as one phrase — "8 GB VRAM · 32 GB RAM" (2026-07-26, the user:
 *  "this pc is what it is that is all"). One source, because the same sentence appears
 *  above the class library, above the model catalog, and in the per-model config editor,
 *  and a class FLOOR shown next to it is only honest while all three agree. "" when the
 *  probe has not answered, so callers can fall back rather than print a half-line. */
export const hardwareLabel = computed(() => {
	if (!hardware.value) return "";
	const vram = maxVramMb.value
		? `${Math.round(maxVramMb.value / 1024)} GB VRAM`
		: "";
	const ram = ramMb.value ? `${Math.round(ramMb.value / 1024)} GB RAM` : "";
	return [vram, ram].filter(Boolean).join(" · ");
});

/** Fetch (or re-fetch) the probe. Returns the response so a caller that needs the fresh
 *  value in the same tick — the change detector — does not have to read the ref back.
 *  Swallows failure into `null`: every accessor degrades to 0/"" and no surface here is
 *  worth blocking on a missing probe. */
export async function refresh() {
	try {
		hardware.value = await request("/v1/llm-runner/hardware");
	} catch {
		hardware.value = null;
	}
	return hardware.value;
}

/** Shared hardware. Every consumer gets the SAME refs; call refresh() on open.
 *  `largestGpu` rides along so a consumer can destructure it here rather than adding a
 *  second import line — and so the contract test polices it like every other name. */
export function useHardware() {
	return { hardwareInfo, mainGpu, largestGpu, maxVramMb, ramMb, hardwareLabel, refresh };
}
