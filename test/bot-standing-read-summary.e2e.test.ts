import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { buildHarness, serveHarness } from "./exo-ui/harness-server";

const address = `0x${"22".repeat(20)}`;
const cid = "f".repeat(64);
const summary = {
  owner: `did:pkh:eip155:1:${address}`,
  from: "2026-11-15T08:00:00.000Z",
  to: "2026-11-22T08:00:00.000Z",
  days: [
    { day: "2026-11-20", area: "feed_chats", tool: "read_chat", ok: 0, refused: 2 },
    { day: "2026-11-21", area: "meetings", tool: "tinycloud_search_transcripts", ok: 3, refused: 1 },
    { day: "2026-11-21", area: "feed_chats", tool: "list_feed_cards", ok: 2, refused: 0 },
  ],
  total: 8,
};
const readPath = "/api/bots/main/reads";
const artifacts = process.env.STANDING_READS_SCREENSHOTS;
let server: ReturnType<typeof serveHarness>;
let browser: Browser;

beforeAll(async () => {
  server = serveHarness(await buildHarness());
  browser = await chromium.launch({ headless: true });
  if (artifacts) await mkdir(artifacts, { recursive: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

for (const theme of ["light", "dark"]) {
  for (const [size, viewport] of Object.entries({ desktop: { width: 1280, height: 900 }, phone: { width: 390, height: 844 } })) {
    test(`${size} ${theme} shows the owner's per-day counts beside the read settings`, async () => {
      const page = await browser.newPage({ viewport, locale: "en-US", timezoneId: "America/Los_Angeles" });
      try {
        await page.addInitScript(({ address }) => {
          localStorage.setItem("xyz.tinycloud.tinychat:session", JSON.stringify({ token: "fixture", expiresAt: Date.now() + 3_600_000, address }));
        }, { address });
        let active = true;
        let expired = false;
        let empty = false;
        let summaryCalls = 0;
        const areas = ["meetings", "feed_chats"];
        await page.route(`**${readPath}**`, async route => {
          const request = route.request();
          const path = new URL(request.url()).pathname;
          expect(request.headers().authorization).toBe("Bearer fixture");
          if (path === readPath) {
            await route.fulfill({ json: {
              serviceDid: "did:key:fixture", expiresAt: Date.now() + 3_600_000,
              areas: { meetings: "on", feed_chats: "on" }, standingAvailable: true,
            } });
          } else if (path === `${readPath}/standing`) {
            await route.fulfill({ json: {
              areas, active: active ? { originalCid: cid, areas, validUntil: Date.now() + 3_600_000 } : null,
              pending: null, previousOriginalCid: null, outcome: expired ? "expired" : null,
            } });
          } else if (path === `${readPath}/standing/summary`) {
            expect(request.method()).toBe("GET");
            summaryCalls++;
            await route.fulfill({ json: empty ? { ...summary, days: [], total: 0 } : summary });
          } else if (path === `${readPath}/standing/${cid}` && request.method() === "DELETE") {
            active = false;
            areas.length = 0;
            await route.fulfill({ status: 204 });
          } else {
            await route.fulfill({ status: 404 });
          }
        });

        await page.goto(`${server.url.origin}/?screen=bots-standing-read-summary&theme=${theme}`);
        // Send only the read fixture paths to the harness origin so its network guard stays in place.
        await page.evaluate(path => {
          const harnessFetch = window.fetch;
          window.fetch = (input, init) => {
            if (typeof input !== "string") return harnessFetch(input, init);
            const url = new URL(input, location.href);
            return harnessFetch(url.pathname.startsWith(path) ? url.pathname + url.search : input, init);
          };
        }, readPath);
        expect(summaryCalls).toBe(0);
        await page.getByRole("button", { name: "Open TrustBot's chat" }).click();
        const card = page.getByRole("region", { name: "Reads while you were away" });
        await card.getByText("3 allowed · 1 refused").waitFor();
        expect(await card.locator("time").allTextContents()).toEqual(["Nov 21, 2026", "Nov 20, 2026"]);
        expect(await card.getByRole("listitem").allTextContents()).toEqual([
          "Meetings · Search transcripts3 allowed · 1 refused",
          "Feed and chats · List feed cards2 allowed · 0 refused",
          "Feed and chats · Read a chat0 allowed · 2 refused",
        ]);
        expect(await page.locator("[data-bots-read-area=meetings]").isVisible()).toBe(true);
        expect(await page.locator("html").evaluate(el => el.classList.contains("dark"))).toBe(theme === "dark");
        await card.scrollIntoViewIfNeeded();
        const bounds = await card.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
        expect(bounds!.y).toBeGreaterThanOrEqual(0);
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
        if (artifacts) await page.screenshot({ path: join(artifacts, `${size}-${theme}.png`), animations: "disabled" });

        empty = true;
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await card.getByText("No reads in the last 7 days.").waitFor();
        const stop = page.getByRole("button", { name: "Turn off standing access" });
        if (size === "desktop") {
          await stop.click();
        } else {
          active = false;
          expired = true;
          areas.length = 0;
          await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        }
        await stop.waitFor({ state: "hidden" });
        expect(await card.isVisible()).toBe(true);
        empty = false;
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await card.getByText("3 allowed · 1 refused").waitFor();
      } finally {
        await page.close();
      }
    }, 30_000);
  }
}
