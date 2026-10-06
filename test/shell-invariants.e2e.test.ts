// Runtime invariants of the shell (TC-761, plan §8.3), on the real AppShell
// and surfaces (frontend/src/harness/shellIntegrationHarness.tsx), under
// StrictMode:
//
//   1. Nothing the user is in the middle of is lost: a draft and a streaming
//      reply survive every tab, Settings, rotation and size class, and the chat
//      and Capture surfaces never remount.
//   2. One recorder: the native plugin never has more than one view listening
//      (the Capture card, or the chat bar), and none on Connectors.
//   3. Android Back closes overlays first, the top one first, then goes home.
//   4. Retired addresses end on the Library.
//
// SHELL_ENGINE=webkit runs it in WebKit (the phone app's engine); Chromium by default (CI).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { chromium, webkit, type Browser, type BrowserType, type Page } from "playwright";
import { OFFERED_CHAT_MODELS } from "../packages/core/src/chatModels";

const frontend = new URL("../frontend/", import.meta.url).pathname;

let bundle = "";
let css = "";
/** Held chat streams: each call finishes its reply. */
let releases: Array<() => void> = [];
let chatRequests = 0;

beforeAll(async () => {
  const built = await Bun.build({
    entrypoints: [`${frontend}src/harness/shellIntegrationHarness.tsx`],
    root: frontend,
    target: "browser",
    minify: false,
    define: { "import.meta.env": "{}" },
    external: ["/fonts/*"],
  });
  if (!built.success) throw new Error(built.logs.join("\n"));
  bundle = await built.outputs.find((output) => output.kind === "entry-point")!.text();

  const requireFromFrontend = createRequire(`${frontend}package.json`);
  const postcss = requireFromFrontend("postcss");
  const tailwindcss = requireFromFrontend("tailwindcss");
  const source = await Bun.file(`${frontend}src/index.css`).text();
  const config = (await import(`${frontend}tailwind.config.js`)).default;
  config.content = [`${frontend}index.html`, `${frontend}src/**/*.{js,ts,jsx,tsx}`];
  css = (await postcss([tailwindcss(config)]).process(source, { from: `${frontend}src/index.css` })).css;
}, 120_000);

const encoder = new TextEncoder();
const chunk = (content: string) => encoder.encode(`data: ${JSON.stringify({ id: "c1", choices: [{ delta: { content } }] })}\n\n`);

function startServer() {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/bundle.js") return new Response(bundle, { headers: { "content-type": "text/javascript" } });
      if (url.pathname === "/app.css") return new Response(css, { headers: { "content-type": "text/css" } });
      if (url.pathname === "/api/chat/model-selection") {
        return Response.json({ model: OFFERED_CHAT_MODELS[0].id, reason: "healthy" });
      }
      if (url.pathname === "/api/chat" && request.method === "POST") {
        chatRequests += 1;
        // The reply starts at once and finishes only when the test releases it.
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(chunk("Hello"));
            releases.push(() => {
              controller.enqueue(chunk(" there"));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            });
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      if (url.pathname.startsWith("/api/")) return new Response("not found", { status: 404 });
      return new Response(
        '<!doctype html><html class="dark"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );
    },
  });
}

const engines: Record<string, BrowserType> = { webkit, chromium };
const name = process.env.SHELL_ENGINE ?? "chromium";
const engine = engines[name];
if (!engine) throw new Error(`SHELL_ENGINE must be one of ${Object.keys(engines).join(", ")}`);

const settle = (page: Page) => page.waitForTimeout(250);
const mounts = (page: Page) => page.evaluate(() => ({ ...window.__mounts }));
const activeListeners = (page: Page) => page.evaluate(() => window.shellHarness!.voiceNotes().active);

async function go(page: Page, path: string) {
  await page.evaluate((to) => window.shellHarness!.navigate(to), path);
  await page.waitForFunction((to) => window.location.pathname === to, path);
  await settle(page);
}

describe.serial(`shell invariants (${name})`, () => {
  let browser: Browser;
  let server: ReturnType<typeof Bun.serve>;

  beforeAll(async () => {
    server = startServer();
    browser = await engine.launch({ headless: true });
  }, 30_000);
  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
  }, 30_000);

  async function open(path: string, viewport = { width: 390, height: 844 }) {
    const page = await browser.newPage({ viewport });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.port}${path}`);
    await page.waitForFunction(() => window.shellHarness !== undefined);
    return { page, errors };
  }

  test("a draft and a streaming reply survive tabs, Settings, rotation and every size class; nothing remounts", async () => {
    releases = [];
    chatRequests = 0;
    const { page, errors } = await open("/chat");
    const composer = page.locator('textarea[placeholder^="Message"]');
    await page.waitForFunction(() => {
      const field = document.querySelector<HTMLTextAreaElement>('textarea[placeholder^="Message"]');
      return field !== null && !field.disabled;
    });

    // Start a reply and leave it streaming; then write a draft.
    await composer.fill("What did we decide on Friday?");
    await composer.press("Enter");
    await page.getByText("Hello", { exact: true }).waitFor();
    expect(chatRequests).toBe(1);
    await composer.fill("my draft");

    await go(page, "/chat/capture");
    await go(page, "/chat/connectors");
    await go(page, "/chat");
    await go(page, "/chat/settings");
    await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
    // Settings' Back (and Android Back) returns through history.
    await page.evaluate(() => window.shellHarness!.back());
    await page.waitForFunction(() => window.location.pathname === "/chat");

    for (const [width, height] of [[844, 390], [1023, 768], [1024, 768], [390, 844]]) {
      await page.setViewportSize({ width, height });
      await settle(page);
    }

    releases.splice(0).forEach((release) => release());
    await page.getByText("Hello there", { exact: true }).waitFor();

    expect(await composer.inputValue()).toBe("my draft");
    const counted = await mounts(page);
    expect(counted.chat).toBe(1);
    expect(counted.capture).toBe(1);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  test("one recorder: the Capture card or the chat bar listens, never both, and nothing on Connectors", async () => {
    const { page, errors } = await open("/chat/capture");
    let highest = 0;
    const expectActive = async (count: number) => {
      await page.waitForFunction((n) => window.shellHarness!.voiceNotes().active === n, count);
      // Sample a few frames after the move settles: never above one view's three.
      for (let i = 0; i < 5; i++) {
        highest = Math.max(highest, await activeListeners(page));
        await page.waitForTimeout(30);
      }
    };

    await page.getByText("Voice notes", { exact: true }).waitFor();
    await expectActive(3); // the card

    await go(page, "/chat");
    await expectActive(0); // the card is gone; the bar is closed

    await page.getByTestId("header-voice-note").click();
    await page.getByTestId("quick-voice-note").waitFor();
    await expectActive(3); // the chat bar, recording
    await page.waitForFunction(() => window.shellHarness!.voiceNotes().recording);

    await go(page, "/chat/connectors");
    await expectActive(0);

    await go(page, "/chat/capture");
    await expectActive(3); // the card picks the running recording up
    await page.getByTestId("voice-note-stop").waitFor();

    await go(page, "/chat/settings");
    await expectActive(0);

    await go(page, "/chat");
    await expectActive(0);

    expect(highest).toBeLessThanOrEqual(3);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  test("Android Back closes the top overlay first, then the next, then goes home", async () => {
    const { page, errors } = await open("/chat");
    const openDialogs = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('[role="dialog"][data-state="open"]')].map(
          (dialog) => dialog.querySelector("h2")?.textContent ?? "",
        ),
      );

    // The model sheet (vaul), then the Chats sheet (Radix) over it.
    const chip = page.getByRole("button", { name: "Model" });
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('button[aria-label="Model"]')?.disabled);
    await chip.click();
    await page.locator('[data-testid="model-sheet"][data-state="open"]').waitFor();
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('button[aria-label="Chats"]')!.click());
    await page.waitForFunction(() => document.querySelectorAll('[role="dialog"][data-state="open"]').length === 2);
    expect(await openDialogs()).toEqual(["Model", "Chats"]);

    await page.evaluate(() => window.shellHarness!.back());
    await page.waitForFunction(() => document.querySelectorAll('[role="dialog"][data-state="open"]').length === 1);
    expect(await openDialogs()).toEqual(["Model"]);
    // The next press comes once the closed sheet has finished leaving: until
    // its exit animation ends it is still the top layer, and a press then is
    // simply dropped.
    await page.waitForFunction(() => document.querySelectorAll('[role="dialog"]').length === 1);

    await page.evaluate(() => window.shellHarness!.back());
    await page.waitForFunction(() => document.querySelectorAll('[role="dialog"][data-state="open"]').length === 0);

    // No overlay left: Chat is not the Android app's home, so Back goes to Capture…
    await page.evaluate(() => window.shellHarness!.back());
    await page.waitForFunction(() => window.location.pathname === "/chat/capture");
    // …and at home it minimises, never exits.
    await settle(page);
    await page.evaluate(() => window.shellHarness!.back());
    expect(await page.evaluate(() => window.shellHarness!.minimized())).toBe(1);
    expect(await page.evaluate(() => window.location.pathname)).toBe("/chat/capture");
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  test("retired addresses end on the Library", async () => {
    for (const path of ["/chat/connectors/library", "/chat/meetings"]) {
      const { page, errors } = await open(path);
      await page.waitForFunction(() => window.location.pathname === "/chat/capture/library");
      await page.getByRole("heading", { name: "Meetings", exact: true }).waitFor();
      expect(errors).toEqual([]);
      await page.close();
    }
  }, 60_000);
});
