// A Home card's Details keeps every part inside its own column at every width: the "This card" rail never grows
// past its column, nor reaches into the "Not shown" list beside it from 900px (Clarissa, #711: at 1280 the rail ran
// 430px wide in its 240px column, 170px under the list). Geometry only, on the harness's Rocinante question
// (frontend/src/harness/screens/homeFeedDetails.tsx), in Chromium.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { SITREP_NOW } from "../frontend/src/feed/sitrep.fixtures";
import { buildHarness, serveHarness } from "./exo-ui/harness-server";

setDefaultTimeout(30_000);

let browser: Browser;
let server: ReturnType<typeof serveHarness>;

beforeAll(async () => {
  server = serveHarness(await buildHarness());
  browser = await chromium.launch({ headless: true });
}, 120_000);

afterAll(async () => {
  await Promise.race([browser?.close(), new Promise((resolve) => setTimeout(resolve, 10_000))]);
  server?.stop(true);
});

for (const width of [390, 768, 900, 1280, 1440]) {
  test(`Details at ${width}px: the rail fits its column and stays clear of the Not shown list`, async () => {
    const page = await (await browser.newContext({ viewport: { width, height: 900 } })).newPage();
    // Half an hour after the synthetic cards were made, so the question is still open.
    await page.clock.install({ time: new Date(Date.parse(SITREP_NOW) + 30 * 60_000) });
    await page.clock.resume();
    await page.goto(`http://127.0.0.1:${server.port}/?screen=home-feed-details&theme=light&platform=web`);
    const article = page.locator("article").first();
    await article.waitFor({ timeout: 15_000 });
    await article.locator("button[aria-expanded]", { hasText: /^Details/ }).first().click();
    await page.locator('[aria-label="Not shown on the card"]').waitFor({ timeout: 5_000 });
    const layout = await page.evaluate(() => {
      const panel = document.querySelector('[aria-label="Details"]')!;
      const list = panel.querySelector('[aria-label="Not shown on the card"]')!;
      const rail = panel.querySelector('[aria-label="This card"]')!.parentElement!;
      const box = (node: Element) => node.getBoundingClientRect();
      const railBox = box(rail);
      // Anything in the rail that ends past the rail's own right edge.
      const outside = [...rail.querySelectorAll("*")].filter((node) => box(node).right > railBox.right + 0.5).map((node) => (node.textContent ?? "").slice(0, 40));
      return { panelRight: box(panel).right, railRight: railBox.right, railScroll: rail.scrollWidth, railWidth: rail.clientWidth, listLeft: box(list).left, listTop: box(list).top, railTop: railBox.top, outside };
    });
    await page.close();
    expect(layout.outside).toEqual([]);
    expect(layout.railScroll).toBeLessThanOrEqual(layout.railWidth + 1);
    expect(layout.railRight).toBeLessThanOrEqual(layout.panelRight + 0.5);
    // Side by side (900px and wider), the rail ends before the list begins.
    if (Math.abs(layout.listTop - layout.railTop) < 1) expect(layout.railRight).toBeLessThanOrEqual(layout.listLeft + 0.5);
  });
}
