// SPDX-License-Identifier: MIT
// Slice 6's behaviour, on both builds: the segmented control (JustVoice's persona filters and kind),
// the tab strip (JustVoice's Settings), the slider (JustVoice's Generation settings and a persona
// knob), the colour picker (JustWrite's project colours) and the progress bar (docgen's
// dashboard) answer the same way. Lines marked EXPECTED are the differences the slice means.
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
  const out = [];
  for (const port of ports) {
    const p = await open(port, route, prep);
    try { out.push(JSON.stringify(await run(p))); } catch (e) { out.push(`THREW ${e.message.split("\n")[0]}`); }
    if (p.errors.length) out[out.length - 1] += ` ERRORS ${p.errors.join(" | ")}`;
    await p.close();
  }
  const same = out[0] === out[1];
  lines.push(`${name.padEnd(44)} ${same ? "SAME" : expected ? "DIFFERENT (EXPECTED)" : "DIFFERENT"}\n    base: ${out[0]}\n    new:  ${out[1]}`);
}
const JW = [8781, 8782];
const JV = [8783, 8784];
const DG = [8785, 8786];
const persona = "/personas/persona_391625bf20db492d9ffc22855d12eef8";
const tab = (t) => `[...document.querySelectorAll('.ui-tabstrip__tab')].find((b) => b.textContent.trim() === '${t}').click()`;

// ── segmented ──
const SEG = ".ui-seg--small";
const segState = (p, i = 0) => p.evaluate((i) => {
  const seg = document.querySelectorAll(".ui-seg--small")[i];
  const bs = [...seg.querySelectorAll("button")];
  const a = document.activeElement;
  return {
    active: bs.filter((b) => b.classList.contains("active")).map((b) => b.querySelector("b")?.textContent.trim()),
    checked: bs.map((b) => b.getAttribute("aria-checked")),
    tabindex: bs.map((b) => b.getAttribute("tabindex")),
    focus: seg.contains(a) ? a.querySelector("b")?.textContent.trim() : a?.tagName,
    rows: document.querySelectorAll(".jv-table-look tbody tr, tbody tr").length,
  };
}, i);
await check("seg: roles + aria", JV, persona, (p) => p.evaluate(() => {
  const seg = document.querySelector(".ui-seg--small");
  return { role: seg.getAttribute("role"), label: seg.getAttribute("aria-label"), btn: [...seg.querySelectorAll("button")].map((b) => [b.getAttribute("role"), b.getAttribute("type"), b.getAttribute("aria-pressed"), b.getAttribute("aria-disabled"), b.title || null]) };
}));
await check("seg: click second", JV, persona, async (p) => { await p.locator(`${SEG} button`).nth(1).click(); await p.waitForTimeout(400); return segState(p); });
await check("seg: click the chosen one again", JV, persona, async (p) => { await p.locator(`${SEG} button`).nth(0).click(); await p.waitForTimeout(400); return segState(p); });
await check("seg: ArrowRight moves focus only", JV, persona, async (p) => {
  await p.evaluate(() => document.querySelector(".ui-seg--small button.active").focus());
  await p.keyboard.press("ArrowRight"); await p.waitForTimeout(200);
  return segState(p);
});
await check("seg: ArrowRight + Enter picks", JV, persona, async (p) => {
  await p.evaluate(() => document.querySelector(".ui-seg--small button.active").focus());
  await p.keyboard.press("ArrowRight"); await p.keyboard.press("Enter"); await p.waitForTimeout(400);
  return segState(p);
});
await check("seg: ArrowLeft wraps + Space picks", JV, persona, async (p) => {
  await p.evaluate(() => document.querySelector(".ui-seg--small button.active").focus());
  await p.keyboard.press("ArrowLeft"); await p.keyboard.press("Space"); await p.waitForTimeout(400);
  return segState(p);
});
await check("seg: End + Home", JV, persona, async (p) => {
  await p.evaluate(() => document.querySelector(".ui-seg--small button.active").focus());
  await p.keyboard.press("End"); const atEnd = (await segState(p)).focus;
  await p.keyboard.press("Home");
  return { atEnd, ...(await segState(p)) };
});
await check("seg: type-ahead picks + focuses", JV, persona, async (p) => {
  await p.evaluate(() => document.querySelector(".ui-seg--small button.active").focus());
  await p.keyboard.type("w"); await p.waitForTimeout(400);
  return segState(p);
});
await check("seg: Tab enters at the chosen one, leaves after", JV, persona, async (p) => {
  await p.locator(`${SEG} button`).nth(1).click(); await p.waitForTimeout(300);
  await p.evaluate(() => { const b = document.querySelector(".ui-seg--small button.active"); b.blur(); const prev = b.closest(".ui-seg--small").previousElementSibling; });
  await p.evaluate(() => document.querySelector(".ui-seg--small button.active").focus());
  await p.keyboard.press("Tab"); await p.waitForTimeout(150);
  const after = await p.evaluate(() => { const a = document.activeElement; return `${a.tagName}.${[...a.classList].slice(0, 2).join(".")}:${a.textContent.trim().slice(0, 20)}`; });
  await p.keyboard.press("Shift+Tab"); await p.waitForTimeout(150);
  return { after, back: (await segState(p)).focus };
});
await check("seg: off option + blocked", JV, persona, async (p) => {
  const kind = p.locator(".ui-seg--small").nth(1);
  const off = await kind.evaluate((s) => [...s.querySelectorAll("button")].map((b) => [b.querySelector("b")?.textContent.trim(), b.classList.contains("is-off"), b.getAttribute("aria-disabled"), b.title || null]));
  const idx = off.findIndex((o) => o[1]);
  if (idx >= 0) { await kind.locator("button").nth(idx).click(); await p.waitForTimeout(600); }
  return { off, after: await segState(p, 1), toast: await p.evaluate(() => [...document.querySelectorAll(".ui-toast, [data-sonner-toast], .q-notification")].map((t) => t.textContent.trim().slice(0, 80))) };
});

// ── tab strip ──
const stripState = (p) => p.evaluate(() => {
  const tabs = [...document.querySelectorAll(".ui-tabstrip__tab")];
  const a = document.activeElement;
  return {
    on: tabs.filter((t) => t.classList.contains("on")).map((t) => t.textContent.trim()),
    focus: a?.classList.contains("ui-tabstrip__tab") ? a.textContent.trim() : `${a?.tagName}.${[...(a?.classList || [])].slice(0, 2).join(".")}`,
    shown: [...document.querySelectorAll(".jv-section")].filter((s) => s.offsetParent).map((s) => s.querySelector("h2, h3, .jv-section__title, .setting-row__title")?.textContent.trim()).slice(0, 2),
  };
});
await check("tabs: click Generation", JV, "/settings", async (p) => { await p.evaluate(tab("Generation")); await p.waitForTimeout(400); return stripState(p); });
await check("tabs: real click on Mastering", JV, "/settings", async (p) => { await p.locator(".ui-tabstrip__tab", { hasText: "Mastering" }).click(); await p.waitForTimeout(400); return stripState(p); });
await check("tabs: focus a tab + Enter picks it", JV, "/settings", async (p) => {
  await p.evaluate(() => [...document.querySelectorAll(".ui-tabstrip__tab")].find((b) => b.textContent.trim() === "Backups").focus());
  await p.keyboard.press("Enter"); await p.waitForTimeout(400);
  return stripState(p);
});
await check("tabs: focus a tab + Space picks it", JV, "/settings", async (p) => {
  await p.evaluate(() => [...document.querySelectorAll(".ui-tabstrip__tab")].find((b) => b.textContent.trim() === "Sync").focus());
  await p.keyboard.press("Space"); await p.waitForTimeout(400);
  return stripState(p);
});
await check("tabs: ArrowRight on the active tab", JV, "/settings", async (p) => {
  await p.evaluate(() => document.querySelector(".ui-tabstrip__tab.on").focus());
  await p.keyboard.press("ArrowRight"); await p.waitForTimeout(200);
  return stripState(p);
}, { expected: true });
await check("tabs: Tab from the active tab", JV, "/settings", async (p) => {
  await p.evaluate(() => document.querySelector(".ui-tabstrip__tab.on").focus());
  await p.keyboard.press("Tab"); await p.waitForTimeout(200);
  return stripState(p);
}, { expected: true });
await check("tabs: roles", JV, "/settings", (p) => p.evaluate(() => {
  const s = document.querySelector(".ui-tabstrip");
  const t = document.querySelector(".ui-tabstrip__tab.on");
  return { strip: [s.tagName, s.getAttribute("role"), s.getAttribute("aria-label")], tab: [t.tagName, t.getAttribute("role"), t.getAttribute("aria-selected"), t.getAttribute("aria-current")] };
}), { expected: true });
await check("tabs: docgen's strip, click Server", DG, "/settings", async (p) => { await p.locator(".ui-tabstrip__tab", { hasText: "Server" }).first().click(); await p.waitForTimeout(500); return p.evaluate(() => ({ hash: location.hash, on: [...document.querySelectorAll(".ui-tabstrip__tab.on")].map((t) => t.textContent.trim()) })); });

// ── slider ──
const genPrep = tab("Generation");
const sliderState = (p) => p.evaluate(() => {
  const row = document.querySelector(".setting-row:has(.ui-slider)");
  const r = row.querySelector("input.ui-slider-range, .ui-slider-range [role=slider]");
  return { shown: row.querySelector(".setting-row__value")?.textContent.trim(), now: r.value ?? r.getAttribute("aria-valuenow"), text: r.getAttribute("aria-valuetext"), label: r.getAttribute("aria-label") };
});
const rangeBox = (p) => p.evaluate(() => { const el = document.querySelector(".setting-row:has(.ui-slider) .ui-slider-range"); const c = el.matches("input") ? el : el.querySelector(".q-slider__track-container"); c.scrollIntoView({ block: "center" }); const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
await check("slider: box + aria", JV, "/settings", async (p) => ({ box: await rangeBox(p), ...(await sliderState(p)) }), { prep: genPrep });
for (const f of [0.02, 0.25, 0.5, 0.9, 0.99]) {
  await check(`slider: click at ${f * 100}%`, JV, "/settings", async (p) => {
    const b = await rangeBox(p);
    await p.mouse.click(b.x + b.w * f, b.y + b.h / 2); await p.waitForTimeout(500);
    return sliderState(p);
  }, { prep: genPrep });
}
await check("slider: drag from 25% to 75%", JV, "/settings", async (p) => {
  const b = await rangeBox(p);
  await p.mouse.move(b.x + b.w * 0.25, b.y + 9); await p.mouse.down();
  await p.mouse.move(b.x + b.w * 0.5, b.y + 9, { steps: 5 });
  const mid = (await sliderState(p)).shown;
  await p.mouse.move(b.x + b.w * 0.75, b.y + 9, { steps: 5 }); await p.mouse.up(); await p.waitForTimeout(500);
  return { mid, ...(await sliderState(p)) };
}, { prep: genPrep });
await check("slider: keys → Right×3 Left PageUp", JV, "/settings", async (p) => {
  await p.evaluate(() => { const r = document.querySelector(".setting-row:has(.ui-slider) .ui-slider-range"); (r.matches("input") ? r : r.querySelector("[role=slider]")).focus(); });
  for (const k of ["ArrowRight", "ArrowRight", "ArrowRight", "ArrowLeft"]) await p.keyboard.press(k);
  const afterArrows = (await sliderState(p)).shown;
  await p.keyboard.press("PageUp"); await p.waitForTimeout(400);
  return { afterArrows, ...(await sliderState(p)) };
}, { prep: genPrep });
await check("slider: keys → Home, End", JV, "/settings", async (p) => {
  await p.evaluate(() => { const r = document.querySelector(".setting-row:has(.ui-slider) .ui-slider-range"); (r.matches("input") ? r : r.querySelector("[role=slider]")).focus(); });
  await p.keyboard.press("Home"); const home = (await sliderState(p)).shown;
  await p.keyboard.press("End"); await p.waitForTimeout(400);
  return { home, ...(await sliderState(p)) };
}, { prep: genPrep });
await check("slider: saved after a change (reload)", JV, "/settings", async (p) => {
  const b = await rangeBox(p);
  await p.mouse.click(b.x + b.w * 0.4, b.y + b.h / 2); await p.waitForTimeout(2500);
  await p.reload(); await p.waitForTimeout(4500); await p.evaluate(genPrep); await p.waitForTimeout(600);
  return sliderState(p);
}, { prep: genPrep });
const knob = (p) => p.evaluate(() => { const s = document.querySelector(".ui-slider"); const r = s.querySelector("input.ui-slider-range, .ui-slider-range [role=slider]"); return { now: r.value ?? r.getAttribute("aria-valuenow"), box: s.querySelector(".ui-slider-number input, .ui-slider-number")?.value ?? s.querySelector("input:not([type=range])")?.value }; });
await check("knob: type in the number box", JV, persona, async (p) => {
  const box = p.locator(".ui-slider").first().locator("input:not([type=range])");
  await box.click(); await box.fill("1.5"); await box.press("Enter"); await p.waitForTimeout(400);
  return knob(p);
});
await check("knob: arrows on the range", JV, persona, async (p) => {
  await p.evaluate(() => { const r = document.querySelector(".ui-slider .ui-slider-range"); (r.matches("input") ? r : r.querySelector("[role=slider]")).focus(); });
  await p.keyboard.press("ArrowRight"); await p.keyboard.press("ArrowRight"); await p.waitForTimeout(300);
  return knob(p);
});

// ── colour picker ──
const cpState = (p) => p.evaluate(() => {
  const sw = document.querySelector(".ui-color-swatch");
  const a = document.activeElement;
  return { open: !!document.querySelector(".ui-color-pop"), expanded: sw.getAttribute("aria-expanded"), bg: sw.style.background, focus: `${a?.tagName}.${[...(a?.classList || [])].slice(0, 2).join(".")}` };
});
await check("color: click opens", JW, "/settings", async (p) => { await p.click(".ui-color-swatch"); await p.waitForTimeout(400); return cpState(p); }, { expected: true });
await check("color: pick a preset", JW, "/settings", async (p) => { await p.click(".ui-color-swatch"); await p.waitForTimeout(400); await p.locator(".ui-color-pop .ui-color-preset").nth(4).click(); await p.waitForTimeout(500); return cpState(p); });
await check("color: Escape closes", JW, "/settings", async (p) => { await p.click(".ui-color-swatch"); await p.waitForTimeout(400); await p.keyboard.press("Escape"); await p.waitForTimeout(400); return cpState(p); });
await check("color: outside click closes", JW, "/settings", async (p) => { await p.click(".ui-color-swatch"); await p.waitForTimeout(400); await p.mouse.click(1300, 800); await p.waitForTimeout(400); const s = await cpState(p); return { open: s.open, expanded: s.expanded, bg: s.bg }; });
await check("color: swatch again closes", JW, "/settings", async (p) => { await p.click(".ui-color-swatch"); await p.waitForTimeout(400); await p.click(".ui-color-swatch", { force: true }); await p.waitForTimeout(400); const s = await cpState(p); return { open: s.open, expanded: s.expanded }; });
await check("color: keyboard Enter opens, Tab reaches presets", JW, "/settings", async (p) => {
  await p.evaluate(() => document.querySelector(".ui-color-swatch").focus());
  await p.keyboard.press("Enter"); await p.waitForTimeout(400);
  await p.keyboard.press("Tab"); await p.waitForTimeout(200);
  return p.evaluate(() => ({ open: !!document.querySelector(".ui-color-pop"), focus: document.activeElement?.className }));
}, { expected: true });
await check("color: popover under the swatch", JW, "/settings", async (p) => { await p.click(".ui-color-swatch"); await p.waitForTimeout(400); await p.mouse.move(10, 10); await p.waitForTimeout(300); return p.evaluate(() => { const s = document.querySelector(".ui-color-swatch").getBoundingClientRect(); const r = document.querySelector(".ui-color-pop").getBoundingClientRect(); return { dx: Math.round(r.x - s.x), dy: Math.round(r.y - s.bottom), w: r.width, h: r.height }; }); });

// ── progress ──
await check("progress: aria + fill", DG, "/", (p) => p.evaluate(() => {
  const t = document.querySelector(".ui-progress [role=progressbar]");
  const fill = t.querySelector(".ui-progress-fill, .q-linear-progress__model");
  const tr = t.getBoundingClientRect(); const fr = fill.getBoundingClientRect();
  return { min: t.getAttribute("aria-valuemin"), max: t.getAttribute("aria-valuemax"), now: t.getAttribute("aria-valuenow"), label: t.getAttribute("aria-label"), filled: Math.round((fr.width / tr.width) * 100) };
}));

console.log(lines.join("\n"));
await browser.close();
