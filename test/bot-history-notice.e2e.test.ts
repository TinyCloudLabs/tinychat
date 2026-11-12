import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { buildHarness, serveHarness } from "./exo-ui/harness-server";

test("Main acknowledges the expiry notice only after opening it, with the deletion date actually shown", async () => {
  const assets = await buildHarness();
  const server = serveHarness(assets);
  const browser = await chromium.launch({ headless: true, ...(process.env.BOT_HISTORY_BROWSER ? { executablePath: process.env.BOT_HISTORY_BROWSER } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: "en-US", timezoneId: "UTC" });
    await page.addInitScript(() => { (window as unknown as { nativeFetch: typeof fetch }).nativeFetch = window.fetch.bind(window); localStorage.setItem("xyz.tinycloud.tinychat:session", JSON.stringify({ token: "fixture", expiresAt: Date.now() + 3_600_000, address: "0x" + "22".repeat(20) })); });
    const acknowledged = Promise.withResolvers<{ id: string; renderedAt: number; deleteAt: number }>();
    let calls = 0;
    await page.route("**/api/bots/history/notice/ack", async route => {
      if (route.request().method() === "OPTIONS") {
        await route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "POST", "access-control-allow-headers": "authorization,content-type,x-requested-with" } }); return;
      }
      calls++; acknowledged.resolve(route.request().postDataJSON());
      await route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } });
    });
    await page.goto(server.url.origin + "/?screen=bots-history-expiry-pending");
    await page.waitForSelector("[data-bots-ask]");
    // The screenshot harness deliberately blocks cross-origin fetch. Restore the captured native
    // transport just for this loopback-routed acknowledgment so the browser exercises the real request.
    await page.evaluate(() => {
      const harnessFetch = window.fetch;
      window.fetch = (input, init) => String(input).includes("/api/bots/history/notice/ack")
        ? (window as unknown as { nativeFetch: typeof fetch }).nativeFetch(input, init) : harnessFetch(input, init);
    });
    expect(calls).toBe(0);
    await page.getByRole("button", { name: "Open Main's chat" }).click();
    await page.waitForSelector("[data-history-expiry-notice]");
    const ack = await acknowledged.promise;
    expect(ack.id).toBe("f".repeat(64));
    expect(await page.locator("[data-history-expiry-notice]").textContent()).toContain(new Date(ack.deleteAt).toLocaleDateString("en-US", { timeZone: "UTC", dateStyle: "medium" }));
    expect(await page.getByRole("button", { name: "Reconnect TinyCloud", exact: true }).isVisible()).toBe(true);
    expect(calls).toBeGreaterThan(0);
  } finally { await browser.close(); server.stop(true); }
}, 60_000);
