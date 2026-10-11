// The recorder fits every viewport it can be shown in: a phone upright (390 and 320 wide), on its side (844x390
// and 740x360) and at large font scales (1.5 and 2.0). Each assertion is geometry: no two parts of the screen
// meet, the ring and its ticks stay inside their stage, the controls can be reached, nothing runs off the
// screen sideways, and what does not fit scrolls. The desktop and web recorders keep Done and Discard when the
// microphone is lost mid-recording, and their toasts keep clear of the pill, the timer and the controls.
//
//   EXO_UI_ENGINE=chromium   webkit (default: Exo's WKWebView) or chromium
//   EXO_UI_SHOTS=<dir>       also write a screenshot of every case there
//   EXO_UI_FIT_VIEWPORTS=<name> comma-separated viewport names, useful for focused reruns
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, webkit, type Browser, type Page } from "playwright";
import { TICK_REACH } from "../frontend/src/capture/recorder/final/halo/renderer";
import { buildHarness, serveHarness } from "./exo-ui/harness-server";

const engineName = process.env.EXO_UI_ENGINE ?? "webkit";
const engine = engineName === "chromium" ? chromium : webkit;
const shotsDir = process.env.EXO_UI_SHOTS;
if (shotsDir) mkdirSync(shotsDir, { recursive: true });

setDefaultTimeout(30_000);

let server: ReturnType<typeof serveHarness>;

beforeAll(async () => {
  server = serveHarness(await buildHarness());
}, 120_000);

afterAll(async () => {
  server?.stop(true);
});

async function launchBrowser(): Promise<Browser> {
  return engine.launch({ headless: true });
}

type BrowserGroup = { current?: Browser };

async function browserForGroup(group: BrowserGroup): Promise<Browser> {
  if (!group.current?.isConnected()) group.current = await launchBrowser();
  return group.current;
}

async function contextForGroup(
  group: BrowserGroup,
  options: Parameters<Browser["newContext"]>[0],
) {
  const browser = await browserForGroup(group);
  try {
    return await browser.newContext(options);
  } catch (error) {
    console.warn(
      `[recorder-fit] context creation failed; relaunching this group: ${String(error)}`,
    );
    group.current = undefined;
    group.current = await launchBrowser();
    return group.current.newContext(options);
  }
}

async function closeBrowser(group: BrowserGroup): Promise<void> {
  const browser = group.current;
  group.current = undefined;
  if (!browser?.isConnected()) return;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      browser.close(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, 10_000);
      }),
    ]);
  } catch (error) {
    if (browser.isConnected()) throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

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

const VIEWPORTS = [
  { name: "390x844 portrait", width: 390, height: 844, fontScale: 1 },
  { name: "320x545 portrait", width: 320, height: 545, fontScale: 1 },
  { name: "844x390 landscape", width: 844, height: 390, fontScale: 1 },
  { name: "740x360 landscape", width: 740, height: 360, fontScale: 1 },
  { name: "390x844 font 1.5", width: 390, height: 844, fontScale: 1.5 },
  { name: "320x545 font 1.5", width: 320, height: 545, fontScale: 1.5 },
  {
    name: "844x390 landscape font 1.5",
    width: 844,
    height: 390,
    fontScale: 1.5,
  },
  {
    name: "740x360 landscape font 1.5",
    width: 740,
    height: 360,
    fontScale: 1.5,
  },
  {
    name: "545x320 landscape font 1.5",
    width: 545,
    height: 320,
    fontScale: 1.5,
  },
  { name: "390x844 font 2.0", width: 390, height: 844, fontScale: 2 },
  { name: "320x545 font 2.0", width: 320, height: 545, fontScale: 2 },
  { name: "844x390 landscape font 2.0", width: 844, height: 390, fontScale: 2 },
  { name: "740x360 landscape font 2.0", width: 740, height: 360, fontScale: 2 },
  { name: "545x320 landscape", width: 545, height: 320, fontScale: 1 },
  { name: "545x320 landscape font 2.0", width: 545, height: 320, fontScale: 2 },
] as const;
const viewportFilter = process.env.EXO_UI_FIT_VIEWPORTS?.split(",").map(
  (name) => name.trim(),
);
const fitViewports = viewportFilter?.length
  ? VIEWPORTS.filter((viewport) => viewportFilter.includes(viewport.name))
  : VIEWPORTS;

const SCREENS = [
  { id: "recording", ready: ".pr-ring" },
  { id: "paused", ready: ".pr-ring" },
  { id: "long-device", ready: ".pr-ring" },
  { id: "revoked", ready: ".pr-ring" },
  { id: "mic-denied", ready: ".pr-ring" },
  { id: "moment-field", ready: ".pr-moment input" },
  { id: "modes", ready: ".pr-modes" },
  { id: "long-device-menu", ready: ".pr-menu" },
] as const;

const slug = (text: string) => text.replace(/[^a-z0-9.]+/gi, "-");

async function open(
  group: BrowserGroup,
  screen: string,
  theme: "light" | "dark",
  viewport: { width: number; height: number; fontScale: number },
  ready: string,
  options: { level?: number; keyboard?: number } = {},
  platform: "android" | "ios" = "android",
): Promise<Page> {
  try {
    const page = await (
      await contextForGroup(group, {
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        reducedMotion: "reduce",
      })
    ).newPage();
    await page.goto(
      `http://127.0.0.1:${server.port}/?screen=recorder-final-phone-${screen}&theme=${theme}&platform=${platform}&freeze=1${options.level === undefined ? "" : `&level=${options.level}`}`,
    );
    await page.waitForSelector(ready);
    if (viewport.fontScale !== 1) {
      await page.evaluate(
        ({ scale, platform }) => {
          const root = document.documentElement;
          root.style.removeProperty("font-size");
          root.toggleAttribute("data-large-text", scale > 1.25);
          if (platform === "ios") {
            root.style.setProperty("--ios-body-scale", String(scale));
            return;
          }

          // Android WebView scales text only. Emulate textZoom without changing
          // layout units, preserving the explicit CSS compensation for timer slots.
          root.style.setProperty("--android-body-scale", String(scale));
          const slots = [
            ...document.querySelectorAll<HTMLElement>(".pr-digit, .pr-colon"),
          ];
          const widths = slots.map((slot) => getComputedStyle(slot).width);
          const fonts = [
            ...document.querySelectorAll<HTMLElement>("body *"),
          ].map(
            (element) =>
              [
                element,
                Number.parseFloat(getComputedStyle(element).fontSize),
              ] as const,
          );
          for (const [element, size] of fonts) {
            if (Number.isFinite(size) && size > 0)
              element.style.fontSize = `${size * scale}px`;
          }
          slots.forEach((slot, index) => {
            slot.style.width = widths[index]!;
          });
        },
        { scale: viewport.fontScale, platform },
      );
    }
    if (options.keyboard) {
      // What iOS does when the keyboard rises: the visual viewport shrinks, the layout viewport does not.
      await page.evaluate((height) => {
        const viewport = window.visualViewport!;
        Object.defineProperty(viewport, "height", {
          configurable: true,
          get: () => window.innerHeight - height,
        });
        Object.defineProperty(viewport, "offsetTop", {
          configurable: true,
          get: () => 0,
        });
        viewport.dispatchEvent(new Event("resize"));
      }, options.keyboard);
    }
    await page.waitForTimeout(400);
    return page;
  } catch (error) {
    // A load/readiness timeout can leave Playwright's Browser handle reporting
    // connected even though the shared process is already closed. Tear down
    // this group now so its next test starts with a fresh browser.
    await closeBrowser(group);
    throw error;
  }
}

const SELECTORS = {
  minimise: 'button[aria-label="Minimise recorder"]',
  pill: "[data-testid=phone-recorder-pill]",
  timer: ".pr-time > span",
  plus: ".pr-time-slot",
  status: ".pr-extra",
  notes: ".pr-notes > *",
  mode: ".pr-mrow",
  scale: ".pr-scale",
  ends: ".pr-ends",
  caption: ".pr-capline",
  via: ".pr-srcbtn",
  alert: ".pr-alert",
  guidance: "[data-testid=browser-mic-guidance]",
  controls: ".pr-controls .pr-b",
};

/** Every visible part of the recorder, by name, in page coordinates; the ring is its disc and its ticks. */
async function parts(page: Page) {
  return page.evaluate(
    ({ selectors, reach }) => {
      const box = (r: DOMRect) => ({
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
      });
      const out: { name: string; box: ReturnType<typeof box> }[] = [];
      for (const [name, selector] of Object.entries(selectors)) {
        for (const el of document.querySelectorAll(selector)) {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          if (name === "status" && !el.textContent?.trim()) continue;
          out.push({ name, box: box(rect) });
        }
      }
      const ring = document.querySelector(".pr-ring");
      if (ring) {
        const r = ring.getBoundingClientRect();
        const grow = (r.width * reach - r.width) / 2;
        out.push({
          name: "ring",
          box: {
            left: r.left - grow,
            top: r.top - grow,
            right: r.right + grow,
            bottom: r.bottom + grow,
          },
        });
      }
      return out;
    },
    { selectors: SELECTORS, reach: TICK_REACH },
  );
}

// A part is only compared with the parts it does not contain by design: the plus lives at the timer's side,
// and the minimise button and the pill share the top row.
const BY_DESIGN = new Set(["timer|plus"]);

for (const platform of ["android", "ios"] as const) {
  for (const viewport of fitViewports.filter(
    (candidate) => candidate.fontScale === 2,
  )) {
    describe.serial(`${viewport.name}, ${platform}, timer slots`, () => {
      const groupBrowser: BrowserGroup = {};
      beforeAll(async () => {
        await browserForGroup(groupBrowser);
      });
      afterAll(async () => closeBrowser(groupBrowser));

      test("timer digit slots and plus do not overlap", async () => {
        const page = await open(
          groupBrowser,
          "recording",
          "light",
          viewport,
          ".pr-ring",
          {},
          platform,
        );
        const overlaps = await page.evaluate(() => {
          const intersect = (a: DOMRect, b: DOMRect) =>
            a.left < b.right &&
            a.right > b.left &&
            a.top < b.bottom &&
            a.bottom > b.top;
          const digits = [
            ...document.querySelectorAll<HTMLElement>(".pr-digits > span"),
          ];
          const boxes = digits.map((digit) => digit.getBoundingClientRect());
          const plus = document
            .querySelector<HTMLElement>(".pr-time-slot")
            ?.getBoundingClientRect();
          return {
            digitPairs: boxes.some((box, index) =>
              boxes.slice(index + 1).some((other) => intersect(box, other)),
            ),
            plus: Boolean(plus && boxes.some((box) => intersect(box, plus))),
            rootSize: getComputedStyle(document.documentElement).fontSize,
            timerSize: Number.parseFloat(
              getComputedStyle(document.querySelector<HTMLElement>(".pr-time")!)
                .fontSize,
            ),
            landscape: window.matchMedia(
              "(orientation: landscape) and (max-height: 520px)",
            ).matches,
          };
        });
        expect(overlaps.digitPairs).toBe(false);
        expect(overlaps.plus).toBe(false);
        expect(overlaps.rootSize).toBe(platform === "ios" ? "32px" : "16px");
        expect(overlaps.timerSize).toBeLessThanOrEqual(
          overlaps.landscape ? 80 : 100,
        );
        await page.context().close();
      });
    });
  }
}

for (const platform of ["android", "ios"] as const) {
  for (const theme of ["light", "dark"] as const) {
    for (const viewport of fitViewports) {
      describe.serial(
        `${viewport.name}, ${theme}, ${platform}, ${engineName}`,
        () => {
          for (const { id, ready } of SCREENS) {
            describe.serial(
              `${id}: ${viewport.name}, ${theme}, ${platform}`,
              () => {
                const groupBrowser: BrowserGroup = {};
                beforeAll(async () => {
                  await browserForGroup(groupBrowser);
                });
                afterAll(async () => closeBrowser(groupBrowser));

                test(`${id}: nothing overlaps, nothing runs off the side, the ring stays in its stage`, async () => {
                  const page = await open(
                    groupBrowser,
                    id,
                    theme,
                    viewport,
                    ready,
                    {},
                    platform,
                  );
                  if (shotsDir)
                    await page.screenshot({
                      path: join(
                        shotsDir,
                        `${slug(viewport.name)}-${id}-${theme}.png`,
                      ),
                    });

                  if (id === "modes") {
                    const layout = await page.evaluate(() => {
                      const panel =
                        document.querySelector<HTMLElement>(".pr-modes")!;
                      const rect = panel.getBoundingClientRect();
                      const headings = [
                        ...document.querySelectorAll<HTMLElement>(
                          ".pr-mplg span",
                        ),
                      ];
                      const dots = [
                        ...document.querySelectorAll<HTMLElement>(
                          ".pr-dots-col",
                        ),
                      ].slice(0, 2);
                      return {
                        panel: { top: rect.top, bottom: rect.bottom },
                        dockTop: document
                          .querySelector<HTMLElement>(".pr-dock")!
                          .getBoundingClientRect().top,
                        headings: headings.map((heading) => ({
                          text: heading.textContent,
                          width: heading.getBoundingClientRect().width,
                          clientWidth: heading.clientWidth,
                          scrollWidth: heading.scrollWidth,
                          textBox: (() => {
                            const range = document.createRange();
                            range.selectNodeContents(heading);
                            const rect = range.getBoundingClientRect();
                            return { left: rect.left, right: rect.right };
                          })(),
                        })),
                        dotWidths: dots.map(
                          (dot) => dot.getBoundingClientRect().width,
                        ),
                      };
                    });
                    expect(layout.panel.top).toBeGreaterThanOrEqual(0);
                    expect(layout.panel.bottom).toBeLessThanOrEqual(
                      viewport.height + 0.5,
                    );
                    expect(layout.panel.bottom).toBeLessThanOrEqual(
                      layout.dockTop + 0.5,
                    );
                    if (viewport.fontScale > 1) {
                      expect(
                        layout.headings.every(
                          (heading) =>
                            heading.scrollWidth <= heading.clientWidth + 1,
                        ),
                      ).toBe(true);
                    } else {
                      expect(
                        layout.headings.every(
                          (heading) => Math.abs(heading.width - 58) < 1,
                        ),
                      ).toBe(true);
                      expect(
                        layout.headings[0]!.textBox.right,
                      ).toBeLessThanOrEqual(layout.headings[1]!.textBox.left);
                    }
                    expect(
                      layout.headings.every(
                        (heading, index) =>
                          Math.abs(heading.width - layout.dotWidths[index]!) <
                          1,
                      ),
                    ).toBe(true);
                    await page.context().close();
                    return;
                  }

                  if (id === "long-device-menu") {
                    const menu = await page.evaluate(() => {
                      const panel =
                        document.querySelector<HTMLElement>(".pr-menu")!;
                      const device = [
                        ...document.querySelectorAll<HTMLElement>(
                          ".pr-item .label > span:last-child",
                        ),
                      ].find((label) =>
                        label.textContent?.includes("sdk_gphone64_arm64"),
                      )!;
                      const range = document.createRange();
                      range.selectNodeContents(device);
                      const lines = new Map<
                        number,
                        { left: number; right: number }
                      >();
                      for (const rect of range.getClientRects()) {
                        const top = Math.round(rect.top);
                        const line = lines.get(top);
                        if (line) {
                          line.left = Math.min(line.left, rect.left);
                          line.right = Math.max(line.right, rect.right);
                        } else
                          lines.set(top, {
                            left: rect.left,
                            right: rect.right,
                          });
                      }
                      return {
                        width: panel.getBoundingClientRect().width,
                        expectedWidth: Math.min(358, window.innerWidth - 16),
                        lineWidths: [...lines.values()].map(
                          (line) => line.right - line.left,
                        ),
                        fontSize: Number.parseFloat(
                          getComputedStyle(device).fontSize,
                        ),
                      };
                    });
                    expect(
                      Math.abs(menu.width - menu.expectedWidth),
                    ).toBeLessThanOrEqual(1);
                    expect(menu.lineWidths.length).toBeLessThanOrEqual(2);
                    expect(Math.min(...menu.lineWidths)).toBeGreaterThan(
                      menu.fontSize * 1.5,
                    );
                    await page.context().close();
                    return;
                  }

                  expect(
                    await page.evaluate(
                      () =>
                        document.documentElement.scrollWidth <=
                        window.innerWidth,
                    ),
                  ).toBe(true);
                  expect(
                    await page.$eval(
                      ".pr-main",
                      (el) => el.scrollWidth <= el.clientWidth + 1,
                    ),
                  ).toBe(true);

                  // The screen scrolls inside .pr-main: compare the parts as laid out, from the top.
                  const laidOut = await parts(page);

                  const stage = await page.$eval(".pr-stage", (el) => {
                    const r = el.getBoundingClientRect();
                    return {
                      left: r.left,
                      top: r.top,
                      right: r.right,
                      bottom: r.bottom,
                    };
                  });
                  const ring = laidOut.find((p) => p.name === "ring");
                  expect(ring).toBeDefined();
                  expect(within(ring!.box, stage)).toBe(true);

                  // The dock holds the controls and is the last thing in the flow; the rest of the screen is above it.
                  const dock = await page.$eval(".pr-dock", (el) => {
                    const r = el.getBoundingClientRect();
                    return {
                      left: r.left,
                      top: r.top,
                      right: r.right,
                      bottom: r.bottom,
                    };
                  });
                  const flow = laidOut.filter(
                    (p) =>
                      p.name !== "controls" &&
                      p.name !== "alert" &&
                      p.name !== "guidance",
                  );
                  for (let i = 0; i < flow.length; i++) {
                    for (let j = i + 1; j < flow.length; j++) {
                      const a = flow[i]!;
                      const b = flow[j]!;
                      if (BY_DESIGN.has(`${a.name}|${b.name}`)) continue;
                      if (!apart(a.box, b.box))
                        throw new Error(
                          `${a.name} ${JSON.stringify(a.box)} meets ${b.name} ${JSON.stringify(b.box)}`,
                        );
                    }
                  }
                  const controls = laidOut.filter((p) => p.name === "controls");
                  for (let i = 0; i < controls.length; i++)
                    for (let j = i + 1; j < controls.length; j++)
                      expect(apart(controls[i]!.box, controls[j]!.box)).toBe(
                        true,
                      );
                  expect(dock.bottom).toBeLessThanOrEqual(
                    viewport.height + 0.5,
                  );
                  await page.context().close();
                });

                test(`${id}: every control can be reached`, async () => {
                  const page = await open(
                    groupBrowser,
                    id,
                    theme,
                    viewport,
                    ready,
                    {},
                    platform,
                  );
                  if (id === "long-device-menu") {
                    await page.context().close();
                    return;
                  }
                  const dockHolds = id !== "moment-field";
                  if (dockHolds) {
                    // Done and Discard are in reach without scrolling, at any size, and nothing covers them.
                    const dockAction =
                      id === "paused" ? "Resume recording" : "Pause recording";
                    for (const label of ["Discard recording", dockAction]) {
                      const hit = await page.evaluate((name) => {
                        const el =
                          name === "Pause recording" ||
                          name === "Resume recording"
                            ? document.querySelector(
                                `.pr-dock [aria-label="${name}"]`,
                              )
                            : document.querySelector(`[aria-label="${name}"]`);
                        if (!el) return "missing";
                        const r = el.getBoundingClientRect();
                        const inside =
                          r.left >= 0 &&
                          r.top >= 0 &&
                          r.right <= window.innerWidth &&
                          r.bottom <= window.innerHeight;
                        const top = document.elementFromPoint(
                          r.left + r.width / 2,
                          r.top + r.height / 2,
                        );
                        return inside && top && el.contains(top)
                          ? "ok"
                          : JSON.stringify({
                              inside,
                              target: r.toJSON(),
                              top: top?.outerHTML.slice(0, 160) ?? null,
                            });
                      }, label);
                      if (
                        id === "mic-denied" ||
                        (id === "revoked" && label === dockAction)
                      )
                        expect(hit).toBe("missing");
                      else if (hit !== "ok")
                        throw new Error(
                          `${label} is covered while modes are open: ${hit}`,
                        );
                    }
                    if (id !== "mic-denied") {
                      const done = await page.evaluate(() => {
                        const el = [
                          ...document.querySelectorAll(".pr-b.main"),
                        ][0];
                        if (!el) return "missing";
                        const r = el.getBoundingClientRect();
                        const top = document.elementFromPoint(
                          r.left + r.width / 2,
                          r.top + r.height / 2,
                        );
                        const inside =
                          r.left >= 0 &&
                          r.top >= 0 &&
                          r.right <= window.innerWidth &&
                          r.bottom <= window.innerHeight;
                        return inside && top && el.contains(top)
                          ? "ok"
                          : "covered";
                      });
                      expect(done).toBe("ok");
                    }
                  }
                  if (id === "modes") {
                    await page.context().close();
                    return;
                  }
                  // The rest scrolls into view, above the dock, and is not covered when it does.
                  const targets = [
                    'button[aria-label="Minimise recorder"]',
                    ".pr-minfo",
                    ".pr-scale",
                    ".pr-srcbtn",
                    ".pr-ring",
                    ".pr-vnotes",
                    ".pr-moment input",
                  ];
                  for (const selector of targets) {
                    const result = await page.evaluate((sel) => {
                      const el = document.querySelector(sel);
                      if (!el) return "absent";
                      const own = el.getBoundingClientRect();
                      if (own.width === 0 || own.height === 0) return "absent";
                      const main =
                        document.querySelector<HTMLElement>(".pr-main")!;
                      const dockEl = document.querySelector(".pr-dock")!;
                      // Bring the control as far from the dock as the scroll allows, then see what is at its centre.
                      const rect = el.getBoundingClientRect();
                      const mainTop = main.getBoundingClientRect().top;
                      main.scrollTop += rect.top - mainTop - 8;
                      const after = el.getBoundingClientRect();
                      const dockRect = dockEl.getBoundingClientRect();
                      // In landscape the dock is a column of its own: it only limits what shares its columns.
                      const dockTop =
                        after.left < dockRect.right &&
                        after.right > dockRect.left
                          ? dockRect.top
                          : window.innerHeight;
                      const x = after.left + after.width / 2;
                      const y = after.top + Math.min(after.height / 2, 20);
                      const hit = document.elementFromPoint(x, y);
                      const visible =
                        after.top >= mainTop - 0.5 && after.top + 1 < dockTop;
                      // The ring's canvas paints the disc and ticks around its button.
                      const owner = sel === ".pr-ring" ? el.parentElement! : el;
                      return hit && owner.contains(hit) && visible
                        ? "ok"
                        : `blocked by ${hit?.className || hit?.tagName} (visible ${visible})`;
                    }, selector);
                    if (result !== "absent")
                      expect([selector, result]).toEqual([selector, "ok"]);
                  }
                  await page.context().close();
                });
              },
            );
          }
        },
      );
    }
  }
}

// The timer sits centred in its row with the ＋ ten pixels past its last digit, on the same line, wherever it fits.
for (const viewport of fitViewports.filter((v) => v.fontScale === 1)) {
  describe.serial(
    `the timer and its ＋ (${viewport.name}, ${engineName})`,
    () => {
      const groupBrowser: BrowserGroup = {};
      beforeAll(async () => {
        await browserForGroup(groupBrowser);
      });
      afterAll(async () => closeBrowser(groupBrowser));

      test(`${viewport.name}: the timer is centred and the ＋ is beside it`, async () => {
        const page = await open(
          groupBrowser,
          "recording",
          "light",
          viewport,
          ".pr-ring",
        );
        const layout = await page.evaluate(() => {
          const rect = (selector: string) =>
            document.querySelector(selector)!.getBoundingClientRect();
          return {
            row: rect(".pr-time-row"),
            timer: rect(".pr-time > span"),
            plus: rect(".pr-time-slot"),
          };
        });
        const rowCentre = (layout.row.left + layout.row.right) / 2;
        expect(
          Math.abs((layout.timer.left + layout.timer.right) / 2 - rowCentre),
        ).toBeLessThan(1.5);
        expect(
          Math.abs(layout.plus.left - layout.timer.right - 10),
        ).toBeLessThan(1.5);
        expect(
          Math.abs(
            (layout.plus.top + layout.plus.bottom) / 2 -
              (layout.timer.top + layout.timer.bottom) / 2,
          ),
        ).toBeLessThan(4);
        await page.context().close();
      });
    },
  );
}

// With the keyboard up (the visual viewport shorter than the layout viewport, as on iOS) the moment field and its
// key are above the keyboard once the screen is scrolled to them.
const KEYBOARD_CASES = [
  { width: 390, height: 844, fontScale: 1, keyboard: 336 },
  { width: 320, height: 545, fontScale: 2, keyboard: 260 },
  { width: 844, height: 390, fontScale: 1, keyboard: 200 },
  { width: 740, height: 360, fontScale: 2, keyboard: 200 },
];
for (const c of KEYBOARD_CASES) {
  describe.serial(
    `the moment field above the keyboard (${c.width}x${c.height}, ${engineName})`,
    () => {
      const groupBrowser: BrowserGroup = {};
      beforeAll(async () => {
        await browserForGroup(groupBrowser);
      });
      afterAll(async () => closeBrowser(groupBrowser));

      test(`${c.width}x${c.height}, font ${c.fontScale}, keyboard ${c.keyboard}`, async () => {
        const page = await open(
          groupBrowser,
          "moment-field",
          "light",
          c,
          ".pr-moment input",
          { keyboard: c.keyboard },
        );
        const result = await page.evaluate((keyboard) => {
          const main = document.querySelector<HTMLElement>(".pr-main")!;
          const field = document.querySelector(".pr-moment input")!;
          const key = document.querySelector(".pr-moment button")!;
          main.scrollTop +=
            field.getBoundingClientRect().top -
            main.getBoundingClientRect().top -
            8;
          const visibleBottom = window.innerHeight - keyboard;
          const within = (el: Element) => {
            const r = el.getBoundingClientRect();
            return {
              top: r.top,
              bottom: r.bottom,
              ok: r.top >= 0 && r.bottom <= visibleBottom + 0.5,
            };
          };
          return {
            visibleBottom,
            mainBottom: main.getBoundingClientRect().bottom,
            field: within(field),
            key: within(key),
          };
        }, c.keyboard);
        expect(result.mainBottom).toBeLessThanOrEqual(
          result.visibleBottom + 0.5,
        );
        expect([c, "field", result.field]).toEqual([
          c,
          "field",
          { ...result.field, ok: true },
        ]);
        expect([c, "key", result.key]).toEqual([
          c,
          "key",
          { ...result.key, ok: true },
        ]);
        await page.context().close();
      });
    },
  );
}

// The ticks are painted out to TICK_REACH times the disc when the source is loud; what is painted stays inside the stage.
describe.serial(`the loudest ticks stay in the stage (${engineName})`, () => {
  describe.serial("ring sizing factor", () => {
    const groupBrowser: BrowserGroup = {};
    beforeAll(async () => {
      await browserForGroup(groupBrowser);
    });
    afterAll(async () => closeBrowser(groupBrowser));

    test("covers what the renderer can draw", async () => {
      const page = await open(
        groupBrowser,
        "recording",
        "light",
        VIEWPORTS[0],
        ".pr-ring",
      );
      const reach = await page.$eval(".pr-ring", (el) =>
        parseFloat(getComputedStyle(el).getPropertyValue("--ring-reach")),
      );
      expect(reach).toBeGreaterThanOrEqual(TICK_REACH);
      await page.context().close();
    });
  });
  for (const viewport of fitViewports) {
    describe.serial(viewport.name, () => {
      const groupBrowser: BrowserGroup = {};
      beforeAll(async () => {
        await browserForGroup(groupBrowser);
      });
      afterAll(async () => closeBrowser(groupBrowser));

      test("painted at level 1, the ticks are inside the stage", async () => {
        const page = await open(
          groupBrowser,
          "recording",
          "light",
          viewport,
          ".halo-ring__canvas",
          { level: 1 },
        );
        await page.waitForTimeout(2000);
        const painted = await page.evaluate(() => {
          const canvas =
            document.querySelector<HTMLCanvasElement>(".halo-ring__canvas")!;
          const box = canvas.getBoundingClientRect();
          const data = canvas
            .getContext("2d")!
            .getImageData(0, 0, canvas.width, canvas.height).data;
          let top = Infinity,
            bottom = -Infinity,
            left = Infinity,
            right = -Infinity;
          for (let y = 0; y < canvas.height; y++)
            for (let x = 0; x < canvas.width; x++) {
              const i = (y * canvas.width + x) * 4;
              // Opaque red: the ticks themselves, not their faint glow.
              if (
                data[i + 3]! > 128 &&
                data[i]! > 150 &&
                data[i]! > data[i + 1]! * 1.3
              ) {
                top = Math.min(top, y);
                bottom = Math.max(bottom, y + 1);
                left = Math.min(left, x);
                right = Math.max(right, x + 1);
              }
            }
          const stage = document
            .querySelector(".pr-stage")!
            .getBoundingClientRect();
          return {
            found: bottom > top,
            top: box.top + (top / canvas.height) * box.height,
            bottom: box.top + (bottom / canvas.height) * box.height,
            left: box.left + (left / canvas.width) * box.width,
            right: box.left + (right / canvas.width) * box.width,
            stage: {
              top: stage.top,
              bottom: stage.bottom,
              left: stage.left,
              right: stage.right,
            },
          };
        });
        expect(painted.found).toBe(true);
        expect(painted.top).toBeGreaterThanOrEqual(painted.stage.top - 0.5);
        expect(painted.bottom).toBeLessThanOrEqual(painted.stage.bottom + 0.5);
        expect(painted.left).toBeGreaterThanOrEqual(painted.stage.left - 0.5);
        expect(painted.right).toBeLessThanOrEqual(painted.stage.right + 0.5);
        await page.context().close();
      });
    });
  }
});

const DESKTOP = { width: 1280, height: 800 };

for (const theme of ["light", "dark"] as const) {
  describe.serial(
    `the recorder on desktop and web (${theme}, ${engineName})`,
    () => {
      const groupBrowser: BrowserGroup = {};
      beforeAll(async () => {
        await browserForGroup(groupBrowser);
      });
      afterAll(async () => closeBrowser(groupBrowser));

      async function openWide(screen: string, platform: string) {
        const page = await (
          await (
            await browserForGroup(groupBrowser)
          ).newContext({
            viewport: DESKTOP,
            reducedMotion: "reduce",
          })
        ).newPage();
        await page.goto(
          `http://127.0.0.1:${server.port}/?screen=${screen}&theme=${theme}&platform=${platform}&freeze=1`,
        );
        await page.waitForSelector("[data-testid=desktop-recorder]");
        await page.waitForTimeout(400);
        return page;
      }

      for (const [screen, platform, name] of [
        ["recorder-final-desktop-mic-revoked", "tauri", "desktop"],
        ["recorder-final-web-mic-revoked", "web", "web"],
      ] as const) {
        test(`${name}: losing the microphone mid-recording keeps Done and Discard`, async () => {
          const page = await openWide(screen, platform);
          if (shotsDir)
            await page.screenshot({
              path: join(shotsDir, `${name}-mic-revoked-${theme}.png`),
            });
          const discard = page.getByRole("button", {
            name: "Discard recording",
          });
          const done = page.getByRole("button", { name: /Done/ });
          expect(await discard.count()).toBe(1);
          expect(await done.count()).toBe(1);
          expect(await discard.isEnabled()).toBe(true);
          expect(await done.isEnabled()).toBe(true);
          const box = async (selector: string): Promise<Box> =>
            page.$eval(selector, (el) => {
              const r = el.getBoundingClientRect();
              return {
                left: r.left,
                top: r.top,
                right: r.right,
                bottom: r.bottom,
              };
            });
          const action = await box(
            platform === "web"
              ? "[data-testid=browser-mic-guidance]"
              : ".pr-controls .pr-b.primary",
          );
          const doneBox = await box(".pr-b.main");
          // The microphone's own action sits above the row, and the row is whole inside the window.
          expect(action.bottom).toBeLessThanOrEqual(doneBox.top + 0.5);
          expect(doneBox.bottom).toBeLessThanOrEqual(DESKTOP.height);
          await page.context().close();
        });
      }

      test("the keep-open toast shows once and keeps clear of the pill, the timer and the controls", async () => {
        const page = await openWide("recorder-final-web-keep-open", "web");
        await page.waitForSelector(".dr-toast");
        if (shotsDir)
          await page.screenshot({
            path: join(shotsDir, `web-keep-open-toast-${theme}.png`),
          });
        expect(await page.locator(".dr-toast").count()).toBe(1);
        const toast = await page.$eval(".dr-toast", (el) => {
          const r = el.getBoundingClientRect();
          return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        });
        for (const selector of [
          "[data-testid=desktop-recorder-pill]",
          ".pr-time",
          ".pr-controls .pr-b",
          ".pr-minfo",
          ".pr-scale",
        ]) {
          const boxes = await page.$$eval(selector, (els) =>
            els.map((el) => {
              const r = el.getBoundingClientRect();
              return {
                left: r.left,
                top: r.top,
                right: r.right,
                bottom: r.bottom,
              };
            }),
          );
          for (const other of boxes)
            expect([selector, apart(toast, other)]).toEqual([selector, true]);
        }
        await page.context().close();
      });
    },
  );
}
