// Build the production frontend before running this test.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";

const dist = new URL("../frontend/dist/", import.meta.url);
const index = Bun.file(new URL("index.html", dist));
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  if (!await index.exists()) throw new Error("Build the production frontend first");
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (/^\/handoff$/i.test(path)) return new Response(index);
      if (!path.startsWith("/assets/")) return new Response(null, { status: 404 });
      const asset = Bun.file(new URL(path.slice(1), dist));
      return await asset.exists() ? new Response(asset) : new Response(null, { status: 404 });
    },
  });
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

for (const { title, path, failChunk } of [
  { title: "a mixed-case handoff reaches the lazy route and consumes the fragment", path: "/Handoff", failChunk: false },
  { title: "a failed handoff chunk clears the captured fragment and opens Home", path: "/handoff", failChunk: true },
]) {
  test(title, async () => {
    const context = await browser.newContext({ serviceWorkers: "block" });
    try {
      let requested = false;
      await context.route("**/*", (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== server.url.origin) return route.abort();
        if (/^\/assets\/HandoffPage-.*\.js$/.test(url.pathname)) {
          requested = true;
          if (failChunk) return route.abort();
        }
        return route.continue();
      });
      const page = await context.newPage();
      // The fragment passes boot's transport prefix check and is intentionally
      // invalid as a UCAN, so both cases finish on the normal first screen.
      await page.goto(new URL(path + "#tch1INVALID", server.url).href);
      await page.waitForURL("**/chat/feed");
      expect(requested).toBe(true);
      expect(await page.evaluate(() => ({
        hash: location.hash,
        captured: Object.hasOwn(window, "takeHandoffFragment"),
      }))).toEqual({ hash: "", captured: false });
    } finally {
      await context.close();
    }
  }, 30_000);
}
