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
async function open(expected: RegExp[] = []) {
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
    `http://127.0.0.1:${server.port}/?screen=capture-settings-interactive&theme=light&platform=web`,
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

  test("the model radiogroup: arrows move focus and select, wrapping; Space selects; models not on disk are never selected", async () => {
    const { page, errors, gear, dialog, calls } = await open();
    await gear.click();
    await dialog.getByRole("radiogroup").waitFor();
    const tiny = model(dialog, "Whisper Tiny (English)");
    const base = model(dialog, "Whisper Base (English)");
    const get = (label: string) =>
      dialog.getByRole("button", { name: `Get ${label}` });
    const selects = async () =>
      (await calls()).filter((call) => call.startsWith("models.select"));

    // Get Base (English); then Tiny (English) and Base (English) are on disk, the rest are not.
    await get("Whisper Base (English)").click();
    await script(page, "finishDownload", "QuantizedBaseEn");
    await attr(base, "aria-disabled", "false");
    await focused(tiny);
    await attr(tiny, "tabindex", "0");
    await attr(base, "tabindex", "-1");

    // Arrow onto a model that is not on disk: its Get takes focus, nothing is selected, the tab stop stays.
    await page.keyboard.press("ArrowDown");
    await focused(get("Whisper Tiny (multilingual)"));
    expect(await selects()).toEqual([]);
    await attr(tiny, "aria-checked", "true");
    await attr(tiny, "tabindex", "0");

    // On to a model on disk: it takes focus and the selection, and the tab stop follows.
    await page.keyboard.press("ArrowDown");
    await focused(base);
    await attr(base, "aria-checked", "true");
    await attr(tiny, "aria-checked", "false");
    await attr(base, "tabindex", "0");
    await attr(tiny, "tabindex", "-1");
    expect(await selects()).toEqual(["models.select:QuantizedBaseEn"]);

    // Back up, through the Get, to Tiny (English).
    await page.keyboard.press("ArrowUp");
    await focused(get("Whisper Tiny (multilingual)"));
    await page.keyboard.press("ArrowUp");
    await focused(tiny);
    await attr(tiny, "aria-checked", "true");
    await attr(base, "aria-checked", "false");

    // Wrapping: up from the first row reaches the last (Large Turbo, not on disk), down from there the first.
    await page.keyboard.press("ArrowUp");
    await focused(get("Whisper Large Turbo"));
    await page.keyboard.press("ArrowDown");
    await focused(tiny);
    await attr(tiny, "aria-checked", "true");

    // Space selects the focused model; on one that is not on disk it goes to its Get instead.
    await base.focus();
    await page.keyboard.press("Space");
    await attr(base, "aria-checked", "true");
    await model(dialog, "Whisper Small (English)").focus();
    await page.keyboard.press("Space");
    await focused(get("Whisper Small (English)"));
    expect(await selects()).not.toContain("models.select:QuantizedSmallEn");
    await attr(base, "aria-checked", "true");

    // Tab out and Shift+Tab back lands on the selected model.
    await base.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await focused(base);
    expect(errors).toEqual([]);
    await page.context().close();
  });

  test("Get shows progress, then the model is selectable", async () => {
    const { page, gear, dialog, calls } = await open();
    await gear.click();
    const small = model(dialog, "Whisper Small (English)");
    await small.waitFor();
    await attr(small, "aria-disabled", "true");

    await dialog
      .getByRole("button", { name: "Get Whisper Small (English)" })
      .click();
    const bar = dialog.getByRole("progressbar", {
      name: "Downloading Whisper Small (English)",
    });
    await bar.waitFor();
    await script(page, "emitProgress", "QuantizedSmallEn", 0.4);
    await attr(bar, "aria-valuenow", "40");
    expect(await dialog.getByText("40%").count()).toBe(1);
    await script(page, "finishDownload", "QuantizedSmallEn");
    await bar.waitFor({ state: "hidden" });
    await attr(small, "aria-disabled", "false");
    expect(
      await dialog
        .getByRole("button", { name: "Get Whisper Small (English)" })
        .count(),
    ).toBe(0);

    await small.click();
    await attr(small, "aria-checked", "true");
    expect(await calls()).toContain("models.download:QuantizedSmallEn");
    expect(await calls()).toContain("models.select:QuantizedSmallEn");
    await page.context().close();
  });

  test("a failed download says so on its row, and Retry starts it again", async () => {
    const { page, errors, gear, dialog } = await open([CAUSED_DOWNLOAD_ERROR]);
    await gear.click();
    await dialog
      .getByRole("button", { name: "Get Whisper Tiny (multilingual)" })
      .click();
    await script(page, "failDownload", "QuantizedTiny", "The network dropped");
    await dialog
      .getByText(
        "Could not download Whisper Tiny (multilingual): The network dropped",
      )
      .waitFor();
    await dialog
      .getByRole("button", { name: "Retry Whisper Tiny (multilingual)" })
      .click();
    await dialog
      .getByRole("progressbar", {
        name: "Downloading Whisper Tiny (multilingual)",
      })
      .waitFor();
    expect(await dialog.getByText("The network dropped").count()).toBe(0);
    expect(errors).toEqual([]);
    await page.context().close();
  });

  test("opened during a download started elsewhere: progress, not Get; finished elsewhere, it becomes selectable", async () => {
    const { page, errors, gear, dialog, calls } = await open();
    await script(page, "startExternalDownload", "QuantizedBase", 0.3);
    await gear.click();
    const bar = dialog.getByRole("progressbar", {
      name: "Downloading Whisper Base (multilingual)",
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
    await attr(base, "aria-disabled", "false");
    await bar.waitFor({ state: "hidden" });

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
        name: "Downloading Whisper Small (multilingual)",
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
