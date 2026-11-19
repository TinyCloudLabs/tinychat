import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright";
import { buildHarness, serveHarness } from "./exo-ui/harness-server";

const frontend = new URL("../frontend/", import.meta.url).pathname;
async function assets() {
  const styles = await buildHarness();
  const build = await Bun.build({ entrypoints: [frontend + "src/harness/sdkPermissionMain.fixture.tsx"], root: frontend,
    target: "browser", define: { "import.meta.env": "{}" }, external: ["/fonts/*"] });
  if (!build.success) throw new Error(build.logs.join("\n"));
  return { ...styles, bundle: await build.outputs.find(output => output.kind === "entry-point")!.text() };
}
async function sheetTrapsFocus(page: Page) {
  await page.locator("#outside").evaluate((element: HTMLElement) => element.focus());
  await page.waitForFunction(() => !!document.activeElement?.closest("[data-bots-main-chat]"), undefined, { timeout: 3000 });
}
for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
  for (const action of ["Decline", "Approve", "Escape"]) {
    test(`SDK permission is accessible over Main at ${viewport.width}px; ${action} restores the sheet`, async () => {
      const server = serveHarness(await assets());
      const browser = await chromium.launch({ headless: true, ...(process.env.BOT_HISTORY_BROWSER ? { executablePath: process.env.BOT_HISTORY_BROWSER } : {}) });
      try {
        const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
        await page.route("**/*", route => new URL(route.request().url()).origin === server.url.origin ? route.continue() : route.abort());
        const pageErrors: string[] = [];
        page.on("pageerror", error => pageErrors.push(error.message));
        await page.goto(server.url.origin);
        const composer = page.getByRole("textbox", { name: "Message Main" });
        await composer.fill("keep my draft");
        await sheetTrapsFocus(page);
        await page.evaluate(() => { void (window as unknown as { tc2835: { request(): Promise<void> } }).tc2835.request(); });
        await page.locator("tinycloud-permission-request-modal [role=dialog]").waitFor();
        const prompt = page.getByRole("dialog", { name: /requesting additional permissions/ });
        await prompt.waitFor({ timeout: 3000 });
        const approve = prompt.getByRole("button", { name: "Approve", exact: true });
        const decline = prompt.getByRole("button", { name: "Decline", exact: true });
        expect(await prompt.evaluate(element => element.contains((element.getRootNode() as ShadowRoot).activeElement))).toBe(true);
        await approve.focus();
        expect(await approve.evaluate(element => element === (element.getRootNode() as ShadowRoot).activeElement)).toBe(true);
        for (let tab = 0; tab < 5; tab++) {
          await page.keyboard.press("Tab");
          expect(await prompt.evaluate(element => element.contains((element.getRootNode() as ShadowRoot).activeElement))).toBe(true);
        }
        await decline.focus();
        expect(await decline.evaluate(element => element === (element.getRootNode() as ShadowRoot).activeElement)).toBe(true);
        if (process.env.TC2835_CAPTURE_DIR && action === "Decline") await page.screenshot({ path: `${process.env.TC2835_CAPTURE_DIR}/${viewport.width}-sdk-prompt.png` });
        if (action === "Escape") await page.keyboard.press("Escape");
        else await (action === "Approve" ? approve : decline).press("Enter");
        await page.locator("tinycloud-permission-request-modal").waitFor({ state: "detached" });
        await composer.waitFor();
        expect(await composer.inputValue()).toBe("keep my draft");
        expect(await page.evaluate(() => (window as unknown as { tc2835: { result: boolean } }).tc2835.result)).toBe(action === "Approve");
        await sheetTrapsFocus(page);
        await page.keyboard.press("Escape");
        await page.locator("[data-bots-main-chat]").waitFor({ state: "hidden" });
        await page.locator("#outside").click();
        await composer.waitFor();
        expect(await composer.inputValue()).toBe("");
        expect(pageErrors).toEqual([]);
      } finally { await browser.close(); server.stop(true); }
    }, 60_000);
  }
}
