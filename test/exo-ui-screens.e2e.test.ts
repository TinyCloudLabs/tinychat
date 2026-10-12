// The exo-ui screenshot harness (TC-761): every registered screen
// (frontend/src/harness/screens/*.tsx) at each viewport, by Day and at Night,
// with automated checks on every capture. Output:
// screenshots/exo-ui/<YYYYMMDD-HHMMSS>/<screen>__<viewport>__<theme>.png, plus
// a contact sheet (index.html) and report.json.
//
//   EXO_UI_ONLY=primitives,legacy    screen groups or ids
//   EXO_UI_VIEWPORTS=phone,zoom200   viewport ids, or a group (zoom200, text200)
//   EXO_UI_VIEWPORTS=phone,halo-review  also enables the halo-only review captures
//   EXO_UI_THEMES=dark               light, dark
//   EXO_UI_ENGINE=chromium           webkit (default: Exo's WKWebView) or chromium (CI)
//   EXO_UI_MOTION=no-preference      reduce (default) or no-preference
//
// Exceptions a legacy screen still needs are in exo-ui/legacy-allowlist.json.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chromium, webkit, type Browser, type BrowserContext, type BrowserType, type ConsoleMessage } from "playwright";
import { buildHarness, serveHarness, type HarnessAssets } from "./exo-ui/harness-server";
import { inspectHaloPixels, readHaloCenterPixel, readHaloThemeColor } from "./exo-ui/halo-pixels";

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
  /** Only the screens whose id starts with one of these run at this viewport (default: every screen). */
  screenPrefixes?: string[];
}

const VIEWPORTS: Viewport[] = [
  { id: "phone", width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  { id: "phone-land", width: 844, height: 390, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  { id: "tablet", width: 820, height: 1180, deviceScaleFactor: 2, hasTouch: true },
  { id: "tablet-land", width: 1180, height: 820, deviceScaleFactor: 2, hasTouch: true },
  { id: "desktop-min", width: 900, height: 600, deviceScaleFactor: 2 },
  { id: "desktop", width: 1280, height: 800, deviceScaleFactor: 2 },
  // 1280x800 at 200% browser zoom.
  { id: "zoom200", width: 640, height: 400, deviceScaleFactor: 2, zoom: true },
  // The smallest phone the recorder-final screens must fit (an Android emulator's 320x640), scoped to those screens.
  {
    id: "phone-small",
    width: 320,
    height: 640,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    screenPrefixes: [
      "shell-chat",
      "recorder-final-phone-",
      "recorder-final-minimized-",
      "capture-soft-",
      "capture-notetaker-route",
    ],
  },
  {
    id: "phone-360",
    width: 360,
    height: 740,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    screenPrefixes: ["capture-soft-", "capture-notetaker-route"],
  },
  { id: "text200-phone", group: "text200", width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true, textScale: 2, zoom: true },
  {
    id: "text200-phone-small",
    group: "text200",
    width: 320,
    height: 640,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    textScale: 2,
    zoom: true,
    screenPrefixes: ["recorder-landed", "capture-soft-", "capture-notetaker-route"],
  },
  {
    id: "text200-phone-360",
    group: "text200",
    width: 360,
    height: 740,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    textScale: 2,
    zoom: true,
    screenPrefixes: ["capture-soft-", "capture-notetaker-route"],
  },
  {
    id: "text200-rail",
    group: "text200",
    width: 844,
    height: 600,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    textScale: 2,
    zoom: true,
    screenPrefixes: ["shell-"],
  },
  { id: "text200-desktop", group: "text200", width: 1280, height: 800, deviceScaleFactor: 2, textScale: 2, zoom: true },
  ...[0.8, 2.5, 3.3].map((scale) => ({
    id: `text${Math.round(scale * 100)}-phone`,
    group: `text${Math.round(scale * 100)}`,
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    textScale: scale,
    zoom: true,
    screenPrefixes: ["shell-", "recorder-final-phone-", "recorder-final-minimized-", "capture-soft-", "capture-notetaker-route"],
  })),
];
const THEMES = ["light", "dark"] as const;

interface ScreenInfo {
  id: string;
  group: string;
  layout: "pane" | "document";
  displayTitle?: boolean;
  /** Where the screen runs (default web); the phone app gets the fake recorder. */
  platform?: string;
  /** Driven by its own test; not captured. */
  interactive?: boolean;
  /** Not captured at viewports narrower than this. */
  minViewportWidth?: number;
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

const list = (value: string | undefined) => value?.split(",").map((part) => part.trim()).filter(Boolean);
const only = list(process.env.EXO_UI_ONLY);
const viewportFilter = list(process.env.EXO_UI_VIEWPORTS);
const themes = THEMES.filter((theme) => !process.env.EXO_UI_THEMES || list(process.env.EXO_UI_THEMES)!.includes(theme));
const viewports = VIEWPORTS.filter((v) => !viewportFilter || viewportFilter.includes(v.id) || (v.group !== undefined && viewportFilter.includes(v.group)));
const motion = process.env.EXO_UI_MOTION === "no-preference" ? "no-preference" : "reduce";

// One engine per process: launching two in one bun process intermittently
// wedges the second (see connectors-scroll.e2e.test.ts).
const engines: Record<string, BrowserType> = { webkit, chromium };
const engineName = process.env.EXO_UI_ENGINE ?? "webkit";
const engine = engines[engineName];
if (!engine) throw new Error(`EXO_UI_ENGINE must be one of ${Object.keys(engines).join(", ")}`);

const allowlist: AllowEntry[] = JSON.parse(readFileSync(new URL("./exo-ui/legacy-allowlist.json", import.meta.url), "utf8"));

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const outDir = new URL(`../screenshots/exo-ui/${stamp}/`, import.meta.url).pathname;

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
  if (text.startsWith("Failed to load resource") && url.includes("/api/")) return true;
  // Another host: the page itself refuses those calls (exoUiHarness.tsx keeps it hermetic).
  if (text.startsWith("Failed to load resource") && url !== "" && !url.startsWith("http://127.0.0.1:")) return true;
  // WebKit does not know Chrome's interactive-widget viewport key (index.html) and reports it as an error.
  if (text.includes('Viewport argument key "interactive-widget" not recognized')) return true;
  // The saved-note-page-save-failed screen refuses the save on purpose, and the app logs every failed save.
  if (text.startsWith("[SavedNote] Could not save the note")) return true;
  return false;
}

// Runs in the page: the automated checks of plan §8.2 (TC-761).
function inspectPage(args: { layout: "pane" | "document"; touch: boolean; zoom: boolean; displayTitle: boolean; largeText: boolean; normalCaptureRow: boolean; routeMode: "stacked" | "horizontal" | null; allow: Array<{ selector: string; check: string }> }) {
  const findings: Array<{ check: string; element?: string; detail: string }> = [];
  const allowed = (el: Element, check: string) => args.allow.some((entry) => entry.check === check && el.matches(entry.selector));
  const describe = (el: Element) => {
    const label = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
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
    findings.push({ check: "shell-pinned", detail: `document ${doc.scrollHeight}px tall in a ${window.innerHeight}px window` });
  }
  if (doc.scrollWidth > window.innerWidth) {
    findings.push({ check: "overflow-x", detail: `document ${doc.scrollWidth}px wide in a ${window.innerWidth}px window` });
  }

  // 2. Touch targets: 44x44, or inside a label or [data-hit-area] at least that big.
  if (args.touch) {
    for (const el of document.querySelectorAll("a, button, [role=radio], [role=tab], input, select, textarea")) {
      if (!shown(el) || el.closest("[data-inline-link]")) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width >= 43.5 && rect.height >= 43.5) continue;
      const wrapper = el.parentElement?.closest("label, [data-hit-area]");
      const area = wrapper?.getBoundingClientRect();
      if (area && area.width >= 43.5 && area.height >= 43.5) continue;
      if (allowed(el, "touch-target")) continue;
      findings.push({ check: "touch-target", element: describe(el), detail: `${Math.round(rect.width)}x${Math.round(rect.height)}` });
    }
  }

  // 3. Text: at least 11px; inputs at least 16px on touch (so iOS never zooms into them).
  for (const el of document.querySelectorAll("body *")) {
    const hasText = [...el.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim() !== "");
    if (!hasText || !shown(el)) continue;
    const size = Number.parseFloat(getComputedStyle(el).fontSize);
    if (size < 11 && !allowed(el, "text-size")) findings.push({ check: "text-size", element: describe(el), detail: `${size}px` });
  }
  if (args.touch) {
    for (const el of document.querySelectorAll("input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=range]), select, textarea")) {
      if (!shown(el)) continue;
      const size = Number.parseFloat(getComputedStyle(el).fontSize);
      if (size < 16 && !allowed(el, "input-size")) findings.push({ check: "input-size", element: describe(el), detail: `${size}px` });
    }
  }

  // 5. The display face actually loaded (document.fonts.check() says yes even when the family is missing).
  if (args.displayTitle && ![...document.fonts].some((face) => /Literata/.test(face.family) && face.status === "loaded")) {
    findings.push({ check: "font-loaded", detail: "Literata never loaded" });
  }

  // 6. Screen invariants.
  const dialogs = document.querySelectorAll("[role=dialog]").length;
  if (dialogs > 1) findings.push({ check: "dialogs", detail: `${dialogs} dialogs` });

  const receiptStatus = document.querySelector<HTMLElement>('[data-testid="voice-note-status"]');
  const receiptStatusLabel = receiptStatus?.querySelector<HTMLElement>('[data-testid="voice-note-status-label"]');
  if (receiptStatus && receiptStatusLabel && shown(receiptStatus)) {
    const pillBounds = receiptStatus.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(receiptStatusLabel);
    const textEscapesPill = [...range.getClientRects()].some((rect) =>
      rect.left < pillBounds.left - 1 || rect.right > pillBounds.right + 1 ||
      rect.top < pillBounds.top - 1 || rect.bottom > pillBounds.bottom + 1
    );
    if (receiptStatus.scrollWidth > receiptStatus.clientWidth + 1 || textEscapesPill) {
      findings.push({ check: "receipt-status-content", element: describe(receiptStatus), detail: "status text overflows the pill bounds" });
    }
  }

  // 7. Zoomed and scaled text: nothing cut off.
  if (args.zoom) {
    for (const el of document.querySelectorAll("body *")) {
      const hasText = [...el.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim() !== "");
      if (!hasText || !shown(el)) continue;
      const style = getComputedStyle(el);
      if (!/hidden|clip/.test(style.overflowX) || el.scrollWidth <= el.clientWidth + 1) continue;
      if (!allowed(el, "clipped-text")) findings.push({ check: "clipped-text", element: describe(el), detail: `${el.scrollWidth}px of text in ${el.clientWidth}px` });
    }
  }

  // Large-text phone captures exercise the six audited layouts plus the
  // Android action row, tab bar, and Ribbon. Keep each target inside the
  // viewport, check sibling line boxes for collisions, and reject line-by-letter
  // wrapping that technically stays inside the component.
  if (args.largeText) {
    const targets = [
      "[data-route-line]",
      '[data-testid="voice-note-receipt"]',
      '[data-testid="voice-note-status"]',
      '[data-testid="recorder-island"]',
      '[data-testid="chat-header"]',
      '[data-testid="connector-row"]',
      'button[role="switch"][aria-label="Enable Conversation Canvas"]',
      '[data-testid="capture-actions"]',
      '[data-testid="capture-upload"]',
      '[data-testid="voice-note-record"]',
      '[data-testid="capture-meeting"]',
      '[data-testid="tab-bar"]',
      '[data-testid="ribbon"]',
      '[data-testid="voice-note-recorder"] main',
      '[data-recorder-timer]',
      '[data-testid="canvas-setting-row"]',
      '[data-testid="autojoin-control-row"]',
    ];
    for (const selector of targets) {
      for (const el of document.querySelectorAll(selector)) {
        const bounds = el.getBoundingClientRect();
        const routeContainer = selector === "[data-route-line]" ? el.parentElement : null;
        const routeInfo = routeContainer ? `; wrapper ${Math.round(routeContainer.getBoundingClientRect().width)}px/${getComputedStyle(routeContainer).fontSize}/${getComputedStyle(routeContainer).containerType}/${getComputedStyle(routeContainer).containerName}; tracks ${getComputedStyle(el).gridTemplateColumns}` : "";
        const name = `${selector} (${Math.round(bounds.width)}x${Math.round(bounds.height)} at ${Math.round(bounds.left)},${Math.round(bounds.top)}${routeInfo})`;
        if (bounds.left < -1 || bounds.right > window.innerWidth + 1) {
          findings.push({ check: "text200-bounds", element: name, detail: "component extends beyond the phone width" });
        }
        const textRects: Array<{ parent: Element; rect: DOMRect; text: string }> = [];
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.textContent?.trim()) continue;
          if (node.parentElement?.closest(".sr-only,[aria-hidden=true]")) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
          const text = node.textContent!.trim();
          for (const rect of rects) {
            if (rect.left < bounds.left - 1 || rect.right > bounds.right + 1) {
              findings.push({ check: "text200-text-bounds", element: name, detail: `${text.slice(0, 48)} at ${Math.round(rect.left)},${Math.round(rect.top)} exceeds component width` });
              break;
            }
            textRects.push({ parent: node.parentElement!, rect, text });
          }
          const wordCount = text.split(/\s+/).filter(Boolean).length;
          const maxReasonableLines = wordCount * 2;
          const letterByLetterWord = [...text.matchAll(/\S{6,}/g)].some((match) => {
            const range = document.createRange();
            range.setStart(node, match.index!);
            range.setEnd(node, match.index! + match[0].length);
            const wordRects = [...range.getClientRects()];
            const lines = new Map<number, { width: number; height: number }>();
            for (const rect of wordRects) {
              const top = Math.round(rect.top);
              const line = lines.get(top) ?? { width: 0, height: 0 };
              line.width += rect.width;
              line.height = Math.max(line.height, rect.height);
              lines.set(top, line);
            }
            return [...lines.values()].some((line) => line.width < line.height * 0.75);
          });
          if (rects.length > maxReasonableLines || letterByLetterWord || getComputedStyle(node.parentElement!).wordBreak === "break-all") {
            findings.push({ check: "text200-letter-wrap", element: name, detail: `"${text.slice(0, 48)}" occupies ${rects.length} lines for ${wordCount} word(s)` });
          }
        }
        for (let i = 0; i < textRects.length; i++) {
          const a = textRects[i]!;
          for (const b of textRects.slice(i + 1)) {
            if (a.parent === b.parent || a.parent.contains(b.parent) || b.parent.contains(a.parent)) continue;
            const intersects = a.rect.left < b.rect.right - 1 && a.rect.right > b.rect.left + 1 && a.rect.top < b.rect.bottom - 1 && a.rect.bottom > b.rect.top + 1;
            if (intersects) findings.push({ check: "text200-sibling-overlap", element: name, detail: `"${a.text.slice(0, 30)}" overlaps "${b.text.slice(0, 30)}"` });
          }
        }
      }
    }
    const timer = document.querySelector('[data-recorder-timer]')?.getBoundingClientRect();
    const receipt = document.querySelector('[data-testid="voice-note-receipt"]')?.getBoundingClientRect();
    if (timer && receipt && receipt.top < timer.bottom - 1) {
      findings.push({ check: "text200-receipt-timer", detail: `receipt top ${Math.round(receipt.top)} is above timer bottom ${Math.round(timer.bottom)}` });
    }
    const chatTitle = document.querySelector<HTMLElement>('[data-testid="chat-header"] h1');
    if (chatTitle) {
      const previous = chatTitle.textContent;
      chatTitle.textContent = "https://example.com/a/very/long/unbroken/chat-title-that-must-wrap-at-large-text-size";
      const titleBounds = chatTitle.getBoundingClientRect();
      if (chatTitle.scrollWidth > chatTitle.clientWidth + 1 || titleBounds.right > window.innerWidth + 1) {
        findings.push({ check: "text200-chat-url", element: describe(chatTitle), detail: "long URL title overflows its available width" });
      }
      chatTitle.textContent = previous;
    }
    const ribbonElement = document.querySelector<HTMLElement>('[data-testid="ribbon"][data-layout="rail"]');
    if (ribbonElement) {
      const ribbon = ribbonElement.getBoundingClientRect();
      for (const scroller of document.querySelectorAll<HTMLElement>("[data-scroll-root], .dch-scroll")) {
        const initialTop = scroller.scrollTop;
        scroller.scrollTo({ top: scroller.scrollHeight, behavior: "instant" });
        const walker = document.createTreeWalker(scroller, NodeFilter.SHOW_TEXT);
        const textRects: DOMRect[] = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.textContent?.trim() || node.parentElement?.closest(".sr-only,[aria-hidden=true]")) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const rect of range.getClientRects()) {
            if (rect.width > 0 && rect.height > 0) textRects.push(rect);
          }
        }
        const clip = scroller.getBoundingClientRect();
        const overlapTop = Math.max(clip.top, ribbon.top);
        const overlapBottom = Math.min(clip.bottom, ribbon.bottom);
        if (overlapBottom > overlapTop && textRects.some((rect) =>
          rect.bottom > overlapTop + 1 && rect.top < overlapBottom - 1 &&
          rect.right > Math.max(clip.left, ribbon.left) + 1 && rect.left < Math.min(clip.right, ribbon.right) - 1
        )) {
          findings.push({ check: "ribbon-occlusion", element: describe(scroller), detail: `visible text intersects Ribbon between y=${Math.round(overlapTop)} and y=${Math.round(overlapBottom)} at scroll end` });
        }
        scroller.scrollTo({ top: initialTop, behavior: "instant" });
      }
    }
  }

  if (args.routeMode) {
    const container = document.querySelector<HTMLElement>("[data-route-line-container]");
    const route = container?.querySelector<HTMLElement>("[data-route-line]");
    if (container && route) {
      const tracks = getComputedStyle(route).gridTemplateColumns.trim().split(/\s+/);
      const stacked = tracks.length === 2;
      if (stacked !== (args.routeMode === "stacked")) {
        findings.push({ check: "route-line-layout", detail: `expected ${args.routeMode}, got ${tracks.length} grid tracks (container ${Math.round(container.getBoundingClientRect().width)}px, font ${getComputedStyle(container).fontSize}, type ${getComputedStyle(container).containerType})` });
      }
      if (args.routeMode === "stacked") {
        const indicators = [...container.querySelectorAll<HTMLElement>("[data-route-node-indicator]")];
        const maxIndicator = Math.max(0, ...indicators.map((indicator) => indicator.getBoundingClientRect().width));
        const twoRem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) * 2;
        const connectorHeights = [...container.querySelectorAll<HTMLElement>("[data-route-node-indicator] > [data-route-connector]")]
          .map((connector) => connector.getBoundingClientRect().height);
        if (maxIndicator > twoRem + 1 || connectorHeights.some((height) => height <= 0)) {
          findings.push({ check: "route-line-stack-geometry", detail: "indicator column max " + Math.round(maxIndicator) + "px (limit " + Math.round(twoRem) + "px), connector heights " + connectorHeights.map(Math.round).join(",") });
        }
      }
    }
  }

  if (args.normalCaptureRow) {
    const actions = document.querySelector('[data-testid="capture-actions"]');
    const upload = actions?.querySelector('[data-testid="capture-upload"]')?.getBoundingClientRect();
    const recorder = actions?.querySelector('[data-testid="voice-note-record"]')?.getBoundingClientRect();
    const meeting = actions?.querySelector('[data-testid="capture-meeting"]')?.getBoundingClientRect();
    if (upload && recorder && meeting) {
      const uploadRatio = recorder.width / upload.width;
      const meetingRatio = recorder.width / meeting.width;
      const sameRow = Math.abs(upload.top - recorder.top) < 1 && Math.abs(meeting.top - recorder.top) < 1;
      if (!sameRow || Math.abs(uploadRatio - 1.3) > 0.04 || Math.abs(meetingRatio - 1.3) > 0.04) {
        findings.push({ check: "capture-normal-emphasis", detail: `same row: ${sameRow}; Recorder width ratios are ${uploadRatio.toFixed(2)}× Upload and ${meetingRatio.toFixed(2)}× Meeting; expected one row and 1.30×` });
      }
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
      (screen) => !screen.interactive && (!only || only.includes(screen.group) || only.includes(screen.id)),
    );
    await page.close();
  }, 60_000);

  afterAll(async () => {
    // A dead Chromium DevTools pipe can leave close() pending after every
    // capture passed. Bound cleanup so it cannot hide the screen results.
    await Promise.all(browsers.map(async (browser) => {
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
    }));
    server?.stop(true);
    writeFileSync(`${outDir}report.json`, JSON.stringify({ engine: engineName, motion, captures }, null, 2));
    writeFileSync(`${outDir}index.html`, contactSheet(captures));
    console.log(`exo-ui: ${captures.length} captures in ${outDir}`);
  }, 60_000);

  test("the registry has screens to capture", () => {
    expect(screens.length).toBeGreaterThan(0);
  });

  for (const viewport of viewports) {
    test(`every screen at ${viewport.id} (${viewport.width}x${viewport.height})`, async () => {
      const failures: string[] = [];
      for (const theme of themes) {
        // WebKit stops loading after about 65 pages per browser. Recycle every
        // 40 screens within each theme to stay below that limit.
        for (let start = 0; start < screens.length; start += 40) {
          const viewportBrowser = await engine.launch({ headless: true });
          browsers.push(viewportBrowser);
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
              const apply = () => {
                const root = document.documentElement;
                if (new URLSearchParams(location.search).get("platform") === "ios") {
                  root.style.removeProperty("font-size");
                  root.style.setProperty("--ios-body-scale", String(scale));
                } else {
                  root.style.setProperty("font-size", `${scale * 100}%`);
                }
              };
              if (document.documentElement) apply();
              else document.addEventListener("readystatechange", apply, { once: true });
            }, viewport.textScale);
          }
          try {
            for (const screen of screens.slice(start, start + 40)) {
              if (
                viewport.screenPrefixes &&
                !viewport.screenPrefixes.some((prefix) => screen.id.startsWith(prefix))
              ) continue;
              if (viewport.textScale !== undefined && viewport.textScale !== 2 && screen.platform !== "ios") continue;
              if (screen.viewports && !screen.viewports.includes(viewport.id)) continue;
              if (screen.minViewportWidth !== undefined && viewport.width < screen.minViewportWidth) continue;
              const page = await context.newPage();
              const errors: string[] = [];
              const expectedRecorderStopError = [
                "capture-recording-minimised-error",
                "capture-stopped-minimised-error",
              ].includes(screen.id);
              let expectedRecorderStopErrors = 0;
              page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
              page.on("console", (message) => {
                if (message.type() === "error") {
                  const text = message.text();
                  if (
                    expectedRecorderStopError &&
                    text.startsWith("[Recorder]") &&
                    text.includes("The recorder could not stop")
                  ) {
                    expectedRecorderStopErrors += 1;
                  } else if (!ignoredConsoleError(message)) {
                    const url = message.location().url;
                    errors.push(`console.error: ${text}${url ? ` (${url})` : ""}`);
                  }
                }
              });
              await page.goto(`http://127.0.0.1:${server.port}/?screen=${screen.id}&theme=${theme}&platform=${screen.platform ?? "web"}&freeze=1`);
              await page.waitForFunction(() => window.exoUi?.ready === true, undefined, { timeout: 20_000 }).catch((error: unknown) => {
                throw new Error(`${screen.id} at ${viewport.id}/${theme} never became ready: ${errors.join("; ") || "no page errors"}`, { cause: error });
              });
              await page.waitForLoadState("networkidle");
              await page.waitForTimeout(300);

              const allow = allowlist.filter((entry) => entry.screen === screen.id).map(({ selector, check }) => ({ selector, check }));
              const findings: Finding[] = await page.evaluate(inspectPage, {
                layout: screen.layout,
                touch: viewport.hasTouch ?? false,
                zoom: viewport.zoom ?? false,
                displayTitle: screen.displayTitle ?? false,
                largeText: (viewport.textScale ?? 1) >= 2,
                normalCaptureRow: ["phone", "phone-small", "phone-360"].includes(viewport.id),
                routeMode: screen.id === "capture-notetaker-route" ? (viewport.textScale && viewport.width <= 400 ? "stacked" : "horizontal") : null,
                allow,
              });
              // The native Capture home must finish recorder setup; generic layout checks missed a missing Record button.
              if (["shell-capture", "capture-first-use", "capture-items", "capture-in-progress"].includes(screen.id)) {
                const record = page.locator('[data-testid="voice-note-record"]');
                if (await record.count() === 0 || await record.first().isDisabled()) {
                  findings.push({ check: "native-record-ready", detail: "Capture has no enabled Record button" });
                }
              }
              if (["shell-chat-ribbon", "shell-chat-ribbon-from-capture", "shell-chat-ribbon-minimized-from-chat", "shell-chat-new-ribbon"].includes(screen.id)) {
                const emptyState = await page.evaluate(() => {
                  const viewport = document.querySelector<HTMLElement>("[data-scroll-root]");
                  const title = viewport?.querySelector("h2");
                  const viewportTop = viewport?.getBoundingClientRect().top ?? 0;
                  const titleTop = title?.getBoundingClientRect().top ?? -1;
                  const copy = document.querySelector<HTMLElement>("[data-agent-enable-copy]");
                  const action = document.querySelector<HTMLElement>("[data-agent-enable-action]");
                  return {
                    scrollTop: viewport?.scrollTop ?? -1,
                    viewportTop,
                    titleTop,
                    compactBannerApplies: window.matchMedia("(max-width: 639px)").matches &&
                      document.documentElement.matches('html[data-nav="tabbar"][data-island]'),
                    copyVisible: Boolean(copy?.getClientRects().length),
                    actionHeight: action?.getBoundingClientRect().height ?? 0,
                  };
                });
                if (emptyState.scrollTop !== 0 || emptyState.titleTop < emptyState.viewportTop) {
                  findings.push({ check: "chat-empty-start", detail: `scrollTop ${emptyState.scrollTop}; title top ${emptyState.titleTop}; viewport top ${emptyState.viewportTop}` });
                }
                if (emptyState.compactBannerApplies && (emptyState.copyVisible || emptyState.actionHeight < 43.5)) {
                  findings.push({ check: "chat-ribbon-action", detail: `copy visible ${emptyState.copyVisible}; action height ${emptyState.actionHeight}px` });
                }
                if (await page.locator('button[aria-label="Scroll to bottom"]').count() > 0) {
                  findings.push({ check: "chat-empty-start", detail: "empty Chat showed the scroll-to-bottom overlay" });
                }
              }
              if (screen.platform === "ios" && viewport.textScale) {
                const rootSize = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).fontSize));
                const expected = Math.max(16, Math.min(32, 16 * viewport.textScale));
                if (Math.abs(rootSize - expected) > 0.1) findings.push({ check: "ios-text-scale", detail: `root font-size ${rootSize}px; expected ${expected}px at scale ${viewport.textScale}` });
              }
              if (screen.group === "pipeline") {
                // Pipeline labels and statuses fit their boxes and stack when text scaling leaves too little room.
                const sizing = await page.evaluate(() => {
                  const root = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
                  const texts = [...document.querySelectorAll<HTMLElement>(
                    ".pipeline-stepper-label, .pipeline-stepper-status, .pipeline-track-summary > span, .pipeline-stepper-notice, .pipeline-stepper-cause, .pipeline-stepper .soft-pill",
                  )];
                  const textRects = (el: HTMLElement) => {
                    const range = document.createRange();
                    range.selectNodeContents(el);
                    return [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
                  };
                  const outside = (rect: DOMRect, bounds: DOMRect) =>
                    rect.left < bounds.left - 1 || rect.right > bounds.right + 1 || rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1;
                  // The pill's ::after hit area inflates its scrollWidth, so its text is measured with a Range against the
                  // button itself and the case that holds it, not with scrollWidth.
                  const overflowing = texts.map((el) => {
                    if (el.matches(".soft-pill")) {
                      const button = el.getBoundingClientRect();
                      const box = el.closest<HTMLElement>("[data-pipeline-case]")!.getBoundingClientRect();
                      return textRects(el).some((rect) => outside(rect, button) || outside(rect, box)) ? el.className : null;
                    }
                    return el.scrollWidth > el.clientWidth + 1 ? el.className : null;
                  }).filter((name) => name !== null);
                  const layouts = [...document.querySelectorAll<HTMLElement>(".pipeline-stepper-list > li")].map((li) => {
                    const label = li.querySelector<HTMLElement>(".pipeline-stepper-label")?.getBoundingClientRect();
                    const status = li.querySelector<HTMLElement>(".pipeline-stepper-status")?.getBoundingClientRect();
                    return { label, status };
                  });
                  return {
                    root,
                    texts: texts.length,
                    wrong: texts.filter((el) => {
                      const size = Number.parseFloat(getComputedStyle(el).fontSize);
                      if (el.matches(".pipeline-stepper-label, .pipeline-stepper-status")) {
                        return Math.abs(size - root * 0.78125) > 0.01;
                      }
                      return el.matches(".pipeline-track-summary > span") ? size > 12.01 : size > root * 0.78125 + 0.01;
                    })
                      .map((el) => `${el.className} ${getComputedStyle(el).fontSize}`),
                    overflowing,
                    layouts,
                  };
                });
                const expectedRoot = 16 * (viewport.textScale ?? 1);
                if (Math.abs(sizing.root - expectedRoot) > 0.1) findings.push({ check: "pipeline-text-scale", detail: `root font-size ${sizing.root}px; expected ${expectedRoot}px` });
                if (sizing.texts === 0) findings.push({ check: "pipeline-text-scale", detail: "no stepper text found" });
                if (sizing.wrong.length > 0) findings.push({ check: "pipeline-text-scale", detail: `not 0.78125rem: ${sizing.wrong.join("; ")}` });
                if (sizing.overflowing.length > 0) findings.push({ check: "pipeline-text-wrap", detail: `text outside its box: ${sizing.overflowing.join("; ")}` });
                for (const layout of sizing.layouts) {
                  const stacked = (viewport.textScale ?? 1) > 1;
                  if (!layout.label || !layout.status || (stacked
                    ? layout.status.top < layout.label.bottom - 1
                    : layout.status.left < layout.label.left - 1 || layout.status.top > layout.label.bottom + 1)) {
                    findings.push({ check: "pipeline-wrap", detail: stacked
                      ? "a pipeline status did not sit below its label at large text size"
                      : "a pipeline row did not keep its label and status on the same line" });
                  }
                }
              }
              if (screen.id === "shell-chat" && ["phone", "phone-small"].includes(viewport.id)) {
                const bannerLayout = await page.evaluate(() => {
                  const banner = document.querySelector('[aria-label="Agent tools"]');
                  const markdown = document.querySelector('[data-testid="chat-markdown-demo"]');
                  const helper = document.querySelector<HTMLElement>("[data-agent-enable-helper]");
                  if (!banner || !markdown || !helper) return { missing: !banner ? "agent banner" : !markdown ? "Markdown demo" : "agent helper" };
                  const bannerRect = banner.getBoundingClientRect();
                  const markdownRect = markdown.getBoundingClientRect();
                  return {
                    bottomGap: window.innerHeight - bannerRect.bottom,
                    bannerTop: bannerRect.top,
                    bannerBottom: bannerRect.bottom,
                    markdownBottom: markdownRect.bottom,
                    clearance: Math.max(markdownRect.top - bannerRect.bottom, bannerRect.top - markdownRect.bottom),
                    helperVisible: Boolean(helper.getClientRects().length),
                    overlapsMarkdown: bannerRect.left < markdownRect.right &&
                      bannerRect.right > markdownRect.left &&
                      bannerRect.top < markdownRect.bottom &&
                      bannerRect.bottom > markdownRect.top,
                  };
                });
                if ("missing" in bannerLayout) {
                  findings.push({ check: "chat-banner-layout", detail: `missing ${bannerLayout.missing}` });
                } else {
                  if (bannerLayout.bottomGap < 150 || bannerLayout.bottomGap > 220) {
                    findings.push({ check: "chat-banner-offset", detail: `${Math.round(bannerLayout.bottomGap)}px from viewport bottom` });
                  }
                  if (bannerLayout.overlapsMarkdown) {
                    findings.push({ check: "chat-banner-overlap", detail: `banner ${Math.round(bannerLayout.bannerTop)}–${Math.round(bannerLayout.bannerBottom)}px; Markdown ends at ${Math.round(bannerLayout.markdownBottom)}px` });
                  }
                  if (bannerLayout.clearance < 8) {
                    findings.push({ check: "chat-banner-clearance", detail: `${Math.round(bannerLayout.clearance)}px between banner and Markdown card; expected at least 8px` });
                  }
                  if (bannerLayout.helperVisible) {
                    findings.push({ check: "chat-banner-helper", detail: `${viewport.width}px phone should hide the helper line` });
                  }
                }
              }
              if (expectedRecorderStopError && expectedRecorderStopErrors === 0) {
                findings.push({ check: "expected-recorder-stop-error", detail: "error fixture did not log its intentional stop failure" });
              }
              for (const error of errors) findings.push({ check: "errors", detail: error });

              const file = `${screen.id}__${viewport.id}__${theme}.png`;
              await page.screenshot({ path: `${outDir}${file}`, fullPage: screen.layout === "document" });
              captures.push({ screen: screen.id, viewport: viewport.id, theme, file, findings });

              for (const finding of findings) {
                failures.push(`${file}: ${finding.check}${finding.element ? ` ${finding.element}` : ""} (${finding.detail})`);
              }
              await page.close();
            }
          } finally {
            await context.close();
          }
        }
      }
      expect(failures).toEqual([]);
      // WebKit takes several seconds per page for the shell screens (they run the whole chat).
    }, 600_000);
  }

  const runsPhoneHaloReview =
    !viewportFilter ||
    viewportFilter.some((id) => ["phone", "phone-halo-review"].includes(id));
  const runsHaloReview = viewportFilter?.includes("halo-review") ?? false;
  if (runsPhoneHaloReview || runsHaloReview)
    test("recorder halo in tall phone and theme-token review captures", async () => {
      const halo = screens.find((screen) => screen.id === "recorder-final-halo");
      if (!halo) return;

      const haloViewports: Viewport[] = [
        ...(runsPhoneHaloReview
          ? [{ id: "phone-halo-review", width: 390, height: 4400, deviceScaleFactor: 2, isMobile: true, hasTouch: true }]
          : []),
        ...(viewportFilter?.includes("halo-review")
          ? [{ id: "halo-review", width: 1280, height: 2200, deviceScaleFactor: 2 }]
          : []),
      ];
      const forceCanvas = process.env.EXO_UI_HALO_FORCE_CANVAS === "1";
      const haloBrowser = await engine.launch({ headless: true });
      browsers.push(haloBrowser);

      for (const viewport of haloViewports) {
        for (const theme of themes) {
          const context = await haloBrowser.newContext({
            viewport: { width: viewport.width, height: viewport.height },
            deviceScaleFactor: viewport.deviceScaleFactor,
            isMobile: viewport.isMobile ?? false,
            hasTouch: viewport.hasTouch ?? false,
            colorScheme: theme,
            reducedMotion: motion,
          });
          if (forceCanvas) {
            await context.addInitScript(() => {
              const constructors = [HTMLCanvasElement, window.OffscreenCanvas].filter(Boolean) as Array<typeof HTMLCanvasElement>;
              for (const Canvas of constructors) {
                const getContext = Canvas.prototype.getContext;
                Canvas.prototype.getContext = function(type: string, ...args: unknown[]) {
                  if (/^(webgl|webgl2|experimental-webgl)$/.test(type)) return null;
                  return Reflect.apply(getContext, this, [type, ...args]);
                } as typeof Canvas.prototype.getContext;
              }
            });
          }
          try {
            const page = await context.newPage();
            const rendererPaths: string[] = [];
            page.on("console", (message) => {
              if (message.type() === "info" && message.text().includes("[HaloRing] renderer:")) rendererPaths.push(message.text());
            });
            try {
              await page.goto(`http://127.0.0.1:${server.port}/?screen=${halo.id}&theme=${theme}&platform=web&freeze=1`);
              await page.waitForFunction(() => window.exoUi?.ready === true, undefined, { timeout: 20_000 });
              await page.waitForFunction(
                inspectHaloPixels,
                { checkCorners: forceCanvas },
                { timeout: 5_000 },
              );
            } catch (caught) {
              const { canvases: canvasStates } = (await page.evaluate(
                inspectHaloPixels,
                { diagnostics: true },
              )) as { ready: boolean; canvases: unknown[] };
              const diagnostic = { error: String(caught), rendererPaths, canvasCount: canvasStates.length, canvases: canvasStates };
              console.error("Halo pixel check timed out", diagnostic);
              const diagnosticFile = `${halo.id}__${viewport.id}__${theme}${forceCanvas ? "-canvas2d" : ""}-timeout.png`;
              await page.screenshot({ path: `${outDir}${diagnosticFile}`, fullPage: false }).catch(() => {});
              throw new Error(`Halo pixel check timed out: ${JSON.stringify(diagnostic)}`, { cause: caught });
            }
            if (!forceCanvas && engineName === "webkit") {
              const center = await page
                .locator(".halo-ring__canvas")
                .nth(3)
                .evaluate(readHaloCenterPixel);
              expect(center.size % 2).toBe(1);
              const tokenColor = await page
                .locator(".halo-ring__canvas")
                .nth(3)
                .evaluate(readHaloThemeColor, theme);
              if (!center.color.every((channel, index) => Math.abs(channel - tokenColor[index]!) <= 18)) {
                throw new Error(`Halo ${theme} center ${center.color.join(",")} does not match --disc ${tokenColor.join(",")}`);
              }
            }
            if (forceCanvas) expect(rendererPaths.some((path) => path.includes("canvas-2d"))).toBe(true);
            const file = `${halo.id}__${viewport.id}__${theme}${forceCanvas ? "-canvas2d" : ""}.png`;
            await page.screenshot({ path: `${outDir}${file}`, fullPage: false });
            captures.push({ screen: halo.id, viewport: viewport.id, theme, file, findings: [] });
            await page.close();
          } finally {
            await context.close();
          }
        }
      }
    }, 180_000);
});

function contactSheet(all: Capture[]): string {
  const rows = all
    .map((capture) => {
      const problems = capture.findings.map((f) => `<li>${escapeHtml(`${f.check}${f.element ? ` ${f.element}` : ""}: ${f.detail}`)}</li>`).join("");
      return `<figure class="${capture.findings.length ? "bad" : ""}"><a href="${capture.file}"><img loading="lazy" src="${capture.file}" alt=""></a><figcaption>${escapeHtml(`${capture.screen} · ${capture.viewport} · ${capture.theme}`)}${problems ? `<ul>${problems}</ul>` : ""}</figcaption></figure>`;
    })
    .join("\n");
  return `<!doctype html><meta charset="utf-8"><title>exo-ui ${stamp}</title>
<style>body{font:14px system-ui;margin:24px;background:#f6f7f9;color:#191e33}main{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px}figure{margin:0;background:#fff;border:1px solid #dcdee5;border-radius:8px;padding:8px}figure.bad{border-color:#c1253a}img{width:100%;height:320px;object-fit:contain;object-position:top;background:#eaecf0}figcaption{margin-top:6px}ul{color:#c1253a;padding-left:16px;margin:4px 0 0}</style>
<h1>exo-ui · ${escapeHtml(engineName)} · ${all.length} captures</h1><main>${rows}</main>`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

declare global {
  interface Window {
    exoUi?: { screens: ScreenInfo[]; ready: boolean };
  }
}
