import { webkit } from "playwright";
import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { buildHarness, serveHarness } from "./exo-ui/harness-server";
const load = () => Number(execSync("sysctl -n vm.loadavg").toString().trim().replace(/[{}]/g, "").trim().split(/\s+/)[0]);
const gate = async () => { while (!process.env.NOGATE && load() > 100) { console.log("load", load(), "waiting"); await new Promise((r) => setTimeout(r, 60000)); } };
const N = Number(process.env.N ?? 60);
const VARIANTS = (process.env.VARIANTS ?? "base,B1,B2,B12,B3").split(",");
const out = "/tmp/tc876";
mkdirSync(out, { recursive: true });
await gate();
const server = serveHarness(await buildHarness());
const stats: Record<string, { loads: number; blankLoads: number; blankFinal: number; probeNotes: any[] }> = {};
for (const v of VARIANTS) stats[v] = { loads: 0, blankLoads: 0, blankFinal: 0, probeNotes: [] };
for (let i = 0; i < N; i++) {
  const browser = await webkit.launch({ headless: true });
  for (const variant of VARIANTS) {
    for (const theme of ["light", "dark"] as const) {
      await gate();
      const context = await browser.newContext({
        viewport: { width: 390, height: 4400 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
        colorScheme: theme, reducedMotion: "reduce",
      });
      const page = await context.newPage();
      await page.addInitScript((v) => { (window as any).__haloVariant = v; }, variant);
      await page.goto(`http://127.0.0.1:${server.port}/?screen=recorder-final-halo&theme=${theme}&platform=web&freeze=1`);
      await page.waitForFunction(() => (window as any).exoUi?.ready === true, undefined, { timeout: 30000 });
      const res = await page.evaluate(async () => {
        const r = (window as any).__halo;
        const entries = [...r.entries] as any[];
        const dom = [...document.querySelectorAll<HTMLCanvasElement>(".halo-ring__canvas")];
        const events: any[] = [];
        let everBlank = false;
        const t0 = performance.now();
        while (performance.now() - t0 < 1000) {
          const blanks: number[] = [];
          for (const e of entries) {
            if (e.lastDraw > 0 && e.canvas.width > 1) {
              const a = e.context.getImageData(e.pixelSize >> 1, e.pixelSize >> 1, 1, 1).data[3];
              if (a === 0) blanks.push(dom.indexOf(e.canvas));
            }
          }
          if (blanks.length) { everBlank = true; events.push([Math.round(performance.now() - t0), blanks]); }
          await new Promise((res) => setTimeout(res, 40));
        }
        const final = entries.map((e) => e.context.getImageData(e.pixelSize >> 1, e.pixelSize >> 1, 1, 1).data[3]);
        return { everBlank, events: events.slice(0, 40), final, log: (window as any).__hl ?? [] };
      });
      const s = stats[variant];
      s.loads++;
      const finalBlank = res.final.some((a: number) => a === 0);
      if (res.everBlank) s.blankLoads++;
      if (finalBlank) s.blankFinal++;
      if (res.everBlank || finalBlank) {
        console.log(`BLANK variant=${variant} iter=${i} theme=${theme} final=${res.final} events=${JSON.stringify(res.events.slice(0, 12))}`);
        if (variant === "base" && s.probeNotes.length < 3) {
          console.log("LOG " + JSON.stringify(res.log.slice(0, 80)));
          const probe = await page.evaluate(async () => {
            const r = (window as any).__halo; const gl = r.gl; const o: any = {};
            const entries = [...r.entries] as any[];
            const read = () => entries.map((e: any) => e.context.getImageData(e.pixelSize >> 1, e.pixelSize >> 1, 1, 1).data[3]);
            const variants: Record<string, { pre?: () => void; direct?: boolean; keep?: boolean }> = {
              baseline: {}, finish: { pre: () => gl.finish() },
              readpx: { pre: () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)) },
              direct: { direct: true }, keep: { keep: true },
            };
            const orig = r.flushBatch; o.initial = read();
            for (const [name, v] of Object.entries(variants)) {
              r.flushBatch = (now: number) => {
                if (r.batch.length === 0) return;
                v.pre?.();
                const bitmap = v.direct || r.path !== "webgl-atlas" ? null : r.canvas.transferToImageBitmap();
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
              o[name] = read();
            }
            r.flushBatch = orig;
            return o;
          });
          console.log("PROBE " + JSON.stringify(probe));
          s.probeNotes.push(1);
        }
        await page.screenshot({ path: `${out}/${variant}-${i}-${theme}.png` }).catch(() => {});
      }
      await context.close();
    }
  }
  await browser.close();
  if (i % 5 === 4) console.log("PROGRESS", i + 1, JSON.stringify(Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, `${v.blankLoads}/${v.blankFinal}/${v.loads}`]))));
}
console.log("SUMMARY (everBlank/finalBlank/loads)", JSON.stringify(Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, `${v.blankLoads}/${v.blankFinal}/${v.loads}`])), null, 1));
server.stop(true);
