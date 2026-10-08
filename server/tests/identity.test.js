// SPDX-License-Identifier: MIT
// Port of tests/test_identity.py — GGUF identity auto-detect → model_catalog.type (design
// S3 / D17). Pure logic + the catalog write; the GGUF read is injected, so no real GGUF bytes
// are needed.
//
// Since decision ④ (2026-08-05) the shared DEFAULT_CATALOG ships EMPTY, so the fixture
// swaps a compact TEST catalog into the seed module (`seed.cfg`, Python's monkeypatch) and
// every seeding MECHANISM (fill-empty facts, stale-value heals, the inherited-drafter borrow,
// the embedding flag, samplers-on-seed) runs its real code path over it.
//
// `detectAndStoreModelType` / `inspectModelFromLink` / `backfillDerivedFromCache` are async
// here (the sampler fallback and the inspect read the network), so their tests await them.
// `seed_heals_known_stale_value_only` step 3 set a NOT NULL column to None in an unflushed
// ORM object; here the seeder is handed a handle whose read shows that None (the same view
// the Python seeder had).
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as identity from "../src/llm/identity.js";
import * as seed from "../src/llm/seed.js";
import * as stores from "../src/llm/stores.js";
import { GgufMeta } from "../src/runner/gguf.js";
import * as ggufRemote from "../src/runner/gguf_remote.js";
import { freshDb } from "./helpers.js";

// stores.js imports switch_resolve.js (wave 2); a stand-in until it lands (fixtures/wave-stubs.js).
vi.mock("./switch_resolve.js", async () => (await import("./fixtures/wave-stubs.js")).stub("llm/switch_resolve.js"));

// The compact test catalog — shapes lifted from the moved JW rows.
const TEST_CATALOG = [
  // a plain dense chat row (the old llama-3.3-70b exhibit's shape)
  {
    id: "dense-a", name: "Dense A", hf_repo: "x/dense-a-GGUF", quant: "Q4_K_M",
    total_params: "70B", trained_ctx: 131072, min_ram_mb: 49152, min_vram_mb: 49152,
    tier: "high-ram", license: "Llama-Community", position: 0, quality_rank: 11,
    architecture: "llama", experts: 0, size_label: "70B", size_bytes: 42520398432,
  },
  // a drafted dense row with seeded samplers + size facts (the 12B QAT shape)
  {
    id: "drafted-b", name: "Drafted B", hf_repo: "x/drafted-b-GGUF", quant: "UD-Q4_K_XL",
    total_params: "12B", mtp: true, mtp_draft_file: "MTP/mtp-drafted-b-Q4_0.gguf",
    mtp_draft_quant: "Q4_0", trained_ctx: 262144,
    samplers: { top_k: "64", top_p: "0.95", temperature: "1" },
    min_ram_mb: 12288, min_vram_mb: 8192, tier: "mid", license: "Apache-2.0",
    position: 1, quality_rank: 22, architecture: "gemma4", experts: 0,
    size_label: "12B", size_bytes: 6716355328,
  },
  // a borrow-only MoE row: no built-in MTP, drafter BORROWED from the base family (the
  // StyleTune shape — mtp enabled via the borrow)
  {
    id: "borrow-c", name: "Borrow C", hf_repo: "x/borrow-c-GGUF", quant: "Q4_K_M",
    total_params: "26B", active_params: "4B", type: "moe", mtp: true,
    mtp_draft_repo: "base/family-qat-GGUF", mtp_draft_file: "MTP/mtp-base-Q4_0.gguf",
    mtp_draft_quant: "Q4_0", trained_ctx: 262144,
    min_vram_mb: 4096, min_ram_mb: 24576, tier: "low-vram-moe", license: "Apache-2.0",
    position: 2, quality_rank: 12, architecture: "gemma4", experts: 128,
  },
  // a built-in-MTP MoE (the GLM shape)
  {
    id: "moe-d", name: "MoE D", hf_repo: "x/moe-d-GGUF", quant: "UD-Q4_K_XL",
    total_params: "106B", active_params: "12B", type: "moe", mtp: true,
    mtp_builtin: true, trained_ctx: 131072, min_vram_mb: 12288, min_ram_mb: 65536,
    tier: "high-ram", license: "MIT", position: 3, quality_rank: 10,
    architecture: "glm4moe", experts: 128, size_label: "128x9.4B", size_bytes: 67721071872,
  },
  // two embed rows (the Qwen3-4B + KaLM shapes)
  {
    id: "embed-e", name: "Embed E", hf_repo: "x/embed-e-GGUF", quant: "Q4_K_M",
    total_params: "4B", trained_ctx: 40960, min_vram_mb: 4500, min_ram_mb: 8000,
    tier: "cpu", license: "Apache-2.0", position: 10, embedding: true,
    pooling: "last", quality_rank: 55, architecture: "qwen3", experts: 0,
    size_label: "4B", size_bytes: 2496703776,
  },
  {
    id: "embed-f", name: "Embed F", hf_repo: "x/embed-f-GGUF", quant: "Q4_K_M",
    total_params: "12B", trained_ctx: 131072, min_vram_mb: 10000, min_ram_mb: 12000,
    tier: "high", license: "Gemma", position: 12, embedding: true,
    pooling: "last", quality_rank: 52, architecture: "gemma-embedding", experts: 0,
    size_label: "12B", size_bytes: 7300777920,
  },
];

// The heal mechanism's test data (QC-43a): borrow-c once seeded a fatal drafter trio.
const STALE_TEST = new Map([
  [["borrow-c", "mtp_draft_repo"], ["Old/stale-assistant-GGUF"]],
  [["borrow-c", "mtp_draft_file"], ["stale-assistant-Q8_0.gguf"]],
  [["borrow-c", "mtp_draft_quant"], ["Q8_0"]],
]);

const saved = { catalog: seed.cfg.DEFAULT_CATALOG, stale: seed.cfg.STALE_SEED_VALUES };
let h;
function configured() {
  h = freshDb();
  seed.cfg.DEFAULT_CATALOG = TEST_CATALOG;
  seed.cfg.STALE_SEED_VALUES = STALE_TEST;
  h.tx(() => seed.seedDefaultCatalog(h));
}
beforeEach(() => {
  h = null;
});
afterEach(() => {
  seed.cfg.DEFAULT_CATALOG = saved.catalog;
  seed.cfg.STALE_SEED_VALUES = saved.stale;
});

const meta = (expertCount) => new GgufMeta({ architecture: "x", blockCount: 10, embeddingLength: 1000, expertCount });

const metaFull = ({ expertCount = 0, nextn = 0, ctx = 0, sampling = null, sizeLabel = "" } = {}) =>
  new GgufMeta({
    architecture: "qwen35",
    blockCount: 65,
    embeddingLength: 5120,
    expertCount,
    contextLength: ctx,
    nextnPredictLayers: nextn,
    sizeLabel,
    sampling: sampling || {},
  });

const row = (modelId) => stores.getModelCatalogStore().list().find((r) => r.id === modelId);
const catalogRow = (id) => h.get("model_catalog", id);
const setRow = (id, vals) => h.update("model_catalog", vals, { id });

test("type_from_meta", () => {
  expect(identity.modelTypeFromMeta(meta(128))).toBe("moe");
  expect(identity.modelTypeFromMeta(meta(0))).toBe("dense");
});

test("detect_flips_type_to_moe_and_keeps_built_in", async () => {
  configured();
  const mid = "dense-a"; // seeded type=dense, built_in=true
  expect(row(mid).type).toBe("dense");
  expect(row(mid).builtIn).toBe(true);
  const out = await identity.detectAndStoreModelType(mid, "x.gguf", { readMeta: () => meta(128) });
  expect(out).toBe("moe");
  const after = row(mid);
  expect(after.type).toBe("moe");
  expect(after.builtIn).toBe(true); // setDerived preserves built_in (upsert would not)
});

test("detect_dense_is_noop_when_already_dense", async () => {
  configured();
  const mid = "dense-a";
  const out = await identity.detectAndStoreModelType(mid, "x.gguf", { readMeta: () => meta(0) });
  expect(out).toBe("dense");
  expect(row(mid).type).toBe("dense");
});

test("physics_facts_reproduce_kv_mb_at_ctx", () => {
  // §13.11's core claim, pinned: the two stored KV scalars + sliding_window reproduce
  // `kvMbAtCtx` BYTE-IDENTICALLY — [Wb×min(ctx,window) + Gb×ctx] × bits/8 — including
  // per-layer head counts, the swa-dim fallback, and the uniform case (Wb=0). If this
  // drifts, stored facts stop being able to compute KV and floors go silently low.
  const iswa = new GgufMeta({
    architecture: "gemma4", blockCount: 6, embeddingLength: 2816,
    expertCount: 128, headCount: 16, headCountKv: 8,
    keyLength: 256, valueLength: 256, keyLengthSwa: 128, valueLengthSwa: 128,
    slidingWindow: 1024,
    slidingWindowPattern: [true, true, false, true, true, false],
    headCountKvPerLayer: [8, 8, 4, 8, 8, 4],
  });
  const facts = identity.physicsFactsFromMeta(iswa);
  for (const ctx of [512, 1024, 4096, 32768]) {
    for (const bits of [8, 16]) {
      const exact = iswa.kvMbAtCtx(ctx, bits);
      // The REAL stored-facts path (not an inline copy of its formula) — both sides MiB.
      const fromFacts = identity.kvMbFromFacts(facts, ctx, bits);
      expect(exact).not.toBeNull();
      expect(Math.abs(fromFacts - exact), String([ctx, bits, fromFacts, exact])).toBeLessThan(1e-9);
    }
  }
  // Uniform model: no window pattern → Wb 0, every layer global.
  const uni = new GgufMeta({
    architecture: "llama", blockCount: 4, embeddingLength: 1024,
    expertCount: 0, headCount: 8, headCountKv: 8, keyLength: 128, valueLength: 128,
  });
  const ufacts = identity.physicsFactsFromMeta(uni);
  expect(ufacts.kv_windowed_bytes_per_token).toBe(0.0);
  expect(ufacts.sliding_window).toBe(0);
  expect(ufacts.kv_global_bytes_per_token).toBe(4 * 8 * 256);
  // Facts mirror the meta's own share (0.0 for dense AND for a MoE header whose expert dims
  // are absent — expertByteShare's honest no-discount fallback).
  expect(ufacts.expert_byte_share).toBe(0.0);
  expect(facts.expert_byte_share).toBe(iswa.expertByteShare());
});

test("computed_fresh_floors_from_facts", () => {
  // Phase 2 A-3 (§13.11): a CHAT row whose physics facts are stored gets its floors + est
  // computed FRESH at read; an EMBED row keeps its curated floors (§8.6); a factless row
  // falls back to the stored values (fidelity ladder).
  configured();
  const store = stores.getModelCatalogStore();
  // factless: stored values pass through untouched
  const before = Object.fromEntries(store.list().map((r) => [r.id, r]));
  expect(before["dense-a"].minVramMb).toBe(49152);
  expect(before["dense-a"].minRamMb).toBe(49152);
  expect(before["embed-e"].minVramMb).toBe(4500);
  // write facts through setDerived (the download-identify path) for dense-a
  const m = new GgufMeta({
    architecture: "llama", blockCount: 80, embeddingLength: 8192,
    expertCount: 0, headCount: 64, headCountKv: 8, keyLength: 128, valueLength: 128, contextLength: 131072,
  });
  store.setDerived("dense-a", {
    modelType: "dense",
    mtpBuiltin: false,
    trainedCtx: 131072,
    sizeBytes: 42520398432,
    physicsFacts: identity.physicsFactsFromMeta(m),
  });
  const after = Object.fromEntries(store.list().map((r) => [r.id, r]));
  const r = after["dense-a"];
  // floors are now the physics numbers, RAW (no rung snapping in storage/wire)
  const [expectVram, expectRam, expectEst] = identity.computedRowNumbers(identity.physicsFactsFromMeta(m), 42520398432, 131072);
  expect([r.minVramMb, r.minRamMb, r.estVramMb]).toEqual([expectVram, expectRam, expectEst]);
  expect(r.minVramMb).not.toBe(49152); // the stored value stopped being consulted
  // dense floor ≈ file + KV@4k + overhead — sane magnitude, raw not rung
  expect(r.minVramMb > 42000 && r.minVramMb < 48000).toBe(true);
  expect(r.minRamMb).toBe(Math.round(42520398432 / (1024 * 1024) + 4096)); // MiB (vram-truth plan §6.4)
  // facts ride the wire for the form (Edit-open == Read-from-link parity)
  expect(r.physicsFacts && r.physicsFacts.block_count === 80).toBe(true);
  // the embed row is untouched by the whole mechanism
  expect(after["embed-e"].minVramMb).toBe(4500);
  expect(after["embed-e"].minRamMb).toBe(8000);
});

test("derived_fields_from_meta", () => {
  const f = identity.derivedFieldsFromMeta(metaFull({ nextn: 1, ctx: 262144, sampling: { temp: 1.0, top_k: 20, penalty_repeat: 1.05 } }));
  expect(f.type).toBe("dense");
  expect(f.mtp_builtin).toBe(true);
  expect(f.trained_ctx).toBe(262144);
  // samplers are canonicalized to OUR catalog namespace (temp→temperature,
  // penalty_repeat→repeat_penalty); unchanged keys (top_k) pass through, and values render
  // as the number the file MEANS (float32-noise cleanup: 1.0 → "1").
  expect(f.samplers).toEqual({ temperature: "1", top_k: "20", repeat_penalty: "1.05" });
  // dense / no-mtp / no-ctx / no-sampling -> falsy fields (null trained_ctx, {} samplers)
  const g = identity.derivedFieldsFromMeta(metaFull());
  expect(g.type).toBe("dense");
  expect(g.mtp_builtin).toBe(false);
  expect(g.trained_ctx).toBeNull();
  expect(g.samplers).toEqual({});
});

test("derived_total_params_from_size_label", () => {
  // dense: general.size_label "27B" parses -> file-derived total_params
  const f = identity.derivedFieldsFromMeta(metaFull({ sizeLabel: "27B" }));
  expect(f.total_params).toBe("27B");
  expect(f.size_label).toBe("27B");
  // MoE expert-label "128x9.4B" does NOT parse -> null (the curated total is preserved)
  const g = identity.derivedFieldsFromMeta(metaFull({ expertCount: 128, sizeLabel: "128x9.4B" }));
  expect(g.total_params).toBeNull();
  expect(g.size_label).toBe("128x9.4B");
  // a MoE whose label DOES parse ("235B-A22B" → parseParams reads "235B") must STILL be
  // null — the isMoe gate prevents clobbering a curated MoE total.
  const k = identity.derivedFieldsFromMeta(metaFull({ expertCount: 8, sizeLabel: "235B-A22B" }));
  expect(k.total_params).toBeNull();
});

test("seed_ships_size_facts_and_reseed_fills_empty_only", () => {
  // #12b (2026-07-08): every seeded catalog row ships its pinned quant's size_label +
  // size_bytes, and a RE-seed on an existing DB fills the fields only when EMPTY — a
  // download-derived value is never clobbered.
  configured();
  // seeded rows carry the facts (a dense, a MoE, and an embed)
  expect(row("drafted-b").sizeLabel).toBe("12B");
  expect(row("drafted-b").sizeBytes).toBe(6716355328);
  expect(row("moe-d").sizeLabel).toBe("128x9.4B");
  expect(row("embed-e").sizeBytes).toBe(2496703776);
  // simulate a pre-#12b row (empty facts) + a download-derived row (real file)
  setRow("embed-f", { size_label: "", size_bytes: null });
  setRow("drafted-b", { size_bytes: 12345 }); // "the local file said so" — must survive reseed
  expect(h.tx(() => seed.seedDefaultCatalog(h))).toBe(0); // nothing inserted…
  expect(row("embed-f").sizeBytes).toBe(7300777920); // …the empty row was filled
  expect(row("embed-f").sizeLabel).toBe("12B");
  expect(row("drafted-b").sizeBytes).toBe(12345); // the derived value was preserved
});

test("seed_heals_known_stale_value_only", () => {
  // QC-43a (2026-07-10): a seeded FACT that later proved wrong can't self-heal through
  // fill-empty (the wrong value isn't empty), so `STALE_SEED_VALUES` records the exact
  // historically-seeded value and the seeder swaps it for the CURRENT seed value — but ONLY
  // on an exact stale match; a user/inspect value or null is left be.
  configured();
  const mid = "borrow-c";
  const stale = "stale-assistant-Q8_0.gguf";
  const staleRepo = "Old/stale-assistant-GGUF";
  const current = "MTP/mtp-base-Q4_0.gguf";

  // 1) the exact historically-seeded stale trio → healed to the current facts
  setRow(mid, { mtp_draft_repo: staleRepo, mtp_draft_file: stale, mtp_draft_quant: "Q8_0" });
  h.tx(() => seed.seedDefaultCatalog(h));
  let r = catalogRow(mid);
  expect(r.mtp_draft_file).toBe(current);
  expect(r.mtp_draft_repo).toBe("base/family-qat-GGUF");
  expect(r.mtp_draft_quant).toBe("Q4_0");

  // 2) a user/inspect value that is NOT the stale one → left untouched
  setRow(mid, { mtp_draft_file: "my/custom-draft.gguf" });
  h.tx(() => seed.seedDefaultCatalog(h));
  expect(catalogRow(mid).mtp_draft_file).toBe("my/custom-draft.gguf");

  // 3) null never matches the stale tuple → no heal, no crash. The column is NOT NULL, so
  //    the seeder is handed a read that SHOWS the row's draft file as null (Python set it
  //    on the unflushed ORM object) — the point is the heal path survives null.
  const view = Object.create(h);
  view.all = (...a) => h.all(...a).map((x) => (x.id === mid ? { ...x, mtp_draft_file: null } : x));
  expect(() => h.tx(() => seed.seedDefaultCatalog(view))).not.toThrow(); // must not raise
  r = catalogRow(mid);
  expect(r.mtp_draft_file).not.toBe(stale);
});

test("borrow_only_row_seeds_inherited_drafter", () => {
  // A row with NO built-in MTP and NO own draft in-file must ship the BORROWED base-family
  // drafter + mtp enabled — so the opened Edit form reads identically to Read-from-link.
  configured();
  const r = row("borrow-c");
  expect(r.mtpBuiltin).toBe(false); // header carries no in-file MTP
  expect(r.mtp).toBe(true); // …yet MTP is enabled via the borrow
  // The exact repo is pinned so a silent re-point is caught.
  expect(r.mtpDraftRepo).toBe("base/family-qat-GGUF");
  expect(r.mtpDraftFile).toBe("MTP/mtp-base-Q4_0.gguf");
  // A model that ships its OWN draft is untouched by the borrow (own, not borrowed).
  expect(row("drafted-b").mtpDraftRepo).toBe("");
  expect(row("drafted-b").mtpDraftFile).toBe("MTP/mtp-drafted-b-Q4_0.gguf");
});

test("fill_inherited_draft_backfills_existing_draftless_row", () => {
  // The boot backfill gives an EXISTING draftless borrow-only row the inherited drafter
  // without a reset — empty-only, so a user's own/edited draft is never clobbered.
  configured();
  // Simulate a pre-fix existing row: no draft, mtp off (as the old seed shipped it).
  setRow("borrow-c", { mtp: false, mtp_draft_repo: "", mtp_draft_file: "", mtp_draft_quant: "" });
  // And a row that already carries a user draft — must be LEFT ALONE.
  setRow("drafted-b", { mtp_draft_file: "my/own-draft.gguf", mtp: true });
  h.tx(() => seed.seedDefaultCatalog(h)); // re-seed → fill-empty backfill runs
  const healed = row("borrow-c");
  expect(healed.mtp).toBe(true);
  expect(healed.mtpDraftFile).toBe("MTP/mtp-base-Q4_0.gguf");
  expect(healed.mtpDraftRepo).toBe("base/family-qat-GGUF");
  // the user's own draft survived (empty-only never overwrites an existing draft)
  expect(row("drafted-b").mtpDraftFile).toBe("my/own-draft.gguf");
});

test("detect_writes_total_params_for_dense_only", async () => {
  configured();
  const mid = "dense-a"; // seeded total_params "70B"
  await identity.detectAndStoreModelType(mid, "x.gguf", { readMeta: () => metaFull({ sizeLabel: "27B" }) });
  expect(row(mid).totalParams).toBe("27B"); // dense size_label overwrote the seed
  // a MoE-style label must NOT clobber the stored value (size_label isn't the total)
  await identity.detectAndStoreModelType(mid, "x.gguf", { readMeta: () => metaFull({ expertCount: 128, sizeLabel: "128x9.4B" }) });
  expect(row(mid).totalParams).toBe("27B"); // unchanged
});

test("detect_stores_mtp_ctx_and_samplers", async () => {
  configured();
  const mid = "dense-a"; // seeded dense / built_in, no mtp / samplers
  const out = await identity.detectAndStoreModelType(mid, "x.gguf", {
    readMeta: () => metaFull({ nextn: 1, ctx: 262144, sampling: { temp: 1.0, top_k: 20 } }),
  });
  expect(out).toBe("dense");
  const r = row(mid);
  // setDerived writes the HEADER truth into mtp_builtin (never the enable flag mtp)
  expect(r.mtpBuiltin).toBe(true);
  expect(r.mtp).toBe(false);
  expect(r.trainedCtx).toBe(262144);
  expect(r.samplers).toEqual({ temperature: "1", top_k: "20" }); // canonicalized + number-cleaned
  expect(r.builtIn).toBe(true); // setDerived preserves built_in (unlike upsert)
});

test("detect_replaces_samplers_and_uses_fallback", async () => {
  configured();
  const mid = "dense-a";
  // 1) header ships samplers -> stored (canonicalized: temp→temperature)
  await identity.detectAndStoreModelType(mid, "x.gguf", { readMeta: () => metaFull({ sampling: { temp: 0.7 } }) });
  expect(row(mid).samplers).toEqual({ temperature: "0.7" });
  // 2) header EMPTY + a fallback -> fallback fills, and it REPLACES the prior set
  await identity.detectAndStoreModelType(mid, "x.gguf", {
    readMeta: () => metaFull({ sampling: {} }),
    samplersFallback: () => ({ top_p: 0.8 }),
  });
  expect(row(mid).samplers).toEqual({ top_p: "0.8" });
  // 3) header EMPTY + no fallback -> the sampler set is cleared
  await identity.detectAndStoreModelType(mid, "x.gguf", { readMeta: () => metaFull({ sampling: {} }) });
  expect(row(mid).samplers).toEqual({});
});

test("embedding_flag_seeded_on_embeds_not_llms", () => {
  // model-surface: the catalog `embedding` flag is seeded true on every embed model and
  // false on chat LLMs, and it threads through the store wire. The UI reads it for the
  // Set-as-embedding action + the QuickSetup embed picker — replacing the fragile /embed/i
  // name guess.
  configured();
  const byId = Object.fromEntries(stores.getModelCatalogStore().list().map((r) => [r.id, r]));
  for (const embed of ["embed-e", "embed-f"]) expect(byId[embed].embedding, embed).toBe(true);
  for (const llm of ["dense-a", "drafted-b", "moe-d"]) expect(byId[llm].embedding, llm).toBe(false);
});

test("inspect_model_from_link", async () => {
  const m = metaFull({ nextn: 1, ctx: 262144, sampling: { temp: 1.0, top_k: 20 }, sizeLabel: "27B" });
  vi.spyOn(ggufRemote, "fetchGgufMeta").mockImplementation(async () => [m, 17_000_000_000]);
  const out = await identity.inspectModelFromLink("unsloth/Qwen3.6-27B-MTP-GGUF", "Q4_K_M");
  expect(out.type).toBe("dense");
  expect(out.mtpBuiltin).toBe(true);
  expect(out.trainedCtx).toBe(262144);
  expect(out.experts).toBe(0);
  expect(out.architecture).toBe("qwen35");
  expect(out.sizeLabel).toBe("27B");
  expect(out.totalParams).toBe("27B"); // dense param count from size_label
  expect(out.samplers).toEqual({ temperature: "1", top_k: "20" }); // canonicalized + number-cleaned
  expect(out.sizeBytes).toBe(17_000_000_000);
  expect(out.estVramMb > 0).toBe(true); // estimateVramMb fed the REAL header + size
  // The Min-RAM floor's pre-download guess rides the SAME payload (2026-07-27) — 17 GB file
  // + 4 GB headroom snaps to the 24 GB rung.
  expect(out.estRamMb).toBe(24 * 1024);
});

test("est_ram_mb_from_bytes_snaps_to_real_ram_rungs", () => {
  // The size-only RAM rule (dense = weights + overhead, MoE = the whole file in RAM) — file
  // MB + 4096, snapped UP to a rung a real PC ships.
  expect(identity.estRamMbFromBytes(null)).toBeNull();
  expect(identity.estRamMbFromBytes(0)).toBeNull();
  expect(identity.estRamMbFromBytes(1_500_000_000)).toBe(8 * 1024); // small file → floor rung
  // Exact-rung boundary: 4.096 GB + 4096 MB headroom == 8192 MB, must NOT climb.
  expect(identity.estRamMbFromBytes(4_096_000_000)).toBe(8 * 1024);
  expect(identity.estRamMbFromBytes(4_096_000_001)).toBe(10 * 1024); // one byte over → next rung
  // The calibration exhibits (2026-07-27): the 12B and the 26B-A4B flagship files.
  expect(identity.estRamMbFromBytes(6_716_355_328)).toBe(12 * 1024);
  expect(identity.estRamMbFromBytes(17_211_252_288)).toBe(24 * 1024);
  // Past the top rung (128 GB) the ladder ends → round up to the next 32 GB.
  expect(identity.estRamMbFromBytes(200_000_000_000)).toBe(224 * 1024);
});

test("inspect_uses_generation_config_fallback", async () => {
  const m = metaFull({ expertCount: 128, nextn: 1, ctx: 131072, sampling: {} }); // GLM-like: no header samplers
  m.baseRepoUrl = "https://huggingface.co/zai-org/GLM-4.5-Air";
  vi.spyOn(ggufRemote, "fetchGgufMeta").mockImplementation(async () => [m, 68_000_000_000]);
  vi.spyOn(ggufRemote, "fetchGenerationConfigSamplers").mockImplementation(async () => ({ temp: 0.6, top_p: 0.95 }));
  const out = await identity.inspectModelFromLink("unsloth/GLM-4.5-Air-GGUF", "UD-Q4_K_XL");
  expect(out.type).toBe("moe");
  expect(out.experts).toBe(128);
  expect(out.mtpBuiltin).toBe(true);
  // from generation_config.json fallback, canonicalized (temp→temperature)
  expect(out.samplers).toEqual({ temperature: "0.6", top_p: "0.95" });
});

// ── the derive-boundary number cleanup + the boot backfill (2026-07-07, the read-from-link
// parity item) ──

test("canonicalize_cleans_float32_noise", () => {
  // GGUF floats arrive as float32 artifacts — the user's Edit form showed "top_p
  // 0.949999988079071"; the derive boundary renders the number the file MEANS. Ints and
  // non-numerics pass through.
  const out = identity.canonicalizeSamplerNames({ top_p: "0.949999988079071", temp: "1.0", top_k: "64", note: "abc" });
  expect(out).toEqual({ top_p: "0.95", temperature: "1", top_k: "64", note: "abc" });
});

test("backfill_rederives_only_cached_samplerless_rows", async () => {
  // rows: a (no samplers, cached) → derived; b (has samplers) → skipped; c (no samplers, NOT
  // cached) → skipped; d (derive raises) → skipped, loop survives.
  const R = (id, samplers) => ({ id, samplers });
  const rows = [R("a", {}), R("b", { top_k: "64" }), R("c", {}), R("d", {})];
  const cached = { a: "/x/a.gguf", d: "/x/d.gguf" };
  const derived = [];
  const identifyOne = (mid, path) => {
    if (mid === "d") throw new Error("broken file");
    derived.push([mid, path]);
  };
  const n = await identity.backfillDerivedFromCache(rows, (mid) => cached[mid] ?? null, identifyOne);
  expect(n).toBe(1);
  expect(derived).toEqual([["a", "/x/a.gguf"]]);
});

test("seeded_samplers_ride_the_catalog_seed", () => {
  // The parity principle: the seed ships the FILE's recommended samplers — a seeded row
  // carries its set out of the box (the 2026-07-07 live reads).
  configured();
  const r = row("drafted-b");
  expect(r.samplers).toEqual({ top_k: "64", top_p: "0.95", temperature: "1" });
  // and a built-in-MTP header fact rides the seed too.
  expect(row("moe-d").mtp).toBe(true);
});
