import { chromium } from "file:///E:/Dev/Web/justwrite-app/node_modules/playwright/index.mjs";
const browser = await chromium.launch();
for (const [port, route] of [[8783, "/voices"], [8784, "/voices"], [8781, "/ai"], [8782, "/ai"]]) {
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await p.addInitScript(() => { window.__JW_BENCH__ = true; });
  await p.goto(`http://127.0.0.1:${port}/#${route}`); await p.waitForTimeout(4500);
  const r = await p.evaluate(async () => {
    const w = document.querySelector(".ui-table-sticky");
    if (!w) return "no sticky table";
    const th = w.querySelector("thead th");
    let s = th.parentElement; while (s && !(s.scrollHeight > s.clientHeight && /auto|scroll/.test(getComputedStyle(s).overflowY))) s = s.parentElement;
    if (!s) return "no scroller";
    const before = Math.round(th.getBoundingClientRect().top);
    s.scrollTop = 900; await new Promise((r) => setTimeout(r, 300));
    return { scroller: s.className.slice(0, 40), before, after: Math.round(th.getBoundingClientRect().top), scrollerTop: Math.round(s.getBoundingClientRect().top), pos: getComputedStyle(th).position, scrolled: s.scrollTop };
  });
  console.log(port, route, JSON.stringify(r));
  await p.screenshot({ path: `s8/sticky-${port}.png`, clip: { x: 0, y: 0, width: 1440, height: 300 } });
  await p.close();
}
await browser.close();
