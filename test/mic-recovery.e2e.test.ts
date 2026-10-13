// The microphone recovery views that remain outside the recorder (MicrophoneAccessOff, and the signed-out
// MicDeniedRecovery), over native calls that reject with native details: the person sees a stable line, the cause is only logged.
//
//   EXO_UI_ENGINE=chromium   webkit (default: Exo's WKWebView) or chromium
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chromium, webkit, type Browser, type Page } from "playwright";
import { buildHarness, serveHarness } from "./exo-ui/harness-server";

const engine = (process.env.EXO_UI_ENGINE ?? "webkit") === "chromium" ? chromium : webkit;
setDefaultTimeout(30_000);

let browser: Browser;
let server: ReturnType<typeof serveHarness>;

beforeAll(async () => {
  server = serveHarness(await buildHarness());
  browser = await engine.launch({ headless: true });
}, 120_000);

afterAll(async () => {
  await Promise.race([browser?.close(), new Promise((resolve) => setTimeout(resolve, 10_000))]);
  server?.stop(true);
});

async function open(name: string, platform: "ios" | "android") {
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" })).newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) errors.push(message.text());
  });
  await page.goto(`http://127.0.0.1:${server.port}/?screen=mic-recovery-${name}&theme=light&platform=${platform}`);
  return { page, errors };
}

const alertText = async (page: Page): Promise<string> => {
  const alert = page.getByRole("alert");
  await alert.waitFor();
  return (await alert.textContent()) ?? "";
};

const NATIVE = /NSCocoaErrorDomain|avfoundation|native detail|0x7f3a/;

describe("microphone recovery never shows a native error", () => {
  test("Open Settings failing: the Settings line; the cause is logged", async () => {
    const { page, errors } = await open("off", "ios");
    await page.getByRole("button", { name: "Open Settings" }).click();
    const text = await alertText(page);
    expect(text).toBe("Couldn't open Settings. Open Settings › Exo › Microphone.");
    expect(text).not.toMatch(NATIVE);
    expect(errors.some((line) => line.includes("Could not open Settings"))).toBe(true);
    await page.context().close();
  });

  test("minimise failing: a stable line; the cause is logged", async () => {
    const { page, errors } = await open("off", "ios");
    await page.getByRole("button", { name: "Minimise recorder" }).click();
    const text = await alertText(page);
    expect(text).toBe("Couldn't close this. Try again.");
    expect(text).not.toMatch(NATIVE);
    expect(errors.some((line) => line.includes("Could not dismiss the microphone recovery"))).toBe(true);
    await page.context().close();
  });

  test("signed out, microphone denied: Open Settings and the dismiss both fail with stable lines", async () => {
    const { page, errors } = await open("denied", "android");
    await page.getByRole("button", { name: "Open Settings" }).click();
    expect(await alertText(page)).toBe("Couldn't open Settings. Open Settings › Exo › Microphone.");
    await page.getByRole("button", { name: "Minimise recorder" }).click();
    await page.getByText("Couldn't close this. Try again.").waitFor();
    expect(await page.getByRole("alert").allTextContents()).not.toContainEqual(expect.stringMatching(NATIVE));
    expect(errors.length).toBeGreaterThanOrEqual(2);
    await page.context().close();
  });

  test("signed out, a later microphone check fails: a stable line, the cause logged", async () => {
    const { page, errors } = await open("check-failed", "android");
    await page.getByRole("button", { name: "Dismiss" }).waitFor();
    await page.evaluate(() => {
      window.exoMicStatusFails = true;
    });
    const text = await page.getByText("Couldn't check microphone access. Exo will try again.").textContent();
    expect(text).not.toMatch(NATIVE);
    expect(errors.some((line) => line.includes("Could not check microphone recovery"))).toBe(true);
    await page.context().close();
  });

  test("signed out, microphone on: Dismiss failing shows a stable line", async () => {
    const { page, errors } = await open("sign-in", "android");
    await page.getByRole("button", { name: "Dismiss" }).click();
    const text = await alertText(page);
    expect(text).toBe("Couldn't close this. Try again.");
    expect(text).not.toMatch(NATIVE);
    expect(errors.some((line) => line.includes("Could not dismiss the microphone recovery"))).toBe(true);
    await page.context().close();
  });
});
