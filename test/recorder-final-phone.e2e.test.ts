// The final phone recorder (TC-867), driven in a real browser: the harness mounts PhoneRecorder over a
// recorder that logs what it is asked to do (frontend/src/harness/screens/recorderFinalPhoneInteractive.tsx).
// The screenshot run checks how each state looks; this checks that the controls do what they say.
//
//   EXO_UI_ENGINE=chromium   webkit (default: Exo's WKWebView) or chromium
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  chromium,
  webkit,
  type Browser,
  type Locator,
  type Page,
} from "playwright";
import { buildHarness, serveHarness } from "./exo-ui/harness-server";

const engineName = process.env.EXO_UI_ENGINE ?? "webkit";
const engine = engineName === "chromium" ? chromium : webkit;

setDefaultTimeout(30_000);

let browser: Browser;
let server: ReturnType<typeof serveHarness>;

type Harness = {
  exoRecorder: {
    calls: string[];
    patch: (patch: object) => void;
    fail: Record<string, boolean>;
  };
};

beforeAll(async () => {
  server = serveHarness(await buildHarness());
  browser = await engine.launch({ headless: true });
}, 120_000);

afterAll(async () => {
  await Promise.race([
    browser?.close(),
    new Promise((resolve) => setTimeout(resolve, 10_000)),
  ]);
  server?.stop(true);
});

interface Opened {
  page: Page;
  calls: () => Promise<string[]>;
  activeName: () => Promise<string>;
  errors: string[];
}

async function open(
  name: "consented" | "first-run" | "failing",
): Promise<Opened> {
  const page = await (
    await browser.newContext({
      viewport: { width: 390, height: 844 },
      reducedMotion: "reduce",
    })
  ).newPage();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().startsWith("Failed to load resource")
    )
      errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(
    `http://127.0.0.1:${server.port}/?screen=recorder-final-phone-interactive-${name}&theme=light&platform=ios`,
  );
  await page.waitForSelector("[data-testid=phone-recorder]");
  return {
    page,
    errors,
    calls: () =>
      page.evaluate(() =>
        (window as unknown as Harness).exoRecorder.calls.slice(),
      ),
    // What has focus, by its name: aria-label, else its text.
    activeName: () =>
      page.evaluate(() => {
        const el = document.activeElement;
        return el?.getAttribute("aria-label") ?? el?.textContent?.trim() ?? "";
      }),
  };
}

const until = async (
  what: string,
  check: () => Promise<boolean>,
  ms = 5000,
) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};
const shown = (locator: Locator) =>
  locator.waitFor({ state: "visible", timeout: 5000 });
const gone = (locator: Locator) =>
  locator.waitFor({ state: "hidden", timeout: 5000 });
const focused = (locator: Locator) =>
  until(`${locator} to have focus`, () =>
    locator.evaluate((el) => el === document.activeElement),
  );
const attr = (locator: Locator, name: string, value: string) =>
  until(
    `${name}="${value}"`,
    async () => (await locator.getAttribute(name)) === value,
  );
const text = (locator: Locator, value: string) =>
  until(
    `text "${value}"`,
    async () => ((await locator.textContent()) ?? "") === value,
  );

const slider = (page: Page) =>
  page.getByRole("slider", { name: "Transcription privacy" });
const mode = (page: Page) => slider(page).getAttribute("aria-valuetext");
const modeIs = (page: Page, value: string) =>
  until(`mode ${value}`, async () => (await mode(page)) === value);
const storedMode = (page: Page) =>
  page.evaluate(() => localStorage.getItem("exo.recorder.transcription-mode"));
const ring = (page: Page) => page.locator(".pr-stage button");

describe.serial(`phone recorder interactions (${engineName})`, () => {
  test("the ring pauses and resumes, and so does the control below it", async () => {
    const { page, calls } = await open("consented");
    await attr(ring(page), "aria-label", "Pause recording");
    const disc = (await ring(page).boundingBox())!;
    expect(Math.round(disc.width)).toBe(172);
    expect(Math.round(disc.height)).toBe(172);
    const canvas = (await page
      .locator(".pr-ring .halo-ring__canvas")
      .boundingBox())!;
    expect(Math.round(canvas.width)).toBe(301);
    await ring(page).click();
    expect(await calls()).toEqual(["pause"]);
    await attr(ring(page), "aria-label", "Resume recording");
    await ring(page).click();
    expect(await calls()).toEqual(["pause", "resume"]);
    await page
      .locator(".pr-controls")
      .getByRole("button", { name: "Pause recording" })
      .click();
    expect(await calls()).toEqual(["pause", "resume", "pause"]);
    await page.context().close();
  });

  test("Done stops, minimise minimises, and neither is announced twice (the provider owns those announcements)", async () => {
    const { page, calls } = await open("consented");
    await ring(page).click();
    await page.getByRole("button", { name: "Done" }).click();
    await page.getByRole("button", { name: "Minimise recorder" }).click();
    expect(await calls()).toEqual(["pause", "stop", "minimise"]);
    await text(page.getByTestId("phone-recorder-announcer"), "");
    await page.context().close();
  });

  test("the slider moves with the arrow keys; leaving Private turns the route off, and the choice is kept", async () => {
    const { page, calls } = await open("consented");
    await modeIs(page, "Private");
    await slider(page).focus();
    await page.keyboard.press("ArrowLeft");
    await modeIs(page, "Local");
    expect(await calls()).toEqual(["turnOff"]);
    expect(await storedMode(page)).toBe("local");
    await text(page.getByTestId("phone-recorder-announcer"), "Local selected");
    await page.context().close();
  });

  test("dragging the slider chooses the nearest stop; an unavailable one says why and stays put", async () => {
    const { page, calls } = await open("consented");
    const box = (await slider(page).boundingBox())!;
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(box.x + 12, y, { steps: 6 });
    await page.mouse.up();
    await modeIs(page, "Skip");
    expect(await calls()).toEqual(["turnOff"]);

    await page.mouse.move(box.x + 12, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 12, y, { steps: 6 });
    await page.mouse.up();
    await modeIs(page, "Skip");
    await shown(page.getByText("Coming with the next update").first());
    await page.context().close();
  });

  test("first run: Private is not shown or stored until consent; consent turns the route on", async () => {
    const { page, calls, activeName } = await open("first-run");
    await modeIs(page, "Skip");
    await shown(page.getByText("Just the recording, kept on this phone."));
    expect(await storedMode(page)).toBeNull();

    await slider(page).focus();
    await page.keyboard.press("ArrowRight");
    await modeIs(page, "Local");
    expect(await storedMode(page)).toBe("local");
    await page.keyboard.press("ArrowRight");
    const dialog = page.getByRole("dialog", { name: "Use private cloud?" });
    await shown(dialog);
    expect(await activeName()).toBe("Use private cloud");
    await modeIs(page, "Local");
    expect(await calls()).toEqual([]);

    await page.getByRole("button", { name: "Use private cloud" }).click();
    expect(await calls()).toEqual(["consent"]);
    await modeIs(page, "Private");
    expect(await storedMode(page)).toBe("private");
    await gone(dialog);
    await focused(slider(page));
    await page.context().close();
  });

  test("the consent sheet gives focus back on Not now, Escape, the veil and consent", async () => {
    const { page, calls } = await open("first-run");
    const dialog = page.getByRole("dialog", { name: "Use private cloud?" });
    await slider(page).focus();
    await page.keyboard.press("ArrowRight");
    await modeIs(page, "Local");
    for (const close of [
      () => page.getByRole("button", { name: "Not now" }).click(),
      () => page.keyboard.press("Escape"),
      () => page.locator(".pr-veil").click({ position: { x: 20, y: 20 } }),
    ]) {
      await page.keyboard.press("ArrowRight");
      await shown(dialog);
      await close();
      await gone(dialog);
      await focused(slider(page));
    }
    expect(await calls()).toEqual([]);
    expect(await storedMode(page)).toBe("local");

    await page.keyboard.press("ArrowRight");
    await shown(dialog);
    await page.getByRole("button", { name: "Use private cloud" }).click();
    await gone(dialog);
    await focused(slider(page));
    expect(await calls()).toEqual(["consent"]);
    await page.context().close();
  });

  test("the discard sheet keeps the recording by default, returns focus on every close, and discards only on Discard", async () => {
    const { page, calls } = await open("consented");
    const discard = page
      .getByRole("button", { name: "Discard recording" })
      .first();
    const dialog = page.getByRole("alertdialog", {
      name: "Discard this recording?",
    });
    const closers = [
      () => page.getByRole("button", { name: "Keep recording" }).click(),
      () => page.keyboard.press("Escape"),
      () => page.locator(".pr-veil").click({ position: { x: 20, y: 20 } }),
    ];
    for (const close of closers) {
      await discard.click();
      await shown(dialog);
      await focused(page.getByRole("button", { name: "Keep recording" }));
      await close();
      await gone(dialog);
      await focused(discard);
    }
    expect(await calls()).toEqual([]);

    await discard.click();
    await dialog.getByRole("button", { name: "Discard recording" }).click();
    expect(await calls()).toEqual(["discard"]);
    await page.context().close();
  });

  test("the modes card and the via menu give focus back to their buttons on every close", async () => {
    const { page, calls } = await open("consented");
    const info = page.getByRole("button", {
      name: "Transcription modes: compare and choose",
    });
    await attr(info, "aria-haspopup", "dialog");
    const card = page.getByRole("dialog", { name: "Transcription modes" });

    await info.click();
    await shown(card);
    await shown(card.getByRole("radiogroup"));
    await page.keyboard.press("Escape");
    await gone(card);
    await focused(info);

    await info.click();
    await card.getByRole("button", { name: "Close" }).click();
    await focused(info);

    await info.click();
    await card.getByRole("radio", { name: /Local/ }).click();
    await gone(card);
    await focused(info);
    await modeIs(page, "Local");

    const via = page.getByRole("button", { name: /^Record from/ });
    await via.click();
    const menu = page.getByRole("menu", { name: "Record from" });
    await shown(menu);
    await page.keyboard.press("Escape");
    await gone(menu);
    await focused(via);

    await via.click();
    await page.keyboard.press("ArrowDown");
    await menu.getByRole("menuitemradio", { name: "AirPods Pro" }).click();
    await gone(menu);
    await focused(via);
    expect(await calls()).toEqual(["turnOff", "select:airpods"]);
    await page.context().close();
  });

  test("a dialog opened from the keyboard shows its focus ring at once; one opened by pointer waits for a key", async () => {
    const { page } = await open("consented");
    const discard = page
      .getByRole("button", { name: "Discard recording" })
      .first();
    const sheet = page.locator(".pr-sheet");

    await discard.click();
    await shown(sheet);
    expect(await sheet.getAttribute("data-kbd")).toBeNull();
    await page.keyboard.press("Tab");
    expect(await sheet.getAttribute("data-kbd")).not.toBeNull();
    await page.keyboard.press("Escape");
    await gone(sheet);

    await discard.focus();
    await page.keyboard.press("Enter");
    await shown(sheet);
    expect(await sheet.getAttribute("data-kbd")).not.toBeNull();
    await page.keyboard.press("Escape");
    await gone(sheet);

    const info = page.getByRole("button", {
      name: "Transcription modes: compare and choose",
    });
    await info.focus();
    await page.keyboard.press("Enter");
    await shown(page.getByTestId("modes-card"));
    expect(
      await page.getByTestId("modes-card").getAttribute("data-kbd"),
    ).not.toBeNull();
    await page.keyboard.press("Escape");
    await gone(page.getByTestId("modes-card"));
    await info.click();
    await shown(page.getByTestId("modes-card"));
    expect(
      await page.getByTestId("modes-card").getAttribute("data-kbd"),
    ).toBeNull();
    await page.context().close();
  });

  test("permission revoked mid-recording: Open Settings leads and the recording controls give way to Done", async () => {
    const { page, calls } = await open("consented");
    await page.evaluate(() =>
      (window as unknown as Harness).exoRecorder.patch({
        mic: { state: "needs_user", reason: "permission_revoked" },
        permissionDenied: true,
      }),
    );
    const settings = page.getByRole("button", { name: "Open Settings" });
    await shown(settings);
    await attr(
      page.getByRole("button", { name: "Done" }),
      "data-secondary",
      "true",
    );
    await gone(
      page
        .getByRole("button", { name: /Pause recording|Resume recording/ })
        .first(),
    );
    await settings.click();
    expect(await calls()).toEqual(["openSettings"]);
    await page.context().close();
  });

  test("emphasis: a write failure outlines Done; an unusable microphone outlines the input", async () => {
    const { page } = await open("consented");
    const done = page.getByRole("button", { name: "Done" });
    const via = page.getByRole("button", { name: /^Record from/ });
    await attr(done, "data-emphasis", "false");
    await attr(via, "data-emphasis", "false");

    await page.evaluate(() =>
      (window as unknown as Harness).exoRecorder.patch({
        mic: { state: "needs_user", reason: "write_failed" },
      }),
    );
    await attr(done, "data-emphasis", "true");
    await attr(via, "data-emphasis", "false");

    await page.evaluate(() =>
      (window as unknown as Harness).exoRecorder.patch({
        mic: { state: "needs_user", reason: "mic_unavailable" },
      }),
    );
    await attr(via, "data-emphasis", "true");
    await attr(done, "data-emphasis", "false");
    await page.context().close();
  });

  test("plugin failures are shown, logged, and retried: Settings, the input list, the on-device model", async () => {
    const { page, errors, calls } = await open("failing");
    const alerts = page.getByRole("alert");
    await shown(
      alerts.filter({
        hasText:
          "Could not list the audio inputs: The input list is unavailable",
      }),
    );
    await shown(
      alerts.filter({
        hasText: "Could not check the on-device model: The model check failed",
      }),
    );
    expect(
      errors.some((text) => text.includes("Could not list the audio inputs")),
    ).toBe(true);
    expect(
      errors.some((text) =>
        text.includes("Could not check the on-device model"),
      ),
    ).toBe(true);

    await page.evaluate(() => {
      const fail = (window as unknown as Harness).exoRecorder.fail;
      fail.listInputs = false;
      fail.modelStatus = false;
    });
    await alerts
      .filter({ hasText: "audio inputs" })
      .getByRole("button", { name: "Try again" })
      .click();
    await gone(alerts.filter({ hasText: "audio inputs" }));
    await alerts
      .filter({ hasText: "on-device model" })
      .getByRole("button", { name: "Try again" })
      .click();
    await gone(alerts.filter({ hasText: "on-device model" }));

    await page.evaluate(() => {
      (window as unknown as Harness).exoRecorder.patch({
        mic: { state: "needs_user", reason: "permission_revoked" },
        permissionDenied: true,
      });
    });
    await page.getByRole("button", { name: "Open Settings" }).click();
    const settingsAlert = alerts.filter({
      hasText: "Could not open Settings: Settings would not open",
    });
    await shown(settingsAlert);
    expect(
      errors.some((text) => text.includes("Could not open Settings")),
    ).toBe(true);
    await page.evaluate(() => {
      (window as unknown as Harness).exoRecorder.fail.openSettings = false;
    });
    await settingsAlert.getByRole("button", { name: "Try again" }).click();
    await gone(settingsAlert);
    expect(await calls()).toEqual(["openSettings", "openSettings"]);
    await page.context().close();
  });
});
