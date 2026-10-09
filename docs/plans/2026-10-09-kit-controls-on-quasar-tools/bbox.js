// The boxes of differing pixels in a diff map (red = differs), merged into regions.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const { PNG } = await import(pathToFileURL("E:/Dev/Web/JustVioce/node_modules/pngjs/lib/png.js").href);
for (const f of process.argv.slice(2)) {
  const p = PNG.sync.read(readFileSync(f));
  const pts = [];
  for (let y = 0; y < p.height; y++) for (let x = 0; x < p.width; x++) { const o = (y * p.width + x) * 4; if (p.data[o] === 255 && p.data[o + 1] === 0 && p.data[o + 2] === 0) pts.push([x, y]); }
  const boxes = [];
  for (const [x, y] of pts) {
    const b = boxes.find((b) => x >= b.x0 - 12 && x <= b.x1 + 12 && y >= b.y0 - 12 && y <= b.y1 + 12);
    if (b) { b.x0 = Math.min(b.x0, x); b.x1 = Math.max(b.x1, x); b.y0 = Math.min(b.y0, y); b.y1 = Math.max(b.y1, y); b.n++; } else boxes.push({ x0: x, x1: x, y0: y, y1: y, n: 1 });
  }
  console.log(f.split(/[\/]/).pop(), boxes.map((b) => `[${b.x0},${b.y0}-${b.x1},${b.y1} n=${b.n}]`).join(" "));
}
