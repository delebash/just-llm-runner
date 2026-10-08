// SPDX-License-Identifier: MIT
// Port of tests/test_models.py — P1.3 GGUF model acquisition: quant-based file selection +
// the HF cache write. The network (HF Hub API + file stream) is mocked — `http.fetch` for
// the API and `download.streamDownload` for the file stream — so it runs anywhere.
//
// All 28 Python tests run here (the three `*_survives_the_wire_model` tests go through
// `llm/model_catalog_api.js`'s ListFilesResponse).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import * as http from "../src/platform/http.js";
import { model } from "../src/platform/models.js";
import { FileNotFoundError } from "../src/platform/py.js";
import * as download from "../src/runner/download.js";
import * as models from "../src/runner/models.js";

let tmpPath;
beforeEach(() => {
  tmpPath = mkdtempSync(join(tmpdir(), "kit-models-"));
});

// A synthetic HF tree: two shards of the wanted quant, a different quant, an mmproj sidecar,
// plus non-GGUF repo files that must never be selected.
const TREE = [
  { type: "file", path: ".gitattributes", oid: "g1", size: 10 },
  { type: "file", path: "README.md", oid: "g2", size: 20 },
  { type: "file", path: "UD-Q4_K_XL/model-00001-of-00002.gguf", oid: "o1", lfs: { oid: "lfs1", size: 4 } },
  { type: "file", path: "UD-Q4_K_XL/model-00002-of-00002.gguf", oid: "o2", lfs: { oid: "lfs2", size: 4 } },
  { type: "file", path: "UD-Q8_0/model.gguf", oid: "o3", lfs: { oid: "lfs3", size: 4 } },
  { type: "file", path: "mmproj-F16.gguf", oid: "o4", lfs: { oid: "lfs4", size: 4 } },
  { type: "directory", path: "UD-Q4_K_XL" },
];

/** requests.get replaced: the revision call answers the sha, the tree call the listing. */
function mockGet(tree, sha = "abc1234") {
  return vi.spyOn(http, "fetch").mockImplementation(async (url) => {
    if (url.includes("/revision/")) return new Response(JSON.stringify({ sha }), { status: 200 });
    if (url.includes("/tree/")) return new Response(JSON.stringify(tree), { status: 200 });
    throw new Error(`unexpected GET: ${url}`);
  });
}

/** streamDownload replaced: writes 4 bytes (every entry's declared size) and reports them. */
function mockStream(calls) {
  return vi.spyOn(download, "streamDownload").mockImplementation(async (url, dest, { onProgress } = {}) => {
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, Buffer.from("GGUF"));
    calls.push(url);
    if (onProgress) onProgress(4, 4); // (downloaded, total) — this file is 4 bytes
  });
}

test("select_files_matches_quant_and_shards", async () => {
  mockGet(TREE);
  const [sha, files] = await models.selectFiles("owner/repo", "UD-Q4_K_XL");
  expect(sha).toBe("abc1234");
  expect(files.map((f) => f.path).sort()).toEqual([
    "UD-Q4_K_XL/model-00001-of-00002.gguf",
    "UD-Q4_K_XL/model-00002-of-00002.gguf",
  ]);
});

test("select_files_includes_mmproj_when_set", async () => {
  mockGet(TREE);
  const [, files] = await models.selectFiles("owner/repo", "UD-Q4_K_XL", "mmproj");
  const paths = files.map((f) => f.path).sort();
  expect(paths).toContain("mmproj-F16.gguf");
  expect(files.length).toBe(3); // two shards + mmproj, never the Q8_0 / readme
});

test("select_files_no_match_raises", async () => {
  mockGet(TREE);
  await expect(models.selectFiles("owner/repo", "DOES-NOT-EXIST")).rejects.toThrow(FileNotFoundError);
});

test("select_repo_files_explicit_list_ordered", async () => {
  mockGet(TREE);
  const [sha, files] = await models.selectRepoFiles("owner/repo", { files: ["mmproj-F16.gguf", "README.md"] });
  expect(sha).toBe("abc1234");
  // Order follows the request, not the tree.
  expect(files.map((f) => f.path)).toEqual(["mmproj-F16.gguf", "README.md"]);
});

test("select_repo_files_whole_tree_when_none", async () => {
  mockGet(TREE);
  const [, files] = await models.selectRepoFiles("owner/repo");
  // Every FILE entry, never the directory row.
  expect(files.length).toBe(6);
  expect(files.every((e) => e.type === "file")).toBe(true);
});

test("select_repo_files_missing_name_raises_naming_it", async () => {
  mockGet(TREE);
  const err = await models.selectRepoFiles("owner/repo", { files: ["README.md", "nope.bin"] }).catch((e) => e);
  expect(err).toBeInstanceOf(FileNotFoundError);
  expect(err.message).toMatch(/nope\.bin/);
});

test("acquire_model_writes_hf_cache_layout", async () => {
  mockGet(TREE);
  const calls = [];
  mockStream(calls);
  const progress = [];

  const snap = await models.acquireModel("owner/repo", "UD-Q4_K_XL", null, {
    cacheRoot: tmpPath,
    onProgress: (d, t) => progress.push([d, t]),
  });

  const repoDir = join(tmpPath, "models--owner--repo");
  expect(snap).toBe(join(repoDir, "snapshots", "abc1234"));
  // snapshot files resolve (symlink → blob, or the copy fallback) for both shards
  expect(existsSync(join(snap, "UD-Q4_K_XL/model-00001-of-00002.gguf"))).toBe(true);
  expect(existsSync(join(snap, "UD-Q4_K_XL/model-00002-of-00002.gguf"))).toBe(true);
  // blobs are keyed by the LFS oid, not the git oid
  expect(readFileSync(join(repoDir, "blobs", "lfs1")).toString()).toBe("GGUF");
  expect(existsSync(join(repoDir, "blobs", "o1"))).toBe(false);
  // refs/<rev> pins the commit sha
  expect(readFileSync(join(repoDir, "refs", "main"), "utf8")).toBe("abc1234");
  // exactly the two shards downloaded; final progress = (cumulative, grand total)
  expect(calls.length).toBe(2);
  expect(progress.at(-1)).toEqual([8, 8]);
});

test("acquire_model_idempotent", async () => {
  mockGet(TREE);
  const calls = [];
  const spy = mockStream(calls);
  await models.acquireModel("owner/repo", "UD-Q4_K_XL", null, { cacheRoot: tmpPath });
  expect(calls.length).toBe(2);

  // Second call: blobs already exist at the right size → no re-download.
  spy.mockImplementation(async () => {
    throw new Error("should not re-download an already-acquired blob");
  });
  const snap = await models.acquireModel("owner/repo", "UD-Q4_K_XL", null, { cacheRoot: tmpPath });
  expect(existsSync(snap)).toBe(true);
});

// ── classifyGgufEntries — the quant dropdown + MTP-draft detection (Plan B D9) ─────────

// The user's real gemma-4-26B repo shape, verbatim conventions: a QAT main model at a UD-
// dynamic quant + a SEPARATE draft at its own quant in an MTP/ subfolder.
const GIB = 1024 * 1024 * 1024;
const GEMMA_TREE = [
  { type: "file", path: "gemma-4-26B-A4B-it-qat-UD-Q4_K_XL.gguf", oid: "a", lfs: { oid: "l1", size: 14 * GIB } },
  { type: "file", path: "gemma-4-26B-A4B-it-qat-Q8_0-00001-of-00002.gguf", oid: "b", lfs: { oid: "l2", size: 12 * GIB } },
  { type: "file", path: "gemma-4-26B-A4B-it-qat-Q8_0-00002-of-00002.gguf", oid: "c", lfs: { oid: "l3", size: 12 * GIB } },
  { type: "file", path: "gemma-4-26B-A4B-it-qat-IQ4_XS.gguf", oid: "d", lfs: { oid: "l4", size: 13 * GIB } },
  { type: "file", path: "MTP/gemma-4-26B-A4B-it-Q4_0-MTP.gguf", oid: "e", lfs: { oid: "l5", size: 700 * 1024 * 1024 } },
  { type: "file", path: "mmproj-F16.gguf", oid: "f", lfs: { oid: "l6", size: 500 * 1024 * 1024 } },
  { type: "file", path: "README.md", oid: "g", size: 20 },
];

const byQuant = (out) => Object.fromEntries(out.quants.map((q) => [q.quant, q]));

test("classify_gemma_repo_quants_and_draft", () => {
  const out = models.classifyGgufEntries(GEMMA_TREE);
  const bq = byQuant(out);
  // UD- dynamic quant recognized whole + flagged QAT (from the filename)
  expect(bq["UD-Q4_K_XL"].kind).toBe("Q");
  expect(bq["UD-Q4_K_XL"].qat).toBe(true);
  // shards SUMMED into one row
  expect(bq.Q8_0.files).toBe(2);
  expect(bq.Q8_0.sizeMb).toBe(2 * 12 * 1024);
  // IQ family labeled IQ
  expect(bq.IQ4_XS.kind).toBe("IQ");
  // the draft is DETECTED (MTP/ dir + -MTP.gguf), carries its own quant, and is NOT in the
  // quants list; mmproj + README are skipped entirely
  expect(out.drafts.length).toBe(1);
  const d = out.drafts[0];
  expect(d.path).toBe("MTP/gemma-4-26B-A4B-it-Q4_0-MTP.gguf");
  expect(d.quant).toBe("Q4_0");
  expect("Q4_0" in bq).toBe(false);
  expect(out.quants.some((q) => q.quant.toLowerCase().includes("mmproj"))).toBe(false);
  // sorted by size ascending
  const sizes = out.quants.map((q) => q.sizeMb);
  expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
});

test("classify_quant_rows_carry_q4_floor", () => {
  // `q4OrBetter` rides QUANT rows (fit-redesign §4 0.4) — the form's nothing-fits fallback
  // prefers the smallest ≥4-bit quant over the truly smallest, so an 8 GB box is never handed
  // a 1-bit IQ1_M by default.
  const tree = [
    { type: "file", path: "m-UD-IQ1_M.gguf", oid: "a", lfs: { oid: "l1", size: 10 * GIB } },
    { type: "file", path: "m-Q3_K_M.gguf", oid: "b", lfs: { oid: "l2", size: 15 * GIB } },
    { type: "file", path: "m-UD-Q4_K_M.gguf", oid: "c", lfs: { oid: "l3", size: 21 * GIB } },
  ];
  const bq = byQuant(models.classifyGgufEntries(tree));
  expect(bq["UD-IQ1_M"].q4OrBetter).toBe(false);
  expect(bq.Q3_K_M.q4OrBetter).toBe(false);
  expect(bq["UD-Q4_K_M"].q4OrBetter).toBe(true);
});

test("classify_plain_repo_no_drafts", () => {
  const out = models.classifyGgufEntries(TREE);
  expect(out.drafts).toEqual([]);
  const bq = byQuant(out);
  expect(bq["UD-Q4_K_XL"].files).toBe(2);
  expect(bq["UD-Q4_K_XL"].qat).toBe(false);
  expect("UD-Q8_0" in bq).toBe(true);
});

// ── dspark own-repo drafters + inherited-drafter shard/fp16 guard (2026-07-19) ────────

const GB = GIB;

// prism-ml/Ternary-Bonsai-27B-gguf, real filenames verbatim (fetched from HF 2026-07-19).
const BONSAI_TREE = [
  { type: "file", path: "Ternary-Bonsai-27B-F16.gguf", oid: "a", lfs: { oid: "l1", size: Math.trunc(53.8 * GB) } },
  { type: "file", path: "Ternary-Bonsai-27B-PQ2_0.gguf", oid: "b", lfs: { oid: "l2", size: Math.trunc(8.2 * GB) } },
  { type: "file", path: "Ternary-Bonsai-27B-Q2_0.gguf", oid: "c", lfs: { oid: "l3", size: Math.trunc(8.1 * GB) } },
  { type: "file", path: "Ternary-Bonsai-27B-Q2_g64.gguf", oid: "d", lfs: { oid: "l4", size: Math.trunc(7.59 * GB) } },
  { type: "file", path: "Ternary-Bonsai-27B-dspark-Q4_1.gguf", oid: "e", lfs: { oid: "l5", size: Math.trunc(1.95 * GB) } },
  { type: "file", path: "Ternary-Bonsai-27B-dspark-bf16.gguf", oid: "f", lfs: { oid: "l6", size: Math.trunc(2.6 * GB) } },
  { type: "file", path: "Ternary-Bonsai-27B-mmproj-BF16.gguf", oid: "g", lfs: { oid: "l7", size: Math.trunc(0.9 * GB) } },
  { type: "file", path: "Ternary-Bonsai-27B-mmproj-Q8_0.gguf", oid: "h", lfs: { oid: "l8", size: Math.trunc(0.5 * GB) } },
  { type: "file", path: "README.md", oid: "i", size: 20 },
];

test("classify_bonsai_dspark_drafters", () => {
  const out = models.classifyGgufEntries(BONSAI_TREE);
  const draftPaths = new Set(out.drafts.map((d) => d.path));
  // BOTH dspark files are detected as drafts (name-keyed, quant OR bf16)…
  expect(draftPaths.has("Ternary-Bonsai-27B-dspark-Q4_1.gguf")).toBe(true);
  expect(draftPaths.has("Ternary-Bonsai-27B-dspark-bf16.gguf")).toBe(true);
  // …and flagged UNLOADABLE (dspark = an arch our engine can't load), token named.
  const byPath = Object.fromEntries(out.drafts.map((d) => [d.path, d]));
  for (const p of ["Ternary-Bonsai-27B-dspark-Q4_1.gguf", "Ternary-Bonsai-27B-dspark-bf16.gguf"]) {
    expect(byPath[p].loadable).toBe(false);
    expect(byPath[p].unsupportedArch).toBe("dspark");
  }
  // …and NEITHER leaks into the quant dropdown
  const quantNames = new Set(out.quants.map((q) => q.quant));
  expect(quantNames.has("Q4_1")).toBe(false);
  // mmproj sidecars skipped entirely (never a quant, never a draft)
  expect(out.drafts.some((d) => d.path.toLowerCase().includes("mmproj"))).toBe(false);
  expect(out.quants.some((q) => q.quant.toLowerCase().includes("mmproj"))).toBe(false);
  // a real quant still lands in the dropdown
  expect(quantNames.has("Q2_g64")).toBe(true);
  // PQ2_0 and Q2_0 are TWO distinct quant rows (word-bounded token) — one file each.
  const bq = byQuant(out);
  expect(bq.PQ2_0.files === 1 && bq.PQ2_0.kind === "Q").toBe(true);
  expect(bq.Q2_0.files === 1 && bq.Q2_0.kind === "Q").toBe(true);
});

test("drafter_skips_shards_prefers_quant_single", async () => {
  // BF16 split shards (shard-2 is the smallest FILE) + a larger single Q4_K_M: the shard tail
  // must be rejected, the loadable Q4_K_M returned.
  const tree = [
    { type: "file", path: "model-BF16-00001-of-00002.gguf", oid: "a", lfs: { oid: "l1", size: 20 * GB } },
    { type: "file", path: "model-BF16-00002-of-00002.gguf", oid: "b", lfs: { oid: "l2", size: 1 * GB } },
    { type: "file", path: "model-Q4_K_M.gguf", oid: "c", lfs: { oid: "l3", size: Math.trunc(1.5 * GB) } },
  ];
  mockGet(tree);
  expect(await models._ggufDrafterInRepo("owner/repo")).toEqual({ repo: "owner/repo", file: "model-Q4_K_M.gguf", quant: "Q4_K_M" });
});

test("drafter_none_when_only_shards_and_mmproj", async () => {
  const tree = [
    { type: "file", path: "model-BF16-00001-of-00002.gguf", oid: "a", lfs: { oid: "l1", size: 20 * GB } },
    { type: "file", path: "model-BF16-00002-of-00002.gguf", oid: "b", lfs: { oid: "l2", size: 20 * GB } },
    { type: "file", path: "mmproj-BF16.gguf", oid: "c", lfs: { oid: "l3", size: 1 * GB } },
  ];
  mockGet(tree);
  expect(await models._ggufDrafterInRepo("owner/repo")).toBeNull();
});

test("drafter_skips_unsupported_dspark", async () => {
  // Fix C (2026-07-21): a dspark drafter is an arch our engine CANNOT load, so the tier-C
  // picker must never suggest it. dspark-Q4_1 beside a huge F16: dspark excluded (arch), F16
  // excluded (full precision) → null.
  const tree = [
    { type: "file", path: "Ternary-Bonsai-27B-dspark-Q4_1.gguf", oid: "a", lfs: { oid: "l1", size: Math.trunc(1.95 * GB) } },
    { type: "file", path: "Ternary-Bonsai-27B-F16.gguf", oid: "b", lfs: { oid: "l2", size: Math.trunc(53.8 * GB) } },
  ];
  const spy = mockGet(tree);
  expect(await models._ggufDrafterInRepo("owner/repo")).toBeNull();
  // But the guard skips ONLY the unloadable arch: a loadable quant beside the dspark wins.
  const tree2 = [...tree, { type: "file", path: "assistant-Q4_K_M.gguf", oid: "c", lfs: { oid: "l3", size: 3 * GB } }];
  spy.mockRestore();
  mockGet(tree2);
  expect(await models._ggufDrafterInRepo("owner/repo")).toEqual({
    repo: "owner/repo",
    file: "assistant-Q4_K_M.gguf",
    quant: "Q4_K_M",
  });
});

test("drafter_rejects_full_model_variant_repos", async () => {
  // Caught live 2026-08-13: Qwen publishers ship "<model>-MTP-GGUF" VARIANT repos — the FULL
  // model with its built-in MTP heads preserved. A multi-GB pick is a full model: better NO
  // suggestion.
  const tree = [
    { type: "file", path: "Qwen3.6-35B-A3B-UD-IQ4_XS.gguf", oid: "a", lfs: { oid: "l1", size: 18 * GB } },
    { type: "file", path: "Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf", oid: "b", lfs: { oid: "l2", size: 22 * GB } },
  ];
  const spy = mockGet(tree);
  expect(await models._ggufDrafterInRepo("owner/repo")).toBeNull();
  // …while a REAL drafter's size sails through (the Gemma 252 MB shape).
  const real = [{ type: "file", path: "mtp-gemma-4-26B-A4B-it-Q4_0.gguf", oid: "c", lfs: { oid: "l3", size: 252 * 1024 * 1024 } }];
  spy.mockRestore();
  mockGet(real);
  const got = await models._ggufDrafterInRepo("owner/repo");
  expect(got?.file).toBe("mtp-gemma-4-26B-A4B-it-Q4_0.gguf");
});

test("drafter_shard_filter_fires_alone", async () => {
  // Isolates the SHARD filter: a QUANTIZED shard tail that is the SMALLEST file, beside a
  // LARGER single quant. Only shard-exclusion can reject it → the single-file Q5_K_M wins.
  const tree = [
    { type: "file", path: "model-Q4_K_M-00001-of-00002.gguf", oid: "a", lfs: { oid: "l1", size: 1 * GB } },
    { type: "file", path: "model-Q4_K_M-00002-of-00002.gguf", oid: "b", lfs: { oid: "l2", size: 1 * GB } },
    { type: "file", path: "model-Q5_K_M.gguf", oid: "c", lfs: { oid: "l3", size: 2 * GB } },
  ];
  mockGet(tree);
  expect(await models._ggufDrafterInRepo("owner/repo")).toEqual({ repo: "owner/repo", file: "model-Q5_K_M.gguf", quant: "Q5_K_M" });
});

test("drafter_fp16_filter_fires_alone", async () => {
  // Isolates the fp16 filter: a NON-shard F16 that is the SMALLEST file, beside a larger
  // single Q4_K_M. Only fp16-exclusion can reject the smaller F16 → the Q4_K_M must win.
  const tree = [
    { type: "file", path: "model-F16.gguf", oid: "a", lfs: { oid: "l1", size: 1 * GB } },
    { type: "file", path: "model-Q4_K_M.gguf", oid: "b", lfs: { oid: "l2", size: 2 * GB } },
  ];
  mockGet(tree);
  expect(await models._ggufDrafterInRepo("owner/repo")).toEqual({ repo: "owner/repo", file: "model-Q4_K_M.gguf", quant: "Q4_K_M" });
});

// ── the draft-pick FLOOR: 4-bit-or-better (2026-07-19) ───────────────────────────────

test("q4_or_better_floor", () => {
  // THE one predicate both pickers order by.
  for (const good of ["Q4_K_M", "Q4_0", "IQ4_XS", "UD-Q4_K_XL", "Q5_K_M", "Q6_K", "Q8_0", "BF16", "F16", "F32"]) {
    expect(models._q4OrBetter(good), good).toBe(true);
  }
  for (const bad of ["Q2_K", "Q2_0", "Q3_K_M", "IQ2_XXS", "IQ3_XXS", "", "weird"]) {
    expect(models._q4OrBetter(bad), bad).toBe(false);
  }
  // PQ2_0's leading P is a format marker, not a bit-width — it is still 2-bit.
  expect(models._q4OrBetter("PQ2_0")).toBe(false);
});

test("classify_marks_the_draft_pick_floor", () => {
  // Each draft row carries the flag the Add/Edit form's pre-select orders by.
  const out = models.classifyGgufEntries([
    { type: "file", path: "MTP/m-Q2_K-MTP.gguf", oid: "a", lfs: { oid: "l1", size: 1 } },
    { type: "file", path: "MTP/m-Q4_0-MTP.gguf", oid: "b", lfs: { oid: "l2", size: 9 } },
  ]);
  expect(Object.fromEntries(out.drafts.map((d) => [d.path, d.q4OrBetter]))).toEqual({
    "MTP/m-Q2_K-MTP.gguf": false,
    "MTP/m-Q4_0-MTP.gguf": true,
  });
});

test("draft_floor_flag_survives_the_wire_model", async () => {
  // THE guard for the 2026-07-19 miss: `/model-catalog/list-files` declares
  // ListFilesResponse, and the model's extra="ignore" SILENTLY DROPS any key the row model
  // doesn't name. Assert the flag survives the real classify → response-model hop.
  const { ListFilesResponse } = await import("../src/llm/model_catalog_api.js");
  const data = models.classifyGgufEntries([
    { type: "file", path: "MTP/m-Q2_K-MTP.gguf", oid: "a", lfs: { oid: "l1", size: 1 } },
    { type: "file", path: "MTP/m-Q4_0-MTP.gguf", oid: "b", lfs: { oid: "l2", size: 9 } },
  ]);
  const rows = model(ListFilesResponse, data).drafts;
  expect(Object.fromEntries(rows.map((r) => [r.path, r.q4OrBetter]))).toEqual({
    "MTP/m-Q2_K-MTP.gguf": false,
    "MTP/m-Q4_0-MTP.gguf": true,
  });
});

test("quant_floor_flag_survives_the_wire_model", async () => {
  // The QUANT-row hop of the same guard (2026-08-13: RepoQuantRow didn't declare q4OrBetter,
  // the form's ≥4-bit fallback saw undefined and handed an 8 GB box the 1-bit IQ1_M).
  const { ListFilesResponse } = await import("../src/llm/model_catalog_api.js");
  const data = models.classifyGgufEntries([
    { type: "file", path: "m-UD-IQ1_M.gguf", oid: "a", lfs: { oid: "l1", size: 10 * GIB } },
    { type: "file", path: "m-UD-Q4_K_XL.gguf", oid: "b", lfs: { oid: "l2", size: 22 * GIB } },
  ]);
  const rows = model(ListFilesResponse, data).quants;
  expect(Object.fromEntries(rows.map((r) => [r.quant, r.q4OrBetter]))).toEqual({ "UD-IQ1_M": false, "UD-Q4_K_XL": true });
});

test("loadable_flag_survives_the_wire_model", async () => {
  // SAME wire-strip guard for the loadability fields (2026-07-21).
  const { ListFilesResponse } = await import("../src/llm/model_catalog_api.js");
  const data = models.classifyGgufEntries([
    { type: "file", path: "MTP/m-Q4_0-MTP.gguf", oid: "a", lfs: { oid: "l1", size: 9 } },
    { type: "file", path: "m-dspark-Q4_1.gguf", oid: "b", lfs: { oid: "l2", size: 5 } },
  ]);
  const rows = Object.fromEntries(model(ListFilesResponse, data).drafts.map((r) => [r.path, r]));
  expect(rows["MTP/m-Q4_0-MTP.gguf"].loadable).toBe(true);
  expect(rows["MTP/m-Q4_0-MTP.gguf"].unsupportedArch).toBe("");
  expect(rows["m-dspark-Q4_1.gguf"].loadable).toBe(false);
  expect(rows["m-dspark-Q4_1.gguf"].unsupportedArch).toBe("dspark");
});

test("drafter_floor_fires_alone_over_a_smaller_low_bit_quant", async () => {
  // Isolates the FLOOR: a Q2_K that is the smallest file beside a larger Q4_K_M — only the
  // 4-bit floor can reject the smaller Q2_K.
  const tree = [
    { type: "file", path: "model-Q2_K.gguf", oid: "a", lfs: { oid: "l1", size: 1 * GB } },
    { type: "file", path: "model-Q4_K_M.gguf", oid: "b", lfs: { oid: "l2", size: 3 * GB } },
  ];
  mockGet(tree);
  expect(await models._ggufDrafterInRepo("owner/repo")).toEqual({ repo: "owner/repo", file: "model-Q4_K_M.gguf", quant: "Q4_K_M" });
});

test("drafter_falls_back_to_smallest_when_nothing_clears_the_floor", async () => {
  // The floor is a PREFERENCE, not a filter: a repo with only sub-4-bit quants still gets a
  // suggestion — the smallest of them.
  const tree = [
    { type: "file", path: "model-Q3_K_S.gguf", oid: "a", lfs: { oid: "l1", size: 3 * GB } },
    { type: "file", path: "model-Q2_K.gguf", oid: "b", lfs: { oid: "l2", size: 1 * GB } },
  ];
  mockGet(tree);
  expect(await models._ggufDrafterInRepo("owner/repo")).toEqual({ repo: "owner/repo", file: "model-Q2_K.gguf", quant: "Q2_K" });
});

// ── word-bounded quant matching in selectFiles + cachedGgufPath (2026-07-19) ──────────

const PQ_TREE = [
  { type: "file", path: "Ternary-Bonsai-27B-PQ2_0.gguf", oid: "a", lfs: { oid: "l1", size: 4 } },
  { type: "file", path: "Ternary-Bonsai-27B-Q2_0.gguf", oid: "b", lfs: { oid: "l2", size: 4 } },
];

test("select_files_pq2_0_and_q2_0_dont_cross_match", async () => {
  // "Q2_0" must select ONLY the plain Q2_0 file — not the PQ2_0 (a different quant); "PQ2_0"
  // must select ONLY its own file.
  mockGet(PQ_TREE);
  const [, q] = await models.selectFiles("owner/repo", "Q2_0");
  expect(q.map((f) => f.path)).toEqual(["Ternary-Bonsai-27B-Q2_0.gguf"]);
  const [, pq] = await models.selectFiles("owner/repo", "PQ2_0");
  expect(pq.map((f) => f.path)).toEqual(["Ternary-Bonsai-27B-PQ2_0.gguf"]);
});

test("select_files_q2_0_excludes_longer_g64_token", async () => {
  // "Q2_0" must not match a "Q2_0_g64"-named file (a longer, distinct token).
  const tree = [
    { type: "file", path: "model-Q2_0.gguf", oid: "a", lfs: { oid: "l1", size: 4 } },
    { type: "file", path: "model-Q2_0_g64.gguf", oid: "b", lfs: { oid: "l2", size: 4 } },
  ];
  mockGet(tree);
  const [, files] = await models.selectFiles("owner/repo", "Q2_0");
  expect(files.map((f) => f.path)).toEqual(["model-Q2_0.gguf"]);
});

test("cached_gguf_path_word_bounded_quant", () => {
  // The SAME boundary rule holds for the on-disk cache lookup.
  const snap = join(tmpPath, "models--owner--repo", "snapshots", "sha");
  mkdirSync(snap, { recursive: true });
  writeFileSync(join(snap, "Ternary-Bonsai-27B-PQ2_0.gguf"), Buffer.from("GGUF"));
  writeFileSync(join(snap, "Ternary-Bonsai-27B-Q2_0.gguf"), Buffer.from("GGUF"));
  const q = models.cachedGgufPath("owner/repo", "Q2_0", { cacheRoot: tmpPath });
  expect(q !== null && basename(q) === "Ternary-Bonsai-27B-Q2_0.gguf").toBe(true);
  const pq = models.cachedGgufPath("owner/repo", "PQ2_0", { cacheRoot: tmpPath });
  expect(pq !== null && basename(pq) === "Ternary-Bonsai-27B-PQ2_0.gguf").toBe(true);
  expect(models.isCached("owner/repo", "Q2_0", { cacheRoot: tmpPath })).toBe(true);
});
