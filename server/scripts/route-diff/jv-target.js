// SPDX-License-Identifier: MIT
// The route diff's JustVoice target (route-diff.js --app --target justvoice): what JustVoice's
// copies need beyond a database copy, which of its GETs to fill and how, which answers move by
// themselves, and its write sequence. JustVoice's server port is landing in three parts (the API
// wave, 2026-10-08); a GET whose router is not ported yet answers 404 from the Node side and is
// listed apart ("not ported yet"), never as a difference.
//
// The copies (plan §2 — "the database copied, the model caches shared read-only"):
//   - justvoice.db copied, the small content folders copied (voices, personas, lexicons, the
//     runtime's config files);
//   - for the reads, the speech cache (36 GB), the render cache and the take audio are reached
//     through junctions to the REAL dev data root — read only, fingerprinted before and after;
//   - the Node side's `engines-runtime` is a junction to Python's source-tree runtime
//     (server/justvoice/engines — Python unfrozen runs its runtime from there; the JS server
//     always from <data>/engines-runtime);
//   - warm-on-boot OFF in every copy, so nothing could load a model.
// Junctions are unlinked first at cleanup, and a folder still holding one is never removed.

import { cpSync, existsSync, lstatSync, readdirSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { ZipWriter } from "../../src/platform/zip.js";

export const REPO = "E:/Dev/Web/JustVioce";
export const DEV_DATA = `${REPO}/data`;
export const PY_RUNTIME = `${REPO}/server/justvoice/engines`;

const COPIED = ["voices", "personas", "lexicons", "engines-runtime-config", "justvoice"];
const READ_LINKS = ["speech-cache", "cache", "generations"];

const junctions = [];
function junction(target, link) {
  symlinkSync(target, link, "junction");
  junctions.push(link);
}

/** Warm-on-boot OFF in a database copy (runner_setting.warm_default_on_startup = "0"). */
function warmOff(dbFile, serverDir) {
  const require = createRequire(path.join(serverDir, "package.json"));
  const Database = require("better-sqlite3");
  const db = new Database(dbFile);
  db.prepare("update runner_setting set value = '0' where key = 'warm_default_on_startup'").run();
  db.close();
}

/**
 * A data-root copy at `dir` (justvoice.db is already there): the small folders copied, warm OFF,
 * and — `reads` — the big caches as junctions to the real root; `js` — the runtime junction.
 */
export function prepare(dir, { side, reads, serverDir }) {
  for (const rel of COPIED) {
    if (existsSync(path.join(DEV_DATA, rel))) cpSync(path.join(DEV_DATA, rel), path.join(dir, rel), { recursive: true });
  }
  warmOff(path.join(dir, "justvoice.db"), serverDir);
  if (reads) for (const rel of READ_LINKS) junction(path.join(DEV_DATA, rel), path.join(dir, rel));
  if (side === "js") junction(PY_RUNTIME, path.join(dir, "engines-runtime"));
}

/** Unlink every junction made here (the link goes, the target stays). */
export function unlinkJunctions() {
  for (const link of junctions.splice(0)) {
    try {
      rmdirSync(link);
    } catch {
      unlinkSync(link);
    }
  }
}

/** Unlink every junction made here, check none is left under `root`, then remove it. */
export function cleanup(root) {
  unlinkJunctions();
  const left = [];
  const walk = (p) => {
    for (const e of readdirSync(p)) {
      const q = path.join(p, e);
      const s = lstatSync(q);
      if (s.isSymbolicLink()) left.push(q);
      else if (s.isDirectory()) walk(q);
    }
  };
  walk(root);
  if (left.length) throw new Error(`refusing to delete ${root}: links left: ${left.join(", ")}`);
  rmSync(root, { recursive: true, force: true });
}

/** Files, bytes and the newest change of a real folder — taken before and after. */
export function fingerprint(root) {
  let files = 0;
  let bytes = 0;
  let newest = 0;
  const walk = (p) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const q = path.join(p, e.name);
      if (e.isDirectory()) walk(q);
      else {
        const s = statSync(q);
        files += 1;
        bytes += s.size;
        newest = Math.max(newest, s.mtimeMs);
      }
    }
  };
  if (existsSync(root)) {
    const s = statSync(root);
    if (s.isFile()) return { files: 1, bytes: s.size, newest: s.mtimeMs };
    walk(root);
  }
  return { files, bytes, newest };
}

export const REAL_FOLDERS = [...READ_LINKS.map((r) => path.join(DEV_DATA, r)), path.join(PY_RUNTIME, "audiocpp"), path.join(DEV_DATA, "justvoice.db")];

/** The routers a later part of the port brings (their GETs answer 404 until then). Agent 2's
 * (generate, voice preview, render chapter / jobs / lines, takes, voices, personas, voice
 * bundle, master, effect presets, lexicons, pronunciation) joined 2026-10-08, agent 3's
 * (projects, extraction, speakers, smart-assign, project export, export jobs, bulk delete) the
 * same day — the whole server is ported. */
export const LATER = new Set([]);

/** GETs never sent: a voice preview SYNTHESIZES (it may load a model), whatever its id; the ACX
 * check renders every chapter of the book (it warms and masters real lines). */
export const SKIP = [/^\/v1\/voices\/\{voice_id\}\/preview\/stream$/, /^\/v1\/projects\/\{project_id\}\/qc$/];

/** Answers that move by themselves (live hardware, processes, sizes) — compared for status. */
export const VOLATILE = [
  /^\/v1\/system\/info/, // live RAM / GPU / ffmpeg probes
  /^\/v1\/engines\/vram/, // the measured pool (nvidia-smi)
  /^\/v1\/engines\/leftovers/, // the live process table
  // A voice bundle: a zip whose entries carry the moment it was written (each side reads the
  // other's — voice_bundle tests).
  /^\/v1\/voices\/[^/]+\/bundle\.zip$/,
];

/** Path/query values for JustVoice's own GETs, from the Python side's own answers. */
export async function fill(get, PY) {
  const engines = (await get(PY, "/v1/engines")).json?.engines || [];
  const managed = engines.filter((e) => e.backend === "managed").map((e) => e.id);
  // A voice of each engine's presets (the first) and every stored voice, from Python's list.
  const all = (await get(PY, "/v1/voices")).json?.voices || [];
  const seen = new Set();
  const voices = [];
  for (const v of all) {
    if (v.source !== "preset") voices.push(v.id);
    else if (!seen.has(v.engine)) {
      seen.add(v.engine);
      voices.push(v.id);
    }
  }
  return { managed, voices };
}

/** Agent 2's routers' parameters: which of the copy's ids each one reads. */
const MODULE_FILLS = {
  voices_api: { id: "voices" },
  voice_bundle_api: { voice_id: "voices" },
  personas_api: { id: "personas3", persona_id: "personas3" },
  lexicons_api: { id: "lexicons" },
  render_chapter_api: { project_id: "projects" },
  render_lines_api: { project_id: "projects", scene_id: "scenes" },
  render_jobs_api: { job_id: "jobs" },
  takes_api: { block_id: "blocks", take_id: "takes", generation_id: "generations" },
  // Agent 3's.
  projects_api: { project_id: "projects", scene_id: "scenes" },
  extraction_api: { project_id: "projects", scene_id: "scenes" },
  speakers_api: { project_id: "projects" },
  project_export_api: { project_id: "projects" },
};

/** The fill for one route's parameter (null = the generic "x"). */
export function valuesFor(row, name, extra) {
  if (LATER.has(row.module)) return null; // a later port's route: never a real id (see SKIP)
  const own = MODULE_FILLS[row.module]?.[name];
  if (own) return extra[own].length ? extra[own] : null;
  if (name === "engine_id" || name === "id") return extra.managed;
  if (name === "persona_id") return extra.personas.slice(0, 2);
  if (name === "generation_id") return extra.generations.slice(0, 1);
  return null;
}

/** The ids the reads need from the database copy (personas, a completed generation, and agent
 * 2's routers' rows: projects, chapters, lines, takes, render jobs, lexicons). */
export function dbIds(dbFile, serverDir) {
  const require = createRequire(path.join(serverDir, "package.json"));
  const Database = require("better-sqlite3");
  const db = new Database(dbFile, { readonly: true });
  const ids = (sql) => db.prepare(sql).all().map((r) => r.id);
  const personas = ids("select id from personas order by rowid");
  const generations = ids("select id from generations where status = 'completed' order by rowid limit 1");
  const out = {
    personas,
    personas3: personas.slice(0, 3),
    generations,
    projects: ids("select id from projects order by rowid limit 2"),
    scenes: ids("select id from scenes order by rowid limit 4"),
    blocks: ids("select id from blocks order by rowid limit 2"),
    takes: ids("select id from takes order by rowid limit 2"),
    jobs: ids("select id from render_jobs order by rowid limit 3"),
    lexicons: ids("select id from lexicons order by rowid limit 2"),
    speakers: ids("select id from speakers order by rowid"),
  };
  db.close();
  return out;
}

// ── The writes ───────────────────────────────────────────────────────────────

/** A 16-bit mono WAV of a quarter second of a 440 Hz tone at 16 kHz, base64. */
export function toneWavB64() {
  const rate = 16000;
  const n = rate / 4;
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]).toString("base64");
}

/** A voice bundle (the JustVoice voice-bundle/1 zip) of a designed Kokoro voice — the same bytes
 * to both sides. */
function bundleZip() {
  const z = new ZipWriter();
  z.writestr(
    "voice.json",
    JSON.stringify({
      format: "justvoice-voice-bundle/1",
      engine: "kokoro",
      model: null,
      source: "designed",
      name: "RD bundle",
      language: "en-GB",
      gender: "F",
      design_prompt: "A bright, quick voice.",
      transcript: null,
      embedding: null,
      blend_recipe: null,
    }),
  );
  return z.toBuffer();
}

/**
 * Agent 2's write steps: voices (clone / design / copy / patch / delete, refusals, a bundle
 * imported), the voice preview's refusals (nothing synthesized: every one stops before the
 * engine — the managed ones at 409 engine_not_loaded), personas (create / patch / merge /
 * delete, usage, the stock line, the preview's refusals, Compose / Rewrite's refusals — no
 * persona here has a note, so no LLM runs), lexicons, the pronunciation scan, effect presets,
 * takes bookkeeping, render jobs created with no lines (born completed — never started) and
 * cancelled / resumed when finished, the book's lexicon, Generate's and render_chapter's
 * refusals, and one ffmpeg master of a tone. Never a load, a synthesis or a render.
 */
function agent2Steps(x) {
  const wav = toneWavB64();
  const project = x.projects[0] || "no-project";
  const job = x.jobs[0] || "no-job";
  const take = x.takes[0] || "no-take";
  const take2 = x.takes[1] || "no-take";
  const block = x.blocks[0] || "no-block";
  const pa = x.personas[6] || "no-persona"; // Auberon Vasht (2 lines) in the dev copy
  const pb = x.personas[5] || "no-persona";
  const raw = (o) => ({ __raw: o });
  return [
    // ── voices
    ["GET", "/v1/voices"],
    ["POST", "/v1/voices/clip-check", { wav_b64: wav }],
    ["POST", "/v1/voices/clip-check", { wav_b64: "QQ=" }],
    ["POST", "/v1/voices/clip-check", { wav_b64: "UklGRg==" }],
    // Kokoro clones nothing, so no family is chosen and the engine itself is stored as the
    // model — a voice is made (Python's rule, copied).
    ["POST", "/v1/voices/clone", { engine: "kokoro", name: "RD clone", ref_wav_b64: wav }, "voice5"],
    ["POST", "/v1/voices/clone", { engine: "chatterbox", name: "", ref_wav_b64: wav }],
    // Non-strict base64 skips every character outside the alphabet: an empty clip is stored.
    ["POST", "/v1/voices/clone", { engine: "chatterbox", model: "chatterbox-turbo", name: "RD clone", ref_wav_b64: "%%%" }, "voice6"],
    ["POST", "/v1/voices/clone", { engine: "chatterbox", model: "chatterbox-turbo", name: "RD clone", ref_wav_b64: wav, language: "en-US", transcript: "A tone." }, "voice"],
    ["POST", "/v1/voices/design", { engine: "qwen3", name: "RD design", prompt: "A warm, low voice.", gender: "M" }, "voice2"],
    ["POST", "/v1/voices/design", { engine: "kokoro", model: "nope-model", name: "RD design", prompt: "x" }],
    ["GET", "/v1/voices/{voice}"],
    ["GET", "/v1/voices/{voice2}"],
    ["GET", "/v1/voices/{voice}/model-version?language=fr"],
    ["PATCH", "/v1/voices/{voice}", { gender: "F", name: "RD clone 2" }],
    ["PATCH", "/v1/voices/{voice}", { gender: null }],
    ["PATCH", "/v1/voices/af_heart", { name: "x" }],
    ["POST", "/v1/voices/{voice}/copy", { model: "chatterbox-nano" }],
    ["POST", "/v1/voices/{voice}/copy", { model: "kokoro" }],
    ["POST", "/v1/voices/{voice}/copy", { model: "nope-model" }],
    ["POST", "/v1/voices/{voice}/copy", { model: "qwen3-base", transcript: " " }],
    ["POST", "/v1/voices/{voice2}/copy", { model: "chatterbox-multilingual" }],
    ["POST", "/v1/voices/{voice}/copy", { model: "chatterbox-multilingual", name: " RD multi " }, "voice3"],
    ["POST", "/v1/voices/nope/copy", { model: "chatterbox-multilingual" }],
    ["POST", "/v1/voices/gender-guess", { voices: [] }],
    ["POST", "/v1/voices/blend", { engine: "chatterbox", name: "RD blend", source_voice_ids: ["a", "b"] }],
    ["POST", "/v1/voices/blend", { engine: "kokoro", name: "RD blend", source_voice_ids: ["af_heart"] }],
    ["POST", "/v1/voices/blend", { engine: "kokoro", name: "RD blend", source_voice_ids: ["af_heart", "am_echo"], weights: [1.0] }],
    ["POST", "/v1/voices/blend", { engine: "kokoro", name: "RD blend", source_voice_ids: ["af_heart", "am_echo"], weights: [0, 0] }],
    ["POST", "/v1/voices/blend", { engine: "kokoro", name: "RD blend", strategy: "vector", source_voice_ids: ["af_heart", "am_echo"], weights: [0, 0] }],
    ["POST", "/v1/voices/blend", { engine: "kokoro", name: "RD blend", strategy: "recombine", segments: [{ voice_id: "af_heart" }] }],
    ["POST", "/v1/voices/blend", { engine: "kokoro", name: "RD blend", source_voice_ids: ["af_heart", "am_echo"], weights: [0.5, 0.5] }],
    ["POST", "/v1/voices/blend", { engine: "kokoro", name: "RD blend", strategy: "bogus", source_voice_ids: ["af_heart", "am_echo"] }],
    ["POST", "/v1/voices/bundle", { __multipart: [{ name: "file", data: bundleZip(), filename: "rd.jvvoice.zip", contentType: "application/zip" }] }, "voice4"],
    ["POST", "/v1/voices/bundle", { __multipart: [{ name: "file", data: "not a zip", filename: "x.zip", contentType: "application/zip" }] }],
    ["POST", "/v1/voices/bundle", { __multipart: [{ name: "other", data: "x" }] }],
    ["GET", "/v1/voices/{voice4}"],
    ["GET", "/v1/voices/af_heart/bundle.zip"],
    ["GET", "/v1/voices/nope/bundle.zip"],
    // ── the voice preview's refusals (each stops before the engine)
    ["POST", "/v1/voices/preview", { engine: "qwen3", source: "designed" }],
    ["POST", "/v1/voices/preview", { engine: "chatterbox", source: "cloned" }],
    ["POST", "/v1/voices/preview", { engine: "kokoro", source: "blended", source_voice_ids: ["af_heart"], weights: [1] }],
    ["POST", "/v1/voices/preview", { engine: "kokoro", source: "blended", strategy: "recombine", segments: [] }],
    ["POST", "/v1/voices/preview", { engine: "nope", source: "designed", prompt: "x" }],
    ["POST", "/v1/voices/preview", { engine: "qwen3", source: "designed", prompt: "x", model: "qwen3-base" }],
    ["POST", "/v1/voices/preview", { engine: "qwen3", source: "bogus" }],
    ["POST", "/v1/voices/preview", { engine: "qwen3", source: "designed", prompt: "x", preview_text: "" }],
    ["POST", "/v1/voices/preview/nope/save", { name: "x" }],
    ["POST", "/v1/voices/preview/nope/save", { name: "" }],
    ["POST", "/v1/voices/preview/stream-ticket", { engine: "kokoro", source: "cloned" }],
    ["POST", "/v1/voices/preview/stream-ticket", { engine: "kokoro", source: "blended" }],
    ["POST", "/v1/voices/preview/stream-ticket", { engine: "kokoro", source: "blended", source_voice_ids: ["af_heart", "am_echo"], weights: [1, 1] }],
    ["POST", "/v1/voices/preview/stream-ticket", { engine: "chatterbox", source: "blended", source_voice_ids: ["a"], weights: [1] }],
    ["POST", "/v1/voices/af_heart/preview"],
    ["POST", "/v1/voices/af_heart/preview", { text: "x".repeat(6000) }],
    ["POST", "/v1/voices/nope/preview"],
    ["POST", "/v1/voices/{voice}/preview", { text: "Hello there." }],
    // ── personas
    ["GET", "/v1/personas"],
    ["POST", "/v1/personas", raw('{"name": "RD persona", "voice_id": "af_heart", "effects_chain": [{"type": "gain", "params": {"gain_db": 2.0}}], "default_delivery": {"speed": 1.0, "models": {"kokoro": {"knobs": {}, "seed": 7}}}}'), "persona"],
    ["POST", "/v1/personas", { name: "  rd   PERSONA ", voice_id: "af_heart" }],
    ["POST", "/v1/personas", { name: "   " }],
    ["POST", "/v1/personas", { name: "RD nobody", voice_id: "nope" }],
    ["POST", "/v1/personas", { name: "RD french", voice_id: "af_heart", language: "fr" }],
    ["POST", "/v1/personas", { name: "RD knobs", default_delivery: { models: { "chatterbox-turbo": { knobs: { nope: 1 }, emotion: "zz" } } } }],
    ["POST", "/v1/personas", { name: "RD designed", voice_id: "{voice2}", language: "ja" }, "persona2"],
    ["GET", "/v1/personas/{persona}"],
    ["PATCH", "/v1/personas/{persona}", { note: "  Gravel and smoke.  ", voice_instruct: "", avatar_path: null }],
    ["PATCH", "/v1/personas/{persona}", { voice_id: "{voice3}" }],
    ["PATCH", "/v1/personas/{persona}", { language: "es" }],
    ["PATCH", "/v1/personas/{persona}", { language: "xx" }],
    ["PATCH", "/v1/personas/{persona}", raw('{"default_delivery": {"pitch": 2.0, "models": {"chatterbox-multilingual": {"knobs": {"exaggeration": 0.5}}}}, "effects_chain": [{"type": "reverb", "params": {"room_size": 1.0}}]}')],
    ["PATCH", "/v1/personas/{persona}", { default_delivery: null }],
    ["PATCH", "/v1/personas/{persona}", { name: "RD designed" }],
    ["PATCH", "/v1/personas/{persona}", { bogus: 1 }],
    ["PATCH", "/v1/personas/nope", { note: "x" }],
    ["GET", "/v1/personas/usage"],
    ["GET", `/v1/personas/${pa}/usage-detail`],
    ["GET", "/v1/personas/stock-line?language=ja"],
    ["GET", "/v1/personas/stock-line?language=pt-BR"],
    ["GET", "/v1/personas/stock-line?language=xx"],
    ["POST", "/v1/personas/preview", {}],
    ["POST", "/v1/personas/preview", { persona_id: "nope" }],
    ["POST", "/v1/personas/preview", { persona: { name: "draft" } }],
    ["POST", "/v1/personas/preview", { persona_id: "{persona2}", auto_load: false }],
    ["POST", "/v1/personas/preview", raw(`{"persona_id": "${pa}", "auto_load": false, "delivery": {"speed": 1.0}}`)],
    ["POST", "/v1/personas/preview", { persona: { name: "d", voice_id: "af_heart", default_delivery: { models: { nope: {} } } } }],
    ["POST", "/v1/personas/preview-candidate", { persona: { name: "d" }, candidate: { engine: "qwen3", source: "designed" } }],
    ["POST", "/v1/personas/preview-candidate", { persona: { name: "d" }, candidate: { engine: "nope", source: "designed", prompt: "x" } }],
    ["POST", "/v1/personas/preview-candidate", { persona: { name: "d", default_delivery: { models: { nope: {} } } }, candidate: { engine: "qwen3", source: "designed", prompt: "x" } }],
    ["POST", `/v1/personas/${pa}/compose`],
    ["POST", "/v1/personas/nope/compose"],
    ["POST", `/v1/personas/${pa}/rewrite`, { text: "Hello." }],
    ["POST", `/v1/personas/${pa}/rewrite`, {}],
    ["POST", `/v1/personas/${pa}/merge`, { into: pa }],
    ["POST", `/v1/personas/${pa}/merge`, { into: "nope" }],
    ["POST", `/v1/personas/${pa}/merge`, { into: pb }],
    ["GET", "/v1/personas/usage"],
    ["DELETE", "/v1/personas/{persona2}"],
    ["DELETE", "/v1/personas/{persona2}"],
    // ── voices go
    ["DELETE", "/v1/voices/{voice3}"],
    ["DELETE", "/v1/voices/{voice3}"],
    // ── lexicons + the book's lexicon + the scan
    ["GET", "/v1/lexicons"],
    ["POST", "/v1/lexicons", { name: "RD global", entries: [{ grapheme: "Mara", alias: "Marah" }, { grapheme: "Vance", phoneme_ipa: "vˈæns" }] }, "lexicon"],
    ["POST", "/v1/lexicons", { name: "RD book", scope: "project", project_id: project, entries: [{ grapheme: "Ophra", alias: "Oprah" }] }, "lexicon2"],
    ["POST", "/v1/lexicons", { entries: [] }],
    ["PUT", "/v1/lexicons/{lexicon}", { name: "  RD global 2 ", entries: [{ grapheme: "Mara", phoneme_ipa: "mˈɑːɹə" }] }],
    ["PUT", "/v1/lexicons/{lexicon}", { name: "   ", entries: [] }],
    ["POST", "/v1/lexicons/{lexicon}/entries", { grapheme: "Iven", alias: "Eye-ven" }],
    ["POST", "/v1/lexicons/nope/entries", { grapheme: "x" }],
    ["GET", "/v1/lexicons/{lexicon}"],
    ["GET", "/v1/lexicons"],
    ["POST", `/v1/projects/${project}/lexicon`],
    ["POST", "/v1/projects/nope/lexicon"],
    ["POST", `/v1/projects/${project}/pronunciation-report`],
    ["POST", "/v1/projects/nope/pronunciation-report"],
    ["DELETE", "/v1/lexicons/{lexicon}"],
    ["DELETE", "/v1/lexicons/{lexicon}"],
    // ── effect presets
    ["GET", "/v1/effects/catalog"],
    ["GET", "/v1/effect-presets"],
    ["POST", "/v1/effect-presets", raw('{"name": "RD chain", "description": "two", "chain": [{"type": "gain", "params": {"gain_db": 3.0}}, {"type": "delay", "params": {"mix": 0.5, "feedback": 0.0}}], "sort_order": 7}'), "effpreset"],
    ["POST", "/v1/effect-presets", { name: "RD chain" }],
    ["POST", "/v1/effect-presets", { name: "" }],
    ["POST", "/v1/effect-presets", { name: "RD bad", chain: [1, 2] }],
    ["PATCH", "/v1/effect-presets/{effpreset}", raw('{"chain": [{"type": "eq_low", "params": {"gain_db": -2.0, "q": 0.7}}], "sort_order": 3}')],
    ["PATCH", "/v1/effect-presets/{effpreset}", { name: "Robotic" }],
    ["PATCH", "/v1/effect-presets/nope", { name: "x" }],
    ["GET", "/v1/effect-presets"],
    ["DELETE", "/v1/effect-presets/{effpreset}"],
    ["DELETE", "/v1/effect-presets/nope"],
    // ── takes bookkeeping (no render)
    ["GET", "/v1/takes/recent?limit=3"],
    ["GET", "/v1/takes/recent?limit=abc"],
    ["GET", `/v1/takes/by_block/${block}`],
    ["PATCH", `/v1/takes/${take}`, { label: "RD keeper" }],
    ["PATCH", `/v1/takes/${take}`, {}],
    ["PATCH", "/v1/takes/nope", { label: "x" }],
    ["POST", `/v1/takes/${take}/set_default`],
    ["POST", "/v1/takes/nope/set_default"],
    ["GET", `/v1/takes/${take}/lineage`],
    ["DELETE", `/v1/takes/${take2}`],
    ["DELETE", "/v1/takes/nope"],
    ["DELETE", "/v1/generations/nope"],
    ["POST", "/v1/blocks/nope/render"],
    ["POST", "/v1/blocks/nope/render", { new_take: "maybe" }],
    // ── render jobs with no lines (born completed — never started), and finished jobs
    ["POST", "/v1/render_jobs", { project_id: project, scope: "scene", scope_ids: [] }],
    ["POST", "/v1/render_jobs", { project_id: project, scope: "blocks", scope_ids: ["nope"] }],
    ["POST", "/v1/render_jobs", { project_id: project, scope: "bogus", scope_ids: ["x"] }],
    ["POST", "/v1/render_jobs", { project_id: project, scope: "scene", scope_ids: ["no-such-scene"] }, "job"],
    ["GET", "/v1/render_jobs/{job}?include_blocks=true"],
    ["POST", "/v1/render_jobs/{job}/cancel"],
    ["POST", `/v1/render_jobs/${job}/cancel`],
    ["POST", `/v1/render_jobs/${job}/resume`],
    ["GET", `/v1/render_jobs/${job}?include_blocks=1`],
    ["POST", "/v1/render_jobs/nope/cancel"],
    ["POST", "/v1/render_jobs/nope/resume"],
    // ── Generate's, render_chapter's and master's refusals; one ffmpeg master of a tone
    ["POST", "/v1/generate", { voice: "af_heart", text: "Hello." }],
    ["POST", "/v1/generate", { voice: "nope", text: "Hello." }],
    ["POST", "/v1/generate", { voice: "af_heart", text: "x".repeat(6000) }],
    ["POST", "/v1/generate", { voice: "af_heart" }],
    ["POST", "/v1/render_chapter", {}],
    ["POST", "/v1/render_chapter", { scene_id: "nope" }],
    ["POST", "/v1/render_chapter", { lines: [], master: "bogus" }],
    ["GET", `/v1/render/master-target?project_id=${project}`],
    ["GET", "/v1/render/master-target"],
    ["POST", "/v1/master", { wav_b64: "%%%", preset: "acx" }],
    ["POST", "/v1/master", { wav_b64: "UklGRg==", preset: "acx" }],
    ["POST", "/v1/master", { wav_b64: wav, preset: "bogus" }],
    ["POST", "/v1/master", { wav_b64: wav, preset: "podcast", title: "RD", author: "Me" }],
  ];
}

/** A multipart import body: form `fields` and, when given, the `file` part [name, text, type]. */
function importForm(fields, file = null) {
  const parts = Object.entries(fields).map(([name, data]) => ({ name, data }));
  if (file) parts.push({ name: "file", data: file[1], filename: file[0], contentType: file[2] });
  return { __multipart: parts };
}

/** A small JustWrite book.json (the shape JustWrite's export writes). */
function justwriteBook() {
  return {
    project: { title: "RD Book", author: "RD", premise: "" },
    parts: [{ id: "p1", title: "Part", chapters: [{ id: "c1", num: 1, title: "One" }] }],
    scenes: { c1: [{ id: "s1", title: "", body: "<p>The hall was dark.</p><p>“Wait,” said Mara.</p>" }] },
    characters: [{ id: "mara", name: "Mara", pronouns: "she/her", aliases: ["M"], oneLiner: "A pilot." }],
  };
}

/**
 * Agent 3's write steps: projects (create / patch / delete and their refusals), chapters
 * (create / rename / move / delete), lines (create, PATCH with the line's own numbers, split,
 * merge, the chapter text edited), speakers (add / rename / cast / narrator / uncast / remove,
 * the rewrite's refusals), the corrections memory, Discover's ignore list and promote, Script's
 * pages, Analyze over a chapter with no speech (no model call — narration only: cut, re-run in
 * place, streamed, the second look with nothing to ask, re-read after an edit), the Lab's
 * analyze-text, Discover's / smart-assign's / show notes' refusals, the imports (a CSV dry run,
 * its import, a re-import updating it in place, every refusal, a JustWrite dry run as a raw
 * body), the exports that render nothing (an empty book's M4B, its two export jobs, the ACX
 * check), the real book's lines, a split and a merge of its lines, and the bulk delete (dry runs
 * and one real delete). `{x}` names an id one side made up (see `captureId`). Never a model
 * load, a synthesis, a render or an LLM call.
 */
function agent3Steps(x) {
  const real = x.projects[0] || "no-project";
  const realScene = x.scenes[0] || "no-scene";
  const [rb0, rb1] = [x.blocks[0] || "no-block", x.blocks[1] || "no-block"];
  const realSpeaker = x.speakers[1] || "no-speaker";
  const persona = x.personas[0] || "no-persona";
  const raw = (o) => ({ __raw: o });
  const csv1 = 'id,scene,character,text,delivery,pause_after_ms\r\nL1,Gate,Mara,We leave at dawn.,"{""emotion"": ""calm""}",300\r\nL2,Gate,Iven,Not without the map.,,\r\nL3,Hall,Mara,"Then we find it, ""soon"".",,\r\n';
  const csv2 = "id,scene,character,text\r\nL1,Gate,Mara,We leave at dawn.\r\nL2,Gate,Iven,Not without the map — or the key.\r\nL4,Hall,Iven,A new line.\r\nL5,Cellar,Mara,A new scene.\r\n";
  const csvFile = (text) => ["lines.csv", text, "text/csv"];
  const narration = "The hall was quiet.\n\nNobody moved, and the lamps burned low.";
  return [
    // ── projects
    ["GET", "/v1/projects"],
    ["GET", "/v1/projects?project_type=audiobook"],
    ["GET", "/v1/projects?project_type=bogus"],
    ["POST", "/v1/projects", raw('{"name": "RD book", "project_type": "audiobook", "language": " en-GB ", "metadata": {"author": "Me", "ratio": 1.0}}'), "bookoid"],
    ["POST", "/v1/projects", { name: "", project_type: "audiobook" }],
    ["POST", "/v1/projects", { name: "x", project_type: "bogus" }],
    ["POST", "/v1/projects", { name: "RD empty", project_type: "podcast", mastering_preset: "acx" }, "emptyoid"],
    ["POST", "/v1/projects", { name: "RD analyze", project_type: "custom", language: "   " }, "anzoid"],
    ["PATCH", "/v1/projects/{bookoid}", { name: "RD book 2", language: null }],
    ["PATCH", "/v1/projects/{bookoid}", { language: " fr " }],
    ["PATCH", "/v1/projects/{bookoid}", { default_lexicon_id: "nope" }],
    ["PATCH", "/v1/projects/{bookoid}", { default_lexicon_id: null, mastering_preset: "podcast" }],
    ["PATCH", "/v1/projects/{bookoid}", raw('{"metadata": {"author": "You", "x": 2.0}, "description": "by Someone"}')],
    ["PATCH", "/v1/projects/{bookoid}", {}],
    ["PATCH", "/v1/projects/nope", { name: "x" }],
    ["GET", "/v1/projects/{bookoid}"],
    // ── chapters
    ["POST", "/v1/projects/{bookoid}/scenes", raw('{"title": "Chapter A", "metadata": {"k": 1.0}}'), "scaoid"],
    ["POST", "/v1/projects/{bookoid}/scenes", { title: "Chapter B", position: 1 }, "scboid"],
    ["POST", "/v1/projects/{bookoid}/scenes", { title: "Chapter C", position: 2 }, "sccoid"],
    ["POST", "/v1/projects/nope/scenes", { title: "x" }],
    ["PATCH", "/v1/scenes/{scaoid}", { title: "A renamed", position: 2 }],
    ["PATCH", "/v1/scenes/{scboid}", { position: 1 }],
    ["PATCH", "/v1/scenes/nope", { title: "x" }],
    ["GET", "/v1/projects/{bookoid}/scenes"],
    // ── lines
    ["POST", "/v1/scenes/{scaoid}/blocks", raw('{"text": "First line.", "metadata": {"source_ref": "R1", "w": 1.0}}'), "blkaoid"],
    ["POST", "/v1/scenes/{scaoid}/blocks", { text: "“Speech here,” she said softly.", position: 1, source: null, extraction_confidence: 0.5 }, "blkboid"],
    ["POST", "/v1/scenes/{scaoid}/blocks", { text: "Third.", position: 2 }, "blkcoid"],
    ["POST", "/v1/scenes/{scaoid}/blocks", { text: "" }],
    ["POST", "/v1/scenes/nope/blocks", { text: "x" }],
    ["GET", "/v1/scenes/{scaoid}/blocks"],
    ["PATCH", "/v1/blocks/{blkaoid}", raw('{"line_override": {"speed": 1.0, "pause_after_ms": 300, "models": {"kokoro": {"knobs": {"x": 2}, "emotion": " calm "}}}}')],
    ["PATCH", "/v1/blocks/{blkaoid}", { line_override: { speed: 9 } }],
    ["PATCH", "/v1/blocks/{blkaoid}", { line_override: { bogus: 1 } }],
    ["PATCH", "/v1/blocks/{blkaoid}", { text: "First line, edited.", direction: "softly" }],
    ["PATCH", "/v1/blocks/{blkaoid}", { source: "corrected", extraction_confidence: null }],
    ["PATCH", "/v1/blocks/{blkaoid}", raw('{"metadata": {"prev_speaker_id": null, "z": 1.5}}')],
    ["PATCH", "/v1/blocks/{blkaoid}", { source: "corrected" }],
    ["PATCH", "/v1/blocks/{blkaoid}", { position: "x" }],
    ["PATCH", "/v1/blocks/nope", { text: "x" }],
    ["POST", "/v1/blocks/{blkboid}/split", { at: 15 }, "splitblk1"],
    ["POST", "/v1/blocks/{blkboid}/split", { at: 0 }],
    ["POST", "/v1/blocks/{blkboid}/split", { at: -5, text: "One two three four" }, "splittwoblk1"],
    ["POST", "/v1/blocks/nope/split", { at: 1 }],
    ["POST", "/v1/blocks/{blkboid}/split", {}],
    ["POST", "/v1/scenes/{scaoid}/blocks/merge", { ids: ["{blkaoid}", "{splitblk1}"] }],
    ["POST", "/v1/scenes/{scaoid}/blocks/merge", { ids: ["{blkaoid}", "{blkaoid}"] }],
    ["POST", "/v1/scenes/{scaoid}/blocks/merge", { ids: ["{blkaoid}"] }],
    ["POST", "/v1/scenes/{scaoid}/blocks/merge", { ids: ["{blkaoid}", "nope"] }],
    ["POST", "/v1/scenes/{scaoid}/blocks/merge", { ids: ["{blkboid}", "{splittwoblk1}"] }],
    ["POST", "/v1/scenes/nope/blocks/merge", { ids: ["a", "b"] }],
    ["GET", "/v1/scenes/{scaoid}/text"],
    ["PUT", "/v1/scenes/{scaoid}/text", { text: "First line, edited.\n\nOne two three four\n\nA brand new paragraph.\n\n\n  Third.  ", dry_run: true }],
    ["PUT", "/v1/scenes/{scaoid}/text", { text: "First line, edited.\n\nOne two three four\n\nA brand new paragraph.\n\n\n  Third.  " }],
    ["PUT", "/v1/scenes/{scaoid}/text", { text: "  \n\n " }],
    ["PUT", "/v1/scenes/nope/text", { text: "x" }],
    ["GET", "/v1/scenes/{scaoid}/blocks", undefined, "scaall"],
    ["GET", "/v1/scenes/{scaoid}/text"],
    ["PUT", `/v1/scenes/${realScene}/text`, { text: "Short.", dry_run: true }],
    ["DELETE", "/v1/blocks/{blkcoid}"],
    ["DELETE", "/v1/blocks/nope"],
    ["DELETE", "/v1/scenes/{scboid}"],
    ["DELETE", "/v1/scenes/nope"],
    ["GET", "/v1/projects/{bookoid}/scenes"],
    // ── speakers
    ["POST", "/v1/projects/{bookoid}/speakers", { name: "  Mara   Vance ", aliases: ["Mara", "mara", " Vance ", "Mara Vance"], description: "  A pilot.  ", pronouns: "she/her" }, "spaoid"],
    ["POST", "/v1/projects/{bookoid}/speakers", { name: "mara vance" }],
    ["POST", "/v1/projects/{bookoid}/speakers", { name: "Iven", persona_id: "nope" }],
    ["POST", "/v1/projects/{bookoid}/speakers", { name: "Iven Sarraz", persona_id: persona }, "spboid"],
    ["POST", "/v1/projects/{bookoid}/speakers", { name: "Odeline Marran" }, "spcoid"],
    ["POST", "/v1/projects/{bookoid}/speakers", { name: "x", pronouns: "xe/xem" }],
    ["POST", "/v1/projects/nope/speakers", { name: "x" }],
    ["GET", "/v1/projects/{bookoid}/speakers"],
    ["PATCH", "/v1/speakers/{spaoid}", { name: "Mara  Vance-Holt" }],
    ["PATCH", "/v1/speakers/{spaoid}", { aliases: ["Holt", "holt", "Mara Vance-Holt"] }],
    ["PATCH", "/v1/speakers/{spaoid}", { description: null, pronouns: null, persona_id: persona }],
    ["PATCH", "/v1/speakers/{spaoid}", { persona_id: null }],
    ["PATCH", "/v1/speakers/{spaoid}", { persona_id: "nope" }],
    ["PATCH", "/v1/speakers/{spaoid}", { name: "iven sarraz" }],
    ["PATCH", "/v1/speakers/nope", { name: "x" }],
    ["PATCH", "/v1/blocks/{blkboid}", { speaker_id: "{spaoid}" }],
    ["PATCH", "/v1/blocks/{blkboid}", { speaker_id: "{spboid}" }, "fixafix"],
    ["PATCH", "/v1/blocks/{blkboid}", { speaker_id: "{spaoid}", no_fix: true }],
    ["GET", "/v1/projects/{bookoid}/corrections/count"],
    ["DELETE", "/v1/projects/{bookoid}/corrections/{fixafix}"],
    ["DELETE", "/v1/projects/{bookoid}/corrections/{fixafix}"],
    ["POST", "/v1/projects/{bookoid}/corrections", { text_snippet: "x".repeat(450), speaker_id: "{spaoid}" }],
    ["POST", "/v1/projects/{bookoid}/corrections", { text_snippet: "y", speaker_id: "nope" }],
    ["POST", "/v1/projects/{bookoid}/corrections", { text_snippet: "y" }],
    ["GET", "/v1/projects/{bookoid}/corrections/count"],
    ["DELETE", "/v1/projects/{bookoid}/corrections"],
    ["POST", "/v1/projects/{bookoid}/narrator", undefined, "booknarr"],
    ["POST", "/v1/projects/{bookoid}/narrator"],
    ["PUT", "/v1/projects/{bookoid}/narrator", { speaker_id: "{spcoid}" }],
    ["PUT", "/v1/projects/{bookoid}/narrator", { speaker_id: "{spcoid}" }],
    ["PUT", "/v1/projects/{bookoid}/narrator", { speaker_id: "nope" }],
    ["POST", "/v1/projects/nope/narrator"],
    ["POST", "/v1/projects/{bookoid}/speakers/uncast"],
    ["POST", "/v1/speakers/{spaoid}/rewrite", { text: "Hi" }],
    ["POST", "/v1/speakers/nope/rewrite", { text: "Hi" }],
    ["DELETE", "/v1/speakers/{spboid}"],
    ["DELETE", "/v1/speakers/nope"],
    // ── Discover's bookkeeping
    ["POST", "/v1/projects/{bookoid}/discover/ignore", { names: ["Old Sedge", " old  sedge ", "Nettle", "  "] }],
    ["POST", "/v1/projects/{bookoid}/discover/unignore", { names: ["nettle"] }],
    ["POST", "/v1/projects/nope/discover/ignore", { names: [] }],
    ["POST", "/v1/projects/{bookoid}/speakers/promote", { candidates: [{ name: "Nettle", description: "A cat.", aliases: ["Net", "nettle"] }] }, "promcrt0"],
    ["POST", "/v1/projects/{bookoid}/speakers/promote", { candidates: [{ name: "Sedge" }, { name: "nettle" }] }],
    ["POST", "/v1/projects/nope/speakers/promote", { candidates: [] }],
    ["GET", "/v1/projects/{bookoid}"],
    ["GET", "/v1/projects/{bookoid}/script"],
    ["GET", "/v1/scenes/{scaoid}/script"],
    // ── Analyze with no speech in the chapter: no model call
    ["POST", "/v1/projects/{anzoid}/scenes", { title: "Narrated" }, "anzsoid"],
    ["POST", "/v1/scenes/{anzsoid}/analyze", { text: "" }],
    ["POST", "/v1/scenes/{anzsoid}/analyze", { text: "x", route: "bogus" }],
    ["POST", "/v1/scenes/nope/analyze", { text: "x" }],
    ["POST", "/v1/scenes/{anzsoid}/analyze", { text: narration }],
    ["GET", "/v1/scenes/{anzsoid}/blocks", undefined, "anzall"],
    ["GET", "/v1/scenes/{anzsoid}/blocks", undefined, "anzlst0"],
    ["POST", "/v1/scenes/{anzsoid}/analyze", { text: narration, route: "direct", propagate: false }],
    ["POST", "/v1/scenes/{anzsoid}/analyze/stream", { text: narration }],
    ["POST", "/v1/scenes/nope/analyze/stream", { text: "x" }],
    ["POST", "/v1/scenes/{anzsoid}/second-look/stream"],
    ["POST", "/v1/scenes/nope/second-look/stream"],
    ["GET", "/v1/scenes/{anzsoid}/script"],
    ["GET", "/v1/projects/{anzoid}/script"],
    ["PATCH", "/v1/blocks/{anzlst0}", { text: "The hall was very quiet." }],
    ["POST", "/v1/scenes/{anzsoid}/analyze", { text: "ignored — the lines are read as they stand" }],
    ["POST", "/v1/projects/{anzoid}/narrator", undefined, "anznarr"],
    ["GET", "/v1/projects/{anzoid}/script"],
    ["GET", "/v1/scenes/{anzsoid}/script"],
    ["POST", "/v1/extraction/analyze-text", { text: "Narration only here.\n\nMore of it." }],
    ["POST", "/v1/extraction/analyze-text", { text: "x", route: "bogus" }],
    ["GET", "/v1/extraction/config"],
    ["POST", "/v1/scenes/nope/discover-speakers", { text: "x" }],
    ["POST", "/v1/scenes/{anzsoid}/discover-speakers", {}],
    ["POST", "/v1/extraction/discover-speakers", {}],
    ["POST", "/v1/llm/smart-assign", { characters: [], voices: [] }],
    ["POST", "/v1/llm/smart-assign", {}],
    ["POST", "/v1/llm/smart-assign", { characters: [{ id: "a", name: "A" }], voices: [] }],
    ["POST", "/v1/projects/{emptyoid}/show-notes"],
    ["POST", "/v1/projects/nope/show-notes"],
    // ── imports
    ["GET", "/v1/projects/import/adapters"],
    ["POST", "/v1/projects/import", importForm({ source: "csv_lines", dry_run: "true" }, csvFile(csv1))],
    ["POST", "/v1/projects/import", importForm({ source: "csv_lines" }, csvFile(csv1)), "imppid"],
    ["GET", "/v1/projects/{imppid}", undefined, "implex"],
    ["GET", "/v1/projects/{imppid}/speakers", undefined, "impspkall"],
    ["GET", "/v1/projects/{imppid}/scenes", undefined, "impscall"],
    ["GET", "/v1/projects/{imppid}/scenes", undefined, "impsclst0"],
    ["GET", "/v1/projects/{imppid}/scenes", undefined, "impsclst1"],
    ["GET", "/v1/scenes/{impsclst0}/blocks", undefined, "impaall"],
    ["GET", "/v1/scenes/{impsclst1}/blocks", undefined, "impball"],
    ["POST", "/v1/projects/import", importForm({ source: "csv_lines", project_id: "{imppid}" }, csvFile(csv2))],
    ["GET", "/v1/projects/{imppid}/scenes", undefined, "impsctwoall"],
    ["GET", "/v1/projects/{imppid}/scenes", undefined, "impsclst2"],
    ["GET", "/v1/scenes/{impsclst0}/blocks", undefined, "impatwoall"],
    ["GET", "/v1/scenes/{impsclst1}/blocks", undefined, "impbtwoall"],
    ["GET", "/v1/scenes/{impsclst2}/blocks", undefined, "impcall"],
    ["GET", "/v1/projects/{imppid}/lines"],
    ["POST", "/v1/projects/import", importForm({ source: "csv_lines", project_id: "{imppid}" }, csvFile("text\r\nNo ids here.\r\n"))],
    ["POST", "/v1/projects/import", importForm({ source: "csv_lines", project_id: "nope" }, csvFile(csv1))],
    ["POST", "/v1/projects/import", importForm({ source: "csv_lines", include_scenes: "a,b" }, csvFile(csv1))],
    ["POST", "/v1/projects/import", importForm({ source: "csv_lines", include_scenes: "9" }, csvFile(csv1))],
    ["POST", "/v1/projects/import", importForm({ source: "csv_lines", include_scenes: "9", dry_run: "1" }, csvFile(csv1))],
    ["POST", "/v1/projects/import", importForm({ source: "csv_lines", dry_run: "maybe" }, csvFile(csv1))],
    ["POST", "/v1/projects/import?dry_run=nah", importForm({ source: "csv_lines" }, csvFile(csv1))],
    ["POST", "/v1/projects/import", importForm({ dry_run: "true" }, csvFile(csv1))],
    ["POST", "/v1/projects/import", importForm({ source: "nope", dry_run: "true" }, csvFile(csv1))],
    ["POST", "/v1/projects/import", importForm({ source: "csv_lines" })],
    ["POST", "/v1/projects/import?source=justwrite&dry_run=true", justwriteBook()],
    ["POST", "/v1/projects/import?source=justwrite&dry_run=1", raw("not json")],
    ["POST", "/v1/projects/import?source=csv_lines&dry_run=true", raw("id,text\r\nA,Hello\r\n")],
    ["POST", "/v1/projects/import?source=csv_lines"],
    ["POST", "/v1/projects/demo", { kind: "nope" }],
    ["POST", "/v1/projects/demo", {}],
    // ── exports that render nothing: an empty book's
    ["GET", "/v1/projects/{emptyoid}/export?include_audio=maybe"],
    ["GET", "/v1/projects/nope/export"],
    ["POST", "/v1/projects/{emptyoid}/export_m4b"],
    ["POST", "/v1/projects/nope/export_m4b"],
    ["POST", "/v1/projects/{emptyoid}/export_m4b/start", undefined, "ejoboid"],
    ["GET", "/v1/projects/{emptyoid}/qc"],
    ["GET", "/v1/projects/nope/qc"],
    ["GET", "/v1/export_jobs/{ejoboid}"],
    ["POST", "/v1/export_jobs/{ejoboid}/cancel"],
    ["GET", "/v1/export_jobs/{ejoboid}/file"],
    ["POST", "/v1/projects/{emptyoid}/export_chapters/start", undefined, "ejobtwooid"],
    ["GET", "/v1/projects/{emptyoid}/lines"],
    ["GET", "/v1/export_jobs/{ejobtwooid}"],
    ["GET", "/v1/export_jobs/nope"],
    ["POST", "/v1/export_jobs/nope/cancel"],
    ["GET", "/v1/export_jobs/nope/file"],
    ["POST", "/v1/projects/nope/export_m4b/start"],
    ["POST", "/v1/projects/nope/export_chapters/start"],
    ["GET", "/v1/projects/nope/lines"],
    // ── the real book: its lines, a speaker change, a split and a merge (no render)
    ["GET", `/v1/projects/${real}/lines`],
    ["PATCH", `/v1/blocks/${rb0}`, { speaker_id: realSpeaker }, "realfix"],
    ["POST", `/v1/blocks/${rb0}/split`, { at: 12 }, "realsplitblk1"],
    ["POST", `/v1/scenes/${realScene}/blocks/merge`, { ids: ["{realsplitblk1}", rb1] }],
    ["GET", `/v1/scenes/${realScene}/script`],
    ["GET", `/v1/projects/${real}/script`],
    // ── the bulk delete
    ["DELETE", "/v1/generations"],
    ["DELETE", "/v1/generations?status=bogus"],
    ["DELETE", "/v1/generations?older_than=abc"],
    ["DELETE", "/v1/generations?older_than=2026-13-01"],
    ["DELETE", "/v1/generations?older_than=2026-10-07T08:00:00"],
    ["DELETE", "/v1/generations?older_than=2026-10-07T08:00:00%2B02:00&engine=kokoro"],
    ["DELETE", "/v1/generations?voice_id=bm_george"],
    ["DELETE", `/v1/generations?chapter_id=${realScene}&project_id=${real}`],
    ["DELETE", "/v1/generations?scope=anything&status=ok"],
    ["DELETE", "/v1/generations?voice_id=af_kore&confirm=true"],
    ["DELETE", "/v1/generations?voice_id=af_kore&confirm=true"],
    ["GET", `/v1/projects/${real}/lines`],
    // ── a book goes
    ["DELETE", "/v1/projects/{emptyoid}"],
    ["DELETE", "/v1/projects/{emptyoid}"],
    ["GET", "/v1/projects"],
  ];
}

/**
 * JustVoice's write sequence over the API wave's first routers: settings, prefs, the auth
 * door, channels, MCP bindings, webhooks, external engines, download sources, placement,
 * runtime options, terms, the speech-runtime row, the cache, analyze/compare, the refine
 * preview, the engine unload/cancel doors, jobs, captures and align refusals — never a load,
 * an install, a download, a synthesis, a transcription, an alignment or the network. `{x}`
 * names an id one side made up (captured from its own answer). Ends with POST /v1/shutdown.
 */
export function steps(extra) {
  const { personas } = extra;
  const wav = toneWavB64();
  const persona = personas[0] || "no-persona";
  const VARIANT = "chatterbox-multilingual-v2-q8";
  return [
    ["GET", "/v1/settings"],
    ["PATCH", "/v1/settings", { captures: { smart_cleanup: false, language: "en" } }],
    // Raw text: a whole-number float literal (`12.0`) must reach the server as written.
    ["PATCH", "/v1/settings", { __raw: '{"extraction": {"direct_min_b": 12.0}, "generation": {}}' }],
    ["PATCH", "/v1/settings", { server: { port: "abc" } }],
    ["PATCH", "/v1/settings", { engines: { llm: [{ id: "c", name: "C", provider_type: "openai-compat" }] } }],
    ["PUT", "/v1/settings", "{settings}"],
    ["PUT", "/v1/settings", { server: { port: "x" } }],
    ["GET", "/v1/settings"],
    // (No integer-like keys: a JavaScript object iterates them first — the known limit wave D
    // recorded.)
    ["PATCH", "/v1/prefs", { __raw: '{"appearance": {"theme": "dark", "scale": 1.0, "hue": 200}, "hiddenVoices": ["a", "b"], "zoom": 2.5, "ratio": 3.0, "big": 1e3}' }],
    ["PATCH", "/v1/prefs", { hiddenVoices: ["a"] }],
    ["PATCH", "/v1/prefs", [1, 2]],
    ["GET", "/v1/prefs"],
    ["PUT", "/v1/server-auth", { __raw: '{"tokens": ["rd-token", " "], "requireForLoopback": 0.0}' }],
    ["GET", "/v1/server-auth"],
    ["PUT", "/v1/server-auth", { tokens: "nope" }],
    ["PUT", "/v1/server-auth", { tokens: [], requireForLoopback: false }],
    ["POST", "/v1/channels", { name: "RD A", is_default: true, device_ids: ["d1", "d2"] }, "channel"],
    ["POST", "/v1/channels", { name: "RD B", is_default: true }, "channel2"],
    ["POST", "/v1/channels", { name: "" }],
    ["PATCH", "/v1/channels/{channel}", { name: "RD A2", is_default: true, device_ids: [] }],
    ["PATCH", "/v1/channels/nope", { name: "x" }],
    ["GET", "/v1/channels"],
    ["PUT", `/v1/personas/${persona}/channels`, { channel_ids: ["{channel}", "{channel2}"] }],
    // Lists the two channels in the (persona_id, channel_id) index's order — each side's own
    // random UUIDs — so this answer's ORDER may differ between the sides run to run; the rows
    // themselves compare in insertion order in the database check.
    ["GET", `/v1/personas/${persona}/channels`],
    ["DELETE", "/v1/channels/{channel2}"],
    ["GET", `/v1/personas/${persona}/channels`],
    ["DELETE", "/v1/channels/nope"],
    ["POST", "/v1/mcp/bindings", { client_id: "rd-client", label: "RD", persona_id: persona, default_engine: "kokoro" }],
    ["POST", "/v1/mcp/bindings", { client_id: "rd-client", label: null }],
    ["POST", "/v1/mcp/bindings", { client_id: "" }],
    ["GET", "/v1/mcp/bindings"],
    ["DELETE", "/v1/mcp/bindings/nope"],
    ["POST", "/v1/webhooks", { url: "HTTP://Example.COM:80/hook?x=1", events: ["render.completed", "voice.created"], secret: "rd-secret-123" }, "webhook"],
    ["POST", "/v1/webhooks", { url: "not a url", events: ["render.completed"] }],
    ["POST", "/v1/webhooks", { url: "ftp://example.com/x", events: ["render.completed"] }],
    ["POST", "/v1/webhooks", { url: "https://example.com", events: ["bogus.event"], secret: "short" }],
    ["POST", "/v1/webhooks", { url: "https://Bücher.example/händler", events: ["webhook.test"], secret: "rd-secret-456", enabled: false }, "webhook2"],
    ["GET", "/v1/webhooks"],
    ["DELETE", "/v1/webhooks/{webhook2}"],
    ["DELETE", "/v1/webhooks/{webhook}"],
    ["DELETE", "/v1/webhooks/nope"],
    ["POST", "/v1/engines/external", { id: "rd-ext", name: "RD external", base_url: "http://127.0.0.1:9", model: "tts-1", voices: ["alloy"] }],
    ["POST", "/v1/engines/external", { id: "rd-ext", name: "again", base_url: "http://127.0.0.1:9" }],
    ["POST", "/v1/engines/external", { id: " ", name: "blank", base_url: "http://127.0.0.1:9" }],
    ["GET", "/v1/engines"],
    ["GET", "/v1/engines/current"],
    ["DELETE", "/v1/engines/external/rd-ext"],
    ["DELETE", "/v1/engines/external/rd-ext"],
    ["PUT", `/v1/engines/chatterbox/sources/${VARIANT}`, { hf_repo: "rd/mirror", hf_revision: "abc" }],
    ["PUT", `/v1/engines/chatterbox/sources/${VARIANT}`, {}],
    ["PUT", "/v1/engines/chatterbox/sources/not-a-variant", { hf_repo: "rd/mirror" }],
    ["GET", "/v1/engines/chatterbox/sources"],
    ["PUT", "/v1/engines/kokoro/models/kokoro-82m-q8/placement", { placement: "cpu" }],
    ["PUT", "/v1/engines/kokoro/models/kokoro-82m-q8/placement", { placement: "npu" }],
    ["PUT", "/v1/engines/qwen3/models/qwen3-cv-1.7b-q8/runtime-options", { options: { "qwen3_tts.perf_mode": "flash_attention" } }],
    ["PUT", "/v1/engines/qwen3/models/qwen3-cv-1.7b-q8/runtime-options", { options: { "qwen3_tts.perf_mode": "turbo" } }],
    ["DELETE", `/v1/engines/chatterbox/sources/${VARIANT}`],
    ["GET", "/v1/settings"],
    ["POST", "/v1/engines/pocket/terms"],
    ["POST", "/v1/engines/pocket/terms"],
    ["POST", "/v1/engines/kokoro/terms"],
    ["POST", "/v1/engines/nope/terms"],
    ["PUT", "/v1/speech-runtime", { cpu_threads: 6, cpu_min_realtime: 3.0 }],
    ["PUT", "/v1/speech-runtime", { backend: "metal" }],
    ["PUT", "/v1/speech-runtime", { backend: "auto", gpu_threads: 0 }],
    ["PUT", "/v1/speech-runtime", { backend: "auto", cpu_threads: 0 }],
    ["POST", "/v1/cache/clear?voice_id=v1&engine=e"],
    ["POST", "/v1/cache/clear?scope=rd-none&older_than_days=30"],
    ["POST", "/v1/cache/clear?older_than_days=abc"],
    ["POST", "/v1/analyze", { wav_b64: wav }],
    ["POST", "/v1/analyze", { wav_b64: "QQ=" }],
    ["POST", "/v1/analyze", { wav_b64: "UklGRg==" }],
    ["POST", "/v1/compare", { a_wav_b64: wav, b_wav_b64: wav, a_label: "A", b_label: null }],
    ["POST", "/v1/ai/prompt-preview", { feature: "refine" }],
    ["POST", "/v1/ai/prompt-preview", { feature: "compose" }],
    ["POST", "/v1/engines/unload", {}],
    ["POST", "/v1/engines/unload", { kind: 5 }],
    ["POST", "/v1/engines/kokoro/cancel-load"],
    ["POST", "/v1/engines/rd-nope/cancel-load"],
    ["POST", "/v1/engines/rd-nope/install", {}],
    ["DELETE", "/v1/engines/rd-nope"],
    ["GET", "/v1/jobs/nope"],
    ["DELETE", "/v1/jobs/nope"],
    ["PATCH", "/v1/captures/nope", { pinned: true }],
    ["POST", "/v1/captures/nope/refine", {}],
    ["DELETE", "/v1/captures/nope"],
    ["POST", "/v1/captures", { __multipart: [{ name: "source", data: "bogus" }, { name: "file", data: "RIFF", filename: "a.wav", contentType: "audio/wav" }] }],
    ["POST", "/v1/transcribe", { __multipart: [{ name: "language", data: "en" }] }],
    ["POST", "/v1/align", { __multipart: [{ name: "text", data: "   " }, { name: "file", data: "RIFF", filename: "a.wav", contentType: "audio/wav" }] }],
    ["POST", "/v1/align", { __multipart: [{ name: "language", data: "en" }] }],
    ["GET", "/v1/active_tasks"],
    ["GET", "/v1/cache/recent?limit=3"],
    ...agent2Steps(extra),
    ...agent3Steps(extra),
    ["POST", "/v1/shutdown"],
  ];
}

/** The id one side made up, from its answer (`capture` names). */
export function captureId(name, json) {
  if (name === "channel" || name === "channel2") return json?.id;
  if (name === "webhook" || name === "webhook2") return json?.subscription?.id;
  // Agent 2's: a new voice, persona, lexicon, effect preset or render job is the row answered.
  if (/^(voice\d?|persona\d?|lexicon\d?|effpreset|job)$/.test(name)) return json?.id;
  // Agent 3's, by the name's ending: `…all` every id of a list answered (a list, its speakers
  // or its blocks — mapped item for item), `…oid` the row answered, `…lst<N>` the N-th of a list
  // answered, `…spk<N>` / `…blk<N>` / `…crt<N>` the N-th speaker / block / created id, `…pid`
  // the import's project, `…lex` the project's lexicon, `…fix` the saved fix, `…narr` the
  // narrator in a speaker list.
  let m;
  if (/all$/.test(name)) {
    const list = Array.isArray(json) ? json : (json?.speakers ?? json?.blocks);
    return Array.isArray(list) ? list.map((x) => x?.id) : undefined;
  }
  if (/oid$/.test(name)) return json?.id;
  if ((m = /lst(\d+)$/.exec(name))) return Array.isArray(json) ? json[Number(m[1])]?.id : undefined;
  if ((m = /spk(\d+)$/.exec(name))) return json?.speakers?.[Number(m[1])]?.id;
  if ((m = /blk(\d+)$/.exec(name))) return json?.blocks?.[Number(m[1])]?.id;
  if ((m = /crt(\d+)$/.exec(name))) return json?.created?.[Number(m[1])];
  if (/pid$/.test(name)) return json?.project_id;
  if (/lex$/.test(name)) return json?.default_lexicon_id;
  if (/fix$/.test(name)) return json?.fix_id;
  if (/narr$/.test(name)) return json?.speakers?.find((s) => s.role_label === "narrator")?.id;
  return undefined;
}

/** Answer keys a server stamps from its own clock — compared for presence only. */
export const STAMP_KEYS = new Set([
  "created_at",
  "updated_at",
  "last_seen_at",
  "last_delivery_at",
  "at",
  "terms_accepted_at",
  // Agent 3's: when Analyze ran / Discover scanned.
  "analyzed_at",
  "scanned_at",
]);

/** Database columns a server stamps from its own clock — compared for presence only. */
export const STAMPED = {
  channels: ["created_at"],
  mcp_bindings: ["created_at", "last_seen_at"],
  webhooks: ["created_at", "last_delivery_at"],
  // Agent 2's: the rows' clocks, and a lexicon entry's own random id (never answered).
  personas: ["created_at", "updated_at"],
  lexicons: ["created_at", "updated_at"],
  lexicon_entries: ["id", "created_at"],
  effect_presets: ["created_at"],
  render_jobs: ["created_at", "started_at", "finished_at"],
  speakers: ["created_at", "updated_at"],
  projects: ["created_at", "updated_at"],
  // Agent 3's: new rows' clocks, and a saved fix's own random id (never answered).
  scenes: ["created_at"],
  blocks: ["created_at"],
  speaker_corrections: ["id", "created_at"],
};

/** A database cell as compared: the settings row's accepted-terms time is the server's clock. */
export function maskCell(table, column, value) {
  if (table === "settings" && column === "data" && typeof value === "string") {
    return value.replace(/(\\?"terms_accepted_at\\?": \\?")[0-9T:+\-]+/g, "$1<stamp>");
  }
  // Agent 3's: a chapter's metadata records when Analyze ran and when Discover scanned.
  if (table === "scenes" && column === "metadata_json" && typeof value === "string") {
    return value.replace(/("(?:analyzed_at|scanned_at)": ")[0-9T:.+\-]+/g, "$1<stamp>");
  }
  return value;
}
