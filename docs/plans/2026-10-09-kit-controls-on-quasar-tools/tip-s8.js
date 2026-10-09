// SPDX-License-Identifier: MIT
import { chromium } from "file:///E:/Dev/Web/justwrite-app/node_modules/playwright/index.mjs";
import scen from "./scenario-s8.js";
const grow = scen.find((s) => s.name === "characters-pager").prep;
const browser = await chromium.launch();
for (const port of [8781, 8782]) {
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await p.addInitScript(() => { window.__JW_BENCH__ = true; });
  await p.goto(`http://127.0.0.1:${port}/#/characters`); await p.waitForTimeout(4000);
  await p.evaluate(grow); await p.waitForTimeout(300);
  await p.locator(".ui-table-pager-btn").nth(2).scrollIntoViewIfNeeded();
  await p.locator(".ui-table-pager-btn").nth(2).hover();
  for (const ms of [300, 1500]) {
    await p.waitForTimeout(ms);
    const tip = await p.evaluate(() => { const t = [...document.querySelectorAll("body *")].find((e) => e.textContent.trim() === "Next page" && e.children.length === 0); if (!t) return null; const r = t.getBoundingClientRect(); const cs = getComputedStyle(t.closest("[class]")); return { cls: t.className || t.parentElement.className, box: [r.x, r.y, r.width, r.height].map(Math.round), bg: cs.backgroundColor, op: cs.opacity }; });
    console.log(port, ms, JSON.stringify(tip));
    const b = await p.locator(".ui-table-pager").boundingBox();
    await p.screenshot({ path: `s8/tip-${port}-${ms}.png`, clip: { x: b.x + 850, y: b.y, width: 250, height: 90 } });
  }
  await p.close();
}
await browser.close();
