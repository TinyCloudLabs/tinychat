import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { buildHarness, serveHarness } from "./exo-ui/harness-server";

setDefaultTimeout(30_000);
let browser: Browser;
let server: ReturnType<typeof serveHarness>;

beforeAll(async () => {
  server = serveHarness(await buildHarness());
  browser = await chromium.launch({ headless: true });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

describe("Meeting sources modal", () => {
  test("opens, traps keyboard focus, and Escape returns focus to its opener", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`${server.url}/?screen=meeting-sources-dialog&theme=dark&platform=web`);
    await page.getByRole("button", { name: /Meeting sources/ }).click();
    const dialog = page.getByRole("dialog", { name: "Meeting sources" });
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Tab");
    expect(await dialog.locator(":focus").count()).toBe(1);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: /Meeting sources/ })).toBeFocused();
    await page.close();
  });
});
