import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, webkit, type Browser, type BrowserType } from "playwright";
import { buildHarness, serveHarness, type HarnessAssets } from "./exo-ui/harness-server";

const WIDTHS = [320, 375, 390, 402, 430];
const SCREENS = [
  ["shell-capture", "ios"],
  ["shell-chat", "ios"],
  ["shell-chat-ribbon", "ios"],
  ["shell-chat-keyboard", "ios"],
  ["shell-model-sheet", "ios"],
  ["shell-connectors", "ios"],
  ["shell-settings", "ios"],
  ["shell-settings-android", "android"],
  ["shell-settings-scrolled", "ios"],
  ["shell-about", "ios"],
  ["shell-boot-signed-out", "ios"],
  ["mic-recovery-sign-in", "android"],
  ["recorder-final-phone-interactive-consented", "ios"],
  ["recorder-final-phone-interactive-first-run", "ios"],
  ["recorder-final-phone-interactive-route-control", "ios"],
  ["recorder-final-phone-interactive-notes", "ios"],
  ["library-all", "ios"],
  ["note-voice-transcribed", "ios"],
  ["saved-note-sheet", "ios"],
  ["saved-note-sheet-long-title", "ios"],
  ["saved-note-sheet-editing", "ios"],
  ["capture-soft-long-titles", "ios"],
  ["pipeline-wire-sheet-done", "ios"],
  ["local-signed-out", "android"],
  ["local-offline", "android"],
] as const;
const knownScreens = new Set(SCREENS.map(([screen]) => screen));
const WEBKIT_SCREEN_BATCHES = [
  ["shell-capture", "shell-chat", "shell-chat-ribbon", "shell-chat-keyboard", "shell-model-sheet", "shell-connectors"],
  ["shell-settings", "shell-settings-android", "shell-settings-scrolled", "shell-about", "shell-boot-signed-out", "mic-recovery-sign-in"],
  ["recorder-final-phone-interactive-consented", "recorder-final-phone-interactive-first-run", "recorder-final-phone-interactive-route-control", "recorder-final-phone-interactive-notes", "library-all", "note-voice-transcribed"],
  ["saved-note-sheet", "saved-note-sheet-long-title", "saved-note-sheet-editing", "capture-soft-long-titles", "pipeline-wire-sheet-done", "local-signed-out", "local-offline"],
] as const;
const webkitBatchScreens = WEBKIT_SCREEN_BATCHES.flat();
if (
  webkitBatchScreens.length !== knownScreens.size ||
  new Set(webkitBatchScreens).size !== webkitBatchScreens.length ||
  webkitBatchScreens.some((screen) => !knownScreens.has(screen))
) {
  throw new Error("WebKit screen batches must include every listed screen exactly once");
}
const batchNumber = process.env.NO_HORIZONTAL_BATCH ? Number(process.env.NO_HORIZONTAL_BATCH) : undefined;
if (batchNumber !== undefined && (!Number.isInteger(batchNumber) || batchNumber < 1 || batchNumber > WEBKIT_SCREEN_BATCHES.length)) {
  throw new Error(`NO_HORIZONTAL_BATCH must be between 1 and ${WEBKIT_SCREEN_BATCHES.length}`);
}
const batchSelection = batchNumber === undefined ? undefined : WEBKIT_SCREEN_BATCHES[batchNumber - 1];
const selectedScreens = batchSelection ?? process.env.NO_HORIZONTAL_SCREENS?.split(",").filter(Boolean);
const unknownScreens = selectedScreens?.filter((screen) => !knownScreens.has(screen));
if (unknownScreens?.length) {
  throw new Error(`NO_HORIZONTAL_SCREENS contains unknown screen(s): ${unknownScreens.join(", ")}`);
}
const screens = selectedScreens
  ? SCREENS.filter(([screen]) => selectedScreens.includes(screen))
  : SCREENS;
if (selectedScreens && screens.length === 0) {
  throw new Error("NO_HORIZONTAL_SCREENS selected no known screens");
}
const selectedWidths = process.env.NO_HORIZONTAL_WIDTHS?.split(",").map(Number).filter(Number.isFinite);
const widths = selectedWidths?.length ? selectedWidths : WIDTHS;
const selectedTextScale = process.env.NO_HORIZONTAL_TEXT_SCALE
  ? Number(process.env.NO_HORIZONTAL_TEXT_SCALE)
  : undefined;
const cases = screens.flatMap(([screen, platform]) => [
  ...(selectedTextScale === undefined || selectedTextScale === 1
    ? widths.map((width) => ({ screen, platform, width, textScale: 1 }))
    : []),
  ...((screen === "shell-settings" || screen === "shell-settings-android") && (selectedTextScale === undefined || selectedTextScale === 2)
    ? widths.includes(402) ? [{ screen, platform, width: 402, textScale: 2 }] : []
    : []),
]);
const engines: Record<string, BrowserType> = { chromium, webkit };
const engineName = process.env.NO_HORIZONTAL_ENGINE ?? "chromium";
const engine = engines[engineName];
if (!engine) throw new Error(`NO_HORIZONTAL_ENGINE must be one of ${Object.keys(engines).join(", ")}`);

let browser: Browser;
let server: ReturnType<typeof serveHarness>;
let assets: HarnessAssets;

beforeAll(async () => {
  assets = await buildHarness();
  server = serveHarness(assets);
  browser = await engine.launch({ headless: true });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
}, 30_000);

async function inspect(page: import("playwright").Page) {
  return page.evaluate(() => {
    const root = document.scrollingElement!;
    const width = document.documentElement.clientWidth;
    const overflow = [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((el) => {
        const style = getComputedStyle(el);
        return (style.overflowX === "auto" || style.overflowX === "scroll") &&
          el.scrollWidth > el.clientWidth;
      })
      .map((el) => {
        const testId = el.dataset.testid;
        const id = el.id ? `#${el.id}` : "";
        const classes = typeof el.className === "string" && el.className.trim()
          ? `.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}`
          : "";
        const edge = el.getBoundingClientRect().right;
        const widest = [...el.querySelectorAll<HTMLElement>("*")]
          .map((child) => {
            const rect = child.getBoundingClientRect();
            return { child, extent: Math.max(rect.right, rect.left + child.scrollWidth) };
          })
          .sort((a, b) => b.extent - a.extent)[0];
        const culprit = widest && widest.extent > edge
          ? (() => {
              const child = widest.child;
              const childTestId = child.dataset.testid;
              const childId = child.id ? `#${child.id}` : "";
              const childClasses = typeof child.className === "string" && child.className.trim()
                ? `.${child.className.trim().split(/\s+/).slice(0, 3).join(".")}`
                : "";
              const text = (child.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 50);
              return `; widest child ${child.tagName.toLowerCase()}${childTestId ? `[data-testid="${childTestId}"]` : ""}${childId}${childClasses}: right=${widest.extent.toFixed(1)}px, overflow=${(widest.extent - edge).toFixed(1)}px${text ? `, text="${text}"` : ""}`;
            })()
          : "";
        return `${el.tagName.toLowerCase()}${testId ? `[data-testid="${testId}"]` : ""}${id}${classes}: scrollWidth=${el.scrollWidth}, clientWidth=${el.clientWidth}${culprit}`;
      });
    const outside = [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" &&
          style.visibility !== "hidden" && Number(style.opacity) > 0 &&
          (rect.left < -1 || rect.right > width + 1);
      })
      .map((el) => {
        const testId = el.dataset.testid;
        const id = el.id ? `#${el.id}` : "";
        const classes = typeof el.className === "string" && el.className.trim()
          ? `.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}`
          : "";
        return `${el.tagName.toLowerCase()}${testId ? `[data-testid="${testId}"]` : ""}${id}${classes} (${Math.round(el.getBoundingClientRect().left)}..${Math.round(el.getBoundingClientRect().right)})`;
      });
    return { document: { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth }, overflow, outside };
  });
}

describe.serial(`mobile screens fit without horizontal drag (${engineName}, motion on)`, () => {
  for (const { screen, platform, width, textScale } of cases) {
    test(`${screen} at ${width}px${textScale === 2 ? " with 200% text" : ""}`, async () => {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        reducedMotion: "no-preference",
      });
      if (textScale === 2) {
        await context.addInitScript((scale) => {
          const apply = () => {
            const root = document.documentElement;
            if (new URLSearchParams(location.search).get("platform") === "ios") {
              root.style.removeProperty("font-size");
              root.style.setProperty("--ios-body-scale", String(scale));
            } else {
              root.style.setProperty("font-size", `${scale * 100}%`);
            }
          };
          if (document.documentElement) apply();
          else document.addEventListener("readystatechange", apply, { once: true });
        }, textScale);
      }
      const page = await context.newPage();
      try {
        await page.goto(`http://127.0.0.1:${server.port}/?screen=${screen}&theme=light&platform=${platform}&freeze=1`, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => window.exoUi?.ready === true, null, { timeout: 20_000 });
        await page.waitForTimeout(500);
        if ((screen === "shell-settings" || screen === "shell-settings-android") && textScale === 2) {
          expect(await page.locator('[data-surface="settings"] [data-stacked]').count(), "200% text must exercise a stacked segmented control").toBeGreaterThan(0);
        }
        if (screen === "shell-settings-android" && textScale === 2) {
          expect(await page.getByRole("button", { name: "Get model" }).count(), "Android Settings must render the large-text model action").toBe(1);
          const modelLabel = await page.locator('[data-testid="voice-notes-on-device-model"] span').first().boundingBox();
          const modelAction = await page.getByRole("button", { name: "Get model" }).boundingBox();
          expect(modelLabel && modelAction && modelAction.y >= modelLabel.y + modelLabel.height, "Android model action must wrap below its label at 200% text").toBe(true);
        }
        if (screen === "shell-settings" && textScale === 2) {
          expect(await page.getByRole("button", { name: "Get model" }).count(), "iOS Settings must use Apple speech instead of the Android model download action").toBe(0);
        }
        const result = await inspect(page);
        expect(result.document.scrollWidth, `${screen}: document wider than viewport`).toBeLessThanOrEqual(result.document.clientWidth);
        expect(result.overflow, `${screen}: overflowing horizontal scroll containers: ${result.overflow.join("; ")}`).toEqual([]);
        expect(result.outside, `${screen}: elements beyond viewport: ${result.outside.join("; ")}`).toEqual([]);
      } finally {
        await context.close();
      }
    }, 30_000);
  }
});
