// Q3 states: drive the build from before Q3 and the current build the same way (hover, keyboard
// focus, dark mode, an accent change, a click…) and compare a clip of each state, so a control's
// states are checked, not only its rest look. The two servers must be running (parity.js's ports
// and data folders: base on <app>.ports[0], new on [1]).
//   node states.js <outDir> <scenario.js>
// A scenario module exports default [{ app, port: [base, new], route, name, prep?, hover?, focus?,
//   press?, clip }]: prep = JS run in the page first; hover/focus = a selector (focus is a keyboard
//   focus: element.focus() with no pointer use); press = a key; clip = a selector — the shot is
//   that element's box grown by 6px.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { chromium } = await import(pathToFileURL("E:/Dev/Web/justwrite-app/node_modules/playwright/index.mjs").href);
const { PNG } = await import(pathToFileURL("E:/Dev/Web/JustVioce/node_modules/pngjs/lib/png.js").href);
const [out, scenarioPath] = process.argv.slice(2);
const { default: scenario } = await import(pathToFileURL(scenarioPath).href);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
async function shoot(port, s) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => { window.__JW_BENCH__ = true; });
  await page.goto(`http://127.0.0.1:${port}/#${s.route}`);
  await page.waitForTimeout(4500);
  await page.evaluate(() => document.querySelector(".lu-bootload__skip")?.click());
  if (s.prep) await page.evaluate(s.prep).catch((e) => errors.push(`prep: ${e.message.split("\n")[0]}`));
  await page.waitForTimeout(300);
  if (s.click) { await page.click(s.click, { timeout: 5000 }).catch(() => errors.push(`click: ${s.click} not found`)); await page.waitForTimeout(350); }
  if (s.type) { await page.keyboard.type(s.type, { delay: 40 }); await page.waitForTimeout(250); }
  if (s.hover) await page.hover(s.hover, { timeout: 5000 }).catch(() => errors.push(`hover: ${s.hover} not found`));
  if (s.focus) await page.evaluate((sel) => document.querySelector(sel)?.focus(), s.focus);
  if (s.press) await page.keyboard.press(s.press);
  await page.waitForTimeout(400);
  const box = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    let r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    if (r.top < 0 || r.bottom > innerHeight) { el.scrollIntoView({ block: "nearest" }); r = el.getBoundingClientRect(); }
    return { x: Math.max(0, r.x - 6), y: Math.max(0, r.y - 6), width: r.width + 12, height: r.height + 12 };
  }, s.clip);
  const shot = box ? await page.screenshot({ clip: box }) : null;
  await page.close();
  return { shot, errors };
}

const lines = [];
for (const s of scenario) {
  const a = await shoot(s.port[0], s);
  const b = await shoot(s.port[1], s);
  const tag = `${s.app}-${s.name}`;
  if (!a.shot || !b.shot) {
    lines.push(`${tag.padEnd(32)} clip not found (${a.shot ? "new" : "base"}) ${[...a.errors, ...b.errors].join(" | ")}`);
    continue;
  }
  writeFileSync(join(out, `${tag}.base.png`), a.shot);
  writeFileSync(join(out, `${tag}.new.png`), b.shot);
  const pa = PNG.sync.read(a.shot);
  const pb = PNG.sync.read(b.shot);
  let n = 0;
  if (pa.width !== pb.width || pa.height !== pb.height) n = -1;
  else for (let i = 0; i < pa.data.length; i += 4) if (pa.data[i] !== pb.data[i] || pa.data[i + 1] !== pb.data[i + 1] || pa.data[i + 2] !== pb.data[i + 2]) n++;
  const size = `${pa.width}x${pa.height}${n === -1 ? ` vs ${pb.width}x${pb.height}` : ""}`;
  const errs = [...a.errors.map((e) => `base: ${e}`), ...b.errors.map((e) => `new: ${e}`)];
  lines.push(`${tag.padEnd(32)} ${n === -1 ? "SIZE DIFFERS" : `${n} px differ`} (${size})${errs.length ? `  ERRORS ${errs.join(" | ")}` : ""}`);
}
await browser.close();
writeFileSync(join(out, "states.txt"), `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
