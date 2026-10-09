// The final recorder and Capture home on the smallest phone (TC-873): a 320x640 viewport, where the Ribbon's
// trace, the modes card's labels, the paused pill and the home rows have to share a narrow line without
// touching. Each assertion is geometry: one element's box must not meet another's.
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
import { chromium, webkit, type Browser, type Page } from "playwright";
import { buildHarness, serveHarness } from "./exo-ui/harness-server";

const engineName = process.env.EXO_UI_ENGINE ?? "webkit";
const engine = engineName === "chromium" ? chromium : webkit;

setDefaultTimeout(30_000);

let browser: Browser;
let server: ReturnType<typeof serveHarness>;

const SMALL = { width: 320, height: 640 };
const THEMES = [
  { name: "Night", param: "dark" },
  { name: "Day", param: "light" },
] as const;

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

async function open(
  screen: string,
  theme: string,
  ready: string,
): Promise<Page> {
  const page = await (
    await browser.newContext({
      viewport: SMALL,
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      reducedMotion: "reduce",
    })
  ).newPage();
  await page.goto(
    `http://127.0.0.1:${server.port}/?screen=${screen}&theme=${theme}&platform=ios&freeze=1`,
  );
  await page.waitForSelector(ready);
  await page.waitForTimeout(300);
  return page;
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The boxes of every element matching `selector`, in the page's coordinates. */
const boxes = (page: Page, selector: string): Promise<Box[]> =>
  page.$$eval(selector, (elements) =>
    elements.map((el) => {
      const { left, top, right, bottom } = el.getBoundingClientRect();
      return { left, top, right, bottom };
    }),
  );

const apart = (a: Box, b: Box, gap = 0) =>
  a.right + gap <= b.left ||
  b.right + gap <= a.left ||
  a.bottom + gap <= b.top ||
  b.bottom + gap <= a.top;

const within = (inner: Box, outer: Box) =>
  inner.left >= outer.left - 0.5 &&
  inner.right <= outer.right + 0.5 &&
  inner.top >= outer.top - 0.5 &&
  inner.bottom <= outer.bottom + 0.5;

const VIEWPORT_BOX: Box = {
  left: 0,
  top: 0,
  right: SMALL.width,
  bottom: SMALL.height,
};

for (const theme of THEMES) {
  describe.serial(`320x640, ${theme.name}, ${engineName}`, () => {
    for (const state of ["recording", "paused"] as const) {
      test(`the Ribbon (${state}): the trace stays inside its area and clear of the Pause button`, async () => {
        const page = await open(
          `recorder-final-minimized-${state}`,
          theme.param,
          "[data-testid=ribbon]",
        );
        const [area] = await boxes(page, ".ribbon-bars");
        const [timer] = await boxes(page, "[data-testid=ribbon-timer]");
        const [pause] = await boxes(page, "[data-testid=ribbon-pause]");
        const [stop] = await boxes(page, "[data-testid=ribbon-stop]");
        const bars = await boxes(page, "[data-spectrum-bars] > span");
        expect(bars.length).toBe(30);
        for (const bar of bars) {
          expect(within(bar, area)).toBe(true);
          expect(apart(bar, pause)).toBe(true);
          expect(apart(bar, stop)).toBe(true);
          expect(apart(bar, timer)).toBe(true);
        }
        // The button's whole 44 px box and the trace's area do not meet either.
        expect(apart(area, pause)).toBe(true);
        // Every bar is still drawn: at least 1 px wide.
        for (const bar of bars) expect(bar.right - bar.left).toBeGreaterThan(1);
        await page.context().close();
      });
    }

    test("the Ribbon's Pause disc has an edge or fill that shows against the Ribbon", async () => {
      const page = await open(
        "recorder-final-minimized-recording",
        theme.param,
        "[data-testid=ribbon]",
      );
      const { ribbon, disc, edge } = await page.evaluate(() => {
        const ribbonEl = document.querySelector(".ribbon")!;
        const discEl = document.querySelector(
          "[data-testid=ribbon-pause] .mini-disc",
        )!;
        const style = getComputedStyle(discEl);
        return {
          ribbon: getComputedStyle(ribbonEl).backgroundColor,
          disc: style.backgroundColor,
          edge: style.boxShadow,
        };
      });
      // Either the disc's fill differs from the Ribbon's, or it draws an edge that is not white-on-cream.
      expect(disc !== ribbon || edge !== "none").toBe(true);
      if (theme.name === "Day") {
        expect(disc).not.toBe(ribbon);
        expect(edge).not.toContain("rgba(255, 255, 255, 0.95)");
      }
      await page.context().close();
    });

    test("the modes card: the name and sub-label never reach the Privacy and Accuracy dots", async () => {
      const page = await open(
        "recorder-final-phone-modes",
        theme.param,
        "[data-testid=modes-card] .pr-mprow",
      );
      const rows = await page.$$eval(".pr-mprow", (rowEls) =>
        rowEls.map((row) => {
          const box = (el: Element | null) => {
            const { left, top, right, bottom } = el!.getBoundingClientRect();
            return { left, top, right, bottom };
          };
          return {
            mode: row.getAttribute("data-mode"),
            title: box(row.querySelector(".pr-mptitle")),
            parts: [...row.querySelectorAll(".pr-mptitle > *")].map(box),
            dots: [...row.querySelectorAll(".pr-dots-col")].map(box),
          };
        }),
      );
      expect(rows.length).toBe(4);
      for (const row of rows) {
        expect(row.dots.length).toBe(2);
        for (const dots of row.dots) {
          expect(apart(row.title, dots, 4)).toBe(true);
          for (const part of row.parts) expect(apart(part, dots, 4)).toBe(true);
        }
      }
      // The sub-label and its name are both still there, whole.
      expect(
        await page.$$eval(".pr-mptitle .s", (els) =>
          els.every((el) => el.scrollWidth <= el.clientWidth + 1),
        ),
      ).toBe(true);
      await page.context().close();
    });

    test("the modes card stays inside the screen", async () => {
      const page = await open(
        "recorder-final-phone-modes",
        theme.param,
        "[data-testid=modes-card]",
      );
      const [card] = await boxes(page, "[data-testid=modes-card]");
      expect(within(card, VIEWPORT_BOX)).toBe(true);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await page.context().close();
    });

    for (const screen of [
      "recorder-final-phone-paused",
      "recorder-final-phone-long-device-paused",
    ]) {
      test(`${screen}: the pill keeps clear of the Minimise button`, async () => {
        const page = await open(
          screen,
          theme.param,
          "[data-testid=phone-recorder-pill]",
        );
        const [pill] = await boxes(page, "[data-testid=phone-recorder-pill]");
        const [minimise] = await boxes(
          page,
          'button[aria-label="Minimise recorder"]',
        );
        expect(apart(pill, minimise, 8)).toBe(true);
        expect(within(pill, VIEWPORT_BOX)).toBe(true);
        await page.context().close();
      });
    }

    test("the full recorder: the scale, the via pill and the controls fit, and none overlap", async () => {
      const page = await open(
        "recorder-final-phone-long-device",
        theme.param,
        "[data-testid=phone-recorder]",
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      const [via] = await boxes(page, ".pr-srcpill");
      expect(within(via, VIEWPORT_BOX)).toBe(true);
      const controls = await boxes(page, ".pr-controls .pr-b");
      expect(controls.length).toBeGreaterThanOrEqual(3);
      for (const control of controls)
        expect(within(control, VIEWPORT_BOX)).toBe(true);
      for (let i = 0; i < controls.length; i++)
        for (let j = i + 1; j < controls.length; j++)
          expect(apart(controls[i], controls[j])).toBe(true);
      const [ends] = await boxes(page, ".pr-ends");
      expect(within(ends, VIEWPORT_BOX)).toBe(true);
      expect(apart(via, controls[0])).toBe(true);
      await page.context().close();
    });

    test("the via menu with a long device name stays inside the screen", async () => {
      const page = await open(
        "recorder-final-phone-long-device-menu",
        theme.param,
        "[data-testid=via-menu]",
      );
      const [menu] = await boxes(page, "[data-testid=via-menu]");
      expect(within(menu, VIEWPORT_BOX)).toBe(true);
      await page.context().close();
    });

    test("the discard sheet fits and its buttons are whole", async () => {
      const page = await open(
        "recorder-final-phone-discard",
        theme.param,
        "[role=dialog], [role=alertdialog]",
      );
      const [sheet] = await boxes(page, "[role=dialog], [role=alertdialog]");
      expect(within(sheet, VIEWPORT_BOX)).toBe(true);
      const buttons = await boxes(
        page,
        "[role=dialog] button, [role=alertdialog] button",
      );
      for (const button of buttons) expect(within(button, sheet)).toBe(true);
      await page.context().close();
    });

    test("Capture home: the actions fit, and a row's title never reaches its duration", async () => {
      const page = await open(
        "capture-soft-long-titles",
        theme.param,
        "[data-testid=capture-actions]",
      );
      await page.waitForSelector(".soft-row");
      const actions = await boxes(page, ".soft-actions > *");
      expect(actions.length).toBe(3);
      const [strip] = await boxes(page, ".soft-actions");
      for (const action of actions) expect(within(action, strip)).toBe(true);
      for (let i = 0; i < actions.length - 1; i++)
        expect(apart(actions[i], actions[i + 1])).toBe(true);
      // Each action's label fits inside its button.
      expect(
        await page.$$eval(".soft-act", (buttons) =>
          buttons.every(
            (button) => button.scrollWidth <= button.clientWidth + 1,
          ),
        ),
      ).toBe(true);
      const rows = await page.$$eval(".soft-row", (rowEls) =>
        rowEls
          .filter((row) => row.getBoundingClientRect().width > 0)
          .map((row) => {
            const box = (el: Element | null) => {
              const { left, top, right, bottom } = el!.getBoundingClientRect();
              return { left, top, right, bottom };
            };
            return {
              row: box(row),
              text: box(row.querySelector(".soft-row-text")),
              aside: box(row.querySelector(".soft-row-aside")),
            };
          }),
      );
      expect(rows.length).toBe(3);
      for (const row of rows) {
        expect(apart(row.text, row.aside, 4)).toBe(true);
        expect(within(row.aside, row.row)).toBe(true);
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await page.context().close();
    });
  });
}
