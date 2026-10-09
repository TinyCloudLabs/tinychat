// The Soft-skin phone Capture home (TC-871) interactions, on the exo-ui harness
// screens (frontend/src/harness/screens/capture.tsx):
//
//   1. A Recent row is one control; tapping it opens the note.
//   2. A "couldn't recover" row opens a labelled sheet; Close returns focus to the row.
//   3. Save now on the "on this phone" card calls retryPending.
//
// SOFT_HOME_ENGINE=webkit runs it in WebKit (the phone app's engine); Chromium by default (CI).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import {
  chromium,
  webkit,
  type Browser,
  type BrowserType,
  type Page,
} from "playwright";

const frontend = new URL("../frontend/", import.meta.url).pathname;

let bundle = "";
let css = "";
let html = "";

beforeAll(async () => {
  const built = await Bun.build({
    entrypoints: [`${frontend}src/harness/exoUiHarness.tsx`],
    root: frontend,
    target: "browser",
    minify: false,
    define: {
      "import.meta.env": "{}",
      __EXO_BUILD_INFO__: JSON.stringify({ channel: "dev" }),
    },
    external: ["/fonts/*"],
  });
  if (!built.success) throw new Error(built.logs.join("\n"));
  bundle = await built.outputs
    .find((output) => output.kind === "entry-point")!
    .text();

  const requireFromFrontend = createRequire(`${frontend}package.json`);
  const postcss = requireFromFrontend("postcss");
  const tailwindcss = requireFromFrontend("tailwindcss");
  const source = await Bun.file(`${frontend}src/index.css`).text();
  const config = (await import(`${frontend}tailwind.config.js`)).default;
  config.content = [
    `${frontend}index.html`,
    `${frontend}src/**/*.{js,ts,jsx,tsx}`,
  ];
  css = (
    await postcss([tailwindcss(config)]).process(source, {
      from: `${frontend}src/index.css`,
    })
  ).css;
  for (const output of built.outputs.filter((entry) =>
    entry.path.endsWith(".css"),
  ))
    css += `\n${await output.text()}`;

  const index = await Bun.file(`${frontend}index.html`).text();
  const appScript = '<script type="module" src="/src/main.tsx"></script>';
  if (!index.includes(appScript) || !index.includes("</head>"))
    throw new Error("index.html changed: update the capture-home e2e page");
  html = index
    .replace(appScript, '<script type="module" src="/bundle.js"></script>')
    .replace("</head>", '<link rel="stylesheet" href="/app.css" />\n  </head>');
}, 120_000);

const server = () =>
  Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/bundle.js")
        return new Response(bundle, {
          headers: { "content-type": "text/javascript" },
        });
      if (url.pathname === "/app.css")
        return new Response(css, { headers: { "content-type": "text/css" } });
      if (url.pathname.startsWith("/fonts/")) {
        const file = Bun.file(`${frontend}public${url.pathname}`);
        return (await file.exists())
          ? new Response(file)
          : new Response("not found", { status: 404 });
      }
      if (url.pathname.startsWith("/api/"))
        return new Response("not found", { status: 404 });
      return new Response(html, { headers: { "content-type": "text/html" } });
    },
  });

const engines: Record<string, BrowserType> = { chromium, webkit };
const engine = engines[process.env.SOFT_HOME_ENGINE ?? "chromium"];
if (!engine)
  throw new Error(
    `SOFT_HOME_ENGINE must be one of ${Object.keys(engines).join(", ")}`,
  );

let browser: Browser;
let running: ReturnType<typeof server>;
beforeAll(async () => {
  running = server();
  browser = await engine.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
  running?.stop(true);
});

async function open(screen: string): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.goto(
    `http://127.0.0.1:${running.port}/?screen=${screen}&theme=dark&platform=ios&freeze=1`,
  );
  await page.waitForFunction(() => window.exoUi?.ready === true, undefined, {
    timeout: 20_000,
  });
  return page;
}

describe("Soft Capture home interactions (phone)", () => {
  test("tapping a Recent row opens its note", async () => {
    const page = await open("capture-soft-notes");
    const row = page
      .locator('[data-testid="capture-recent"] [data-testid="recent-item"] a')
      .first();
    expect(await row.getAttribute("aria-label")).toContain("Voice note");
    await row.tap();
    await page.waitForSelector(
      '[data-testid="note-detail"], [data-testid="note-loading"], [data-testid="note-failed"], [data-testid="note-absent"]',
      { timeout: 5_000 },
    );
    await page.context().close();
  });

  test("a couldn't-recover row opens a sheet, and Close returns focus to the row", async () => {
    const page = await open("capture-soft-recovery-failed");
    const row = page.locator(
      '[data-testid="capture-recent"] li[data-issue="recoveryFailed"] button',
    );
    expect(await row.getAttribute("aria-label")).toContain("Needs attention");
    await row.tap();

    const sheet = page.getByRole("dialog");
    await sheet.waitFor({ timeout: 5_000 });
    expect(await sheet.getAttribute("aria-modal")).not.toBe("false");
    expect(await sheet.getAttribute("aria-labelledby")).toBeTruthy();
    expect(await sheet.innerText()).toContain(
      "Exo couldn't finish saving this recording. It will try again when it next opens.",
    );
    expect(await sheet.innerText()).not.toMatch(
      /Try again\b(?!.*opens)|Delete/,
    );

    await page.locator('[data-testid="capture-issue-close"]').tap();
    await sheet.waitFor({ state: "detached", timeout: 5_000 });
    expect(await row.evaluate((el) => el === document.activeElement)).toBe(
      true,
    );
    await page.context().close();
  });

  test("Save now retries the saves waiting on this phone", async () => {
    const page = await open("capture-soft-on-phone");
    expect(await page.evaluate(() => window.exoUiRetryPending ?? 0)).toBe(0);
    await page.locator('[data-testid="voice-note-retry"]').tap();
    expect(await page.evaluate(() => window.exoUiRetryPending ?? 0)).toBe(1);
    await page.context().close();
  });
});
