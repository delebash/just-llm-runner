// Crop the same box out of <tag>.base.png and <tag>.new.png, scale it, and stack them (base on
// top) into <tag>.crop.png.   node crop.js <dir> <tag> x y w h [scale]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { PNG } = await import(pathToFileURL("E:/Dev/Web/JustVioce/node_modules/pngjs/lib/png.js").href);
const [dir, tag, x, y, w, h, s = "3"] = process.argv.slice(2);
const [X, Y, W, H, S] = [x, y, w, h, s].map(Number);
const out = new PNG({ width: W * S, height: H * S * 2 + S * 2 });
out.data.fill(255);
["base", "new"].forEach((label, k) => {
  const src = PNG.sync.read(readFileSync(join(dir, `${tag}.${label}.png`)));
  for (let j = 0; j < H * S; j++) {
    for (let i = 0; i < W * S; i++) {
      const si = ((Y + Math.floor(j / S)) * src.width + (X + Math.floor(i / S))) * 4;
      const di = ((j + k * (H * S + S * 2)) * out.width + i) * 4;
      for (let c = 0; c < 4; c++) out.data[di + c] = src.data[si + c];
    }
  }
});
writeFileSync(join(dir, `${tag}.crop.png`), PNG.sync.write(out));
