// SPDX-License-Identifier: MIT
// Slice 7b's behaviour, on both builds: the row menu (JustVoice's Personas — pointer, keyboard,
// typing, Esc, outside click, an action that opens a prompt, a disabled item) and JustWrite's
// StatusSelect (open, pick, keyboard, Esc, New status…).
import { chromium } from "file:///E:/Dev/Web/justwrite-app/node_modules/playwright/index.mjs";

const browser = await chromium.launch();
async function open(port, route, prep) {
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  p.errors = [];
  p.on("pageerror", (e) => p.errors.push(e.message));
  await p.addInitScript(() => { window.__JW_BENCH__ = true; });
  await p.goto(`http://127.0.0.1:${port}/#${route}`);
  await p.waitForTimeout(4500);
  if (prep) { await p.evaluate(prep); await p.waitForTimeout(600); }
  return p;
}
const lines = [];
async function check(name, ports, route, run, { prep, expected } = {}) {
  if (process.env.FILTER && !name.startsWith(process.env.FILTER)) return;
  const out = [];
  for (const port of ports) {
    const p = await open(port, route, prep);
    try { out.push(JSON.stringify(await run(p))); } catch (e) { out.push(`THREW ${e.message.split("\n")[0]}`); }
    if (p.errors.length) out[out.length - 1] += ` ERRORS ${p.errors.join(" | ")}`;
    await p.close();
  }
  const same = out[0] === out[1];
  lines.push(`${name.padEnd(46)} ${same ? "SAME" : expected ? "DIFFERENT (EXPECTED)" : "DIFFERENT"}\n    base: ${out[0]}\n    new:  ${out[1]}`);
}
const JW = [8781, 8782];
const JV = [8783, 8784];
const menuState = (p) => p.evaluate(() => {
  const m = document.querySelector(".ev-menu");
  const a = document.activeElement;
  const t = document.querySelector(".ev-kebab");
  return {
    open: !!m,
    items: m ? [...m.querySelectorAll(".ev-menu-item")].map((i) => `${i.textContent.trim()}${i.hasAttribute("data-disabled") ? "(off)" : ""}${i.hasAttribute("data-highlighted") ? "*" : ""}`) : null,
    focus: a?.classList.contains("ev-menu-item") ? a.textContent.trim() : a === t ? "trigger" : a?.tagName,
    expanded: t?.getAttribute("aria-expanded"),
    roles: m ? [m.getAttribute("role"), m.querySelector(".ev-menu-item")?.getAttribute("role"), m.querySelector(".ev-menu-sep")?.getAttribute("role")] : null,
  };
});
const focusTrigger = (p) => p.evaluate(() => document.querySelector(".ev-kebab").focus());

await check("menu: click opens", JV, "/personas", async (p) => { await p.click(".ev-kebab"); await p.waitForTimeout(400); return menuState(p); });
await check("menu: click again closes", JV, "/personas", async (p) => { await p.click(".ev-kebab"); await p.waitForTimeout(400); await p.click(".ev-kebab", { force: true }); await p.waitForTimeout(400); return menuState(p); });
await check("menu: Esc closes, focus back on the trigger", JV, "/personas", async (p) => { await p.click(".ev-kebab"); await p.waitForTimeout(400); await p.keyboard.press("Escape"); await p.waitForTimeout(400); return menuState(p); });
await check("menu: outside click closes", JV, "/personas", async (p) => { await p.click(".ev-kebab"); await p.waitForTimeout(400); await p.mouse.click(300, 600); await p.waitForTimeout(400); const s = await menuState(p); return { open: s.open, expanded: s.expanded }; });
await check("menu: hover highlights", JV, "/personas", async (p) => { await p.click(".ev-kebab"); await p.waitForTimeout(400); await p.hover(".ev-menu .ev-menu-item:nth-child(2)"); await p.waitForTimeout(200); return menuState(p); });
await check("menu: ↓ on the trigger opens on the first item", JV, "/personas", async (p) => { await focusTrigger(p); await p.keyboard.press("ArrowDown"); await p.waitForTimeout(400); return menuState(p); });
await check("menu: Enter on the trigger opens on the first item", JV, "/personas", async (p) => { await focusTrigger(p); await p.keyboard.press("Enter"); await p.waitForTimeout(400); return menuState(p); });
await check("menu: ↑ on the trigger opens on the last item", JV, "/personas", async (p) => { await focusTrigger(p); await p.keyboard.press("ArrowUp"); await p.waitForTimeout(400); return menuState(p); });
await check("menu: ↓↓↓ then ↑", JV, "/personas", async (p) => { await focusTrigger(p); await p.keyboard.press("ArrowDown"); await p.waitForTimeout(300); for (const k of ["ArrowDown", "ArrowDown", "ArrowDown", "ArrowUp"]) await p.keyboard.press(k); await p.waitForTimeout(200); return menuState(p); });
await check("menu: End / Home", JV, "/personas", async (p) => { await focusTrigger(p); await p.keyboard.press("ArrowDown"); await p.waitForTimeout(300); await p.keyboard.press("End"); const end = (await menuState(p)).focus; await p.keyboard.press("Home"); return { end, ...(await menuState(p)) }; });
await check("menu: typing 'm' moves to Merge", JV, "/personas", async (p) => { await focusTrigger(p); await p.keyboard.press("ArrowDown"); await p.waitForTimeout(300); await p.keyboard.type("m"); await p.waitForTimeout(200); return menuState(p); });
await check("menu: Tab stays in the menu", JV, "/personas", async (p) => { await focusTrigger(p); await p.keyboard.press("ArrowDown"); await p.waitForTimeout(300); await p.keyboard.press("Tab"); await p.waitForTimeout(200); return menuState(p); });
await check("menu: Enter on Rename opens its prompt", JV, "/personas", async (p) => {
  await focusTrigger(p); await p.keyboard.press("ArrowDown"); await p.waitForTimeout(300);
  await p.keyboard.press("ArrowDown"); await p.keyboard.press("Enter"); await p.waitForTimeout(800);
  return p.evaluate(() => ({ menu: !!document.querySelector(".ev-menu"), modal: document.querySelector(".ui-modal__title")?.textContent.trim() ?? null, focus: document.activeElement?.tagName }));
});
await check("menu: click Edit opens the persona", JV, "/personas", async (p) => { await p.click(".ev-kebab"); await p.waitForTimeout(400); await p.locator(".ev-menu .ev-menu-item", { hasText: "Edit" }).click(); await p.waitForTimeout(800); return p.evaluate(() => ({ route: location.hash.replace(/persona_\w+/, "persona_ID"), menu: !!document.querySelector(".ev-menu") })); });

// the disabled item: StudioScript's Move up on the first row lives on a project's Script page; the
// Personas menu's Merge is off with fewer than two personas — here there are many, so the
// attribute check covers the shape
await check("menu: aria on trigger and list", JV, "/personas", async (p) => { await p.click(".ev-kebab"); await p.waitForTimeout(400); return p.evaluate(() => { const t = document.querySelector(".ev-kebab"); const m = document.querySelector(".ev-menu"); return { haspopup: t.getAttribute("aria-haspopup"), expanded: t.getAttribute("aria-expanded"), labelledBy: m.getAttribute("aria-labelledby") === t.id, state: t.getAttribute("data-state") }; }); });

// ── StatusSelect ──
const editMode = '[...document.querySelectorAll(".seg-toggle button")][0].click()';
const statusState = (p) => p.evaluate(() => {
  const m = document.querySelector(".status-menu");
  return {
    pill: document.querySelector(".status-pill .status-pill-label")?.textContent.trim(),
    open: !!m,
    opts: m ? [...m.querySelectorAll(".status-opt")].map((o) => `${o.textContent.trim()}${o.getAttribute("data-state") === "checked" ? "✓" : ""}${o.hasAttribute("data-highlighted") ? "*" : ""}`) : null,
  };
});
await check("status: click opens the list", JW, "/chapters/ch1", async (p) => { await p.click(".status-pill"); await p.waitForTimeout(500); return statusState(p); }, { prep: editMode });
await check("status: pick Draft", JW, "/chapters/ch1", async (p) => { await p.click(".status-pill"); await p.waitForTimeout(500); await p.locator(".status-menu .status-opt", { hasText: "Draft" }).click(); await p.waitForTimeout(500); return statusState(p); }, { prep: editMode });
await check("status: pick Done back", JW, "/chapters/ch1", async (p) => { await p.click(".status-pill"); await p.waitForTimeout(500); await p.locator(".status-menu .status-opt", { hasText: "Done" }).click(); await p.waitForTimeout(500); return statusState(p); }, { prep: editMode });
await check("status: Esc closes", JW, "/chapters/ch1", async (p) => { await p.click(".status-pill"); await p.waitForTimeout(500); await p.keyboard.press("Escape"); await p.waitForTimeout(400); return statusState(p); }, { prep: editMode });
await check("status: New status… opens its prompt", JW, "/chapters/ch1", async (p) => { await p.click(".status-pill"); await p.waitForTimeout(500); await p.locator(".status-menu .status-opt", { hasText: "New status" }).click(); await p.waitForTimeout(800); return p.evaluate(() => ({ modal: document.querySelector(".ui-modal__title")?.textContent.trim() ?? null, pill: document.querySelector(".status-pill .status-pill-label")?.textContent.trim() })); }, { prep: editMode });
await check("status: keyboard ↓ opens, ↓↓ Enter picks", JW, "/chapters/ch1", async (p) => {
  await p.evaluate(() => { const t = document.querySelector(".status-pill"); (t.matches("button") ? t : t.querySelector(".q-select__focus-target")).focus(); });
  await p.keyboard.press("ArrowDown"); await p.waitForTimeout(400);
  const opened = await statusState(p);
  await p.keyboard.press("ArrowDown"); await p.keyboard.press("ArrowDown"); await p.keyboard.press("Enter"); await p.waitForTimeout(500);
  return { opened, after: await statusState(p) };
}, { prep: editMode });

console.log(lines.join("\n"));
await browser.close();
