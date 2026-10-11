import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
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
  ["capture-soft-long-titles", "ios"],
  ["pipeline-wire-sheet-done", "ios"],
  ["local-signed-out", "android"],
  ["local-offline", "android"],
] as const;

let browser: Browser;
let assets: HarnessAssets;
let server: ReturnType<typeof serveHarness>;

beforeAll(async () => {
  assets = await buildHarness();
  server = serveHarness(assets);
  browser = await chromium.launch({ headless: true });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  server?.stop();
});

async function inspect(page: Page) {
  return page.evaluate(() => {
    const root = document.scrollingElement!;
    const width = document.documentElement.clientWidth;
    const outside = [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" &&
          style.visibility !== "hidden" && Number(style.opacity) > 0 &&
          (rect.left < -1 || rect.right > width + 1);
      })
      .map((el) => {
        const id = el.id ? `#${el.id}` : "";
        const classes = typeof el.className === "string" && el.className.trim()
          ? `.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}` : "";
        const label = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 35);
        const state = el.getAttribute("data-state");
        const style = getComputedStyle(el);
        const parent = el.parentElement;
        const parentRect = parent?.getBoundingClientRect();
        return `${el.tagName.toLowerCase()}${id}${classes}${state ? `[data-state=${state}]` : ""}${label ? ` "${label}"` : ""} (${Math.round(el.getBoundingClientRect().left)}..${Math.round(el.getBoundingClientRect().right)}, width:${style.width}, transform:${style.transform}; parent ${parent?.tagName}.${(parent?.className as string | undefined)?.split(" ").slice(0, 2).join(".")} ${parentRect ? `${Math.round(parentRect.left)}..${Math.round(parentRect.right)}` : ""})`;
      });
    return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, outside };
  });
}

describe("mobile screens fit the viewport without horizontal drag", () => {
  for (const [screen, platform] of SCREENS) {
    for (const width of WIDTHS) {
      test(`${screen} at ${width}px`, async () => {
        const context: BrowserContext = await browser.newContext({
          viewport: { width, height: 844 },
          deviceScaleFactor: 3,
          isMobile: true,
          hasTouch: true,
          reducedMotion: "reduce",
        });
        const page = await context.newPage();
        await page.goto(`http://127.0.0.1:${server.port}/?screen=${screen}&theme=light&platform=${platform}&freeze=1`);
        await page.waitForFunction(() => window.exoUi?.ready === true, null, { timeout: 20_000 });
        await page.waitForTimeout(400);
        if (screen === "shell-settings") {
          await page.locator('[data-surface="settings"]').evaluate((el) => {
            const valueFor = (label: string) => {
              const name = [...el.querySelectorAll("span")].find((node) => node.textContent?.trim() === label);
              return name?.nextElementSibling;
            };
            const address = valueFor("Address");
            const did = valueFor("DID");
            if (address) address.textContent = "alexandria.long.account@example-with-an-intentionally-long-domain.invalid";
            if (did) did.textContent = `did:example:${"ab".repeat(80)}`;
          });
        }
        const result = await inspect(page);
        await context.close();
        expect(result.scrollWidth, `${screen} document width exceeds ${width}px`).toBeLessThanOrEqual(result.clientWidth);
        expect(result.outside, `${screen} elements outside ${width}px: ${result.outside.join(", ")}`).toEqual([]);
      }, 30_000);
    }
  }
});
