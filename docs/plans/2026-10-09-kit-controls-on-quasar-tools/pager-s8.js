// SPDX-License-Identifier: MIT
import { chromium } from "file:///E:/Dev/Web/justwrite-app/node_modules/playwright/index.mjs";
const browser = await chromium.launch();
const out = [];
for (const port of [8781, 8782]) {
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  await p.addInitScript(() => { window.__JW_BENCH__ = true; });
  await p.goto(`http://127.0.0.1:${port}/#/characters`); await p.waitForTimeout(4000);
  await p.evaluate(() => {
    const el = document.querySelector("#q-app") ?? document.querySelector("[data-v-app]");
    const store = el.__vue_app__.config.globalProperties.$pinia._s.get("project");
    const base = store.characters[0];
    for (let i = 0; i < 37; i++) store.characters.push({ ...base, id: `chr_pg_${i}`, name: `Zed ${String(i).padStart(2, "0")}` });
  });
  await p.waitForTimeout(500);
  const snap = () => p.evaluate(() => {
    const w = document.querySelector(".ui-table-wrap");
    return { rows: w.querySelectorAll("tbody > tr.ui-table-row").length, first: w.querySelector("tbody > tr.ui-table-row")?.textContent.trim().slice(0, 20), count: w.querySelector(".ui-table-pager-count")?.textContent.trim(), page: w.querySelector(".ui-table-pager-page")?.textContent.trim(), btns: [...w.querySelectorAll(".ui-table-pager-btn")].map((b) => b.disabled ? "x" : "o").join(""), size: w.querySelector(".ui-table-pager-size")?.value ?? w.querySelector(".ui-table-pager-size")?.textContent.trim() };
  });
  const steps = { start: await snap() };
  const btn = (i) => p.evaluate((i) => document.querySelectorAll(".ui-table-pager-btn")[i].click(), i);
  await btn(2); await p.waitForTimeout(200); steps.next = await snap();
  await btn(3); await p.waitForTimeout(200); steps.last = await snap();
  await btn(1); await p.waitForTimeout(200); steps.prev = await snap();
  await btn(0); await p.waitForTimeout(200); steps.first = await snap();
  await btn(2); await p.waitForTimeout(200);
  // a sort click on page 2 goes back to page 1
  await p.locator("table.ui-table thead th.is-sortable").first().click(); await p.waitForTimeout(200); steps.sortResets = await snap();
  await btn(2); await p.waitForTimeout(200);
  await p.locator("input[placeholder*='earch'], input[placeholder*='ilter']").first().fill("Zed"); await p.waitForTimeout(400); steps.filterResets = await snap();
  steps.sizeHtml = await p.evaluate(() => document.querySelector(".ui-table-pager-size")?.outerHTML.slice(0, 160));
  out.push(JSON.stringify(steps) + (errs.length ? ` ERRORS ${errs.join(" | ")}` : ""));
  await p.close();
}
console.log(out[0] === out[1] ? "SAME" : "DIFFERENT"); console.log(out.join("\n"));
await browser.close();
