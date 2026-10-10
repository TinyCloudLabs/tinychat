import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { webkit, type Browser } from "playwright";
import { buildHarness, serveHarness } from "./exo-ui/harness-server";
import { inspectHaloPixels, readHaloCenterPixel } from "./exo-ui/halo-pixels";

declare global {
  interface Window {
    exoUi?: { ready: boolean };
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
