import { chromium } from "file:///E:/Dev/Web/justwrite-app/node_modules/playwright/index.mjs";
const browser = await chromium.launch();
async function run(port, route) {
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(`http://127.0.0.1:${port}/#${route}`); await p.waitForTimeout(4500);
  const res = [];
  const nT = await p.evaluate(() => document.querySelectorAll("table.ui-table").length);
  for (let t = 0; t < nT; t++) {
    const nH = await p.evaluate((t) => document.querySelectorAll("table.ui-table")[t].querySelectorAll("thead th.is-sortable").length, t);
    const rest = await p.evaluate((t) => [...document.querySelectorAll("table.ui-table")[t].querySelectorAll("thead th")].map((th) => th.className.replace("ui-table-th", "").trim() + ":" + th.textContent.trim().slice(0, 12)), t);
    const cyc = [];
    for (let h = 0; h < nH; h++) for (let k = 0; k < 3; k++) {
      await p.evaluate(([t, h]) => document.querySelectorAll("table.ui-table")[t].querySelectorAll("thead th.is-sortable")[h].click(), [t, h]);
      await p.waitForTimeout(150);
      cyc.push(await p.evaluate((t) => { const tb = document.querySelectorAll("table.ui-table")[t]; return [...tb.querySelectorAll("thead th.is-sorted")].map((th) => th.textContent.trim().slice(0, 10) + (th.querySelector(".ui-table-sort.desc") ? "↓" : "↑")).join(",") + "|" + [...tb.querySelectorAll("tbody > tr")].slice(0, 4).map((r) => r.textContent.replace(/\s+/g, " ").trim().slice(0, 16)).join("/"); }, t));
    }
    res.push({ rest, cyc });
  }
  await p.close();
  return JSON.stringify(res) + (errs.length ? " ERRORS " + errs.join(" | ") : "");
}
for (const [a, b, r] of [[8783, 8784, "/ai"], [8783, 8784, "/settings"], [8783, 8784, "/settings/server"], [8781, 8782, "/ai"], [8781, 8782, "/settings/ai"], [8785, 8786, "/ai"], [8785, 8786, "/runs"]]) {
  const x = await run(a, r); const y = await run(b, r);
  console.log(`${b} ${r}: ${x === y ? "SAME" : "DIFFERENT"}  tables=${(x.match(/"rest"/g) || []).length}`);
  if (x !== y) console.log("  base: " + x.slice(0, 900) + "\n  new:  " + y.slice(0, 900));
}
await browser.close();
