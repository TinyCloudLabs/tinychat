// The exo-ui screenshot harness (TC-761): every registered screen
// (frontend/src/harness/screens/*.tsx) at each viewport, by Day and at Night,
// with automated checks on every capture. Output:
// screenshots/exo-ui/<YYYYMMDD-HHMMSS>/<screen>__<viewport>__<theme>.png, plus
// a contact sheet (index.html) and report.json.
//
//   EXO_UI_ONLY=primitives,legacy    screen groups or ids
//   EXO_UI_VIEWPORTS=phone,zoom200   viewport ids, or a group (zoom200, text200)
//   EXO_UI_THEMES=dark               light, dark
//   EXO_UI_ENGINE=chromium           webkit (default: Exo's WKWebView) or chromium (CI)
//   EXO_UI_MOTION=no-preference      reduce (default) or no-preference
//
// Exceptions a legacy screen still needs are in exo-ui/legacy-allowlist.json.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  chromium,
  webkit,
  type Browser,
  type BrowserContext,
  type BrowserType,
  type ConsoleMessage,
} from "playwright";
import {
  buildHarness,
  serveHarness,
  type HarnessAssets,
} from "./exo-ui/harness-server";

interface Viewport {
  id: string;
  group?: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
  isMobile?: boolean;
  hasTouch?: boolean;
  /** Root font-size multiplier: rem text scaling. */
  textScale?: number;
  /** Zoom and text-scale captures also check for clipped text. */
  zoom?: boolean;
}

const VIEWPORTS: Viewport[] = [
  {
    id: "phone",
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
  {
    id: "phone-land",
    width: 844,
    height: 390,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
  {
    id: "tablet",
    width: 820,
    height: 1180,
    deviceScaleFactor: 2,
    hasTouch: true,
  },
  {
    id: "tablet-land",
    width: 1180,
    height: 820,
    deviceScaleFactor: 2,
    hasTouch: true,
  },
  { id: "desktop-min", width: 900, height: 600, deviceScaleFactor: 2 },
  { id: "desktop", width: 1280, height: 800, deviceScaleFactor: 2 },
  { id: "halo-review", width: 1280, height: 1200, deviceScaleFactor: 2 },
  // 1280x800 at 200% browser zoom.
  { id: "zoom200", width: 640, height: 400, deviceScaleFactor: 2, zoom: true },
  {
    id: "text200-phone",
    group: "text200",
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    textScale: 2,
    zoom: true,
  },
  {
    id: "text200-desktop",
    group: "text200",
    width: 1280,
    height: 800,
    deviceScaleFactor: 2,
    textScale: 2,
    zoom: true,
  },
];
const THEMES = ["light", "dark"] as const;

interface ScreenInfo {
  id: string;
  /** Driven by its own test; not captured. */
  interactive?: boolean;
  group: string;
  layout: "pane" | "document";
  displayTitle?: boolean;
  /** Where the screen runs (default web); the phone app gets the fake recorder. */
  platform?: string;
}

interface AllowEntry {
  screen: string;
  selector: string;
  check: string;
  reason: string;
  removeIn: string;
}

interface Finding {
  check: string;
  element?: string;
  detail: string;
}

const list = (value: string | undefined) =>
  value
    ?.split(",")
    .map((part) => part.trim())
    .filter(Boolean);
const only = list(process.env.EXO_UI_ONLY);
const viewportFilter = list(process.env.EXO_UI_VIEWPORTS);
const themes = THEMES.filter(
  (theme) =>
    !process.env.EXO_UI_THEMES ||
    list(process.env.EXO_UI_THEMES)!.includes(theme),
);
const viewports = VIEWPORTS.filter(
  (v) =>
    !viewportFilter ||
    viewportFilter.includes(v.id) ||
    (v.group !== undefined && viewportFilter.includes(v.group)),
);
const motion =
  process.env.EXO_UI_MOTION === "no-preference" ? "no-preference" : "reduce";

// One engine per process: launching two in one bun process intermittently
// wedges the second (see connectors-scroll.e2e.test.ts).
const engines: Record<string, BrowserType> = { webkit, chromium };
const engineName = process.env.EXO_UI_ENGINE ?? "webkit";
const engine = engines[engineName];
if (!engine)
  throw new Error(
    `EXO_UI_ENGINE must be one of ${Object.keys(engines).join(", ")}`,
  );

const allowlist: AllowEntry[] = JSON.parse(
  readFileSync(
    new URL("./exo-ui/legacy-allowlist.json", import.meta.url),
    "utf8",
  ),
);

const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, "")
  .replace("T", "-")
  .slice(0, 15);
const outDir = new URL(`../screenshots/exo-ui/${stamp}/`, import.meta.url)
  .pathname;

let assets: HarnessAssets;

beforeAll(async () => {
  assets = await buildHarness();
  mkdirSync(outDir, { recursive: true });
}, 120_000);

const startServer = () => serveHarness(assets);

/** Console errors that are not the screen's fault. */
function ignoredConsoleError(message: ConsoleMessage): boolean {
  const text = message.text();
  const url = message.location().url;
  // A fixture-less /api/ call answers 404; the screen shows its empty state.
  if (text.startsWith("Failed to load resource") && url.includes("/api/"))
    return true;
  // Another host: the page itself refuses those calls (exoUiHarness.tsx keeps it hermetic).
  if (
    text.startsWith("Failed to load resource") &&
    url !== "" &&
    !url.startsWith("http://127.0.0.1:")
  )
    return true;
  // WebKit does not know Chrome's interactive-widget viewport key (index.html) and reports it as an error.
  if (
    text.includes('Viewport argument key "interactive-widget" not recognized')
  )
    return true;
  return false;
}

// Runs in the page: the automated checks of plan §8.2 (TC-761).
function inspectPage(args: {
  layout: "pane" | "document";
  touch: boolean;
  zoom: boolean;
  displayTitle: boolean;
  allow: Array<{ selector: string; check: string }>;
}) {
  const findings: Array<{ check: string; element?: string; detail: string }> =
    [];
  const allowed = (el: Element, check: string) =>
    args.allow.some(
      (entry) => entry.check === check && el.matches(entry.selector),
    );
  const describe = (el: Element) => {
    const label = (el.getAttribute("aria-label") ?? el.textContent ?? "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 40);
    const testId = el.getAttribute("data-testid");
    return `${el.tagName.toLowerCase()}${testId ? `[data-testid=${testId}]` : ""}${label ? ` "${label}"` : ""}`;
  };
  const shown = (el: Element) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false; // display:none, sr-only
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && Number(style.opacity) > 0;
  };
  const doc = document.documentElement;

  // 1. The shell stays pinned: a pane screen never scrolls the document; no screen scrolls sideways.
  if (args.layout === "pane" && doc.scrollHeight !== window.innerHeight) {
    findings.push({
      check: "shell-pinned",
      detail: `document ${doc.scrollHeight}px tall in a ${window.innerHeight}px window`,
    });
  }
  if (doc.scrollWidth > window.innerWidth) {
    findings.push({
      check: "overflow-x",
      detail: `document ${doc.scrollWidth}px wide in a ${window.innerWidth}px window`,
    });
  }

  // 2. Touch targets: 44x44, or inside a label or [data-hit-area] at least that big.
  if (args.touch) {
    for (const el of document.querySelectorAll(
      "a, button, [role=radio], [role=tab], input, select, textarea",
    )) {
      if (!shown(el) || el.closest("[data-inline-link]")) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width >= 43.5 && rect.height >= 43.5) continue;
      const wrapper = el.parentElement?.closest("label, [data-hit-area]");
      const area = wrapper?.getBoundingClientRect();
      if (area && area.width >= 43.5 && area.height >= 43.5) continue;
      if (allowed(el, "touch-target")) continue;
      findings.push({
        check: "touch-target",
        element: describe(el),
        detail: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
      });
    }
  }

  // 3. Text: at least 11px; inputs at least 16px on touch (so iOS never zooms into them).
  for (const el of document.querySelectorAll("body *")) {
    const hasText = [...el.childNodes].some(
      (node) =>
        node.nodeType === Node.TEXT_NODE && node.textContent!.trim() !== "",
    );
    if (!hasText || !shown(el)) continue;
    const size = Number.parseFloat(getComputedStyle(el).fontSize);
    if (size < 11 && !allowed(el, "text-size"))
      findings.push({
        check: "text-size",
        element: describe(el),
        detail: `${size}px`,
      });
  }
  if (args.touch) {
    for (const el of document.querySelectorAll(
      "input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=range]), select, textarea",
    )) {
      if (!shown(el)) continue;
      const size = Number.parseFloat(getComputedStyle(el).fontSize);
      if (size < 16 && !allowed(el, "input-size"))
        findings.push({
          check: "input-size",
          element: describe(el),
          detail: `${size}px`,
        });
    }
  }

  // 5. The display face actually loaded (document.fonts.check() says yes even when the family is missing).
  if (
    args.displayTitle &&
    ![...document.fonts].some(
      (face) => /Literata/.test(face.family) && face.status === "loaded",
    )
  ) {
    findings.push({ check: "font-loaded", detail: "Literata never loaded" });
  }

  // 6. Screen invariants.
  const dialogs = document.querySelectorAll("[role=dialog]").length;
  if (dialogs > 1)
    findings.push({ check: "dialogs", detail: `${dialogs} dialogs` });

  // 7. Zoomed and scaled text: nothing cut off.
  if (args.zoom) {
    for (const el of document.querySelectorAll("body *")) {
      const hasText = [...el.childNodes].some(
        (node) =>
          node.nodeType === Node.TEXT_NODE && node.textContent!.trim() !== "",
      );
      if (!hasText || !shown(el)) continue;
      const style = getComputedStyle(el);
      if (
        !/hidden|clip/.test(style.overflowX) ||
        el.scrollWidth <= el.clientWidth + 1
      )
        continue;
      if (!allowed(el, "clipped-text"))
        findings.push({
          check: "clipped-text",
          element: describe(el),
          detail: `${el.scrollWidth}px of text in ${el.clientWidth}px`,
        });
    }
  }
  return findings;
}

interface Capture {
  screen: string;
  viewport: string;
  theme: string;
  file: string;
  findings: Finding[];
}
const captures: Capture[] = [];

describe.serial(`exo-ui screens (${engineName}, motion ${motion})`, () => {
  // Every browser stays open until the run ends. Under bun, closing one
  // browser and launching the next intermittently cuts the new browser's
  // DevTools pipe ("Connection terminated while reading from pipe"): the
  // browser exits and the run waits forever on its next reply.
  const browsers: Browser[] = [];
  let server: ReturnType<typeof Bun.serve>;
  let screens: ScreenInfo[] = [];

  beforeAll(async () => {
    server = startServer();
    const browser = await engine.launch({ headless: true });
    browsers.push(browser);
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.waitForFunction(() => window.exoUi !== undefined);
    screens = (await page.evaluate(() => window.exoUi!.screens)).filter(
      (screen) =>
        !screen.interactive &&
        (!only || only.includes(screen.group) || only.includes(screen.id)),
    );
    await page.close();
  }, 60_000);

  afterAll(async () => {
    // A dead Chromium DevTools pipe can leave close() pending after every
    // capture passed. Bound cleanup so it cannot hide the screen results.
    await Promise.all(
      browsers.map(async (browser) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            browser.close(),
            new Promise<void>((resolve) => {
              timer = setTimeout(() => {
                console.warn("exo-ui: browser close timed out");
                resolve();
              }, 10_000);
            }),
          ]);
        } catch (caught) {
          console.warn("exo-ui: browser close failed", caught);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }),
    );
    server?.stop(true);
    writeFileSync(
      `${outDir}report.json`,
      JSON.stringify({ engine: engineName, motion, captures }, null, 2),
    );
    writeFileSync(`${outDir}index.html`, contactSheet(captures));
    console.log(`exo-ui: ${captures.length} captures in ${outDir}`);
  }, 60_000);

  test("the registry has screens to capture", () => {
    expect(screens.length).toBeGreaterThan(0);
  });

  for (const viewport of viewports) {
    test(`every screen at ${viewport.id} (${viewport.width}x${viewport.height})`, async () => {
      const failures: string[] = [];
      // A fresh browser per viewport: WebKit stops loading pages after about
      // sixty in one browser, and a full run loads several hundred.
      const viewportBrowser = await engine.launch({ headless: true });
      browsers.push(viewportBrowser);
      for (const theme of themes) {
        const context: BrowserContext = await viewportBrowser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: viewport.deviceScaleFactor,
          isMobile: viewport.isMobile ?? false,
          hasTouch: viewport.hasTouch ?? false,
          colorScheme: theme,
          reducedMotion: motion,
        });
        if (viewport.textScale) {
          // Before the app's scripts run; <html> may not exist yet when init scripts start.
          await context.addInitScript((scale) => {
            const apply = () =>
              document.documentElement.style.setProperty(
                "font-size",
                `${scale * 100}%`,
              );
            if (document.documentElement) apply();
            else
              document.addEventListener("readystatechange", apply, {
                once: true,
              });
          }, viewport.textScale);
        }
        try {
          for (const screen of screens) {
            const page = await context.newPage();
            const errors: string[] = [];
            page.on("pageerror", (error) =>
              errors.push(`pageerror: ${error.message}`),
            );
            page.on("console", (message) => {
              if (message.type() === "error" && !ignoredConsoleError(message)) {
                const url = message.location().url;
                errors.push(
                  `console.error: ${message.text()}${url ? ` (${url})` : ""}`,
                );
              }
            });
            await page.goto(
              `http://127.0.0.1:${server.port}/?screen=${screen.id}&theme=${theme}&platform=${screen.platform ?? "web"}&freeze=1`,
            );
            await page.waitForFunction(
              () => window.exoUi?.ready === true,
              undefined,
              { timeout: 20_000 },
            );
            await page.waitForLoadState("networkidle");
            await page.waitForTimeout(300);

            const allow = allowlist
              .filter((entry) => entry.screen === screen.id)
              .map(({ selector, check }) => ({ selector, check }));
            const findings: Finding[] = await page.evaluate(inspectPage, {
              layout: screen.layout,
              touch: viewport.hasTouch ?? false,
              zoom: viewport.zoom ?? false,
              displayTitle: screen.displayTitle ?? false,
              allow,
            });
            // The native Capture home must finish recorder setup; generic layout checks missed a missing Record button.
            if (
              [
                "shell-capture",
                "capture-first-use",
                "capture-items",
                "capture-in-progress",
              ].includes(screen.id)
            ) {
              const record = page.locator('[data-testid="voice-note-record"]');
              if (
                (await record.count()) === 0 ||
                (await record.first().isDisabled())
              ) {
                findings.push({
                  check: "native-record-ready",
                  detail: "Capture has no enabled Record button",
                });
              }
            }
            for (const error of errors)
              findings.push({ check: "errors", detail: error });

            const file = `${screen.id}__${viewport.id}__${theme}.png`;
            await page.screenshot({
              path: `${outDir}${file}`,
              fullPage: screen.layout === "document",
            });
            captures.push({
              screen: screen.id,
              viewport: viewport.id,
              theme,
              file,
              findings,
            });

            if (
              screen.id === "recorder-final-halo" &&
              viewport.id === "phone"
            ) {
              for (const index of [4, 5, 6, 7]) {
                await page
                  .locator(".halo-ring__canvas")
                  .nth(index)
                  .scrollIntoViewIfNeeded();
                await page.waitForFunction(
                  (canvasIndex) => {
                    const canvas =
                      document.querySelectorAll<HTMLCanvasElement>(
                        ".halo-ring__canvas",
                      )[canvasIndex];
                    const context = canvas?.getContext("2d");
                    if (!canvas || !context) return false;
                    const pixels = context.getImageData(
                      0,
                      0,
                      canvas.width,
                      canvas.height,
                    ).data;
                    for (let y = 0; y < canvas.height; y += 16) {
                      for (let x = 0; x < canvas.width; x += 16) {
                        if (pixels[(y * canvas.width + x) * 4 + 3] > 0)
                          return true;
                      }
                    }
                    return false;
                  },
                  index,
                  { timeout: 3_000 },
                );
              }
            }

            if (
              screen.id === "recorder-final-halo" &&
              viewport.id === "halo-review"
            ) {
              await page.waitForFunction(
                () => {
                  const canvases =
                    document.querySelectorAll<HTMLCanvasElement>(
                      ".halo-ring__canvas",
                    );
                  if (canvases.length !== 8) return false;
                  return [...canvases].every((canvas) => {
                    const context = canvas.getContext("2d");
                    if (!context) return false;
                    const pixels = context.getImageData(
                      0,
                      0,
                      canvas.width,
                      canvas.height,
                    ).data;
                    for (let y = 0; y < canvas.height; y += 16) {
                      for (let x = 0; x < canvas.width; x += 16) {
                        if (pixels[(y * canvas.width + x) * 4 + 3] > 0)
                          return true;
                      }
                    }
                    return false;
                  });
                },
                undefined,
                { timeout: 3_000 },
              );
            }

            for (const finding of findings) {
              failures.push(
                `${file}: ${finding.check}${finding.element ? ` ${finding.element}` : ""} (${finding.detail})`,
              );
            }
            await page.close();
          }
        } finally {
          await context.close();
        }
      }
      expect(failures).toEqual([]);
      // WebKit takes several seconds per page for the shell screens (they run the whole chat).
    }, 600_000);
  }
});

function contactSheet(all: Capture[]): string {
  const rows = all
    .map((capture) => {
      const problems = capture.findings
        .map(
          (f) =>
            `<li>${escapeHtml(`${f.check}${f.element ? ` ${f.element}` : ""}: ${f.detail}`)}</li>`,
        )
        .join("");
      return `<figure class="${capture.findings.length ? "bad" : ""}"><a href="${capture.file}"><img loading="lazy" src="${capture.file}" alt=""></a><figcaption>${escapeHtml(`${capture.screen} · ${capture.viewport} · ${capture.theme}`)}${problems ? `<ul>${problems}</ul>` : ""}</figcaption></figure>`;
    })
    .join("\n");
  return `<!doctype html><meta charset="utf-8"><title>exo-ui ${stamp}</title>
<style>body{font:14px system-ui;margin:24px;background:#f6f7f9;color:#191e33}main{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px}figure{margin:0;background:#fff;border:1px solid #dcdee5;border-radius:8px;padding:8px}figure.bad{border-color:#c1253a}img{width:100%;height:320px;object-fit:contain;object-position:top;background:#eaecf0}figcaption{margin-top:6px}ul{color:#c1253a;padding-left:16px;margin:4px 0 0}</style>
<h1>exo-ui · ${escapeHtml(engineName)} · ${all.length} captures</h1><main>${rows}</main>`;
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );
}

declare global {
  interface Window {
    exoUi?: { screens: ScreenInfo[]; ready: boolean };
  }
}
