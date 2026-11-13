import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { buildHarness, serveHarness } from "./exo-ui/harness-server";

const frontend = new URL("../frontend/", import.meta.url).pathname;
for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
  for (const result of ["fail", "resolve"] as const) {
    test(`Main sends while history loads at ${viewport.width}px; late history ${result}`, async () => {
      const styles = await buildHarness();
      const build = await Bun.build({ entrypoints: [frontend + "src/harness/historyReadMain.fixture.tsx"], root: frontend,
        target: "browser", define: { "import.meta.env": "{}" }, external: ["/fonts/*"] });
      if (!build.success) throw new Error(build.logs.join("\n"));
      const server = serveHarness({ ...styles, bundle: await build.outputs.find(output => output.kind === "entry-point")!.text() });
      const browser = await chromium.launch({ headless: true, ...(process.env.BOT_HISTORY_BROWSER ? { executablePath: process.env.BOT_HISTORY_BROWSER } : {}) });
      try {
        const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.route("**/*", route => new URL(route.request().url()).origin === server.url.origin ? route.continue() : route.abort());
        await page.goto(server.url.origin);
        await page.getByRole("textbox", { name: "What do you want done?" }).fill("New question");
        await page.getByRole("button", { name: "Send", exact: true }).click();
        const sheet = page.locator("[data-bots-main-chat]");
        await sheet.waitFor();
        await page.getByRole("status").filter({ hasText: "Loading earlier messages…" }).waitFor();
        // No history response is resolved: the POST must nevertheless have started.
        await page.waitForFunction(() => (window as unknown as { tc2909: { sends: number } }).tc2909.sends === 1);
        if (process.env.TC2909_CAPTURE_DIR && result === "fail") await page.screenshot({ path: `${process.env.TC2909_CAPTURE_DIR}/${viewport.width}-history-loading.png` });
        await page.evaluate(() => (window as unknown as { tc2909: { complete(): void } }).tc2909.complete());
        await sheet.getByText("Current answer", { exact: true }).waitFor();
        await page.evaluate(result => (window as unknown as { tc2909: { fail(): void; resolve(): void } }).tc2909[result](), result);
        if (result === "fail") {
          await sheet.getByRole("alert").filter({ hasText: "Couldn't load your earlier messages with Main." }).waitFor();
          await sheet.getByRole("button", { name: "Try again", exact: true }).click();
          await page.getByRole("status").filter({ hasText: "Loading earlier messages…" }).waitFor();
          expect(await page.evaluate(() => (window as unknown as { tc2909: { reads: number } }).tc2909.reads)).toBe(2);
          await page.evaluate(() => (window as unknown as { tc2909: { resolve(): void } }).tc2909.resolve());
        }
        await sheet.getByText("Earlier answer", { exact: true }).waitFor();
        expect(await sheet.getByText("Current answer", { exact: true }).count()).toBe(1);
        expect(await sheet.getByText("New question", { exact: true }).count()).toBe(1);
        expect(await sheet.isVisible()).toBe(true);
        expect(await sheet.getByRole("alert").count()).toBe(0);
        expect(await page.getByRole("status").filter({ hasText: "Loading earlier messages…" }).count()).toBe(0);
        expect(errors).toEqual([]);
      } finally { await browser.close(); server.stop(true); }
    }, 60_000);
  }
}
