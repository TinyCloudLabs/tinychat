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

type NativeHarness = {
  exoNative: { calls: string[]; fail: Record<string, boolean> };
};

type Harness = {
  exoRecorder: {
    calls: string[];
    patch: (patch: object) => void;
    fail: Record<string, boolean>;
    transcriberResult: string | null;
    patchTranscriber: (patch: object) => void;
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
  name: "consented" | "first-run" | "failing" | "native",
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
  const screenName = `recorder-final-phone-interactive-${name}`;
  await page.goto(
    `http://127.0.0.1:${server.port}/?screen=${screenName}&theme=light&platform=ios`,
  );
  // Fail inside bun's 30 s test timeout: past it bun kills the browser and every later test reports a closed context.
  page.setDefaultTimeout(10_000);
  await page.waitForSelector("[data-testid=phone-recorder]").catch((caught) => {
    throw new Error(
      `${screenName} did not render: ${caught instanceof Error ? caught.message : String(caught)}\npage errors: ${JSON.stringify(errors)}`,
    );
  });
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

  test("the slider moves with the arrow keys; leaving Private asks the provider for Local for this recording only", async () => {
    const { page, calls } = await open("consented");
    await modeIs(page, "Private");
    await slider(page).focus();
    await page.keyboard.press("ArrowLeft");
    await modeIs(page, "Local");
    expect(await calls()).toEqual(["transcriber:on-device:recording"]);
    expect(await storedMode(page)).toBeNull();
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
    await modeIs(page, "Audio only");
    expect(await calls()).toEqual(["transcriber:off:recording"]);

    await page.mouse.move(box.x + 12, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 12, y, { steps: 6 });
    await page.mouse.up();
    await modeIs(page, "Audio only");
    await shown(page.getByText("Coming with the next update").first());
    await page.context().close();
  });

  test("first run: the scale shows the provider's mode; Private waits on consent, then asks again", async () => {
    const { page, calls, activeName } = await open("first-run");
    await modeIs(page, "Audio only");
    await shown(page.getByText("Just the recording, kept on this phone."));

    await slider(page).focus();
    await page.keyboard.press("ArrowRight");
    await modeIs(page, "Local");
    await page.keyboard.press("ArrowRight");
    const dialog = page.getByRole("dialog", { name: "Use private cloud?" });
    await shown(dialog);
    expect(await activeName()).toBe("Use private cloud");
    await modeIs(page, "Local");
    expect(await calls()).toEqual([
      "transcriber:on-device:recording",
      "transcriber:private-cloud:recording",
    ]);

    await page.getByRole("button", { name: "Use private cloud" }).click();
    await modeIs(page, "Private");
    await gone(dialog);
    await focused(slider(page));
    expect(await calls()).toEqual([
      "transcriber:on-device:recording",
      "transcriber:private-cloud:recording",
      "consent",
      "transcriber:private-cloud:recording",
    ]);
    expect(await storedMode(page)).toBeNull();
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
    expect((await calls()).filter((c) => c === "consent")).toEqual([]);
    await modeIs(page, "Local");

    await page.keyboard.press("ArrowRight");
    await shown(dialog);
    await page.getByRole("button", { name: "Use private cloud" }).click();
    await gone(dialog);
    await focused(slider(page));
    expect((await calls()).filter((c) => c === "consent")).toEqual(["consent"]);
    await page.context().close();
  });

  test("the scale always shows the provider's transcriber, including when it changes from outside while mounted", async () => {
    const { page, calls } = await open("consented");
    await modeIs(page, "Private");
    for (const [id, label] of [
      ["off", "Audio only"],
      ["on-device", "Local"],
      ["private-cloud", "Private"],
    ] as const) {
      await page.evaluate(
        (next) =>
          (window as unknown as Harness).exoRecorder.patchTranscriber({
            id: next,
          }),
        id,
      );
      await modeIs(page, label);
    }
    expect(await calls()).toEqual([]);
    await page.context().close();
  });

  test("the provider can refuse: a toast says why, the scale stays where the provider is, and the failure is logged", async () => {
    const { page, errors } = await open("consented");
    await page.evaluate(() => {
      (window as unknown as Harness).exoRecorder.transcriberResult =
        "unavailable";
    });
    await slider(page).focus();
    await page.keyboard.press("ArrowLeft");
    await shown(page.getByText("Local isn't available right now").first());
    await modeIs(page, "Private");
    expect(errors.some((text) => text.includes("cannot use on-device"))).toBe(
      true,
    );
    await page.context().close();
  });

  test("signed out: Local is selected and the other stops say why they are off, from the account's state alone", async () => {
    const { page } = await open("consented");
    const stops = () =>
      page
        .locator("[data-available]")
        .evaluateAll((all) =>
          all.map((stop) => stop.getAttribute("data-available")),
        );
    await page.evaluate(() => {
      const recorder = (window as unknown as Harness).exoRecorder;
      recorder.patchTranscriber({ id: "on-device" });
      recorder.patch({ signedIn: false });
    });
    await modeIs(page, "Local");
    expect(await stops()).toEqual(["false", "true", "false", "false"]);
    await page
      .getByRole("button", { name: "Transcription modes: compare and choose" })
      .click();
    await shown(page.getByText("Sign in to choose another mode").first());
    await page.keyboard.press("Escape");
    await page.evaluate(() =>
      (window as unknown as Harness).exoRecorder.patch({ signedIn: true }),
    );
    await until(
      "the stops to open after sign-in",
      async () =>
        (await stops()).join() === ["true", "true", "true", "false"].join(),
    );
    await page.context().close();
  });

  test("a locked_signed_out answer is feedback only: a toast, and the stops follow the account", async () => {
    const { page } = await open("consented");
    await page.evaluate(() => {
      (window as unknown as Harness).exoRecorder.transcriberResult =
        "locked_signed_out";
    });
    await slider(page).focus();
    await page.keyboard.press("ArrowLeft");
    await shown(page.getByText("Sign in to choose another mode").first());
    const available = await page
      .locator("[data-available]")
      .evaluateAll((stops) =>
        stops.map((stop) => stop.getAttribute("data-available")),
      );
    expect(available).toEqual(["true", "true", "true", "false"]);
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
    expect(await calls()).toEqual([
      "transcriber:on-device:recording",
      "select:airpods",
    ]);
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
    // Generic copy; the cause is only logged, never shown (E1 iOS F1).
    const settingsAlert = alerts.filter({
      hasText: "Couldn't open Settings. Open Settings › Exo › Microphone.",
    });
    await shown(settingsAlert);
    expect(await settingsAlert.textContent()).not.toContain("Settings would not open");
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
  describe("a rejected recorder control is shown, logged, and retried (the real controller on the fake plugin)", () => {
    const failing = (page: Page, name: string, on: boolean) =>
      page.evaluate(
        ([key, value]) => {
          (window as unknown as NativeHarness).exoNative.fail[key as string] =
            value as boolean;
        },
        [name, on],
      );
    const nativeCalls = (page: Page) =>
      page.evaluate(() =>
        (window as unknown as NativeHarness).exoNative.calls.slice(),
      );
    const recording = async (page: Page) => {
      await control(page, "Pause recording").waitFor({
        state: "visible",
        timeout: 10_000,
      });
      await attr(page.getByTestId("phone-recorder"), "data-ring", "live");
    };
    const control = (page: Page, label: string) =>
      page.locator(`.pr-controls button[aria-label="${label}"]`);
    const enabled = (locator: Locator) =>
      until(`${locator} to be enabled`, () => locator.isEnabled());
    const logged = (errors: string[], what: string) =>
      until(`console.error "${what}"`, async () =>
        errors.some((text) => text.includes(what)),
      );

    test("Pause: the alert names the failure, Pause stays enabled, and retrying clears it", async () => {
      const { page, errors } = await open("native");
      await recording(page);
      const alert = page.getByRole("alert");
      const pause = control(page, "Pause recording");
      await failing(page, "pause", true);
      await pause.click();
      await shown(
        alert.filter({ hasText: "Could not pause: pause was refused" }),
      );
      await logged(errors, "[Recorder] pause failed");
      await enabled(pause);
      await attr(page.getByTestId("phone-recorder"), "data-ring", "live");
      await failing(page, "pause", false);
      await pause.click();
      await gone(alert);
      await shown(control(page, "Resume recording"));
      await page.context().close();
    });

    test("Resume: the alert names the failure, Resume stays enabled, and retrying clears it", async () => {
      const { page, errors } = await open("native");
      await recording(page);
      await control(page, "Pause recording").click();
      const resume = control(page, "Resume recording");
      await shown(resume);
      const alert = page.getByRole("alert");
      await failing(page, "resume", true);
      await resume.click();
      await shown(
        alert.filter({ hasText: "Could not resume: resume was refused" }),
      );
      await logged(errors, "[Recorder] resume failed");
      await enabled(resume);
      await failing(page, "resume", false);
      await resume.click();
      await gone(alert);
      await shown(control(page, "Pause recording"));
      await page.context().close();
    });

    test("Done: the alert names the failure, the recording goes on, and Done tries again", async () => {
      const { page, errors } = await open("native");
      await recording(page);
      const alert = page.getByRole("alert");
      const done = page.getByRole("button", { name: "Done" });
      await failing(page, "stop", true);
      await done.click();
      await shown(
        alert.filter({ hasText: "Could not stop: stop was refused" }),
      );
      await logged(errors, "[Recorder] stop failed");
      await enabled(done);
      await attr(page.getByTestId("phone-recorder"), "data-ring", "live");
      await failing(page, "stop", false);
      await done.click();
      await gone(alert.filter({ hasText: "Could not stop" }));
      expect((await nativeCalls(page)).filter((c) => c === "stop")).toEqual([
        "stop",
        "stop",
      ]);
      await page.context().close();
    });

    test("Discard: the sheet closes, the alert shows, the recording clearly goes on, and Discard tries again", async () => {
      const { page, errors } = await open("native");
      await recording(page);
      const alert = page.getByRole("alert");
      const discard = control(page, "Discard recording");
      await failing(page, "discard", true);
      await discard.click();
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: "Discard recording" })
        .click();
      await gone(page.getByRole("alertdialog"));
      await shown(
        alert.filter({
          hasText: "Could not discard the recording: discard was refused",
        }),
      );
      await logged(errors, "[Recorder] discard failed");
      await attr(page.getByTestId("phone-recorder"), "data-ring", "live");
      await enabled(page.getByRole("button", { name: "Done" }));
      await enabled(control(page, "Pause recording"));
      await enabled(discard);
      await failing(page, "discard", false);
      await discard.click();
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: "Discard recording" })
        .click();
      await gone(alert);
      expect((await nativeCalls(page)).filter((c) => c === "discard")).toEqual([
        "discard",
        "discard",
      ]);
      await page.context().close();
    });
  });
});

type RouteHarness = {
  exoRoute: {
    calls: string[];
    rejectSetter: boolean;
    rejectConsent: boolean;
  };
};

describe.serial(`default recorder route control (${engineName})`, () => {
  async function openRoute() {
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
    await page.goto(
      `http://127.0.0.1:${server.port}/?screen=recorder-final-phone-interactive-route-control&theme=light&platform=ios`,
    );
    await page.waitForSelector("[data-testid=transcription-route]");
    const selected = () =>
      page.getByRole("radio", { checked: true }).first().textContent();
    return { page, errors, selected };
  }

  test("a rejected setter shows an alert naming the mode, logs it, and leaves the selection with the provider", async () => {
    const { page, errors, selected } = await openRoute();
    await page.evaluate(() => {
      (window as unknown as RouteHarness).exoRoute.rejectSetter = true;
    });
    await page.getByRole("radio", { name: "Off" }).click();
    const alert = page.getByRole("alert");
    await shown(alert);
    expect(await alert.textContent()).toBe(
      "Could not change the transcription to Off: Plugin is down",
    );
    expect(await selected()).toBe("On this phone");
    expect(errors.some((text) => text.includes("Could not change"))).toBe(true);
    await page.context().close();
  });

  test("through the consent question the selection stays the provider's, and a rejected consent shows the alert", async () => {
    const { page, selected } = await openRoute();
    await page.getByRole("radio", { name: "Private cloud" }).click();
    await shown(page.getByTestId("voice-note-transcription-consent"));
    expect(await selected()).toBe("On this phone");
    await page.evaluate(() => {
      (window as unknown as RouteHarness).exoRoute.rejectConsent = true;
    });
    await page.getByTestId("voice-note-transcription-enable").click();
    const alert = page.getByRole("alert");
    await shown(alert);
    expect(await alert.textContent()).toBe(
      "Could not change the transcription to Private cloud: Consent was not saved",
    );
    expect(await selected()).toBe("On this phone");
    expect(
      await page.evaluate(
        () => (window as unknown as RouteHarness).exoRoute.calls,
      ),
    ).toEqual(["consent"]);
    await page.context().close();
  });
});
