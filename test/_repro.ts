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
    if (process.env.POLL) await page.addInitScript(() => {
      let last = "";
      const w = window as any;
      w.__poll = [];
      setInterval(() => {
        const cs = [...document.querySelectorAll<HTMLCanvasElement>(".halo-ring__canvas")];
        if (!cs.length) return;
        const a = cs.map((c) => (c.width > 1 ? c.getContext("2d")!.getImageData(c.width >> 1, c.height >> 1, 1, 1).data[3] : -1)).join(",");
        if (a !== last) { last = a; w.__poll.push([Math.round(performance.now()), a]); }
      }, 8);
    });
    await page.goto(`http://127.0.0.1:${server.port}/?screen=recorder-final-halo&theme=${theme}&platform=web&freeze=1`);
    await page.waitForFunction(() => (window as any).exoUi?.ready === true, undefined, { timeout: 20000 });
    await page.waitForTimeout(Number(process.env.SETTLE ?? 1500));
    const res = await page.evaluate(() => {
      const out: any[] = [];
      for (const c of document.querySelectorAll<HTMLCanvasElement>(".halo-ring__canvas")) {
        const d = c.getContext("2d")!.getImageData(c.width >> 1, c.height >> 1, 1, 1).data;
        out.push({ w: c.width, a: d[3] });
      }
      return { out, log: [...((window as any).__hl ?? []), ...((window as any).__poll ?? []).map((p: any) => ["POLL", ...p])].sort((x: any, y: any) => x[0] - y[0]) };
    });
    const blank = res.out.filter((o) => o.a === 0);
    if (blank.length) {
      fails++; 
      const probe = await page.evaluate(async () => {
        const r = (window as any).__halo; const gl = r.gl; const res: any = {};
        const entries = [...r.entries];
        const read = () => entries.map((e: any) => e.context.getImageData(e.pixelSize >> 1, e.pixelSize >> 1, 1, 1).data[3]);
        const variants: Record<string, { pre?: () => void; direct?: boolean; keep?: boolean }> = {
          baseline: {},
          finish: { pre: () => gl.finish() },
          readpx: { pre: () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)) },
          direct: { direct: true },
          keep: { keep: true },
        };
        const orig = r.flushBatch;
        res.initial = read();
        for (const [name, v] of Object.entries(variants)) {
          r.flushBatch = (now: number) => {
            if (r.batch.length === 0) return;
            v.pre?.();
            const bitmap = v.direct ? null : r.canvas.transferToImageBitmap();
            const src = bitmap ?? r.canvas;
            for (const e of r.batch) {
              e.context.clearRect(0, 0, e.pixelSize, e.pixelSize);
              e.context.drawImage(src, e.atlasX, 1024 - e.atlasY - e.pixelSize, e.pixelSize, e.pixelSize, 0, 0, e.pixelSize, e.pixelSize);
              e.lastDraw = now;
            }
            if (!v.keep) bitmap?.close();
            r.batch.length = 0;
          };
          for (const e of entries) { e.context.clearRect(0, 0, e.pixelSize, e.pixelSize); e.lastDraw = 0; }
          r.frameLoop.start();
          await new Promise((res2) => setTimeout(res2, 500));
          res[name] = read();
        }
        r.flushBatch = orig;
        return res;
      });
      console.log("PROBE", JSON.stringify(probe));
      console.log(`FAIL run ${i} ${theme}`, JSON.stringify(res.out));
      if (process.env.LOG) console.log("LOGSTART\n" + res.log.map((l: any) => JSON.stringify(l)).join("\n") + "\nLOGEND");
    } else if (i === 0 && theme === "light" && process.env.LOG) console.log("PASSLOG\n" + res.log.filter((l: any) => l[1] !== "resize-clear" && l[1] !== "RO" && l[1] !== "IO").map((l: any) => JSON.stringify(l)).join("\n"));
    await context.close();
    if (process.env.STOP && fails) break;
  }
  if (process.env.STOP && fails) break;
}
console.log(`${engine.name()} done: ${fails} failing page loads of ${N * 2}`);
await browser.close();
server.stop(true);
