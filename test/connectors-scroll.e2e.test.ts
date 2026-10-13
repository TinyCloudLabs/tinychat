// Rendered layout: Connectors, Capture and Settings scroll inside their own
// pane. The app shell (the sidebar, the page's header) stays fixed to the
// viewport, the document never grows taller than the window, and opening and
// closing Capture's Upload and Meeting sheets never moves the document. Before the fix,
// sr-only/absolute descendants (e.g. the meeting-link form labels) were
// positioned against the initial containing block, escaped the scroller and
// stretched the document (Exo 0.5.0 at 1280x800). The harness renders the real
// AppShell (TC-761).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { webkit, chromium, type Browser, type BrowserType, type Page } from "playwright";

const frontend = new URL("../frontend/", import.meta.url).pathname;

let bundle = "";
let css = "";

beforeAll(async () => {
  const built = await Bun.build({
    entrypoints: [`${frontend}src/chat/connectorsScrollHarness.tsx`],
    root: frontend,
    target: "browser",
    minify: false,
    define: { "import.meta.env": "{}" },
    // index.css's @font-face URLs point into frontend/public; nothing here needs the font.
    external: ["/fonts/*"],
  });
  if (!built.success) throw new Error(built.logs.join("\n"));
  bundle = await built.outputs.find((output) => output.kind === "entry-point")!.text();
  const componentCss = await Promise.all(
    built.outputs
      .filter((output) => output.path.endsWith(".css"))
      .map((output) => output.text()),
  );

  // The app's own stylesheet, compiled with its Tailwind config.
  const requireFromFrontend = createRequire(`${frontend}package.json`);
  const postcss = requireFromFrontend("postcss");
  const tailwindcss = requireFromFrontend("tailwindcss");
  const source = await Bun.file(`${frontend}src/index.css`).text();
  // The config's content globs are relative; anchor them at frontend/.
  const config = (await import(`${frontend}tailwind.config.js`)).default;
  config.content = [`${frontend}index.html`, `${frontend}src/**/*.{js,ts,jsx,tsx}`];
  css =
    (await postcss([tailwindcss(config)]).process(source, { from: `${frontend}src/index.css` })).css +
    componentCss.join("\n");

}, 60_000);

function startServer() {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/bundle.js") return new Response(bundle, { headers: { "content-type": "text/javascript" } });
      if (url.pathname === "/app.css") return new Response(css, { headers: { "content-type": "text/css" } });
      if (url.pathname.startsWith("/api/")) return new Response("unauthorized", { status: 401 });
      return new Response(
        '<!doctype html><html class="dark" data-size="expanded"><head><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );
    },
  });
}

const geometry = (page: Page) =>
  page.evaluate(() => {
    // The header of the surface on screen (the hidden ones have no box).
    const header = [...document.querySelectorAll<HTMLElement>("main [data-surface] header")].find(
      (element) => element.getClientRects().length > 0,
    )!;
    return {
      documentHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
      scrollY: window.scrollY,
      // The sticky header can sit inside the desktop surface's top padding.
      headerTop:
        header.getBoundingClientRect().top -
        Number.parseFloat(getComputedStyle(header.parentElement!).paddingTop),
      sidebarBottom: document.querySelector("[data-testid=sidebar]")!.getBoundingClientRect().bottom,
    };
  });

function expectShellPinned(g: Awaited<ReturnType<typeof geometry>>) {
  expect(g.documentHeight).toBe(g.viewportHeight);
  expect(g.scrollY).toBe(0);
  expect(g.headerTop).toBe(0);
  expect(g.sidebarBottom).toBe(g.viewportHeight);
}

// One engine per process: WebKit (what Exo's WKWebView runs) by default,
// SCROLL_ENGINE=chromium for the web app's most common engine. Launching both
// in one bun process intermittently wedges the second browser.
const engines: Record<string, BrowserType> = { webkit, chromium };
const name = process.env.SCROLL_ENGINE ?? "webkit";
const engine = engines[name];
if (!engine) throw new Error(`SCROLL_ENGINE must be one of ${Object.keys(engines).join(", ")}`);

describe.serial(`App pane scroll containment (${name}, 1280x800)`, () => {
  let browser: Browser;
  let server: ReturnType<typeof Bun.serve>;
  beforeAll(async () => {
    server = startServer();
    browser = await engine.launch({ headless: true });
  }, 30_000);
  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
  }, 30_000);

  async function wheelBoth(page: Page) {
    // Wheel over the sidebar: nothing below it can scroll the document.
    await page.mouse.move(110, 400);
    await page.mouse.wheel(0, 2000);
    await page.waitForTimeout(200);
    expectShellPinned(await geometry(page));
    // Wheel over the content pane: the pane scrolls, the shell does not.
    await page.mouse.move(760, 400);
    await page.mouse.wheel(0, 2000);
    await page.waitForTimeout(200);
    expectShellPinned(await geometry(page));
  }

  test("Connectors: only the content pane scrolls", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${server.port}/chat/connectors`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Connectors", exact: true }).waitFor();
    await page.waitForTimeout(500);
    expectShellPinned(await geometry(page));
    await wheelBoth(page);
    await page.close();
  }, 30_000);

  test("Capture: only the content pane scrolls; opening and closing the Upload and Meeting sheets never moves the document", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${server.port}/chat/capture`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Upload audio" }).waitFor();
    expectShellPinned(await geometry(page));
    await wheelBoth(page);

    for (const [action, field] of [
      ["Upload audio", "Choose an audio file"],
      ["Send a notetaker to a meeting", "Meeting link"],
      ["Upload audio", "Choose an audio file"],
      ["Send a notetaker to a meeting", "Meeting link"],
    ] as const) {
      const target = page.getByRole("button", { name: action });
      const before = (await target.boundingBox())!.y;
      await target.click();
      await page.getByRole("dialog").getByText(field).first().waitFor();
      expectShellPinned(await geometry(page));
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "detached" });
      expectShellPinned(await geometry(page));
      // The actions sit where they were: nothing behind the sheet moved.
      expect((await target.boundingBox())!.y).toBe(before);
    }
    await page.close();
  }, 30_000);

  test("Settings: only the content pane scrolls", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${server.port}/chat/settings`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
    await page.waitForTimeout(500);
    expectShellPinned(await geometry(page));
    await wheelBoth(page);
    await page.close();
  }, 30_000);
});
