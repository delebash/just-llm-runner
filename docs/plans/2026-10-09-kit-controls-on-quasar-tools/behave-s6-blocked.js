// The off option of JustVoice's persona-kind segmented control: listed, dimmed, and a click says why.
import { chromium } from "file:///E:/Dev/Web/justwrite-app/node_modules/playwright/index.mjs";
const browser = await chromium.launch();
const out = [];
for (const port of [8783, 8784]) {
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`http://127.0.0.1:${port}/#/personas/persona_391625bf20db492d9ffc22855d12eef8`);
  await p.waitForTimeout(4500);
  const off = await p.evaluate(() => [...document.querySelectorAll(".ui-seg--small")].map((s) => [...s.querySelectorAll("button")].map((b) => [b.querySelector("b")?.textContent.trim(), b.classList.contains("is-off"), b.getAttribute("aria-disabled"), b.title || null])));
  const clicked = await p.evaluate(() => { const b = [...document.querySelectorAll(".ui-seg--small button.is-off")][0]; if (!b) return null; b.click(); return b.querySelector("b")?.textContent.trim(); });
  await p.waitForTimeout(800);
  const after = await p.evaluate(() => ({
    active: [...document.querySelectorAll(".ui-seg--small button.active")].map((b) => b.querySelector("b")?.textContent.trim()),
    notes: [...document.querySelectorAll(".ui-toast, [data-sonner-toast], .q-notification, .pe-note, .jv-notice, [role=status], [role=alert]")].map((t) => t.textContent.trim().slice(0, 90)).filter(Boolean),
  }));
  out.push(JSON.stringify({ off, clicked, after, errors }));
  await p.close();
}
console.log(out[0] === out[1] ? "SAME" : "DIFFERENT");
console.log("base:", out[0]);
console.log("new: ", out[1]);
await browser.close();
