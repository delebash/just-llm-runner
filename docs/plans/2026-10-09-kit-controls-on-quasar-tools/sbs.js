// Put <name>.base.png and <name>.new.png side by side (base left), scaled: node sbs.js <dir> <name> [scale]
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const { PNG } = await import(pathToFileURL("E:/Dev/Web/JustVioce/node_modules/pngjs/lib/png.js").href);
const [dir, name, s = "2"] = process.argv.slice(2);
const S = Number(s);
const a = PNG.sync.read(readFileSync(`${dir}/${name}.base.png`));
const b = PNG.sync.read(readFileSync(`${dir}/${name}.new.png`));
const W = Math.max(a.width, b.width), H = Math.max(a.height, b.height);
const o = new PNG({ width: (W * 2 + 4) * S, height: H * S });
o.data.fill(255);
for (const [k, src] of [[0, a], [1, b]]) for (let y = 0; y < src.height * S; y++) for (let x = 0; x < src.width * S; x++) {
  const si = (Math.floor(y / S) * src.width + Math.floor(x / S)) * 4, di = (y * o.width + x + k * (W + 4) * S) * 4;
  for (let c = 0; c < 4; c++) o.data[di + c] = src.data[si + c];
}
writeFileSync(`${dir}/${name}.sbs.png`, PNG.sync.write(o));
