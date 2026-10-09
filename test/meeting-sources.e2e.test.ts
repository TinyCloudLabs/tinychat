import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { buildHarness, serveHarness } from "./exo-ui/harness-server";

setDefaultTimeout(30_000);
let browser: Browser;
let server: ReturnType<typeof serveHarness>;

beforeAll(async () => {
  server = serveHarness(await buildHarness());
  browser = await chromium.launch({ headless: true });
}, 120_000);

afterAll(async () => {
  server?.stop(true);
  // A dead DevTools pipe can leave close() pending after every test passed.
  await Promise.race([browser?.close(), new Promise((resolve) => setTimeout(resolve, 10_000))]);
}, 20_000);

async function open(theme: "dark" | "light"): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${server.url}/?screen=meeting-sources-interactive&theme=${theme}&platform=web`);
  await page.locator(".ms-entry").waitFor();
  return page;
}

const activeText = (page: Page) =>
  page.evaluate(() => (document.activeElement as HTMLElement | null)?.textContent?.trim() ?? "");
const activeLabel = (page: Page) =>
  page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? "");

for (const theme of ["dark", "light"] as const) {
  describe(`Meeting sources window (${theme})`, () => {
    test("Manage expands, Instant updates is a switch, and Escape returns focus to the entry", async () => {
      const page = await open(theme);
      const entry = page.locator(".ms-entry");
      await entry.click();
      const window = page.getByRole("dialog", { name: "Meeting sources" });
      await window.waitFor();
      expect(await activeLabel(page)).toBe("Close");

      const manage = window.locator('[data-source="fireflies"] button[aria-controls="msx-fireflies"]');
      expect(await manage.getAttribute("aria-expanded")).toBe("false");
      await manage.click();
      expect(await manage.getAttribute("aria-expanded")).toBe("true");
      // Only the Fireflies panel opens; the other sources stay closed.
      expect(await window.locator("[aria-expanded=true]").count()).toBe(1);

      const instant = window.getByRole("switch", { name: "Instant updates" });
      expect(await instant.getAttribute("aria-checked")).toBe("true");
      await instant.click();
      expect(await instant.getAttribute("aria-checked")).toBe("false");
      await instant.click();
      expect(await instant.getAttribute("aria-checked")).toBe("true");

      await manage.click();
      expect(await manage.getAttribute("aria-expanded")).toBe("false");

      await page.keyboard.press("Escape");
      await window.waitFor({ state: "hidden" });
      expect(await page.evaluate(() => document.activeElement?.className)).toContain("ms-entry");
      await page.close();
    });

    test("Rotate asks first: Keep is focused, Escape keeps, and focus returns to the opener", async () => {
      const page = await open(theme);
      await page.locator(".ms-entry").click();
      const window = page.getByRole("dialog", { name: "Meeting sources" });
      await window.locator('[data-source="fireflies"] button[aria-controls="msx-fireflies"]').click();

      const rotate = window.getByRole("button", { name: "Rotate the webhook secret" });
      await rotate.focus();
      await rotate.click();
      const confirm = page.getByRole("alertdialog", { name: "Rotate the webhook secret?" });
      await confirm.waitFor();
      expect(await activeText(page)).toBe("Keep the current one");

      await page.keyboard.press("Escape");
      await confirm.waitFor({ state: "hidden" });
      // The window under it is still open, and focus is back on what opened the sheet.
      expect(await window.isVisible()).toBe(true);
      expect(await activeText(page)).toBe("Rotate the webhook secret");

      await rotate.click();
      await confirm.waitFor();
      await page.getByRole("button", { name: "Keep the current one" }).click();
      await confirm.waitFor({ state: "hidden" });
      expect(await activeText(page)).toBe("Rotate the webhook secret");
      await page.close();
    });

    test("Disconnect asks first and says what stays", async () => {
      const page = await open(theme);
      await page.locator(".ms-entry").click();
      const window = page.getByRole("dialog", { name: "Meeting sources" });
      await window.locator('[data-source="fireflies"] button[aria-controls="msx-fireflies"]').click();

      const disconnect = window.getByRole("button", { name: "Disconnect Fireflies" });
      await disconnect.click();
      const confirm = page.getByRole("alertdialog", { name: "Disconnect Fireflies?" });
      await confirm.waitFor();
      expect(await confirm.textContent()).toContain("Meetings already in your space stay.");
      expect(await activeText(page)).toBe("Keep connected");

      await page.keyboard.press("Escape");
      await confirm.waitFor({ state: "hidden" });
      expect(await activeText(page)).toBe("Disconnect Fireflies");
      // Nothing was disconnected.
      expect(await window.locator('[data-source="fireflies"] .ms-btn1').count()).toBe(0);
      await page.close();
    });
  });
}
