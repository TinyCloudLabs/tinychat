// The Soft-skin phone Capture home (TC-871) interactions, on the exo-ui harness
// screens (frontend/src/harness/screens/capture.tsx):
//
//   1. A Recent row is one control; tapping it opens the note.
//   2. A "couldn't recover" row opens a labelled sheet; Close returns focus to the row.
//   3. A capture issue with no Library row also shows in the Library list, and behaves the same.
//   4. A timed-out row is one keyboard-reachable button that opens its sheet.
//   5. An open sheet closes when the provider clears its issue.
//   6. Save now on the "on this phone" card calls retryPending.
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
}, 30_000);

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

  test("a timed-out row is a button reachable by keyboard; its sheet explains, and Close returns focus", async () => {
    const page = await open("capture-soft-timed-out");
    const row = page.locator(
      '[data-testid="capture-recent"] li[data-issue="finalization_timed_out"] button',
    );
    expect(await row.getAttribute("aria-label")).toContain(
      "Saving… · kept on this phone",
    );
    await row.focus();
    await page.keyboard.press("Enter");
    const sheet = page.getByRole("dialog");
    await sheet.waitFor({ timeout: 5_000 });
    expect(await sheet.innerText()).toContain("kept on this phone");
    expect(await sheet.innerText()).not.toMatch(/Try again|Delete/);
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached", timeout: 5_000 });
    expect(await row.evaluate((el) => el === document.activeElement)).toBe(
      true,
    );
    await page.context().close();
  });

  for (const [screen, kind] of [
    ["capture-soft-clearing-failed", "recoveryFailed"],
    ["capture-soft-clearing-saving", "finalization_timed_out"],
  ] as const)
    test(`an open ${kind} sheet closes when the recorder clears the issue`, async () => {
      const page = await open(screen);
      await page
        .locator(
          `[data-testid="capture-recent"] li[data-issue="${kind}"] button`,
        )
        .tap();
      const sheet = page.getByRole("dialog");
      await sheet.waitFor({ timeout: 5_000 });
      await page.evaluate(() => window.exoUiClearIssues?.());
      await sheet.waitFor({ state: "detached", timeout: 5_000 });
      expect(await page.locator(`li[data-issue="${kind}"]`).count()).toBe(0);
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
