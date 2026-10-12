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
import { mkdirSync } from "node:fs";
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
    downloadCalls?: number[];
    deferModelStatus?: boolean;
    releaseModelStatus?: () => void;
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
  name:
    | "consented"
    | "first-run"
    | "failing"
    | "native"
    | "model-unavailable"
    | "model-unavailable-first-run"
    | "permission-denied",
  options: { clock?: boolean; theme?: "light" | "dark" } = {},
): Promise<Opened> {
  const page = await (
    await browser.newContext({
      viewport: { width: 390, height: 844 },
      reducedMotion: "reduce",
    })
  ).newPage();
  if (options.clock) await page.clock.install();
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
    `http://127.0.0.1:${server.port}/?screen=${screenName}&theme=${options.theme ?? "light"}&platform=ios`,
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
const setFontScale = (page: Page, scale: number) =>
  page.evaluate((nextScale) => {
    for (const element of document.querySelectorAll<HTMLElement>(
      "[data-font-base]",
    )) {
      element.style.removeProperty("font-size");
      element.removeAttribute("data-font-base");
    }
    if (nextScale === 1) return;
    const elements = [...document.querySelectorAll<HTMLElement>("*")];
    const sizes = elements.map((element) =>
      Number.parseFloat(getComputedStyle(element).fontSize),
    );
    elements.forEach((element, index) => {
      const base = sizes[index]!;
      element.dataset.fontBase = String(base);
      element.style.fontSize = `${base * nextScale}px`;
    });
  }, scale);
const setToastFontScale = (page: Page, scale: number) =>
  page.evaluate((nextScale) => {
    const elements = [
      ...document.querySelectorAll<HTMLElement>(".pr-toast, .pr-toast *"),
    ];
    const sizes = elements.map((element) =>
      Number.parseFloat(getComputedStyle(element).fontSize),
    );
    elements.forEach((element, index) => {
      element.style.fontSize = `${sizes[index]! * nextScale}px`;
    });
  }, scale);
const settleToastPlacement = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
const assertToastMessageVisible = async (
  page: Page,
  expected: string,
  requiredActions: string[] = [],
) => {
  const message = page.locator(".pr-toast-message");
  await shown(message);
  const layout = await message.evaluate((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      text: element.textContent,
      width: rect.width,
      height: rect.height,
      fontSize: Number.parseFloat(style.fontSize),
      clientWidth: element.clientWidth,
      clientHeight: element.clientHeight,
      scrollWidth: element.scrollWidth,
      scrollHeight: element.scrollHeight,
      whiteSpace: style.whiteSpace,
      textOverflow: style.textOverflow,
      overflow: style.overflow,
      clipPath: style.clipPath,
      lineCount: (() => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return new Set(
          [...range.getClientRects()].map(({ top }) => Math.round(top)),
        ).size;
      })(),
    };
  });
  expect(layout.text).toBe(expected);
  expect(layout.width).toBeGreaterThan(1);
  expect(layout.height).toBeGreaterThan(layout.fontSize * 0.9);
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
  expect(layout.whiteSpace).not.toBe("nowrap");
  expect(layout.textOverflow).not.toBe("ellipsis");
  expect(layout.overflow).toBe("visible");
  expect(layout.clipPath).toBe("none");
  expect(layout.lineCount).toBeGreaterThanOrEqual(1);
  const toast = await page.locator(".pr-toast").boundingBox();
  const copy = await page.locator(".pr-toast-copy").evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      overflowY: style.overflowY,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      minHeight: Number.parseFloat(style.minHeight),
    };
  });
  expect(copy.overflowY).toBe("auto");
  expect(copy.clientHeight).toBeGreaterThan(0);
  expect(copy.clientHeight).toBeGreaterThanOrEqual(copy.minHeight - 1);
  expect(copy.scrollHeight).toBeGreaterThanOrEqual(copy.clientHeight);
  expect(
    await page.getByRole("region", { name: "Notification message" }).count(),
  ).toBe(1);
  const toastButtons = await page
    .locator(".pr-toast")
    .getByRole("button")
    .all();
  for (const button of toastButtons) {
    const buttonBox = await button.boundingBox();
    expect(buttonBox).not.toBeNull();
    expect(buttonBox!.x).toBeGreaterThanOrEqual(toast!.x);
    expect(buttonBox!.y).toBeGreaterThanOrEqual(toast!.y);
    expect(buttonBox!.x + buttonBox!.width).toBeLessThanOrEqual(
      toast!.x + toast!.width,
    );
    expect(buttonBox!.y + buttonBox!.height).toBeLessThanOrEqual(
      toast!.y + toast!.height,
    );
  }
  const viewport = page.viewportSize()!;
  expect(toast).not.toBeNull();
  expect(toast!.x).toBeGreaterThanOrEqual(0);
  expect(toast!.y).toBeGreaterThanOrEqual(0);
  expect(toast!.x + toast!.width).toBeLessThanOrEqual(viewport.width);
  expect(toast!.y + toast!.height).toBeLessThanOrEqual(viewport.height);
  for (const name of requiredActions) {
    const action = page.locator(".pr-toast").getByRole("button", { name });
    expect(await action.count()).toBe(1);
    await shown(action);
  }
  for (const name of ["Get model", "Use Private"]) {
    const action = page.locator(".pr-toast").getByRole("button", { name });
    if (await action.count()) {
      const actionBox = await action.boundingBox();
      const messageBox = await page.locator(".pr-toast-copy").boundingBox();
      expect(actionBox).not.toBeNull();
      expect(messageBox).not.toBeNull();
      expect(actionBox!.y).toBeGreaterThanOrEqual(
        messageBox!.y + messageBox!.height,
      );
    }
  }
};
const holdToast = async (page: Page) => {
  await page
    .locator(".pr-toast")
    .getByRole("button", { name: "Dismiss notification" })
    .focus();
};
const assertToastClearOfRecorderControls = async (
  page: Page,
  fontScale: number,
  allowMissingRingButton = false,
) => {
  const toast = await page.locator(".pr-toast").boundingBox();
  expect(toast).not.toBeNull();
  const targets: [string, Locator][] = [
    ["timer", page.locator(".pr-time")],
    ["moment button", page.locator(".pr-time-slot")],
    ["Listening pill", page.getByTestId("phone-recorder-pill")],
    ["Minimise", page.getByRole("button", { name: "Minimise recorder" })],
    ["ring", page.locator(".pr-stage button")],
    ["ring body", page.locator(".pr-ring")],
    ["status line", page.locator(".pr-extra")],
    ["notes row", page.locator(".pr-notes")],
    ["mode row", page.locator(".pr-mrow")],
    ["modes button", page.locator(".pr-minfo")],
    ["mode name", page.locator(".pr-mname")],
    ["mode detail", page.locator(".pr-mshort")],
    ["privacy scale", page.locator(".pr-scale")],
    ["privacy labels (allowed)", page.locator(".pr-ends")],
    // The toast is anchored above the sticky dock. The caption and Via row
    // may sit behind it while the dismissible notification is present.
    ["caption (allowed)", page.locator(".pr-capline")],
    ["Via row (allowed)", page.locator(".pr-src-wrap")],
    ["Via control (allowed)", page.locator(".pr-srcbtn")],
    ["control buttons", page.locator(".pr-controls button")],
  ];
  expect(await page.locator(".pr-ends").getAttribute("aria-hidden")).toBe(
    "true",
  );
  const viewport = page.viewportSize()!;
  const overlaps: { name: string; target: NonNullable<typeof toast> }[] = [];
  for (const [name, locator] of targets) {
    const count = await locator.count();
    if (name === "notes row" && count === 0) continue;
    if (name === "ring" && count === 0 && allowMissingRingButton) continue;
    expect(count).toBeGreaterThan(0);
    if (name === "status line" && !(await locator.innerText()).trim()) continue;
    for (let index = 0; index < count; index++) {
      const target = await locator.nth(index).boundingBox();
      expect(target).not.toBeNull();
      if (
        toast!.x < target!.x + target!.width &&
        toast!.x + toast!.width > target!.x &&
        toast!.y < target!.y + target!.height &&
        toast!.y + toast!.height > target!.y
      )
        overlaps.push({
          name: count > 1 ? `${name}[${index}]` : name,
          target: target!,
        });
    }
  }
  console.log(
    `toast-overlap-check ${viewport.width}x${viewport.height} font=${fontScale}x toast=${JSON.stringify(toast)} overlaps=${JSON.stringify(overlaps)}`,
  );
  if (viewport.width > viewport.height) {
    const scale = await page.locator(".pr-scale").boundingBox();
    expect(scale).not.toBeNull();
    if (
      toast!.x < scale!.x + scale!.width &&
      toast!.x + toast!.width > scale!.x
    )
      expect(toast!.y).toBeGreaterThanOrEqual(scale!.y + scale!.height + 4);
  }
  expect(
    overlaps.filter(({ name }) => {
      if (name.includes("(allowed)")) return false;
      return true;
    }),
  ).toEqual([]);
};
const measureToastLayout = (page: Page) =>
  page.evaluate(() => {
    const box = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) return null;
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    };
    const controls = [
      ...document.querySelectorAll<HTMLElement>(".pr-controls button"),
    ];
    const namedControl = (pattern: RegExp) => {
      const element = controls.find((control) =>
        pattern.test(
          `${control.getAttribute("aria-label") ?? ""} ${control.textContent ?? ""}`,
        ),
      );
      if (!element) return null;
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    };
    return {
      scale: box(".pr-scale"),
      ring: box(".pr-ring"),
      toast: box(".pr-toast"),
      toastItems: [
        ...document.querySelectorAll<HTMLElement>(".pr-toast > *"),
      ].map((element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return {
          className: element.className,
          text: element.textContent?.trim(),
          x,
          y,
          width,
          height,
        };
      }),
      done: namedControl(/Done/),
      pause: namedControl(/Pause recording/),
      discard: namedControl(/Discard recording/),
      viewport: { width: innerWidth, height: innerHeight },
    };
  });
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

  test("dragging the slider chooses the nearest stop at either end", async () => {
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
    await modeIs(page, "Private");
    expect(await calls()).toEqual(["transcriber:off:recording", "transcriber:private-cloud:recording"]);
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
    const { page, errors } = await open("consented", { clock: true });
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
    const toast = page.locator(".pr-toast");
    expect(
      await toast.getByRole("button", { name: "Use Private" }).count(),
    ).toBe(0);
    expect(await toast.getByRole("button", { name: "Get model" }).count()).toBe(
      0,
    );
    const dismiss = toast.getByRole("button", { name: "Dismiss notification" });
    await dismiss.focus();
    await page.clock.fastForward(10_000);
    await shown(dismiss);
    const toastBox = (await toast.boundingBox())!;
    await page.mouse.move(
      toastBox.x + toastBox.width / 2,
      toastBox.y + toastBox.height / 2,
    );
    await slider(page).focus();
    await page.clock.fastForward(10_000);
    await shown(dismiss);
    await page.mouse.move(5, 5);
    await page.clock.fastForward(4_200);
    await gone(toast);
    await page.context().close();
  });

  test("a provider refusal stays fully visible at every phone size and text scale", async () => {
    const { page } = await open("consented", { clock: true });
    await page.evaluate(() => {
      (window as unknown as Harness).exoRecorder.transcriberResult =
        "unavailable";
    });
    const toast = page.locator(".pr-toast");
    const viewports = [
      { width: 390, height: 844 },
      { width: 320, height: 545 },
      { width: 844, height: 390 },
      { width: 740, height: 360 },
    ];
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      for (const fontScale of [1, 2]) {
        await setFontScale(page, 1);
        if (fontScale === 2) await setFontScale(page, fontScale);
        await slider(page).scrollIntoViewIfNeeded();
        await slider(page).focus();
        await page.keyboard.press("ArrowLeft");
        await shown(toast);
        if (fontScale === 2) await setToastFontScale(page, fontScale);
        await settleToastPlacement(page);
        await assertToastMessageVisible(
          page,
          "Local isn't available right now",
        );
        await assertToastClearOfRecorderControls(page, fontScale);
        const icon = page.locator(".pr-toast-icon");
        expect(await icon.getAttribute("aria-hidden")).toBe("true");
        const evidenceDir = process.env.EXO_POLISH_EVIDENCE;
        if (evidenceDir) {
          mkdirSync(evidenceDir, { recursive: true });
          await page.screenshot({
            path: `${evidenceDir}/recorder-refusal-${viewport.width}x${viewport.height}-font-${fontScale}.png`,
            fullPage: true,
          });
        }
        await toast
          .getByRole("button", { name: "Dismiss notification" })
          .click();
        await gone(toast);
      }
    }
    await page.context().close();
  });

  // A provider refusal keeps the recorder controls visible around its toast.
  const toastScenarios = [
    {
      suffix: "",
      stop: "local",
      refuse: true,
      message: "Local isn't available right now",
      actions: [] as string[],
    },
  ];
  const prepareToastScenario = (
    page: Page,
    scenario: (typeof toastScenarios)[number],
  ) =>
    page.evaluate((refuse) => {
      (window as unknown as Harness).exoRecorder.transcriberResult = refuse
        ? "unavailable"
        : null;
    }, scenario.refuse);

  for (const scenario of toastScenarios) test(`an unavailable mode toast stays readable and keeps fixed controls clear${scenario.suffix}`, async () => {
    const { page } = await open("model-unavailable", { clock: true });
    await prepareToastScenario(page, scenario);
    const toast = page.locator(".pr-toast");
    const evidenceDir = process.env.EXO_POLISH_EVIDENCE;
    if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });
    const viewports = [
      { width: 390, height: 844 },
      { width: 320, height: 545 },
      { width: 844, height: 390 },
      { width: 740, height: 360 },
    ];
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      for (const fontScale of [1, 2]) {
        await setFontScale(page, 1);
        if (fontScale === 2) await setFontScale(page, fontScale);
        const stop = page.locator(`.pr-stop[data-stop="${scenario.stop}"]`);
        await stop.scrollIntoViewIfNeeded();
        const before = await measureToastLayout(page);
        await stop.click();
        await shown(toast);
        await holdToast(page);
        for (const action of scenario.actions)
          await shown(toast.getByRole("button", { name: action }));
        if (fontScale === 2) await setToastFontScale(page, fontScale);
        const message = page.locator(".pr-toast-message");
        const exerciseFontMetricFallback =
          viewport.width === 390 && viewport.height === 844 && fontScale === 1;
        if (exerciseFontMetricFallback)
          await message.evaluate((element) => {
            // Simulate wider CI fallback-font glyphs and exercise the toast's
            // measured placement when that extra width adds a line.
            element.style.letterSpacing = "2px";
          });
        await settleToastPlacement(page);
        await assertToastMessageVisible(
          page,
          scenario.message,
          scenario.actions,
        );
        const after = await measureToastLayout(page);
        expect(after.toast).not.toBeNull();
        expect(after.scale).not.toBeNull();
        expect(after.ring).not.toBeNull();
        for (const part of ["scale", "ring"] as const) {
          for (const dimension of ["x", "y", "width", "height"] as const) {
            expect(
              Math.abs(after[part]![dimension] - before[part]![dimension]),
            ).toBeLessThanOrEqual(2);
          }
        }
        const viewportBottom = after.viewport.height;
        for (const action of ["done", "pause", "discard"] as const) {
          expect(after[action]).not.toBeNull();
          expect(after[action]!.y).toBeGreaterThanOrEqual(0);
          expect(after[action]!.y + after[action]!.height).toBeLessThanOrEqual(
            viewportBottom,
          );
        }
        expect(after.toast!.x).toBeGreaterThanOrEqual(0);
        expect(after.toast!.y).toBeGreaterThanOrEqual(0);
        expect(after.toast!.x + after.toast!.width).toBeLessThanOrEqual(
          after.viewport.width,
        );
        expect(after.toast!.y + after.toast!.height).toBeLessThanOrEqual(
          after.viewport.height,
        );
        await assertToastClearOfRecorderControls(page, fontScale);
        if (exerciseFontMetricFallback) {
          await message.evaluate((element) => {
            element.style.removeProperty("letter-spacing");
          });
          await settleToastPlacement(page);
        }
        if (evidenceDir)
          await page.screenshot({
            path: `${evidenceDir}/recorder-toast-${viewport.width}x${viewport.height}-font-${fontScale}.png`,
            fullPage: true,
          });
        await toast
          .getByRole("button", { name: "Dismiss notification" })
          .click();
        await gone(toast);
      }
    }
    await setFontScale(page, 1);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => {
      (window as unknown as Harness).exoRecorder.transcriberResult = null;
    });
    await page.locator('.pr-stop[data-stop="private"]').click();
    await modeIs(page, "Private");
    await page.context().close();

    const dark = await open("model-unavailable", {
      clock: true,
      theme: "dark",
    });
    await prepareToastScenario(dark.page, scenario);
    await dark.page.locator(`.pr-stop[data-stop="${scenario.stop}"]`).click();
    await shown(dark.page.locator(".pr-toast"));
    await holdToast(dark.page);
    if (evidenceDir)
      await dark.page.screenshot({
        path: `${evidenceDir}/recorder-toast-phone-dark.png`,
        fullPage: true,
      });
    await dark.page.setViewportSize({ width: 844, height: 390 });
    if (evidenceDir)
      await dark.page.screenshot({
        path: `${evidenceDir}/recorder-toast-phone-land-dark.png`,
        fullPage: true,
      });
    await dark.page.context().close();
  }, 120_000);

  for (const scenario of toastScenarios) test(`a five-line toast scrolls without covering the ring or scale on a short phone${scenario.suffix}`, async () => {
    const { page } = await open("model-unavailable", { clock: true });
    await prepareToastScenario(page, scenario);
    const sentence =
      "This recording cannot switch to the on-device model until the model download finishes. Check your connection and try again when the download is complete. The recording stays available while you wait.";
    const messageText = `${sentence} ${sentence} ${sentence}`;
    const message = page.locator(".pr-toast-message");
    const copy = page.locator(".pr-toast-copy");
    await page.setViewportSize({ width: 320, height: 545 });

    for (const fontScale of [1, 2]) {
      await setFontScale(page, 1);
      if (fontScale === 2) await setFontScale(page, fontScale);
      const stop = page.locator(`.pr-stop[data-stop="${scenario.stop}"]`);
      await stop.scrollIntoViewIfNeeded();
      await stop.click();
      await shown(page.locator(".pr-toast"));
      await holdToast(page);
      for (const action of scenario.actions)
        await shown(
          page.locator(".pr-toast").getByRole("button", { name: action }),
        );
      await message.evaluate((element, value) => {
        element.textContent = value;
      }, messageText);
      if (fontScale === 2) await setToastFontScale(page, fontScale);
      await settleToastPlacement(page);

      await assertToastMessageVisible(page, messageText, scenario.actions);
      const lineCount = await message.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return new Set(
          [...range.getClientRects()].map(({ top }) => Math.round(top)),
        ).size;
      });
      expect(lineCount).toBeGreaterThanOrEqual(5);
      const copySizing = await copy.evaluate((element) => {
        const message =
          element.querySelector<HTMLElement>(".pr-toast-message")!;
        const style = getComputedStyle(element);
        return {
          lineHeight: Number.parseFloat(getComputedStyle(message).lineHeight),
          padding:
            Number.parseFloat(style.paddingTop) +
            Number.parseFloat(style.paddingBottom),
          minHeight: Number.parseFloat(style.minHeight),
          maxHeight: Number.parseFloat(style.maxHeight),
          height: element.getBoundingClientRect().height,
        };
      });
      const reservedLines =
        copySizing.maxHeight <
        copySizing.lineHeight * 2 + copySizing.padding + 1
          ? 1
          : 2;
      if (fontScale === 1)
        expect(reservedLines).toBe(scenario.actions.length > 0 ? 1 : 2);
      const reservedHeight =
        copySizing.lineHeight * reservedLines + copySizing.padding;
      expect(copySizing.minHeight).toBeGreaterThanOrEqual(reservedHeight);
      expect(copySizing.maxHeight).toBeGreaterThanOrEqual(reservedHeight);
      expect(copySizing.height).toBeGreaterThanOrEqual(reservedHeight);
      const visibleLineCount = await message.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const copyBounds = element.parentElement!.getBoundingClientRect();
        return new Set(
          [...range.getClientRects()]
            .filter(
              ({ top, bottom }) =>
                top >= copyBounds.top && bottom <= copyBounds.bottom,
            )
            .map(({ top }) => Math.round(top)),
        ).size;
      });
      expect(visibleLineCount).toBeGreaterThanOrEqual(reservedLines);
      await assertToastClearOfRecorderControls(page, fontScale);

      await copy.focus();
      await focused(copy);
      await copy.evaluate(async (element) => {
        element.scrollTop = element.scrollHeight;
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
      });
      expect(
        await copy.evaluate((element) => element.scrollTop),
      ).toBeGreaterThan(0);
      const finalLineVisible = await message.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const rects = [...range.getClientRects()];
        const last = rects.at(-1);
        const copy = element.parentElement!.getBoundingClientRect();
        return Boolean(
          last && last.bottom <= copy.bottom && last.top >= copy.top,
        );
      });
      expect(finalLineVisible).toBe(true);
      const evidenceDir = process.env.EXO_POLISH_EVIDENCE;
      if (evidenceDir) {
        mkdirSync(evidenceDir, { recursive: true });
        await page.screenshot({
          path: `${evidenceDir}/recorder-long-toast-320x545-font-${fontScale}.png`,
          fullPage: true,
        });
      }
      await page
        .locator(".pr-toast")
        .getByRole("button", { name: "Dismiss notification" })
        .click();
      await gone(page.locator(".pr-toast"));
    }
    await page.context().close();
  });

  test("an interrupted recording keeps its status and notes row clear of the toast", async () => {
    const { page } = await open("consented");
    await page.evaluate(() => {
      const harness = (window as unknown as Harness).exoRecorder;
      harness.patch({
        mic: { state: "interrupted", reason: "call" },
        note: {
          md: "- **0:12** Keep this note visible",
          moments: [{ atMs: 12_000, label: "Keep this note visible" }],
        },
        noteStatus: "ready",
      });
      harness.transcriberResult = "unavailable";
    });
    await shown(page.getByText("Resumes when the call ends"));
    await shown(page.locator(".pr-notes .pr-vnotes"));
    await slider(page).focus();
    await page.keyboard.press("ArrowLeft");
    const toast = page.locator(".pr-toast");
    await shown(toast);
    await page.locator(".pr-toast-message").evaluate((element) => {
      element.textContent =
        "This unavailable mode can be selected after the recording resumes.";
    });
    await settleToastPlacement(page);
    await assertToastClearOfRecorderControls(page, 1, true);
    expect(await page.locator(".pr-extra").innerText()).toContain(
      "Resumes when the call ends",
    );
    expect(await page.locator(".pr-notes .pr-vnotes").innerText()).toContain(
      "View notes",
    );
    await page.context().close();
  });

  test("Get model starts the shared Wi-Fi download and shows its waiting state inline", async () => {
    const { page } = await open("model-unavailable", { clock: true });
    await page
      .getByRole("button", { name: "Transcription modes: compare and choose" })
      .click();
    const localRow = page.locator('.pr-mprow[data-mode="local"]');
    const localRowBox = (await localRow.boundingBox())!;
    await page.mouse.click(
      localRowBox.x + localRowBox.width / 2,
      localRowBox.y + localRowBox.height / 2,
    );
    const toast = page.locator(".pr-toast");
    const note = page.getByTestId("local-model-note");
    const getModel = page.getByTestId("local-model-action");
    await shown(getModel);
    expect(await note.textContent()).toContain(
      "The on-device model isn't downloaded",
    );
    expect(await toast.count()).toBe(0);
    await page.clock.fastForward(10_000);
    await shown(getModel);
    const evidenceDir = process.env.EXO_POLISH_EVIDENCE;
    if (evidenceDir) {
      mkdirSync(evidenceDir, { recursive: true });
      await page.screenshot({
        path: `${evidenceDir}/recorder-get-model-phone.png`,
        fullPage: true,
      });
    }

    await getModel.click();
    await shown(
      note.filter({
        hasText: /Waiting for Wi-Fi to download the on-device model/,
      }),
    );
    expect(
      await page.evaluate(() => window.exoRecorder?.downloadCalls?.length),
    ).toBe(1);

    await page.evaluate(() => {
      (window as unknown as Harness).exoRecorder.transcriberResult =
        "unavailable";
    });
    await slider(page).press("ArrowRight");
    await shown(page.getByText("Private isn't available right now"));
    expect(await toast.textContent()).toContain(
      "Private isn't available right now",
    );
    await focused(slider(page));
    await holdToast(page);
    await page.setViewportSize({ width: 844, height: 390 });
    await settleToastPlacement(page);
    await assertToastClearOfRecorderControls(page, 1);
    if (evidenceDir)
      await page.screenshot({
        path: `${evidenceDir}/recorder-get-model-phone-land.png`,
        fullPage: true,
      });
    await page.context().close();
  });

  test("a Private choice from the first-run scale returns focus after consent is dismissed", async () => {
    const { page } = await open("model-unavailable-first-run");
    await page.locator('.pr-stop[data-stop="private"]').click();
    const consent = page.getByRole("dialog", { name: "Use private cloud?" });
    await shown(consent);
    await consent.getByRole("button", { name: "Not now" }).click();
    await gone(consent);
    await focused(slider(page));
    await page.context().close();
  });

  test("mic denied keeps the ring and scale in the recording layout positions", async () => {
    const { page: recording } = await open("consented");
    const recordingRing = await recording.locator(".pr-ring").boundingBox();
    const recordingScale = await recording.locator(".pr-scale").boundingBox();
    const { page: denied } = await open("permission-denied");
    const deniedRing = await denied.locator(".pr-ring").boundingBox();
    const deniedScale = await denied.locator(".pr-scale").boundingBox();
    expect(recordingRing).not.toBeNull();
    expect(recordingScale).not.toBeNull();
    expect(deniedRing).not.toBeNull();
    expect(deniedScale).not.toBeNull();
    expect(Math.abs(recordingRing!.x - deniedRing!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(recordingRing!.y - deniedRing!.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(recordingScale!.x - deniedScale!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(recordingScale!.y - deniedScale!.y)).toBeLessThanOrEqual(1);
    const recordingVia = await recording.locator(".pr-src-wrap").boundingBox();
    const deniedVia = await denied.locator(".pr-via-placeholder").boundingBox();
    expect(recordingVia).not.toBeNull();
    expect(deniedVia).not.toBeNull();
    expect(
      Math.abs(recordingVia!.height - deniedVia!.height),
    ).toBeLessThanOrEqual(1);
    const deniedControls = denied.locator(".pr-controls[data-mic-denied=true]");
    expect(await deniedControls.getByRole("button").count()).toBe(1);
    expect(
      await deniedControls
        .getByRole("button", { name: "Open Settings" })
        .count(),
    ).toBe(1);
    expect(
      await denied
        .locator(".pr-mark")
        .evaluate((el) => getComputedStyle(el).visibility),
    ).toBe("hidden");
    expect(
      await denied
        .locator(".pr-ring")
        .evaluate((el) => getComputedStyle(el).opacity),
    ).toBe("0.35");
    const evidenceDir = process.env.EXO_POLISH_EVIDENCE;
    if (evidenceDir) {
      mkdirSync(evidenceDir, { recursive: true });
      await denied.screenshot({
        path: `${evidenceDir}/recorder-mic-denied-phone.png`,
        fullPage: true,
      });
    }
    await recording.context().close();
    await denied.context().close();

    const darkDenied = await open("permission-denied", { theme: "dark" });
    if (evidenceDir)
      await darkDenied.page.screenshot({
        path: `${evidenceDir}/recorder-mic-denied-phone-dark.png`,
        fullPage: true,
      });
    await darkDenied.page.context().close();
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
    expect(await settingsAlert.textContent()).not.toContain(
      "Settings would not open",
    );
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
    await page.getByRole("radio", { name: "Audio only" }).click();
    const alert = page.getByRole("alert");
    await shown(alert);
    expect(await alert.textContent()).toBe(
      "Could not change the transcription to Audio only: Plugin is down",
    );
    expect(await selected()).toBe("Local");
    expect(errors.some((text) => text.includes("Could not change"))).toBe(true);
    await page.context().close();
  });

  test("through the consent question the selection stays the provider's, and a rejected consent shows the alert", async () => {
    const { page, selected } = await openRoute();
    await page.getByRole("radio", { name: "Private" }).click();
    await shown(page.getByTestId("voice-note-transcription-consent"));
    expect(await selected()).toBe("Local");
    await page.evaluate(() => {
      (window as unknown as RouteHarness).exoRoute.rejectConsent = true;
    });
    await page.getByTestId("voice-note-transcription-enable").click();
    const alert = page.getByRole("alert");
    await shown(alert);
    expect(await alert.textContent()).toBe(
      "Could not change the transcription to Private: Consent was not saved",
    );
    expect(await selected()).toBe("Local");
    expect(
      await page.evaluate(
        () => (window as unknown as RouteHarness).exoRoute.calls,
      ),
    ).toEqual(["consent"]);
    await page.context().close();
  });
});
