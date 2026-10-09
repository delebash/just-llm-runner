// Slice 7's behaviour, on both builds: the modal (JustWrite's Critique: Esc, ✕, the backdrop, the
// focus trap, the drag, the close timing), the prompt and confirm dialogs (JustWrite's New part,
// Clear…), the feature chip's popover inside the modal, the help drawer, and the toasts (timing,
// hover pause, ✕, the action, at most three). Lines marked EXPECTED are the differences the
// slice means.
import { chromium } from "file:///E:/Dev/Web/justwrite-app/node_modules/playwright/index.mjs";

const browser = await chromium.launch();
async function open(port, route, prep) {
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  p.errors = [];
  p.on("pageerror", (e) => p.errors.push(e.message));
  await p.addInitScript(() => { window.__JW_BENCH__ = true; });
  await p.goto(`http://127.0.0.1:${port}/#${route}`);
  await p.waitForTimeout(4500);
  if (prep) { await p.evaluate(prep); await p.waitForTimeout(700); }
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
const later = (js, ms = 400) => `new Promise((r) => setTimeout(() => { ${js}; r(); }, ${ms}))`;
const critique = `[...document.querySelectorAll(".seg-toggle button")][0].click(); ${later(`[...document.querySelectorAll("button")].find((b) => /^Critique/.test(b.textContent.trim())).click()`)}`;
const outline = `[...document.querySelectorAll(".seg-toggle button")][1].click()`;
const addPart = `${outline}; ${later(`document.querySelector(".ol-add-part").click()`)}`;
const modalState = (p) => p.evaluate(() => {
  const m = document.querySelector(".ui-modal");
  const a = document.activeElement;
  return { open: !!m, title: m?.querySelector(".ui-modal__title")?.textContent.trim() ?? null, focusInside: !!(m && m.contains(a)) };
});

// ── the modal ──
await check("modal: Esc closes", JW, "/chapters/ch1", async (p) => { await p.keyboard.press("Escape"); await p.waitForTimeout(500); return modalState(p); }, { prep: critique });
await check("modal: ✕ closes", JW, "/chapters/ch1", async (p) => { await p.click(".ui-modal__close"); await p.waitForTimeout(500); return modalState(p); }, { prep: critique });
await check("modal: a backdrop click keeps it (locked; focus as opened)", JW, "/chapters/ch1", async (p) => { await p.mouse.click(40, 860); await p.waitForTimeout(500); return modalState(p); }, { prep: critique, expected: true });
await check("modal: still there 100ms into closing, gone at 300ms", JW, "/chapters/ch1", async (p) => {
  await p.keyboard.press("Escape"); await p.waitForTimeout(100);
  const mid = (await modalState(p)).open;
  await p.waitForTimeout(250);
  return { mid, after: (await modalState(p)).open };
}, { prep: critique });
await check("modal: Tab stays inside (12 presses)", JW, "/chapters/ch1", async (p) => {
  const seen = [];
  for (let i = 0; i < 12; i++) { await p.keyboard.press("Tab"); await p.waitForTimeout(150); seen.push(await p.evaluate(() => !!document.querySelector(".ui-modal")?.contains(document.activeElement))); }
  return seen;
}, { prep: critique });
await check("modal: focus on open", JW, "/chapters/ch1", (p) => p.evaluate(() => { const a = document.activeElement; return `${a.tagName}.${[...a.classList].slice(0, 2).join(".")}`; }), { prep: critique, expected: true });
await check("modal: drag the header 200px right, 100px down", JW, "/chapters/ch1", async (p) => {
  const r0 = await p.evaluate(() => { const r = document.querySelector(".ui-modal").getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) }; });
  await p.mouse.move(r0.x + 60, r0.y + 30); await p.mouse.down();
  await p.mouse.move(r0.x + 160, r0.y + 80, { steps: 4 }); await p.mouse.move(r0.x + 260, r0.y + 130, { steps: 4 }); await p.mouse.up();
  await p.waitForTimeout(200);
  return p.evaluate((r0) => { const m = document.querySelector(".ui-modal"); const r = m.getBoundingClientRect(); return { dx: Math.round(r.x) - r0.x, dy: Math.round(r.y) - r0.y, dragged: m.classList.contains("is-dragged") }; }, r0);
}, { prep: critique });
await check("modal: the page behind takes no click", JW, "/chapters/ch1", (p) => p.evaluate(() => { const el = document.elementFromPoint(40, 860); return !!el?.closest(".ui-modal-overlay, [data-reka-dialog-overlay], .ui-modal-overlay *") || el?.className?.toString().includes("overlay") || el?.className?.toString().includes("backdrop"); }), { prep: critique });
await check("modal: aria (aria-modal is new)", JW, "/chapters/ch1", (p) => p.evaluate(() => {
  const d = document.querySelector("[role=dialog]");
  const lb = d?.getAttribute("aria-labelledby");
  return { modal: d?.getAttribute("aria-modal") ?? null, name: lb ? document.getElementById(lb)?.textContent.trim().replace(/\s+/g, " ") : d?.getAttribute("aria-label") };
}), { prep: critique, expected: true });

// ── the chip popover inside the modal ──
await check("chip in modal: opens and stays", JW, "/chapters/ch1", async (p) => {
  await p.click(".ui-modal .afc-chip"); await p.waitForTimeout(800);
  return { ...(await p.evaluate(() => ({ pop: !!document.querySelector(".afc-pop"), head: document.querySelector(".afc-pop-h")?.textContent.trim() }))), modal: (await modalState(p)).open };
}, { prep: critique });
await check("chip in modal: its Thinking field takes focus + a change", JW, "/chapters/ch1", async (p) => {
  await p.click(".ui-modal .afc-chip"); await p.waitForTimeout(800);
  await p.focus(".afc-pop-sel"); await p.keyboard.press("ArrowDown"); await p.waitForTimeout(300);
  return p.evaluate(() => ({ pop: !!document.querySelector(".afc-pop"), focusInPop: !!document.querySelector(".afc-pop")?.contains(document.activeElement), value: document.querySelector(".afc-pop-sel")?.value }));
}, { prep: critique, expected: true });
await check("chip in modal: Esc closes the popover only", JW, "/chapters/ch1", async (p) => {
  await p.click(".ui-modal .afc-chip"); await p.waitForTimeout(800);
  await p.focus(".afc-pop-sel"); await p.keyboard.press("Escape"); await p.waitForTimeout(500);
  return { pop: await p.evaluate(() => !!document.querySelector(".afc-pop")), modal: (await modalState(p)).open };
}, { prep: critique, expected: true });
await check("chip in modal: Cancel closes the popover only", JW, "/chapters/ch1", async (p) => {
  await p.click(".ui-modal .afc-chip"); await p.waitForTimeout(800);
  await p.locator(".afc-pop button", { hasText: "Cancel" }).click(); await p.waitForTimeout(500);
  return { pop: await p.evaluate(() => !!document.querySelector(".afc-pop")), modal: (await modalState(p)).open };
}, { prep: critique });

// ── the prompt / confirm dialogs ──
const dialogState = (p) => p.evaluate(() => {
  const m = document.querySelector(".ui-modal");
  const a = document.activeElement;
  const btns = m ? [...m.querySelectorAll(".ui-modal__footer button")].map((b) => [b.textContent.trim(), b.disabled]) : null;
  return { open: !!m, focus: a?.tagName === "INPUT" ? `input:${a.value}|${a.selectionStart}-${a.selectionEnd}` : a?.tagName, btns, parts: document.querySelectorAll(".ol-part, .ol-part-title, [data-part-id]").length };
});
await check("prompt: opens with the field focused", JW, "/chapters/ch1", (p) => dialogState(p), { prep: addPart });
await check("prompt: typing enables Create", JW, "/chapters/ch1", async (p) => { await p.keyboard.type("Part Two"); await p.waitForTimeout(200); return dialogState(p); }, { prep: addPart });
await check("prompt: Esc cancels", JW, "/chapters/ch1", async (p) => { await p.keyboard.type("Part Two"); await p.keyboard.press("Escape"); await p.waitForTimeout(500); return dialogState(p); }, { prep: addPart });
await check("prompt: a backdrop click cancels (dismissable)", JW, "/chapters/ch1", async (p) => { await p.mouse.click(40, 860); await p.waitForTimeout(500); return dialogState(p); }, { prep: addPart });
await check("prompt: Enter submits", JW, "/chapters/ch1", async (p) => { await p.keyboard.type("Part Two"); await p.keyboard.press("Enter"); await p.waitForTimeout(800); return { ...(await dialogState(p)), hasPart: await p.evaluate(() => document.body.textContent.includes("Part Two")) }; }, { prep: addPart });
await check("prompt: focus back on the opener after cancel", JW, "/chapters/ch1", async (p) => {
  await p.keyboard.press("Escape"); await p.waitForTimeout(500);
  return p.evaluate(() => { const a = document.activeElement; return `${a.tagName}.${[...a.classList].slice(0, 2).join(".")}`; });
}, { prep: addPart });
const clearPrep = `[...document.querySelectorAll(".ui-tabstrip__tab")].find((b) => b.textContent.trim() === "Storage").click(); ${later(`[...document.querySelectorAll("button")].find((b) => /^Clear/.test(b.textContent.trim())).click()`)}`;
await check("confirm: Cancel resolves and closes", JW, "/settings", async (p) => { await p.locator(".ui-modal__footer button", { hasText: "Cancel" }).click(); await p.waitForTimeout(500); return dialogState(p); }, { prep: clearPrep });
await check("confirm: Esc closes", JW, "/settings", async (p) => { await p.keyboard.press("Escape"); await p.waitForTimeout(500); return dialogState(p); }, { prep: clearPrep });

// ── the help drawer ──
const helpState = (p) => p.evaluate(() => ({ open: !!document.querySelector(".help-drawer"), title: document.querySelector(".help-drawer-title")?.textContent.trim() ?? null }));
await check("help: opens on its trigger", JW, "/settings", async (p) => { await p.click(".help-trigger"); await p.waitForTimeout(500); return helpState(p); });
await check("help: Esc closes", JW, "/settings", async (p) => { await p.click(".help-trigger"); await p.waitForTimeout(500); await p.keyboard.press("Escape"); await p.waitForTimeout(500); return helpState(p); });
await check("help: a click outside closes", JW, "/settings", async (p) => { await p.click(".help-trigger"); await p.waitForTimeout(500); await p.mouse.click(300, 500); await p.waitForTimeout(500); return helpState(p); });
await check("help: ✕ closes", JW, "/settings", async (p) => { await p.click(".help-trigger"); await p.waitForTimeout(500); await p.click(".help-drawer-close"); await p.waitForTimeout(500); return helpState(p); });

// ── toasts ──
const ui = "document.querySelector('#q-app').__vue_app__.config.globalProperties.$pinia._s.get('ui')";
const toasts = (p) => p.evaluate(() => [...document.querySelectorAll(".ui-toast, [data-sonner-toast]")]
  .filter((t) => !t.matches("[data-sonner-toast][data-visible='false'], [data-removed='true']") && getComputedStyle(t).opacity !== "0")
  .map((t) => t.querySelector(".q-notification__message, [data-title]")?.textContent.trim()));
await check("toast: shows, gone after its time", JW, "/settings", async (p) => {
  await p.evaluate((ui) => eval(ui).showToast({ message: "Quick one" }, 1500), ui);
  await p.waitForTimeout(800); const during = await toasts(p);
  await p.waitForTimeout(1800); return { during, after: await toasts(p) };
});
await check("toast: hovered, it stays past its time", JW, "/settings", async (p) => {
  await p.evaluate((ui) => eval(ui).showToast({ message: "Hold me" }, 1500), ui);
  await p.waitForTimeout(600); await p.hover(".ui-toast, [data-sonner-toast]");
  await p.waitForTimeout(2500); const held = await toasts(p);
  await p.mouse.move(100, 100); await p.waitForTimeout(2500);
  return { held, after: await toasts(p) };
});
await check("toast: ✕ closes it", JW, "/settings", async (p) => {
  await p.evaluate((ui) => eval(ui).showToast({ message: "Close me" }, 60000), ui);
  await p.waitForTimeout(600); await p.click(".ui-toast__close, [data-close-button]"); await p.waitForTimeout(800);
  return toasts(p);
});
await check("toast: its action runs and closes it", JW, "/settings", async (p) => {
  await p.evaluate((ui) => { window.__undone = 0; eval(ui).showToast({ message: "Moved to trash", action: { label: "Undo", fn() { window.__undone++; } } }, 60000); }, ui);
  await p.waitForTimeout(600); await p.click(".ui-toast__action, [data-button]"); await p.waitForTimeout(800);
  return { undone: await p.evaluate(() => window.__undone), left: await toasts(p) };
});
await check("toast: five pushed, three up (the newest)", JW, "/settings", async (p) => {
  await p.evaluate((ui) => { for (const n of [1, 2, 3, 4, 5]) eval(ui).showToast({ message: `Toast ${n}` }, 60000); }, ui);
  await p.waitForTimeout(1000);
  return (await toasts(p)).sort();
}, { expected: false });
await check("toast: dismissToast clears them", JW, "/settings", async (p) => {
  await p.evaluate((ui) => { eval(ui).showToast({ message: "A" }, 60000); eval(ui).showToast({ message: "B" }, 60000); }, ui);
  await p.waitForTimeout(600); await p.evaluate((ui) => eval(ui).dismissToast(), ui); await p.waitForTimeout(800);
  return toasts(p);
});
await check("toast: role", JW, "/settings", async (p) => {
  await p.evaluate((ui) => eval(ui).showToast({ message: "Read me" }, 60000), ui);
  await p.waitForTimeout(600);
  return p.evaluate(() => { const t = document.querySelector(".ui-toast, [data-sonner-toast]"); return [t.getAttribute("role"), t.closest("[aria-live]")?.getAttribute("aria-live") ?? t.getAttribute("aria-live")]; });
}, { expected: true });

console.log(lines.join("\n"));
await browser.close();
