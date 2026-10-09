// SPDX-License-Identifier: MIT
// The model-catalog router (llm/model_catalog_api.js) — not a Python test file: Python
// has no router test for it. Every expected answer below is what the Python router gave
// through FastAPI's TestClient on 2026-10-07, with the same injected functions and the
// kit's problem+json handlers (status, fields, field order).
import { beforeEach, expect, test } from "vitest";
import { makeCatalogRouter } from "../src/llm/model_catalog_api.js";
import * as seed from "../src/llm/seed.js";
import * as stores from "../src/llm/stores.js";
import { HttpError } from "../src/platform/errors.js";
import { FileNotFoundError, RuntimeError, ValueError } from "../src/platform/py.js";
import { createServer } from "../src/platform/server.js";
import { classifyGgufEntries } from "../src/runner/models.js";
import { freshDb } from "./helpers.js";

const CATALOG = [
  { id: "dense-a", name: "Dense A", hf_repo: "x/dense-a-GGUF", quant: "Q4_K_M", samplers: { top_k: "40", temperature: "0.8" } },
  { id: "moe-d", name: "MoE D", hf_repo: "x/moe-d-GGUF", quant: "UD-Q4_K_XL", type: "moe", mtp: true, mtp_builtin: true },
];
const ENTRIES = [
  { type: "file", path: "README.md", size: 10 },
  { type: "file", path: "m-Q4_K_M.gguf", lfs: { oid: "a", size: 4000000000 } },
  { type: "file", path: "UD-Q2_K_XL/m-00001-of-00002.gguf", lfs: { oid: "b", size: 3000000000 } },
  { type: "file", path: "UD-Q2_K_XL/m-00002-of-00002.gguf", lfs: { oid: "c", size: 3000000000 } },
  { type: "file", path: "m-qat-IQ4_XS.gguf", lfs: { oid: "d", size: 3500000000 } },
  { type: "file", path: "MTP/m-Q4_0-MTP.gguf", lfs: { oid: "e", size: 500000000 } },
  { type: "file", path: "m-dspark-Q4_1.gguf", lfs: { oid: "f", size: 400000000 } },
  { type: "file", path: "mmproj-F16.gguf", lfs: { oid: "g", size: 900000000 } },
];
const INSPECT = {
  architecture: "qwen35", type: "dense", mtpBuiltin: true, trainedCtx: 262144, experts: 0, sizeLabel: "27B",
  totalParams: "27B", samplers: { temperature: "1" }, sizeBytes: 17000000000, estVramMb: 18001,
  physicsFacts: { block_count: 65, expert_byte_share: 0.0 }, estRamMb: 24576, mtpInheritedRepo: "",
  mtpInheritedFile: "", mtpInheritedQuant: "", junk: 1,
};

let app;
let resets;
beforeEach(() => {
  const h = freshDb();
  const saved = seed.cfg.DEFAULT_CATALOG;
  seed.cfg.DEFAULT_CATALOG = CATALOG;
  try {
    h.tx(() => seed.seedDefaultCatalog(h));
  } finally {
    seed.cfg.DEFAULT_CATALOG = saved;
  }
  resets = 0;
  app = createServer({ typeBase: "https://example.test/errors/" });
  app.route(
    "/",
    makeCatalogRouter(stores.getModelCatalogStore, {
      resolveSwitches: (mid) => (mid === "dense-a" ? { ctx_len: "8192", n_gpu_layers: "99" } : {}),
      resolveOrigins: (mid) =>
        mid === "dense-a"
          ? [{ ctx_len: "8192", mlock: true, x: 1.5 }, { ctx_len: "base", mlock: "type" }]
          : [{ ctx_len: "16384" }, null],
      resolveBaselineOrigins: () => [{ ctx_len: "4096", n_cpu_moe: "3" }, { ctx_len: "type" }],
      previewFitFn: async (mid) => {
        if (mid === "boom") throw new RuntimeError("no gguf");
        return { ok: true, nGpuLayers: 81, ctxLen: 32768, isMoe: mid === "moe-d", nCpuMoe: 12 };
      },
      inspectFn: async (repo, quant, revision) => {
        if (repo === "missing") throw new FileNotFoundError(`no .gguf matching quant '${quant}' in ${repo}@${revision}`);
        if (repo === "bad") throw new RuntimeError("network down");
        if (repo === "http") throw new HttpError(418, "teapot");
        return { ...INSPECT };
      },
      listFilesFn: async (repo) => {
        if (repo === "bad") throw new ValueError("nope");
        return classifyGgufEntries(ENTRIES);
      },
      classTuneRefsFn: () => [{ modelId: "dense-a", classKey: "dgpu-vram8|ram32", extra: 1 }],
      classKeyFn: () => "dgpu-vram8|ram32",
      onReset: () => {
        resets += 1;
      },
    }),
  );
});

const call = async (method, url, payload) => {
  const r = await app.request(
    url,
    payload === undefined
      ? { method }
      : { method, body: JSON.stringify(payload), headers: { "content-type": "application/json" } },
  );
  return [r.status, await r.json()];
};
const problem = (status, title, slug, detail, instance) => ({
  type: `https://example.test/errors/${slug}`,
  title,
  status,
  detail,
  instance,
});

test("resolved defaults: origins, computed fit values, the baseline and the bool query", async () => {
  const url = "/v1/ai/model-catalog/resolved-defaults";
  expect(await call("GET", `${url}?modelId=dense-a`)).toEqual([
    200,
    {
      modelId: "dense-a",
      switches: [
        { flagName: "ctx_len", flagValue: "8192" },
        { flagName: "mlock", flagValue: "True" },
        { flagName: "x", flagValue: "1.5" },
      ],
      samplers: [
        { flagName: "temperature", flagValue: "0.8" },
        { flagName: "top_k", flagValue: "40" },
      ],
      mtpCapable: false,
      computed: [{ flagName: "n_gpu_layers", flagValue: "81" }],
      origins: { ctx_len: "base", mlock: "type" },
    },
  ]);
  const baseline = {
    modelId: "moe-d",
    switches: [
      { flagName: "ctx_len", flagValue: "4096" },
      { flagName: "n_cpu_moe", flagValue: "3" },
    ],
    samplers: [],
    mtpCapable: true,
    computed: [{ flagName: "n_gpu_layers", flagValue: "81" }],
    origins: { ctx_len: "type" },
  };
  expect(await call("GET", `${url}?modelId=moe-d&excludeTune=1`)).toEqual([200, baseline]);
  expect(await call("GET", `${url}?modelId=moe-d&excludeTune=YES`)).toEqual([200, baseline]);
  expect(await call("GET", `${url}?modelId=moe-d&excludeTune=off`)).toEqual([
    200,
    {
      modelId: "moe-d",
      switches: [{ flagName: "ctx_len", flagValue: "16384" }],
      samplers: [],
      mtpCapable: true,
      computed: [
        { flagName: "n_gpu_layers", flagValue: "81" },
        { flagName: "n_cpu_moe", flagValue: "12" },
      ],
      origins: {},
    },
  ]);
  const [status, body] = await call("GET", `${url}?modelId=moe-d&excludeTune=maybe`);
  expect(status).toBe(422);
  expect(body.errors).toEqual([
    { loc: ["query", "excludeTune"], msg: "Input should be a valid boolean, unable to interpret input", type: "bool_parsing" },
  ]);
  // a fit preview that throws is an enrichment that never breaks the grid seed
  expect((await call("GET", `${url}?modelId=boom`))[1].computed).toEqual([]);
  expect(await call("GET", `${url}?modelId=%20`)).toEqual([
    400,
    problem(400, "Bad Request", "bad-request", "modelId is required", "/v1/ai/model-catalog/resolved-defaults"),
  ]);
});

test("list-files keeps every declared row field and only those", async () => {
  expect(await call("POST", "/v1/ai/model-catalog/list-files?repo=x/y")).toEqual([
    200,
    {
      quants: [
        { quant: "IQ4_XS", sizeMb: 3337, files: 1, kind: "IQ", qat: true, q4OrBetter: true },
        { quant: "Q4_K_M", sizeMb: 3814, files: 1, kind: "Q", qat: false, q4OrBetter: true },
        { quant: "UD-Q2_K_XL", sizeMb: 5722, files: 2, kind: "Q", qat: false, q4OrBetter: false },
      ],
      drafts: [
        { path: "MTP/m-Q4_0-MTP.gguf", quant: "Q4_0", sizeMb: 476, qat: false, q4OrBetter: true, loadable: true, unsupportedArch: "" },
        { path: "m-dspark-Q4_1.gguf", quant: "Q4_1", sizeMb: 381, qat: false, q4OrBetter: true, loadable: false, unsupportedArch: "dspark" },
      ],
    },
  ]);
  const [status, body] = await call("POST", "/v1/ai/model-catalog/list-files?repo=bad");
  expect(status).toBe(502);
  expect(body.detail).toBe("couldn't list bad: nope");
});

test("inspect: the response model, 404 for no file, 502 for the rest, an HttpError passes", async () => {
  const [status, body] = await call("POST", "/v1/ai/model-catalog/inspect?repo=x/y&quant=Q4");
  expect(status).toBe(200);
  expect(Object.keys(body)).toEqual(Object.keys(INSPECT).filter((k) => k !== "junk"));
  const inst = "/v1/ai/model-catalog/inspect";
  expect(await call("POST", `${inst}?repo=missing`)).toEqual([
    404,
    problem(404, "Not Found", "not-found", "no .gguf matching quant '' in missing@main", inst),
  ]);
  expect(await call("POST", `${inst}?repo=bad`)).toEqual([502, problem(502, "Error", "error", "inspect failed: network down", inst)]);
  expect(await call("POST", `${inst}?repo=http`)).toEqual([418, problem(418, "Error", "error", "teapot", inst)]);
});

test("the catalog response carries the refs and this box's class; reset calls the host", async () => {
  const [, body] = await call("POST", "/v1/ai/model-catalog/reset");
  expect(resets).toBe(1);
  expect(Object.keys(body)).toEqual(["rows", "classTuneRefs", "myClassKey"]);
  expect(body.classTuneRefs).toEqual([{ modelId: "dense-a", classKey: "dgpu-vram8|ram32" }]);
  expect(body.myClassKey).toBe("dgpu-vram8|ram32");
  // a user PUT is never built-in, whatever it says
  const [, after] = await call("PUT", "/v1/ai/model-catalog", { id: "user-y", builtIn: true, mmproj: null, minVramMb: null });
  const row = after.rows.find((r) => r.id === "user-y");
  expect([row.builtIn, row.mmproj, row.minVramMb]).toEqual([false, null, null]);
});
