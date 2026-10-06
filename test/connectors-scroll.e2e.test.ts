// Rendered layout: the Connectors page scrolls inside its own pane. The app
// shell (header, sidebar) stays fixed to the viewport, the document never grows
// taller than the window, and switching Transcriber tabs never moves the
// document. Before the fix the `sr-only` labels of the meeting-link form were
// positioned against the initial containing block, escaped the scroller and
// stretched the document (Exo 0.5.0 at 1280x800).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { webkit, chromium, type Browser, type BrowserType, type Page } from "playwright";

const frontend = new URL("../frontend/", import.meta.url).pathname;

let server: ReturnType<typeof Bun.serve>;
let bundle = "";
let css = "";

beforeAll(async () => {
  const built = await Bun.build({
    entrypoints: [`${frontend}src/chat/connectorsScrollHarness.tsx`],
    root: frontend,
    target: "browser",
    minify: false,
    define: { "import.meta.env": "{}" },
  });
  if (!built.success) throw new Error(built.logs.join("\n"));
  bundle = await built.outputs[0]!.text();

  // The app's own stylesheet, compiled with its Tailwind config.
  const requireFromFrontend = createRequire(`${frontend}package.json`);
  const postcss = requireFromFrontend("postcss");
  const tailwindcss = requireFromFrontend("tailwindcss");
  const source = await Bun.file(`${frontend}src/index.css`).text();
  // The config's content globs are relative; anchor them at frontend/.
  const config = (await import(`${frontend}tailwind.config.js`)).default;
  config.content = [`${frontend}index.html`, `${frontend}src/**/*.{js,ts,jsx,tsx}`];
  css = (await postcss([tailwindcss(config)]).process(source, { from: `${frontend}src/index.css` })).css;

  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/bundle.js") return new Response(bundle, { headers: { "content-type": "text/javascript" } });
      if (url.pathname === "/app.css") return new Response(css, { headers: { "content-type": "text/css" } });
      if (url.pathname.startsWith("/api/")) return new Response("unauthorized", { status: 401 });
      return new Response(
        '<!doctype html><html class="dark"><head><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );
    },
  });
});

afterAll(() => {
  server?.stop(true);
});

const geometry = (page: Page) =>
  page.evaluate(() => ({
    documentHeight: document.documentElement.scrollHeight,
    viewportHeight: window.innerHeight,
    scrollY: window.scrollY,
    headerTop: document.querySelector("[data-testid=shell-header]")!.getBoundingClientRect().top,
    sidebarBottom: document.querySelector("[data-testid=shell-sidebar]")!.getBoundingClientRect().bottom,
  }));

function expectShellPinned(g: Awaited<ReturnType<typeof geometry>>) {
  expect(g.documentHeight).toBe(g.viewportHeight);
  expect(g.scrollY).toBe(0);
  expect(g.headerTop).toBe(0);
  expect(g.sidebarBottom).toBe(g.viewportHeight);
}

for (const [name, engine] of [["webkit", webkit], ["chromium", chromium]] as [string, BrowserType][]) {
  describe.serial(`Connectors scroll containment (${name}, 1280x800)`, () => {
    let browser: Browser;
    beforeAll(async () => {
      browser = await engine.launch({ headless: true });
    });
    afterAll(async () => {
      await browser?.close();
    });

    test("only the content pane scrolls; tab switches never move the document", async () => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto(`http://127.0.0.1:${server.port}/chat/connectors`);
      await page.getByLabel("Meeting link").waitFor({ state: "attached" });
      expectShellPinned(await geometry(page));

      // Wheel over the sidebar: nothing below it can scroll the document.
      await page.mouse.move(130, 400);
      await page.mouse.wheel(0, 2000);
      await page.waitForTimeout(200);
      expectShellPinned(await geometry(page));

      // Wheel over the content pane: the pane scrolls, the shell does not.
      await page.mouse.move(760, 400);
      await page.mouse.wheel(0, 2000);
      await page.waitForTimeout(200);
      expectShellPinned(await geometry(page));

      for (const tab of ["Upload audio", "Meeting bot", "Upload audio", "Meeting bot"]) {
        const target = page.getByRole("tab", { name: tab });
        const before = (await target.boundingBox())!.y;
        await target.click();
        await expect(target.getAttribute("aria-selected")).resolves.toBe("true");
        expectShellPinned(await geometry(page));
        // The tab strip sits above the panel that changes, so it must not move.
        expect((await target.boundingBox())!.y).toBe(before);
      }
      await page.close();
    });
  });
}
