// Slice 4's behaviour, on both builds: the text fields answer the same way.
import { chromium } from "file:///E:/Dev/Web/justwrite-app/node_modules/playwright/index.mjs";

const browser = await chromium.launch();
async function open(port, route) {
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  p.errors = [];
  p.on("pageerror", (e) => p.errors.push(e.message));
  await p.addInitScript(() => { window.__JW_BENCH__ = true; });
  await p.goto(`http://127.0.0.1:${port}/#${route}`);
  await p.waitForTimeout(4500);
  return p;
}
const lines = [];
async function check(name, ports, route, run) {
  const out = [];
  for (const port of ports) {
    const p = await open(port, route);
    try { out.push(JSON.stringify(await run(p, port))); } catch (e) { out.push(`THREW ${e.message.split("\n")[0]}`); }
    if (p.errors.length) out[out.length - 1] += ` ERRORS ${p.errors.join(" | ")}`;
    await p.close();
  }
  lines.push(`${name.padEnd(36)} ${out[0] === out[1] ? "SAME" : "DIFFERENT"}\n    base: ${out[0]}\n    new:  ${out[1]}`);
}
const JW = [8781, 8782];
const JV = [8783, 8784];
const DG = [8785, 8786];
const native = (sel) => `${sel} input, input${sel}`;

await check("search: typing filters (:value + @input)", JW, "/chapters", async (p) => {
  await p.locator(native(".entity-search-input")).first().pressSequentially("Brass", { delay: 30 });
  await p.waitForTimeout(400);
  return p.evaluate(() => ({ value: (document.querySelector(".entity-search-input input") || document.querySelector("input.entity-search-input")).value, rows: document.querySelectorAll("tbody tr").length }));
});
await check("search: clear filters resets", JW, "/chapters", async (p) => {
  await p.locator(native(".entity-search-input")).first().pressSequentially("Brass", { delay: 30 });
  await p.waitForTimeout(300);
  await p.getByRole("button", { name: /clear filters/i }).click();
  await p.waitForTimeout(300);
  return p.evaluate(() => ({ value: (document.querySelector(".entity-search-input input") || document.querySelector("input.entity-search-input")).value, rows: document.querySelectorAll("tbody tr").length }));
});
await check("v-model: typing into the title", JW, "/settings", async (p) => {
  const f = p.locator("main input").first();
  await f.click(); await f.press("End"); await f.pressSequentially(" X", { delay: 20 });
  await p.waitForTimeout(300);
  const v = await f.inputValue();
  await f.press("Control+z"); // JustWrite's own undo, as a user would — on the scratch copy anyway
  return { v };
});
await check("number: ArrowUp steps, blur formats", JW, "/settings", async (p) => {
  const f = p.locator(".ui-number input, input.ui-number").first();
  const before = await f.inputValue();
  await f.click(); await f.press("ArrowUp"); await f.press("ArrowUp"); await p.waitForTimeout(200);
  const typed = await f.inputValue();
  await f.press("Tab"); await p.waitForTimeout(300);
  return { before, typed, after: await f.inputValue() };
});
await check("number: typing a grouped number", JW, "/settings", async (p) => {
  const f = p.locator(".ui-number input, input.ui-number").first();
  await f.click(); await f.selectText(); await f.pressSequentially("98765", { delay: 20 }); await f.press("Tab"); await p.waitForTimeout(300);
  return { after: await f.inputValue() };
});
await check("textarea: auto-resize grows", JW, "/settings", async (p) => {
  const t = p.locator(".ui-textarea textarea, textarea.ui-textarea").first();
  const box = () => p.evaluate(() => { const b = document.querySelector(".ui-textarea"); return Math.round(b.getBoundingClientRect().height); });
  const before = await box();
  await t.click(); await t.press("End"); await t.press("Enter"); await t.pressSequentially("Another line.", { delay: 10 }); await t.press("Enter"); await t.pressSequentially("And one more.", { delay: 10 });
  await p.waitForTimeout(300);
  return { before, after: await box() };
});
await check("enter: Check path (keydown.enter)", DG, "/setup", async (p) => {
  const f = p.locator(native(".setup .ui-input")).first();
  await f.click(); await f.press("End"); await f.press("Enter"); await p.waitForTimeout(1500);
  return p.evaluate(() => ({ inspected: /Placeholders/.test(document.body.innerText), keys: document.body.innerText.match(/Keys\s+(\d+)/)?.[1] ?? null }));
});
await check("change: Studio title commits on change", JV, "/studio", async (p, port) => {
  const f = p.locator("input[placeholder='Project title']").first();
  if (!(await f.count())) return "no title field on this page";
  await f.fill("Q3 check title"); await f.press("Tab"); await p.waitForTimeout(800);
  const res = await fetch(`http://127.0.0.1:${port}/v1/projects`).then((r) => r.json()).catch(() => null);
  const list = Array.isArray(res) ? res : res?.projects ?? [];
  return { names: list.map((x) => x.name).filter((n) => /Q3 check/.test(n)) };
});
await check("focus(): Tab order through fields", DG, "/setup", async (p) => {
  const seen = [];
  await p.evaluate(() => document.activeElement?.blur());
  for (let i = 0; i < 8; i++) { await p.keyboard.press("Tab"); seen.push(await p.evaluate(() => { const a = document.activeElement; return `${a.tagName}:${(a.placeholder || a.textContent || "").trim().slice(0, 16)}`; })); }
  return seen;
});
console.log(lines.join("\n"));
await browser.close();
