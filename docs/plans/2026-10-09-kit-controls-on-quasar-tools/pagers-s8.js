import { chromium } from "file:///E:/Dev/Web/justwrite-app/node_modules/playwright/index.mjs";
const browser = await chromium.launch();
const routes = { 8782: ["/characters", "/locations", "/plot", "/chapters", "/ai", "/notes", "/items", "/factions"], 8784: ["/personas", "/lexicons", "/voices", "/effects", "/studio", "/projects", "/captures", "/settings", "/ai"], 8786: ["/", "/runs", "/review", "/docs", "/ai"] };
for (const [port, rs] of Object.entries(routes)) for (const r of rs) {
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await p.addInitScript(() => { window.__JW_BENCH__ = true; });
  await p.goto(`http://127.0.0.1:${port}/#${r}`); await p.waitForTimeout(3500);
  const info = await p.evaluate(() => [...document.querySelectorAll(".ui-table-wrap")].map((w) => `${w.querySelectorAll("tbody > tr").length}r pager=${w.querySelector(".ui-table-pager-count")?.textContent.trim() ?? "-"}`));
  console.log(port, r, JSON.stringify(info));
  await p.close();
}
await browser.close();
