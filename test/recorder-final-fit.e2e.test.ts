// The recorder fits every viewport it can be shown in: a phone upright (390 and 320 wide), on its side (844x390
// and 740x360) and at a large font scale (2.0). Each assertion is geometry: no two parts of the screen
// meet, the ring and its ticks stay inside their stage, the controls can be reached, nothing runs off the
// screen sideways, and what does not fit scrolls. The desktop and web recorders keep Done and Discard when the
// microphone is lost mid-recording, and their toasts keep clear of the pill, the timer and the controls.
//
//   EXO_UI_ENGINE=chromium   webkit (default: Exo's WKWebView) or chromium
//   EXO_UI_SHOTS=<dir>       also write a screenshot of every case there
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
import { buildHarness, serveHarness } from "./exo-ui/harness-server";

const engineName = process.env.EXO_UI_ENGINE ?? "webkit";
const engine = engineName === "chromium" ? chromium : webkit;
const shotsDir = process.env.EXO_UI_SHOTS;
if (shotsDir) mkdirSync(shotsDir, { recursive: true });

setDefaultTimeout(30_000);

let browser: Browser;
let server: ReturnType<typeof serveHarness>;

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
  { name: "390x844 font 2.0", width: 390, height: 844, fontScale: 2 },
  { name: "320x545 font 2.0", width: 320, height: 545, fontScale: 2 },
] as const;

const SCREENS = [
  { id: "recording", ready: ".pr-ring" },
  { id: "paused", ready: ".pr-ring" },
  { id: "long-device", ready: ".pr-ring" },
  { id: "revoked", ready: ".pr-ring" },
  { id: "mic-denied", ready: ".pr-ring" },
  { id: "moment-field", ready: ".pr-moment input" },
] as const;

const slug = (text: string) => text.replace(/[^a-z0-9.]+/gi, "-");

async function open(
  screen: string,
  theme: "light" | "dark",
  viewport: { width: number; height: number; fontScale: number },
  ready: string,
): Promise<Page> {
  const page = await (
    await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      reducedMotion: "reduce",
    })
  ).newPage();
  await page.goto(
    `http://127.0.0.1:${server.port}/?screen=recorder-final-phone-${screen}&theme=${theme}&platform=android&freeze=1`,
  );
  await page.waitForSelector(ready);
  if (viewport.fontScale !== 1) {
    // What Android's font scale does to a WebView: every font size is multiplied, whatever unit it was set in.
    await page.evaluate((scale) => {
      const elements = [...document.querySelectorAll<HTMLElement>("*")];
      const sizes = elements.map((el) => parseFloat(getComputedStyle(el).fontSize));
      elements.forEach((el, i) => {
        el.style.fontSize = `${sizes[i]! * scale}px`;
      });
    }, viewport.fontScale);
  }
  await page.waitForTimeout(400);
  return page;
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
  return page.evaluate((selectors) => {
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
      const grow = (r.width * 1.25 - r.width) / 2;
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
  }, SELECTORS);
}

// A part is only compared with the parts it does not contain by design: the plus lives at the timer's side,
// and the minimise button and the pill share the top row.
const BY_DESIGN = new Set(["timer|plus"]);

for (const theme of ["light", "dark"] as const) {
  for (const viewport of VIEWPORTS) {
    describe.serial(`${viewport.name}, ${theme}, ${engineName}`, () => {
      for (const { id, ready } of SCREENS) {
        test(`${id}: nothing overlaps, nothing runs off the side, the ring stays in its stage`, async () => {
          const page = await open(id, theme, viewport, ready);
          if (shotsDir)
            await page.screenshot({
              path: join(shotsDir, `${slug(viewport.name)}-${id}-${theme}.png`),
            });

          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= window.innerWidth,
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
            return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
          });
          const ring = laidOut.find((p) => p.name === "ring");
          expect(ring).toBeDefined();
          expect(within(ring!.box, stage)).toBe(true);

          // The dock holds the controls and is the last thing in the flow; the rest of the screen is above it.
          const dock = await page.$eval(".pr-dock", (el) => {
            const r = el.getBoundingClientRect();
            return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
          });
          const flow = laidOut.filter(
            (p) => p.name !== "controls" && p.name !== "alert" && p.name !== "guidance",
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
              expect(apart(controls[i]!.box, controls[j]!.box)).toBe(true);
          expect(dock.bottom).toBeLessThanOrEqual(viewport.height + 0.5);
          await page.context().close();
        });

        test(`${id}: every control can be reached`, async () => {
          const page = await open(id, theme, viewport, ready);
          const dockHolds = id !== "moment-field";
          if (dockHolds) {
            // Done and Discard are in reach without scrolling, at any size, and nothing covers them.
            for (const label of ["Discard recording"]) {
              const hit = await page.evaluate((name) => {
                const el = document.querySelector(`[aria-label="${name}"]`);
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
                return inside && top && el.contains(top) ? "ok" : "covered";
              }, label);
              if (id === "mic-denied") expect(hit).toBe("missing");
              else expect(hit).toBe("ok");
            }
            if (id !== "mic-denied") {
              const done = await page.evaluate(() => {
                const el = [...document.querySelectorAll(".pr-b.main")][0];
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
                return inside && top && el.contains(top) ? "ok" : "covered";
              });
              expect(done).toBe("ok");
            }
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
              const main = document.querySelector<HTMLElement>(".pr-main")!;
              const dockEl = document.querySelector(".pr-dock")!;
              // Bring the control as far from the dock as the scroll allows, then see what is at its centre.
              const rect = el.getBoundingClientRect();
              const mainTop = main.getBoundingClientRect().top;
              main.scrollTop += rect.top - mainTop - 8;
              const after = el.getBoundingClientRect();
              const dockRect = dockEl.getBoundingClientRect();
              // In landscape the dock is a column of its own: it only limits what shares its columns.
              const dockTop =
                after.left < dockRect.right && after.right > dockRect.left
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
            if (result !== "absent") expect([selector, result]).toEqual([selector, "ok"]);
          }
          await page.context().close();
        });
      }
    });
  }
}

describe.serial(`the recorder on desktop and web (${engineName})`, () => {
  const DESKTOP = { width: 1280, height: 800 };

  async function openWide(screen: string, theme: "light" | "dark", platform: string) {
    const page = await (
      await browser.newContext({ viewport: DESKTOP, reducedMotion: "reduce" })
    ).newPage();
    await page.goto(
      `http://127.0.0.1:${server.port}/?screen=${screen}&theme=${theme}&platform=${platform}&freeze=1`,
    );
    await page.waitForSelector("[data-testid=desktop-recorder]");
    await page.waitForTimeout(400);
    return page;
  }

  for (const theme of ["light", "dark"] as const) {
    for (const [screen, platform, name] of [
      ["recorder-final-desktop-mic-revoked", "tauri", "desktop"],
      ["recorder-final-web-mic-revoked", "web", "web"],
    ] as const) {
      test(`${name}, ${theme}: losing the microphone mid-recording keeps Done and Discard`, async () => {
        const page = await openWide(screen, theme, platform);
        if (shotsDir)
          await page.screenshot({
            path: join(shotsDir, `${name}-mic-revoked-${theme}.png`),
          });
        const discard = page.getByRole("button", { name: "Discard recording" });
        const done = page.getByRole("button", { name: /Done/ });
        expect(await discard.count()).toBe(1);
        expect(await done.count()).toBe(1);
        expect(await discard.isEnabled()).toBe(true);
        expect(await done.isEnabled()).toBe(true);
        const box = async (selector: string): Promise<Box> =>
          page.$eval(selector, (el) => {
            const r = el.getBoundingClientRect();
            return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
          });
        const action = await box(
          platform === "web" ? "[data-testid=browser-mic-guidance]" : ".pr-controls .pr-b.primary",
        );
        const doneBox = await box(".pr-b.main");
        // The microphone's own action sits above the row, and the row is whole inside the window.
        expect(action.bottom).toBeLessThanOrEqual(doneBox.top + 0.5);
        expect(doneBox.bottom).toBeLessThanOrEqual(DESKTOP.height);
        await page.context().close();
      });
    }

    test(`${theme}: the keep-open toast shows once and keeps clear of the pill, the timer and the controls`, async () => {
      const page = await openWide("recorder-final-web-keep-open", theme, "web");
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
            return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
          }),
        );
        for (const other of boxes) expect([selector, apart(toast, other)]).toEqual([selector, true]);
      }
      await page.context().close();
    });
  }
});
