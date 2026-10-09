// The desktop ⚙︎ Capture settings popover (D4), driven in a real browser over a scripted DesktopCaptureExtras
// (frontend/src/harness/screens/captureSettings.tsx): open and close, the model radiogroup's keys, a download
// from Get to selectable (and a failed one), a download already under way elsewhere, the two switches, and
// where focus goes.
//
//   EXO_UI_ENGINE=webkit   run it in WebKit instead (default: chromium)
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

const engine = process.env.EXO_UI_ENGINE === "webkit" ? webkit : chromium;

setDefaultTimeout(30_000);

let browser: Browser;
let server: ReturnType<typeof serveHarness>;

type Harness = {
  exoCaptureSettings: {
    calls: string[];
    startExternalDownload: (id: string, fraction?: number | null) => void;
    emitProgress: (id: string, fraction: number) => void;
    finishDownload: (id: string) => void;
    failDownload: (id: string, message: string) => void;
    failNext: (call: string, message: string) => void;
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

// Console errors fail a test, except the ones it says it causes on purpose (a refused call is logged by the
// component, as it should be). Nothing else is let through.
async function open(
  expected: RegExp[] = [],
  screen = "capture-settings-interactive",
) {
  const page = await (
    await browser.newContext({
      viewport: { width: 1280, height: 800 },
      reducedMotion: "reduce",
    })
  ).newPage();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().startsWith("Failed to load resource") &&
      !message.text().startsWith("Viewport argument key") &&
      !expected.some((pattern) => pattern.test(message.text()))
    )
      errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(
    `http://127.0.0.1:${server.port}/?screen=${screen}&theme=light&platform=web`,
  );
  const gear = page.getByRole("button", { name: "Capture settings" });
  await gear.waitFor({ state: "visible" });
  return {
    page,
    errors,
    gear,
    dialog: page.getByRole("dialog", { name: "Capture settings" }),
    calls: () =>
      page.evaluate(() =>
        (window as unknown as Harness).exoCaptureSettings.calls.slice(),
      ),
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
const focused = (locator: Locator) =>
  until(`${locator} to have focus`, () =>
    locator.evaluate((el) => el === document.activeElement),
  );
const attr = (locator: Locator, name: string, value: string) =>
  until(
    `${name}="${value}"`,
    async () => (await locator.getAttribute(name)) === value,
  );
const script = <A extends unknown[]>(
  page: Page,
  call:
    | "startExternalDownload"
    | "emitProgress"
    | "finishDownload"
    | "failDownload"
    | "failNext",
  ...args: A
) =>
  page.evaluate(
    ([name, rest]) =>
      (
        (window as unknown as Harness).exoCaptureSettings[
          name as "emitProgress"
        ] as (...a: unknown[]) => void
      )(...(rest as unknown[])),
    [call, args] as const,
  );

const CAUSED_DOWNLOAD_ERROR = /^\[CaptureSettings\] Could not download the model/;
const CAUSED_SETTING_ERROR = /^\[CaptureSettings\] Could not change the setting/;

const model = (dialog: Locator, label: string) =>
  dialog.getByRole("radio", {
    name: new RegExp(`^${label.replace(/[()]/g, "\\$&")}`),
  });

describe.serial(`capture settings (${engine.name()})`, () => {
  test("opens from the gear with a labelled dialog, focus on the selected model; Escape closes and returns focus", async () => {
    const { page, errors, gear, dialog } = await open();
    await attr(gear, "aria-expanded", "false");
    await gear.click();
    await dialog.waitFor({ state: "visible" });
    await attr(gear, "aria-expanded", "true");
    await dialog.getByRole("radiogroup").waitFor();
    await focused(model(dialog, "Whisper Tiny (English)"));
    expect(await dialog.getByText("Shortcuts").count()).toBe(0);

    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    await attr(gear, "aria-expanded", "false");
    await focused(gear);
    expect(errors).toEqual([]);
    await page.context().close();
  });

  test("a click outside closes it and returns focus to the gear; Tab stays inside it", async () => {
    const { page, errors, gear, dialog } = await open();
    await gear.click();
    await dialog.getByRole("radiogroup").waitFor();
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press("Tab");
      expect(
        await dialog.evaluate((el) => el.contains(document.activeElement)),
      ).toBe(true);
    }
    await page.getByRole("heading", { name: "Capture" }).click();
    await dialog.waitFor({ state: "hidden" });
    await attr(gear, "aria-expanded", "false");
    await focused(gear);
    expect(errors).toEqual([]);
    await page.context().close();
  });

  test("a click outside on another control leaves focus on that control", async () => {
    const { page, errors, gear, dialog } = await open();
    await gear.click();
    await dialog.getByRole("radiogroup").waitFor();
    const field = page.getByRole("textbox", { name: "Find a note" });
    await field.click();
    await dialog.waitFor({ state: "hidden" });
    await focused(field);
    expect(errors).toEqual([]);
    await page.context().close();
  });

  test("the model radiogroup holds only downloaded models: arrows move focus and select, wrapping; Space selects; Tab leaves it", async () => {
    const { page, errors, gear, dialog, calls } = await open();
    await gear.click();
    const group = dialog.getByRole("radiogroup");
    await group.waitFor();
    const tiny = model(dialog, "Whisper Tiny (English)");
    const base = model(dialog, "Whisper Base (English)");
    const selects = async () =>
      (await calls()).filter((call) => call.startsWith("models.select"));

    // Two models are on disk, so two radios; the other five are outside the group, each with a Get.
    expect(await group.getByRole("radio").count()).toBe(2);
    expect(await group.getByRole("button").count()).toBe(0);
    const rest = dialog.getByRole("group", { name: "Available to download" });
    expect(await rest.getByRole("button", { name: /^Get / }).count()).toBe(5);
    expect(await rest.getByRole("radio").count()).toBe(0);
    await focused(tiny);
    await attr(tiny, "aria-checked", "true");

    await page.keyboard.press("ArrowDown");
    await focused(base);
    await attr(base, "aria-checked", "true");
    await attr(tiny, "aria-checked", "false");
    await attr(base, "tabindex", "0");
    await attr(tiny, "tabindex", "-1");
    expect(await selects()).toEqual(["models.select:QuantizedBaseEn"]);

    // Wrapping, both ways; Left/Right work like Up/Down.
    await page.keyboard.press("ArrowDown");
    await focused(tiny);
    await attr(tiny, "aria-checked", "true");
    await page.keyboard.press("ArrowUp");
    await focused(base);
    await attr(base, "aria-checked", "true");
    await page.keyboard.press("ArrowLeft");
    await focused(tiny);
    await page.keyboard.press("ArrowRight");
    await focused(base);
    await attr(base, "aria-checked", "true");

    // Space checks the focused radio.
    await tiny.focus();
    await attr(tiny, "aria-checked", "false");
    await page.keyboard.press("Space");
    await attr(tiny, "aria-checked", "true");
    await attr(base, "aria-checked", "false");

    // Tab leaves the group (the next stop is the first Get, not another radio); Shift+Tab returns to the checked radio.
    await page.keyboard.press("Tab");
    await focused(
      dialog.getByRole("button", { name: "Get Whisper Tiny (multilingual)" }),
    );
    await page.keyboard.press("ArrowDown");
    await focused(
      dialog.getByRole("button", { name: "Get Whisper Tiny (multilingual)" }),
    );
    await page.keyboard.press("Shift+Tab");
    await focused(tiny);
    expect(errors).toEqual([]);
    await page.context().close();
  });

  test("keyboard Get: focus goes to the row's progress, then to its new radio, which is not selected; the arrows carry on from it", async () => {
    const { page, errors, gear, dialog, calls } = await open();
    await gear.click();
    const group = dialog.getByRole("radiogroup");
    await group.waitFor();
    const small = dialog.getByRole("button", {
      name: "Get Whisper Small (English)",
    });
    await small.focus();
    await page.keyboard.press("Enter");
    const bar = dialog.getByRole("progressbar", {
      name: "Whisper Small (English) download",
    });
    await bar.waitFor();
    await focused(bar);
    await attr(bar, "aria-valuenow", "0");

    await script(page, "emitProgress", "QuantizedSmallEn", 0.4);
    await attr(bar, "aria-valuenow", "40");
    await attr(bar, "aria-valuetext", "Downloading, 40%");
    expect(await dialog.getByText("40%").count()).toBe(1);
    await focused(bar);

    await script(page, "finishDownload", "QuantizedSmallEn");
    const radio = model(dialog, "Whisper Small (English)");
    await focused(radio);
    await bar.waitFor({ state: "hidden" });
    expect(await group.getByRole("radio").count()).toBe(3);
    await attr(radio, "aria-checked", "false");
    await attr(model(dialog, "Whisper Tiny (English)"), "aria-checked", "true");
    expect(await calls()).not.toContain("models.select:QuantizedSmallEn");
    await dialog
      .getByRole("status")
      .filter({ hasText: "Whisper Small (English) downloaded" })
      .waitFor();

    // The new radio is a member of the group: the arrows reach it and select it.
    await page.keyboard.press("ArrowUp");
    await focused(model(dialog, "Whisper Base (English)"));
    await page.keyboard.press("ArrowDown");
    await focused(radio);
    await attr(radio, "aria-checked", "true");
    expect(errors).toEqual([]);
    await page.context().close();
  });

  test("a download finishing while focus is elsewhere does not take focus", async () => {
    const { page, errors, gear, dialog } = await open();
    await gear.click();
    await dialog.getByRole("radiogroup").waitFor();
    await dialog
      .getByRole("button", { name: "Get Whisper Small (English)" })
      .click();
    const bar = dialog.getByRole("progressbar", {
      name: "Whisper Small (English) download",
    });
    await focused(bar);
    const tiny = model(dialog, "Whisper Tiny (English)");
    await tiny.focus();
    await script(page, "finishDownload", "QuantizedSmallEn");
    await model(dialog, "Whisper Small (English)").waitFor();
    await focused(tiny);
    expect(errors).toEqual([]);
    await page.context().close();
  });

  test("a failed download moves focus to Retry and says so on its row; Retry starts it again and focus follows to the progress", async () => {
    const { page, errors, gear, dialog } = await open([CAUSED_DOWNLOAD_ERROR]);
    await gear.click();
    const get = dialog.getByRole("button", {
      name: "Get Whisper Tiny (multilingual)",
    });
    await get.focus();
    await page.keyboard.press("Enter");
    const bar = dialog.getByRole("progressbar", {
      name: "Whisper Tiny (multilingual) download",
    });
    await focused(bar);
    await script(page, "failDownload", "QuantizedTiny", "The network dropped");
    await dialog
      .getByText(
        "Could not download Whisper Tiny (multilingual): The network dropped",
      )
      .waitFor();
    const retry = dialog.getByRole("button", {
      name: "Retry Whisper Tiny (multilingual)",
    });
    await focused(retry);
    await page.keyboard.press("Enter");
    await bar.waitFor();
    await focused(bar);
    expect(await dialog.getByText("The network dropped").count()).toBe(0);
    expect(errors).toEqual([]);
    await page.context().close();
  });

  test("opened during a download started elsewhere: progress, not Get; finished elsewhere, it becomes a radio", async () => {
    const { page, errors, gear, dialog, calls } = await open();
    await script(page, "startExternalDownload", "QuantizedBase", 0.3);
    await gear.click();
    const bar = dialog.getByRole("progressbar", {
      name: "Whisper Base (multilingual) download",
    });
    await bar.waitFor();
    await attr(bar, "aria-valuenow", "30");
    expect(
      await dialog
        .getByRole("button", { name: "Get Whisper Base (multilingual)" })
        .count(),
    ).toBe(0);

    await script(page, "emitProgress", "QuantizedBase", 0.7);
    await attr(bar, "aria-valuenow", "70");
    await script(page, "finishDownload", "QuantizedBase");
    const base = model(dialog, "Whisper Base (multilingual)");
    await base.waitFor();
    await bar.waitFor({ state: "hidden" });
    await dialog
      .getByRole("status")
      .filter({ hasText: "Whisper Base (multilingual) downloaded" })
      .waitFor();

    await base.click();
    await attr(base, "aria-checked", "true");
    expect(await calls()).not.toContain("models.download:QuantizedBase");
    expect(await calls()).toContain("models.select:QuantizedBase");
    expect(errors).toEqual([]);
    await page.context().close();
  });

  test("a download that fails elsewhere shows the error on its row, and Retry is offered", async () => {
    const { page, errors, gear, dialog } = await open();
    await script(page, "startExternalDownload", "QuantizedSmall", 0.2);
    await gear.click();
    await dialog
      .getByRole("progressbar", {
        name: "Whisper Small (multilingual) download",
      })
      .waitFor();
    await script(page, "failDownload", "QuantizedSmall", "The disk is full");
    await dialog
      .getByText(
        "Could not download Whisper Small (multilingual): The disk is full",
      )
      .waitFor();
    await dialog
      .getByRole("button", { name: "Retry Whisper Small (multilingual)" })
      .waitFor();
    expect(errors).toEqual([]);
    await page.context().close();
  });

  test("nothing downloaded: one line instead of a radiogroup, Tab reaches the first Get, and keyboard Get ends on the new radio", async () => {
    const { page, errors, gear, dialog, calls } = await open(
      [],
      "capture-settings-interactive-none",
    );
    await gear.click();
    await dialog.getByText("No model on this Mac yet. Get one below.").waitFor();
    expect(await dialog.getByRole("radiogroup").count()).toBe(0);
    expect(await dialog.getByRole("radio").count()).toBe(0);
    const rest = dialog.getByRole("group", { name: "Available to download" });
    expect(await rest.getByRole("button", { name: /^Get / }).count()).toBe(7);

    // The popover itself holds focus; the first Tab goes straight to the first Get.
    await focused(dialog);
    await page.keyboard.press("Tab");
    const first = dialog.getByRole("button", { name: "Get Whisper Tiny (English)" });
    await focused(first);
    await page.keyboard.press("Enter");
    const bar = dialog.getByRole("progressbar", {
      name: "Whisper Tiny (English) download",
    });
    await focused(bar);
    await script(page, "finishDownload", "QuantizedTinyEn");

    const radio = model(dialog, "Whisper Tiny (English)");
    await focused(radio);
    expect(await dialog.getByRole("radiogroup").getByRole("radio").count()).toBe(1);
    expect(await dialog.getByText("No model on this Mac yet.").count()).toBe(0);
    // Not selected for you, yet it holds the tab stop as the first radio of an unchecked group.
    await attr(radio, "aria-checked", "false");
    await attr(radio, "tabindex", "0");
    expect(await calls()).not.toContain("models.select:QuantizedTinyEn");
    await dialog
      .getByRole("status")
      .filter({ hasText: "Whisper Tiny (English) downloaded" })
      .waitFor();
    await page.keyboard.press("Space");
    await attr(radio, "aria-checked", "true");
    expect(errors).toEqual([]);
    await page.context().close();
  });

  test("the two switches toggle through the extras; a refused one shows why and keeps its value", async () => {
    const { page, errors, gear, dialog, calls } = await open([
      CAUSED_SETTING_ERROR,
    ]);
    await gear.click();
    const system = dialog.getByRole("switch", {
      name: "Also record this Mac’s audio",
    });
    const save = dialog.getByRole("switch", {
      name: "Save to your space automatically",
    });
    await system.waitFor();
    await attr(system, "aria-checked", "false");
    await attr(save, "aria-checked", "true");

    await system.click();
    await attr(system, "aria-checked", "true");
    await save.click();
    await attr(save, "aria-checked", "false");
    expect(await calls()).toEqual(
      expect.arrayContaining([
        "systemAudio.set:true",
        "autoSaveToSpace.set:false",
      ]),
    );

    await script(page, "failNext", "systemAudio.set", "macOS refused");
    await system.click();
    await dialog
      .getByText("Could not change this setting: macOS refused")
      .waitFor();
    await attr(system, "aria-checked", "true");
    expect(errors).toEqual([]);
    await page.context().close();
  });
});
