// Slice 5's behaviour, on both builds: the selects answer the same way.
import { chromium } from "file:///E:/Dev/Web/justwrite-app/node_modules/playwright/index.mjs";

const browser = await chromium.launch();
async function open(port, route) {
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  p.errors = [];
  p.on("pageerror", (e) => p.errors.push(e.message));
  await p.goto(`http://127.0.0.1:${port}/#${route}`);
  await p.waitForTimeout(4500);
  return p;
}
const lines = [];
async function check(name, ports, route, run) {
  const out = [];
  for (const port of ports) {
    const p = await open(port, route);
    if (route === "/voices") { await p.click(".ui-select-trigger"); await p.waitForTimeout(300); await p.locator(".ui-select-content .ui-select-item").first().click(); await p.waitForTimeout(400); }
    try { out.push(JSON.stringify(await run(p))); } catch (e) { out.push(`THREW ${e.message.split("\n")[0]}`); }
    if (p.errors.length) out[out.length - 1] += ` ERRORS ${p.errors.join(" | ")}`;
    await p.close();
  }
  lines.push(`${name.padEnd(38)} ${out[0] === out[1] ? "SAME" : "DIFFERENT"}\n    base: ${out[0]}\n    new:  ${out[1]}`);
}
const JV = [8783, 8784];
const DG = [8785, 8786];
const trig = ".ui-select-trigger";
const state = (p) => p.evaluate(() => ({
  open: !!document.querySelector(".ui-select-content"),
  value: document.querySelector(".ui-select-trigger")?.innerText.trim(),
  rows: document.querySelectorAll("tbody tr").length,
}));
const focusTrigger = (p, sel = trig) => p.evaluate((sel) => { const t = document.querySelector(sel); (t.matches("button") ? t : t.querySelector(".q-select__focus-target")).focus(); }, sel);
const pickSecond = async (p) => { await p.click(trig); await p.waitForTimeout(300); await p.locator(".ui-select-content .ui-select-item").nth(1).click(); await p.waitForTimeout(400); };

await check("select: click opens", JV, "/voices", async (p) => { await p.click(trig); await p.waitForTimeout(300); return state(p); });
await check("select: click option chooses + filters", JV, "/voices", async (p) => { await pickSecond(p); return state(p); });
await check("select: options listed", JV, "/voices", async (p) => { await p.click(trig); await p.waitForTimeout(300); return p.evaluate(() => [...document.querySelectorAll(".ui-select-content .ui-select-item")].map((i) => i.innerText.trim())); });
await check("select: Escape closes", JV, "/voices", async (p) => { await p.click(trig); await p.waitForTimeout(300); await p.keyboard.press("Escape"); await p.waitForTimeout(300); return state(p); });
await check("select: outside click closes", JV, "/voices", async (p) => { await p.click(trig); await p.waitForTimeout(300); await p.mouse.click(700, 600); await p.waitForTimeout(400); return state(p); });
await check("select: keyboard ArrowDown×2 Enter", JV, "/voices", async (p) => {
  await focusTrigger(p); await p.keyboard.press("ArrowDown"); await p.waitForTimeout(400);
  const opened = (await state(p)).open;
  await p.keyboard.press("ArrowDown"); await p.waitForTimeout(250); await p.keyboard.press("Enter"); await p.waitForTimeout(400);
  return { opened, ...(await state(p)) };
});
await check("select: Enter opens, Escape keeps value", JV, "/voices", async (p) => {
  await focusTrigger(p); await p.keyboard.press("Enter"); await p.waitForTimeout(300);
  const opened = (await state(p)).open;
  await p.keyboard.press("Escape"); await p.waitForTimeout(300);
  return { opened, ...(await state(p)) };
});
await check("select: focus stays on trigger after pick", JV, "/voices", async (p) => { await pickSecond(p); return p.evaluate(() => { const a = document.activeElement; return { inTrigger: !!a.closest(".ui-select-trigger") }; }); });

const ms = ".ui-mselect-trigger";
const msState = (p) => p.evaluate(() => ({
  open: !!document.querySelector(".ui-mselect-content"),
  chips: [...document.querySelectorAll(".ui-mselect-chip")].map((c) => c.innerText.trim()),
  items: [...document.querySelectorAll(".ui-mselect-content .ui-mselect-item")].slice(0, 4).map((i) => i.innerText.trim()),
  checked: [...document.querySelectorAll(".ui-mselect-content .ui-mselect-item")].filter((i) => i.matches(".is-checked, [data-state=checked]")).map((i) => i.innerText.trim()),
  focusInFilter: document.activeElement?.matches?.(".ui-mselect-filter, input[placeholder='Filter…']") ?? false,
}));
await check("multi: open, filter has focus", DG, "/setup", async (p) => { await p.click(ms); await p.waitForTimeout(400); return msState(p); });
await check("multi: type filters", DG, "/setup", async (p) => { await p.click(ms); await p.waitForTimeout(400); await p.keyboard.type("ger", { delay: 40 }); await p.waitForTimeout(300); return msState(p); });
await check("multi: Enter ticks the highlighted", DG, "/setup", async (p) => { await p.click(ms); await p.waitForTimeout(400); await p.keyboard.type("german", { delay: 40 }); await p.keyboard.press("ArrowDown"); await p.keyboard.press("Enter"); await p.waitForTimeout(300); return msState(p); });
await check("multi: click ticks, keeps open", DG, "/setup", async (p) => { await p.click(ms); await p.waitForTimeout(400); await p.locator(".ui-mselect-content .ui-mselect-item").nth(0).click(); await p.waitForTimeout(300); return msState(p); });
await check("multi: click trigger again closes", DG, "/setup", async (p) => { await p.click(ms); await p.waitForTimeout(400); await p.click(ms); await p.waitForTimeout(400); return msState(p); });
await check("multi: chip ✕ removes", DG, "/setup", async (p) => { await p.locator(".ui-mselect-chip-x").first().click(); await p.waitForTimeout(300); return msState(p); });
await check("multi: clear all", DG, "/setup", async (p) => { await p.locator(".ui-mselect-trigger .ui-select-clear").click(); await p.waitForTimeout(300); return msState(p); });
await check("multi: no matches row", DG, "/setup", async (p) => { await p.click(ms); await p.waitForTimeout(400); await p.keyboard.type("zzzq", { delay: 40 }); await p.waitForTimeout(300); return p.evaluate(() => ({ empty: document.querySelector(".ui-mselect-empty")?.innerText.trim(), focusInFilter: document.activeElement?.matches?.("input") ?? false })); });
console.log(lines.join("\n"));
await browser.close();
