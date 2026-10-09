// SPDX-License-Identifier: MIT
// Q3 side by side: for each app, the build taken before Q3 (scratchpad q3-base/<app>) and the
// app checkout's current dist/spa, each served by the app's own server on its own copy of a fresh
// snapshot of the app's real database (warm-on-boot off in the copies), screenshotted on the same
// routes at 1440x900; prints the share of differing pixels and saves both shots plus a diff map.
//   node parity.js <outDir> [jw|jv|dg ...]      (no app names = all three)
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const WEB = "E:/Dev/Web";
const SP = "C:/Users/danel/AppData/Local/Temp/claude/E--Dev-Web-JustVioce/010ca198-6cb0-4bfe-86b8-0e9ec1770500/scratchpad";
const JW = `${WEB}/justwrite-app`;
const { chromium } = await import(pathToFileURL(`${JW}/node_modules/playwright/index.mjs`).href);
const { chromeLaunchOptions, waitReady, sleep } = await import(pathToFileURL(`${JW}/tests/lib/smoke-common.js`).href);
const { PNG } = await import(pathToFileURL(`${WEB}/JustVioce/node_modules/pngjs/lib/png.js`).href);

const APPS = {
  jw: {
    repo: JW, db: "justwrite.db", extra: ["projects"], uiEnv: "JUSTWRITE_UI_DIR", dataEnv: "JUSTWRITE_DATA_DIR",
    base: `${SP}/q3-base/justwrite-app`, ports: [8781, 8782], ready: ".app, .ob-stage",
    routes: ["/", "/chapters", "/characters", "/locations", "/plot", "/settings", "/ai", "/help", "/welcome", "/export"],
    init: () => { window.__JW_BENCH__ = true; },
  },
  jv: {
    repo: `${WEB}/JustVioce`, db: "justvoice.db", extra: [], uiEnv: "JUSTVOICE_UI_DIR", dataEnv: "JUSTVOICE_DATA_DIR",
    base: `${SP}/q3-base/JustVioce`, ports: [8783, 8784], ready: ".app-shell",
    routes: ["/home", "/projects", "/studio", "/captures", "/voices", "/personas", "/lexicons", "/effects", "/ai", "/settings"],
  },
  dg: {
    repo: `${WEB}/just_ai_i18n_docgen`, db: "app.db", extra: [], uiEnv: "JUST_AI_I18N_DOCGEN_UI_DIR", dataEnv: "JUST_AI_I18N_DOCGEN_DATA_DIR",
    base: `${SP}/q3-base/just_ai_i18n_docgen`, ports: [8785, 8786], ready: ".shell",
    args: ["--config", "E:\\Dev\\Web\\justwrite-app\\just-ai-i18n-docgen\\config.json"],
    routes: ["/", "/setup", "/review", "/runs", "/docs", "/ai", "/settings", "/settings/backups", "/settings/storage", "/settings/server"],
  },
};

const [out, ...names] = process.argv.slice(2);
const picked = names.length ? names : Object.keys(APPS);
mkdirSync(out, { recursive: true });
const servers = [];
const summary = [];

function snapshot(app, dest) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const r = spawnSync(process.execPath, [`${JW}/scripts/node24.js`, `${JW}/scripts/snapshot-db.js`, `${app.repo}/data/${app.db}`, join(dest, app.db)], { cwd: JW, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  for (const x of app.extra) if (existsSync(`${app.repo}/data/${x}`)) cpSync(`${app.repo}/data/${x}`, join(dest, x), { recursive: true });
}

function serve(app, port, data, ui) {
  const child = spawn(process.execPath, [`${app.repo}/scripts/node24.js`, `${app.repo}/server/src/serve.js`, "serve", "--host", "127.0.0.1", "--port", String(port), "--data-dir", data, ...(app.args || [])], {
    cwd: app.repo, stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, [app.dataEnv]: data, JUST_AI_HOME: data, [app.uiEnv]: ui },
  });
  servers.push(child);
}

function diff(a, b, file) {
  const pa = PNG.sync.read(a);
  const pb = PNG.sync.read(b);
  if (pa.width !== pb.width || pa.height !== pb.height) return 100;
  let n = 0;
  const marked = new PNG({ width: pa.width, height: pa.height });
  for (let i = 0; i < pa.data.length; i += 4) {
    const same = pa.data[i] === pb.data[i] && pa.data[i + 1] === pb.data[i + 1] && pa.data[i + 2] === pb.data[i + 2];
    if (!same) n++;
    marked.data[i] = same ? pa.data[i] >> 2 : 255;
    marked.data[i + 1] = same ? pa.data[i + 1] >> 2 : 0;
    marked.data[i + 2] = same ? pa.data[i + 2] >> 2 : 0;
    marked.data[i + 3] = 255;
  }
  if (n) writeFileSync(file, PNG.sync.write(marked));
  return (100 * n) / (pa.width * pa.height);
}

try {
  const browser = await chromium.launch(chromeLaunchOptions());
  for (const key of picked) {
    const app = APPS[key];
    const dataOld = join(out, `${key}-data-base`);
    const dataNew = join(out, `${key}-data-new`);
    snapshot(app, dataOld);
    rmSync(dataNew, { recursive: true, force: true });
    cpSync(dataOld, dataNew, { recursive: true });
    serve(app, app.ports[0], dataOld, app.base);
    serve(app, app.ports[1], dataNew, `${app.repo}/dist/spa`);
    await waitReady(`http://127.0.0.1:${app.ports[0]}/v1/health`, `${key} base`);
    await waitReady(`http://127.0.0.1:${app.ports[1]}/v1/health`, `${key} new`);
    for (const route of app.routes) {
      const shots = {};
      const errors = [];
      for (const [label, port] of [["base", app.ports[0]], ["new", app.ports[1]]]) {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        if (app.init) await page.addInitScript(app.init);
        page.on("pageerror", (e) => errors.push(`${label}: ${e.message}`));
        await page.goto(`http://127.0.0.1:${port}/#${route}`);
        await page.waitForSelector(app.ready, { timeout: 20000 }).catch(() => {});
        await sleep(2500);
        await page.evaluate(() => document.querySelector(".lu-bootload__skip")?.click());
        await sleep(400);
        shots[label] = await page.screenshot();
        await page.close();
      }
      const tag = `${key}${route.replace(/[/#]+/g, "_")}`;
      writeFileSync(join(out, `${tag}.base.png`), shots.base);
      writeFileSync(join(out, `${tag}.new.png`), shots.new);
      const pct = diff(shots.base, shots.new, join(out, `${tag}.diff.png`));
      const line = `${key} ${route.padEnd(18)} ${pct.toFixed(3)}%${errors.length ? `  ERRORS: ${errors.join(" | ")}` : ""}`;
      summary.push(line);
      console.log(line);
    }
    for (const s of servers.splice(0)) s.kill();
  }
  await browser.close();
} finally {
  for (const s of servers) s.kill();
  writeFileSync(join(out, "summary.txt"), `${summary.join("\n")}\n`);
}
