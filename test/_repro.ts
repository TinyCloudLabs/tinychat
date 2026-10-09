import { webkit, chromium } from "playwright";
import { buildHarness, serveHarness } from "./exo-ui/harness-server";
import { execSync } from "node:child_process";
const load = () => Number(execSync("sysctl -n vm.loadavg").toString().trim().replace(/[{}]/g, "").trim().split(/\s+/)[0]);
const gate = async () => { while (load() > 100) { console.log("load", load(), "waiting"); await new Promise((r) => setTimeout(r, 60000)); } };
const N = Number(process.env.N ?? 30);
const engine = process.env.ENGINE === "chromium" ? chromium : webkit;
await gate();
const server = serveHarness(await buildHarness());
let browser = await engine.launch({ headless: true });
let fails = 0;
for (let i = 0; i < N; i++) {
  if (i % 10 === 0 && i) { await browser.close(); browser = await engine.launch({ headless: true }); }
  for (const theme of ["light", "dark"] as const) {
    await gate();
    const context = await browser.newContext({
      viewport: { width: 390, height: 4400 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
      colorScheme: theme, reducedMotion: "reduce",
    });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.port}/?screen=recorder-final-halo&theme=${theme}&platform=web&freeze=1`);
    await page.waitForFunction(() => (window as any).exoUi?.ready === true, undefined, { timeout: 20000 });
    await page.waitForTimeout(Number(process.env.SETTLE ?? 1500));
    const res = await page.evaluate(() => {
      const out: any[] = [];
      for (const c of document.querySelectorAll<HTMLCanvasElement>(".halo-ring__canvas")) {
        const d = c.getContext("2d")!.getImageData(c.width >> 1, c.height >> 1, 1, 1).data;
        out.push({ w: c.width, a: d[3] });
      }
      return { out, log: (window as any).__hl ?? [] };
    });
    const blank = res.out.filter((o) => o.a === 0);
    if (blank.length) {
      fails++; 
      const probe = await page.evaluate(async () => {
        const r = (window as any).__halo; const gl = r.gl; const out: any[] = [];
        const orig = r.flushBatch.bind(r);
        r.flushBatch = (now: number) => {
          const batch = [...r.batch];
          for (const e of r.batch) {
            const px = new Uint8Array(4);
            gl.readPixels(e.atlasX + (e.pixelSize >> 1), e.atlasY + (e.pixelSize >> 1), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
            out.push(["gl", e.pixelSize, e.atlasX, e.atlasY, Array.from(px)]);
          }
          orig(now);
          for (const e of batch) out.push(["after", e.pixelSize, Array.from(e.context.getImageData(e.pixelSize >> 1, e.pixelSize >> 1, 1, 1).data)]);
        };
        for (const e of r.entries) e.lastDraw = 0;
        r.frameLoop.start();
        await new Promise((res) => setTimeout(res, 400));
        return out;
      });
      console.log("PROBE", JSON.stringify(probe));
      console.log(`FAIL run ${i} ${theme}`, JSON.stringify(res.out));
      if (process.env.LOG) console.log("LOGSTART\n" + res.log.map((l: any) => JSON.stringify(l)).join("\n") + "\nLOGEND");
    } else if (i === 0 && theme === "light" && process.env.LOG) console.log("PASSLOG\n" + res.log.slice(0,60).map((l: any) => JSON.stringify(l)).join("\n"));
    await context.close();
    if (process.env.STOP && fails) break;
  }
  if (process.env.STOP && fails) break;
}
console.log(`${engine.name()} done: ${fails} failing page loads of ${N * 2}`);
await browser.close();
server.stop(true);
