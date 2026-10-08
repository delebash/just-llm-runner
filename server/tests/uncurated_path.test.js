// SPDX-License-Identifier: MIT
// Port of tests/test_uncurated_path.py — §7.3, the uncurated-path acceptance test
// (fit-redesign, Phase 7).
//
// A FRESH DB with NO seed rows, a MoE hand-added BY LINK (the HF header read faked with a
// byte-faithful Gemma-4-26B-class iSWA header), on a simulated 8 GB-VRAM / 32 GB-RAM box: the
// badge, the floors, the ctx and the split must come out sane with nobody having curated
// anything. This is the path where every defect in the plan's evidence index lived — the
// MoE-blind floor lie ("Won't fit" on a model the box runs, §1.4), the hand-typed floors, the
// ctx handout, the inverse split — because the SEEDED rows had hand-fitted numbers papering
// over all of it. The launchable half of the §7.3 pin (a "no"-badged model still loads) lives
// in lifecycle.test.js, where the service harness is.
//
// Python's monkeypatch of `gguf_remote.fetch_gguf_meta` / `models.find_inherited_mtp_drafter`
// → `vi.spyOn` on those namespaces (identity calls them through them).
import { expect, test, vi } from "vitest";
import * as identity from "../src/llm/identity.js";
import { CatalogRow } from "../src/llm/model_catalog_api.js";
import * as stores from "../src/llm/stores.js";
import { model } from "../src/platform/models.js";
import { pyRound } from "../src/platform/py.js";
import * as fit from "../src/runner/fit.js";
import { GgufMeta } from "../src/runner/gguf.js";
import * as ggufRemote from "../src/runner/gguf_remote.js";
import * as runnerModels from "../src/runner/models.js";
import { computeFit } from "../src/runner/process.js";
import { HardwareInfo } from "../src/runner/schema.js";
import { freshDb } from "./helpers.js";

// A Gemma-4-26B-class MoE header, byte-faithful where it matters: the 5:1 windowed:global iSWA
// pattern with per-layer KV heads reproduces the real file's KV scalars (windowed 102400
// B/token, global 10240 — the seeded facts), and the expert dims give expertByteShare ≈ 0.92
// (real: 0.9389).
const META = new GgufMeta({
  architecture: "gemma4moe",
  blockCount: 30,
  embeddingLength: 2816,
  expertCount: 128,
  expertUsedCount: 8,
  headCount: 16,
  contextLength: 131072,
  expertFeedForwardLength: 1024,
  feedForwardLength: 8192,
  headCountKvPerLayer: Array.from({ length: 30 }, (_, i) => (i % 6 !== 5 ? 16 : 8)),
  slidingWindow: 1024,
  slidingWindowPattern: Array.from({ length: 30 }, (_, i) => i % 6 !== 5),
  keyLength: 128,
  valueLength: 128,
  keyLengthSwa: 128,
  valueLengthSwa: 128,
  sizeLabel: "128x2.6B",
});
const BYTES = 14_249_047_104;

const box832 = () =>
  model(HardwareInfo, {
    os: "Windows",
    platform: "windows",
    cpuCores: 16,
    ramMb: 32768,
    gpus: [{ vendor: "NVIDIA", name: "dgpu", vramMb: 8192 }],
    runtimes: { cuda: true },
  });

test("hand_added_moe_by_link_is_sane_on_8_32", async () => {
  freshDb();
  vi.spyOn(ggufRemote, "fetchGgufMeta").mockResolvedValue([META, BYTES]);
  // The tier-C drafter probe is advisory network discovery — not this test.
  vi.spyOn(runnerModels, "findInheritedMtpDrafter").mockResolvedValue(null);

  // 1) READ FROM LINK — the Add form's pre-download inspect.
  const out = await identity.inspectModelFromLink("someone/Big-MoE-GGUF", "UD-Q4_K_XL");
  expect(out.type === "moe" && out.experts === 128).toBe(true);
  expect(out.sizeBytes).toBe(BYTES);
  const facts = out.physicsFacts;
  expect(facts.block_count).toBe(30);
  expect(facts.kv_windowed_bytes_per_token).toBe(102400.0); // the real file's scalar
  expect(facts.kv_global_bytes_per_token).toBe(10240.0);
  expect(facts.expert_byte_share > 0.85 && facts.expert_byte_share < 0.99).toBe(true);

  // 2) SAVE — the form PUT's door (a chat row types NO floors, §13.17: the user never enters
  //    one; every number below is computed, not curated).
  stores.getModelCatalogStore().upsert(
    model(CatalogRow, {
      id: "hand-added-moe",
      name: "Hand-added MoE",
      hfRepo: "someone/Big-MoE-GGUF",
      quant: "UD-Q4_K_XL",
      type: out.type,
      trainedCtx: out.trainedCtx,
      experts: out.experts,
      sizeLabel: out.sizeLabel,
      totalParams: out.totalParams,
      sizeBytes: out.sizeBytes,
      estVramMb: out.estVramMb,
      physicsFacts: facts,
    }),
  );

  // 3) THE WIRE ROW — floors + est computed FRESH from the stored facts.
  const row = stores
    .getModelCatalogStore()
    .list()
    .find((r) => r.id === "hand-added-moe");
  expect(row.minRamMb).toBe(pyRound(BYTES / (1024 * 1024) + 4096)); // file + headroom, MiB (vram-truth §6.4)
  expect(row.minVramMb > 1500 && row.minVramMb < 6000).toBe(true); // max-offload floor: non-expert + KV(4k) + overhead
  expect(row.estVramMb > 12000 && row.estVramMb < 20000).toBe(true); // full-residency want at 8k ctx
  expect(row.minVramMb).toBeLessThan(row.estVramMb);

  // 4) THE BADGE on the 8/32 box — runnable, never the MoE-blind "no".
  const badge = fit.coarseFit({
    totalParams: row.totalParams || null,
    quant: row.quant,
    vramMb: 8192,
    ramMb: 32768,
    marginMb: 1024,
    minVramOverride: row.minVramMb,
    minRamOverride: row.minRamMb,
  });
  expect(["ok", "tight"]).toContain(badge);
  // The §1.4 lie this test exists to catch, kept visible: without the computed floor the
  // params×quant estimate charges the WHOLE 26B to VRAM → "no".
  expect(
    fit.coarseFit({
      totalParams: "26B",
      quant: row.quant,
      vramMb: 8192,
      ramMb: 32768,
      marginMb: 1024,
      minVramOverride: null,
      minRamOverride: row.minRamMb,
    }),
  ).toBe("no");

  // 5) THE SPLIT — untuned computeFit on the same box: all layers on the GPU with just-enough
  //    experts in RAM (the joint solve), ctx a ladder value under the cap, the booking inside
  //    the card.
  const plan = computeFit(META, BYTES, box832());
  expect(plan.nGpuLayers).toBe(30);
  expect(plan.nCpuMoe >= 15 && plan.nCpuMoe <= 30).toBe(true);
  expect(plan.ctxLen >= 4096 && plan.ctxLen <= 32768).toBe(true);
  expect(plan.vramMb > 0 && plan.vramMb <= 8192).toBe(true);
});
