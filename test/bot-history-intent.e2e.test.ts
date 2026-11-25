import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { buildHarness, serveHarness } from "./exo-ui/harness-server";
const frontend = new URL("../frontend/", import.meta.url).pathname;
for (const width of [390, 1280]) {
  test(`history approval follows the owner action at ${width}px`, async () => {
    const styles = await buildHarness();
    const build = await Bun.build({ entrypoints: [frontend + "src/harness/historyIntent.fixture.tsx"], root: frontend,
      target: "browser", define: { "import.meta.env": "{}" }, external: ["/fonts/*"] });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const server = serveHarness({ ...styles, bundle: await build.outputs.find(output => output.kind === "entry-point")!.text() });
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
      await page.route("**/*", route => new URL(route.request().url()).origin === server.url.origin ? route.continue() : route.abort());
      await page.goto(server.url.origin);
      const sheet = page.locator("[data-bots-main-chat]");
      const show = page.getByRole("button", { name: "Show older messages", exact: true });
      await show.waitFor();
      const counts = () => page.evaluate(() => (window as unknown as { tc3583: { asks: number; sends: number } }).tc3583);
      const capture = async (state: string) => { if (process.env.TC3583_CAPTURE_DIR) await page.screenshot({ path: `${process.env.TC3583_CAPTURE_DIR}/${width}-${state}.png` }); };
      expect((await counts()).asks).toBe(0); await capture("opened");
      await show.click();
      const prompt = page.getByRole("dialog", { name: /requesting additional permissions/ });
      await prompt.waitFor(); expect((await counts()).asks).toBe(1); await capture("asked");
      await prompt.getByRole("button", { name: "Decline", exact: true }).click();
      await page.locator("tinycloud-permission-request-modal").waitFor({ state: "detached" });
      await sheet.getByText("Older messages stay hidden until you approve access.", { exact: true }).waitFor(); await capture("cancelled");
      await page.getByRole("textbox", { name: "Message TrustBot" }).fill("hello");
      await page.getByRole("button", { name: "Send to TrustBot", exact: true }).click();
      await sheet.getByText("Current answer", { exact: true }).waitFor();
      expect((await counts()).sends).toBe(1); expect((await counts()).asks).toBe(1);
      await sheet.getByRole("button", { name: "Close", exact: true }).click(); await sheet.waitFor({ state: "hidden" });
      await page.locator("#outside").click(); await show.waitFor();
      expect((await counts()).asks).toBe(1); await capture("button");
      await show.click(); await prompt.waitFor(); expect((await counts()).asks).toBe(2);
      await prompt.getByRole("button", { name: "Decline", exact: true }).click();
      await show.waitFor(); expect((await counts()).asks).toBe(2);
    } finally { await browser.close(); server.stop(true); }
  }, 60_000);
}
