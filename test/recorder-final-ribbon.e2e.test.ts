// The minimised final recorder (TC-870), driven in a real browser: the Ribbon above the tab bar, the
// floating Ribbon on the rail and the sidebar dock, over a recorder that logs what it is asked to do
// (frontend/src/harness/screens/recorderFinalRibbon.tsx). The screenshot run checks how each looks;
// this checks that they do what they say, and that crossing a breakpoint keeps the recording.
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
  exoMinimized: { calls: string[]; patch: (patch: object) => void };
};
type NativeHarness = {
  exoMinimizedNative: { calls: string[]; fail: Record<string, boolean> };
};

const PHONE = { width: 390, height: 844 };
const RAIL = { width: 900, height: 700 };
const DESKTOP = { width: 1280, height: 800 };

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
  patch: (patch: object) => Promise<void>;
  /** How many times "Minimized" has been put in a live region. */
  minimizedAnnouncements: () => Promise<number>;
  errors: string[];
}

async function open(
  name: "recording" | "paused" | "interrupted" | "silenced" | "native",
  size: { width: number; height: number } = PHONE,
): Promise<Opened> {
  const page = await (
    await browser.newContext({ viewport: size, reducedMotion: "reduce" })
  ).newPage();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().startsWith("Failed to load resource") &&
      !message.text().startsWith("Viewport argument key")
    )
      errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  // Counts every time "Minimized" lands in the page, whichever live region (or remounted control) carries it.
  await page.addInitScript(() => {
    (window as unknown as { minimizedCount: number }).minimizedCount = 0;
    new MutationObserver((records) => {
      const w = window as unknown as { minimizedCount: number };
      for (const record of records) {
        if (
          record.type === "characterData" &&
          record.target.nodeValue === "Minimized"
        )
          w.minimizedCount++;
        for (const node of record.addedNodes)
          if (node.textContent === "Minimized") w.minimizedCount++;
      }
    }).observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
  await page.goto(
    `http://127.0.0.1:${server.port}/?screen=recorder-final-minimized-${name}&theme=dark&platform=ios`,
  );
  await page.waitForSelector(
    "[data-testid=ribbon], [data-testid=sidebar-dock]",
  );
  return {
    page,
    errors,
    calls: () =>
      page.evaluate(() =>
        (window as unknown as Harness).exoMinimized.calls.slice(),
      ),
    patch: (patch) =>
      page.evaluate(
        (p) => (window as unknown as Harness).exoMinimized.patch(p),
        patch,
      ),
    minimizedAnnouncements: () =>
      page.evaluate(
        () => (window as unknown as { minimizedCount: number }).minimizedCount,
      ),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (
  what: string,
  check: () => Promise<boolean>,
  ms = 5000,
) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(50);
  }
};
const shown = (locator: Locator) =>
  locator.waitFor({ state: "visible", timeout: 5000 });
const gone = (locator: Locator) =>
  locator.waitFor({ state: "hidden", timeout: 5000 });
const attr = (locator: Locator, name: string, value: string) =>
  until(
    `${name}="${value}"`,
    async () => (await locator.getAttribute(name)) === value,
  );

const seconds = async (locator: Locator) => {
  const [m, s] = ((await locator.textContent()) ?? "").split(":").map(Number);
  return m * 60 + s;
};

const ribbon = (page: Page) => page.getByTestId("ribbon");
const dock = (page: Page) => page.getByTestId("sidebar-dock");
const timer = (page: Page) =>
  page.locator("[data-testid=ribbon-timer], [data-testid=dock-timer]");

describe.serial(`minimised recorder interactions (${engineName})`, () => {
  test("phone: the Ribbon shows above the tab bar with the timer, bars, pause and stop", async () => {
    const { page, errors } = await open("recording");
    await shown(ribbon(page));
    expect(await ribbon(page).getAttribute("data-layout")).toBe("phone");
    await expect(
      page.getByTestId("ribbon-pause").getAttribute("aria-label"),
    ).resolves.toBe("Pause recording");
    await expect(
      page.getByTestId("ribbon-stop").getAttribute("aria-label"),
    ).resolves.toBe("Stop and save");
    expect(await page.locator("[data-spectrum-bars] [data-bar]").count()).toBe(
      30,
    );
    const tabs = await page.getByRole("navigation").last().boundingBox();
    const box = (await ribbon(page).boundingBox())!;
    if (tabs) expect(box.y + box.height).toBeLessThanOrEqual(tabs.y + 1);
    await gone(dock(page));
    expect(errors).toEqual([]);
  });

  test("tapping the timer or the bars reopens the recorder", async () => {
    for (const target of [".ribbon-timer", ".ribbon-bars"]) {
      const { page, calls, patch } = await open("recording");
      await page.locator(target).click();
      await until("openSheet", async () =>
        (await calls()).includes("openSheet"),
      );
      await gone(ribbon(page));
      await patch({ sheetOpen: false });
      await shown(ribbon(page));
    }
  });

  test("Enter and Space on the Ribbon's one labelled control reopen the recorder", async () => {
    const { page, calls, patch } = await open("recording");
    const openButton = page.getByRole("button", {
      name: "Recording. Open recorder",
    });
    await openButton.focus();
    await page.keyboard.press("Enter");
    await until(
      "openSheet",
      async () => (await calls()).filter((c) => c === "openSheet").length === 1,
    );
    await patch({ sheetOpen: false });
    await shown(ribbon(page));
    await openButton.focus();
    await page.keyboard.press("Space");
    await until(
      "openSheet again",
      async () => (await calls()).filter((c) => c === "openSheet").length === 2,
    );
  });

  test("Pause holds the timer and greys the bars; Resume starts them again", async () => {
    const { page, calls } = await open("recording");
    const pause = page.getByTestId("ribbon-pause");
    await pause.click();
    await attr(pause, "aria-label", "Resume recording");
    await attr(ribbon(page), "data-state", "paused");
    await attr(page.locator("[data-spectrum-bars]"), "data-paused", "true");
    const held = await seconds(timer(page));
    await sleep(1300);
    expect(await seconds(timer(page))).toBe(held);
    expect(await ribbon(page).getAttribute("data-live")).toBe("false");

    await pause.click();
    await attr(pause, "aria-label", "Pause recording");
    await attr(ribbon(page), "data-state", "live");
    await until(
      "the timer to run",
      async () => (await seconds(timer(page))) > held,
      4000,
    );
    expect(await calls()).toEqual(["pause", "resume"]);
  });

  test("Stop stops and saves", async () => {
    const { page, calls } = await open("recording");
    await page.getByTestId("ribbon-stop").click();
    expect(await calls()).toEqual(["stop"]);
  });

  test("a paused recording opens paused, with Resume", async () => {
    const { page } = await open("paused");
    expect(
      await page.getByTestId("ribbon-pause").getAttribute("aria-label"),
    ).toBe("Resume recording");
    expect(await ribbon(page).getAttribute("data-live")).toBe("false");
  });

  test("an interrupted recording is not shown as recording", async () => {
    const { page } = await open("interrupted");
    expect(await ribbon(page).getAttribute("data-live")).toBe("false");
    expect(await ribbon(page).getAttribute("data-state")).not.toBe("live");
  });

  test("the rail floats the Ribbon at the foot of the main area, taking none of its height", async () => {
    const { page } = await open("recording", RAIL);
    await shown(ribbon(page));
    expect(await ribbon(page).getAttribute("data-layout")).toBe("rail");
    await gone(dock(page));
    const box = (await ribbon(page).boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(RAIL.height);
    expect(box.y + box.height).toBeGreaterThan(RAIL.height - 40);
  });

  test("the sidebar dock: pause, stop and a click anywhere else restore the recorder", async () => {
    const { page, calls, patch } = await open("recording", DESKTOP);
    await shown(dock(page));
    await gone(ribbon(page));
    expect(await page.locator("[data-spectrum-bars] [data-bar]").count()).toBe(
      22,
    );
    await page.getByTestId("dock-pause").click();
    await attr(
      page.getByTestId("dock-pause"),
      "aria-label",
      "Resume recording",
    );
    await page.getByTestId("dock-pause").click();
    await page.getByTestId("dock-stop").click();
    expect(await calls()).toEqual(["pause", "resume", "stop"]);

    await page.getByTestId("dock-status").click({ force: true });
    await until("openSheet", async () => (await calls()).includes("openSheet"));
    await patch({ sheetOpen: false });
    await shown(dock(page));
    const reopen = page.getByRole("button", {
      name: "Recording. Open recorder",
    });
    await reopen.focus();
    await page.keyboard.press("Enter");
    await until(
      "openSheet by Enter",
      async () => (await calls()).filter((c) => c === "openSheet").length === 2,
    );
    await patch({ sheetOpen: false });
    await shown(dock(page));
    await reopen.focus();
    await page.keyboard.press("Space");
    await until(
      "openSheet by Space",
      async () => (await calls()).filter((c) => c === "openSheet").length === 3,
    );
  });

  test("the Capture item carries a red dot while live, and a grey one while paused", async () => {
    const { page } = await open("recording", DESKTOP);
    const dot = page.getByTestId("capture-dot");
    await attr(dot, "data-dot", "live");
    await page.getByTestId("dock-pause").click();
    await attr(dot, "data-dot", "paused");
  });

  test("crossing a breakpoint swaps the Ribbon and the dock and keeps the recording", async () => {
    const { page, calls, errors, minimizedAnnouncements } =
      await open("recording");
    await page.getByTestId("ribbon-pause").click();
    await attr(ribbon(page), "data-state", "paused");
    const held = await seconds(timer(page));

    await page.setViewportSize(RAIL);
    await attr(ribbon(page), "data-layout", "rail");
    expect(await ribbon(page).getAttribute("data-state")).toBe("paused");
    expect(await seconds(timer(page))).toBe(held);

    await page.setViewportSize(DESKTOP);
    await shown(dock(page));
    await gone(ribbon(page));
    expect(await dock(page).getAttribute("data-state")).toBe("paused");
    expect(await seconds(timer(page))).toBe(held);

    await page.getByTestId("dock-pause").click();
    await attr(dock(page), "data-state", "live");
    const running = await seconds(timer(page));
    expect(running).toBeGreaterThanOrEqual(held);
    await page.setViewportSize(PHONE);
    await shown(ribbon(page));
    await gone(dock(page));
    // The clock lives above the swap: a remounted control starts from the time it had, not the last checkpoint.
    expect(await seconds(timer(page))).toBeGreaterThanOrEqual(running);
    expect(await ribbon(page).getAttribute("data-state")).toBe("live");

    expect(await calls()).toEqual(["pause", "resume"]);
    expect(await minimizedAnnouncements()).toBe(0);
    expect(errors).toEqual([]);
  });

  test('"Minimized" is announced once, when the user minimises, and not at start or on a layout swap', async () => {
    const { page, patch, minimizedAnnouncements } = await open("recording");
    const status = page.getByTestId("minimized-announcement");
    expect(await status.getAttribute("role")).toBe("status");
    expect(await status.textContent()).toBe("");
    expect(await minimizedAnnouncements()).toBe(0);

    await patch({ sheetOpen: true });
    await gone(ribbon(page));
    expect(await minimizedAnnouncements()).toBe(0);
    await patch({ sheetOpen: false });
    await shown(ribbon(page));
    await until(
      "the announcement",
      async () => (await status.textContent()) === "Minimized",
    );
    await until(
      "the announcement to clear",
      async () => (await status.textContent()) === "",
      5000,
    );

    await page.setViewportSize(DESKTOP);
    await shown(dock(page));
    await page.setViewportSize(RAIL);
    await shown(ribbon(page));
    await sleep(300);
    expect(await minimizedAnnouncements()).toBe(1);
  });
});

describe.serial(`a silenced mic (${engineName})`, () => {
  const bars = (page: Page) => page.locator("[data-bar]");
  const transforms = (page: Page) =>
    bars(page).evaluateAll((spans) =>
      spans.map((span) => (span as HTMLElement).style.transform),
    );
  const colour = (page: Page) =>
    bars(page)
      .first()
      .evaluate((span) => getComputedStyle(span).backgroundColor);

  for (const [layout, size, container] of [
    ["Ribbon", PHONE, "ribbon"],
    ["dock", DESKTOP, "sidebar-dock"],
  ] as const) {
    test(`the ${layout} stays red but its bars are flat while the level keeps arriving`, async () => {
      const { page, errors } = await open("silenced", size);
      const box = page.getByTestId(container);
      await attr(box, "data-state", "live");
      await attr(box.locator("[data-spectrum-bars]"), "data-paused", "false");
      const first = await transforms(page);
      expect(new Set(first).size).toBe(1);
      await sleep(600);
      expect(await transforms(page)).toEqual(first);
      expect(await colour(page)).toBe("rgb(255, 107, 98)");
      expect(errors).toEqual([]);
    });
  }

  test("a live mic's bars, by contrast, follow the level", async () => {
    const { page } = await open("recording");
    await until("the bars to move off their resting height", async () =>
      (await transforms(page)).some((value) => value !== "scaleY(0.12)"),
    );
  });
});

describe.serial(`a rejected control while minimised (${engineName})`, () => {
  const setFailing = (page: Page, name: string, on: boolean) =>
    page.evaluate(
      ([key, value]) => {
        (window as unknown as NativeHarness).exoMinimizedNative.fail[
          key as string
        ] = value as boolean;
      },
      [name, on],
    );
  const nativeCalls = (page: Page) =>
    page.evaluate(() =>
      (window as unknown as NativeHarness).exoMinimizedNative.calls.slice(),
    );
  const logged = (errors: string[], what: string) =>
    until(`console.error "${what}"`, async () =>
      errors.some((text) => text.includes(what)),
    );

  const layouts = [
    ["phone", PHONE, "ribbon", "ribbon-pause", "ribbon-stop"],
    ["rail", RAIL, "ribbon", "ribbon-pause", "ribbon-stop"],
    ["desktop", DESKTOP, "sidebar-dock", "dock-pause", "dock-stop"],
  ] as const;

  for (const [layout, size, container, pauseId, stopId] of layouts) {
    describe.serial(layout, () => {
      test("Pause: the alert names the failure, Pause stays enabled, and retrying clears it", async () => {
        const { page, errors } = await open("native", size);
        const pause = page.getByTestId(pauseId);
        const alert = page.getByRole("alert");
        await attr(page.getByTestId(container), "data-state", "live");
        await setFailing(page, "pause", true);
        await pause.click();
        await shown(alert);
        expect(await alert.textContent()).toMatch(/refused/i);
        await logged(errors, "[Recorder] pause failed");
        expect(await alert.count()).toBe(1);
        expect(await pause.isEnabled()).toBe(true);
        expect(
          await page.getByTestId(container).getAttribute("data-state"),
        ).toBe("live");

        await setFailing(page, "pause", false);
        await pause.click();
        await gone(alert);
        await attr(page.getByTestId(container), "data-state", "paused");
        expect(
          (await nativeCalls(page)).filter((c) => c === "pause"),
        ).toHaveLength(2);
      });

      test("Resume: the alert names the failure, Resume stays enabled, and retrying clears it", async () => {
        const { page, errors } = await open("native", size);
        const control = page.getByTestId(pauseId);
        const alert = page.getByRole("alert");
        await control.click();
        await attr(page.getByTestId(container), "data-state", "paused");
        await setFailing(page, "resume", true);
        await control.click();
        await shown(alert);
        expect(await alert.textContent()).toMatch(/refused/i);
        await logged(errors, "[Recorder] resume failed");
        expect(await control.isEnabled()).toBe(true);
        expect(await control.getAttribute("aria-label")).toBe(
          "Resume recording",
        );

        await setFailing(page, "resume", false);
        await control.click();
        await gone(alert);
        await attr(page.getByTestId(container), "data-state", "live");
      });

      test("Stop: the alert names the failure, Stop stays enabled, and stopping again clears it", async () => {
        const { page, errors } = await open("native", size);
        const alert = page.getByRole("alert");
        const stop = page.getByTestId(stopId);
        await setFailing(page, "stop", true);
        await stop.click();
        await shown(alert);
        expect(await alert.textContent()).toMatch(/refused/i);
        await logged(errors, "[Recorder] stop failed");
        expect(await stop.isEnabled()).toBe(true);

        await setFailing(page, "stop", false);
        await stop.click();
        await gone(alert);
        expect(
          (await nativeCalls(page)).filter((c) => c === "stop"),
        ).toHaveLength(2);
      });

      test("Stop whose outcome is unknown: the alert stays, offers Try again, and the Ribbon or dock comes back", async () => {
        const { page, errors } = await open("native", size);
        const alert = page.getByRole("alert");
        await setFailing(page, "stop", true);
        await setFailing(page, "status", true);
        await page.getByTestId(stopId).click();
        await shown(alert);
        expect(await alert.textContent()).toMatch(
          /whether this phone stopped/i,
        );
        await logged(errors, "[Recorder] stop failed");
        const retry = page.getByTestId("minimized-alert-retry");
        await shown(retry);
        expect(await retry.isEnabled()).toBe(true);
        await gone(page.getByTestId(container));

        await setFailing(page, "status", false);
        await retry.click();
        await shown(page.getByTestId(container));
        await setFailing(page, "stop", false);
        await page.getByTestId(stopId).click();
        await gone(alert);
        expect(
          (await nativeCalls(page)).filter((c) => c === "stop"),
        ).toHaveLength(2);
      });

      test("the alert's Open reaches the full recorder", async () => {
        const { page } = await open("native", size);
        await setFailing(page, "pause", true);
        await page.getByTestId(pauseId).click();
        await shown(page.getByRole("alert"));
        await page.getByTestId("minimized-alert-open").click();
        await gone(page.getByTestId("minimized-alert"));
        await gone(page.getByTestId(container));
      });
    });
  }
});
