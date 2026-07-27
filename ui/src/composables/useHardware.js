// SPDX-License-Identifier: GPL-3.0-or-later
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
// fields no accessor should guess at: QuickSetup renders the whole probe, and
// AiModelsArea builds a change fingerprint from `gpus[0]` — deliberately left on the first
// GPU rather than corrected to the largest, since changing that rule would mismatch every
// stored `ackHwFingerprint` once and fire a spurious "your graphics hardware changed"
// toast at every user. Fixing it is a separate change with a migration question attached.
import { computed, ref } from "vue";

import { request } from "../client.js";

const hardware = ref(null);

/** The raw probe response ({ gpus: [{name, vramMb}], ramMb, … }), or null before the
 *  first successful refresh. Prefer the accessors below; reach in only for a field they
 *  do not cover. */
export const hardwareInfo = hardware;

/** THE GPU this box serves from: the LARGEST, which is the server's own rule
 *  (`max_vram_mb`, hardware.py:45, and the class-key builder at :212). Never `gpus[0]` —
 *  that names the iGPU on laptops that enumerate it first, and every consumer here that
 *  reached for `gpus[0]` meant "this machine's card". null on a CPU-only box. */
export const mainGpu = computed(() => {
	const gpus = hardware.value?.gpus || [];
	if (!gpus.length) return null;
	return gpus.reduce((best, g) =>
		(g.vramMb || 0) > (best.vramMb || 0) ? g : best,
	);
});

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

/** Shared hardware. Every consumer gets the SAME refs; call refresh() on open. */
export function useHardware() {
	return { hardwareInfo, mainGpu, maxVramMb, ramMb, hardwareLabel, refresh };
}
