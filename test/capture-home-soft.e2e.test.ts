// The Soft-skin phone Capture home (TC-871) interactions, on the exo-ui harness
// screens (frontend/src/harness/screens/capture.tsx):
//
//   1. A Recent row is one control; tapping it opens the note.
//   2. A "couldn't recover" row opens a labelled sheet; Close returns focus to the row.
//   3. A capture issue with no Library row also shows in the Library list, and behaves the same.
//   4. Save now on the "on this phone" card calls retryPending.
//
// SOFT_HOME_ENGINE=webkit runs it in WebKit (the phone app's engine); Chromium by default (CI).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chromium,
  webkit,
  type Browser,
  type BrowserType,
  type Page,
} from "playwright";
import { buildHarness, serveHarness } from "./exo-ui/harness-server";

const engines: Record<string, BrowserType> = { chromium, webkit };
const engine = engines[process.env.SOFT_HOME_ENGINE ?? "chromium"];
if (!engine)
  throw new Error(
    `SOFT_HOME_ENGINE must be one of ${Object.keys(engines).join(", ")}`,
  );

let browser: Browser;
let running: ReturnType<typeof serveHarness>;
beforeAll(async () => {
  running = serveHarness(await buildHarness());
  browser = await engine.launch({ headless: true });
}, 120_000);
afterAll(async () => {
  await browser?.close();
  running?.stop(true);
});

async function open(screen: string): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.goto(
    `http://127.0.0.1:${running.port}/?screen=${screen}&theme=dark&platform=ios&freeze=1`,
  );
  await page.waitForFunction(() => window.exoUi?.ready === true, undefined, {
    timeout: 20_000,
  });
  return page;
}

describe("Soft Capture home interactions (phone)", () => {
  test("tapping a Recent row opens its note", async () => {
    const page = await open("capture-soft-notes");
    const row = page
      .locator('[data-testid="capture-recent"] [data-testid="recent-item"] a')
      .first();
    expect(await row.getAttribute("aria-label")).toContain("Voice note");
    await row.tap();
    await page.waitForSelector(
      '[data-testid="note-detail"], [data-testid="note-loading"], [data-testid="note-failed"], [data-testid="note-absent"]',
      { timeout: 5_000 },
    );
    await page.context().close();
  });

  test("a couldn't-recover row opens a sheet, and Close returns focus to the row", async () => {
    const page = await open("capture-soft-recovery-failed");
    const row = page.locator(
      '[data-testid="capture-recent"] li[data-issue="recoveryFailed"] button',
    );
    expect(await row.getAttribute("aria-label")).toContain("Needs attention");
    await row.tap();

    const sheet = page.getByRole("dialog");
    await sheet.waitFor({ timeout: 5_000 });
    expect(await sheet.getAttribute("aria-modal")).not.toBe("false");
    expect(await sheet.getAttribute("aria-labelledby")).toBeTruthy();
    expect(await sheet.innerText()).toContain(
      "Exo couldn't finish saving this recording. It will try again when it next opens.",
    );
    expect(await sheet.innerText()).not.toMatch(
      /Try again\b(?!.*opens)|Delete/,
    );

    await page.locator('[data-testid="capture-issue-close"]').tap();
    await sheet.waitFor({ state: "detached", timeout: 5_000 });
    expect(await row.evaluate((el) => el === document.activeElement)).toBe(
      true,
    );
    await page.context().close();
  });

  test("a Library-list issue row opens the same sheet, and Close returns focus to it", async () => {
    const page = await open("capture-soft-library-issue");
    const row = page.locator(
      '[data-testid="library-list"] li[data-issue="recoveryFailed"] button',
    );
    await row.tap();
    const sheet = page.getByRole("dialog");
    await sheet.waitFor({ timeout: 5_000 });
    await page.locator('[data-testid="capture-issue-close"]').tap();
    await sheet.waitFor({ state: "detached", timeout: 5_000 });
    expect(await row.evaluate((el) => el === document.activeElement)).toBe(
      true,
    );
    await page.context().close();
  });

  test("Save now retries the saves waiting on this phone", async () => {
    const page = await open("capture-soft-on-phone");
    expect(await page.evaluate(() => window.exoUiRetryPending ?? 0)).toBe(0);
    await page.locator('[data-testid="voice-note-retry"]').tap();
    expect(await page.evaluate(() => window.exoUiRetryPending ?? 0)).toBe(1);
    await page.context().close();
  });
});
