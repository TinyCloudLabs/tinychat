// Rendered navigation: the C3 agent access banner shows on the chat view and
// disappears on client-side navigation to Connectors (Sources, Library),
// Settings, the legacy /chat/meetings redirect and unknown /chat/* links —
// while the shared AgentAccessProvider stays mounted (same controller, no
// re-probe), so returning to chat shows it again with state intact.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let bundle = "";
let probes = 0;

const BANNER_TEXT = "Connect private agent access";

beforeAll(async () => {
  const built = await Bun.build({
    entrypoints: [new URL("../frontend/src/chat/agentBannerRouteHarness.tsx", import.meta.url).pathname],
    root: new URL("../frontend", import.meta.url).pathname,
    target: "browser",
    minify: false,
    define: { "import.meta.env": "{}" },
  });
  if (!built.success) throw new Error(built.logs.join("\n"));
  bundle = await built.outputs[0]!.text();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/bundle.js") {
        return new Response(bundle, { headers: { "content-type": "text/javascript" } });
      }
      if (url.pathname === "/api/agent/session") {
        probes++;
        return new Response("unauthorized", { status: 401 });
      }
      return new Response('<!doctype html><html><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>', {
        headers: { "content-type": "text/html" },
      });
    },
  });
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

async function openAt(path: string): Promise<Page> {
  probes = 0;
  const page = await browser.newPage();
  page.on("pageerror", (error) => console.error("Browser error:", error.message));
  await page.goto(`http://127.0.0.1:${server.port}${path}`);
  await page.waitForFunction(() => window.bannerHarness?.capability() === "available");
  return page;
}

async function navigate(page: Page, path: string) {
  await page.evaluate((to) => window.bannerHarness!.navigate(to), path);
  await page.waitForFunction((to) => window.location.pathname === to, path);
}

const bannerCount = (page: Page) => page.getByText(BANNER_TEXT).count();

describe.serial("agent access banner across chat navigation", () => {
  test("hides off the chat view and returns on it, with the provider kept mounted", async () => {
    const page = await openAt("/chat");
    await page.getByText(BANNER_TEXT).waitFor();
    expect(await page.getByRole("button", { name: "Connect agent" }).count()).toBe(1);

    for (const path of [
      "/chat/connectors",
      "/chat/connectors/library",
      "/chat/settings",
      "/chat/settings/",
      "/chat/meetings",
      "/chat/foo",
    ]) {
      await navigate(page, path);
      expect(await bannerCount(page)).toBe(0);
    }

    await navigate(page, "/chat");
    await page.getByText(BANNER_TEXT).waitFor();

    // One controller, one mount, one probe: navigation only toggled the banner.
    expect(await page.evaluate(() => window.bannerHarness!.controllers())).toBe(1);
    expect(await page.evaluate(() => window.bannerHarness!.providerChildMounts())).toBe(1);
    expect(probes).toBe(1);
    await page.close();
  });

  test("a cold load of a non-chat address never renders the banner", async () => {
    for (const path of ["/chat/connectors", "/chat/meetings", "/chat/foo"]) {
      const page = await openAt(path);
      expect(await bannerCount(page)).toBe(0);
      await page.close();
    }
  });
});
