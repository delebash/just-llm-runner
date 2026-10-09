// SPDX-License-Identifier: MIT
import { chromium } from "file:///E:/Dev/Web/justwrite-app/node_modules/playwright/index.mjs";
const browser = await chromium.launch();
for (const [ports, route, sel] of [[[8783, 8784], "/personas", "input[type=search], input[placeholder*='earch'], input[placeholder*='ilter']"], [[8785, 8786], "/", "input"], [[8781, 8782], "/characters", "input[placeholder*='earch'], input[placeholder*='ilter']"]]) {
  for (const port of ports) {
    for (const theme of ["light", "dark"]) {
      const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await p.addInitScript(() => { window.__JW_BENCH__ = true; });
      await p.goto(`http://127.0.0.1:${port}/#${route}`); await p.waitForTimeout(4000);
      if (theme === "dark") await p.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
      await p.locator(sel).first().fill("zzzzqqq"); await p.waitForTimeout(600);
      await p.mouse.move(0, 0);
      const el = p.locator(".ui-table-wrap").first();
      if (await el.count()) await el.screenshot({ path: `s8/empty-${route.replace(/\W/g, "") || "home"}-${theme}-${port}.png` });
      else console.log(port, route, "no table");
      await p.close();
    }
  }
}
await browser.close();
