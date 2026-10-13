// Compares two exo-ui capture runs (screenshots/exo-ui/<stamp>/), image by
// image: a pixel counts as changed when any channel moves by more than 8. Writes
// diff.json and, for each changed image, diff-<name>.png (changed pixels in red
// over a faded copy of the new capture). Needs only Playwright's Chromium.
//
//   bun exo-ui/diff.ts <before-dir> <after-dir> [out-dir]     (from test/)
//
// A screen counts as unchanged at 0.1% of its pixels or fewer.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { chromium } from "playwright";

const [beforeArg, afterArg, outArg] = process.argv.slice(2);
if (!beforeArg || !afterArg) {
  console.error("usage: bun exo-ui/diff.ts <before-dir> <after-dir> [out-dir]");
  process.exit(2);
}
const beforeDir = resolve(beforeArg);
const afterDir = resolve(afterArg);
const outDir = resolve(outArg ?? join(afterDir, "diff"));
mkdirSync(outDir, { recursive: true });

const UNCHANGED_AT_MOST = 0.001;
const pngs = (dir: string) => new Set(readdirSync(dir).filter((name) => name.endsWith(".png")));
const before = pngs(beforeDir);
const after = pngs(afterDir);

interface Result {
  file: string;
  status: "unchanged" | "changed" | "size-changed" | "added" | "removed";
  width?: number;
  height?: number;
  changedPixels?: number;
  ratio?: number;
}
const results: Result[] = [];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
for (const file of [...after].sort()) {
  if (!before.has(file)) {
    results.push({ file, status: "added" });
    continue;
  }
  const a = `data:image/png;base64,${readFileSync(join(beforeDir, file)).toString("base64")}`;
  const b = `data:image/png;base64,${readFileSync(join(afterDir, file)).toString("base64")}`;
  const diff = await page.evaluate(async ({ a, b }) => {
    const load = (src: string) =>
      new Promise<HTMLImageElement>((done, fail) => {
        const image = new Image();
        image.onload = () => done(image);
        image.onerror = () => fail(new Error("unreadable PNG"));
        image.src = src;
      });
    const [left, right] = await Promise.all([load(a), load(b)]);
    if (left.width !== right.width || left.height !== right.height) {
      return { width: right.width, height: right.height, sizeChanged: true, changed: right.width * right.height, image: null };
    }
    const pixels = (image: HTMLImageElement) => {
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, image.width, image.height);
    };
    const x = pixels(left);
    const y = pixels(right);
    const out = new ImageData(y.width, y.height);
    let changed = 0;
    for (let i = 0; i < y.data.length; i += 4) {
      const moved =
        Math.abs(x.data[i]! - y.data[i]!) > 8 ||
        Math.abs(x.data[i + 1]! - y.data[i + 1]!) > 8 ||
        Math.abs(x.data[i + 2]! - y.data[i + 2]!) > 8 ||
        Math.abs(x.data[i + 3]! - y.data[i + 3]!) > 8;
      if (moved) {
        changed++;
        out.data.set([220, 30, 50, 255], i);
      } else {
        out.data.set([y.data[i]!, y.data[i + 1]!, y.data[i + 2]!, 60], i);
      }
    }
    let image: string | null = null;
    if (changed > 0) {
      const canvas = document.createElement("canvas");
      canvas.width = y.width;
      canvas.height = y.height;
      canvas.getContext("2d")!.putImageData(out, 0, 0);
      image = canvas.toDataURL("image/png");
    }
    return { width: y.width, height: y.height, sizeChanged: false, changed, image };
  }, { a, b });
  const ratio = diff.changed / (diff.width * diff.height);
  const status = diff.sizeChanged ? "size-changed" : ratio <= UNCHANGED_AT_MOST ? "unchanged" : "changed";
  results.push({ file, status, width: diff.width, height: diff.height, changedPixels: diff.changed, ratio });
  if (diff.image && status !== "unchanged") {
    writeFileSync(join(outDir, `diff-${file}`), Buffer.from(diff.image.split(",")[1]!, "base64"));
  }
}
for (const file of before) if (!after.has(file)) results.push({ file, status: "removed" });
await browser.close();

writeFileSync(join(outDir, "diff.json"), JSON.stringify({ before: beforeDir, after: afterDir, unchangedAtMost: UNCHANGED_AT_MOST, results }, null, 2));
const counts = results.reduce<Record<string, number>>((tally, r) => ({ ...tally, [r.status]: (tally[r.status] ?? 0) + 1 }), {});
console.log(`exo-ui diff ${basename(beforeDir)} → ${basename(afterDir)}:`, counts);
for (const r of results.filter((r) => r.status !== "unchanged")) {
  console.log(`  ${r.status.padEnd(12)} ${r.file}${r.ratio === undefined ? "" : ` ${(r.ratio * 100).toFixed(2)}%`}`);
}
