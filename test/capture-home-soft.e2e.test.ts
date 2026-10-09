// The Soft-skin phone Capture home (TC-871) interactions, on the exo-ui harness
// screens (frontend/src/harness/screens/capture.tsx):
//
//   1. A Recent row is one control; tapping it opens the note.
//   2. A "couldn't recover" row opens a labelled sheet; Close returns focus to the row.
//   3. A capture issue with no Library row also shows in the Library list, and behaves the same.
//   4. A timed-out row is one keyboard-reachable button that opens its sheet.
//   5. An open sheet closes when the provider clears its issue, and focus lands on the list's heading (Recent or Library), never <body>.
//   6. Save now on the "on this phone" card calls retryPending.
//   7. The couldn't-recover sheet's Try again and Delete (TC-868), for a failed recording and a quarantined one.
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
    expect(await page.locator('[data-testid="capture-issue-retry"]').innerText()).toBe("Try again");
    expect(await page.locator('[data-testid="capture-issue-delete"]').innerText()).toBe("Delete");

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
    expect(await sheet.innerText()).toMatch(/kept on this phone/i);
    expect(await sheet.innerText()).not.toMatch(/Try again|Delete/);
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached", timeout: 5_000 });
    expect(await row.evaluate((el) => el === document.activeElement)).toBe(
      true,
    );
    await page.context().close();
  });

  for (const [screen, kind, pane, landing] of [
    [
      "capture-soft-clearing-failed",
      "recoveryFailed",
      "capture-recent",
      "#recent-title",
    ],
    [
      "capture-soft-clearing-saving",
      "finalization_timed_out",
      "capture-recent",
      "#recent-title",
    ],
    [
      "capture-soft-clearing-library",
      "recoveryFailed",
      "library-list",
      '[data-testid="library-list"]',
    ],
  ] as const)
    test(`${screen}: an open ${kind} sheet closes when the recorder clears the issue, and focus lands on the list's heading`, async () => {
      const page = await open(screen);
      await page
        .locator(`[data-testid="${pane}"] li[data-issue="${kind}"] button`)
        .tap();
      const sheet = page.getByRole("dialog");
      await sheet.waitFor({ timeout: 5_000 });
      await page.evaluate(() => window.exoUiClearIssues?.());
      await sheet.waitFor({ state: "detached", timeout: 5_000 });
      expect(await page.locator(`li[data-issue="${kind}"]`).count()).toBe(0);
      expect(
        await page.evaluate(
          (selector) =>
            document.activeElement === document.querySelector(selector),
          landing,
        ),
      ).toBe(true);
      expect(
        await page.evaluate(() => document.activeElement?.tagName),
      ).not.toBe("BODY");
      await page.context().close();
    });

  test("Save now retries the saves waiting on this phone", async () => {
    const page = await open("capture-soft-on-phone");
    expect(await page.evaluate(() => window.exoUiRetryPending ?? 0)).toBe(0);
    await page.locator('[data-testid="voice-note-retry"]').tap();
    expect(await page.evaluate(() => window.exoUiRetryPending ?? 0)).toBe(1);
    await page.context().close();
  });

  describe("couldn't-recover sheet actions (TC-868)", () => {
    const ROW = '[data-testid="capture-recent"] li[data-issue="recoveryFailed"] button';
    const PARKED = '[data-testid="capture-recent"] li[data-issue="quarantined"] button';
    const sheetOf = (page: Page) => page.getByRole("dialog", { name: /recover/i });
    const calls = (page: Page) => page.evaluate(() => window.exoUiFailed?.calls ?? []);
    const fail = (page: Page, name: "retry" | "discard" | "deleteQuarantined" | "list", code: string) =>
      page.evaluate(([n, c]) => { window.exoUiFailed!.fail[n as "retry"] = c; }, [name, code]);

    test("Try again shows a busy state, then the sheet closes and the row is gone when the issue clears", async () => {
      const page = await open("capture-soft-failed-actions");
      await page.locator(ROW).tap();
      await sheetOf(page).waitFor({ timeout: 5_000 });
      await page.evaluate(() => { window.exoUiFailed!.hold = true; });
      await page.locator('[data-testid="capture-issue-retry"]').tap();
      await page.waitForFunction(
        () => document.querySelector('[data-testid="capture-issue-retry"]')?.textContent === "Trying again…",
      );
      expect(await page.locator('[data-testid="capture-issue-retry"]').getAttribute("aria-disabled")).toBe("true");
      await page.evaluate(() => window.exoUiFailed!.release());
      await sheetOf(page).waitFor({ state: "detached", timeout: 5_000 });
      expect(await page.locator('li[data-issue="recoveryFailed"]').count()).toBe(0);
      expect((await calls(page)).filter((c) => c.startsWith("retry:"))).toHaveLength(1);
      await page.context().close();
    });

    test("Delete asks first with Keep focused; Delete then discards the recording and the row goes", async () => {
      const page = await open("capture-soft-failed-actions");
      await page.locator(ROW).tap();
      await sheetOf(page).waitFor({ timeout: 5_000 });
      await page.locator('[data-testid="capture-issue-delete"]').tap();
      const confirm = page.getByRole("alertdialog");
      await confirm.waitFor({ timeout: 5_000 });
      expect(await confirm.innerText()).toContain("The audio will be deleted from this phone.");
      expect(
        await page.evaluate(() => document.activeElement?.getAttribute("data-testid")),
      ).toBe("capture-issue-keep");
      expect((await calls(page)).filter((c) => c.startsWith("discard:"))).toHaveLength(0);
      await page.locator('[data-testid="capture-issue-delete-confirm"]').tap();
      await sheetOf(page).waitFor({ state: "detached", timeout: 5_000 });
      expect((await calls(page)).filter((c) => c.startsWith("discard:"))).toHaveLength(1);
      expect(await page.locator('li[data-issue="recoveryFailed"]').count()).toBe(0);
      await page.context().close();
    });

    test("Delete then Keep deletes nothing and returns focus to the Delete button", async () => {
      const page = await open("capture-soft-failed-actions");
      await page.locator(ROW).tap();
      await sheetOf(page).waitFor({ timeout: 5_000 });
      await page.locator('[data-testid="capture-issue-delete"]').tap();
      await page.getByRole("alertdialog").waitFor({ timeout: 5_000 });
      await page.locator('[data-testid="capture-issue-keep"]').tap();
      await page.getByRole("alertdialog").waitFor({ state: "detached", timeout: 5_000 });
      expect(
        await page.evaluate(() => document.activeElement?.getAttribute("data-testid")),
      ).toBe("capture-issue-delete");
      expect(await sheetOf(page).isVisible()).toBe(true);
      expect((await calls(page)).filter((c) => c.startsWith("discard:"))).toHaveLength(0);
      await page.context().close();
    });

    test("Escape on the confirmation is Keep, not a close of the sheet", async () => {
      const page = await open("capture-soft-failed-actions");
      await page.locator(ROW).tap();
      await sheetOf(page).waitFor({ timeout: 5_000 });
      await page.locator('[data-testid="capture-issue-delete"]').tap();
      await page.getByRole("alertdialog").waitFor({ timeout: 5_000 });
      await page.keyboard.press("Escape");
      await page.getByRole("alertdialog").waitFor({ state: "detached", timeout: 5_000 });
      expect(await sheetOf(page).isVisible()).toBe(true);
      await page.context().close();
    });

    test("not_failed_recording closes the sheet when the issue is already gone, with no error", async () => {
      const page = await open("capture-soft-failed-actions");
      await page.locator(ROW).tap();
      await sheetOf(page).waitFor({ timeout: 5_000 });
      await fail(page, "retry", "not_failed_recording");
      await page.evaluate(() => window.exoUiClearIssues?.());
      await sheetOf(page).waitFor({ state: "detached", timeout: 5_000 });
      expect(await page.locator('[data-testid="capture-issue-error"]').count()).toBe(0);
      await page.context().close();
    });

    test("not_failed_recording from Try again shows no error", async () => {
      const page = await open("capture-soft-failed-actions");
      await page.locator(ROW).tap();
      await sheetOf(page).waitFor({ timeout: 5_000 });
      await fail(page, "retry", "not_failed_recording");
      await page.locator('[data-testid="capture-issue-retry"]').tap();
      await page.waitForFunction(() => window.exoUiFailed!.calls.some((c) => c.startsWith("retry:")));
      expect(await page.locator('[data-testid="capture-issue-error"]').count()).toBe(0);
      await page.context().close();
    });

    test("any other rejection is shown inline as an alert, and the buttons stay", async () => {
      const page = await open("capture-soft-failed-actions");
      const logged: string[] = [];
      page.on("console", (message) => message.type() === "error" && logged.push(message.text()));
      await page.locator(ROW).tap();
      await sheetOf(page).waitFor({ timeout: 5_000 });
      await fail(page, "retry", "recording_in_progress");
      await page.locator('[data-testid="capture-issue-retry"]').tap();
      const alert = page.locator('[data-testid="capture-issue-error"]');
      await alert.waitFor({ timeout: 5_000 });
      expect(await alert.getAttribute("role")).toBe("alert");
      expect(await alert.innerText()).toContain("Couldn't try again");
      expect(await page.locator('[data-testid="capture-issue-retry"]').innerText()).toBe("Try again");
      expect(await page.locator('[data-testid="capture-issue-delete"]').count()).toBe(1);
      expect(logged.length).toBeGreaterThan(0);
      await page.context().close();
    });

    test("a quarantined recording is a Recent row with its audio kept, and Delete removes it via deleteQuarantined", async () => {
      const page = await open("capture-soft-failed-parked");
      const row = page.locator(PARKED);
      await row.waitFor({ timeout: 5_000 });
      expect(await row.getAttribute("aria-label")).toContain("audio kept");
      await row.tap();
      await sheetOf(page).waitFor({ timeout: 5_000 });
      await page.locator('[data-testid="capture-issue-delete"]').tap();
      await page.getByRole("alertdialog").waitFor({ timeout: 5_000 });
      await page.locator('[data-testid="capture-issue-delete-confirm"]').tap();
      await sheetOf(page).waitFor({ state: "detached", timeout: 5_000 });
      expect(await calls(page)).toContain("deleteQuarantined:rec-parked");
      expect(await calls(page)).not.toContain("discard:rec-parked");
      expect(await page.locator('li[data-issue="quarantined"]').count()).toBe(0);
      await page.context().close();
    });

    for (const [screen, reason] of [
      ["capture-soft-failed-unplayable", "unplayable (Android)"],
      ["capture-soft-failed-no-audio", "no_audio_track (iOS)"],
    ] as const)
    test(`a quarantined recording native calls ${reason} offers Delete only, with an honest line`, async () => {
      const page = await open(screen);
      await page.locator(PARKED).tap();
      await sheetOf(page).waitFor({ timeout: 5_000 });
      expect(await sheetOf(page).innerText()).toContain("This recording can't be recovered. You can delete it.");
      expect(await page.locator('[data-testid="capture-issue-retry"]').count()).toBe(0);
      await page.locator('[data-testid="capture-issue-delete"]').tap();
      await page.getByRole("alertdialog").waitFor({ timeout: 5_000 });
      await page.locator('[data-testid="capture-issue-delete-confirm"]').tap();
      await sheetOf(page).waitFor({ state: "detached", timeout: 5_000 });
      expect(await calls(page)).toContain("deleteQuarantined:rec-unplayable");
      expect(await page.locator('li[data-issue="quarantined"]').count()).toBe(0);
      await page.context().close();
    });

    test("Try again on a quarantined recording that fails again leaves it quarantined, with the error shown", async () => {
      const page = await open("capture-soft-failed-parked");
      await page.locator(PARKED).tap();
      await sheetOf(page).waitFor({ timeout: 5_000 });
      await fail(page, "retry", "recovery_failed");
      const before = await page.evaluate(() => window.exoUiFailed!.listCalls());
      await page.locator('[data-testid="capture-issue-retry"]').tap();
      await page.locator('[data-testid="capture-issue-error"]').waitFor({ timeout: 5_000 });
      expect(await page.evaluate(() => window.exoUiFailed!.listCalls())).toBeGreaterThan(before);
      expect(await page.locator(PARKED).count()).toBe(1);
      await page.context().close();
    });

    test("quarantine is read on mount, again after an action (at least once; one read serves a refresh asked for while it is pending), and again when a recoveryFailed issue appears", async () => {
      const page = await open("capture-soft-failed-parked");
      await page.locator(PARKED).waitFor({ timeout: 5_000 });
      const reads = () => page.evaluate(() => window.exoUiFailed!.listCalls());
      const mounted = await reads();
      expect(mounted).toBeGreaterThanOrEqual(1);
      await page.evaluate(() => window.exoUiAddLost?.("rec-new"));
      await page.waitForFunction((before) => window.exoUiFailed!.listCalls() > before, mounted);
      const appeared = await reads();
      expect(appeared).toBe(mounted + 1);
      await page.locator(PARKED).tap();
      await sheetOf(page).waitFor({ timeout: 5_000 });
      await page.locator('[data-testid="capture-issue-retry"]').tap();
      await sheetOf(page).waitFor({ state: "detached", timeout: 5_000 });
      await page.waitForFunction((before) => window.exoUiFailed!.listCalls() > before, appeared);
      await page.context().close();
    });
  });
});
