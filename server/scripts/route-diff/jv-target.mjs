// SPDX-License-Identifier: MIT
// The route diff's JustVoice target (route-diff.mjs --app --target justvoice): what JustVoice's
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

export const REPO = "E:/Dev/Web/JustVioce";
export const DEV_DATA = `${REPO}/src-tauri/target/debug/data`;
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

/** The API wave's routers ported by agents 2 and 3 (their GETs answer 404 until then). */
export const LATER = new Set([
  "generate_api",
  "voice_preview_api",
  "render_chapter_api",
  "render_jobs_api",
  "render_lines_api",
  "takes_api",
  "voices_api",
  "personas_api",
  "voice_bundle_api",
  "master_api",
  "effect_presets_api",
  "lexicons_api",
  "pronunciation_api",
  "projects_api",
  "extraction_api",
  "speakers_api",
  "smart_assign_api",
  "project_export_api",
  "export_jobs_api",
  "bulk_delete_api",
]);

/** GETs never sent: a voice preview SYNTHESIZES (it may load a model), whatever its id. */
export const SKIP = [/^\/v1\/voices\/\{voice_id\}\/preview\/stream$/];

/** Answers that move by themselves (live hardware, processes, sizes) — compared for status. */
export const VOLATILE = [
  /^\/v1\/system\/info/, // live RAM / GPU / ffmpeg probes
  /^\/v1\/engines\/vram/, // the measured pool (nvidia-smi)
  /^\/v1\/engines\/leftovers/, // the live process table
];

/** Path/query values for JustVoice's own GETs, from the Python side's own answers. */
export async function fill(get, PY) {
  const engines = (await get(PY, "/v1/engines")).json?.engines || [];
  const managed = engines.filter((e) => e.backend === "managed").map((e) => e.id);
  const personas = []; // personas_api is a later port; read their ids from the database copy instead
  return { managed, personas };
}

/** The fill for one route's parameter (null = the generic "x"). */
export function valuesFor(row, name, extra) {
  if (LATER.has(row.module)) return null; // a later port's route: never a real id (see SKIP)
  if (name === "engine_id" || name === "id") return extra.managed;
  if (name === "persona_id") return extra.personas.slice(0, 2);
  if (name === "generation_id") return extra.generations.slice(0, 1);
  return null;
}

/** The ids the reads need from the database copy (personas, a completed generation). */
export function dbIds(dbFile, serverDir) {
  const require = createRequire(path.join(serverDir, "package.json"));
  const Database = require("better-sqlite3");
  const db = new Database(dbFile, { readonly: true });
  const personas = db.prepare("select id from personas order by rowid").all().map((r) => r.id);
  const generations = db.prepare("select id from generations where status = 'completed' order by rowid limit 1").all().map((r) => r.id);
  db.close();
  return { personas, generations };
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

/**
 * JustVoice's write sequence over the API wave's first routers: settings, prefs, the auth
 * door, channels, MCP bindings, webhooks, external engines, download sources, placement,
 * runtime options, terms, the speech-runtime row, the cache, analyze/compare, the refine
 * preview, the engine unload/cancel doors, jobs, captures and align refusals — never a load,
 * an install, a download, a synthesis, a transcription, an alignment or the network. `{x}`
 * names an id one side made up (captured from its own answer). Ends with POST /v1/shutdown.
 */
export function steps({ personas }) {
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
    ["POST", "/v1/shutdown"],
  ];
}

/** The id one side made up, from its answer (`capture` names). */
export function captureId(name, json) {
  if (name === "channel" || name === "channel2") return json?.id;
  if (name === "webhook" || name === "webhook2") return json?.subscription?.id;
  return undefined;
}

/** Answer keys a server stamps from its own clock — compared for presence only. */
export const STAMP_KEYS = new Set(["created_at", "last_seen_at", "last_delivery_at", "at", "terms_accepted_at"]);

/** Database columns a server stamps from its own clock — compared for presence only. */
export const STAMPED = {
  channels: ["created_at"],
  mcp_bindings: ["created_at", "last_seen_at"],
  webhooks: ["created_at", "last_delivery_at"],
};

/** A database cell as compared: the settings row's accepted-terms time is the server's clock. */
export function maskCell(table, column, value) {
  if (table === "settings" && column === "data" && typeof value === "string") {
    return value.replace(/(\\?"terms_accepted_at\\?": \\?")[0-9T:+\-]+/g, "$1<stamp>");
  }
  return value;
}
