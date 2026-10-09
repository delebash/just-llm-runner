// SPDX-License-Identifier: MIT
// Slice 8's behaviour, on both builds: the table sorts (each sortable column through its click
// cycle), filters, pages, clicks through to a row, shows its empty row, and adds no Tab stop —
// JustVoice's Personas / Lexicons / Voices / Effects, JustWrite's entity index, docgen's dashboard
// and runs.
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
async function check(name, ports, route, run, { expected } = {}) {
  if (process.env.FILTER && !name.startsWith(process.env.FILTER)) return;
  const out = [];
  for (const port of ports) {
    const p = await open(port, route);
    try { out.push(JSON.stringify(await run(p))); } catch (e) { out.push(`THREW ${e.message.split("\n")[0]}`); }
    if (p.errors.length) out[out.length - 1] += ` ERRORS ${p.errors.join(" | ")}`;
    await p.close();
  }
  const same = out[0] === out[1];
  lines.push(`${name.padEnd(46)} ${same ? "SAME" : expected ? "DIFFERENT (EXPECTED)" : "DIFFERENT"}\n    base: ${out[0].slice(0, 600)}\n    new:  ${out[1].slice(0, 600)}`);
}
const JW = [8781, 8782];
const JV = [8783, 8784];
const DG = [8785, 8786];
const table = (p, i = 0) => p.evaluate((i) => {
  const t = document.querySelectorAll("table.ui-table")[i];
  if (!t) return null;
  const wrap = t.closest(".ui-table-wrap");
  return {
    heads: [...t.querySelectorAll("thead th")].map((th) => `${th.textContent.trim().slice(0, 18)}${th.classList.contains("is-sortable") ? "~" : ""}${th.classList.contains("is-sorted") ? (th.querySelector(".ui-table-sort.desc") ? "↓" : "↑") : ""}`),
    rows: [...t.querySelectorAll("tbody > tr")].slice(0, 6).map((tr) => `${tr.className.replace(/\s+/g, ".")}|${tr.textContent.replace(/\s+/g, " ").trim().slice(0, 40)}`),
    count: t.querySelectorAll("tbody > tr.ui-table-row").length,
    full: t.querySelectorAll("tbody > tr.ui-table-fullrow").length,
    empty: t.querySelector(".ui-table-empty-row")?.textContent.trim() ?? null,
    pager: wrap?.querySelector(".ui-table-pager-count")?.textContent.trim() ?? null,
    page: wrap?.querySelector(".ui-table-pager-page")?.textContent.trim() ?? null,
  };
}, i);
// each sortable header of the first table: click 1, 2, 3 times
async function sortCycle(p, i = 0) {
  const n = await p.evaluate(() => document.querySelectorAll("table.ui-table")[0]?.querySelectorAll("thead th.is-sortable").length ?? 0);
  const out = [];
  for (let h = 0; h < n; h++) {
    const steps = [];
    for (let k = 0; k < 3; k++) {
      await p.evaluate((h) => document.querySelectorAll("table.ui-table")[0].querySelectorAll("thead th.is-sortable")[h].click(), h);
      await p.waitForTimeout(200);
      const t = await table(p, i);
      steps.push({ heads: t.heads.filter((x) => /[↑↓]/.test(x)), rows: t.rows.slice(0, 3) });
    }
    out.push(steps);
  }
  return out;
}

for (const route of ["/personas", "/lexicons", "/voices", "/effects", "/studio"]) {
  await check(`table ${route}: at rest`, JV, route, (p) => table(p));
  await check(`table ${route}: every sort cycle`, JV, route, (p) => sortCycle(p));
}
await check("table /personas: a row click opens it", JV, "/personas", async (p) => {
  await p.locator("table.ui-table tbody tr.ui-table-row td:nth-child(2)").first().click(); await p.waitForTimeout(800);
  return p.evaluate(() => location.hash.replace(/persona_\w+/, "persona_ID"));
});
await check("table /personas: hover marks the row", JV, "/personas", async (p) => {
  await p.locator("table.ui-table tbody tr.ui-table-row").nth(2).hover(); await p.waitForTimeout(200);
  return p.evaluate(() => getComputedStyle(document.querySelectorAll("table.ui-table tbody tr.ui-table-row")[2].querySelector("td")).backgroundColor);
});
await check("table /personas: no extra Tab stops", JV, "/personas", (p) => p.evaluate(() => {
  const w = document.querySelector(".ui-table-wrap");
  return [...w.querySelectorAll("*")].filter((el) => el.tabIndex >= 0 && !el.disabled && el.getClientRects().length).map((el) => el.tagName).reduce((a, t) => { a[t] = (a[t] || 0) + 1; return a; }, {});
}));
await check("table /personas: filter to nothing shows the empty row", JV, "/personas", async (p) => {
  const box = p.locator("input[type=search], input[placeholder*='earch'], input[placeholder*='ilter']").first();
  await box.fill("zzzzqqq"); await p.waitForTimeout(500);
  return table(p);
});

await check("table jw /characters: at rest + pager", JW, "/characters", (p) => table(p));
await check("table jw /characters: search filters", JW, "/characters", async (p) => {
  const box = p.locator(".ui-table-wrap").first().locator("xpath=ancestor::*[1]").locator("input").first();
  const any = p.locator("input[placeholder*='earch'], input[placeholder*='ilter']").first();
  await (await box.count() ? box : any).fill("a"); await p.waitForTimeout(500);
  return table(p);
});
await check("table jw /characters: page size 10, next page", JW, "/characters", async (p) => {
  const size = p.locator(".ui-table-pager-size");
  if (!(await size.count())) return "no pager";
  await size.selectOption("10"); await p.waitForTimeout(300);
  const first = await table(p);
  await p.locator(".ui-table-pager-btn").nth(2).click(); await p.waitForTimeout(300);
  return { first: { pager: first.pager, page: first.page }, next: await table(p) };
});
await check("table jw /characters: sort cycle", JW, "/characters", (p) => sortCycle(p));

await check("table dg /: at rest", DG, "/", (p) => table(p));
await check("table dg /: filter 'ger'", DG, "/", async (p) => {
  const box = p.locator("input[placeholder*='ilter'], input[type=search]").first();
  if (!(await box.count())) return "no filter box";
  await box.fill("ger"); await p.waitForTimeout(500);
  return table(p);
});
await check("table dg /runs: default sort + cycle", DG, "/runs", async (p) => ({ rest: await table(p), cycle: await sortCycle(p) }));

console.log(lines.join("\n"));
await browser.close();
