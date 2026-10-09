import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { webkit, type Browser } from "playwright";
import { buildHarness, serveHarness } from "./exo-ui/harness-server";

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
        await page.waitForFunction(
          () => {
            const canvases = [
              ...document.querySelectorAll<HTMLCanvasElement>(
                ".halo-ring__canvas",
              ),
            ];
            if (canvases.length !== 8) return false;
            return canvases.every((canvas) => {
              const ctx = canvas.getContext("2d");
              if (!ctx || canvas.width < 2) return false;
              const pixels = ctx.getImageData(
                0,
                0,
                canvas.width,
                canvas.height,
              ).data;
              for (
                let y = Math.floor(canvas.height * 0.3);
                y < canvas.height * 0.7;
                y += 4
              ) {
                for (
                  let x = Math.floor(canvas.width * 0.3);
                  x < canvas.width * 0.7;
                  x += 4
                ) {
                  if (pixels[(y * canvas.width + x) * 4 + 3] > 0) return true;
                }
              }
              return false;
            });
          },
          undefined,
          { timeout: 5_000 },
        );
        const center = await page
          .locator(".halo-ring__canvas")
          .nth(3)
          .evaluate((canvas) => {
            const element = canvas as HTMLCanvasElement;
            const context = element.getContext("2d");
            if (!context)
              throw new Error("Halo output canvas has no 2D context");
            return {
              size: element.width,
              color: [
                ...context
                  .getImageData(
                    Math.floor(element.width / 2),
                    Math.floor(element.height / 2),
                    1,
                    1,
                  )
                  .data.slice(0, 3),
              ],
            };
          });
        expect(center.size % 2).toBe(1);
        expect(center.color).toEqual(
          theme === "dark" ? [68, 59, 76] : [251, 248, 246],
        );
      } catch (caught) {
        const canvases = await page
          .locator(".halo-ring__canvas")
          .evaluateAll((items) =>
            items.map((item) => {
              const canvas = item as HTMLCanvasElement;
              const context = canvas.getContext("2d");
              let centerVisible = false;
              let cornerAlpha: number | null = null;
              if (context && canvas.width > 1 && canvas.height > 1) {
                const pixels = context.getImageData(
                  0,
                  0,
                  canvas.width,
                  canvas.height,
                ).data;
                for (
                  let y = Math.floor(canvas.height * 0.3);
                  y < canvas.height * 0.7 && !centerVisible;
                  y += 4
                ) {
                  for (
                    let x = Math.floor(canvas.width * 0.3);
                    x < canvas.width * 0.7;
                    x += 4
                  ) {
                    if (pixels[(y * canvas.width + x) * 4 + 3] > 0) {
                      centerVisible = true;
                      break;
                    }
                  }
                }
                cornerAlpha =
                  pixels[3] +
                  pixels[(canvas.width - 1) * 4 + 3] +
                  pixels[(canvas.height - 1) * canvas.width * 4 + 3] +
                  pixels[(canvas.height * canvas.width - 1) * 4 + 3];
              }
              return {
                width: canvas.width,
                height: canvas.height,
                has2dContext: context !== null,
                centerVisible,
                cornerAlpha,
              };
            }),
          );
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
