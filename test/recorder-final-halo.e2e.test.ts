import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { webkit, type Browser } from "playwright";
import { buildHarness, serveHarness } from "./exo-ui/harness-server";
import { inspectHaloPixels, readHaloCenterPixel } from "./exo-ui/halo-pixels";

declare global {
  interface Window {
    exoUi?: { ready: boolean };
    haloStall?: { done: boolean };
  }
}

const output = new URL("../screenshots/recorder-halo/", import.meta.url)
  .pathname;
let server: ReturnType<typeof serveHarness> | undefined;
let browser: Browser | undefined;

beforeAll(async () => {
  mkdirSync(output, { recursive: true });
  server = serveHarness(await buildHarness());
  browser = await webkit.launch({ headless: true });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

test("recorder-final halo renders its centre pixel in WebKit", async () => {
  for (const theme of ["light", "dark"] as const) {
    const context = await browser!.newContext({
      viewport: { width: 390, height: 4400 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      colorScheme: theme,
      reducedMotion: "reduce",
    });
    try {
      const page = await context.newPage();
      const rendererPaths: string[] = [];
      page.on("console", (message) => {
        if (
          message.type() === "info" &&
          message.text().includes("[HaloRing] renderer:")
        ) {
          rendererPaths.push(message.text());
        }
      });
      try {
        await page.goto(
          `http://127.0.0.1:${server!.port}/?screen=recorder-final-halo&theme=${theme}&platform=web&freeze=1`,
        );
        await page.waitForFunction(
          () => window.exoUi?.ready === true,
          undefined,
          { timeout: 20_000 },
        );
        await page.waitForFunction(inspectHaloPixels, {}, { timeout: 5_000 });
        const center = await page
          .locator(".halo-ring__canvas")
          .nth(3)
          .evaluate(readHaloCenterPixel);
        expect(center.size % 2).toBe(1);
        expect(center.color).toEqual(
          theme === "dark" ? [68, 59, 76] : [251, 248, 246],
        );
      } catch (caught) {
        const { canvases } = (await page.evaluate(inspectHaloPixels, {
          diagnostics: true,
        })) as { canvases: unknown[] };
        const diagnostic = {
          error: String(caught),
          rendererPaths,
          canvasCount: canvases.length,
          canvases,
        };
        console.error("Halo centre pixel check failed", diagnostic);
        await page
          .screenshot({
            path: `${output}halo-${theme}-failure.png`,
            fullPage: false,
          })
          .catch(() => {});
        throw new Error(
          `Halo centre pixel check failed: ${JSON.stringify(diagnostic)}`,
          { cause: caught },
        );
      }
      await page.screenshot({
        path: `${output}halo-${theme}.png`,
        fullPage: false,
      });
      await page.close();
    } finally {
      await context.close();
    }
  }
}, 60_000);

const loads = Number(process.env.HALO_LOADS ?? 2);
const stallMs = Number(process.env.HALO_STALL ?? 800);
const reportOnly = process.env.HALO_REPORT === "1";

interface BlankEpisode {
  ring: number;
  startFrame: number;
  frames: number;
  ms: number;
}

// Samples every ring's centre on each animation frame after the injected stall
// (every ring has been drawn by then) and records each run of transparent
// frames as an episode.
async function blankEpisodesAfterStall(theme: "light" | "dark") {
  const context = await browser!.newContext({
    viewport: { width: 390, height: 4400 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  try {
    const page = await context.newPage();
    await page.goto(
      `http://127.0.0.1:${server!.port}/?screen=recorder-final-halo&theme=${theme}&platform=web&freeze=1&haloStall=${stallMs}`,
    );
    await page.waitForFunction(
      () => window.haloStall?.done === true,
      undefined,
      { timeout: 60_000 },
    );
    return await page.evaluate(
      () =>
        new Promise<{ canvases: number; episodes: BlankEpisode[] }>(
          (resolve) => {
            const canvases = [
              ...document.querySelectorAll<HTMLCanvasElement>(
                ".halo-ring__canvas",
              ),
            ];
            const open = new Map<number, BlankEpisode & { t0: number }>();
            const episodes: BlankEpisode[] = [];
            let frame = 0;
            const close = (ring: number, now: number) => {
              const episode = open.get(ring);
              if (!episode) return;
              open.delete(ring);
              episodes.push({
                ring,
                startFrame: episode.startFrame,
                frames: episode.frames,
                ms: Math.round(now - episode.t0),
              });
            };
            const sample = (now: number) => {
              canvases.forEach((canvas, ring) => {
                const context = canvas.getContext("2d");
                const blank =
                  !context ||
                  canvas.width < 2 ||
                  context.getImageData(
                    canvas.width >> 1,
                    canvas.height >> 1,
                    1,
                    1,
                  ).data[3] === 0;
                const episode = open.get(ring);
                if (blank && episode) episode.frames++;
                else if (blank)
                  open.set(ring, {
                    ring,
                    startFrame: frame,
                    frames: 1,
                    ms: 0,
                    t0: now,
                  });
                else close(ring, now);
              });
              if (++frame < 40) requestAnimationFrame(sample);
              else {
                for (const ring of [...open.keys()]) close(ring, now);
                resolve({ canvases: canvases.length, episodes });
              }
            };
            requestAnimationFrame(sample);
          },
        ),
    );
  } finally {
    await context.close();
  }
}

test(
  "recorder-final halo rings stay painted after the main thread stalls",
  async () => {
    const blank: string[] = [];
    for (let load = 0; load < loads; load++) {
      if (load > 0 && load % 10 === 0) {
        await browser?.close();
        browser = await webkit.launch({ headless: true });
      }
      const { canvases, episodes } = await blankEpisodesAfterStall(
        load % 2 === 0 ? "light" : "dark",
      );
      expect(canvases).toBe(8);
      for (const episode of episodes) {
        blank.push(
          `load ${load}: ring ${episode.ring} blank from frame ${episode.startFrame} for ${episode.frames} frames / ${episode.ms} ms`,
        );
      }
    }
    const blankLoads = new Set(blank.map((line) => line.split(":")[0])).size;
    console.log(
      `HALO_STALL_RESULT blankLoads=${blankLoads}/${loads} episodes=${blank.length} stall=${stallMs}ms`,
    );
    for (const line of blank) console.log(`HALO_STALL_EPISODE ${line}`);
    if (!reportOnly) expect(blank).toEqual([]);
  },
  Math.max(1, loads) * 40_000,
);
