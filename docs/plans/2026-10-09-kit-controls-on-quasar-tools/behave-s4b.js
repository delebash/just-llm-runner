import { chromium } from "file:///E:/Dev/Web/justwrite-app/node_modules/playwright/index.mjs";
const browser = await chromium.launch();
for (const port of [8785, 8786]) {
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto(`http://127.0.0.1:${port}/#/setup`);
  await p.waitForTimeout(4500);
  const before = await p.evaluate(() => ({ inspected: /Placeholders\s+\{/.test(document.body.innerText) || !!document.querySelector(".setup td")?.textContent.match(/\d/) }));
  const handle = await p.evaluateHandle(() => { const b = document.querySelector(".setup .ui-input"); return b.matches("input") ? b : b.querySelector("input"); });
  await handle.focus(); await p.keyboard.press("End"); await p.keyboard.press("Enter");
  await p.waitForTimeout(2500);
  const after = await p.evaluate(() => [...document.querySelectorAll(".setup td")].slice(0, 3).map((t) => t.textContent.trim()));
  console.log(port, JSON.stringify({ before, after }));
  await p.close();
}
await browser.close();
