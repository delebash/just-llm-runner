// SPDX-License-Identifier: MIT
// Slice 2's behaviour, on both builds: the same answers from UiButton's users.
import { chromium } from "file:///E:/Dev/Web/justwrite-app/node_modules/playwright/index.mjs";

const browser = await chromium.launch();
async function page(port, route) {
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.addInitScript(() => { window.__JW_BENCH__ = true; });
  await p.goto(`http://127.0.0.1:${port}/#${route}`);
  await p.waitForTimeout(4500);
  await p.evaluate(() => document.querySelector(".lu-bootload__skip")?.click());
  p.errors = errors;
  return p;
}
const results = [];
async function check(name, ports, fn) {
  const out = [];
  for (const port of ports) {
    const p = await page(port, fn.route);
    try { out.push(JSON.stringify(await fn.run(p))); } catch (e) { out.push(`THREW ${e.message}`); }
    if (p.errors.length) out[out.length - 1] += ` ERRORS ${p.errors.join(" | ")}`;
    await p.close();
  }
  results.push(`${name.padEnd(30)} ${out[0] === out[1] ? "SAME" : "DIFFERENT"}\n    base: ${out[0]}\n    new:  ${out[1]}`);
}

const JV = [8783, 8784];
const JW = [8781, 8782];
await check("jv: QBtn in use", JV, { route: "/projects", run: (p) => p.evaluate(() => ({ qbtn: document.querySelectorAll(".q-btn.ui-btn").length > 0, buttons: document.querySelectorAll("button.ui-btn").length })) });
await check("jv: click New project", JV, { route: "/projects", run: async (p) => { await p.click(".ui-btn--primary"); await p.waitForTimeout(600); return { modal: !!document && await p.evaluate(() => !!document.querySelector(".ui-modal")) }; } });
await check("jv: Enter on New project", JV, { route: "/projects", run: async (p) => { await p.focus(".ui-btn--primary"); await p.keyboard.press("Enter"); await p.waitForTimeout(600); return { modal: await p.evaluate(() => !!document.querySelector(".ui-modal")) }; } });
await check("jv: Space on New project", JV, { route: "/projects", run: async (p) => { await p.focus(".ui-btn--primary"); await p.keyboard.press("Space"); await p.waitForTimeout(600); return { modal: await p.evaluate(() => !!document.querySelector(".ui-modal")) }; } });
await check("jv: disabled button", JV, { route: "/personas", run: (p) => p.evaluate(() => { const b = document.querySelector(".ui-btn.is-disabled"); return { tag: b.tagName, disabled: b.disabled, focusable: (b.focus(), document.activeElement === b), text: b.textContent.trim() }; }) });
await check("jv: tab order of buttons", JV, { route: "/projects", run: async (p) => { const seen = []; await p.evaluate(() => document.activeElement?.blur()); for (let i = 0; i < 12; i++) { await p.keyboard.press("Tab"); seen.push(await p.evaluate(() => { const a = document.activeElement; return `${a.tagName}${a.classList.contains("ui-btn") ? ".ui-btn" : ""}:${(a.textContent || a.placeholder || "").trim().slice(0, 14)}`; })); } return seen; } });
await check("jv: download link", JV, { route: "/home", run: (p) => p.evaluate(() => [...document.querySelectorAll("a.ui-btn")].slice(0, 2).map((a) => ({ tag: a.tagName, href: !!a.getAttribute("href"), download: a.hasAttribute("download"), title: a.title }))) });
await check("jw: cover picker opens a file chooser", JW, { route: "/settings", run: async (p) => {
  const label = await p.evaluateHandle(() => [...document.querySelectorAll(".ui-btn")].find((b) => b.querySelector('input[type="file"]')));
  if (!(await label.evaluate((x) => !!x))) return "no picker on this page";
  await label.evaluate((x) => x.scrollIntoView());
  const [chooser] = await Promise.all([p.waitForEvent("filechooser", { timeout: 3000 }).catch(() => null), label.click()]);
  return { tag: await label.evaluate((x) => x.tagName), chooser: !!chooser };
} });
await check("jw: New chapter click", JW, { route: "/chapters", run: async (p) => { const before = await p.evaluate(() => location.hash); await p.click(".ui-btn--primary"); await p.waitForTimeout(800); return { modal: await p.evaluate(() => !!document.querySelector(".ui-modal, [role=dialog]")), samePage: before === (await p.evaluate(() => location.hash)) }; } });
console.log(results.join("\n"));
await browser.close();
