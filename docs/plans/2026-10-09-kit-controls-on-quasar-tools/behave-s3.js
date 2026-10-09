// Slice 3's behaviour, on both builds: checkbox and switch answer the same way.
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
    try { out.push(JSON.stringify(await run(p))); } catch (e) { out.push(`THREW ${e.message.split("\n")[0]}`); }
    if (p.errors.length) out[out.length - 1] += ` ERRORS ${p.errors.join(" | ")}`;
    await p.close();
  }
  lines.push(`${name.padEnd(34)} ${out[0] === out[1] ? "SAME" : "DIFFERENT"}\n    base: ${out[0]}\n    new:  ${out[1]}`);
}
const JV = [8783, 8784];
const DG = [8785, 8786];
const cbState = (p, i) => p.evaluate((i) => {
  const c = document.querySelectorAll("tbody .ui-checkbox")[i];
  const sel = document.querySelector(".ui-btn.is-disabled, .ui-btn--danger-outline");
  return { checked: c.classList.contains("is-checked"), aria: (c.getAttribute("aria-checked") ?? c.querySelector("input")?.checked?.toString()), deleteDisabled: sel?.disabled ?? null };
}, i);
await check("checkbox: click", JV, "/personas", async (p) => { await p.locator("tbody .ui-checkbox").nth(1).click(); await p.waitForTimeout(200); return cbState(p, 1); });
await check("checkbox: click twice", JV, "/personas", async (p) => { const c = p.locator("tbody .ui-checkbox").nth(1); await c.click(); await c.click(); await p.waitForTimeout(200); return cbState(p, 1); });
await check("checkbox: Tab + Space", JV, "/personas", async (p) => {
  await p.locator("tbody .ui-checkbox").nth(0).click();
  await p.keyboard.press("Tab"); await p.keyboard.press("Space"); await p.waitForTimeout(200);
  return [await cbState(p, 0), await cbState(p, 1)];
});
await check("checkbox: Enter does nothing", JV, "/personas", async (p) => {
  await p.locator("tbody .ui-checkbox").nth(0).click();
  await p.keyboard.press("Tab"); await p.keyboard.press("Enter"); await p.waitForTimeout(200);
  return [await cbState(p, 0), await cbState(p, 1)];
});
await check("checkbox: select-all", JV, "/personas", async (p) => { await p.locator("thead .ui-checkbox").click(); await p.waitForTimeout(200); return p.evaluate(() => document.querySelectorAll("tbody .ui-checkbox.is-checked").length); });
await check("checkbox: disabled stays", JV, "/captures", async (p) => { await p.locator(".captures__autopaste").click({ force: true }); await p.waitForTimeout(200); return p.evaluate(() => { const c = document.querySelector(".captures__autopaste"); return { checked: c.classList.contains("is-checked"), disabled: c.classList.contains("is-disabled"), tabbable: c.tabIndex >= 0 && !c.querySelector?.("input:disabled") }; }); });
const tgState = (p) => p.evaluate(() => { const t = document.querySelector(".lu-warm-toggle .ui-toggle, label.row .ui-toggle"); return { on: t.classList.contains("ui-toggle--on"), aria: t.getAttribute("aria-checked"), role: t.getAttribute("role") }; });
await check("switch: role and state", DG, "/settings/server", (p) => tgState(p));
await check("switch: Space flips (then back)", DG, "/settings/server", async (p) => {
  await p.locator("label.row .ui-toggle").first().focus(); await p.keyboard.press("Space"); await p.waitForTimeout(400);
  const after = await tgState(p);
  await p.keyboard.press("Space"); await p.waitForTimeout(400);
  return [after, await tgState(p)];
});
await check("switch: Enter flips (then back)", DG, "/settings/server", async (p) => {
  await p.locator("label.row .ui-toggle").first().focus(); await p.keyboard.press("Enter"); await p.waitForTimeout(400);
  const after = await tgState(p);
  await p.keyboard.press("Enter"); await p.waitForTimeout(400);
  return [after, await tgState(p)];
});
await check("switch: label click flips (then back)", DG, "/settings/server", async (p) => {
  await p.locator("label.row > span").first().click(); await p.waitForTimeout(400);
  const after = await tgState(p);
  await p.locator("label.row > span").first().click(); await p.waitForTimeout(400);
  return [after, await tgState(p)];
});
const JW = [8781, 8782];
await check("checkbox: label text click (JW)", JW, "/relations", async (p) => {
  const st = () => p.evaluate(() => [...document.querySelectorAll(".relations-legend .ui-checkbox")].map((c) => c.classList.contains("is-checked")));
  const before = await st();
  await p.locator(".relations-legend .legend-label").first().click(); await p.waitForTimeout(300);
  const after = await st();
  await p.locator(".relations-legend .legend-label").first().click(); await p.waitForTimeout(300);
  return [before, after, await st()];
});
await check("checkbox: box click inside label (JW)", JW, "/relations", async (p) => {
  const st = () => p.evaluate(() => [...document.querySelectorAll(".relations-legend .ui-checkbox")].map((c) => c.classList.contains("is-checked")));
  await p.locator(".relations-legend .ui-checkbox").first().click(); await p.waitForTimeout(300);
  const after = await st();
  await p.locator(".relations-legend .ui-checkbox").first().click(); await p.waitForTimeout(300);
  return [after, await st()];
});
await check("switch: box click inside label", DG, "/settings/server", async (p) => {
  await p.locator("label.row .ui-toggle").first().click(); await p.waitForTimeout(400);
  const after = await tgState(p);
  await p.locator("label.row .ui-toggle").first().click(); await p.waitForTimeout(400);
  return [after, await tgState(p)];
});
console.log(lines.join("\n"));
await browser.close();
