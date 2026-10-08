// SPDX-License-Identifier: MIT
// THE route diff (the Electron move's plan §2.2 — the user's rule: "the old and new servers
// run against the same database and each route's answers are compared").
//
// Read routes: the app's REAL Python server (docgen's, mounting llm_runner) and the Node host
// mounting the JavaScript kit (kit-host.mjs), each on its OWN COPY of the app's dev database,
// both pointed at a scratch copy of the family cache registry (JUST_AI_HOME) so neither writes
// the real one. Every kit GET (scripts/route-table.json) is sent to both, parameters filled
// from the Python side's own answers; status, content type and JSON are compared — key order
// included. Nothing starts a model: GETs never load one, and both run on loopback ports
// nobody else uses.
//
//   node scripts/node24.mjs scripts/route-diff/route-diff.mjs [--clean]
//
// Writes the full report to <scratch>/report.json (kept; --clean deletes the scratch folder)
// and prints a summary. Exit 0 = no
// differences outside the known-volatile list below.

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";

const HERE = import.meta.dirname;
const SERVER = path.resolve(HERE, "../..");
// --app: compare the app's WHOLE server (its own routes + the kit's) — the Node side is the
// app's own server/src/serve.js instead of the kit-only host.
// --target: which app's Python server is the reference (default: the one being moved now).
const { values: opts } = parseArgs({
  options: { clean: { type: "boolean" }, app: { type: "boolean" }, target: { type: "string", default: "justwrite" } },
});

const APPS = {
  // docgen's run (2026-10-08) was the last against it: its Python server was deleted after it.
  docgen: {
    name: "docgen",
    dataRoot: "E:/Dev/Web/just_ai_i18n_docgen/data",
    db: "app.db",
    python: "E:/Dev/Web/just_ai_i18n_docgen/server/.venv/Scripts/python.exe",
    pyArgs: (port, dir) => ["-m", "just_ai_i18n_docgen.serve", "serve", "--port", String(port), "--data-dir", dir],
    nodeEntry: "E:/Dev/Web/just_ai_i18n_docgen/server/src/serve.js",
  },
  justwrite: {
    name: "justwrite",
    dataRoot: "E:/Dev/Web/justwrite-app/data",
    db: "justwrite.db",
    python: "E:/Dev/Web/justwrite-app/.venv/Scripts/python.exe",
    pyArgs: (port, dir) => ["-m", "justwrite_server.serve", "serve", "--port", String(port), "--data-dir", dir],
    nodeEntry: "E:/Dev/Web/justwrite-app/server/src/serve.js",
  },
};
const APP = APPS[opts.target];
if (!APP) throw new Error(`--target: one of ${Object.keys(APPS).join(", ")}`);
const PY_PORT = 8790;
const JS_PORT = 8791;

// Answers that change by themselves between two reads (live hardware readings, log content,
// sizes on disk, the network) — compared for status only, and listed in the report.
const VOLATILE = [
  /^\/v1\/llm-runner\/hardware/,
  /^\/v1\/llm-runner\/gpu-processes/,
  /^\/v1\/llm-runner\/resident/,
  /^\/v1\/llm-runner\/engine\/update-check/,
  /^\/v1\/llm-runner\/engine\/resolve-assets/,
  /^\/v1\/logs\//,
  /^\/v1\/disk\/usage/,
  // A backup zip: its bytes differ by the entries' timestamps; each server restores the
  // other's (the kit's data_api tests prove it both ways).
  /^\/v1\/data\/backup/,
  // A book's export zip: the same files, different zip framing (JustWrite's port writes its
  // own zip; each server imports the other's — its book_transfer tests).
  /^\/v1\/projects\/[^/]+\/export/,
];
// Kit routers docgen mounts with its own hooks; the Node host doesn't (step 3 ports docgen).
const NOT_MOUNTED = [/^\/v1\/data\//, /^\/v1\/prefs/];

const scratch = mkdtempSync(path.join(os.tmpdir(), "route-diff-"));
const dirs = { py: path.join(scratch, "py"), js: path.join(scratch, "js"), home: path.join(scratch, "home") };
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
copyFileSync(path.join(APP.dataRoot, APP.db), path.join(dirs.py, APP.db));
copyFileSync(path.join(APP.dataRoot, APP.db), path.join(dirs.js, APP.db));
const realReg = path.join(process.env.LOCALAPPDATA || "", "just-ai", "caches.json");
if (existsSync(realReg)) copyFileSync(realReg, path.join(dirs.home, "caches.json"));
const env = { ...process.env, JUST_AI_HOME: dirs.home, PYTHONIOENCODING: "utf-8" };

// The Node host's arguments, from the app's own Python data (kit-only mode; --app runs the
// app's own server, which has them built in).
const argsFile = path.join(scratch, "host-args.json");
if (!opts.app) await new Promise((resolve, reject) => {
  const c = spawn(APP.python, [path.join(HERE, "host-args.py"), APP.name], { env, windowsHide: true });
  const out = [];
  c.stdout.on("data", (d) => out.push(d));
  c.stderr.on("data", (d) => process.stderr.write(d));
  c.on("close", (code) => {
    if (code) return reject(new Error(`host-args.py exited ${code}`));
    writeFileSync(argsFile, Buffer.concat(out));
    resolve();
  });
});

const procs = [];
function start(label, cmd, args, extraEnv = {}) {
  const c = spawn(cmd, args, { env: { ...env, ...extraEnv }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const log = [];
  c.stdout.on("data", (d) => log.push(d));
  c.stderr.on("data", (d) => log.push(d));
  procs.push({ label, c, log });
  return c;
}
start("python", APP.python, APP.pyArgs(PY_PORT, dirs.py));
const nodeArgs = opts.app
  ? [APP.nodeEntry, "serve", "--port", String(JS_PORT), "--data-dir", dirs.js]
  : [path.join(HERE, "kit-host.mjs"), "--data-dir", dirs.js, "--port", String(JS_PORT), "--args", argsFile];
start("node", process.execPath, nodeArgs, { ELECTRON_RUN_AS_NODE: "1" });

function stopAll() {
  for (const p of procs) {
    try {
      p.c.kill();
    } catch {
      /* gone */
    }
  }
}
process.on("exit", stopAll);

async function waitUp(port, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/v1/llm-runner/status`);
      if (r.status < 500) return;
    } catch {
      /* not yet */
    }
    const p = procs.find((x) => x.label === label);
    if (p.c.exitCode !== null) throw new Error(`${label} exited: ${Buffer.concat(p.log).toString().slice(-3000)}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${label} never came up`);
}

async function get(port, url) {
  const r = await fetch(`http://127.0.0.1:${port}${url}`);
  const text = await r.text();
  return { status: r.status, type: (r.headers.get("content-type") || "").split(";")[0], text: mask(text), json: parseMasked(text) };
}

// Each side runs on its own copy of the data root: its folder name is the one expected
// difference, so both read as <DATA>.
function mask(text) {
  let t = text;
  for (const d of [dirs.py, dirs.js]) {
    for (const form of [d, JSON.stringify(d).slice(1, -1), d.replaceAll("\\", "/")]) t = t.split(form).join("<DATA>");
  }
  return t;
}
function parseMasked(text) {
  try {
    return JSON.parse(mask(text));
  } catch {
    return undefined;
  }
}

const canon = (v) => JSON.stringify(v);
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}
function firstDiff(a, b, at = "$") {
  if (canon(a) === canon(b)) return null;
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b) || a === null || b === null || typeof a !== "object") {
    return { at, py: a, js: b };
  }
  if (Array.isArray(a)) {
    if (a.length !== b.length) return { at: `${at}.length`, py: a.length, js: b.length };
    for (let i = 0; i < a.length; i++) {
      const d = firstDiff(a[i], b[i], `${at}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  const missing = ka.filter((k) => !(k in b));
  const extra = kb.filter((k) => !(k in a));
  if (missing.length || extra.length) return { at, missingInJs: missing, extraInJs: extra };
  for (const k of ka) {
    const d = firstDiff(a[k], b[k], `${at}.${k}`);
    if (d) return d;
  }
  if (canon(ka) !== canon(kb)) return { at, keyOrder: { py: ka, js: kb } };
  return null;
}

async function send(port, method, url, body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const r = await fetch(`http://127.0.0.1:${port}${url}`, init);
  const text = await r.text();
  return { status: r.status, type: (r.headers.get("content-type") || "").split(";")[0], text: mask(text), json: parseMasked(text) };
}

/**
 * The write sequence: every store route a user's edits reach — never one that loads,
 * downloads or deletes a model, reaches the network, or touches the cache's files. Ids a
 * server makes up (a new engine preset's uuid) are mapped Python → JS from the answers and
 * substituted in later requests, and in the database comparison.
 */
async function replayWrites(catalog, features) {
  const mid = catalog[0]?.id || "rd-model";
  const feature = features[0] || "translate";
  const idMap = new Map(); // python id → js id
  const steps = [
    ["PUT", "/v1/ai/pricing", { modelId: "RD-Cloud-1", inputPerM: 1.5, outputPerM: 2 }],
    ["DELETE", "/v1/ai/pricing?modelId=gpt-5"],
    ["PUT", "/v1/ai/routing", { default: { llmId: "openai", model: "gpt-4o-mini", embeddingId: "", embeddingModel: "" } }],
    ["POST", "/v1/llm-providers", { id: "rd-prov", name: "RD", providerType: "openai-compat", baseUrl: "http://127.0.0.1:9/v1", local: true }],
    ["PATCH", "/v1/llm-providers/rd-prov", { name: "RD two", providerType: "ollama", baseUrl: "http://127.0.0.1:9", defaultModel: "m1", local: true }],
    ["PUT", "/v1/ai/reasoning-map/rd-prov", { level: "high", word: "high", tokens: 2048 }],
    ["PUT", "/v1/ai/reasoning-map/rd-prov", { level: "low", word: "", tokens: null }],
    ["DELETE", "/v1/llm-providers/rd-prov"],
    ["POST", "/v1/ai/engine-presets", { name: "RD preset", providerId: "openai", model: "gpt-4o-mini", temperature: 0.3, maxTokens: 512, samplers: [{ flagName: "top_k", flagValue: "40" }] }, "preset"],
    ["PUT", "/v1/ai/engine-presets/{preset}", { name: "RD preset 2", providerId: "openai", model: "gpt-4o", temperature: 0.5, topP: 0.9, reasoningEffort: "low", think: true }],
    ["PUT", "/v1/ai/preset-assignments/feature", { featureKey: feature, presetId: "{preset}" }],
    ["POST", `/v1/ai/preset-assignments/feature/${feature}/reset`],
    ["PUT", "/v1/ai/preset-assignments/feature", { featureKey: feature, presetId: "{preset}" }],
    ["POST", "/v1/ai/preset-assignments/clear-features", { featureKeys: [feature] }],
    ["PUT", "/v1/ai/preset-assignments/default", { presetId: "{preset}" }],
    ["DELETE", "/v1/ai/engine-presets/{preset}"],
    ["POST", "/v1/ai/engine-presets/reset"],
    ["PUT", "/v1/ai/switch-presets", { id: "rd-sp", label: "RD", appliesTo: "moe", switches: [{ flagName: "threads", flagValue: "4" }] }],
    ["DELETE", "/v1/ai/switch-presets?presetId=rd-sp"],
    ["POST", "/v1/ai/switch-presets/reset"],
    ["PUT", "/v1/ai/model-catalog", { id: "rd-model", name: "RD model", hfRepo: "org/rd-GGUF", quant: "Q4_K_M", totalParams: "7B", minVramMb: 5000, tier: "mid", samplers: { temp: "0.7" } }],
    ["PUT", "/v1/ai/model-tunes", { modelId: mid, switches: [{ flagName: "threads", flagValue: "6" }, { flagName: "ctx_len", flagValue: "8192" }] }],
    ["PUT", "/v1/ai/class-tunes", { modelId: mid, classKey: "dgpu-vram8|ram32", switches: [{ flagName: "n_cpu_moe", flagValue: "12" }] }],
    ["PUT", "/v1/ai/hardware-class", { name: "RD box", memType: "discrete", vramGb: 12, ramGb: 64, vramBwGbps: 360, ramBwGbps: null }],
    ["DELETE", "/v1/ai/hardware-class?classKey=dgpu-vram12|ram64"],
    ["POST", "/v1/ai/model-measurements", { modelId: mid, source: "tune", label: "rd", tokensPerSec: 12.5, vramTotalMb: 5000, switches: [{ flagName: "threads", flagValue: "6" }] }],
    ["PUT", "/v1/ai/embed-templates", { modelId: "rd-embed", documentTemplate: "search_document: {text}", queryTemplate: "search_query: {text}" }],
    ["DELETE", "/v1/ai/embed-templates?modelId=rd-embed"],
    ["PUT", "/v1/ai/test-samples", { action: "translate", label: "rd sample", variables: { text: "héllo" } }],
    ["PUT", "/v1/ai/engine-config", { safetyMarginMb: 900, modelsMax: 3, bandFineToks: 9.5, warmDefaultOnStartup: false }],
    ["DELETE", `/v1/ai/class-tunes?modelId=${encodeURIComponent(mid)}&classKey=${encodeURIComponent("dgpu-vram8|ram32")}`],
    ["DELETE", `/v1/ai/model-tunes?modelId=${encodeURIComponent(mid)}`],
    ["DELETE", "/v1/ai/model-catalog?modelId=rd-model"],
    ["POST", "/v1/ai/engine-config/reset"],
    ["DELETE", "/v1/ai-usage"],
    ["PUT", "/v1/ai/pricing", { modelId: "", inputPerM: 1 }],
    ["PUT", "/v1/ai/model-tunes", { switches: [] }],
  ];
  const sub = (v, side) => {
    const s = JSON.stringify(v ?? null).replace(/\{preset\}/g, side === "py" ? idMap.get("preset:py") || "x" : idMap.get("preset:js") || "x");
    return JSON.parse(s);
  };
  const results = [];
  for (const [method, url0, body0, capture] of steps) {
    const urlPy = sub(url0, "py");
    const urlJs = sub(url0, "js");
    const a = await send(PY_PORT, method, urlPy, body0 === undefined ? undefined : sub(body0, "py"));
    const b = await send(JS_PORT, method, urlJs, body0 === undefined ? undefined : sub(body0, "js"));
    if (capture === "preset") {
      // The POST answers with the whole list; the new preset is the one with this name.
      const pick = (j) => (j?.presets || []).find((x) => x.name === body0.name)?.id;
      const [pa, pb] = [pick(a.json), pick(b.json)];
      if (pa && pb) {
        idMap.set("preset:py", pa);
        idMap.set("preset:js", pb);
        idMap.set(pb, pa);
      }
    }
    // The JS side's made-up ids read as Python's before comparing.
    let bj = b.json;
    if (bj !== undefined && idMap.size) {
      let t = JSON.stringify(bj);
      for (const [k, v] of idMap) if (!k.includes(":")) t = t.split(k).join(v);
      bj = JSON.parse(t);
    }
    const row = { method, url: url0, py: a.status, js: b.status };
    if (a.status !== b.status || a.type !== b.type) {
      results.push({ ...row, same: false, pyBody: a.text.slice(0, 400), jsBody: b.text.slice(0, 400) });
      continue;
    }
    const d = a.json !== undefined ? firstDiff(unstamp(a.json), unstamp(bj)) : a.text === b.text ? null : { at: "text" };
    results.push({ ...row, same: !d, diff: d });
  }
  return { results, idMap: Object.fromEntries([...idMap].filter(([k]) => !k.includes(":"))) };
}

/** A measurement's `at` is the server's clock (epoch ms): compared for presence only. */
function unstamp(v) {
  if (Array.isArray(v)) return v.map(unstamp);
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = k === "at" && typeof x === "number" ? "<stamp>" : unstamp(x);
    return o;
  }
  return v;
}

/** Both databases, every kit table, every cell (SQLite quote(): type and bytes), rowid order. */
function compareDatabases(idMap) {
  const require = createRequire(path.join(SERVER, "package.json"));
  const Database = require("better-sqlite3");
  const a = new Database(path.join(dirs.py, APP.db), { readonly: true });
  const b = new Database(path.join(dirs.js, APP.db), { readonly: true });
  // Columns a server stamps itself (epoch ms of a measurement) — compared for presence only.
  const STAMPED = { model_measurements: ["at"] };
  const tables = a
    .prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name")
    .all()
    .map((r) => r.name);
  const out = { tables: 0, cells: 0, diffs: [] };
  const fix = (v) => {
    if (typeof v !== "string") return v;
    let t = v;
    for (const [js, py] of Object.entries(idMap)) t = t.split(js).join(py);
    return t;
  };
  for (const t of tables) {
    const colsA = a.pragma(`table_info("${t}")`).map((c) => c.name);
    const colsB = b.pragma(`table_info("${t}")`).map((c) => c.name);
    if (JSON.stringify(colsA) !== JSON.stringify(colsB)) {
      out.diffs.push({ table: t, columns: { py: colsA, js: colsB } });
      continue;
    }
    const sel = `select ${colsA.map((c) => `quote("${c}") as "${c}"`).join(", ")} from "${t}" order by rowid`;
    const ra = a.prepare(sel).all();
    const rb = b.prepare(sel).all();
    out.tables += 1;
    if (ra.length !== rb.length) {
      out.diffs.push({ table: t, rows: { py: ra.length, js: rb.length } });
      continue;
    }
    for (let i = 0; i < ra.length; i++) {
      for (const c of colsA) {
        out.cells += 1;
        if ((STAMPED[t] || []).includes(c)) continue;
        // The machine RAM-bandwidth probe row holds a LIVE measurement each server made.
        if (t === "model_measurements" && ra[i].source === "'probe'" && c === "tokens_per_sec") continue;
        if (ra[i][c] !== fix(rb[i][c])) out.diffs.push({ table: t, row: i, column: c, py: ra[i][c], js: rb[i][c] });
      }
    }
  }
  a.close();
  b.close();
  return out;
}

try {
  await Promise.all([waitUp(PY_PORT, "python"), waitUp(JS_PORT, "node")]);
  let table = JSON.parse(readFileSync(path.join(SERVER, "scripts", "route-table.json"), "utf8"));
  if (opts.app) {
    // The app's whole route table, from its Python app's OpenAPI.
    const out = await new Promise((resolve, reject) => {
      const c = spawn(APP.python, [path.join(HERE, "app-routes.py"), APP.name], { env, windowsHide: true });
      const b = [];
      c.stdout.on("data", (d) => b.push(d));
      c.on("close", (code) => (code ? reject(new Error(`app-routes.py exited ${code}`)) : resolve(Buffer.concat(b).toString())));
    });
    table = JSON.parse(out);
  }

  // Parameter values, from the Python side's own data.
  const catalog = (await get(PY_PORT, "/v1/ai/model-catalog")).json?.rows || [];
  const prompts = (await get(PY_PORT, "/v1/ai/prompts")).json?.prompts || [];
  const providers = (await get(PY_PORT, "/v1/llm-providers")).json || [];
  const routing = (await get(PY_PORT, "/v1/ai/routing")).json || {};
  const providerList = Array.isArray(providers) ? providers : providers.providers || [];
  const features = (routing.features || []).map((f) => f.key);
  const fill = {
    modelId: catalog.slice(0, 4).map((r) => r.id),
    key: prompts.slice(0, 3).map((p) => p.key),
    provider: providerList.slice(0, 4).map((p) => p.id),
    provider_id: providerList.filter((p) => p.local).slice(0, 2).map((p) => p.id),
    feature: features.slice(0, 3),
    action: prompts.slice(0, 2).map((p) => p.key),
    date: [new Date().toISOString().slice(0, 10)],
    build: ["b11239"],
  };
  if (opts.app && APP.name === "justwrite") {
    // JustWrite's own routes, from the Python side's answers.
    const projects = (await get(PY_PORT, "/v1/projects")).json || [];
    fill.project_id = projects.slice(0, 3).map((p) => p.id);
    fill.projectId = fill.project_id;
    const sessions = [];
    for (const id of fill.project_id) {
      const s = (await get(PY_PORT, `/v1/chat/sessions?projectId=${encodeURIComponent(id)}`)).json;
      for (const x of Array.isArray(s) ? s : s?.sessions || []) sessions.push(x.id);
    }
    fill.session_id = sessions.slice(0, 3);
    fill.key = [...fill.key, ...((await get(PY_PORT, "/v1/projects/autosaves")).json || []).slice(0, 2).map((a) => a.key)];
  }

  const urls = [];
  for (const r of table) {
    if (r.method !== "GET") continue;
    if (!opts.app && NOT_MOUNTED.some((re) => re.test(r.path))) continue;
    const pathParams = r.params.filter((p) => p.in === "path");
    const reqQuery = r.params.filter((p) => p.in === "query" && p.required);
    const combos = [{}];
    for (const p of [...pathParams, ...reqQuery]) {
      const vals = fill[p.name] || [];
      const next = [];
      for (const c of combos) for (const v of vals.length ? vals : ["x"]) next.push({ ...c, [p.name]: v });
      combos.splice(0, combos.length, ...next);
    }
    for (const c of combos) {
      let u = r.path;
      const q = [];
      for (const [k, v] of Object.entries(c)) {
        if (u.includes(`{${k}}`)) u = u.replace(`{${k}}`, encodeURIComponent(v));
        else q.push(`${k}=${encodeURIComponent(v)}`);
      }
      urls.push(q.length ? `${u}?${q.join("&")}` : u);
    }
    // the shape of a missing required query parameter
    if (reqQuery.length && !pathParams.length) urls.push(r.path);
  }
  // A few error answers on purpose.
  urls.push("/v1/nothing-here", "/v1/ai/prompts/no-such-prompt", "/v1/ai/model-tunes?modelId=", "/v1/llm-runner/models?vram_mb=abc");

  const report = { scratch, same: [], volatile: [], differ: [] };
  for (const u of urls) {
    const [a, b] = [await get(PY_PORT, u), await get(JS_PORT, u)];
    const volatile = VOLATILE.some((re) => re.test(u));
    const row = { url: u, py: a.status, js: b.status };
    if (a.status !== b.status || a.type !== b.type) {
      report.differ.push({ ...row, pyType: a.type, jsType: b.type, pyBody: a.text.slice(0, 600), jsBody: b.text.slice(0, 600) });
      continue;
    }
    if (volatile) {
      // Still compared — recorded, not failed — so the report shows WHAT moved.
      const d = a.json !== undefined ? firstDiff(a.json, b.json) : a.text === b.text ? null : { at: "text" };
      report.volatile.push({ ...row, same: !d, diff: d });
      continue;
    }
    const d = a.json !== undefined ? firstDiff(a.json, b.json) : a.text === b.text ? null : { at: "text" };
    if (!d) report.same.push(row);
    else {
      const loose = a.json !== undefined && canon(sortKeys(a.json)) === canon(sortKeys(b.json));
      report.differ.push({ ...row, keyOrderOnly: loose, diff: d });
    }
  }
  console.log(`reads — ${urls.length} requests: ${report.same.length} identical, ${report.volatile.length} volatile (status equal), ${report.differ.length} different`);
  for (const v of report.volatile) console.log(`  volatile ${v.url}: ${v.same ? "identical this time" : JSON.stringify(v.diff).slice(0, 200)}`);
  for (const d of report.differ) console.log(`  DIFF ${d.url}  py ${d.py} / js ${d.js}  ${JSON.stringify(d.diff || d.pyBody).slice(0, 300)}`);

  // ── writes: one recorded sequence, replayed on both, every answer compared ───────────
  const writes = await replayWrites(catalog, features);
  report.writes = writes;
  console.log(`writes — ${writes.results.length} requests: ${writes.results.filter((r) => r.same).length} identical, ${writes.results.filter((r) => !r.same).length} different`);
  for (const w of writes.results.filter((r) => !r.same)) {
    console.log(`  DIFF ${w.method} ${w.url}  py ${w.py} / js ${w.js}  ${JSON.stringify(w.diff || w.pyBody).slice(0, 300)}`);
  }

  // ── then both databases, cell by cell (the servers stopped first) ─────────────────────
  stopAll();
  await new Promise((r) => setTimeout(r, 1500));
  report.db = compareDatabases(writes.idMap);
  console.log(`database — ${report.db.tables} tables, ${report.db.cells} cells: ${report.db.diffs.length} different`);
  for (const d of report.db.diffs.slice(0, 20)) console.log(`  DB ${JSON.stringify(d).slice(0, 300)}`);
  writeFileSync(path.join(scratch, "report.json"), JSON.stringify(report, null, 2));
  console.log(`report: ${path.join(scratch, "report.json")}`);
  process.exitCode = report.differ.length || writes.results.some((r) => !r.same) || report.db.diffs.length ? 1 : 0;
} catch (e) {
  console.error(String(e?.stack || e));
  process.exitCode = 2;
} finally {
  stopAll();
  await new Promise((r) => setTimeout(r, 800));
  if (opts.clean) {
    try {
      rmSync(scratch, { recursive: true, force: true });
    } catch {
      /* a process may still hold a file */
    }
  }
}
